'use strict';
// Painel do administrador/organizador

const estado = {
  eu: null,
  ehMaster: false,
  eventoId: null,
  eventos: [],
  evento: null,
  stats: null,
  empresas: [],
  convidados: [],
  mesas: [],
  ocupantes: [],
};
let mapa = null;

// ── Navegação por abas ──
document.getElementById('abas').addEventListener('click', e => {
  const btn = e.target.closest('button[data-secao]');
  if (!btn) return;
  document.querySelectorAll('#abas button').forEach(b => b.classList.toggle('ativa', b === btn));
  document.querySelectorAll('.secao').forEach(s => s.classList.toggle('ativa', s.id === 'secao-' + btn.dataset.secao));
  if (btn.dataset.secao === 'envio') carregarEnvio();
  else pararPollingWa();
});
document.getElementById('btn-sair').addEventListener('click', sair);

// ── Inicialização ──
(async function init() {
  try {
    const eu = await api('/api/me');
    if (eu.role !== 'master' && eu.role !== 'admin_evento') { location.href = '/empresa.html'; return; }
    estado.eu = eu;
    estado.ehMaster = eu.role === 'master';
  } catch { return; }

  // Identificação do usuário conectado
  document.getElementById('usuario-logado').innerHTML =
    `👤 ${esc(estado.eu.nome || estado.eu.username)} <em>· ${estado.ehMaster ? 'Master' : 'Admin do evento'}</em>`;

  // Admin do evento não vê funções exclusivas do master
  if (!estado.ehMaster) {
    document.querySelectorAll('.apenas-master').forEach(el => el.classList.add('oculto'));
    document.getElementById('btn-novo-evento').classList.add('oculto');
    document.getElementById('seletor-evento').classList.add('oculto');
  }

  mapa = criarMapa(document.getElementById('mapa-mesas'), {
    editavel: true,
    aoMover: async (id, x, y) => {
      try { await api(`/api/admin/mesas/${id}/posicao`, { method: 'PUT', body: { x, y } }); }
      catch (e) { toast(e.message, 'erro'); }
    },
    aoClicar: abrirModalMesa,
  });

  await carregarEventos();
  // Master aterrissa na visão geral da plataforma; admin do evento, no seu evento
  if (estado.ehMaster) ativarAba('eventos');
})();

function ativarAba(secao) {
  const btn = document.querySelector(`#abas button[data-secao="${secao}"]`);
  if (btn) btn.click();
}

async function carregarEventos() {
  estado.eventos = await api('/api/admin/eventos');
  const sel = document.getElementById('seletor-evento');
  sel.innerHTML = estado.eventos.map(e =>
    `<option value="${e.id}">${esc(e.nome)}</option>`).join('');
  if (estado.ehMaster) {
    const salvo = Number(localStorage.getItem('eventoId'));
    estado.eventoId = estado.eventos.some(e => e.id === salvo) ? salvo : (estado.eventos[0]?.id ?? null);
  } else {
    estado.eventoId = estado.eu.evento_id ?? (estado.eventos[0]?.id ?? null);
  }
  if (estado.eventoId) sel.value = estado.eventoId;
  sel.onchange = () => {
    estado.eventoId = Number(sel.value);
    localStorage.setItem('eventoId', estado.eventoId);
    recarregar();
  };
  desenharEventosMaster();
  await recarregar();
}

// ═══════════ EVENTOS (visão master) ═══════════

function desenharEventosMaster() {
  if (!estado.ehMaster) return;
  const area = document.getElementById('lista-eventos-master');
  if (!estado.eventos.length) {
    area.innerHTML = '<div class="painel"><p>Nenhum evento criado ainda. Comece pelo botão acima.</p></div>';
    return;
  }
  area.innerHTML = estado.eventos.map(e => `
    <div class="cartao-evento ${e.id === estado.eventoId ? 'atual' : ''}">
      <div class="cabeca">
        <h3>${esc(e.nome)}</h3>
        ${e.id === estado.eventoId ? '<span class="selo selo-confirmado">evento ativo</span>' : ''}
      </div>
      <div class="detalhes">
        📅 ${dataBr(e.data_evento)} às ${esc(e.hora_evento)}<br>
        📍 ${esc(e.local_nome)}<br>
        ⏳ Prazo dos convites: ${dataBr(e.deadline)}
      </div>
      <div class="numeros">
        <span><strong>${e.total_empresas}</strong> conv. principais</span>
        <span><strong>${e.total_inscritos}</strong> inscritos</span>
        <span>${e.mapa_mesas !== 0 ? '🗺️ mapa ligado' : '🚫 sem mapa'}</span>
      </div>
      <div class="acoes-cartao">
        <button class="botao-ouro botao-mini" onclick="abrirEventoMaster(${e.id})">Abrir painel</button>
        <button class="botao-claro botao-mini" onclick="abrirEventoMaster(${e.id}, 'evento')">⚙️ Configurar</button>
        <button class="botao-perigo botao-mini" onclick="excluirEventoMaster(${e.id})">Excluir</button>
      </div>
    </div>`).join('');
}

window.abrirEventoMaster = (id, secao = 'visao') => {
  estado.eventoId = id;
  localStorage.setItem('eventoId', id);
  document.getElementById('seletor-evento').value = id;
  recarregar().then(() => desenharEventosMaster());
  ativarAba(secao);
};

window.excluirEventoMaster = (id) => {
  const e = estado.eventos.find(x => x.id === id);
  const m = abrirModal(`
    <h3>Excluir evento?</h3>
    <p><strong>${esc(e.nome)}</strong> será removido com TODOS os seus dados: convidados principais,
    convidados, mesas, envios e acessos. Esta ação não pode ser desfeita.</p>
    <label>Digite o nome do evento para confirmar</label><input id="xe-nome" placeholder="${esc(e.nome)}">
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-perigo" id="xe-conf">Excluir definitivamente</button></div>`);
  m.querySelector('#xe-conf').onclick = async () => {
    if (m.querySelector('#xe-nome').value.trim() !== e.nome) {
      toast('O nome digitado não confere.', 'erro');
      return;
    }
    try {
      await api(`/api/admin/eventos/${id}`, { method: 'DELETE' });
      m.remove();
      toast('Evento excluído.', 'ok');
      localStorage.removeItem('eventoId');
      await carregarEventos();
      desenharEventosMaster();
    } catch (err) { toast(err.message, 'erro'); }
  };
};

// Mostra/esconde tudo que depende do mapa de mesas estar habilitado no evento
function aplicarMapaMesas() {
  const ativo = estado.evento ? estado.evento.mapa_mesas !== 0 : true;
  const abaMapa = document.getElementById('aba-mapa');
  abaMapa.classList.toggle('oculto', !ativo);
  const toggle = document.getElementById('toggle-mapa');
  if (toggle) toggle.checked = ativo;
  // se a aba ativa é o mapa e ele foi desligado, volta para a visão geral
  if (!ativo && document.getElementById('secao-mapa').classList.contains('ativa')) {
    document.querySelector('#abas button[data-secao="visao"]').click();
  }
  return ativo;
}

