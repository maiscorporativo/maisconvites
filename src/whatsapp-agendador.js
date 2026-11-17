'use strict';
// Disparo SEGMENTADO de mensagens pelo WhatsApp (Evolution API = WhatsApp comum pareado por QR).
// Mandar muitas mensagens iguais em sequência faz o WhatsApp bloquear o número; por isso o envio
// imita o ritmo de uma pessoa:
//   • intervalo ALEATÓRIO entre mensagens + "digitando…" antes de cada uma
//   • LOTES: depois de N mensagens, pausa longa (também aleatória)
//   • LIMITE DIÁRIO por número (conta tudo o que o evento enviou por WhatsApp no dia)
//   • HORÁRIO PERMITIDO: fora da janela, aguarda e retoma sozinho no dia seguinte
//   • pausa automática se o WhatsApp desconectar ou houver falhas seguidas
// A fila fica no banco (whatsapp_fila): o disparo continua de onde parou após um reinício.

const { db } = require('./db');
const evolution = require('./evolution');
const { carregarConfigEnvio } = require('./envio');
const { textoWhatsappMensagem } = require('./mensagens');

// Convidado com os mesmos campos usados na montagem da mensagem (empresa, mesa…)
const SQL_CONVIDADO_ATUAL = `
  SELECT c.*, u.empresa_nome, m.numero AS mesa_numero FROM convidados c
  LEFT JOIN usuarios u ON u.id = c.empresa_id
  LEFT JOIN mesas m ON m.id = c.mesa_id
  WHERE c.id=?`;

// O disparo pode levar dias: o texto é remontado NA HORA DO ENVIO com os dados atuais
// ("faltam N dias", status de confirmação, mesa, data/local do evento). Usa a cópia do
// modelo guardada no disparo — editar a mensagem depois não altera um envio já iniciado.
// Se não der para remontar (convidado apagado etc.), usa o texto gravado na criação.
function textoAtual(d, item, cfg) {
  try {
    if (!cfg.modelo || !item.convidado_id) return item.texto;
    const evento = db.prepare(`SELECT * FROM eventos WHERE id=?`).get(d.evento_id);
    const convidado = db.prepare(SQL_CONVIDADO_ATUAL).get(item.convidado_id);
    if (!evento || !convidado) return item.texto;
    return textoWhatsappMensagem(cfg.modelo, evento, convidado) || item.texto;
  } catch {
    return item.texto;
  }
}

const PRESETS = {
  cauteloso: { intervalo_min: 30, intervalo_max: 60, lote: 15, pausa_lote_min: 15, pausa_lote_max: 25, limite_diario: 100, hora_inicio: '08:00', hora_fim: '20:00' },
  moderado:  { intervalo_min: 20, intervalo_max: 40, lote: 25, pausa_lote_min: 10, pausa_lote_max: 15, limite_diario: 200, hora_inicio: '08:00', hora_fim: '20:00' },
};
const MAX_FALHAS_SEGUIDAS = 3;
const TICK_MS = 4000;
// Só para testes automatizados: encolhe intervalos e pausas (ex.: 0.01). Em produção fica 1.
const ESCALA = Math.min(1, Math.max(0.001, Number(process.env.WHATSAPP_ESCALA_TEMPO || 1)));

const limitar = (v, min, max, padrao) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
};
const horaValida = (h, padrao) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || '')) ? h : padrao);
const minutosDoDia = h => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
const aleatorio = (min, max) => min + Math.random() * (max - min);

// Valida/normaliza a segmentação vinda do painel, com pisos de segurança
function normalizarConfig(entrada = {}) {
  const base = PRESETS[entrada.preset] || PRESETS.cauteloso;
  const c = entrada.preset === 'personalizado' ? { ...PRESETS.cauteloso, ...entrada } : { ...base };
  const cfg = {
    preset: PRESETS[entrada.preset] ? entrada.preset : (entrada.preset === 'personalizado' ? 'personalizado' : 'cauteloso'),
    intervalo_min: limitar(c.intervalo_min, 10, 600, 30),
    intervalo_max: limitar(c.intervalo_max, 10, 900, 60),
    lote: limitar(c.lote, 1, 100, 15),
    pausa_lote_min: limitar(c.pausa_lote_min, 1, 240, 15),
    pausa_lote_max: limitar(c.pausa_lote_max, 1, 480, 25),
    limite_diario: limitar(c.limite_diario, 1, 500, 100),
    hora_inicio: horaValida(c.hora_inicio, '08:00'),
    hora_fim: horaValida(c.hora_fim, '20:00'),
  };
  if (cfg.intervalo_max < cfg.intervalo_min) cfg.intervalo_max = cfg.intervalo_min;
  if (cfg.pausa_lote_max < cfg.pausa_lote_min) cfg.pausa_lote_max = cfg.pausa_lote_min;
  if (minutosDoDia(cfg.hora_fim) <= minutosDoDia(cfg.hora_inicio)) return { erro: 'O horário final precisa ser depois do horário inicial.' };
  return cfg;
}

