'use strict';
// Reconhecimento facial do totem.
// O navegador (public/js/facial.js, com face-api) transforma o rosto numa "assinatura" de
// 128 números; aqui guardamos a assinatura do cadastro (feito pelo convidado no convite,
// com consentimento) e, no totem, procuramos a mais parecida do evento.
// Nada sai do nosso servidor: sem serviço externo de biometria.

const { db } = require('./db');

const DIM = 128;
// Distância euclidiana máxima para considerar a mesma pessoa (face-api: 0,6 é o "padrão
// solto"; usamos valores mais exigentes) e a folga mínima para o 2º mais parecido.
const LIMIARES = { normal: 0.5, rigoroso: 0.42 };
const FOLGA = 0.06;
const FOTO_MAX = 90 * 1024;

const PADRAO = { ativo: 0, prova_vida: 0, rigor: 'normal', apagar_dias: 7 };

function configFacial(eventoId) {
  const r = db.prepare(`SELECT * FROM evento_facial WHERE evento_id=?`).get(eventoId);
  if (!r) return { ...PADRAO };
  return {
    ativo: r.ativo ? 1 : 0, prova_vida: r.prova_vida ? 1 : 0,
    rigor: LIMIARES[r.rigor] ? r.rigor : 'normal',
    apagar_dias: Math.max(1, Number(r.apagar_dias) || 7),
    atualizado_em: r.atualizado_em, atualizado_por: r.atualizado_por,
  };
}

function salvarConfigFacial(eventoId, b, autor) {
  const a = configFacial(eventoId);
  const v = {
    ativo: b.ativo !== undefined ? (b.ativo ? 1 : 0) : a.ativo,
    prova_vida: b.prova_vida !== undefined ? (b.prova_vida ? 1 : 0) : a.prova_vida,
    rigor: LIMIARES[b.rigor] ? b.rigor : a.rigor,
    apagar_dias: b.apagar_dias !== undefined ? Math.min(90, Math.max(1, Math.round(Number(b.apagar_dias) || 7))) : a.apagar_dias,
  };
  db.prepare(`INSERT INTO evento_facial (evento_id, ativo, prova_vida, rigor, apagar_dias, atualizado_em, atualizado_por)
              VALUES (?,?,?,?,?,datetime('now','localtime'),?)
              ON CONFLICT(evento_id) DO UPDATE SET ativo=excluded.ativo, prova_vida=excluded.prova_vida, rigor=excluded.rigor,
                apagar_dias=excluded.apagar_dias, atualizado_em=excluded.atualizado_em, atualizado_por=excluded.atualizado_por`)
    .run(eventoId, v.ativo, v.prova_vida, v.rigor, v.apagar_dias, autor || '');
  return configFacial(eventoId);
}

/** Valida a assinatura vinda do navegador → Float32Array(128) ou null */
function lerDescritor(d) {
  if (!Array.isArray(d) || d.length !== DIM) return null;
  const v = new Float32Array(DIM);
  let norma = 0;
  for (let i = 0; i < DIM; i++) {
    const n = Number(d[i]);
    if (!Number.isFinite(n) || Math.abs(n) > 2) return null;
    v[i] = n; norma += n * n;
  }
  return norma > 0.05 ? v : null; // vetor "vazio" não é rosto
}

/** Média de várias leituras (mais estável que um quadro só) */
function mediaDescritores(lista) {
  const vs = (Array.isArray(lista) ? lista : []).slice(0, 5).map(lerDescritor).filter(Boolean);
  if (!vs.length) return null;
  const m = new Float32Array(DIM);
  for (const v of vs) for (let i = 0; i < DIM; i++) m[i] += v[i] / vs.length;
  return m;
}

function validarFoto(foto) {
  const f = String(foto || '');
  if (!f) return '';
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(f) || f.length > FOTO_MAX) return null;
  return f;
}

const paraBlob = v => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const deBlob = b => new Float32Array(new Uint8Array(b).buffer); // cópia alinhada

// ── Cache por evento (a busca é em memória: milhares de rostos em poucos ms) ──
// Em produção há mais de um processo Node; por isso o cache é validado a cada busca por
// uma "assinatura" barata da tabela (cadastro feito em outro processo também é visto).
const cache = new Map();
function invalidar(eventoId) { if (eventoId == null) cache.clear(); else cache.delete(Number(eventoId)); }
function rostosDoEvento(eventoId) {
  const id = Number(eventoId);
  const s = db.prepare(`SELECT COUNT(*) n, COALESCE(MAX(criado_em),'') m, COALESCE(SUM(convidado_id),0) t,
                          (SELECT COUNT(*) FROM convidados WHERE evento_id=? AND status='cancelado') x
                        FROM convidado_faces WHERE evento_id=?`).get(id, id);
  const assinatura = `${s.n}|${s.m}|${s.t}|${s.x}`;
  const c = cache.get(id);
  if (c && c.assinatura === assinatura) return c.lista;
  const linhas = db.prepare(`SELECT f.convidado_id, f.descritor FROM convidado_faces f
                             JOIN convidados c ON c.id=f.convidado_id
                             WHERE f.evento_id=? AND c.status!='cancelado'`).all(id);
  const lista = linhas.map(l => ({ id: l.convidado_id, v: deBlob(l.descritor) }));
  cache.set(id, { assinatura, lista });
  return lista;
}

