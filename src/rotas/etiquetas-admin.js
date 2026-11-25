'use strict';
// Painel: etiquetas de crachá (configuração por evento, editor, biblioteca de modelos,
// impressão em lote, categorias) e link do totem de autocredenciamento.

const express = require('express');
const crypto = require('node:crypto');
const { db } = require('../db');
const { exigirAdminEvento, podeAcessarEvento, descreverUsuario } = require('../auth');
const F = require('../facial');
const { configEtiqueta, salvarConfigEtiqueta, validarModelo, dadosEtiqueta, SQL_CONVIDADO } = require('../etiquetas');

const router = express.Router();
router.use(exigirAdminEvento);

const alfa = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const limpo = s => String(s ?? '').trim().replace(/\s+/g, ' ');

function eventoDoEscopo(req, res, eventoId) {
  if (!podeAcessarEvento(req.session.usuario, eventoId)) { res.status(403).json({ erro: 'Você não tem acesso a este evento.' }); return null; }
  const e = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(eventoId);
  if (!e) { res.status(404).json({ erro: 'Evento não encontrado.' }); return null; }
  return e;
}

function urlTotem(token) {
  return `${(process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')}/totem/${token}`;
}

function categoriasDoEvento(eventoId, padrao) {
  const usadas = db.prepare(`SELECT DISTINCT TRIM(categoria) c FROM convidados WHERE evento_id=? AND TRIM(COALESCE(categoria,''))!=''`).all(eventoId).map(r => r.c.toLocaleUpperCase('pt-BR'));
  return [...new Set([padrao, ...usadas].filter(Boolean))].sort(alfa.compare);
}

// ── Configuração + modelo do evento ──
router.get('/eventos/:id/etiqueta', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const cfg = configEtiqueta(e.id);
  const link = db.prepare(`SELECT token, criado_em, criado_por FROM totem_links WHERE evento_id=?`).get(e.id);
  const impressas = db.prepare(`SELECT COUNT(*) n FROM convidados WHERE evento_id=? AND etiquetas_impressas>0 AND status!='cancelado'`).get(e.id).n;
  res.json({
    evento: { id: e.id, nome: e.nome, mapa_mesas: e.mapa_mesas },
    config: cfg,
    categorias: categoriasDoEvento(e.id, cfg.categoria_padrao),
    totem: link ? { ativo: true, url: urlTotem(link.token), criado_em: link.criado_em, criado_por: link.criado_por } : { ativo: false },
    etiquetas_impressas: impressas,
  });
});

router.put('/eventos/:id/etiqueta', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  if (req.body?.modelo !== undefined && req.body.modelo !== null && !validarModelo(req.body.modelo)) {
    return res.status(400).json({ erro: 'Modelo de etiqueta inválido.' });
  }
  const cfg = salvarConfigEtiqueta(e.id, req.body || {}, descreverUsuario(req.session.usuario));
  res.json({ ok: true, config: cfg });
});

// ── Dados para pré-visualização e impressão em lote ──
// ?ids=1,2,3  ou  ?empresa=<id|individual>&situacao=<todos|confirmados|presentes|nao_impressos>&busca=
router.get('/eventos/:id/etiqueta/dados', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const cfg = configEtiqueta(e.id);
  let lista;
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map(Number).filter(Number.isInteger).slice(0, 2000);
    if (!ids.length) return res.json({ convidados: [] });
    lista = db.prepare(`${SQL_CONVIDADO} WHERE c.evento_id=? AND c.id IN (${ids.map(() => '?').join(',')})`).all(e.id, ...ids);
  } else {
    lista = db.prepare(`${SQL_CONVIDADO} WHERE c.evento_id=? AND c.status!='cancelado'`).all(e.id);
    const emp = String(req.query.empresa || '');
    if (emp === 'individual') lista = lista.filter(c => !c.empresa_id);
    else if (emp) lista = lista.filter(c => c.empresa_id === Number(emp));
    const sit = String(req.query.situacao || 'todos');
    if (sit === 'confirmados') lista = lista.filter(c => c.status === 'confirmado' || c.status === 'checkin');
    if (sit === 'presentes') lista = lista.filter(c => c.status === 'checkin');
    if (sit === 'nao_impressos') lista = lista.filter(c => !c.etiquetas_impressas);
    const cat = limpo(req.query.categoria).toLocaleUpperCase('pt-BR');
    if (cat) lista = lista.filter(c => (limpo(c.categoria) || cfg.categoria_padrao || '').toLocaleUpperCase('pt-BR') === cat);
  }
  lista.sort((a, b) => (!a.empresa_nome) - (!b.empresa_nome) || alfa.compare(a.empresa_nome || '', b.empresa_nome || '') || alfa.compare(a.nome, b.nome));
  res.json({
    convidados: lista.slice(0, 2000).map(c => ({ ...dadosEtiqueta(c, cfg), status: c.status, etiquetas_impressas: c.etiquetas_impressas || 0 })),
  });
});