// ── Horário SEMPRE no fuso do evento (padrão: Brasília), nunca no relógio do servidor ──
// A hospedagem roda em UTC (3 h à frente de Brasília): usar getHours() fazia a janela
// 08:00–20:00 valer como 05:00–17:00 no Brasil. Tudo aqui passa pelo Intl com timeZone fixo.
const FUSO = process.env.FUSO_HORARIO || 'America/Sao_Paulo';
const partesFormatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function noFuso(d) {
  const p = Object.fromEntries(partesFormatador.formatToParts(d).map(x => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), m: Number(p.minute), s: Number(p.second) };
}

function dentroDoHorario(agora, cfg) {
  const { h, m } = noFuso(agora);
  const min = h * 60 + m;
  return min >= minutosDoDia(cfg.hora_inicio) && min < minutosDoDia(cfg.hora_fim);
}

// Próximo instante em que a janela abre (hoje, se ainda não abriu; senão amanhã), no fuso do evento
function proximaAbertura(agora, cfg, pularHoje = false) {
  const { h, m, s } = noFuso(agora);
  const agoraMin = h * 60 + m;
  let falta = minutosDoDia(cfg.hora_inicio) - agoraMin; // minutos até a abertura de hoje
  if (pularHoje || falta <= 0) falta += 24 * 60;
  return new Date(agora.getTime() + falta * 60000 - s * 1000 - agora.getMilliseconds());
}

const horaBr = d => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: FUSO });
const quandoBr = d => {
  const dia = noFuso(d).dia;
  if (dia === noFuso(new Date()).dia) return `hoje às ${horaBr(d)}`;
  if (dia === noFuso(new Date(Date.now() + 86400000)).dia) return `amanhã às ${horaBr(d)}`;
  return `${d.toLocaleDateString('pt-BR', { timeZone: FUSO })} às ${horaBr(d)}`;
};

// Início do dia de hoje (meia-noite no fuso do evento) em UTC, no formato do SQLite
function inicioDoDiaUtc() {
  const agora = new Date();
  const { h, m, s } = noFuso(agora);
  const meiaNoite = new Date(agora.getTime() - ((h * 60 + m) * 60 + s) * 1000 - agora.getMilliseconds());
  return meiaNoite.toISOString().slice(0, 19).replace('T', ' ');
}

// envios.criado_em é gravado em UTC (datetime('now')): compara com a meia-noite do fuso em UTC
function enviadosHojeNoEvento(eventoId) {
  return db.prepare(`
    SELECT COUNT(*) n FROM envios en JOIN convidados c ON c.id = en.convidado_id
    WHERE c.evento_id=? AND en.canal='whatsapp' AND en.status='enviado'
      AND en.criado_em >= ?`).get(eventoId, inicioDoDiaUtc()).n;
}

function atualizarDisparo(id, campos) {
  const chaves = Object.keys(campos);
  db.prepare(`UPDATE mensagem_disparos SET ${chaves.map(k => `${k}=?`).join(', ')} WHERE id=?`)
    .run(...chaves.map(k => campos[k]), id);
}

function contarFila(disparoId) {
  const r = db.prepare(`SELECT status, COUNT(*) n FROM whatsapp_fila WHERE disparo_id=? GROUP BY status`).all(disparoId);
  const c = { pendente: 0, enviando: 0, enviado: 0, erro: 0, cancelado: 0 };
  for (const x of r) c[x.status] = x.n;
  return c;
}

// Disparo de WhatsApp ainda não finalizado do evento (só um por vez, para não somar ritmos)
function disparoWhatsappAtivo(eventoId) {
  return db.prepare(`SELECT * FROM mensagem_disparos WHERE evento_id=? AND canal='whatsapp'
                     AND situacao IN ('andamento','pausado') ORDER BY id DESC LIMIT 1`).get(eventoId);
}

/**
 * Cria o disparo e enfileira as mensagens. O texto gravado aqui é uma prévia/reserva:
 * na hora do envio ele é remontado com os dados do dia (ver textoAtual).
 * @param itens [{convidado, numero, texto}] — já deduplicados por número
 */