async function recarregar() {
  if (!estado.eventoId) return;
  const id = estado.eventoId;
  estado.evento = estado.eventos.find(e => e.id === id);
  const mapaAtivo = estado.evento ? estado.evento.mapa_mesas !== 0 : true;
  const [stats, empresas, convidados, mapaDados, checkins, admins] = await Promise.all([
    api(`/api/admin/eventos/${id}/stats`),
    api(`/api/admin/eventos/${id}/empresas`),
    api(`/api/admin/eventos/${id}/convidados`),
    mapaAtivo ? api(`/api/admin/eventos/${id}/mesas`) : Promise.resolve({ mesas: [], ocupantes: [] }),
    api(`/api/admin/eventos/${id}/checkins`),
    estado.ehMaster ? api(`/api/admin/eventos/${id}/admins`) : Promise.resolve([]),
  ]);
  estado.stats = stats;
  estado.empresas = empresas;
  estado.convidados = convidados;
  estado.mesas = mapaDados.mesas;
  estado.ocupantes = mapaDados.ocupantes;

  aplicarMapaMesas();
  desenharStats();
  preencherFormEvento();
  desenharEmpresas();
  desenharAdmins(admins);
  desenharConvidados();
  mapa.atualizar(estado.mesas, estado.ocupantes);
  desenharCheckins(checkins);
  desenharRelatorios();
  desenharEventosMaster();
}

// ═══════════ RELATÓRIOS ═══════════

const RELATORIOS = [
  { tipo: 'geral', titulo: '📋 Lista geral', desc: 'Todos os convidados com contato, assento e status. Aceita filtros.' },
  { tipo: 'credenciamento', titulo: '🖊️ Credenciamento', desc: 'Ordem alfabética com campo de assinatura — plano B da recepção.' },
  { tipo: 'empresas', titulo: '🏭 Por empresa', desc: 'Cotas, usos e convidados de cada empresa. Aponta pendências.' },
  { tipo: 'mapa', titulo: '🗺️ Mapa de mesas', desc: 'Layout do salão e ocupação mesa a mesa, para o cerimonial.' },
  { tipo: 'presenca', titulo: '✅ Presença', desc: 'Confirmações × check-ins com horários e taxa de comparecimento.' },
  { tipo: 'etiquetas', titulo: '🎫 Etiquetas', desc: 'Credenciais com QR code, nome, empresa e mesa, para recorte.' },
];

function desenharRelatorios() {
  const selEmpresa = document.getElementById('rel-empresa');
  const valorAtual = selEmpresa.value;
  selEmpresa.innerHTML = '<option value="">Todas</option><option value="individual">Somente individuais</option>' +
    estado.empresas.map(e => `<option value="${e.id}">${esc(e.empresa_nome)}</option>`).join('');
  selEmpresa.value = valorAtual || '';

  const mapaAtivo = estado.evento ? estado.evento.mapa_mesas !== 0 : true;
  document.getElementById('cartoes-relatorios').innerHTML = RELATORIOS.filter(r => mapaAtivo || r.tipo !== 'mapa').map(r => `
    <div class="stat" style="display:flex;flex-direction:column;gap:8px">
      <div style="font-size:16px;font-weight:700;color:var(--escuro-2)">${r.titulo}</div>
      <div style="font-size:13px;color:var(--texto-suave);flex:1">${r.desc}</div>
      <div style="display:flex;gap:8px">
        <button class="botao-ouro botao-mini" style="flex:1" onclick="abrirRelatorio('${r.tipo}')">🖨️ Imprimir/PDF</button>
        <button class="botao-claro botao-mini" title="Baixar em Excel (.xlsx)" onclick="baixarRelatorioXlsx('${r.tipo}')">📊 Excel</button>
      </div>
    </div>`).join('');
}

function filtrosRelatorio(tipo) {
  const q = new URLSearchParams({ evento: estado.eventoId, tipo });
  const status = document.getElementById('rel-status').value;
  const empresa = document.getElementById('rel-empresa').value;
  if (status && (tipo === 'geral' || tipo === 'presenca')) q.set('status', status);
  if (empresa && (tipo === 'geral' || tipo === 'etiquetas')) q.set('empresa', empresa);
  return q;
}

window.abrirRelatorio = (tipo) => {
  window.open('/relatorios.html?' + filtrosRelatorio(tipo).toString(), '_blank');
};

window.baixarRelatorioXlsx = (tipo) => {
  const q = filtrosRelatorio(tipo);
  q.delete('evento');
  location.href = `/api/admin/eventos/${estado.eventoId}/relatorio-xlsx?${q.toString()}`;
};

// ═══════════ VISÃO GERAL ═══════════

function desenharStats() {
  const s = estado.stats;
  document.getElementById('stats').innerHTML = `
    <div class="stat destaque"><div class="valor">${s.inscritos}</div><div class="rotulo">Inscritos</div></div>
    <div class="stat"><div class="valor">${s.empresas}</div><div class="rotulo">Conv. principais</div></div>
    <div class="stat"><div class="valor">${s.cota_total}</div><div class="rotulo">Cota total</div></div>
    <div class="stat"><div class="valor">${s.confirmados}</div><div class="rotulo">Confirmados</div></div>
    <div class="stat"><div class="valor">${s.checkins}</div><div class="rotulo">Check-ins</div></div>
    <div class="stat"><div class="valor">${s.pool_individual}</div><div class="rotulo">Pool individual</div></div>
  `;
  document.getElementById('pool-disponivel').textContent = s.pool_individual;

  const area = document.getElementById('area-expiracao');
  if (s.expirado) {
    area.innerHTML = `<div class="aviso-caixa aviso-ok">✓ Expiração processada. Os convites não utilizados pelas empresas
      foram recolhidos para o pool individual.</div>`;
  } else {
    const hoje = new Date().toISOString().slice(0, 10);
    const vencido = hoje > s.deadline;
    area.innerHTML = `
      <div class="aviso-caixa ${vencido ? 'aviso-erro' : 'aviso-info'}">
        Prazo dos convites das empresas: <strong>${dataBr(s.deadline)}</strong>${vencido ? ' — <strong>prazo vencido!</strong> Processe a expiração para recolher os convites não usados.' : ''}
      </div>
      <button class="botao-perigo" id="btn-expirar">Processar expiração agora</button>`;
    document.getElementById('btn-expirar').onclick = async () => {
      const m = abrirModal(`
        <h3>Processar expiração dos convites?</h3>
        <p>Os convites <strong>não utilizados</strong> pelas empresas serão recolhidos para o pool de convites
        individuais e as empresas não poderão mais inscrever convidados. Esta ação não pode ser desfeita.</p>
        <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
        <button class="botao-perigo" id="btn-conf-exp">Confirmar expiração</button></div>`);
      m.querySelector('#btn-conf-exp').onclick = async () => {
        try {
          const r = await api(`/api/admin/eventos/${estado.eventoId}/expirar`, { method: 'POST' });
          m.remove();
          toast(`Expiração concluída: ${r.recolhidos} convite(s) recolhido(s) para o pool.`, 'ok');
          recarregar();
        } catch (e) { toast(e.message, 'erro'); }
      };
    };
  }
}

document.getElementById('btn-pool-mais').onclick = () => ajustarPool(1);
document.getElementById('btn-pool-menos').onclick = () => ajustarPool(-1);
async function ajustarPool(sinal) {
  const n = Math.max(1, Number(document.getElementById('pool-delta').value || 1));
  try {
    const r = await api(`/api/admin/eventos/${estado.eventoId}/pool`, { method: 'POST', body: { delta: sinal * n } });
    toast(`Pool individual: ${r.pool_individual} convite(s).`, 'ok');
    recarregar();
  } catch (e) { toast(e.message, 'erro'); }
}

// ═══════════ EVENTO ═══════════

