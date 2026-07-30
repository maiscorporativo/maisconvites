'use strict';
// Utilitários compartilhados

async function api(url, opcoes = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opcoes,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  let dados = {};
  try { dados = await resp.json(); } catch {}
  if (resp.status === 401 && !location.pathname.includes('convite')) {
    location.href = '/';
    throw new Error('Sessão expirada');
  }
  if (!resp.ok) throw new Error(dados.erro || `Erro ${resp.status}`);
  return dados;
}

function toast(msg, tipo = 'info') {
  let area = document.getElementById('toasts');
  if (!area) {
    area = document.createElement('div');
    area.id = 'toasts';
    document.body.appendChild(area);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + (tipo === 'erro' ? 'erro' : tipo === 'ok' ? 'ok' : '');
  el.textContent = msg;
  area.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dataBr(iso) {
  if (!iso) return '—';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

// Formata "YYYY-MM-DD HH:MM:SS" (datetime('now','localtime') do SQLite) em "DD/MM/AAAA HH:MM"
function dataHoraBr(iso) {
  if (!iso) return '—';
  const [data, hora] = String(iso).split(' ');
  return `${dataBr(data)}${hora ? ' ' + hora.slice(0, 5) : ''}`;
}

function seloStatus(status) {
  const nomes = { pendente: 'Pendente', enviado: 'Convite enviado', confirmado: 'Confirmado', checkin: 'Check-in ✓', cancelado: 'Cancelado' };
  return `<span class="selo selo-${esc(status)}">${nomes[status] || esc(status)}</span>`;
}

function seloTipo(tipo) {
  const nomes = { responsavel: 'Responsável', convidado: 'Convidado', individual: 'Individual' };
  return `<span class="selo selo-${esc(tipo)}">${nomes[tipo] || esc(tipo)}</span>`;
}

function assentoTexto(c) {
  if (c.mesa_numero != null && c.cadeira != null) return `Mesa ${c.mesa_numero} · Cad. ${c.cadeira}`;
  if (c.mesa_numero != null) return `Mesa ${c.mesa_numero}`;
  return '—';
}

// Modal genérico: abrirModal(html) devolve o elemento; fecha ao clicar fora ou em [data-fechar]
function abrirModal(html) {
  const fundo = document.createElement('div');
  fundo.className = 'modal-fundo';
  fundo.innerHTML = `<div class="modal">${html}</div>`;
  fundo.addEventListener('click', e => { if (e.target === fundo) fundo.remove(); });
  fundo.querySelectorAll('[data-fechar]').forEach(b => b.addEventListener('click', () => fundo.remove()));
  document.body.appendChild(fundo);
  return fundo;
}

// Resultado de envio de convite (email simulado / link whatsapp)
function tratarResultadoEnvio(r) {
  if (r.modo === 'enviado') { toast(r.mensagem, 'ok'); return; }
  if (r.modo === 'link') {
    window.open(r.link, '_blank');
    toast('WhatsApp aberto em nova aba — revise e envie a mensagem.', 'ok');
    return;
  }
  if (r.modo === 'simulado') {
    abrirModal(`
      <h3>✉️ E-mail pronto para envio manual</h3>
      <p class="aviso-caixa aviso-info">O servidor de e-mail (SMTP) ainda não foi configurado no arquivo <strong>.env</strong>.
      Copie a mensagem abaixo e envie manualmente, ou configure o SMTP para envio automático.</p>
      <label>Destinatário</label><input readonly value="${esc(r.destinatario)}">
      <label>Assunto</label><input readonly value="${esc(r.assunto)}">
      <label>Mensagem</label><textarea readonly rows="12">${esc(r.texto)}</textarea>
      <div class="acoes">
        <button class="botao-claro" data-fechar>Fechar</button>
        <button class="botao-ouro" id="btn-copiar-msg">Copiar mensagem</button>
      </div>
    `).querySelector('#btn-copiar-msg').addEventListener('click', e => {
      navigator.clipboard.writeText(r.texto).then(() => toast('Mensagem copiada!', 'ok'));
    });
    return;
  }
  toast(r.mensagem || 'Operação concluída.', 'ok');
}

// Resultado do envio automático (disparo composto: e-mail + WhatsApp)
function tratarEnvioAutomatico(envio) {
  if (!envio) return;
  if (envio.email) {
    if (envio.email.ok && envio.email.modo === 'enviado') toast(envio.email.mensagem, 'ok');
    else if (envio.email.ok) tratarResultadoEnvio(envio.email); // modo simulado → modal
    else toast('E-mail: ' + envio.email.erro, 'erro');
  }
  if (envio.whatsapp) {
    if (envio.whatsapp.ok && envio.whatsapp.modo === 'enviado') toast(envio.whatsapp.mensagem, 'ok');
    else if (envio.whatsapp.ok && envio.whatsapp.modo === 'link') {
      // botão clicável evita bloqueio de popup e deixa o envio a 1 clique
      abrirModal(`
        <h3>💬 Enviar convite pelo WhatsApp</h3>
        <p>O WhatsApp deste evento não está conectado — clique no botão para abrir o WhatsApp
        com a mensagem pronta, revise e envie.</p>
        <div class="acoes">
          <button class="botao-claro" data-fechar>Depois</button>
          <a class="botao botao-ouro" href="${envio.whatsapp.link}" target="_blank">Abrir WhatsApp</a>
        </div>`);
    }
    else if (!envio.whatsapp.ok) toast('WhatsApp: ' + envio.whatsapp.erro, 'erro');
  }
  if (!envio.email && !envio.whatsapp) {
    toast('Convidado sem e-mail e sem telefone — cadastre um contato para enviar o convite.', 'erro');
  }
}

async function sair() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
}
