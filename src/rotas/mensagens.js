'use strict';
// Módulo de mensagens por e-mail: o organizador cria/edita mensagens personalizadas
// (lembretes da data, pedido de confirmação, avisos) e dispara para todos os convidados
// ou para convidados escolhidos. Montado em /api/admin (master ou admin do evento).

const express = require('express');
const nodemailer = require('nodemailer');
const { db } = require('../db');
const { exigirAdminEvento, podeAcessarEvento, descreverUsuario } = require('../auth');
const { carregarConfigEnvio, bannerDataUrl, soDigitos } = require('../envio');
const { htmlMensagem, textoWhatsappMensagem, linkConvite, linkConfirmar } = require('../mensagens');
const evolution = require('../evolution');
const wa = require('../whatsapp-agendador');

wa.iniciarAgendador();

const router = express.Router();
router.use(exigirAdminEvento);

// Intervalo entre um e-mail e outro no disparo em massa — evita bloqueio/spam do provedor
// (ex.: Gmail). 300 convidados × 2 s ≈ 10 min, em segundo plano.
const INTERVALO_MS = Math.max(0, Number(process.env.MENSAGENS_INTERVALO_MS ?? 2000));
// Para o disparo após N falhas seguidas (senha errada, cota diária do provedor esgotada…)
const MAX_FALHAS_SEGUIDAS = 5;

function eventoDoEscopo(req, res, eventoId) {
  if (!podeAcessarEvento(req.session.usuario, eventoId)) {
    res.status(403).json({ erro: 'Você não tem acesso a este evento.' });
    return null;
  }
  const e = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(eventoId);
  if (!e) { res.status(404).json({ erro: 'Evento não encontrado.' }); return null; }
  return e;
}

function mensagemDoEscopo(req, res, id) {
  const m = db.prepare(`SELECT * FROM mensagens_modelo WHERE id=?`).get(id);
  if (!m) { res.status(404).json({ erro: 'Mensagem não encontrada.' }); return null; }
  if (!podeAcessarEvento(req.session.usuario, m.evento_id)) {
    res.status(403).json({ erro: 'Você não tem acesso a este evento.' });
    return null;
  }
  return m;
}

function validarMensagem(b) {
  const nome = String(b.nome || '').trim();
  const assunto = String(b.assunto || '').trim();
  const corpo = String(b.corpo || '').trim();
  if (!nome) return { erro: 'Dê um nome para a mensagem (ex.: "Lembrete 7 dias antes").' };
  if (!assunto) return { erro: 'Informe o assunto do e-mail.' };
  if (!corpo) return { erro: 'Escreva o texto da mensagem.' };
  if (assunto.length > 200) return { erro: 'O assunto pode ter no máximo 200 caracteres.' };
  if (corpo.length > 20000) return { erro: 'O texto da mensagem está muito longo.' };
  return { nome, assunto, corpo, incluir_botoes: b.incluir_botoes === false || b.incluir_botoes === 0 ? 0 : 1 };
}

const SQL_CONVIDADO = `
  SELECT c.*, u.empresa_nome, m.numero AS mesa_numero FROM convidados c
  LEFT JOIN usuarios u ON u.id = c.empresa_id
  LEFT JOIN mesas m ON m.id = c.mesa_id`;

// Convidado fictício para a pré-visualização quando o evento ainda não tem convidados
function convidadoExemplo() {
  return {
    id: 0, nome: 'Maria Exemplo', cargo: 'Diretora Comercial', empresa_nome: 'Empresa Exemplo',
    email: 'maria@exemplo.com.br', token: 'exemplo', codigo: '123456', status: 'enviado',
    mesa_numero: 5, cadeira: 3,
  };
}

// Versão texto (para clientes de e-mail sem HTML)
function textoPuro(modelo, texto, convidado) {
  let t = texto;
  if (modelo.incluir_botoes !== 0) {
    if (!['confirmado', 'checkin', 'cancelado'].includes(convidado.status)) {
      t += `\n\nConfirme sua presença: ${linkConfirmar(convidado.token)}`;
    }
    t += `\nSeu convite digital: ${linkConvite(convidado.token)}`;
  }
  return t;
}

function criarTransporte(smtp, pool = false) {
  return nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    ...(pool ? { pool: true, maxConnections: 1 } : {}),
  });
}

// ═══════════════ CRUD das mensagens ═══════════════