function linhaHotel(h = {}) {
  const div = document.createElement('div');
  div.className = 'linha-flex';
  div.innerHTML = `
    <div><input placeholder="Nome do hotel" data-campo="nome" value="${esc(h.nome || '')}"></div>
    <div><input placeholder="Endereço" data-campo="endereco" value="${esc(h.endereco || '')}"></div>
    <div class="curto"><input placeholder="Distância" data-campo="distancia" value="${esc(h.distancia || '')}"></div>
    <div class="curto"><input placeholder="Telefone" data-campo="telefone" value="${esc(h.telefone || '')}"></div>
    <div class="curto"><button type="button" class="botao-mini botao-perigo" onclick="this.closest('.linha-flex').remove()">✕</button></div>`;
  return div;
}
function linhaFacility(f = {}) {
  const div = document.createElement('div');
  div.className = 'linha-flex';
  div.innerHTML = `
    <div class="curto"><input placeholder="Título (ex.: Estacionamento)" data-campo="titulo" value="${esc(f.titulo || '')}"></div>
    <div style="flex:2 1 240px"><input placeholder="Descrição" data-campo="descricao" value="${esc(f.descricao || '')}"></div>
    <div class="curto"><button type="button" class="botao-mini botao-perigo" onclick="this.closest('.linha-flex').remove()">✕</button></div>`;
  return div;
}
document.getElementById('btn-add-hotel').onclick = () => document.getElementById('lista-hoteis').appendChild(linhaHotel());
document.getElementById('btn-add-facility').onclick = () => document.getElementById('lista-facilities').appendChild(linhaFacility());

function coletarLinhas(containerId) {
  return [...document.getElementById(containerId).children].map(div => {
    const obj = {};
    div.querySelectorAll('[data-campo]').forEach(inp => obj[inp.dataset.campo] = inp.value.trim());
    return obj;
  }).filter(o => Object.values(o).some(v => v));
}

function preencherFormEvento() {
  const e = estado.evento;
  if (!e) return;
  const f = document.getElementById('form-evento');
  for (const campo of ['nome', 'data_evento', 'hora_evento', 'local_nome', 'endereco', 'dress_code', 'deadline', 'descricao', 'email_titulo', 'email_texto', 'email_rodape']) {
    if (f.elements[campo]) f.elements[campo].value = e[campo] || '';
  }
  desenharBanner(e.banner);
  desenharTimbrado(e.timbrado);
  const hoteis = JSON.parse(e.hoteis || '[]');
  const facilities = JSON.parse(e.facilities || '[]');
  const lh = document.getElementById('lista-hoteis'); lh.innerHTML = '';
  hoteis.forEach(h => lh.appendChild(linhaHotel(h)));
  const lf = document.getElementById('lista-facilities'); lf.innerHTML = '';
  facilities.forEach(x => lf.appendChild(linhaFacility(x)));
  document.getElementById('mapa-google').src =
    `https://www.google.com/maps?q=${encodeURIComponent(e.local_nome + ' ' + e.endereco)}&output=embed`;
}

document.getElementById('form-evento').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target;
  const corpo = {
    nome: f.elements.nome.value, data_evento: f.elements.data_evento.value,
    hora_evento: f.elements.hora_evento.value, local_nome: f.elements.local_nome.value,
    endereco: f.elements.endereco.value, dress_code: f.elements.dress_code.value,
    deadline: f.elements.deadline.value, descricao: f.elements.descricao.value,
    hoteis: coletarLinhas('lista-hoteis'), facilities: coletarLinhas('lista-facilities'),
    email_titulo: f.elements.email_titulo.value, email_texto: f.elements.email_texto.value,
    email_rodape: f.elements.email_rodape.value,
  };
  try {
    await api(`/api/admin/eventos/${estado.eventoId}`, { method: 'PUT', body: corpo });
    toast('Evento salvo.', 'ok');
    await carregarEventos();
  } catch (e) { toast(e.message, 'erro'); }
});

// ── Imagens do evento (banner do convite e timbrado dos relatórios) ──
function configurarImagemEvento(campo, rotulo, inputId, previewId, btnRemoverId) {
  document.getElementById(inputId).addEventListener('change', ev => {
    const arquivo = ev.target.files[0];
    if (!arquivo) return;
    if (arquivo.size > 2 * 1024 * 1024) {
      toast('A imagem deve ter no máximo 2 MB.', 'erro');
      ev.target.value = '';
      return;
    }
    const leitor = new FileReader();
    leitor.onload = async () => {
      try {
        await api(`/api/admin/eventos/${estado.eventoId}/${campo}`, { method: 'POST', body: { imagem: leitor.result } });
        toast(`${rotulo} atualizado.`, 'ok');
        await carregarEventos();
      } catch (e) { toast(e.message, 'erro'); }
      ev.target.value = '';
    };
    leitor.readAsDataURL(arquivo);
  });

  document.getElementById(btnRemoverId).onclick = async () => {
    try {
      await api(`/api/admin/eventos/${estado.eventoId}/${campo}`, { method: 'DELETE' });
      toast(`${rotulo} removido.`, 'ok');
      await carregarEventos();
    } catch (e) { toast(e.message, 'erro'); }
  };

  return function desenhar(arquivo) {
    const prev = document.getElementById(previewId);
    const btn = document.getElementById(btnRemoverId);
    if (arquivo) {
      prev.innerHTML = `<img src="/banners/${esc(arquivo)}?v=${Date.now()}" alt="${rotulo}"
        style="max-width:100%;max-height:180px;border-radius:10px;border:1px solid var(--borda);margin-bottom:8px">`;
      btn.classList.remove('oculto');
    } else {
      prev.innerHTML = '';
      btn.classList.add('oculto');
    }
  };
}
const desenharBanner = configurarImagemEvento('banner', 'Banner', 'banner-arquivo', 'banner-preview', 'btn-remover-banner');
const desenharTimbrado = configurarImagemEvento('timbrado', 'Timbrado', 'timbrado-arquivo', 'timbrado-preview', 'btn-remover-timbrado');

function abrirModalNovoEvento() {
  const m = abrirModal(`
    <h3>Criar novo evento</h3>
    <label>Nome *</label><input id="ne-nome" placeholder="Jantar FECOFAR 2027">
    <div class="linha-flex">
      <div><label>Data *</label><input id="ne-data" type="date"></div>
      <div><label>Deadline dos convites *</label><input id="ne-deadline" type="date"></div>
    </div>
    <label>Local *</label><input id="ne-local">
    <label>Endereço *</label><input id="ne-endereco">
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-ouro" id="ne-criar">Criar evento</button></div>`);
  m.querySelector('#ne-criar').onclick = async () => {
    try {
      const r = await api('/api/admin/eventos', { method: 'POST', body: {
        nome: m.querySelector('#ne-nome').value, data_evento: m.querySelector('#ne-data').value,
        deadline: m.querySelector('#ne-deadline').value, local_nome: m.querySelector('#ne-local').value,
        endereco: m.querySelector('#ne-endereco').value,
      }});
      m.remove();
      localStorage.setItem('eventoId', r.id);
      toast('Evento criado.', 'ok');
      await carregarEventos();
      desenharEventosMaster();
    } catch (e) { toast(e.message, 'erro'); }
  };
}
document.getElementById('btn-novo-evento').onclick = abrirModalNovoEvento;
document.getElementById('btn-novo-evento-master').onclick = abrirModalNovoEvento;

// ═══════════ FUNCIONALIDADES (master) ═══════════

document.getElementById('toggle-mapa').addEventListener('change', async ev => {
  try {
    const r = await api(`/api/admin/eventos/${estado.eventoId}/mapa`, { method: 'PUT', body: { ativo: ev.target.checked ? 1 : 0 } });
    toast(r.mapa_mesas ? 'Mapa de mesas habilitado.' : 'Mapa de mesas desativado (as mesas foram preservadas).', 'ok');
    await carregarEventos();
  } catch (e) { toast(e.message, 'erro'); ev.target.checked = !ev.target.checked; }
});

