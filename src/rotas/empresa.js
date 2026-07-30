'use strict';
const express = require('express');
const { db, novoToken, novoCodigo } = require('../db');
const { exigirConvidadoPrincipal, descreverUsuario } = require('../auth');
const { enviarConvite, enviarConviteAutomatico, enviarCancelamentoAutomatico } = require('../envio');

const router = express.Router();
router.use(exigirConvidadoPrincipal);

// Recarrega o convidado com o nº da mesa (formato esperado por enviarConvite)
function convidadoComMesa(id) {
  return db.prepare(`
    SELECT c.*, m.numero AS mesa_numero FROM convidados c
    LEFT JOIN mesas m ON m.id = c.mesa_id WHERE c.id=?
  `).get(id);
}

function contexto(req) {
  const usuario = db.prepare(`SELECT * FROM usuarios WHERE id=?`).get(req.session.usuario.id);
  const evento = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(usuario.evento_id);
  return { usuario, evento };
}

function prazoEncerrado(evento) {
  if (!evento) return true;
  if (evento.expirado) return true;
  const hoje = new Date().toISOString().slice(0, 10);
  return hoje > evento.deadline;
}

router.get('/painel', (req, res) => {
  const { usuario, evento } = contexto(req);
  if (!evento) return res.status(404).json({ erro: 'Sua empresa não está vinculada a um evento. Contate a organização.' });
  const convidados = db.prepare(`
    SELECT c.*, m.numero AS mesa_numero FROM convidados c
    LEFT JOIN mesas m ON m.id = c.mesa_id
    WHERE c.empresa_id = ? ORDER BY c.tipo DESC, c.criado_em
  `).all(usuario.id);
  const usados = convidados.filter(c => c.status !== 'cancelado').length;
  const mesas = db.prepare(`SELECT * FROM mesas WHERE evento_id=? ORDER BY numero`).all(evento.id);
  const ocupantes = db.prepare(`
    SELECT c.id, c.nome, c.cadeira, c.mesa_id, u.empresa_nome
    FROM convidados c LEFT JOIN usuarios u ON u.id = c.empresa_id
    WHERE c.evento_id=? AND c.mesa_id IS NOT NULL AND c.status!='cancelado'
  `).all(evento.id);

  res.json({
    empresa: {
      id: usuario.id, username: usuario.username, empresa_nome: usuario.empresa_nome,
      nome: usuario.nome, cargo: usuario.cargo, email: usuario.email, telefone: usuario.telefone,
      cota: usuario.cota, usados, restantes: Math.max(0, usuario.cota - usados),
    },
    evento: { ...evento, prazo_encerrado: prazoEncerrado(evento) },
    convidados,
    mapa: evento.mapa_mesas === 0 ? null : { mesas, ocupantes },
  });
});

// Dados do responsável (nome, empresa, cargo + contato) — cria/atualiza sua própria inscrição
router.put('/perfil', (req, res) => {
  const { usuario, evento } = contexto(req);
  const b = req.body || {};
  if (!b.nome || !b.cargo) return res.status(400).json({ erro: 'Nome e cargo do responsável são obrigatórios.' });

  db.prepare(`UPDATE usuarios SET nome=?, cargo=?, email=?, telefone=? WHERE id=?`)
    .run(b.nome, b.cargo, b.email || '', b.telefone || '', usuario.id);

  const resp = db.prepare(`SELECT * FROM convidados WHERE empresa_id=? AND tipo='responsavel'`).get(usuario.id);
  if (resp) {
    db.prepare(`UPDATE convidados SET nome=?, cargo=?, email=?, telefone=? WHERE id=?`)
      .run(b.nome, b.cargo, b.email || '', b.telefone || '', resp.id);
  } else {
    if (prazoEncerrado(evento)) return res.status(400).json({ erro: 'O prazo de inscrição foi encerrado. Contate a organização.' });
    const usados = db.prepare(`SELECT COUNT(*) c FROM convidados WHERE empresa_id=? AND status!='cancelado'`).get(usuario.id).c;
    if (usados >= usuario.cota) return res.status(400).json({ erro: 'Sua cota de convites já foi totalmente utilizada.' });
    db.prepare(`
      INSERT INTO convidados (evento_id, empresa_id, tipo, nome, cargo, email, telefone, token, codigo)
      VALUES (?,?,'responsavel',?,?,?,?,?,?)
    `).run(evento.id, usuario.id, b.nome, b.cargo, b.email || '', b.telefone || '', novoToken(), novoCodigo());
  }
  res.json({ ok: true });
});