router.get('/eventos/:id/mensagens', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const lista = db.prepare(`
    SELECT m.*,
      (SELECT MAX(d.iniciado_em) FROM mensagem_disparos d WHERE d.mensagem_id = m.id) AS ultimo_disparo,
      (SELECT COALESCE(SUM(d.enviados),0) FROM mensagem_disparos d WHERE d.mensagem_id = m.id) AS total_enviados
    FROM mensagens_modelo m WHERE m.evento_id=? ORDER BY m.atualizado_em DESC, m.id DESC
  `).all(e.id);
  res.json(lista);
});

router.post('/eventos/:id/mensagens', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const v = validarMensagem(req.body || {});
  if (v.erro) return res.status(400).json({ erro: v.erro });
  const r = db.prepare(`INSERT INTO mensagens_modelo (evento_id, nome, assunto, corpo, incluir_botoes) VALUES (?,?,?,?,?)`)
    .run(e.id, v.nome, v.assunto, v.corpo, v.incluir_botoes);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.put('/mensagens/:mid', (req, res) => {
  const m = mensagemDoEscopo(req, res, req.params.mid);
  if (!m) return;
  const v = validarMensagem(req.body || {});
  if (v.erro) return res.status(400).json({ erro: v.erro });
  db.prepare(`UPDATE mensagens_modelo SET nome=?, assunto=?, corpo=?, incluir_botoes=?, atualizado_em=datetime('now','localtime') WHERE id=?`)
    .run(v.nome, v.assunto, v.corpo, v.incluir_botoes, m.id);
  res.json({ ok: true });
});

router.delete('/mensagens/:mid', (req, res) => {
  const m = mensagemDoEscopo(req, res, req.params.mid);
  if (!m) return;
  if (disparos.get(m.evento_id)?.processando && disparos.get(m.evento_id).mensagem_id === m.id) {
    return res.status(400).json({ erro: 'Esta mensagem está sendo enviada agora. Aguarde ou interrompa o envio.' });
  }
  db.prepare(`DELETE FROM mensagens_modelo WHERE id=?`).run(m.id); // histórico de disparos é preservado
  res.json({ ok: true });
});

// ═══════════════ Pré-visualização e teste ═══════════════

// Renderiza a mensagem (ainda não salva) com os dados de um convidado real do evento
router.post('/eventos/:id/mensagens/preview', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const b = req.body || {};
  let convidado = null;
  if (b.convidado_id) convidado = db.prepare(`${SQL_CONVIDADO} WHERE c.id=? AND c.evento_id=?`).get(b.convidado_id, e.id);
  if (!convidado) convidado = db.prepare(`${SQL_CONVIDADO} WHERE c.evento_id=? AND c.status!='cancelado' ORDER BY c.id LIMIT 1`).get(e.id);
  if (!convidado) convidado = convidadoExemplo();
  const modelo = { assunto: b.assunto || '', corpo: b.corpo || '', incluir_botoes: b.incluir_botoes === false ? 0 : 1 };
  const r = htmlMensagem(modelo, e, convidado, bannerDataUrl(e));
  res.json({
    assunto: r.assunto, html: r.html, texto_whatsapp: textoWhatsappMensagem(modelo, e, convidado),
    convidado: { id: convidado.id, nome: convidado.nome },
  });
});

// Envia a mensagem para o próprio organizador (Reply-To / conta SMTP) para conferir na caixa de entrada
router.post('/eventos/:id/mensagens/teste', async (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const b = req.body || {};
  const v = validarMensagem({ ...b, nome: 'teste' });
  if (v.erro) return res.status(400).json({ erro: v.erro });
  const config = carregarConfigEnvio(e.id);
  if (!config.smtp) return res.status(400).json({ erro: 'Nenhum servidor de e-mail (SMTP) configurado. Veja a aba Envio.' });
  const ehEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
  const doRemetente = (String(config.smtp.from || '').match(/<([^>]+)>/) || [])[1] || config.smtp.from;
  const destino = [b.destino, config.smtp.replyTo, req.session.usuario.email, doRemetente, config.smtp.user]
    .map(s => String(s || '').trim()).find(ehEmail);
  if (!destino) return res.status(400).json({ erro: 'Não há e-mail para receber o teste. Informe o "Seu e-mail" na aba Envio.' });
  const convidado = db.prepare(`${SQL_CONVIDADO} WHERE c.evento_id=? AND c.status!='cancelado' ORDER BY c.id LIMIT 1`).get(e.id) || convidadoExemplo();
  const r = htmlMensagem(v, e, convidado, bannerDataUrl(e));
  try {
    await criarTransporte(config.smtp).sendMail({
      from: config.smtp.from, replyTo: config.smtp.replyTo, to: destino,
      subject: `[TESTE] ${r.assunto}`, text: textoPuro(v, r.texto, convidado), html: r.html, attachDataUrls: true,
    });
    res.json({ ok: true, mensagem: `E-mail de teste enviado para ${destino} (com os dados de ${convidado.nome}).` });
  } catch (err) {
    res.status(400).json({ erro: 'Falha no envio do teste: ' + err.message });
  }
});

