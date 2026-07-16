'use strict';
// Cliente da Evolution API (servidor global definido no .env).
// Cada evento pode ter sua própria instância ('evento_<id>') conectada
// ao WhatsApp pessoal do admin do evento via QR code.

const TIMEOUT = 10000;

function base() {
  return String(process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
}

function headers() {
  return { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY };
}

function evolutionGlobalConfigurada() {
  return !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY);
}

function nomeInstancia(eventoId) {
  return `evento_${Number(eventoId)}`;
}

async function chamar(metodo, caminho, corpo) {
  const resp = await fetch(`${base()}${caminho}`, {
    method: metodo,
    headers: headers(),
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const dados = await resp.json().catch(() => ({}));
  return { resp, dados };
}

async function criarInstancia(nome) {
  const { resp, dados } = await chamar('POST', '/instance/create', {
    instanceName: nome, qrcode: true, integration: 'WHATSAPP-BAILEYS',
  });
  // 403/409 com "already in use" = instância já existe; não é erro para nós
  if (!resp.ok && !JSON.stringify(dados).toLowerCase().includes('already')) {
    throw new Error(extrairErro(dados));
  }
  return dados;
}

// QR code para parear o WhatsApp; retorna data URL base64 (ou null se já conectado)
async function qrInstancia(nome) {
  const { resp, dados } = await chamar('GET', `/instance/connect/${encodeURIComponent(nome)}`);
  if (!resp.ok) throw new Error(extrairErro(dados));
  const b64 = dados?.base64 || dados?.qrcode?.base64 || null;
  return b64 ? (b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`) : null;
}

// 'open' = conectado | 'connecting' | 'close' | 'nao_criada' | 'indisponivel'
async function estadoInstancia(nome) {
  if (!evolutionGlobalConfigurada()) return 'indisponivel';
  try {
    const { resp, dados } = await chamar('GET', `/instance/connectionState/${encodeURIComponent(nome)}`);
    if (resp.status === 404) return 'nao_criada';
    if (!resp.ok) return 'indisponivel';
    return dados?.instance?.state || dados?.state || 'close';
  } catch {
    return 'indisponivel';
  }
}

// Desconecta o WhatsApp e apaga a instância (best-effort)
async function removerInstancia(nome) {
  try { await chamar('DELETE', `/instance/logout/${encodeURIComponent(nome)}`); } catch {}
  try { await chamar('DELETE', `/instance/delete/${encodeURIComponent(nome)}`); } catch {}
}

// Envia texto; body v2 {number, text}, com fallback ao formato v1
async function enviarTexto(nome, numero, texto) {
  const caminho = `/message/sendText/${encodeURIComponent(nome)}`;
  let { resp, dados } = await chamar('POST', caminho, { number: numero, text: texto });
  if (resp.status === 400) {
    ({ resp, dados } = await chamar('POST', caminho, { number: numero, textMessage: { text: texto } }));
  }
  if (!resp.ok) throw new Error(extrairErro(dados));
  return dados;
}

function extrairErro(dados) {
  const d = dados?.response?.message || dados?.message || dados?.error || dados;
  return typeof d === 'string' ? d : JSON.stringify(d);
}

module.exports = {
  evolutionGlobalConfigurada, nomeInstancia,
  criarInstancia, qrInstancia, estadoInstancia, removerInstancia, enviarTexto,
};