// Inscrever convidado (nome, email, telefone/whatsapp).
// O convite é DISPARADO AUTOMATICAMENTE na inserção (e-mail e/ou WhatsApp).
router.post('/convidados', async (req, res) => {
  const { usuario, evento } = contexto(req);
  const b = req.body || {};
  if (prazoEncerrado(evento)) return res.status(400).json({ erro: 'O prazo de inscrição de convidados foi encerrado.' });
  if (!b.nome) return res.status(400).json({ erro: 'Informe o nome do convidado.' });
  const usados = db.prepare(`SELECT COUNT(*) c FROM convidados WHERE empresa_id=? AND status!='cancelado'`).get(usuario.id).c;
  if (usados >= usuario.cota) {
    return res.status(400).json({ erro: `Sua cota de ${usuario.cota} convites já foi totalmente utilizada.` });
  }
  const r = db.prepare(`
    INSERT INTO convidados (evento_id, empresa_id, tipo, nome, cargo, email, telefone, token, codigo)
    VALUES (?,?,'convidado',?,?,?,?,?,?)
  `).run(evento.id, usuario.id, b.nome, b.cargo || '', b.email || '', b.telefone || '', novoToken(), novoCodigo());
  const id = Number(r.lastInsertRowid);
  const envio = await enviarConviteAutomatico(evento, convidadoComMesa(id));
  res.json({ ok: true, id, envio });
});

// Editar convidado. Se o contato (nome/e-mail/telefone) mudou, o convite é
// reenviado automaticamente para os novos dados.
router.put('/convidados/:id', async (req, res) => {
  const { usuario, evento } = contexto(req);
  const b = req.body || {};
  const c = db.prepare(`SELECT * FROM convidados WHERE id=? AND empresa_id=?`).get(req.params.id, usuario.id);
  if (!c) return res.status(404).json({ erro: 'Convidado não encontrado.' });
  if (prazoEncerrado(evento)) return res.status(400).json({ erro: 'O prazo para alterações foi encerrado.' });
  const novo = {
    nome: b.nome ?? c.nome, cargo: b.cargo ?? c.cargo,
    email: b.email ?? c.email, telefone: b.telefone ?? c.telefone,
  };
  const mudouContato = novo.nome !== c.nome || novo.email !== c.email || novo.telefone !== c.telefone;
  db.prepare(`UPDATE convidados SET nome=?, cargo=?, email=?, telefone=? WHERE id=?`)
    .run(novo.nome, novo.cargo, novo.email, novo.telefone, c.id);
  let envio = null;
  if (mudouContato) envio = await enviarConviteAutomatico(evento, convidadoComMesa(c.id));
  res.json({ ok: true, envio });
});

router.delete('/convidados/:id', async (req, res) => {
  const { usuario, evento } = contexto(req);
  const c = db.prepare(`SELECT * FROM convidados WHERE id=? AND empresa_id=?`).get(req.params.id, usuario.id);
  if (!c) return res.status(404).json({ erro: 'Convidado não encontrado.' });
  if (c.tipo === 'responsavel') return res.status(400).json({ erro: 'A inscrição do responsável não pode ser excluída por aqui. Contate a organização.' });
  if (c.status === 'cancelado') return res.status(400).json({ erro: 'Este convidado já está cancelado.' });
  if (prazoEncerrado(evento)) return res.status(400).json({ erro: 'O prazo para alterações foi encerrado. Contate a organização.' });
  const envio = (c.email || c.telefone) ? await enviarCancelamentoAutomatico(evento, c) : null;
  db.prepare(`
    UPDATE convidados SET status='cancelado', mesa_id=NULL, cadeira=NULL,
      cancelado_em=datetime('now','localtime'), cancelado_por=?
    WHERE id=?
  `).run(descreverUsuario(usuario), c.id);
  res.json({ ok: true, envio });
});

// Disparo do convite (e-mail / WhatsApp) para um convidado da empresa
router.post('/convidados/:id/enviar', async (req, res) => {
  const { usuario } = contexto(req);
  const canal = req.body?.canal;
  const c = db.prepare(`
    SELECT c.*, m.numero AS mesa_numero FROM convidados c
    LEFT JOIN mesas m ON m.id = c.mesa_id
    WHERE c.id=? AND c.empresa_id=?
  `).get(req.params.id, usuario.id);
  if (!c) return res.status(404).json({ erro: 'Convidado não encontrado.' });
  const evento = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(c.evento_id);
  const resultado = await enviarConvite(canal, evento, c, null);
  res.status(resultado.ok ? 200 : 400).json(resultado);
});

module.exports = router;
