'use strict';
// Página de relatórios para impressão / PDF

const params = new URLSearchParams(location.search);
const eventoId = Number(params.get('evento'));
const tipo = params.get('tipo') || 'geral';
const filtroStatus = params.get('status') || '';
const filtroEmpresa = params.get('empresa') || ''; // id da empresa ou 'individual'

const TITULOS = {
  geral: 'Lista geral de convidados',
  credenciamento: 'Lista de credenciamento (recepção)',
  empresas: 'Relatório por empresa',
  mapa: 'Mapa de mesas',
  presenca: 'Relatório de presença',
  etiquetas: 'Etiquetas / credenciais',
};

const NOMES_STATUS = { pendente: 'Pendente', enviado: 'Convite enviado', confirmado: 'Confirmado', checkin: 'Presente (check-in)', cancelado: 'Cancelado' };

function selo(status) {
  return `<span class="selo s-${esc(status)}">${NOMES_STATUS[status] || esc(status)}</span>`;
}

function assento(c) {
  if (c.mesa_numero != null && c.cadeira != null) return `Mesa ${c.mesa_numero} · Cad. ${c.cadeira}`;
  if (c.mesa_numero != null) return `Mesa ${c.mesa_numero}`;
  return '—';
}

function contato(c) {
  return [c.email, c.telefone].filter(Boolean).map(esc).join('<br>') || '—';
}

let mapaAtivo = true; // definido no init conforme a configuração do evento

(async function init() {
  let eventos, convidados, empresas, mapaDados = { mesas: [], ocupantes: [] };
  try {
    [eventos, convidados, empresas] = await Promise.all([
      api('/api/admin/eventos'),
      api(`/api/admin/eventos/${eventoId}/convidados`),
      api(`/api/admin/eventos/${eventoId}/empresas`),
    ]);
  } catch (e) {
    document.getElementById('titulo').textContent = 'Erro ao carregar';
    document.getElementById('conteudo').innerHTML = `<p>${esc(e.message)} — faça login no painel e gere o relatório novamente.</p>`;
    return;
  }
  const evento = eventos.find(e => e.id === eventoId);
  if (!evento) {
    document.getElementById('titulo').textContent = 'Evento não encontrado';
    return;
  }
  mapaAtivo = evento.mapa_mesas !== 0;
  if (mapaAtivo) {
    try { mapaDados = await api(`/api/admin/eventos/${eventoId}/mesas`); } catch {}
  } else if (tipo === 'mapa') {
    document.getElementById('titulo').textContent = 'Mapa de mesas desativado';
    document.getElementById('conteudo').innerHTML = '<p>O mapa de mesas está desativado neste evento.</p>';
    return;
  }

  const titulo = TITULOS[tipo] || TITULOS.geral;
  document.title = `${titulo} — ${evento.nome}`;
  document.getElementById('barra-titulo').textContent = titulo;
  document.getElementById('titulo').textContent = titulo;

  if (evento.timbrado) {
    document.getElementById('timbrado').innerHTML = `<img src="/banners/${esc(evento.timbrado)}" alt="">`;
  }

  const agora = new Date();
  const emissao = agora.toLocaleDateString('pt-BR') + ' às ' + agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const filtros = [];
  if (filtroStatus) filtros.push(`status: ${NOMES_STATUS[filtroStatus] || filtroStatus}`);
  if (filtroEmpresa === 'individual') filtros.push('somente convites individuais');
  else if (filtroEmpresa) {
    const emp = empresas.find(e => e.id === Number(filtroEmpresa));
    if (emp) filtros.push(`empresa: ${emp.empresa_nome}`);
  }
  document.getElementById('meta').innerHTML =
    `<strong>${esc(evento.nome)}</strong> · ${dataBr(evento.data_evento)} às ${esc(evento.hora_evento)} · ` +
    `${esc(evento.local_nome)} — ${esc(evento.endereco)}` +
    (filtros.length ? `<br>Filtros: ${esc(filtros.join(' · '))}` : '');
  document.getElementById('rodape-evento').textContent = evento.nome;
  document.getElementById('rodape-emissao').textContent = 'Emitido em ' + emissao;

  // Aplica filtros (cancelados só aparecem quando pedidos explicitamente)
  let lista = convidados.filter(c => filtroStatus ? c.status === filtroStatus : c.status !== 'cancelado');
  if (filtroEmpresa === 'individual') lista = lista.filter(c => !c.empresa_id);
  else if (filtroEmpresa) lista = lista.filter(c => c.empresa_id === Number(filtroEmpresa));

  const el = document.getElementById('conteudo');
  if (tipo === 'geral') el.innerHTML = relGeral(lista);
  else if (tipo === 'credenciamento') el.innerHTML = relCredenciamento(lista);
  else if (tipo === 'empresas') el.innerHTML = relEmpresas(empresas, convidados);
  else if (tipo === 'presenca') el.innerHTML = relPresenca(lista);
  else if (tipo === 'mapa') relMapa(el, mapaDados);
  else if (tipo === 'etiquetas') await relEtiquetas(el, lista);
})();

