'use strict';
// Área privativa do convidado principal

let painelDados = null;
let mapa = null;

document.getElementById('abas').addEventListener('click', e => {
  const btn = e.target.closest('button[data-secao]');
  if (!btn) return;
  document.querySelectorAll('#abas button').forEach(b => b.classList.toggle('ativa', b === btn));
  document.querySelectorAll('.secao').forEach(s => s.classList.toggle('ativa', s.id === 'secao-' + btn.dataset.secao));
});
document.getElementById('btn-sair').addEventListener('click', sair);

(async function init() {
  try {
    const eu = await api('/api/me');
    if (eu.role !== 'convidado_principal') { location.href = '/admin.html'; return; }
  } catch { return; }
  mapa = criarMapa(document.getElementById('mapa-mesas'), { editavel: false });
  await recarregar();
})();

async function recarregar() {
  painelDados = await api('/api/empresa/painel');
  const { empresa, evento, convidados, mapa: dadosMapa } = painelDados;

  document.getElementById('titulo-evento').textContent = evento.nome;
  document.getElementById('nome-empresa').innerHTML =
    `👤 ${esc(empresa.nome || empresa.username)} <em>· ${esc(empresa.empresa_nome)}</em>`;

  // Aviso de prazo
  const aviso = document.getElementById('aviso-prazo');
  if (evento.prazo_encerrado) {
    aviso.innerHTML = `<div class="aviso-caixa aviso-erro">⏰ O prazo para inscrição de convidados foi encerrado
      (${dataBr(evento.deadline)}). Para alterações, contate a organização.</div>`;
  } else {
    aviso.innerHTML = `<div class="aviso-caixa aviso-info">Você pode inscrever e editar seus convidados até
      <strong>${dataBr(evento.deadline)}</strong>. Após essa data, os convites não utilizados retornam à organização.</div>`;
  }

  // Painel do evento
  let facilities = evento.facilities;
  try { if (typeof facilities === 'string') facilities = JSON.parse(facilities || '[]'); } catch { facilities = []; }
  document.getElementById('painel-evento').innerHTML = `
    <h2>${esc(evento.nome)}</h2>
    <p>${esc(evento.descricao || '')}</p>
    <div class="bloco-info">
      📅 <strong>Data:</strong> ${dataBr(evento.data_evento)} às ${esc(evento.hora_evento)}<br>
      📍 <strong>Local:</strong> ${esc(evento.local_nome)} — ${esc(evento.endereco)}<br>
      ${evento.dress_code ? `👔 <strong>Traje:</strong> ${esc(evento.dress_code)}<br>` : ''}
      🎟️ <strong>Prazo dos convites:</strong> ${dataBr(evento.deadline)}
    </div>
    ${facilities.length ? `<h3>✨ Comodidades</h3><ul class="lista-simples">${facilities.map(f =>
      `<li><strong>${esc(f.titulo)}:</strong> ${esc(f.descricao)}</li>`).join('')}</ul>` : ''}
  `;
  document.getElementById('mapa-google').src =
    `https://www.google.com/maps?q=${encodeURIComponent(evento.local_nome + ' ' + evento.endereco)}&output=embed`;

  let hoteis = evento.hoteis;
  try { if (typeof hoteis === 'string') hoteis = JSON.parse(hoteis || '[]'); } catch { hoteis = []; }
  document.getElementById('painel-hoteis').innerHTML = hoteis.length ? `
    <h2>🏨 Hotéis próximos</h2>
    <ul class="lista-simples">${hoteis.map(h =>
      `<li><strong>${esc(h.nome)}</strong>${h.distancia ? ` (${esc(h.distancia)})` : ''}${h.endereco ? ` — ${esc(h.endereco)}` : ''}${h.telefone ? ` — ${esc(h.telefone)}` : ''}</li>`).join('')}</ul>`
    : '<h2>🏨 Hotéis próximos</h2><p>A organização ainda não informou hotéis sugeridos.</p>';

  // Cota
  document.getElementById('stats-cota').innerHTML = `
    <div class="stat destaque"><div class="valor">${empresa.cota}</div><div class="rotulo">Cota de convites</div></div>
    <div class="stat"><div class="valor">${empresa.usados}</div><div class="rotulo">Utilizados</div></div>
    <div class="stat"><div class="valor">${empresa.restantes}</div><div class="rotulo">Disponíveis</div></div>
  `;

  // Perfil
  const fp = document.getElementById('form-perfil');
  fp.elements.nome.value = empresa.nome || '';
  fp.elements.cargo.value = empresa.cargo || '';
  fp.elements.email.value = empresa.email || '';
  fp.elements.telefone.value = empresa.telefone || '';

  desenharConvidados(convidados, evento);

  // Mapa de mesas: aba visível só quando habilitado no evento
  const mapaAtivo = evento.mapa_mesas !== 0 && dadosMapa;
  const abaMapa = document.querySelector('#abas button[data-secao="mapa"]');
  abaMapa.classList.toggle('oculto', !mapaAtivo);
  if (mapaAtivo) {
    mapa.atualizar(dadosMapa.mesas, dadosMapa.ocupantes);
  } else if (document.getElementById('secao-mapa').classList.contains('ativa')) {
    document.querySelector('#abas button[data-secao="evento"]').click();
  }
}

document.getElementById('form-perfil').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api('/api/empresa/perfil', { method: 'PUT', body: {
      nome: f.elements.nome.value, cargo: f.elements.cargo.value,
      email: f.elements.email.value, telefone: f.elements.telefone.value,
    }});
    toast('Dados salvos — sua inscrição está garantida!', 'ok');
    recarregar();
  } catch (e) { toast(e.message, 'erro'); }
});

