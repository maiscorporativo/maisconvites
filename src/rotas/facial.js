'use strict';
// Cadastro facial feito pelo PRÓPRIO convidado, na página do convite (link secreto).
// Exige consentimento explícito; o convidado pode remover o cadastro quando quiser.

const express = require('express');
const { db } = require('../db');
const F = require('../facial');

const router = express.Router();

// Limite simples por convite: evita abuso do endpoint (cada envio processa ~1 KB)
const envios = new Map();
function muitosEnvios(token) {
  const agora = Date.now(), r = envios.get(token);
  if (!r || agora - r.inicio > 60 * 60 * 1000) { envios.set(token, { inicio: agora, n: 1 }); return false; }
  r.n++;
  if (envios.size > 5000) for (const [k, v] of envios) if (agora - v.inicio > 60 * 60 * 1000) envios.delete(k);
  return r.n > 20;
}

function convite(req, res) {
  res.set('Cache-Control', 'no-store');
  const c = db.prepare(`SELECT c.id, c.evento_id, c.status, e.data_evento FROM convidados c JOIN eventos e ON e.id=c.evento_id WHERE c.token=?`).get(String(req.params.token || ''));
  if (!c) { res.status(404).json({ erro: 'Convite não encontrado.' }); return null; }
  if (c.status === 'cancelado') { res.status(410).json({ erro: 'Este convite foi cancelado.' }); return null; }
  return c;
}

const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ || 'America/Sao_Paulo' });

router.get('/api/convite/:token/facial', (req, res) => {
  const c = convite(req, res);
  if (!c) return;
  const cfg = F.configFacial(c.evento_id);
  const rosto = F.rostoDoConvidado(c.id);
  const apagarAte = F.dataExclusao(c, cfg);
  res.json({
    ativo: !!cfg.ativo && !(apagarAte && apagarAte <= hoje()),
    cadastrado: !!rosto,
    foto: rosto?.foto || '',
    cadastrado_em: rosto?.criado_em || null,
    apagar_ate: apagarAte,
  });
});

router.post('/api/convite/:token/facial', (req, res) => {
  const c = convite(req, res);
  if (!c) return;
  const cfg = F.configFacial(c.evento_id);
  if (!cfg.ativo) return res.status(400).json({ erro: 'O reconhecimento facial não está ativo para este evento.' });
  const apagarAte = F.dataExclusao(c, cfg);
  if (apagarAte && apagarAte <= hoje()) return res.status(400).json({ erro: 'O prazo para cadastrar o rosto neste evento já terminou.' });
  if (req.body?.consentimento !== true) return res.status(400).json({ erro: 'É preciso marcar a autorização para cadastrar o rosto.' });
  if (muitosEnvios(req.params.token)) return res.status(429).json({ erro: 'Muitas tentativas. Tente de novo mais tarde.' });
  const descritor = F.mediaDescritores(req.body?.descritores);
  if (!descritor) return res.status(400).json({ erro: 'Não conseguimos ler o rosto. Tire a foto de novo.' });
  const foto = F.validarFoto(req.body?.foto);
  if (foto === null) return res.status(400).json({ erro: 'Foto inválida. Tire a foto de novo.' });
  F.cadastrarRosto({ convidadoId: c.id, eventoId: c.evento_id, descritor, foto, origem: 'convite' });
  res.json({ ok: true, cadastrado: true, foto });
});

router.delete('/api/convite/:token/facial', (req, res) => {
  const c = convite(req, res);
  if (!c) return;
  F.removerRosto(c.id);
  res.json({ ok: true, cadastrado: false });
});

module.exports = router;