// Registra etiquetas impressas pelo painel (lote)
router.post('/eventos/:id/etiqueta/impressas', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 2000);
  const upd = db.prepare(`UPDATE convidados SET etiquetas_impressas=COALESCE(etiquetas_impressas,0)+1, etiqueta_impressa_em=datetime('now','localtime') WHERE id=? AND evento_id=?`);
  let n = 0;
  db.exec('BEGIN');
  try { for (const id of ids) n += upd.run(id, e.id).changes; db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
  res.json({ ok: true, registradas: n });
});

// ── Categoria do convidado (VISITANTE, PALESTRANTE, IMPRENSA…) ──
router.put('/eventos/:id/categorias', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 5000);
  const categoria = limpo(req.body?.categoria).toLocaleUpperCase('pt-BR').slice(0, 40);
  if (!ids.length) return res.status(400).json({ erro: 'Selecione ao menos um convidado.' });
  const upd = db.prepare(`UPDATE convidados SET categoria=? WHERE id=? AND evento_id=?`);
  let n = 0;
  db.exec('BEGIN');
  try { for (const id of ids) n += upd.run(categoria, id, e.id).changes; db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
  res.json({ ok: true, alterados: n, categorias: categoriasDoEvento(e.id, configEtiqueta(e.id).categoria_padrao) });
});

// Lista enxuta para escolher convidados no editor (busca / lote / categorias)
router.get('/eventos/:id/etiqueta/convidados', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const cfg = configEtiqueta(e.id);
  const lista = db.prepare(`
    SELECT c.id, c.nome, c.cargo, c.codigo, c.status, c.categoria, c.etiquetas_impressas, c.empresa_id, u.empresa_nome
    FROM convidados c LEFT JOIN usuarios u ON u.id=c.empresa_id
    WHERE c.evento_id=? AND c.status!='cancelado'`).all(e.id)
    .map(c => ({ id: c.id, nome: limpo(c.nome), cargo: limpo(c.cargo), codigo: c.codigo || '', status: c.status,
      categoria: limpo(c.categoria) || '', categoria_efetiva: (limpo(c.categoria) || cfg.categoria_padrao || '').toLocaleUpperCase('pt-BR'),
      etiquetas_impressas: c.etiquetas_impressas || 0, empresa_id: c.empresa_id, empresa: limpo(c.empresa_nome) }))
    .sort((a, b) => (!a.empresa) - (!b.empresa) || alfa.compare(a.empresa, b.empresa) || alfa.compare(a.nome, b.nome));
  res.json({ convidados: lista });
});

// ── Biblioteca de modelos (compartilhada entre eventos) ──
router.get('/etiqueta-modelos', (req, res) => {
  const lista = db.prepare(`SELECT id, nome, modelo, criado_por, criado_em FROM etiqueta_modelos ORDER BY nome COLLATE NOCASE`).all()
    .map(m => { let modelo = null; try { modelo = JSON.parse(m.modelo); } catch {} return { ...m, modelo }; })
    .filter(m => m.modelo);
  res.json({ modelos: lista });
});