let inscrevendoConvidado = false;
document.getElementById('form-convidado').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (inscrevendoConvidado) return; // trava contra duplo clique/Enter repetido enquanto o envio roda
  inscrevendoConvidado = true;
  const f = ev.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.classList.add('carregando');
  try {
    const r = await api('/api/empresa/convidados', { method: 'POST', body: {
      nome: f.elements.nome.value, cargo: f.elements.cargo.value,
      email: f.elements.email.value, telefone: f.elements.telefone.value,
    }});
    f.reset();
    toast('Convidado inscrito!', 'ok');
    tratarEnvioAutomatico(r.envio); // convite dispara automaticamente na inscrição
    recarregar();
  } catch (e) { toast(e.message, 'erro'); }
  finally {
    inscrevendoConvidado = false;
    btn.disabled = false;
    btn.classList.remove('carregando');
  }
});

function desenharConvidados(convidados, evento) {
  const t = document.getElementById('tabela-convidados');
  if (!convidados.length) {
    t.innerHTML = '<tr><td>Nenhum convidado inscrito ainda. Comece salvando seus próprios dados acima.</td></tr>';
    return;
  }
  const podeEditar = !evento.prazo_encerrado;
  const mapaAtivo = evento.mapa_mesas !== 0;
  t.innerHTML = `<tr><th>Nome</th><th>Tipo</th><th>Contato</th>${mapaAtivo ? '<th>Assento</th>' : ''}<th>Status</th><th>Convite</th></tr>` +
    convidados.map(c => `
      <tr>
        <td><strong>${esc(c.nome)}</strong>${c.cargo ? `<br><small style="color:var(--texto-suave)">${esc(c.cargo)}</small>` : ''}</td>
        <td>${seloTipo(c.tipo)}</td>
        <td><small>${esc(c.email || '')}${c.email && c.telefone ? '<br>' : ''}${esc(c.telefone || '')}</small></td>
        ${mapaAtivo ? `<td>${assentoTexto(c)}</td>` : ''}
        <td>${seloStatus(c.status)}</td>
        <td style="white-space:nowrap">
          <button class="botao-mini botao-claro" title="Reenviar por e-mail" onclick="enviarConviteEmpresa(${c.id},'email')">✉️ Reenviar</button>
          <button class="botao-mini botao-claro" title="Reenviar por WhatsApp" onclick="enviarConviteEmpresa(${c.id},'whatsapp')">💬 Reenviar</button>
          <a class="botao botao-mini botao-claro" title="Ver convite digital" href="/convite/${esc(c.token)}" target="_blank">🎫 Ver</a>
          ${podeEditar && c.tipo !== 'responsavel' ? `
            <button class="botao-mini botao-claro" title="Editar" onclick="editarConvidadoEmpresa(${c.id})">✎</button>
            <button class="botao-mini botao-perigo" title="Excluir" onclick="excluirConvidadoEmpresa(${c.id})">✕</button>` : ''}
        </td>
      </tr>`).join('');
}

window.enviarConviteEmpresa = async (id, canal) => {
  try {
    const r = await api(`/api/empresa/convidados/${id}/enviar`, { method: 'POST', body: { canal } });
    tratarResultadoEnvio(r);
    recarregar();
  } catch (e) { toast(e.message, 'erro'); }
};

window.editarConvidadoEmpresa = (id) => {
  const c = painelDados.convidados.find(x => x.id === id);
  const m = abrirModal(`
    <h3>Editar convidado</h3>
    <label>Nome</label><input id="ee-nome" value="${esc(c.nome)}">
    <label>Cargo</label><input id="ee-cargo" value="${esc(c.cargo || '')}">
    <div class="linha-flex">
      <div><label>E-mail</label><input id="ee-email" value="${esc(c.email)}"></div>
      <div><label>Telefone/WhatsApp</label><input id="ee-telefone" value="${esc(c.telefone)}"></div>
    </div>
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-ouro" id="ee-salvar">Salvar</button></div>`);
  m.querySelector('#ee-salvar').onclick = async () => {
    try {
      const r = await api(`/api/empresa/convidados/${id}`, { method: 'PUT', body: {
        nome: m.querySelector('#ee-nome').value,
        cargo: m.querySelector('#ee-cargo').value,
        email: m.querySelector('#ee-email').value,
        telefone: m.querySelector('#ee-telefone').value,
      }});
      m.remove(); toast('Convidado atualizado.', 'ok');
      if (r.envio) {
        toast('Contato alterado — o convite foi reenviado para os novos dados.', 'ok');
        tratarEnvioAutomatico(r.envio);
      }
      recarregar();
    } catch (e) { toast(e.message, 'erro'); }
  };
};

window.excluirConvidadoEmpresa = (id) => {
  const c = painelDados.convidados.find(x => x.id === id);
  const m = abrirModal(`
    <h3>Excluir convidado?</h3>
    <p><strong>${esc(c.nome)}</strong> será removido e o convite volta a ficar disponível na sua cota.</p>
    <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
    <button class="botao-perigo" id="xx-conf">Excluir</button></div>`);
  m.querySelector('#xx-conf').onclick = async () => {
    try {
      await api(`/api/empresa/convidados/${id}`, { method: 'DELETE' });
      m.remove(); toast('Convidado excluído.', 'ok'); recarregar();
    } catch (e) { toast(e.message, 'erro'); }
  };
};

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
