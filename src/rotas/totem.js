'use strict';
// Totem de autocredenciamento (tablet na entrada do evento).
// SEM LOGIN: acesso só pelo link secreto do totem (tabela totem_links).
// Fluxo: identificar (QR do convite ou código de 6 dígitos) → "É você?" → confirmar
// → check-in + etiqueta (se o evento imprime). A confirmação exige o bilhete assinado
// devolvido na identificação, válido por poucos minutos.

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('../db');
const { matrizQr, configEtiqueta, dadosEtiqueta, SQL_CONVIDADO } = require('../etiquetas');
const F = require('../facial');

const router = express.Router();
const SEGREDO = process.env.SESSION_SECRET || 'segredo-dev-trocar-em-producao';
const VALIDADE_BILHETE = 3 * 60 * 1000;
const limpo = s => String(s ?? '').trim().replace(/\s+/g, ' ');

function semRastro(res) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');
}

function eventoDoTotem(req, res) {
  semRastro(res);
  const token = String(req.params.token || '');
  const l = token.length >= 20 ? db.prepare(`SELECT evento_id FROM totem_links WHERE token=?`).get(token) : null;
  if (!l) { res.status(404).json({ erro: 'Totem desativado ou link inválido. Peça um novo link ao organizador.' }); return null; }
  return db.prepare(`SELECT id, nome, data_evento, hora_evento, local_nome FROM eventos WHERE id=?`).get(l.evento_id);
}

// ── Limite de tentativas sem sucesso por aparelho/IP (evita "chutar" códigos) ──
const falhas = new Map();
const JANELA = 10 * 60 * 1000, MAX_FALHAS = 25;
function bloqueado(ip) {
  const f = falhas.get(ip);
  if (!f || Date.now() - f.inicio > JANELA) return false;
  return f.n >= MAX_FALHAS;
}
function registrarFalha(ip) {
  const f = falhas.get(ip);
  if (!f || Date.now() - f.inicio > JANELA) falhas.set(ip, { inicio: Date.now(), n: 1 });
  else f.n++;
  if (falhas.size > 5000) for (const [k, v] of falhas) if (Date.now() - v.inicio > JANELA) falhas.delete(k);
}

// Reconhecimento facial: rostos não cadastrados são comuns (não é "chute"), então o limite
// é bem mais alto e separado do de códigos.
const falhasFace = new Map();
const MAX_FALHAS_FACE = 150;
function bloqueadoFace(ip) { const f = falhasFace.get(ip); return !!f && Date.now() - f.inicio <= JANELA && f.n >= MAX_FALHAS_FACE; }
function registrarFalhaFace(ip) {
  const f = falhasFace.get(ip);
  if (!f || Date.now() - f.inicio > JANELA) falhasFace.set(ip, { inicio: Date.now(), n: 1 }); else f.n++;
  if (falhasFace.size > 5000) for (const [k, v] of falhasFace) if (Date.now() - v.inicio > JANELA) falhasFace.delete(k);
}

const assinar = txt => crypto.createHmac('sha256', SEGREDO).update(txt).digest('base64url').slice(0, 32);
function criarBilhete(tokenTotem, convidadoId) {
  const exp = Date.now() + VALIDADE_BILHETE;
  return `${convidadoId}.${exp}.${assinar(`${tokenTotem}|${convidadoId}|${exp}`)}`;
}
function lerBilhete(tokenTotem, bilhete) {
  const [id, exp, sig] = String(bilhete || '').split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
  const esperado = assinar(`${tokenTotem}|${id}|${exp}`);
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  return Number(id);
}

function etiquetaPublica(cfg) {
  return { imprime: !!cfg.imprime, automatica: !!cfg.automatica, modelo: cfg.modelo, max_reimpressoes: cfg.max_reimpressoes };
}
function facialPublica(eventoId) {
  const f = F.configFacial(eventoId);
  return { ativo: !!f.ativo, prova_vida: !!f.prova_vida, cadastrados: f.ativo ? F.estatisticas(eventoId).cadastrados : 0 };
}
function impressoesPermitidas(cfg) { return 1 + (cfg.max_reimpressoes || 0); }