router.post('/etiqueta-modelos', (req, res) => {
  const nome = limpo(req.body?.nome).slice(0, 80);
  const modelo = validarModelo(req.body?.modelo);
  if (!nome) return res.status(400).json({ erro: 'Dê um nome ao modelo.' });
  if (!modelo) return res.status(400).json({ erro: 'Modelo de etiqueta inválido.' });
  const existente = db.prepare(`SELECT id FROM etiqueta_modelos WHERE nome=? COLLATE NOCASE`).get(nome);
  if (existente && !req.body?.substituir) return res.status(409).json({ erro: `Já existe um modelo chamado “${nome}”.`, existente: existente.id });
  if (existente) db.prepare(`UPDATE etiqueta_modelos SET modelo=?, criado_por=?, criado_em=datetime('now','localtime') WHERE id=?`).run(JSON.stringify(modelo), descreverUsuario(req.session.usuario), existente.id);
  else db.prepare(`INSERT INTO etiqueta_modelos (nome, modelo, criado_por) VALUES (?,?,?)`).run(nome, JSON.stringify(modelo), descreverUsuario(req.session.usuario));
  res.json({ ok: true });
});

router.delete('/etiqueta-modelos/:id', (req, res) => {
  const m = db.prepare(`SELECT * FROM etiqueta_modelos WHERE id=?`).get(req.params.id);
  if (!m) return res.status(404).json({ erro: 'Modelo não encontrado.' });
  const u = req.session.usuario;
  if (u.role !== 'master' && m.criado_por !== descreverUsuario(u)) return res.status(403).json({ erro: 'Só quem criou o modelo (ou o master) pode excluí-lo.' });
  db.prepare(`DELETE FROM etiqueta_modelos WHERE id=?`).run(m.id);
  res.json({ ok: true });
});

// ── Link do totem (sem login, só pelo link secreto) ──
router.post('/eventos/:id/totem-link', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO totem_links (evento_id, token, criado_por, criado_em) VALUES (?, ?, ?, datetime('now','localtime'))
              ON CONFLICT(evento_id) DO UPDATE SET token=excluded.token, criado_por=excluded.criado_por, criado_em=excluded.criado_em`)
    .run(e.id, token, descreverUsuario(req.session.usuario));
  res.json({ ativo: true, url: urlTotem(token) });
});

router.delete('/eventos/:id/totem-link', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  db.prepare(`DELETE FROM totem_links WHERE evento_id=?`).run(e.id);
  res.json({ ativo: false });
});

// ── Reconhecimento facial do totem ──
router.get('/eventos/:id/facial', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const cfg = F.configFacial(e.id);
  res.json({ config: cfg, ...F.estatisticas(e.id), apagar_ate: F.dataExclusao(e, cfg) });
});

router.put('/eventos/:id/facial', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const cfg = F.salvarConfigFacial(e.id, req.body || {}, descreverUsuario(req.session.usuario));
  res.json({ ok: true, config: cfg, ...F.estatisticas(e.id), apagar_ate: F.dataExclusao(e, cfg) });
});

// Apaga TODOS os cadastros faciais do evento (direito de exclusão / encerramento)
router.delete('/eventos/:id/facial/rostos', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const n = F.removerRostosDoEvento(e.id);
  console.log(`[facial] ${descreverUsuario(req.session.usuario)} apagou ${n} cadastro(s) facial(is) do evento ${e.id}`);
  res.json({ ok: true, apagados: n, ...F.estatisticas(e.id) });
});

// Apaga o cadastro facial de um convidado
router.delete('/eventos/:id/convidados/:cid/rosto', (req, res) => {
  const e = eventoDoEscopo(req, res, req.params.id);
  if (!e) return;
  const c = db.prepare(`SELECT id FROM convidados WHERE id=? AND evento_id=?`).get(req.params.cid, e.id);
  if (!c) return res.status(404).json({ erro: 'Convidado não encontrado.' });
  res.json({ ok: true, removido: F.removerRosto(c.id) });
});

module.exports = router;