function criarDisparo({ evento, modelo, itens, config, criadoPor, semTelefone }) {
  db.exec('BEGIN');
  try {
    const r = db.prepare(`
      INSERT INTO mensagem_disparos (evento_id, mensagem_id, mensagem_nome, assunto, total, sem_email, criado_por,
                                     canal, config, proximo_envio_ts, situacao)
      VALUES (?,?,?,?,?,?,?, 'whatsapp', ?, ?, 'andamento')`).run(
      evento.id, modelo.id, modelo.nome, modelo.assunto, itens.length, semTelefone, criadoPor,
      JSON.stringify({ ...config, modelo: { assunto: modelo.assunto, corpo: modelo.corpo, incluir_botoes: modelo.incluir_botoes } }),
      Date.now());
    const disparoId = Number(r.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO whatsapp_fila (disparo_id, convidado_id, nome, numero, texto) VALUES (?,?,?,?,?)`);
    for (const it of itens) ins.run(disparoId, it.convidado.id, it.convidado.nome, it.numero, it.texto);
    db.exec('COMMIT');
    return disparoId;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function pausar(disparo, motivo = 'Pausado pelo organizador.') {
  atualizarDisparo(disparo.id, { situacao: 'pausado', motivo });
}

function retomar(disparo) {
  falhasSeguidas.delete(disparo.id);
  atualizarDisparo(disparo.id, { situacao: 'andamento', motivo: '', proximo_envio_ts: Date.now() });
}

function cancelar(disparo) {
  db.prepare(`UPDATE whatsapp_fila SET status='cancelado' WHERE disparo_id=? AND status='pendente'`).run(disparo.id);
  const c = contarFila(disparo.id);
  atualizarDisparo(disparo.id, {
    situacao: 'cancelado', motivo: 'Cancelado pelo organizador.', enviados: c.enviado, falhas: c.erro,
    concluido_em: new Date().toLocaleString('sv-SE').replace('T', ' '),
  });
}

// Visão do disparo para o painel (progresso, lote atual, próxima mensagem)
function resumo(d) {
  const cfg = JSON.parse(d.config || '{}');
  const c = contarFila(d.id);
  const processados = c.enviado + c.erro + c.cancelado;
  const lote = cfg.lote || 1;
  return {
    id: d.id, mensagem_nome: d.mensagem_nome, situacao: d.situacao, motivo: d.motivo,
    total: d.total, enviados: c.enviado, falhas: c.erro, pendentes: c.pendente, cancelados: c.cancelado,
    processados, sem_telefone: d.sem_email,
    lote_atual: Math.min(Math.floor(c.enviado / lote) + 1, Math.ceil(d.total / lote)),
    total_lotes: Math.ceil(d.total / lote),
    proximo_envio_ts: d.situacao === 'andamento' ? d.proximo_envio_ts : null,
    enviados_hoje: enviadosHojeNoEvento(d.evento_id),
    config: cfg, iniciado_em: d.iniciado_em, criado_por: d.criado_por,
  };
}

// ═══════════════ Agendador ═══════════════

const emProcessamento = new Set();
const falhasSeguidas = new Map();

const erroDoNumero = msg => /exist|not.*(whatsapp|registered)|invalid.*number|n[uú]mero/i.test(msg);

async function processarDisparo(d) {
  const cfg = JSON.parse(d.config || '{}');
  const agora = new Date();

  // 1) Horário permitido
  if (!dentroDoHorario(agora, cfg)) {
    const abre = proximaAbertura(agora, cfg);
    atualizarDisparo(d.id, { proximo_envio_ts: abre.getTime(), motivo: `Fora do horário permitido (${cfg.hora_inicio}–${cfg.hora_fim}). Retoma ${quandoBr(abre)}.` });
    return;
  }
  // 2) Limite diário do número
  const hoje = enviadosHojeNoEvento(d.evento_id);
  if (hoje >= cfg.limite_diario) {
    const abre = proximaAbertura(agora, cfg, true);
    atualizarDisparo(d.id, { proximo_envio_ts: abre.getTime(), motivo: `Limite de ${cfg.limite_diario} mensagens por dia atingido. Retoma ${quandoBr(abre)}.` });
    return;
  }
  // 3) Próxima mensagem da fila
  const item = db.prepare(`SELECT * FROM whatsapp_fila WHERE disparo_id=? AND status='pendente' ORDER BY id LIMIT 1`).get(d.id);
  // Reserva atômica do item: se outro processo já o pegou, não envia de novo
  if (item && db.prepare(`UPDATE whatsapp_fila SET status='enviando' WHERE id=? AND status='pendente'`).run(item.id).changes === 0) return;
  if (!item) {
    const c = contarFila(d.id);
    atualizarDisparo(d.id, { situacao: 'concluido', motivo: '', enviados: c.enviado, falhas: c.erro, proximo_envio_ts: null,
      concluido_em: new Date().toLocaleString('sv-SE').replace('T', ' ') });
    return;
  }
  // 4) WhatsApp conectado? (instância do evento, depois a global)
  let instancia = null;
  for (const nome of carregarConfigEnvio(d.evento_id).instancias) {
    if (await evolution.estadoInstancia(nome) === 'open') { instancia = nome; break; }
  }
  if (!instancia) {
    db.prepare(`UPDATE whatsapp_fila SET status='pendente' WHERE id=? AND status='enviando'`).run(item.id);
    pausar(d, 'O WhatsApp está desconectado. Conecte o número na aba Envio e clique em “Retomar”.');
    return;
  }

  // 5) Envia (com "digitando…" de 2 a 5 s)
  let ok = false;
  const texto = textoAtual(d, item, cfg);
  if (texto !== item.texto) db.prepare(`UPDATE whatsapp_fila SET texto=? WHERE id=?`).run(texto, item.id);
  try {
    await evolution.enviarTexto(instancia, item.numero, texto, { delay: Math.round(aleatorio(2000, 5000) * ESCALA) });
    ok = true;
  } catch (e) {
    db.prepare(`UPDATE whatsapp_fila SET status='erro', erro=?, enviado_em=datetime('now','localtime') WHERE id=?`).run(e.message, item.id);
    if (item.convidado_id) {
      db.prepare(`INSERT INTO envios (convidado_id, canal, destino, status, disparo_id) VALUES (?, 'whatsapp', ?, ?, ?)`)
        .run(item.convidado_id, item.numero, 'erro: ' + e.message, d.id);
    }
    // número inexistente no WhatsApp é problema do cadastro, não do envio: não conta para a pausa automática
    if (!erroDoNumero(e.message)) {
      const n = (falhasSeguidas.get(d.id) || 0) + 1;
      falhasSeguidas.set(d.id, n);
      if (n >= MAX_FALHAS_SEGUIDAS) {
        pausar(d, `Pausado após ${n} falhas seguidas (último erro: ${e.message}). Verifique o WhatsApp e clique em “Retomar”.`);
        return;
      }
    }
  }
  if (ok) {
    falhasSeguidas.delete(d.id);
    db.prepare(`UPDATE whatsapp_fila SET status='enviado', enviado_em=datetime('now','localtime') WHERE id=?`).run(item.id);
    if (item.convidado_id) {
      db.prepare(`INSERT INTO envios (convidado_id, canal, destino, status, disparo_id) VALUES (?, 'whatsapp', ?, 'enviado', ?)`)
        .run(item.convidado_id, item.numero, d.id);
    }
  }

  // 6) Agenda a próxima: pausa de lote a cada N enviadas; senão intervalo aleatório
  const c = contarFila(d.id);
  const campos = { enviados: c.enviado, falhas: c.erro, motivo: '' };
  if (!c.pendente) {
    Object.assign(campos, { situacao: 'concluido', proximo_envio_ts: null, concluido_em: new Date().toLocaleString('sv-SE').replace('T', ' ') });
  } else if (ok && c.enviado % cfg.lote === 0) {
    const prox = new Date(Date.now() + aleatorio(cfg.pausa_lote_min, cfg.pausa_lote_max) * 60000 * ESCALA);
    campos.proximo_envio_ts = prox.getTime();
    campos.motivo = `Lote ${c.enviado / cfg.lote} concluído. Pausa de proteção até ${horaBr(prox)}.`;
  } else {
    campos.proximo_envio_ts = Date.now() + Math.round(aleatorio(cfg.intervalo_min, cfg.intervalo_max) * 1000 * ESCALA);
  }
  atualizarDisparo(d.id, campos);
}

async function tick() {
  const prontos = db.prepare(`SELECT * FROM mensagem_disparos WHERE canal='whatsapp' AND situacao='andamento'
                              AND (proximo_envio_ts IS NULL OR proximo_envio_ts <= ?)`).all(Date.now());
  const agora = Date.now();
  for (const d of prontos) {
    if (emProcessamento.has(d.id)) continue;
    // Trava atômica no banco: com mais de um processo do sistema rodando (deploy/cluster),
    // só quem conseguir empurrar o proximo_envio_ts processa este disparo agora.
    // processarDisparo sempre regrava o proximo_envio_ts (ou pausa/conclui) ao terminar.
    const trava = db.prepare(`UPDATE mensagem_disparos SET proximo_envio_ts=? WHERE id=? AND situacao='andamento'
                              AND (proximo_envio_ts IS NULL OR proximo_envio_ts <= ?)`).run(agora + 5 * 60000, d.id, agora);
    if (trava.changes === 0) continue;
    emProcessamento.add(d.id);
    processarDisparo(d)
      .catch(e => { try { pausar(d, 'Erro inesperado: ' + e.message); } catch {} })
      .finally(() => emProcessamento.delete(d.id));
  }
}

let timer = null;
function iniciarAgendador() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, ESCALA < 1 ? 300 : TICK_MS);
  timer.unref?.();
}

module.exports = {
  PRESETS, normalizarConfig, criarDisparo, disparoWhatsappAtivo, pausar, retomar, cancelar, resumo,
  iniciarAgendador,
  _teste: { dentroDoHorario, proximaAbertura, inicioDoDiaUtc }, // usado só em testes
};