// Página do totem
router.get('/totem/:token', (req, res, next) => {
  if (req.params.token === 'teste') return next();
  semRastro(res);
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'totem.html'));
});

// Página de teste da impressora (não mostra nenhum dado de convidado)
router.get('/totem/teste', (req, res) => {
  semRastro(res);
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'totem-teste.html'));
});

// Matriz de QR para a página de teste
router.get('/api/totem/qr', (req, res) => {
  const texto = String(req.query.texto || '');
  if (!texto || texto.length > 300) return res.status(400).json({ erro: 'Texto do QR code ausente ou longo demais.' });
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(matrizQr(texto));
});

// Dados do evento + configuração da etiqueta
router.get('/api/totem/:token', (req, res) => {
  const evento = eventoDoTotem(req, res);
  if (!evento) return;
  const cfg = configEtiqueta(evento.id);
  const total = db.prepare(`SELECT COUNT(*) n, SUM(status='checkin') p FROM convidados WHERE evento_id=? AND status!='cancelado'`).get(evento.id);
  res.json({
    evento: { nome: evento.nome, data_evento: evento.data_evento, hora_evento: evento.hora_evento, local_nome: evento.local_nome },
    titulo: cfg.totem_titulo || '',
    etiqueta: etiquetaPublica(cfg),
    facial: facialPublica(evento.id),
    presentes: total.p || 0, total: total.n || 0,
  });
});