// ═══════════ ADMINS DO EVENTO (master) ═══════════

document.getElementById('form-admin-evento').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await api(`/api/admin/eventos/${estado.eventoId}/admins`, { method: 'POST', body: {
      nome: f.elements.nome.value, cargo: f.elements.cargo.value,
      email: f.elements.email.value, telefone: f.elements.telefone.value,
    }});
    f.reset();
    abrirModal(`
      <h3>✓ Administrador do evento criado</h3>
      <p>Envie estas credenciais ao responsável pelo evento. Ele acessa o painel restrito a este evento
      e pode conectar o próprio WhatsApp e e-mail na aba <em>Envio</em>.</p>
      <label>Login</label><input readonly value="${esc(r.username)}">
      <label>Senha</label><input readonly value="${esc(r.senha)}">
      <div class="acoes"><button class="botao-ouro" data-fechar>Entendi</button></div>`);
    recarregar();
  } catch (e) { toast(e.message, 'erro'); }
});

function desenharAdmins(admins) {
  const t = document.getElementById('tabela-admins');
  if (!estado.ehMaster) return;
  if (!admins.length) {
    t.innerHTML = '<tr><td>Nenhum administrador criado para este evento.</td></tr>';
    return;
  }
  t.innerHTML = `<tr><th>Nome</th><th>Login</th><th>Senha</th><th>Contato</th><th>Ações</th></tr>` +
    admins.map(a => `
      <tr>
        <td><strong>${esc(a.nome)}</strong>${a.cargo ? `<br><small style="color:var(--texto-suave)">${esc(a.cargo)}</small>` : ''}</td>
        <td><code>${esc(a.username)}</code></td>
        <td>${a.senha_provisoria ? `<code>${esc(a.senha_provisoria)}</code>` : '<small>alterada pelo usuário</small>'}</td>
        <td><small>${esc(a.email || '')}${a.email && a.telefone ? '<br>' : ''}${esc(a.telefone || '')}</small></td>
        <td style="white-space:nowrap">
          <button class="botao-mini botao-claro" onclick="novaSenhaAdmin(${a.id})">Nova senha</button>
          <button class="botao-mini botao-perigo" onclick="excluirAdmin(${a.id})">Excluir</button>
        </td>
      </tr>`).join('');
}

window.novaSenhaAdmin = async (id) => {
  try {
    const r = await api(`/api/admin/admins/${id}/nova-senha`, { method: 'POST' });
    abrirModal(`
      <h3>Nova senha gerada</h3>
      <label>Login</label><input readonly value="${esc(r.username)}">
      <label>Senha</label><input readonly value="${esc(r.senha)}">
      <div class="acoes"><button class="botao-ouro" data-fechar>Fechar</button></div>`);
    recarregar();
  } catch (e) { toast(e.message, 'erro'); }
};

window.excluirAdmin = (id) => {
  const m = abrirModal(`
    <h3>Excluir administrador do evento?</h3>
    <p>O acesso dele será removido. Os dados do evento não são afetados.</p>
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-perigo" id="xa-conf">Excluir</button></div>`);
  m.querySelector('#xa-conf').onclick = async () => {
    try { await api(`/api/admin/admins/${id}`, { method: 'DELETE' }); m.remove(); toast('Administrador excluído.', 'ok'); recarregar(); }
    catch (e) { toast(e.message, 'erro'); }
  };
};

// ═══════════ ENVIO (e-mail e WhatsApp do evento) ═══════════

let pollWa = null;
function pararPollingWa() {
  if (pollWa) { clearInterval(pollWa); pollWa = null; }
}

async function carregarEnvio() {
  try {
    const cfg = await api(`/api/admin/eventos/${estado.eventoId}/envio`);
    const f = document.getElementById('form-envio-email');
    f.elements.remetente_nome.value = cfg.remetente_nome || '';
    f.elements.reply_to.value = cfg.reply_to || '';
    f.elements.smtp_host.value = cfg.smtp_host || '';
    f.elements.smtp_port.value = cfg.smtp_port || 587;
    f.elements.smtp_secure.value = cfg.smtp_secure ? '1' : '0';
    f.elements.smtp_user.value = cfg.smtp_user || '';
    f.elements.smtp_pass.placeholder = cfg.tem_senha ? 'Deixe em branco para manter a atual' : 'Senha de app do seu provedor';
    const proprio = cfg.smtp_modo === 'proprio';
    document.getElementById('smtp-proprio').checked = proprio;
    document.getElementById('campos-smtp').classList.toggle('oculto', !proprio);
    await atualizarStatusWa();
  } catch (e) { toast(e.message, 'erro'); }
}

document.getElementById('smtp-proprio').addEventListener('change', ev => {
  document.getElementById('campos-smtp').classList.toggle('oculto', !ev.target.checked);
});

document.getElementById('form-envio-email').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api(`/api/admin/eventos/${estado.eventoId}/envio`, { method: 'PUT', body: {
      remetente_nome: f.elements.remetente_nome.value,
      reply_to: f.elements.reply_to.value,
      smtp_modo: document.getElementById('smtp-proprio').checked ? 'proprio' : 'global',
      smtp_host: f.elements.smtp_host.value,
      smtp_port: f.elements.smtp_port.value,
      smtp_secure: f.elements.smtp_secure.value === '1',
      smtp_user: f.elements.smtp_user.value,
      smtp_pass: f.elements.smtp_pass.value,
    }});
    f.elements.smtp_pass.value = '';
    toast('Configuração de envio salva.', 'ok');
    carregarEnvio();
  } catch (e) { toast(e.message, 'erro'); }
});

document.getElementById('btn-testar-email').onclick = async () => {
  try {
    const r = await api(`/api/admin/eventos/${estado.eventoId}/envio/testar-email`, { method: 'POST' });
    toast(r.mensagem, 'ok');
  } catch (e) { toast(e.message, 'erro'); }
};

function desenharStatusWa(estadoWa) {
  const area = document.getElementById('wa-status');
  const btnCon = document.getElementById('btn-wa-conectar');
  const btnDes = document.getElementById('btn-wa-desconectar');
  const mapa = {
    open:        ['aviso-ok',   '✅ <strong>WhatsApp conectado.</strong> Os convites saem do número conectado.'],
    connecting:  ['aviso-info', '⏳ <strong>Aguardando conexão…</strong> escaneie o QR code com o seu WhatsApp.'],
    close:       ['aviso-erro', '⚠️ <strong>Desconectado.</strong> Gere um novo QR code para reconectar.'],
    nao_criada:  ['aviso-info', 'Nenhum WhatsApp conectado a este evento ainda. Sem conexão, o sistema gera links wa.me para envio manual (1 clique).'],
    indisponivel:['aviso-erro', '⚠️ O servidor de WhatsApp está indisponível no momento.'],
  };
  const [classe, texto] = mapa[estadoWa] || mapa.indisponivel;
  area.innerHTML = `<div class="aviso-caixa ${classe}">${texto}</div>`;
  btnCon.textContent = estadoWa === 'open' ? 'Reconectar (novo QR)' : (estadoWa === 'close' ? 'Gerar novo QR code' : 'Conectar meu WhatsApp');
  btnDes.classList.toggle('oculto', estadoWa === 'nao_criada' || estadoWa === 'indisponivel');
}

async function atualizarStatusWa() {
  try {
    const r = await api(`/api/admin/eventos/${estado.eventoId}/whatsapp/status`);
    desenharStatusWa(r.estado);
    return r.estado;
  } catch { desenharStatusWa('indisponivel'); return 'indisponivel'; }
}