function distancia(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

/**
 * Procura o convidado do evento. Só aceita se o mais parecido estiver abaixo do limiar E
 * bem à frente do segundo (evita confundir pessoas parecidas — na dúvida, pede o QR).
 */
function reconhecer(eventoId, descritor, rigor = 'normal') {
  const limiar = LIMIARES[rigor] || LIMIARES.normal;
  let melhor = null, segundo = Infinity;
  for (const r of rostosDoEvento(eventoId)) {
    const d = distancia(descritor, r.v);
    if (!melhor || d < melhor.d) { if (melhor) segundo = melhor.d; melhor = { id: r.id, d }; }
    else if (d < segundo) segundo = d;
  }
  if (!melhor) return { ok: false, motivo: 'sem_cadastros' };
  if (melhor.d > limiar) return { ok: false, motivo: 'nao_reconhecido', distancia: melhor.d };
  if (segundo - melhor.d < FOLGA) return { ok: false, motivo: 'ambiguo', distancia: melhor.d };
  return { ok: true, convidado_id: melhor.id, distancia: melhor.d };
}

function cadastrarRosto({ convidadoId, eventoId, descritor, foto, origem }) {
  db.prepare(`INSERT INTO convidado_faces (convidado_id, evento_id, descritor, foto, origem, consentimento_em, criado_em)
              VALUES (?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))
              ON CONFLICT(convidado_id) DO UPDATE SET evento_id=excluded.evento_id, descritor=excluded.descritor, foto=excluded.foto,
                origem=excluded.origem, consentimento_em=excluded.consentimento_em, criado_em=excluded.criado_em`)
    .run(convidadoId, eventoId, paraBlob(descritor), foto || '', origem || 'convite');
  invalidar(eventoId);
}

function removerRosto(convidadoId) {
  const r = db.prepare(`SELECT evento_id FROM convidado_faces WHERE convidado_id=?`).get(convidadoId);
  if (!r) return false;
  db.prepare(`DELETE FROM convidado_faces WHERE convidado_id=?`).run(convidadoId);
  invalidar(r.evento_id);
  return true;
}

function removerRostosDoEvento(eventoId) {
  const n = db.prepare(`DELETE FROM convidado_faces WHERE evento_id=?`).run(eventoId).changes;
  invalidar(eventoId);
  return n;
}

function rostoDoConvidado(convidadoId) {
  return db.prepare(`SELECT foto, origem, consentimento_em, criado_em FROM convidado_faces WHERE convidado_id=?`).get(convidadoId) || null;
}

function estatisticas(eventoId) {
  const r = db.prepare(`SELECT COUNT(f.convidado_id) cadastrados, COUNT(c.id) total
                        FROM convidados c LEFT JOIN convidado_faces f ON f.convidado_id=c.id
                        WHERE c.evento_id=? AND c.status!='cancelado'`).get(eventoId);
  return { cadastrados: r.cadastrados || 0, total: r.total || 0 };
}

/** Data em que os rostos são apagados (YYYY-MM-DD) — mostrada ao convidado no consentimento.
 *  Mínimo de 1 dia depois da data do evento (congressos de vários dias continuam funcionando). */
function dataExclusao(evento, cfg) {
  if (!evento?.data_evento) return null;
  const d = new Date(evento.data_evento + 'T12:00:00');
  d.setDate(d.getDate() + Math.max(1, cfg.apagar_dias || 7));
  return d.toISOString().slice(0, 10);
}

/** Apaga os rostos dos eventos que já passaram do prazo (roda ao iniciar e de hora em hora) */
function limpezaAutomatica() {
  try {
    const r = db.prepare(`DELETE FROM convidado_faces WHERE evento_id IN (
        SELECT e.id FROM eventos e LEFT JOIN evento_facial f ON f.evento_id=e.id
        WHERE date(e.data_evento, '+' || MAX(1, COALESCE(f.apagar_dias, 7)) || ' days') < date('now','localtime'))`).run();
    if (r.changes) { invalidar(); console.log(`[facial] ${r.changes} cadastro(s) facial(is) apagado(s) após o prazo do evento.`); }
  } catch (e) { console.error('[facial] limpeza automática falhou:', e.message); }
}
limpezaAutomatica();
setInterval(limpezaAutomatica, 60 * 60 * 1000).unref();

module.exports = {
  configFacial, salvarConfigFacial, lerDescritor, mediaDescritores, validarFoto, reconhecer,
  cadastrarRosto, removerRosto, removerRostosDoEvento, rostoDoConvidado, estatisticas, dataExclusao,
  limpezaAutomatica, LIMIARES,
};