// ═══════════════ Disparo (em segundo plano) ═══════════════

// Progresso em memória, por evento (o resultado definitivo fica em mensagem_disparos/envios)
const disparos = new Map();
const esperar = ms => new Promise(r => setTimeout(r, ms));

router.post('/mensagens/:mid/disparar', (req, res) => {
  const modelo = mensagemDoEscopo(req, res, req.params.mid);
  if (!modelo) return;
  const evento = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(modelo.evento_id);
  if (req.body?.canal === 'whatsapp') return dispararWhatsapp(req, res, evento, modelo);
  if (disparos.get(evento.id)?.processando) {
    return res.status(400).json({ erro: 'Já existe um envio de mensagens em andamento neste evento. Aguarde terminar.' });
  }
  const config = carregarConfigEnvio(evento.id);
  if (!config.smtp) return res.status(400).json({ erro: 'Nenhum servidor de e-mail (SMTP) configurado. Veja a aba Envio.' });

  const ids = [...new Set((req.body?.convidado_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ erro: 'Selecione ao menos um convidado.' });

  const buscar = db.prepare(`${SQL_CONVIDADO} WHERE c.id=? AND c.evento_id=? AND c.status!='cancelado'`);
  const convidados = ids.map(id => buscar.get(id, evento.id)).filter(Boolean);
  if (!convidados.length) return res.status(400).json({ erro: 'Nenhum dos convidados selecionados pertence a este evento.' });
  const comEmail = convidados.filter(c => String(c.email || '').trim());
  const semEmail = convidados.filter(c => !String(c.email || '').trim());
  if (!comEmail.length) return res.status(400).json({ erro: 'Nenhum dos convidados selecionados tem e-mail cadastrado.' });

  const r = db.prepare(`
    INSERT INTO mensagem_disparos (evento_id, mensagem_id, mensagem_nome, assunto, total, sem_email, criado_por)
    VALUES (?,?,?,?,?,?,?)`).run(evento.id, modelo.id, modelo.nome, modelo.assunto, comEmail.length, semEmail.length,
    descreverUsuario(req.session.usuario));
  const disparoId = Number(r.lastInsertRowid);

  const progresso = {
    processando: true, disparo_id: disparoId, mensagem_id: modelo.id, mensagem_nome: modelo.nome,
    total: comEmail.length, feitos: 0, enviados: 0, falhas: [], sem_email: semEmail.map(c => c.nome),
    interromper: false, motivo_parada: null,
  };
  disparos.set(evento.id, progresso);

  // Snapshot da mensagem: editar o modelo durante o envio não altera o que está saindo
  const snapshot = { assunto: modelo.assunto, corpo: modelo.corpo, incluir_botoes: modelo.incluir_botoes };
  executarDisparo(evento, snapshot, comEmail, config.smtp, progresso).catch(err => {
    progresso.motivo_parada = 'Erro inesperado: ' + err.message;
  }).finally(() => {
    progresso.processando = false;
    const situacao = progresso.motivo_parada || progresso.feitos < progresso.total ? 'interrompido' : 'concluido';
    db.prepare(`UPDATE mensagem_disparos SET enviados=?, falhas=?, situacao=?, concluido_em=datetime('now','localtime') WHERE id=?`)
      .run(progresso.enviados, progresso.falhas.length, situacao, disparoId);
  });

  res.json({ ok: true, iniciado: true, total: comEmail.length, sem_email: semEmail.length, intervalo_ms: INTERVALO_MS });
});

// ── WhatsApp: cria o disparo segmentado; quem envia é o agendador (src/whatsapp-agendador.js) ──
function dispararWhatsapp(req, res, evento, modelo) {
  if (!evolution.evolutionGlobalConfigurada()) {
    return res.status(400).json({ erro: 'O servidor de WhatsApp (Evolution API) não está configurado no sistema.' });
  }
  const ativo = wa.disparoWhatsappAtivo(evento.id);
  if (ativo) {
    return res.status(400).json({ erro: `Já existe um envio por WhatsApp em andamento neste evento (“${ativo.mensagem_nome}”). ` +
      'Para proteger o número, só um envio por WhatsApp acontece por vez — aguarde terminar ou cancele-o.' });
  }
  const config = wa.normalizarConfig(req.body?.segmentacao || {});
  if (config.erro) return res.status(400).json({ erro: config.erro });

  const ids = [...new Set((req.body?.convidado_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ erro: 'Selecione ao menos um convidado.' });
  const buscar = db.prepare(`${SQL_CONVIDADO} WHERE c.id=? AND c.evento_id=? AND c.status!='cancelado'`);
  const convidados = ids.map(id => buscar.get(id, evento.id)).filter(Boolean);
  if (!convidados.length) return res.status(400).json({ erro: 'Nenhum dos convidados selecionados pertence a este evento.' });

  // Número válido (55 + DDD + 8/9 dígitos) e um envio por número — mandar o mesmo texto
  // duas vezes para o mesmo celular é justamente o tipo de coisa que gera denúncia/bloqueio
  const itens = []; const vistos = new Set(); let semTelefone = 0; let duplicados = 0;
  for (const c of convidados) {
    const numero = soDigitos(c.telefone);
    if (numero.length < 12 || numero.length > 13) { semTelefone++; continue; }
    // celular com e sem o 9º dígito (55 11 9xxxx-xxxx × 55 11 xxxx-xxxx) é o mesmo WhatsApp
    const chave = numero.length === 12 && /[6-9]/.test(numero[4]) ? numero.slice(0, 4) + '9' + numero.slice(4) : numero;
    if (vistos.has(chave)) { duplicados++; continue; }
    vistos.add(chave);
    itens.push({ convidado: c, numero, texto: textoWhatsappMensagem(modelo, evento, c) });
  }
  if (!itens.length) return res.status(400).json({ erro: 'Nenhum dos convidados selecionados tem WhatsApp/telefone válido cadastrado.' });

  const disparoId = wa.criarDisparo({
    evento, modelo, itens, config, semTelefone, criadoPor: descreverUsuario(req.session.usuario),
  });
  res.json({ ok: true, iniciado: true, canal: 'whatsapp', disparo_id: disparoId, total: itens.length, sem_telefone: semTelefone, duplicados });
}

async function executarDisparo(evento, modelo, convidados, smtp, progresso) {
  const transporte = criarTransporte(smtp, true);
  const banner = bannerDataUrl(evento);
  const registrar = db.prepare(`INSERT INTO envios (convidado_id, canal, destino, status, disparo_id) VALUES (?, 'email', ?, ?, ?)`);
  const atualizar = db.prepare(`UPDATE mensagem_disparos SET enviados=?, falhas=? WHERE id=?`);
  let falhasSeguidas = 0;
  try {
    for (const c of convidados) {
      if (progresso.interromper) { progresso.motivo_parada = 'Interrompido pelo organizador.'; break; }
      const r = htmlMensagem(modelo, evento, c, banner);
      try {
        await transporte.sendMail({
          from: smtp.from, replyTo: smtp.replyTo, to: c.email.trim(),
          subject: r.assunto, text: textoPuro(modelo, r.texto, c), html: r.html, attachDataUrls: true,
        });
        registrar.run(c.id, c.email.trim(), 'enviado', progresso.disparo_id);
        progresso.enviados++;
        falhasSeguidas = 0;
      } catch (err) {
        registrar.run(c.id, c.email.trim(), 'erro: ' + err.message, progresso.disparo_id);
        progresso.falhas.push({ nome: c.nome, email: c.email, erro: err.message });
        if (++falhasSeguidas >= MAX_FALHAS_SEGUIDAS) {
          progresso.motivo_parada = `Envio interrompido após ${MAX_FALHAS_SEGUIDAS} falhas seguidas ` +
            `(possível limite diário do provedor de e-mail ou problema na conta). Último erro: ${err.message}`;
          progresso.feitos++;
          break;
        }
      }
      progresso.feitos++;
      atualizar.run(progresso.enviados, progresso.falhas.length, progresso.disparo_id);
      if (progresso.feitos < progresso.total && INTERVALO_MS) await esperar(INTERVALO_MS);
    }
  } finally {
    transporte.close();
  }
}

router.get('/eventos/:id/mensagens/disparo/status', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const p = disparos.get(e.id);
  if (!p) return res.json({ processando: false, nenhum: true });
  const { interromper, ...publico } = p;
  res.json(publico);
});

router.post('/eventos/:id/mensagens/disparo/interromper', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const p = disparos.get(e.id);
  if (!p?.processando) return res.status(400).json({ erro: 'Não há envio em andamento.' });
  p.interromper = true;
  res.json({ ok: true });
});