document.getElementById('btn-wa-conectar').onclick = async () => {
  const btn = document.getElementById('btn-wa-conectar');
  btn.disabled = true;
  try {
    const r = await api(`/api/admin/eventos/${estado.eventoId}/whatsapp/conectar`, { method: 'POST' });
    if (r.estado === 'open' && !r.qr) {
      toast('WhatsApp já está conectado.', 'ok');
      desenharStatusWa('open');
      return;
    }
    const m = abrirModal(`
      <h3>Conectar WhatsApp</h3>
      <p>No seu celular, abra o WhatsApp → <strong>Aparelhos conectados</strong> →
      <strong>Conectar um aparelho</strong> e escaneie o código abaixo:</p>
      <div style="text-align:center">${r.qr ? `<img src="${r.qr}" alt="QR code" style="width:260px;max-width:100%">` : '<p>QR indisponível — tente novamente.</p>'}</div>
      <p id="wa-modal-status" style="text-align:center;color:var(--texto-suave)">Aguardando leitura…</p>
      <div class="acoes"><button class="botao-claro" data-fechar>Fechar</button></div>`);
    pararPollingWa();
    pollWa = setInterval(async () => {
      if (!document.body.contains(m)) { pararPollingWa(); atualizarStatusWa(); return; }
      const estadoWa = await atualizarStatusWa();
      if (estadoWa === 'open') {
        pararPollingWa();
        m.remove();
        toast('WhatsApp conectado com sucesso!', 'ok');
      }
    }, 3000);
  } catch (e) { toast(e.message, 'erro'); }
  finally { btn.disabled = false; }
};

document.getElementById('btn-wa-desconectar').onclick = async () => {
  const m = abrirModal(`
    <h3>Desconectar WhatsApp?</h3>
    <p>Os envios deste evento deixarão de sair do número conectado (o sistema volta a gerar links wa.me).</p>
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-perigo" id="wa-desc-conf">Desconectar</button></div>`);
  m.querySelector('#wa-desc-conf').onclick = async () => {
    try {
      await api(`/api/admin/eventos/${estado.eventoId}/whatsapp/desconectar`, { method: 'POST' });
      m.remove(); toast('WhatsApp desconectado.', 'ok'); atualizarStatusWa();
    } catch (e) { toast(e.message, 'erro'); }
  };
};

// ═══════════ CONVIDADOS PRINCIPAIS ═══════════

document.getElementById('form-empresa').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await api('/api/admin/empresas', { method: 'POST', body: {
      evento_id: estado.eventoId,
      empresa_nome: f.elements.empresa_nome.value, cota: f.elements.cota.value,
      nome: f.elements.nome.value, cargo: f.elements.cargo.value,
      email: f.elements.email.value, telefone: f.elements.telefone.value,
    }});
    f.reset(); f.elements.cota.value = 4;
    abrirModal(`
      <h3>✓ Convidado principal cadastrado</h3>
      <p>Acesso gerado — envie estas credenciais ao responsável (o botão “Enviar convite” da lista de
      convidados já inclui login e senha na mensagem do responsável):</p>
      <label>Login</label><input readonly value="${esc(r.username)}">
      <label>Senha</label><input readonly value="${esc(r.senha)}">
      <div class="acoes"><button class="botao-ouro" data-fechar>Entendi</button></div>`);
    recarregar();
  } catch (e) { toast(e.message, 'erro'); }
});

// ── Importação em lote via planilha ──

const inputImportacao = document.getElementById('arquivo-importacao');
const btnImportar = document.getElementById('btn-importar');
inputImportacao.addEventListener('change', () => { btnImportar.disabled = !inputImportacao.files.length; });

btnImportar.onclick = () => {
  const arquivo = inputImportacao.files[0];
  if (!arquivo) return;
  if (arquivo.size > 5 * 1024 * 1024) { toast('A planilha deve ter no máximo 5 MB.', 'erro'); return; }
  const leitor = new FileReader();
  leitor.onload = async () => {
    btnImportar.disabled = true;
    try {
      const r = await api(`/api/admin/eventos/${estado.eventoId}/importar`, {
        method: 'POST', body: { arquivo: leitor.result, confirmar: false },
      });
      abrirPreviewImportacao(leitor.result, r);
    } catch (e) { toast(e.message, 'erro'); }
    finally { btnImportar.disabled = !inputImportacao.files.length; }
  };
  leitor.readAsDataURL(arquivo);
};

function abrirPreviewImportacao(arquivoBase64, r) {
  const linhasHtml = r.linhas.map(l => `
    <tr style="${l.valida ? '' : 'opacity:.55'}">
      <td class="num">${l.linha}</td>
      <td><strong>${esc(l.empresa_nome || '—')}</strong></td>
      <td>${l.cota}</td>
      <td>${esc(l.nome || '—')}</td>
      <td><small>${esc(l.email || '')}${l.email && l.telefone ? '<br>' : ''}${esc(l.telefone || '')}</small></td>
      <td>${l.valida
        ? (l.problemas.length ? `<span class="selo selo-pendente">⚠ ${esc(l.problemas.join('; '))}</span>` : '<span class="selo selo-confirmado">✓ ok</span>')
        : `<span class="selo selo-cancelado">✕ ${esc(l.problemas.join('; '))}</span>`}</td>
    </tr>`).join('');
  const m = abrirModal(`
    <h3>📥 Pré-visualização da importação</h3>
    <p><strong>${r.validas}</strong> de <strong>${r.total}</strong> linha(s) serão importadas
       ${r.validas < r.total ? '— as demais serão ignoradas (veja o motivo em cada linha)' : ''}.</p>
    <div class="rolagem-x" style="max-height:320px;overflow-y:auto">
      <table class="tabela">
        <tr><th>Linha</th><th>Empresa</th><th>Cota</th><th>Responsável</th><th>Contato</th><th>Situação</th></tr>
        ${linhasHtml}
      </table>
    </div>
    <div class="acoes">
      <button class="botao-claro" data-fechar>Cancelar</button>
      <button class="botao-ouro" id="imp-confirmar" ${r.validas ? '' : 'disabled'}>Confirmar importação (${r.validas})</button>
    </div>`);
  m.querySelector('#imp-confirmar').onclick = async () => {
    const btn = m.querySelector('#imp-confirmar');
    btn.disabled = true; btn.textContent = 'Importando…';
    try {
      const rc = await api(`/api/admin/eventos/${estado.eventoId}/importar`, {
        method: 'POST', body: { arquivo: arquivoBase64, confirmar: true },
      });
      m.remove();
      inputImportacao.value = '';
      btnImportar.disabled = true;
      mostrarResultadoImportacao(rc);
      recarregar();
    } catch (e) { toast(e.message, 'erro'); btn.disabled = false; btn.textContent = 'Confirmar importação'; }
  };
}