// Identifica o convidado pelo QR do convite (link/token) ou pelo código de 6 dígitos
router.post('/api/totem/:token/identificar', (req, res) => {
  const evento = eventoDoTotem(req, res);
  if (!evento) return;
  const ip = req.ip || 'x';
  if (bloqueado(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Procure a recepção.' });

  let entrada = String(req.body?.entrada || '').trim();
  const m = entrada.match(/\/convite\/([a-f0-9]+)/i);
  if (m) entrada = m[1];
  entrada = entrada.replace(/[\s.-]/g, '').toLowerCase();
  const valida = /^\d{6}$/.test(entrada) || /^[a-f0-9]{16,64}$/.test(entrada);
  const c = valida ? db.prepare(`${SQL_CONVIDADO} WHERE c.evento_id=? AND (c.token=? OR c.codigo=?)`).get(evento.id, entrada, entrada) : null;
  if (!c) {
    registrarFalha(ip);
    return res.status(404).json({ erro: 'Não encontramos esse convite neste evento. Confira o código ou procure a recepção.' });
  }
  if (c.status === 'cancelado') return res.status(400).json({ erro: 'Este convite está cancelado. Por favor, procure a recepção.' });

  res.json(respostaIdentificacao(req.params.token, evento, c));
});

function respostaIdentificacao(tokenTotem, evento, c, extra = {}) {
  const cfg = configEtiqueta(evento.id);
  const restantes = cfg.imprime ? Math.max(0, impressoesPermitidas(cfg) - (c.etiquetas_impressas || 0)) : 0;
  return {
    bilhete: criarBilhete(tokenTotem, c.id),
    convidado: {
      nome: limpo(c.nome), primeiro_nome: limpo(c.nome).split(' ')[0] || '',
      empresa: c.empresa_nome ? limpo(c.empresa_nome) : '', cargo: limpo(c.cargo),
    },
    ja_credenciado: c.status === 'checkin',
    checkin_em: c.status === 'checkin' ? c.checkin_em : null,
    etiquetas_restantes: restantes,
    ...extra,
  };
}

// Reconhecimento facial: o tablet manda 1 a 5 leituras (assinaturas de 128 números) do rosto
router.post('/api/totem/:token/reconhecer', (req, res) => {
  const evento = eventoDoTotem(req, res);
  if (!evento) return;
  const cfgF = F.configFacial(evento.id);
  if (!cfgF.ativo) return res.status(400).json({ erro: 'Reconhecimento facial desligado para este evento.', motivo: 'desligado' });
  const ip = req.ip || 'x';
  if (bloqueadoFace(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Use o QR code ou procure a recepção.', motivo: 'bloqueado' });
  const descritor = F.mediaDescritores(req.body?.descritores);
  if (!descritor) return res.status(400).json({ erro: 'Leitura do rosto inválida.', motivo: 'invalido' });
  const r = F.reconhecer(evento.id, descritor, cfgF.rigor);
  if (!r.ok) {
    registrarFalhaFace(ip);
    return res.status(404).json({ erro: 'Não reconhecemos seu rosto. Mostre o QR code do convite ou digite o código.', motivo: r.motivo });
  }
  const c = db.prepare(`${SQL_CONVIDADO} WHERE c.id=? AND c.evento_id=?`).get(r.convidado_id, evento.id);
  if (!c) return res.status(404).json({ erro: 'Não reconhecemos seu rosto.', motivo: 'nao_reconhecido' });
  if (c.status === 'cancelado') return res.status(400).json({ erro: 'Este convite está cancelado. Por favor, procure a recepção.' });
  const rosto = F.rostoDoConvidado(c.id);
  res.json(respostaIdentificacao(req.params.token, evento, c, { por: 'facial', foto: rosto?.foto || '', confianca: Math.round((1 - r.distancia) * 100) }));
});

// Confirma: faz o check-in e devolve a etiqueta (se o evento imprime e ainda há impressões)
router.post('/api/totem/:token/confirmar', (req, res) => {
  const evento = eventoDoTotem(req, res);
  if (!evento) return;
  const id = lerBilhete(req.params.token, req.body?.bilhete);
  if (!id) return res.status(400).json({ erro: 'Tempo esgotado. Faça a leitura de novo.' });
  const c = db.prepare(`${SQL_CONVIDADO} WHERE c.id=? AND c.evento_id=?`).get(id, evento.id);
  if (!c) return res.status(404).json({ erro: 'Convite não encontrado.' });
  if (c.status === 'cancelado') return res.status(400).json({ erro: 'Este convite está cancelado. Por favor, procure a recepção.' });

  const cfg = configEtiqueta(evento.id);
  const reimpressao = c.status === 'checkin';
  const querImprimir = !!req.body?.imprimir;
  let novoCheckin = false;
  if (c.status !== 'checkin') {
    db.prepare(`UPDATE convidados SET status='checkin', status_antes_checkin=status, checkin_em=datetime('now','localtime'),
                checkin_por=? WHERE id=? AND status!='checkin'`).run(req.body?.por === 'facial' ? 'Totem (reconhecimento facial)' : 'Totem de autocredenciamento', c.id);
    novoCheckin = true;
  }
  let etiqueta = null, aviso = '';
  if (cfg.imprime && querImprimir) {
    // Atômico: só incrementa se ainda houver impressão disponível
    const r = db.prepare(`UPDATE convidados SET etiquetas_impressas=COALESCE(etiquetas_impressas,0)+1, etiqueta_impressa_em=datetime('now','localtime')
                          WHERE id=? AND COALESCE(etiquetas_impressas,0) < ?`).run(c.id, impressoesPermitidas(cfg));
    if (r.changes) etiqueta = dadosEtiqueta(c, cfg);
    else aviso = 'Sua etiqueta já foi impressa. Se precisar de outra, procure a recepção.';
  }
  const atual = db.prepare(`SELECT checkin_em, etiquetas_impressas FROM convidados WHERE id=?`).get(c.id);
  res.json({
    ok: true, novo_checkin: novoCheckin, reimpressao, checkin_em: atual.checkin_em,
    etiqueta, aviso,
    etiquetas_restantes: cfg.imprime ? Math.max(0, impressoesPermitidas(cfg) - (atual.etiquetas_impressas || 0)) : 0,
  });
});

// A impressão falhou no tablet: devolve a impressão gasta para poder tentar de novo
router.post('/api/totem/:token/falha-impressao', (req, res) => {
  const evento = eventoDoTotem(req, res);
  if (!evento) return;
  const id = lerBilhete(req.params.token, req.body?.bilhete);
  if (!id) return res.status(400).json({ erro: 'Tempo esgotado.' });
  db.prepare(`UPDATE convidados SET etiquetas_impressas=MAX(0, COALESCE(etiquetas_impressas,0)-1) WHERE id=? AND evento_id=?`).run(id, evento.id);
  res.json({ ok: true });
});

module.exports = router;
