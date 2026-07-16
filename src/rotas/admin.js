'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const path = require('node:path');
const { db, novoToken, novoCodigo, gerarSenha, UPLOADS_DIR } = require('../db');
const { exigirAdminEvento, exigirMaster, podeAcessarEvento } = require('../auth');
const { enviarConvite, carregarConfigEnvio, qrDoConvite } = require('../envio');
const evolution = require('../evolution');
const { gerarModeloXlsx, lerPlanilha, validarLinhas } = require('../importacao');
const { gerarRelatorioXlsx } = require('../relatorios-xlsx');

const router = express.Router();
router.use(exigirAdminEvento); // master ou admin do evento

// ── Escopo: master acessa qualquer evento; admin_evento só o seu ──
function eventoDoEscopo(req, res, eventoId) {
  if (!podeAcessarEvento(req.session.usuario, eventoId)) {
    res.status(403).json({ erro: 'Você não tem acesso a este evento.' });
    return null;
  }
  const e = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(eventoId);
  if (!e) { res.status(404).json({ erro: 'Evento não encontrado.' }); return null; }
  return e;
}

// Carrega uma linha e valida o escopo pelo evento_id dela
function linhaDoEscopo(req, res, sql, id, nomeEntidade) {
  const linha = db.prepare(sql).get(id);
  if (!linha) { res.status(404).json({ erro: `${nomeEntidade} não encontrado(a).` }); return null; }
  if (!podeAcessarEvento(req.session.usuario, linha.evento_id)) {
    res.status(403).json({ erro: 'Você não tem acesso a este evento.' });
    return null;
  }
  return linha;
}

function mapaAtivo(res, evento) {
  if (evento.mapa_mesas === 0) {
    res.status(400).json({ erro: 'O mapa de mesas está desativado neste evento.' });
    return false;
  }
  return true;
}

// Gera username único a partir de um nome (slug com desambiguação .2, .3, ...)
function gerarUsername(base) {
  let username = String(base || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30);
  if (!username) return null;
  if (db.prepare(`SELECT 1 FROM usuarios WHERE username=?`).get(username)) {
    let i = 2;
    while (db.prepare(`SELECT 1 FROM usuarios WHERE username=?`).get(`${username}.${i}`)) i++;
    username = `${username}.${i}`;
  }
  return username;
}

// ═══════════════ EVENTOS ═══════════════