function mostrarResultadoImportacao(rc) {
  const m = abrirModal(`
    <h3>✓ Importação concluída</h3>
    <p><strong>${rc.criadas.length}</strong> convidado(s) principal(is) criado(s)
       ${rc.ignoradas.length ? ` · ${rc.ignoradas.length} linha(s) ignorada(s)` : ''}.
       Guarde as credenciais abaixo — a senha também aparece na tabela e vai na mensagem
       do convite do responsável.</p>
    <div class="rolagem-x" style="max-height:300px;overflow-y:auto">
      <table class="tabela">
        <tr><th>Empresa</th><th>Cota</th><th>Login</th><th>Senha</th></tr>
        ${rc.criadas.map(c => `
          <tr><td><strong>${esc(c.empresa_nome)}</strong></td><td>${c.cota}</td>
          <td><code>${esc(c.username)}</code></td><td><code>${esc(c.senha)}</code></td></tr>`).join('')}
      </table>
    </div>
    <div class="acoes">
      <button class="botao-claro" id="imp-baixar-csv">⬇ Baixar credenciais (CSV)</button>
      <button class="botao-ouro" data-fechar>Concluir</button>
    </div>`);
  m.querySelector('#imp-baixar-csv').onclick = () => {
    const linhas = [['Empresa', 'Cota', 'Login', 'Senha'],
      ...rc.criadas.map(c => [c.empresa_nome, c.cota, c.username, c.senha])];
    const csv = '﻿' + linhas.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    // (o prefixo acima é o BOM UTF-8, para o Excel abrir os acentos corretamente)
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'credenciais-convidados-principais.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

function desenharEmpresas() {
  const t = document.getElementById('tabela-empresas');
  if (!estado.empresas.length) {
    t.innerHTML = '<tr><td>Nenhum convidado principal cadastrado ainda.</td></tr>';
    return;
  }
  t.innerHTML = `
    <tr><th>Empresa/Organização</th><th>Responsável</th><th>Login</th><th>Senha</th><th>Cota</th><th>Usados</th><th>Ações</th></tr>` +
    estado.empresas.map(e => `
      <tr>
        <td><strong>${esc(e.empresa_nome)}</strong></td>
        <td>${esc(e.nome || '—')}${e.cargo ? `<br><small style="color:var(--texto-suave)">${esc(e.cargo)}</small>` : ''}</td>
        <td><code>${esc(e.username)}</code></td>
        <td>${e.senha_provisoria ? `<code>${esc(e.senha_provisoria)}</code>` : '<small>alterada pelo usuário</small>'}</td>
        <td>${e.cota}</td>
        <td>${e.usados}</td>
        <td style="white-space:nowrap">
          <button class="botao-mini botao-claro" onclick="editarEmpresa(${e.id})">Editar</button>
          <button class="botao-mini botao-claro" onclick="novaSenhaEmpresa(${e.id})">Nova senha</button>
          <button class="botao-mini botao-perigo" onclick="excluirEmpresa(${e.id})">Excluir</button>
        </td>
      </tr>`).join('');
}

window.editarEmpresa = (id) => {
  const e = estado.empresas.find(x => x.id === id);
  const m = abrirModal(`
    <h3>Editar empresa</h3>
    <div class="linha-flex">
      <div style="flex:2 1 200px"><label>Empresa</label><input id="ee-empresa" value="${esc(e.empresa_nome)}"></div>
      <div class="curto"><label>Cota</label><input id="ee-cota" type="number" min="${e.usados}" value="${e.cota}"></div>
    </div>
    <div class="linha-flex">
      <div><label>Responsável</label><input id="ee-nome" value="${esc(e.nome)}"></div>
      <div><label>Cargo</label><input id="ee-cargo" value="${esc(e.cargo)}"></div>
    </div>
    <div class="linha-flex">
      <div><label>E-mail</label><input id="ee-email" value="${esc(e.email)}"></div>
      <div><label>Telefone/WhatsApp</label><input id="ee-telefone" value="${esc(e.telefone)}"></div>
    </div>
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-ouro" id="ee-salvar">Salvar</button></div>`);
  m.querySelector('#ee-salvar').onclick = async () => {
    try {
      await api(`/api/admin/empresas/${id}`, { method: 'PUT', body: {
        empresa_nome: m.querySelector('#ee-empresa').value, cota: m.querySelector('#ee-cota').value,
        nome: m.querySelector('#ee-nome').value, cargo: m.querySelector('#ee-cargo').value,
        email: m.querySelector('#ee-email').value, telefone: m.querySelector('#ee-telefone').value,
      }});
      m.remove(); toast('Empresa atualizada.', 'ok'); recarregar();
    } catch (err) { toast(err.message, 'erro'); }
  };
};

window.novaSenhaEmpresa = async (id) => {
  try {
    const r = await api(`/api/admin/empresas/${id}/nova-senha`, { method: 'POST' });
    abrirModal(`
      <h3>Nova senha gerada</h3>
      <label>Login</label><input readonly value="${esc(r.username)}">
      <label>Senha</label><input readonly value="${esc(r.senha)}">
      <div class="acoes"><button class="botao-ouro" data-fechar>Fechar</button></div>`);
    recarregar();
  } catch (e) { toast(e.message, 'erro'); }
};

window.excluirEmpresa = (id) => {
  const e = estado.empresas.find(x => x.id === id);
  const m = abrirModal(`
    <h3>Excluir empresa?</h3>
    <p><strong>${esc(e.empresa_nome)}</strong> e todos os seus convidados serão removidos. Esta ação não pode ser desfeita.</p>
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-perigo" id="ex-conf">Excluir</button></div>`);
  m.querySelector('#ex-conf').onclick = async () => {
    try { await api(`/api/admin/empresas/${id}`, { method: 'DELETE' }); m.remove(); toast('Empresa excluída.', 'ok'); recarregar(); }
    catch (err) { toast(err.message, 'erro'); }
  };
};

// ═══════════ CONVIDADOS ═══════════

document.getElementById('form-individual').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api('/api/admin/convidados', { method: 'POST', body: {
      evento_id: estado.eventoId, nome: f.elements.nome.value,
      email: f.elements.email.value, telefone: f.elements.telefone.value,
    }});
    f.reset(); toast('Convidado individual adicionado.', 'ok'); recarregar();
  } catch (e) { toast(e.message, 'erro'); }
});

document.getElementById('filtro-convidados').addEventListener('input', desenharConvidados);

function desenharConvidados() {
  const filtro = (document.getElementById('filtro-convidados').value || '').toLowerCase();
  const lista = estado.convidados.filter(c =>
    !filtro || [c.nome, c.empresa_nome, c.status, c.tipo].join(' ').toLowerCase().includes(filtro));
  const t = document.getElementById('tabela-convidados');
  if (!lista.length) { t.innerHTML = '<tr><td>Nenhum convidado encontrado.</td></tr>'; return; }
  const mapaAtivo = estado.evento ? estado.evento.mapa_mesas !== 0 : true;
  t.innerHTML = `
    <tr><th>Nome</th><th>Empresa</th><th>Tipo</th><th>Contato</th>${mapaAtivo ? '<th>Assento</th>' : ''}<th>Status</th><th>Ações</th></tr>` +
    lista.map(c => `
      <tr>
        <td><strong>${esc(c.nome)}</strong>${c.cargo ? `<br><small style="color:var(--texto-suave)">${esc(c.cargo)}</small>` : ''}</td>
        <td>${esc(c.empresa_nome || 'Individual')}</td>
        <td>${seloTipo(c.tipo)}</td>
        <td><small>${esc(c.email || '')}${c.email && c.telefone ? '<br>' : ''}${esc(c.telefone || '')}</small></td>
        ${mapaAtivo ? `<td>${assentoTexto(c)}</td>` : ''}
        <td>${seloStatus(c.status)}</td>
        <td style="white-space:nowrap">
          <button class="botao-mini botao-claro" title="Editar" onclick="editarConvidado(${c.id})">✎</button>
          ${mapaAtivo ? `<button class="botao-mini botao-claro" title="Definir assento" onclick="definirAssento(${c.id})">🪑</button>` : ''}
          <button class="botao-mini botao-claro" title="Enviar por e-mail" onclick="enviarConviteAdmin(${c.id},'email')">✉️</button>
          <button class="botao-mini botao-claro" title="Enviar por WhatsApp" onclick="enviarConviteAdmin(${c.id},'whatsapp')">💬</button>
          <a class="botao botao-mini botao-claro" title="Ver convite digital" href="/convite/${esc(c.token)}" target="_blank">🎫</a>
          <button class="botao-mini botao-perigo" title="Excluir" onclick="excluirConvidado(${c.id})">✕</button>
        </td>
      </tr>`).join('');
}