// Estado do WhatsApp para o painel: conexão, envio ativo e ritmos predefinidos
router.get('/eventos/:id/mensagens/whatsapp', async (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  // ?leve=1 (acompanhamento a cada poucos segundos): pula a consulta de conexão à Evolution
  let conectado = null;
  if (!req.query.leve && evolution.evolutionGlobalConfigurada()) {
    conectado = false;
    for (const nome of carregarConfigEnvio(e.id).instancias) {
      if (await evolution.estadoInstancia(nome) === 'open') { conectado = true; break; }
    }
  }
  const ativo = wa.disparoWhatsappAtivo(e.id);
  res.json({
    disponivel: evolution.evolutionGlobalConfigurada(), conectado,
    ativo: ativo ? wa.resumo(ativo) : null, presets: wa.PRESETS,
  });
});

function disparoWhatsappDoEscopo(req, res) {
  const d = db.prepare(`SELECT * FROM mensagem_disparos WHERE id=? AND canal='whatsapp'`).get(req.params.did);
  if (!d) { res.status(404).json({ erro: 'Envio não encontrado.' }); return null; }
  if (!podeAcessarEvento(req.session.usuario, d.evento_id)) { res.status(403).json({ erro: 'Você não tem acesso a este evento.' }); return null; }
  return d;
}