router.get('/eventos', (req, res) => {
  const u = req.session.usuario;
  const filtro = u.role === 'master' ? '' : 'WHERE e.id = ?';
  const params = u.role === 'master' ? [] : [u.evento_id];
  const eventos = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM usuarios us WHERE us.evento_id = e.id AND us.role='convidado_principal') AS total_empresas,
      (SELECT COUNT(*) FROM convidados c WHERE c.evento_id = e.id AND c.status != 'cancelado') AS total_inscritos
    FROM eventos e ${filtro} ORDER BY e.data_evento
  `).all(...params);
  res.json(eventos);
});

router.post('/eventos', exigirMaster, (req, res) => {
  const b = req.body || {};
  if (!b.nome || !b.data_evento || !b.local_nome || !b.endereco || !b.deadline) {
    return res.status(400).json({ erro: 'Preencha nome, data, local, endereço e deadline dos convites.' });
  }
  const r = db.prepare(`
    INSERT INTO eventos (nome, data_evento, hora_evento, local_nome, endereco, descricao, dress_code, deadline, hoteis, facilities)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(b.nome, b.data_evento, b.hora_evento || '20:00', b.local_nome, b.endereco,
         b.descricao || '', b.dress_code || '', b.deadline,
         JSON.stringify(b.hoteis || []), JSON.stringify(b.facilities || []));
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.put('/eventos/:id', (req, res) => {
  const b = req.body || {};
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  db.prepare(`
    UPDATE eventos SET nome=?, data_evento=?, hora_evento=?, local_nome=?, endereco=?,
      descricao=?, dress_code=?, deadline=?, hoteis=?, facilities=?,
      email_titulo=?, email_texto=?, email_rodape=? WHERE id=?
  `).run(b.nome, b.data_evento, b.hora_evento || '20:00', b.local_nome, b.endereco,
         b.descricao || '', b.dress_code || '', b.deadline,
         JSON.stringify(b.hoteis || []), JSON.stringify(b.facilities || []),
         b.email_titulo || '', b.email_texto || '', b.email_rodape || '', e.id);
  res.json({ ok: true });
});

// Liga/desliga o mapa de mesas do evento (exclusivo do master)
router.put('/eventos/:id/mapa', exigirMaster, (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const ativo = req.body?.ativo ? 1 : 0;
  db.prepare(`UPDATE eventos SET mapa_mesas=? WHERE id=?`).run(ativo, e.id);
  res.json({ ok: true, mapa_mesas: ativo });
});

// ── Imagens do evento: banner do convite e timbrado dos relatórios (data URL) ──
function salvarImagemEvento(campo) {
  return (req, res) => {
    const evento = eventoDoEscopo(req, res, req.params.id);
    if (!evento) return;
    const m = String(req.body?.imagem || '').match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!m) return res.status(400).json({ erro: 'Envie uma imagem PNG, JPG ou WebP.' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ erro: 'A imagem deve ter no máximo 2 MB.' });

    if (evento[campo]) { try { fs.unlinkSync(path.join(UPLOADS_DIR, evento[campo])); } catch {} }
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const arquivo = `${campo}-${evento.id}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, arquivo), buf);
    db.prepare(`UPDATE eventos SET ${campo}=? WHERE id=?`).run(arquivo, evento.id);
    res.json({ ok: true, url: '/banners/' + arquivo });
  };
}

function removerImagemEvento(campo) {
  return (req, res) => {
    const evento = eventoDoEscopo(req, res, req.params.id);
    if (!evento) return;
    if (evento[campo]) { try { fs.unlinkSync(path.join(UPLOADS_DIR, evento[campo])); } catch {} }
    db.prepare(`UPDATE eventos SET ${campo}='' WHERE id=?`).run(evento.id);
    res.json({ ok: true });
  };
}

router.post('/eventos/:id/banner', salvarImagemEvento('banner'));
router.delete('/eventos/:id/banner', removerImagemEvento('banner'));
router.post('/eventos/:id/timbrado', salvarImagemEvento('timbrado'));
router.delete('/eventos/:id/timbrado', removerImagemEvento('timbrado'));

// QR codes em lote (para o relatório de etiquetas/credenciais)
router.get('/eventos/:id/qrcodes', async (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const convidados = db.prepare(`
    SELECT id, token FROM convidados WHERE evento_id=? AND status!='cancelado'
  `).all(e.id);
  const qrs = {};
  for (const c of convidados) qrs[c.id] = await qrDoConvite(c.token);
  res.json(qrs);
});

router.delete('/eventos/:id', exigirMaster, async (req, res) => {
  const e = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(req.params.id);
  if (!e) return res.status(404).json({ erro: 'Evento não encontrado.' });
  const envio = db.prepare(`SELECT wa_instancia_criada FROM evento_envio WHERE evento_id=?`).get(e.id);
  if (envio?.wa_instancia_criada) await evolution.removerInstancia(evolution.nomeInstancia(e.id));
  db.prepare(`DELETE FROM eventos WHERE id=?`).run(e.id);
  res.json({ ok: true });
});

router.get('/eventos/:id/stats', (req, res) => {
  const evento = eventoDoEscopo(req, res, req.params.id);
  if (!evento) return;
  const id = evento.id;
  const s = {
    empresas: db.prepare(`SELECT COUNT(*) c FROM usuarios WHERE evento_id=? AND role='convidado_principal'`).get(id).c,
    cota_total: db.prepare(`SELECT COALESCE(SUM(cota),0) c FROM usuarios WHERE evento_id=? AND role='convidado_principal'`).get(id).c,
    inscritos: db.prepare(`SELECT COUNT(*) c FROM convidados WHERE evento_id=? AND status!='cancelado'`).get(id).c,
    confirmados: db.prepare(`SELECT COUNT(*) c FROM convidados WHERE evento_id=? AND status IN ('confirmado','checkin')`).get(id).c,
    checkins: db.prepare(`SELECT COUNT(*) c FROM convidados WHERE evento_id=? AND status='checkin'`).get(id).c,
    individuais: db.prepare(`SELECT COUNT(*) c FROM convidados WHERE evento_id=? AND tipo='individual' AND status!='cancelado'`).get(id).c,
    pool_individual: evento.pool_individual,
    expirado: evento.expirado,
    deadline: evento.deadline,
    mapa_mesas: evento.mapa_mesas,
  };
  res.json(s);
});

// Expiração: convites não usados das empresas voltam para o pool de convites individuais
router.post('/eventos/:id/expirar', (req, res) => {
  const evento = eventoDoEscopo(req, res, req.params.id);
  if (!evento) return;
  if (evento.expirado) return res.status(400).json({ erro: 'A expiração deste evento já foi processada.' });

  const empresas = db.prepare(`SELECT * FROM usuarios WHERE evento_id=? AND role='convidado_principal'`).all(evento.id);
  let recolhidos = 0;
  const detalhe = [];
  for (const emp of empresas) {
    const usados = db.prepare(`SELECT COUNT(*) c FROM convidados WHERE empresa_id=? AND status!='cancelado'`).get(emp.id).c;
    const naoUsados = Math.max(0, emp.cota - usados);
    if (naoUsados > 0) {
      db.prepare(`UPDATE usuarios SET cota=? WHERE id=?`).run(usados, emp.id);
      recolhidos += naoUsados;
      detalhe.push({ empresa: emp.empresa_nome, recolhidos: naoUsados });
    }
  }
  db.prepare(`UPDATE eventos SET pool_individual = pool_individual + ?, expirado = 1 WHERE id=?`)
    .run(recolhidos, evento.id);
  res.json({ ok: true, recolhidos, detalhe, pool_individual: evento.pool_individual + recolhidos });
});

// Ajuste manual do pool de convites individuais (+n ou -n)
router.post('/eventos/:id/pool', (req, res) => {
  const delta = Number(req.body?.delta || 0);
  const evento = eventoDoEscopo(req, res, req.params.id);
  if (!evento) return;
  const novo = evento.pool_individual + delta;
  if (novo < 0) return res.status(400).json({ erro: 'O pool não pode ficar negativo.' });
  db.prepare(`UPDATE eventos SET pool_individual=? WHERE id=?`).run(novo, evento.id);
  res.json({ ok: true, pool_individual: novo });
});

// ═══════════════ ADMINS DO EVENTO (exclusivo do master) ═══════════════

router.get('/eventos/:id/admins', exigirMaster, (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const admins = db.prepare(`
    SELECT id, username, senha_provisoria, nome, cargo, email, telefone, criado_em
    FROM usuarios WHERE evento_id=? AND role='admin_evento' ORDER BY nome
  `).all(e.id);
  res.json(admins);
});

router.post('/eventos/:id/admins', exigirMaster, (req, res) => {
  const b = req.body || {};
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  if (!b.nome) return res.status(400).json({ erro: 'Informe o nome do administrador do evento.' });

  const username = gerarUsername(b.username || b.nome);
  if (!username) return res.status(400).json({ erro: 'Não foi possível gerar um login. Informe um login manualmente.' });

  const senha = gerarSenha();
  const r = db.prepare(`
    INSERT INTO usuarios (evento_id, username, senha_hash, senha_provisoria, role, nome, cargo, email, telefone, cota)
    VALUES (?,?,?,?,'admin_evento',?,?,?,?,0)
  `).run(e.id, username, bcrypt.hashSync(senha, 10), senha,
         b.nome, b.cargo || '', b.email || '', b.telefone || '');
  res.json({ ok: true, id: Number(r.lastInsertRowid), username, senha });
});

router.post('/admins/:id/nova-senha', exigirMaster, (req, res) => {
  const adm = db.prepare(`SELECT * FROM usuarios WHERE id=? AND role='admin_evento'`).get(req.params.id);
  if (!adm) return res.status(404).json({ erro: 'Administrador não encontrado.' });
  const senha = gerarSenha();
  db.prepare(`UPDATE usuarios SET senha_hash=?, senha_provisoria=? WHERE id=?`)
    .run(bcrypt.hashSync(senha, 10), senha, adm.id);
  res.json({ ok: true, username: adm.username, senha });
});

router.delete('/admins/:id', exigirMaster, (req, res) => {
  const adm = db.prepare(`SELECT * FROM usuarios WHERE id=? AND role='admin_evento'`).get(req.params.id);
  if (!adm) return res.status(404).json({ erro: 'Administrador não encontrado.' });
  db.prepare(`DELETE FROM usuarios WHERE id=?`).run(adm.id);
  res.json({ ok: true });
});

// ═══════════════ ENVIO DO EVENTO (e-mail e WhatsApp pessoais) ═══════════════

function garantirLinhaEnvio(eventoId) {
  db.prepare(`INSERT OR IGNORE INTO evento_envio (evento_id) VALUES (?)`).run(eventoId);
  return db.prepare(`SELECT * FROM evento_envio WHERE evento_id=?`).get(eventoId);
}

router.get('/eventos/:id/envio', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const ee = garantirLinhaEnvio(e.id);
  res.json({
    remetente_nome: ee.remetente_nome, reply_to: ee.reply_to,
    smtp_modo: ee.smtp_modo, smtp_host: ee.smtp_host, smtp_port: ee.smtp_port,
    smtp_secure: ee.smtp_secure, smtp_user: ee.smtp_user,
    tem_senha: !!ee.smtp_pass, // a senha nunca é devolvida
    wa_instancia_criada: ee.wa_instancia_criada,
    smtp_global_configurado: !!(process.env.SMTP_HOST && process.env.SMTP_USER),
    evolution_disponivel: evolution.evolutionGlobalConfigurada(),
  });
});

router.put('/eventos/:id/envio', (req, res) => {
  const b = req.body || {};
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const ee = garantirLinhaEnvio(e.id);
  const modo = b.smtp_modo === 'proprio' ? 'proprio' : 'global';
  db.prepare(`
    UPDATE evento_envio SET remetente_nome=?, reply_to=?, smtp_modo=?,
      smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?,
      smtp_pass = CASE WHEN ? != '' THEN ? ELSE smtp_pass END,
      atualizado_em = datetime('now')
    WHERE evento_id=?
  `).run(
    b.remetente_nome ?? ee.remetente_nome, b.reply_to ?? ee.reply_to, modo,
    b.smtp_host ?? ee.smtp_host, Number(b.smtp_port || ee.smtp_port || 587),
    b.smtp_secure ? 1 : 0, b.smtp_user ?? ee.smtp_user,
    b.smtp_pass || '', b.smtp_pass || '', e.id,
  );
  res.json({ ok: true });
});

// E-mail de teste para validar a configuração (vai para o reply_to/remetente)
router.post('/eventos/:id/envio/testar-email', async (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const config = carregarConfigEnvio(e.id);
  if (!config.smtp) return res.status(400).json({ erro: 'Nenhum SMTP configurado (nem no evento, nem no sistema).' });
  const destino = config.smtp.replyTo || config.smtp.user;
  try {
    const nodemailer = require('nodemailer');
    await nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    }).sendMail({
      from: config.smtp.from, replyTo: config.smtp.replyTo, to: destino,
      subject: `Teste de envio — ${e.nome}`,
      text: `Este é um e-mail de teste do sistema de convites.\n\nEvento: ${e.nome}\nRemetente: ${config.smtp.from}\nModo: ${config.smtp.origem === 'evento' ? 'SMTP próprio do evento' : 'SMTP do sistema'}\n\nSe você recebeu esta mensagem, a configuração está funcionando.`,
    });
    res.json({ ok: true, mensagem: `E-mail de teste enviado para ${destino}.` });
  } catch (err) {
    res.status(400).json({ erro: 'Falha no teste: ' + err.message });
  }
});

// ── WhatsApp pessoal do admin do evento (instância Evolution por evento) ──

router.post('/eventos/:id/whatsapp/conectar', async (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  if (!evolution.evolutionGlobalConfigurada()) {
    return res.status(400).json({ erro: 'O servidor de WhatsApp (Evolution API) não está configurado no sistema.' });
  }
  const nome = evolution.nomeInstancia(e.id);
  try {
    await evolution.criarInstancia(nome);
    garantirLinhaEnvio(e.id);
    db.prepare(`UPDATE evento_envio SET wa_instancia_criada=1, atualizado_em=datetime('now') WHERE evento_id=?`).run(e.id);
    const estado = await evolution.estadoInstancia(nome);
    if (estado === 'open') return res.json({ ok: true, estado, qr: null, mensagem: 'WhatsApp já conectado.' });
    const qr = await evolution.qrInstancia(nome);
    res.json({ ok: true, estado, qr });
  } catch (err) {
    res.status(400).json({ erro: 'Falha ao conectar: ' + err.message });
  }
});

router.get('/eventos/:id/whatsapp/status', async (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const ee = db.prepare(`SELECT wa_instancia_criada FROM evento_envio WHERE evento_id=?`).get(e.id);
  if (!ee?.wa_instancia_criada) return res.json({ estado: 'nao_criada' });
  const estado = await evolution.estadoInstancia(evolution.nomeInstancia(e.id));
  res.json({ estado });
});

router.post('/eventos/:id/whatsapp/desconectar', async (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  await evolution.removerInstancia(evolution.nomeInstancia(e.id));
  garantirLinhaEnvio(e.id);
  db.prepare(`UPDATE evento_envio SET wa_instancia_criada=0, atualizado_em=datetime('now') WHERE evento_id=?`).run(e.id);
  res.json({ ok: true });
});

// ═══════════════ CONVIDADOS PRINCIPAIS (ex-empresas) ═══════════════

router.get('/eventos/:id/empresas', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const empresas = db.prepare(`
    SELECT u.id, u.username, u.senha_provisoria, u.empresa_nome, u.nome, u.cargo, u.email, u.telefone, u.cota,
      (SELECT COUNT(*) FROM convidados c WHERE c.empresa_id = u.id AND c.status != 'cancelado') AS usados
    FROM usuarios u WHERE u.evento_id = ? AND u.role = 'convidado_principal'
    ORDER BY u.empresa_nome
  `).all(e.id);
  res.json(empresas);
});

router.post('/empresas', (req, res) => {
  const b = req.body || {};
  if (!b.evento_id || !b.empresa_nome) return res.status(400).json({ erro: 'Informe o evento e o nome da empresa/organização.' });
  const evento = eventoDoEscopo(req, res, b.evento_id);
  if (!evento) return;

  const username = gerarUsername(b.username || b.empresa_nome);
  if (!username) return res.status(400).json({ erro: 'Não foi possível gerar um login. Informe um login manualmente.' });

  const senha = gerarSenha();
  const cota = Math.max(1, Number(b.cota || 4));
  const r = db.prepare(`
    INSERT INTO usuarios (evento_id, username, senha_hash, senha_provisoria, role, empresa_nome, nome, cargo, email, telefone, cota)
    VALUES (?,?,?,?,'convidado_principal',?,?,?,?,?,?)
  `).run(b.evento_id, username, bcrypt.hashSync(senha, 10), senha,
         b.empresa_nome, b.nome || '', b.cargo || '', b.email || '', b.telefone || '', cota);
  const empresaId = Number(r.lastInsertRowid);

  // Se os dados do responsável foram informados, já o inscreve (consome 1 convite da cota)
  if (b.nome) {
    db.prepare(`
      INSERT INTO convidados (evento_id, empresa_id, tipo, nome, cargo, email, telefone, token, codigo)
      VALUES (?,?,'responsavel',?,?,?,?,?,?)
    `).run(b.evento_id, empresaId, b.nome, b.cargo || '', b.email || '', b.telefone || '', novoToken(), novoCodigo());
  }

  res.json({ ok: true, id: empresaId, username, senha });
});

router.put('/empresas/:id', (req, res) => {
  const b = req.body || {};
  const emp = linhaDoEscopo(req, res, `SELECT * FROM usuarios WHERE id=? AND role='convidado_principal'`, req.params.id, 'Convidado principal');
  if (!emp) return;
  const usados = db.prepare(`SELECT COUNT(*) c FROM convidados WHERE empresa_id=? AND status!='cancelado'`).get(emp.id).c;
  const cota = Math.max(usados, Number(b.cota ?? emp.cota));
  db.prepare(`UPDATE usuarios SET empresa_nome=?, nome=?, cargo=?, email=?, telefone=?, cota=? WHERE id=?`)
    .run(b.empresa_nome ?? emp.empresa_nome, b.nome ?? emp.nome, b.cargo ?? emp.cargo,
         b.email ?? emp.email, b.telefone ?? emp.telefone, cota, emp.id);
  res.json({ ok: true, cota });
});

router.post('/empresas/:id/nova-senha', (req, res) => {
  const emp = linhaDoEscopo(req, res, `SELECT * FROM usuarios WHERE id=? AND role='convidado_principal'`, req.params.id, 'Convidado principal');
  if (!emp) return;
  const senha = gerarSenha();
  db.prepare(`UPDATE usuarios SET senha_hash=?, senha_provisoria=? WHERE id=?`)
    .run(bcrypt.hashSync(senha, 10), senha, emp.id);
  res.json({ ok: true, username: emp.username, senha });
});

router.delete('/empresas/:id', (req, res) => {
  const emp = linhaDoEscopo(req, res, `SELECT * FROM usuarios WHERE id=? AND role='convidado_principal'`, req.params.id, 'Convidado principal');
  if (!emp) return;
  db.prepare(`DELETE FROM convidados WHERE empresa_id=?`).run(emp.id);
  db.prepare(`DELETE FROM usuarios WHERE id=?`).run(emp.id);
  res.json({ ok: true });
});

// Relatório em Excel (.xlsx): tipo = geral|credenciamento|empresas|presenca|mapa|etiquetas
router.get('/eventos/:id/relatorio-xlsx', (req, res) => {
  const evento = eventoDoEscopo(req, res, req.params.id);
  if (!evento) return;
  try {
    const { buffer, nomeArquivo } = gerarRelatorioXlsx(String(req.query.tipo || 'geral'), evento, {
      status: req.query.status || '',
      empresa: req.query.empresa || '',
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(buffer);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ── Importação em lote via planilha (.xlsx, .xls ou .csv) ──

// Planilha-modelo para download
router.get('/importar/modelo', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-convidados-principais.xlsx"');
  res.send(gerarModeloXlsx());
});

// Fase 1 (confirmar=false): valida e devolve a pré-visualização.
// Fase 2 (confirmar=true): grava as linhas válidas e devolve as credenciais geradas.
router.post('/eventos/:id/importar', (req, res) => {
  const evento = eventoDoEscopo(req, res, req.params.id);
  if (!evento) return;
  const { arquivo, confirmar } = req.body || {};

  const lido = lerPlanilha(arquivo);
  if (lido.erro) return res.status(400).json({ erro: lido.erro });
  if (!lido.linhas.length) return res.status(400).json({ erro: 'Nenhuma linha de dados encontrada abaixo do cabeçalho.' });

  const existentes = db.prepare(`SELECT empresa_nome FROM usuarios WHERE evento_id=? AND role='convidado_principal'`).all(evento.id);
  const linhas = validarLinhas(lido.linhas, existentes);
  const validas = linhas.filter(l => l.valida);

  if (!confirmar) {
    return res.json({ ok: true, preview: true, total: linhas.length, validas: validas.length, linhas });
  }

  if (!validas.length) return res.status(400).json({ erro: 'Nenhuma linha válida para importar.' });
  const criadas = [];
  db.exec('BEGIN');
  try {
    for (const l of validas) {
      const username = gerarUsername(l.empresa_nome);
      const senha = gerarSenha();
      const r = db.prepare(`
        INSERT INTO usuarios (evento_id, username, senha_hash, senha_provisoria, role, empresa_nome, nome, cargo, email, telefone, cota)
        VALUES (?,?,?,?,'convidado_principal',?,?,?,?,?,?)
      `).run(evento.id, username, bcrypt.hashSync(senha, 10), senha,
             l.empresa_nome, l.nome || '', l.cargo || '', l.email || '', l.telefone || '', l.cota);
      // Responsável informado já entra como inscrito (consome 1 da cota), igual ao cadastro manual
      if (l.nome) {
        db.prepare(`
          INSERT INTO convidados (evento_id, empresa_id, tipo, nome, cargo, email, telefone, token, codigo)
          VALUES (?,?,'responsavel',?,?,?,?,?,?)
        `).run(evento.id, Number(r.lastInsertRowid), l.nome, l.cargo || '', l.email || '', l.telefone || '', novoToken(), novoCodigo());
      }
      criadas.push({ linha: l.linha, empresa_nome: l.empresa_nome, nome: l.nome || '', cota: l.cota, username, senha });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ erro: 'Falha ao gravar a importação: ' + e.message });
  }
  res.json({ ok: true, criadas, ignoradas: linhas.filter(l => !l.valida) });
});

// ═══════════════ CONVIDADOS ═══════════════

router.get('/eventos/:id/convidados', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const lista = db.prepare(`
    SELECT c.*, u.empresa_nome, m.numero AS mesa_numero
    FROM convidados c
    LEFT JOIN usuarios u ON u.id = c.empresa_id
    LEFT JOIN mesas m ON m.id = c.mesa_id
    WHERE c.evento_id = ?
    ORDER BY CASE WHEN c.status='cancelado' THEN 1 ELSE 0 END, u.empresa_nome, c.tipo DESC, c.nome
  `).all(e.id);
  res.json(lista);
});

// Convite individual (consome o pool) ou convidado em nome de uma empresa
router.post('/convidados', (req, res) => {
  const b = req.body || {};
  if (!b.evento_id || !b.nome) return res.status(400).json({ erro: 'Informe o evento e o nome do convidado.' });
  const evento = eventoDoEscopo(req, res, b.evento_id);
  if (!evento) return;

  let tipo = 'individual';
  if (b.empresa_id) {
    const emp = db.prepare(`SELECT * FROM usuarios WHERE id=? AND role='convidado_principal'`).get(b.empresa_id);
    if (!emp || emp.evento_id !== evento.id) return res.status(404).json({ erro: 'Convidado principal não encontrado neste evento.' });
    const usados = db.prepare(`SELECT COUNT(*) c FROM convidados WHERE empresa_id=? AND status!='cancelado'`).get(emp.id).c;
    if (usados >= emp.cota) return res.status(400).json({ erro: `A cota de ${emp.empresa_nome} (${emp.cota}) já foi totalmente utilizada.` });
    tipo = 'convidado';
  } else {
    if (evento.pool_individual <= 0) {
      return res.status(400).json({ erro: 'Não há convites individuais disponíveis no pool. Ajuste o pool ou processe a expiração.' });
    }
    db.prepare(`UPDATE eventos SET pool_individual = pool_individual - 1 WHERE id=?`).run(evento.id);
  }

  const r = db.prepare(`
    INSERT INTO convidados (evento_id, empresa_id, tipo, nome, cargo, email, telefone, token, codigo)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(b.evento_id, b.empresa_id || null, tipo, b.nome, b.cargo || '', b.email || '', b.telefone || '', novoToken(), novoCodigo());
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.put('/convidados/:id', (req, res) => {
  const b = req.body || {};
  const c = linhaDoEscopo(req, res, `SELECT * FROM convidados WHERE id=?`, req.params.id, 'Convidado');
  if (!c) return;
  db.prepare(`UPDATE convidados SET nome=?, cargo=?, email=?, telefone=? WHERE id=?`)
    .run(b.nome ?? c.nome, b.cargo ?? c.cargo, b.email ?? c.email, b.telefone ?? c.telefone, c.id);
  res.json({ ok: true });
});

router.delete('/convidados/:id', (req, res) => {
  const c = linhaDoEscopo(req, res, `SELECT * FROM convidados WHERE id=?`, req.params.id, 'Convidado');
  if (!c) return;
  if (c.tipo === 'individual' && c.status !== 'cancelado') {
    db.prepare(`UPDATE eventos SET pool_individual = pool_individual + 1 WHERE id=?`).run(c.evento_id);
  }
  db.prepare(`DELETE FROM convidados WHERE id=?`).run(c.id);
  res.json({ ok: true });
});

// Atribuir/limpar assento (mesa + cadeira)
router.post('/convidados/:id/assento', (req, res) => {
  const { mesa_id, cadeira } = req.body || {};
  const c = linhaDoEscopo(req, res, `SELECT * FROM convidados WHERE id=?`, req.params.id, 'Convidado');
  if (!c) return;
  const evento = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(c.evento_id);
  if (!mapaAtivo(res, evento)) return;

  if (!mesa_id) {
    db.prepare(`UPDATE convidados SET mesa_id=NULL, cadeira=NULL WHERE id=?`).run(c.id);
    return res.json({ ok: true });
  }
  const mesa = db.prepare(`SELECT * FROM mesas WHERE id=? AND evento_id=?`).get(mesa_id, c.evento_id);
  if (!mesa) return res.status(404).json({ erro: 'Mesa não encontrada neste evento.' });
  const cad = Number(cadeira);
  if (!cad || cad < 1 || cad > mesa.capacidade) {
    return res.status(400).json({ erro: `Cadeira inválida (a mesa ${mesa.numero} tem ${mesa.capacidade} lugares).` });
  }
  const ocupada = db.prepare(`SELECT id, nome FROM convidados WHERE mesa_id=? AND cadeira=? AND id!=? AND status!='cancelado'`)
    .get(mesa.id, cad, c.id);
  if (ocupada) return res.status(400).json({ erro: `A cadeira ${cad} da mesa ${mesa.numero} já está ocupada por ${ocupada.nome}.` });

  db.prepare(`UPDATE convidados SET mesa_id=?, cadeira=? WHERE id=?`).run(mesa.id, cad, c.id);
  res.json({ ok: true });
});

// Envio de convite (email/whatsapp); convidados principais recebem também as credenciais de acesso
router.post('/convidados/:id/enviar', async (req, res) => {
  const canal = req.body?.canal;
  const c = linhaDoEscopo(req, res, `
    SELECT c.*, m.numero AS mesa_numero FROM convidados c
    LEFT JOIN mesas m ON m.id = c.mesa_id WHERE c.id=?
  `, req.params.id, 'Convidado');
  if (!c) return;
  const evento = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(c.evento_id);

  let credenciais = null;
  if (c.tipo === 'responsavel' && c.empresa_id) {
    const emp = db.prepare(`SELECT username, senha_provisoria FROM usuarios WHERE id=?`).get(c.empresa_id);
    if (emp) credenciais = { username: emp.username, senha: emp.senha_provisoria || '(já alterada pelo usuário)' };
  }
  const resultado = await enviarConvite(canal, evento, c, credenciais);
  res.status(resultado.ok ? 200 : 400).json(resultado);
});

// ═══════════════ MESAS ═══════════════

router.get('/eventos/:id/mesas', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const mesas = db.prepare(`SELECT * FROM mesas WHERE evento_id=? ORDER BY numero`).all(e.id);
  const ocupantes = db.prepare(`
    SELECT c.id, c.nome, c.cadeira, c.mesa_id, c.status, u.empresa_nome
    FROM convidados c LEFT JOIN usuarios u ON u.id = c.empresa_id
    WHERE c.evento_id=? AND c.mesa_id IS NOT NULL AND c.status!='cancelado'
  `).all(e.id);
  res.json({ mesas, ocupantes });
});

// Cria N mesas de uma vez, numeradas em sequência e posicionadas em grade
router.post('/eventos/:id/mesas', (req, res) => {
  const b = req.body || {};
  const evento = eventoDoEscopo(req, res, req.params.id);
  if (!evento) return;
  if (!mapaAtivo(res, evento)) return;
  const qtd = Math.min(100, Math.max(1, Number(b.quantidade || 1)));
  const capacidade = Math.max(1, Number(b.capacidade || 8));
  const formato = b.formato === 'retangular' ? 'retangular' : 'redonda';
  const maxNum = db.prepare(`SELECT COALESCE(MAX(numero),0) n FROM mesas WHERE evento_id=?`).get(evento.id).n;
  const existentes = db.prepare(`SELECT COUNT(*) c FROM mesas WHERE evento_id=?`).get(evento.id).c;

  const ins = db.prepare(`INSERT INTO mesas (evento_id, numero, capacidade, formato, x, y) VALUES (?,?,?,?,?,?)`);
  const porLinha = 6, passo = 150;
  for (let i = 0; i < qtd; i++) {
    const idx = existentes + i;
    const x = 90 + (idx % porLinha) * passo;
    const y = 90 + Math.floor(idx / porLinha) * passo;
    ins.run(evento.id, maxNum + 1 + i, capacidade, formato, x, y);
  }
  res.json({ ok: true, criadas: qtd });
});

router.put('/mesas/:id', (req, res) => {
  const b = req.body || {};
  const m = linhaDoEscopo(req, res, `SELECT * FROM mesas WHERE id=?`, req.params.id, 'Mesa');
  if (!m) return;
  const capacidade = Math.max(1, Number(b.capacidade ?? m.capacidade));
  const ocupadosAcima = db.prepare(`SELECT COUNT(*) c FROM convidados WHERE mesa_id=? AND cadeira > ? AND status!='cancelado'`)
    .get(m.id, capacidade).c;
  if (ocupadosAcima > 0) return res.status(400).json({ erro: 'Há convidados em cadeiras acima da nova capacidade. Realoque-os antes.' });
  db.prepare(`UPDATE mesas SET numero=?, nome=?, capacidade=?, formato=? WHERE id=?`)
    .run(Number(b.numero ?? m.numero), b.nome ?? m.nome, capacidade,
         (b.formato === 'retangular' ? 'retangular' : 'redonda'), m.id);
  res.json({ ok: true });
});

router.put('/mesas/:id/posicao', (req, res) => {
  const { x, y } = req.body || {};
  const m = linhaDoEscopo(req, res, `SELECT * FROM mesas WHERE id=?`, req.params.id, 'Mesa');
  if (!m) return;
  db.prepare(`UPDATE mesas SET x=?, y=? WHERE id=?`).run(Number(x) || 0, Number(y) || 0, m.id);
  res.json({ ok: true });
});

router.delete('/mesas/:id', (req, res) => {
  const m = linhaDoEscopo(req, res, `SELECT * FROM mesas WHERE id=?`, req.params.id, 'Mesa');
  if (!m) return;
  db.prepare(`UPDATE convidados SET mesa_id=NULL, cadeira=NULL WHERE mesa_id=?`).run(m.id);
  db.prepare(`DELETE FROM mesas WHERE id=?`).run(m.id);
  res.json({ ok: true });
});

// ═══════════════ CREDENCIAMENTO (CHECK-IN) ═══════════════

router.post('/checkin', (req, res) => {
  let token = String(req.body?.token || '').trim();
  // Aceita o link completo do convite (conteúdo do QR) ou só o token
  const m = token.match(/\/convite\/([a-f0-9]+)/i);
  if (m) token = m[1];
  // Digitação manual: ignora espaços/hífens de agrupamento e caixa alta
  token = token.replace(/[\s-]/g, '').toLowerCase();
  if (!token) return res.status(400).json({ erro: 'Informe o código do convite.' });

  // Aceita o token longo (QR/link) ou o código curto de 6 dígitos do convidado
  const c = db.prepare(`
    SELECT c.*, u.empresa_nome, m.numero AS mesa_numero FROM convidados c
    LEFT JOIN usuarios u ON u.id = c.empresa_id
    LEFT JOIN mesas m ON m.id = c.mesa_id
    WHERE c.token=? OR c.codigo=?
  `).get(token, token);
  if (!c) return res.status(404).json({ erro: 'Convite não encontrado. Verifique o código.' });
  if (!podeAcessarEvento(req.session.usuario, c.evento_id)) {
    return res.status(403).json({ erro: 'Este convite pertence a outro evento.' });
  }
  if (c.status === 'cancelado') return res.status(400).json({ erro: `Convite CANCELADO — ${c.nome}.`, convidado: c });
  if (c.status === 'checkin') {
    return res.json({ ok: true, repetido: true, mensagem: `${c.nome} já fez check-in em ${c.checkin_em}.`, convidado: c });
  }
  db.prepare(`UPDATE convidados SET status='checkin', checkin_em=datetime('now','localtime') WHERE id=?`).run(c.id);
  res.json({ ok: true, mensagem: `Check-in confirmado: ${c.nome}`, convidado: { ...c, status: 'checkin' } });
});

router.get('/eventos/:id/checkins', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const lista = db.prepare(`
    SELECT c.nome, c.checkin_em, u.empresa_nome, m.numero AS mesa_numero, c.cadeira
    FROM convidados c
    LEFT JOIN usuarios u ON u.id = c.empresa_id
    LEFT JOIN mesas m ON m.id = c.mesa_id
    WHERE c.evento_id=? AND c.status='checkin'
    ORDER BY c.checkin_em DESC LIMIT 50
  `).all(e.id);
  res.json(lista);
});

module.exports = router;