window.editarConvidado = (id) => {
  const c = estado.convidados.find(x => x.id === id);
  const m = abrirModal(`
    <h3>Editar convidado</h3>
    <label>Nome</label><input id="ec-nome" value="${esc(c.nome)}">
    <label>Cargo</label><input id="ec-cargo" value="${esc(c.cargo)}">
    <div class="linha-flex">
      <div><label>E-mail</label><input id="ec-email" value="${esc(c.email)}"></div>
      <div><label>Telefone/WhatsApp</label><input id="ec-telefone" value="${esc(c.telefone)}"></div>
    </div>
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-ouro" id="ec-salvar">Salvar</button></div>`);
  m.querySelector('#ec-salvar').onclick = async () => {
    try {
      await api(`/api/admin/convidados/${id}`, { method: 'PUT', body: {
        nome: m.querySelector('#ec-nome').value, cargo: m.querySelector('#ec-cargo').value,
        email: m.querySelector('#ec-email').value, telefone: m.querySelector('#ec-telefone').value,
      }});
      m.remove(); toast('Convidado atualizado.', 'ok'); recarregar();
    } catch (e) { toast(e.message, 'erro'); }
  };
};

window.definirAssento = (id) => {
  const c = estado.convidados.find(x => x.id === id);
  if (!estado.mesas.length) { toast('Crie as mesas primeiro (aba Mapa de mesas).', 'erro'); return; }
  const opcoesMesas = estado.mesas.map(mm =>
    `<option value="${mm.id}" ${mm.id === c.mesa_id ? 'selected' : ''}>Mesa ${mm.numero}${mm.nome ? ' — ' + esc(mm.nome) : ''} (${mm.capacidade} lugares)</option>`).join('');
  const m = abrirModal(`
    <h3>Assento de ${esc(c.nome)}</h3>
    <div class="linha-flex">
      <div><label>Mesa</label><select id="as-mesa"><option value="">— sem mesa —</option>${opcoesMesas}</select></div>
      <div class="curto"><label>Cadeira</label><select id="as-cadeira"></select></div>
    </div>
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-ouro" id="as-salvar">Salvar assento</button></div>`);
  const selMesa = m.querySelector('#as-mesa');
  const selCad = m.querySelector('#as-cadeira');
  function atualizarCadeiras() {
    const mesa = estado.mesas.find(x => x.id === Number(selMesa.value));
    if (!mesa) { selCad.innerHTML = '<option value="">—</option>'; return; }
    const ocupadas = new Map(estado.ocupantes.filter(o => o.mesa_id === mesa.id && o.id !== c.id).map(o => [o.cadeira, o.nome]));
    selCad.innerHTML = Array.from({ length: mesa.capacidade }, (_, i) => i + 1).map(n =>
      `<option value="${n}" ${ocupadas.has(n) ? 'disabled' : ''} ${c.mesa_id === mesa.id && c.cadeira === n ? 'selected' : ''}>
        ${n}${ocupadas.has(n) ? ' — ' + esc(ocupadas.get(n)) : ''}</option>`).join('');
  }
  selMesa.onchange = atualizarCadeiras;
  atualizarCadeiras();
  m.querySelector('#as-salvar').onclick = async () => {
    try {
      await api(`/api/admin/convidados/${id}/assento`, { method: 'POST', body: {
        mesa_id: selMesa.value ? Number(selMesa.value) : null,
        cadeira: selCad.value ? Number(selCad.value) : null,
      }});
      m.remove(); toast('Assento salvo.', 'ok'); recarregar();
    } catch (e) { toast(e.message, 'erro'); }
  };
};

window.enviarConviteAdmin = async (id, canal) => {
  try {
    const r = await api(`/api/admin/convidados/${id}/enviar`, { method: 'POST', body: { canal } });
    tratarResultadoEnvio(r);
    recarregar();
  } catch (e) { toast(e.message, 'erro'); }
};

window.excluirConvidado = (id) => {
  const c = estado.convidados.find(x => x.id === id);
  const m = abrirModal(`
    <h3>Excluir convidado?</h3>
    <p><strong>${esc(c.nome)}</strong> será removido${c.tipo === 'individual' ? ' e o convite voltará ao pool individual' : ''}.</p>
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-perigo" id="xc-conf">Excluir</button></div>`);
  m.querySelector('#xc-conf').onclick = async () => {
    try { await api(`/api/admin/convidados/${id}`, { method: 'DELETE' }); m.remove(); toast('Convidado excluído.', 'ok'); recarregar(); }
    catch (e) { toast(e.message, 'erro'); }
  };
};

// ═══════════ MAPA DE MESAS ═══════════

document.getElementById('form-mesas').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api(`/api/admin/eventos/${estado.eventoId}/mesas`, { method: 'POST', body: {
      quantidade: f.elements.quantidade.value,
      capacidade: f.elements.capacidade.value,
      formato: f.elements.formato.value,
    }});
    toast('Mesas criadas.', 'ok'); recarregar();
  } catch (e) { toast(e.message, 'erro'); }
});

function abrirModalMesa(mesa) {
  const ocs = estado.ocupantes.filter(o => o.mesa_id === mesa.id).sort((a, b) => (a.cadeira || 0) - (b.cadeira || 0));
  const semAssento = estado.convidados.filter(c => !c.mesa_id && c.status !== 'cancelado');
  const cadeirasLivres = Array.from({ length: mesa.capacidade }, (_, i) => i + 1)
    .filter(n => !ocs.some(o => o.cadeira === n));

  const m = abrirModal(`
    <h3>Mesa ${mesa.numero}${mesa.nome ? ' — ' + esc(mesa.nome) : ''}</h3>
    <div class="linha-flex">
      <div class="curto"><label>Número</label><input id="mm-numero" type="number" value="${mesa.numero}"></div>
      <div><label>Nome (opcional)</label><input id="mm-nome" value="${esc(mesa.nome || '')}" placeholder="Ex.: Diretoria"></div>
      <div class="curto"><label>Lugares</label><input id="mm-capacidade" type="number" min="1" value="${mesa.capacidade}"></div>
      <div class="curto"><label>Formato</label>
        <select id="mm-formato">
          <option value="redonda" ${mesa.formato === 'redonda' ? 'selected' : ''}>Redonda</option>
          <option value="retangular" ${mesa.formato === 'retangular' ? 'selected' : ''}>Retangular</option>
        </select></div>
    </div>
    <h3 style="margin-top:18px">Ocupação (${ocs.length}/${mesa.capacidade})</h3>
    ${ocs.length ? `<table class="tabela">${ocs.map(o => `
      <tr><td style="width:40px"><strong>${o.cadeira ?? '—'}</strong></td>
      <td>${esc(o.nome)}${o.empresa_nome ? ` <small style="color:var(--texto-suave)">· ${esc(o.empresa_nome)}</small>` : ''}</td>
      <td style="text-align:right"><button class="botao-mini botao-claro" data-liberar="${o.id}">Liberar</button></td></tr>`).join('')}</table>`
      : '<p style="color:var(--texto-suave)">Mesa livre.</p>'}
    ${cadeirasLivres.length && semAssento.length ? `
      <h3>Acomodar convidado</h3>
      <div class="linha-flex">
        <div><select id="mm-convidado">${semAssento.map(c =>
          `<option value="${c.id}">${esc(c.nome)}${c.empresa_nome ? ' · ' + esc(c.empresa_nome) : ''}</option>`).join('')}</select></div>
        <div class="curto"><select id="mm-cadeira">${cadeirasLivres.map(n => `<option value="${n}">Cad. ${n}</option>`).join('')}</select></div>
        <div class="curto"><button class="botao-ouro botao-mini" id="mm-acomodar">Acomodar</button></div>
      </div>` : ''}
    <div class="acoes">
      <button class="botao-perigo" id="mm-excluir">Excluir mesa</button>
      <button class="botao-claro" data-fechar>Fechar</button>
      <button class="botao-ouro" id="mm-salvar">Salvar mesa</button>
    </div>`);

  m.querySelector('#mm-salvar').onclick = async () => {
    try {
      await api(`/api/admin/mesas/${mesa.id}`, { method: 'PUT', body: {
        numero: m.querySelector('#mm-numero').value, nome: m.querySelector('#mm-nome').value,
        capacidade: m.querySelector('#mm-capacidade').value, formato: m.querySelector('#mm-formato').value,
      }});
      m.remove(); toast('Mesa salva.', 'ok'); recarregar();
    } catch (e) { toast(e.message, 'erro'); }
  };
  m.querySelector('#mm-excluir').onclick = async () => {
    try {
      await api(`/api/admin/mesas/${mesa.id}`, { method: 'DELETE' });
      m.remove(); toast('Mesa excluída (assentos liberados).', 'ok'); recarregar();
    } catch (e) { toast(e.message, 'erro'); }
  };
  m.querySelectorAll('[data-liberar]').forEach(b => b.onclick = async () => {
    try {
      await api(`/api/admin/convidados/${b.dataset.liberar}/assento`, { method: 'POST', body: { mesa_id: null } });
      m.remove(); toast('Assento liberado.', 'ok'); recarregar();
    } catch (e) { toast(e.message, 'erro'); }
  });
  const btnAcomodar = m.querySelector('#mm-acomodar');
  if (btnAcomodar) btnAcomodar.onclick = async () => {
    try {
      await api(`/api/admin/convidados/${m.querySelector('#mm-convidado').value}/assento`, {
        method: 'POST',
        body: { mesa_id: mesa.id, cadeira: Number(m.querySelector('#mm-cadeira').value) },
      });
      m.remove(); toast('Convidado acomodado.', 'ok'); recarregar();
    } catch (e) { toast(e.message, 'erro'); }
  };
}

