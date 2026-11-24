'use strict';
// Etiquetas de crachá: configuração por evento e dados de cada convidado para o motor
// de etiquetas do navegador (public/js/etiqueta.js), que desenha e imprime.

const QRCode = require('qrcode');
const { db } = require('./db');

const limpo = s => String(s ?? '').trim().replace(/\s+/g, ' ');
const baseUrl = () => (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// Matriz do QR code ({ n, bits }) — o navegador desenha os módulos na resolução da impressora
function matrizQr(texto) {
  const q = QRCode.create(String(texto), { errorCorrectionLevel: 'M' });
  const n = q.modules.size;
  let bits = '';
  for (let i = 0; i < n * n; i++) bits += q.modules.data[i] ? '1' : '0';
  return { n, bits };
}

const PADRAO = {
  imprime: 0, automatica: 1, modelo: null, qr_conteudo: 'link', categoria_padrao: 'CONVIDADO',
  max_reimpressoes: 1, totem_titulo: '',
};

function configEtiqueta(eventoId) {
  const r = db.prepare(`SELECT * FROM evento_etiqueta WHERE evento_id=?`).get(eventoId);
  if (!r) return { ...PADRAO };
  let modelo = null;
  try { modelo = r.modelo ? JSON.parse(r.modelo) : null; } catch { modelo = null; }
  return {
    imprime: r.imprime ? 1 : 0,
    automatica: r.automatica ? 1 : 0,
    modelo,
    qr_conteudo: ['link', 'codigo'].includes(r.qr_conteudo) ? r.qr_conteudo : 'link',
    categoria_padrao: r.categoria_padrao ?? 'CONVIDADO',
    max_reimpressoes: Math.max(0, Number(r.max_reimpressoes) || 0),
    totem_titulo: r.totem_titulo || '',
    atualizado_em: r.atualizado_em, atualizado_por: r.atualizado_por,
  };
}

/** Valida e grava a configuração (campos ausentes mantêm o valor atual) */
function salvarConfigEtiqueta(eventoId, b, autor) {
  const atual = configEtiqueta(eventoId);
  const modelo = b.modelo !== undefined ? validarModelo(b.modelo) : atual.modelo;
  const v = {
    imprime: b.imprime !== undefined ? (b.imprime ? 1 : 0) : atual.imprime,
    automatica: b.automatica !== undefined ? (b.automatica ? 1 : 0) : atual.automatica,
    qr_conteudo: ['link', 'codigo'].includes(b.qr_conteudo) ? b.qr_conteudo : atual.qr_conteudo,
    categoria_padrao: b.categoria_padrao !== undefined ? limpo(b.categoria_padrao).toLocaleUpperCase('pt-BR').slice(0, 40) : atual.categoria_padrao,
    max_reimpressoes: b.max_reimpressoes !== undefined ? Math.min(10, Math.max(0, Math.round(Number(b.max_reimpressoes) || 0))) : atual.max_reimpressoes,
    totem_titulo: b.totem_titulo !== undefined ? limpo(b.totem_titulo).slice(0, 120) : atual.totem_titulo,
  };
  db.prepare(`INSERT INTO evento_etiqueta (evento_id, imprime, automatica, modelo, qr_conteudo, categoria_padrao, max_reimpressoes, totem_titulo, atualizado_em, atualizado_por)
              VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'),?)
              ON CONFLICT(evento_id) DO UPDATE SET imprime=excluded.imprime, automatica=excluded.automatica, modelo=excluded.modelo,
                qr_conteudo=excluded.qr_conteudo, categoria_padrao=excluded.categoria_padrao, max_reimpressoes=excluded.max_reimpressoes,
                totem_titulo=excluded.totem_titulo, atualizado_em=excluded.atualizado_em, atualizado_por=excluded.atualizado_por`)
    .run(eventoId, v.imprime, v.automatica, modelo ? JSON.stringify(modelo) : '', v.qr_conteudo, v.categoria_padrao, v.max_reimpressoes, v.totem_titulo, autor || '');
  return configEtiqueta(eventoId);
}

const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const TIPOS = ['campo', 'texto', 'qrcode', 'codigobarras', 'caixa'];
const CAMPOS = ['nome', 'primeiro_nome', 'empresa', 'cargo', 'categoria', 'codigo', 'mesa', 'evento'];

/** Sanitiza o modelo vindo do navegador (tamanhos plausíveis, só tipos/campos conhecidos) */
function validarModelo(m) {
  if (!m || typeof m !== 'object') return null;
  const largura = num(m.largura, 15, 104, 100), altura = num(m.altura, 10, 300, 50);
  const elementos = (Array.isArray(m.elementos) ? m.elementos : []).slice(0, 40)
    .filter(e => e && TIPOS.includes(e.tipo))
    .map((e, i) => {
      const r = { id: String(e.id || 'el' + (i + 1)).slice(0, 30), tipo: e.tipo, x: num(e.x, -50, 400, 0), y: num(e.y, -50, 400, 0) };
      if (e.tipo === 'qrcode') r.tamanho = num(e.tamanho, 4, 200, 20);
      else { r.w = num(e.w, 1, 400, 30); r.h = num(e.h, 0.5, 400, 8); }
      if (e.tipo === 'campo' || e.tipo === 'codigobarras') r.campo = CAMPOS.includes(e.campo) ? e.campo : (e.tipo === 'campo' ? 'nome' : 'codigo');
      if (e.tipo === 'texto') r.texto = String(e.texto || '').slice(0, 200);
      if (e.tipo === 'campo' || e.tipo === 'texto') {
        Object.assign(r, {
          fonte: num(e.fonte, 4, 200, 12), negrito: !!e.negrito, maiusculas: !!e.maiusculas, ajustar: e.ajustar !== false,
          linhas: Math.round(num(e.linhas, 1, 6, 1)), inverter: !!e.inverter,
          alinhar: ['left', 'center', 'right'].includes(e.alinhar) ? e.alinhar : 'left',
          valign: ['top', 'middle', 'bottom'].includes(e.valign) ? e.valign : 'middle',
        });
        if (e.raio !== undefined) r.raio = num(e.raio, 0, 20, 1);
      }
      if (e.tipo === 'codigobarras') r.mostrarTexto = !!e.mostrarTexto;
      if (e.tipo === 'caixa') Object.assign(r, { borda: num(e.borda, 0.1, 5, 0.4), raio: num(e.raio, 0, 20, 0), preencher: !!e.preencher });
      if (e.oculto) r.oculto = true;
      if (Array.isArray(e.soCategorias)) r.soCategorias = e.soCategorias.map(c => limpo(c).slice(0, 40)).filter(Boolean).slice(0, 20);
      return r;
    });
  return {
    largura, altura,
    rotacao: [0, 90, 180, 270].includes(Number(m.rotacao)) ? Number(m.rotacao) : 0,
    ajusteX: num(m.ajusteX, -20, 20, 0), ajusteY: num(m.ajusteY, -20, 20, 0),
    escurecimento: Math.round(num(m.escurecimento, -30, 30, 0)),
    fonte: String(m.fonte || 'Arial, Helvetica, sans-serif').slice(0, 120).replace(/[;{}<>]/g, ''),
    dpmm: 8,
    elementos,
  };
}

const SQL_CONVIDADO = `
  SELECT c.id, c.evento_id, c.empresa_id, c.nome, c.cargo, c.codigo, c.token, c.tipo, c.status, c.categoria, c.cadeira,
         c.etiquetas_impressas, c.checkin_em, c.status_antes_checkin, c.confirmado_em,
         u.empresa_nome, m.numero AS mesa_numero, m.nome AS mesa_nome, e.nome AS evento_nome, e.mapa_mesas
  FROM convidados c
  LEFT JOIN usuarios u ON u.id = c.empresa_id
  LEFT JOIN mesas m ON m.id = c.mesa_id
  JOIN eventos e ON e.id = c.evento_id`;

function textoMesa(c) {
  if (!c.mapa_mesas || c.mesa_numero == null) return '';
  return `Mesa ${c.mesa_numero}` + (c.cadeira ? ` · Lugar ${c.cadeira}` : '');
}

/** Dados de UM convidado para a etiqueta (o que vai impresso) */
function dadosEtiqueta(c, cfg) {
  const qr = cfg.qr_conteudo === 'codigo' ? (c.codigo || '') : `${baseUrl()}/convite/${c.token}`;
  return {
    id: c.id,
    nome: limpo(c.nome),
    empresa: c.empresa_nome ? limpo(c.empresa_nome) : '',
    cargo: limpo(c.cargo),
    categoria: limpo(c.categoria) || cfg.categoria_padrao || '',
    codigo: c.codigo || '',
    mesa: textoMesa(c),
    evento: limpo(c.evento_nome),
    qr_matriz: qr ? matrizQr(qr) : null,
  };
}

module.exports = { matrizQr, configEtiqueta, salvarConfigEtiqueta, validarModelo, dadosEtiqueta, SQL_CONVIDADO, CAMPOS };