// ── Lista geral ──
function relGeral(lista) {
  const ordenada = [...lista].sort((a, b) =>
    (a.empresa_nome || 'zzz').localeCompare(b.empresa_nome || 'zzz') || a.nome.localeCompare(b.nome));
  return `
    <div class="resumo"><div class="card"><b>${lista.length}</b><span>Convidados</span></div></div>
    <table>
      <thead><tr><th>#</th><th>Nome</th><th>Empresa</th><th>Cargo</th><th>Contato</th>${mapaAtivo ? '<th>Mesa/Cadeira</th>' : ''}<th>Status</th></tr></thead>
      <tbody>${ordenada.map((c, i) => `
        <tr><td class="num">${i + 1}</td><td><strong>${esc(c.nome)}</strong></td>
        <td>${esc(c.empresa_nome || 'Individual')}</td><td>${esc(c.cargo || '—')}</td>
        <td>${contato(c)}</td>${mapaAtivo ? `<td>${assento(c)}</td>` : ''}<td>${selo(c.status)}</td></tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Credenciamento (recepção, com assinatura) ──
function relCredenciamento(lista) {
  const ordenada = [...lista].sort((a, b) => a.nome.localeCompare(b.nome));
  return `
    <div class="resumo"><div class="card"><b>${lista.length}</b><span>Convidados esperados</span></div></div>
    <table>
      <thead><tr><th>#</th><th>Nome</th><th>Empresa</th>${mapaAtivo ? '<th>Mesa/Cadeira</th>' : ''}<th class="assin">Assinatura / Check</th></tr></thead>
      <tbody>${ordenada.map((c, i) => `
        <tr><td class="num">${i + 1}</td><td><strong>${esc(c.nome)}</strong></td>
        <td>${esc(c.empresa_nome || 'Individual')}</td>${mapaAtivo ? `<td>${assento(c)}</td>` : ''}
        <td class="assin"><div></div></td></tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Por empresa ──
function relEmpresas(empresas, convidados) {
  const ativos = convidados.filter(c => c.status !== 'cancelado');
  let html = `
    <div class="resumo">
      <div class="card"><b>${empresas.length}</b><span>Empresas</span></div>
      <div class="card"><b>${empresas.reduce((s, e) => s + e.cota, 0)}</b><span>Cota total</span></div>
      <div class="card"><b>${empresas.reduce((s, e) => s + e.usados, 0)}</b><span>Convites usados</span></div>
    </div>`;
  for (const emp of [...empresas].sort((a, b) => a.empresa_nome.localeCompare(b.empresa_nome))) {
    const seus = ativos.filter(c => c.empresa_id === emp.id);
    html += `
      <div class="grupo">
        <h2>${esc(emp.empresa_nome)}</h2>
        <p class="sub">Responsável: ${esc(emp.nome || '—')}${emp.cargo ? ` (${esc(emp.cargo)})` : ''} ·
          Cota: ${emp.cota} · Usados: ${emp.usados} · Disponíveis: ${Math.max(0, emp.cota - emp.usados)}</p>
        ${seus.length ? `<table>
          <thead><tr><th>Nome</th><th>Contato</th>${mapaAtivo ? '<th>Mesa/Cadeira</th>' : ''}<th>Status</th></tr></thead>
          <tbody>${seus.map(c => `
            <tr><td><strong>${esc(c.nome)}</strong>${c.tipo === 'responsavel' ? ' <small>(responsável)</small>' : ''}</td>
            <td>${contato(c)}</td>${mapaAtivo ? `<td>${assento(c)}</td>` : ''}<td>${selo(c.status)}</td></tr>`).join('')}
          </tbody></table>` : '<p class="sub">Nenhum convidado inscrito.</p>'}
      </div>`;
  }
  const individuais = ativos.filter(c => !c.empresa_id);
  if (individuais.length) {
    html += `
      <div class="grupo">
        <h2>Convites individuais (organização)</h2>
        <table>
          <thead><tr><th>Nome</th><th>Contato</th>${mapaAtivo ? '<th>Mesa/Cadeira</th>' : ''}<th>Status</th></tr></thead>
          <tbody>${individuais.map(c => `
            <tr><td><strong>${esc(c.nome)}</strong></td><td>${contato(c)}</td>
            ${mapaAtivo ? `<td>${assento(c)}</td>` : ''}<td>${selo(c.status)}</td></tr>`).join('')}
          </tbody></table>
      </div>`;
  }
  return html;
}

// ── Presença (pós-evento) ──
function relPresenca(lista) {
  const confirmados = lista.filter(c => c.status === 'confirmado' || c.status === 'checkin');
  const presentes = lista.filter(c => c.status === 'checkin');
  const taxa = lista.length ? Math.round(presentes.length / lista.length * 100) : 0;
  const ordenada = [...lista].sort((a, b) =>
    (b.status === 'checkin') - (a.status === 'checkin') || a.nome.localeCompare(b.nome));
  return `
    <div class="resumo">
      <div class="card"><b>${lista.length}</b><span>Inscritos</span></div>
      <div class="card"><b>${confirmados.length}</b><span>Confirmaram</span></div>
      <div class="card"><b>${presentes.length}</b><span>Presentes</span></div>
      <div class="card"><b>${taxa}%</b><span>Comparecimento</span></div>
    </div>
    <table>
      <thead><tr><th>Nome</th><th>Empresa</th><th>Confirmou em</th><th>Check-in em</th><th>Situação</th></tr></thead>
      <tbody>${ordenada.map(c => `
        <tr><td><strong>${esc(c.nome)}</strong></td><td>${esc(c.empresa_nome || 'Individual')}</td>
        <td>${esc(c.confirmado_em || '—')}</td><td>${esc(c.checkin_em || '—')}</td><td>${selo(c.status)}</td></tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Mapa de mesas ──
function relMapa(el, mapaDados) {
  const { mesas, ocupantes } = mapaDados;
  el.innerHTML = `
    <div class="resumo">
      <div class="card"><b>${mesas.length}</b><span>Mesas</span></div>
      <div class="card"><b>${mesas.reduce((s, m) => s + m.capacidade, 0)}</b><span>Lugares</span></div>
      <div class="card"><b>${ocupantes.length}</b><span>Acomodados</span></div>
    </div>
    <div id="mapa-svg"></div>
    <div id="mesa-listas"></div>`;
  const mapa = criarMapa(document.getElementById('mapa-svg'), { editavel: false });
  mapa.atualizar(mesas, ocupantes);

  const listas = document.getElementById('mesa-listas');
  listas.innerHTML = [...mesas].sort((a, b) => a.numero - b.numero).map(m => {
    const ocs = ocupantes.filter(o => o.mesa_id === m.id).sort((a, b) => (a.cadeira || 0) - (b.cadeira || 0));
    return `
      <div class="grupo">
        <h2>Mesa ${m.numero}${m.nome ? ' — ' + esc(m.nome) : ''} <small style="color:var(--suave)">(${ocs.length}/${m.capacidade})</small></h2>
        ${ocs.length ? `<table>
          <thead><tr><th style="width:70px">Cadeira</th><th>Nome</th><th>Empresa</th></tr></thead>
          <tbody>${ocs.map(o => `
            <tr><td class="num">${o.cadeira ?? '—'}</td><td><strong>${esc(o.nome)}</strong></td>
            <td>${esc(o.empresa_nome || 'Individual')}</td></tr>`).join('')}
          </tbody></table>` : '<p class="sub">Mesa livre.</p>'}
      </div>`;
  }).join('');
}

// ── Etiquetas / credenciais ──
async function relEtiquetas(el, lista) {
  el.innerHTML = '<p>Gerando QR codes…</p>';
  let qrs = {};
  try { qrs = await api(`/api/admin/eventos/${eventoId}/qrcodes`); }
  catch (e) { el.innerHTML = `<p>${esc(e.message)}</p>`; return; }
  const ordenada = [...lista].sort((a, b) =>
    (a.empresa_nome || 'zzz').localeCompare(b.empresa_nome || 'zzz') || a.nome.localeCompare(b.nome));
  el.innerHTML = `
    <div class="etiquetas">${ordenada.map(c => `
      <div class="etiqueta">
        ${qrs[c.id] ? `<img src="${qrs[c.id]}" alt="QR">` : ''}
        <div class="ei">
          <b>${esc(c.nome)}</b>
          <small>${esc(c.empresa_nome || 'Convite individual')}${c.cargo ? ' · ' + esc(c.cargo) : ''}</small>
          ${mapaAtivo ? `<div class="mesa">${assento(c)}</div>` : ''}
          <div class="codigo">Código: <b>${esc(c.codigo ? String(c.codigo).replace(/(.{3})/g, '$1 ').trim() : c.token)}</b></div>
        </div>
      </div>`).join('')}
    </div>`;
}