// ═══════════ CREDENCIAMENTO ═══════════

document.getElementById('btn-checkin').onclick = () => fazerCheckin(document.getElementById('entrada-token').value);
document.getElementById('entrada-token').addEventListener('keydown', e => {
  if (e.key === 'Enter') fazerCheckin(e.target.value);
});

async function fazerCheckin(token) {
  const area = document.getElementById('resultado-checkin');
  if (!token.trim()) return;
  try {
    const r = await api('/api/admin/checkin', { method: 'POST', body: { token } });
    const c = r.convidado;
    area.innerHTML = `
      <div class="aviso-caixa ${r.repetido ? 'aviso-info' : 'aviso-ok'}" style="font-size:16px">
        ${r.repetido ? '⚠️' : '✅'} <strong>${esc(r.mensagem)}</strong><br>
        ${esc(c.empresa_nome || 'Convite individual')}${(estado.evento && estado.evento.mapa_mesas === 0) ? '' :
          ' · ' + (c.mesa_numero != null ? `Mesa ${c.mesa_numero}${c.cadeira != null ? ', Cadeira ' + c.cadeira : ''}` : 'sem mesa definida')}
      </div>`;
    document.getElementById('entrada-token').value = '';
    const checkins = await api(`/api/admin/eventos/${estado.eventoId}/checkins`);
    desenharCheckins(checkins);
  } catch (e) {
    area.innerHTML = `<div class="aviso-caixa aviso-erro" style="font-size:16px">❌ ${esc(e.message)}</div>`;
  }
}

function desenharCheckins(lista) {
  const t = document.getElementById('tabela-checkins');
  if (!lista.length) { t.innerHTML = '<tr><td>Nenhum check-in realizado ainda.</td></tr>'; return; }
  t.innerHTML = `<tr><th>Horário</th><th>Nome</th><th>Empresa</th><th>Assento</th></tr>` +
    lista.map(c => `
      <tr><td>${esc(c.checkin_em)}</td><td><strong>${esc(c.nome)}</strong></td>
      <td>${esc(c.empresa_nome || 'Individual')}</td><td>${assentoTexto(c)}</td></tr>`).join('');
}

// Leitura do QR pela câmera — BarcodeDetector nativo (Chrome/Edge) com fallback jsQR (iPhone/Safari e demais)
let leitorAtivo = false;
document.getElementById('btn-camera').onclick = async () => {
  const areaCam = document.getElementById('area-camera');
  const video = document.getElementById('video-camera');
  if (leitorAtivo) {
    leitorAtivo = false;
    areaCam.classList.add('oculto');
    (video.srcObject?.getTracks() || []).forEach(tr => tr.stop());
    video.srcObject = null;
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    // navegadores escondem a câmera fora de contexto seguro (https:// ou localhost)
    toast(window.isSecureContext
      ? 'Este navegador não permite acesso à câmera. Cole o código manualmente.'
      : 'A câmera só funciona em conexão segura: acesse o sistema pelo endereço https:// (porta 3443) e tente novamente.', 'erro');
    return;
  }
  const temNativo = 'BarcodeDetector' in window;
  const temFallback = typeof jsQR === 'function';
  if (!temNativo && !temFallback) {
    toast('Este navegador não suporta leitura de QR pela câmera. Use Chrome/Edge ou cole o código manualmente.', 'erro');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    await video.play();
    areaCam.classList.remove('oculto');
    leitorAtivo = true;
    let ultimo = '';
    const aoLer = async (valor) => {
      if (!valor || valor === ultimo) return;
      ultimo = valor;
      await fazerCheckin(valor);
      setTimeout(() => { ultimo = ''; }, 4000); // permite reler outro QR em seguida
    };
    if (temNativo) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      (async function laco() {
        while (leitorAtivo) {
          try {
            const codigos = await detector.detect(video);
            if (codigos.length) await aoLer(codigos[0].rawValue);
          } catch {}
          await new Promise(r => setTimeout(r, 400));
        }
      })();
    } else {
      // fallback: captura frames num canvas e decodifica com jsQR
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      (async function laco() {
        while (leitorAtivo) {
          try {
            if (video.videoWidth) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              ctx.drawImage(video, 0, 0);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const codigo = jsQR(img.data, img.width, img.height);
              if (codigo) await aoLer(codigo.data);
            }
          } catch {}
          await new Promise(r => setTimeout(r, 400));
        }
      })();
    }
  } catch (e) {
    toast('Não foi possível acessar a câmera: ' + e.message, 'erro');
  }
};

// ═══════════ TROCA DE SENHA ═══════════

document.getElementById('btn-trocar-senha').onclick = () => {
  const m = abrirModal(`
    <h3>Trocar minha senha</h3>
    <label>Senha atual</label><input id="ts-atual" type="password">
    <label>Nova senha (mín. 6 caracteres)</label><input id="ts-nova" type="password">
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-ouro" id="ts-salvar">Salvar</button></div>`);
  m.querySelector('#ts-salvar').onclick = async () => {
    try {
      await api('/api/trocar-senha', { method: 'POST', body: {
        senha_atual: m.querySelector('#ts-atual').value, senha_nova: m.querySelector('#ts-nova').value,
      }});
      m.remove(); toast('Senha alterada.', 'ok');
    } catch (e) { toast(e.message, 'erro'); }
  };
};
