'use strict';
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { db, UPLOADS_DIR } = require('../db');
const { qrDoConvite } = require('../envio');

const router = express.Router();
const BASE_URL = () => (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// HTML-base do convite, lido uma vez; os dados de cada convite continuam vindo
// do cliente via /api/convite/:token — só as tags de preview (Open Graph) abaixo
// são montadas por evento antes de servir a página.
const CONVITE_HTML_BASE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'convite.html'), 'utf8');

function escAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Banner do convite (imagem enviada pelo organizador)
router.get('/banners/:arquivo', (req, res) => {
  const arquivo = path.basename(req.params.arquivo); // evita path traversal
  const caminho = path.join(UPLOADS_DIR, arquivo);
  res.sendFile(caminho, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// Página do convite digital — injeta título/descrição/imagem (Open Graph) do PRÓPRIO
// evento para o preview de link no WhatsApp e redes sociais. Sem JS envolvido: robôs de
// preview não executam o script da página, então essas tags precisam vir prontas aqui.
router.get('/convite/:token', (req, res) => {
  const c = db.prepare(`SELECT evento_id FROM convidados WHERE token=?`).get(req.params.token);
  const evento = c ? db.prepare(`SELECT nome, descricao, banner FROM eventos WHERE id=?`).get(c.evento_id) : null;

  const titulo = evento ? `Convite — ${evento.nome}` : 'Seu Convite';
  const descricao = evento?.descricao ? evento.descricao.slice(0, 200) : 'Você foi convidado(a) para este evento.';
  const imagem = evento?.banner ? `${BASE_URL()}/banners/${evento.banner}` : `${BASE_URL()}/logo-branco.png`;
  const url = `${BASE_URL()}/convite/${req.params.token}`;

  const tags = `<title>${escAttr(titulo)}</title>
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escAttr(titulo)}">
  <meta property="og:description" content="${escAttr(descricao)}">
  <meta property="og:image" content="${escAttr(imagem)}">
  <meta property="og:url" content="${escAttr(url)}">
  <meta name="twitter:card" content="summary_large_image">`;

  res.type('html').send(CONVITE_HTML_BASE.replace('<title>Seu Convite</title>', tags));
});

// Dados do convite digital (público, via token secreto)
router.get('/api/convite/:token', async (req, res) => {
  const c = db.prepare(`
    SELECT c.id, c.nome, c.cargo, c.status, c.cadeira, c.token, c.codigo, c.tipo,
           u.empresa_nome, m.numero AS mesa_numero, m.nome AS mesa_nome
    FROM convidados c
    LEFT JOIN usuarios u ON u.id = c.empresa_id
    LEFT JOIN mesas m ON m.id = c.mesa_id
    WHERE c.token = ?
  `).get(req.params.token);
  if (!c) return res.status(404).json({ erro: 'Convite não encontrado.' });
  if (c.status === 'cancelado') return res.status(410).json({ erro: 'Este convite foi cancelado.' });

  const convidado = db.prepare(`SELECT evento_id FROM convidados WHERE token=?`).get(req.params.token);
  const evento = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(convidado.evento_id);
  const qr = await qrDoConvite(c.token);
  let hoteis = [], facilities = [];
  try { hoteis = JSON.parse(evento.hoteis || '[]'); } catch {}
  try { facilities = JSON.parse(evento.facilities || '[]'); } catch {}

  const mapaAtivo = evento.mapa_mesas !== 0;
  res.json({
    convidado: {
      nome: c.nome, cargo: c.cargo, empresa: c.empresa_nome, status: c.status, codigo: c.codigo,
      mesa_numero: mapaAtivo ? c.mesa_numero : null,
      mesa_nome: mapaAtivo ? c.mesa_nome : null,
      cadeira: mapaAtivo ? c.cadeira : null,
    },
    evento: {
      nome: evento.nome, data_evento: evento.data_evento, hora_evento: evento.hora_evento,
      local_nome: evento.local_nome, endereco: evento.endereco,
      descricao: evento.descricao, dress_code: evento.dress_code,
      hoteis, facilities,
      banner_url: evento.banner ? '/banners/' + evento.banner : null,
      email_titulo: evento.email_titulo || '', email_texto: evento.email_texto || '',
      email_rodape: evento.email_rodape || '',
    },
    qr,
  });
});

// Confirmação de presença pelo próprio convidado
router.post('/api/convite/:token/confirmar', (req, res) => {
  const c = db.prepare(`SELECT * FROM convidados WHERE token=?`).get(req.params.token);
  if (!c) return res.status(404).json({ erro: 'Convite não encontrado.' });
  if (c.status === 'cancelado') return res.status(410).json({ erro: 'Este convite foi cancelado.' });
  if (c.status === 'checkin') return res.json({ ok: true, mensagem: 'Presença já registrada no evento.' });
  if (c.status !== 'confirmado') {
    db.prepare(`UPDATE convidados SET status='confirmado', confirmado_em=datetime('now','localtime') WHERE id=?`).run(c.id);
  }
  res.json({ ok: true, mensagem: 'Presença confirmada. Até lá!' });
});

module.exports = router;