router.post('/disparos/:did/pausar', (req, res) => {
  const d = disparoWhatsappDoEscopo(req, res); if (!d) return;
  if (d.situacao !== 'andamento') return res.status(400).json({ erro: 'Este envio não está em andamento.' });
  wa.pausar(d); res.json({ ok: true });
});
router.post('/disparos/:did/retomar', (req, res) => {
  const d = disparoWhatsappDoEscopo(req, res); if (!d) return;
  if (d.situacao !== 'pausado') return res.status(400).json({ erro: 'Este envio não está pausado.' });
  wa.retomar(d); res.json({ ok: true });
});
router.post('/disparos/:did/cancelar', (req, res) => {
  const d = disparoWhatsappDoEscopo(req, res); if (!d) return;
  if (!['andamento', 'pausado'].includes(d.situacao)) return res.status(400).json({ erro: 'Este envio já terminou.' });
  wa.cancelar(d); res.json({ ok: true });
});

// ═══════════════ Histórico ═══════════════

router.get('/eventos/:id/mensagens/disparos', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  res.json(db.prepare(`SELECT * FROM mensagem_disparos WHERE evento_id=? ORDER BY id DESC LIMIT 100`).all(e.id));
});

router.get('/disparos/:did', (req, res) => {
  const d = db.prepare(`SELECT * FROM mensagem_disparos WHERE id=?`).get(req.params.did);
  if (!d) return res.status(404).json({ erro: 'Disparo não encontrado.' });
  if (!podeAcessarEvento(req.session.usuario, d.evento_id)) return res.status(403).json({ erro: 'Você não tem acesso a este evento.' });
  if (d.canal === 'whatsapp') {
    const destinatarios = db.prepare(`
      SELECT numero AS destino, status, erro, enviado_em AS criado_em, nome FROM whatsapp_fila
      WHERE disparo_id=? ORDER BY id`).all(d.id);
    return res.json({ ...d, destinatarios });
  }
  const destinatarios = db.prepare(`
    SELECT en.destino, en.status, en.criado_em, c.nome, c.status AS status_convidado
    FROM envios en JOIN convidados c ON c.id = en.convidado_id
    WHERE en.disparo_id=? ORDER BY en.id`).all(d.id);
  res.json({ ...d, destinatarios });
});

module.exports = router;
