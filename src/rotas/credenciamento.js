'use strict';
// Lista de credenciamento para equipe externa (recepção terceirizada).
// SEM LOGIN: o acesso é só pelo link secreto gerado pelo organizador (tabela credenciamento_links).
// Expõe o MÍNIMO: nome, empresa, código curto e se já está presente — nada de e-mail,
// telefone, cargo, mesa ou token do convite.

const express = require('express');
const path = require('node:path');
const { db } = require('../db');

const router = express.Router();
const PAGINA = path.join(__dirname, '..', '..', 'public', 'credenciamento.html');
const alfa = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const limpo = s => String(s || '').trim().replace(/\s+/g, ' ');

// Página não deve ir para buscadores nem vazar o link por Referer
function semRastro(res) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');
}

function eventoDoLink(req, res) {
  semRastro(res);
  const token = String(req.params.token || '');
  const l = token.length >= 20 ? db.prepare(`SELECT evento_id FROM credenciamento_links WHERE token=?`).get(token) : null;
  if (!l) { res.status(404).json({ erro: 'Link de credenciamento inválido ou desativado. Peça um novo link ao organizador do evento.' }); return null; }
  return db.prepare(`SELECT id, nome, data_evento, hora_evento, local_nome FROM eventos WHERE id=?`).get(l.evento_id);
}

router.get('/credenciamento/:token', (req, res) => {
  semRastro(res);
  res.sendFile(PAGINA);
});

router.get('/api/credenciamento/:token', (req, res) => {
  const evento = eventoDoLink(req, res);
  if (!evento) return;
  const lista = db.prepare(`
    SELECT c.id, c.nome, c.codigo, c.status, c.status_antes_checkin, c.confirmado_em, c.checkin_em, c.empresa_id, u.empresa_nome
    FROM convidados c LEFT JOIN usuarios u ON u.id = c.empresa_id
    WHERE c.evento_id=? AND c.status!='cancelado'`).all(evento.id)
    .map(c => ({
      id: c.id,
      nome: limpo(c.nome),
      empresa: c.empresa_id ? (limpo(c.empresa_nome) || 'Empresa sem nome') : '',
      codigo: c.codigo || '',
      // Situação do convite (como no relatório). A chegada já aparece na caixa marcada; para quem
      // já fez check-in mostra o status que tinha antes (confirmou ou não), que é o que interessa à recepção.
      situacao: c.status !== 'checkin' ? c.status
        : (['pendente', 'enviado', 'confirmado'].includes(c.status_antes_checkin) ? c.status_antes_checkin : c.confirmado_em ? 'confirmado' : 'enviado'),
      presente: c.status === 'checkin',
      hora: c.status === 'checkin' && c.checkin_em ? String(c.checkin_em).slice(11, 16) : '',
    }))
    // Empresas A→Z (convites individuais no fim); convidados A→Z dentro de cada empresa
    .sort((a, b) => (a.empresa === '') - (b.empresa === '') || alfa.compare(a.empresa, b.empresa) || alfa.compare(a.nome, b.nome));
  res.json({ evento: { nome: evento.nome, data_evento: evento.data_evento, hora_evento: evento.hora_evento, local_nome: evento.local_nome }, convidados: lista });
});

// Marca / desmarca presença
router.post('/api/credenciamento/:token/presenca', (req, res) => {
  const evento = eventoDoLink(req, res);
  if (!evento) return;
  const id = Number(req.body?.convidado_id);
  const presente = req.body?.presente === true;
  const c = db.prepare(`SELECT id, nome, status, status_antes_checkin, confirmado_em, checkin_em FROM convidados WHERE id=? AND evento_id=?`).get(id, evento.id);
  if (!c) return res.status(404).json({ erro: 'Convidado não encontrado neste evento.' });
  if (c.status === 'cancelado') return res.status(400).json({ erro: `O convite de ${c.nome} foi cancelado. Procure o organizador.` });

  if (presente && c.status !== 'checkin') {
    db.prepare(`UPDATE convidados SET status='checkin', status_antes_checkin=status, checkin_em=datetime('now','localtime'),
                checkin_por='Lista de credenciamento' WHERE id=?`).run(c.id);
  } else if (!presente && c.status === 'checkin') {
    // Desfaz um "tique" errado: volta exatamente ao status de antes do check-in
    // (check-ins antigos, sem esse registro: confirmado se já tinha confirmado, senão convite enviado)
    const anterior = ['pendente', 'enviado', 'confirmado'].includes(c.status_antes_checkin) ? c.status_antes_checkin
      : c.confirmado_em ? 'confirmado' : 'enviado';
    db.prepare(`UPDATE convidados SET status=?, status_antes_checkin=NULL, checkin_em=NULL, checkin_por=NULL WHERE id=?`)
      .run(anterior, c.id);
  }
  const atual = db.prepare(`SELECT status, checkin_em FROM convidados WHERE id=?`).get(c.id);
  res.json({ ok: true, presente: atual.status === 'checkin', hora: atual.status === 'checkin' && atual.checkin_em ? String(atual.checkin_em).slice(11, 16) : '' });
});

module.exports = router;
