'use strict';
// Módulo Mensagens (painel do organizador): criar/editar mensagens por e-mail e
// enviar para todos ou para convidados escolhidos. Usa `estado`, `api`, `esc`,
// `abrirModal`, `toast`, `seloStatus` e `dataHoraBr` definidos em admin.js / comum.js.

(function () {
  const msg = {
    lista: [],
    editandoId: null,     // null = nova mensagem
    pollTimer: null,
    previewTimer: null,
  };

  // Informações que o organizador pode inserir no texto. Internamente viram {{chave}}
  // (formato que o servidor substitui), mas na tela aparecem só como etiquetas com nome comum.
  const GRUPOS_CAMPOS = [
    ['Do convidado', [
      ['nome', 'Nome do convidado', 'Maria Silva'],
      ['empresa', 'Empresa do convidado', 'Empresa Exemplo'],
      ['cargo', 'Cargo do convidado', 'Diretora Comercial'],
      ['mesa', 'Mesa e cadeira', 'Mesa 5, Cadeira 3'],
      ['codigo', 'Código de entrada', '123456'],
    ]],
    ['Do evento', [
      ['evento', 'Nome do evento', ''],
      ['data', 'Data do evento', '15/09/2026'],
      ['hora', 'Horário', '20:00'],
      ['dias_restantes', 'Quantos dias faltam', '7'],
      ['local', 'Local', ''],
      ['endereco', 'Endereço', ''],
      ['traje', 'Traje', 'Esporte fino'],
    ]],
    ['Links', [
      ['link_confirmar', 'Link para confirmar presença', ''],
      ['link', 'Link do convite digital', ''],
    ]],
  ];
  const ROTULOS = Object.fromEntries(GRUPOS_CAMPOS.flatMap(([, campos]) => campos.map(([c, r]) => [c, r])));

  const MODELOS_PRONTOS = {
    confirmacao: {
      nome: 'Lembrete — confirmar presença',
      assunto: '{{nome}}, confirme sua presença no {{evento}}',
      corpo: `Olá, {{nome}}!

Ainda não recebemos a confirmação da sua presença no **{{evento}}**, que acontece em **{{data}} às {{hora}}**, no {{local}}.

Para nos ajudar na organização, pedimos que confirme sua presença clicando no botão abaixo — leva só alguns segundos.

Contamos com você!`,
    },
    contagem: {
      nome: 'Lembrete — faltam poucos dias',
      assunto: 'Faltam {{dias_restantes}} dias para o {{evento}}',
      corpo: `Olá, {{nome}}!

Faltam apenas **{{dias_restantes}} dias** para o **{{evento}}**.

📅 {{data}} às {{hora}}
📍 {{local}} — {{endereco}}
👔 Traje: {{traje}}

Se ainda não confirmou sua presença, use o botão abaixo. No dia, basta apresentar o QR code do seu convite digital na recepção.

Até breve!`,
    },
    vespera: {
      nome: 'Véspera — informações finais',
      assunto: 'É amanhã! Informações finais do {{evento}}',
      corpo: `Olá, {{nome}}!

Amanhã é o grande dia. Seguem as informações para a sua chegada:

📅 {{data}} às {{hora}}
📍 {{local}} — {{endereco}}
👔 Traje: {{traje}}
🪑 Seu lugar: {{mesa}}

Na recepção, apresente o QR code do seu convite digital (ou informe o código **{{codigo}}**).

Nos vemos lá!`,
    },
  };

  const $ = id => document.getElementById(id);
  const form = $('form-mensagem');
  const edAssunto = $('msg-assunto');
  const edCorpo = $('msg-corpo');

  // ── Editor visual: etiquetas no lugar de {{campo}} e negrito no lugar de **texto** ──

  function chipHtml(campo) {
    return `<span class="chip-campo" contenteditable="false" data-campo="${esc(campo)}">${esc(ROTULOS[campo] || campo)}</span>`;
  }

  // Texto interno ({{campo}}, **negrito**, \n) → HTML do editor
  function paraEditor(texto, multilinha = true) {
    let h = esc(texto || '');
    if (multilinha) h = h.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
    h = h.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, c) => chipHtml(c));
    return multilinha ? h.replace(/\n/g, '<br>') : h.replace(/\n/g, ' ');
  }

  // HTML do editor → texto interno
  function doEditor(el, multilinha = true) {
    let out = '';
    (function percorrer(no) {
      for (const n of no.childNodes) {
        if (n.nodeType === 3) { out += n.nodeValue.replace(/[ ​]/g, m => (m === ' ' ? ' ' : '')); continue; }
        if (n.nodeType !== 1) continue;
        if (n.dataset.campo) { out += `{{${n.dataset.campo}}}`; continue; }
        if (n.tagName === 'BR') { out += '\n'; continue; }
        const bloco = n.tagName === 'DIV' || n.tagName === 'P';
        if (bloco && out && !out.endsWith('\n')) out += '\n';
        const peso = n.style && n.style.fontWeight;
        const negrito = multilinha && (n.tagName === 'B' || n.tagName === 'STRONG' || peso === 'bold' || Number(peso) >= 600);
        const antes = out.length;
        if (negrito) out += '**';
        percorrer(n);
        if (negrito) { if (out.length === antes + 2) out = out.slice(0, antes); else out += '**'; }
        if (bloco && !out.endsWith('\n')) out += '\n';
      }
    })(el);
    out = out.replace(/\*\*(\s*)\*\*/g, '$1'); // negritos vizinhos/vazios
    return multilinha ? out.replace(/\s+$/, '') : out.replace(/\s+/g, ' ').trim();
  }

  function definirEditor(el, texto) {
    el.innerHTML = paraEditor(texto, el === edCorpo);
    marcarVazio(el);
  }
  function marcarVazio(el) {
    el.classList.toggle('vazio', !el.textContent.trim() && !el.querySelector('[data-campo]'));
  }

  // Guarda a posição do cursor em cada editor (o clique nos botões não pode perdê-la)
  const cursores = new Map();
  let ultimoEditor = edCorpo;
  function lembrarCursor() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    for (const ed of [edAssunto, edCorpo]) {
      if (ed.contains(r.startContainer)) { cursores.set(ed, r.cloneRange()); ultimoEditor = ed; }
    }
  }
  document.addEventListener('selectionchange', lembrarCursor);

  function inserirCampo(campo) {
    const sel = window.getSelection();
    // 1º: cursor atual, se estiver num dos editores (os botões não roubam o foco);
    // 2º: última posição guardada daquele editor; 3º: fim do texto
    const atual = sel.rangeCount ? sel.getRangeAt(0) : null;
    const edAtual = atual && [edAssunto, edCorpo].find(ed => ed.contains(atual.startContainer));
    const ed = edAtual || ultimoEditor;
    let r = edAtual ? atual : cursores.get(ed);
    ed.focus();
    if (!r || !ed.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); }
    r.deleteContents();
    const tmp = document.createElement('span');
    tmp.innerHTML = chipHtml(campo);
    const chip = tmp.firstChild;
    // caractere invisível depois da etiqueta: dá ao cursor um lugar para ficar sem forçar um espaço
    const espaco = document.createTextNode('​');
    r.insertNode(espaco);
    r.insertNode(chip);
    r.setStartAfter(espaco); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    marcarVazio(ed);
    agendarPreview();
  }

  for (const ed of [edAssunto, edCorpo]) {
    ed.addEventListener('input', () => { lembrarCursor(); marcarVazio(ed); agendarPreview(); });
    ed.addEventListener('keyup', lembrarCursor);
    ed.addEventListener('mouseup', lembrarCursor);
    ed.addEventListener('focus', () => { ultimoEditor = ed; });
    // Colar sempre como texto simples (evita trazer formatação estranha de Word/sites)
    ed.addEventListener('paste', e => {
      e.preventDefault();
      let t = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (ed === edAssunto) t = t.replace(/\s*\n\s*/g, ' ');
      document.execCommand('insertText', false, t);
    });
    // Ao sair do campo, quem colou {{algo}} vê virar etiqueta
    ed.addEventListener('blur', () => {
      if (/\{\{\s*\w+\s*\}\}|\*\*/.test(ed.textContent)) definirEditor(ed, doEditor(ed, ed === edCorpo));
    });
  }
  edAssunto.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  edCorpo.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); document.execCommand('bold'); }
  });

  const btnNegrito = $('btn-msg-negrito');
  btnNegrito.addEventListener('mousedown', e => e.preventDefault()); // mantém a seleção do texto
  btnNegrito.addEventListener('click', () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || !edCorpo.contains(sel.anchorNode) || sel.isCollapsed) {
      toast('Primeiro selecione (marque com o mouse) o trecho da mensagem que quer em negrito.', 'erro');
      return;
    }
    document.execCommand('bold');
    agendarPreview();
  });

  // Versão legível de um texto interno (para listas): {{nome}} → [Nome do convidado]
  function legivel(texto) {
    return String(texto || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, c) => `[${ROTULOS[c] || c}]`);
  }
  const url = sufixo => `/api/admin/eventos/${estado.eventoId}/mensagens${sufixo || ''}`;

  // ── Carregamento da aba ──
  window.carregarMensagens = async function () {
    if (!estado.eventoId) return;
    try {
      const [lista, disparos, status] = await Promise.all([
        api(url()), api(url('/disparos')), api(url('/disparo/status')),
      ]);
      msg.lista = lista;
      desenharLista();
      desenharHistorico(disparos);
      desenharProgresso(status);
      if (status.processando) iniciarPolling();
      preencherConvidadosPreview();
    } catch (e) { toast(e.message, 'erro'); }
  };

  function desenharLista() {
    const t = $('tabela-mensagens');
    if (!msg.lista.length) {
      t.innerHTML = '<tr><td>Nenhuma mensagem criada ainda. Clique em “+ Nova mensagem” — há modelos prontos para começar.</td></tr>';
      return;
    }
    t.innerHTML = `<tr><th>Mensagem</th><th>Assunto</th><th>Último envio</th><th>E-mails enviados</th><th>Ações</th></tr>` +
      msg.lista.map(m => `
        <tr>
          <td><strong>${esc(m.nome)}</strong><br><small style="color:var(--texto-suave)">editada em ${dataHoraBr(m.atualizado_em)}</small></td>
          <td>${esc(legivel(m.assunto))}</td>
          <td>${m.ultimo_disparo ? dataHoraBr(m.ultimo_disparo) : '<small style="color:var(--texto-suave)">nunca enviada</small>'}</td>
          <td>${m.total_enviados || 0}</td>
          <td style="white-space:nowrap">
            <button class="botao-mini botao-ouro" title="Escolher destinatários e enviar" onclick="msgEnviar(${m.id})">Enviar</button>
            <button class="botao-mini botao-claro" title="Editar" onclick="msgEditar(${m.id})">✎</button>
            <button class="botao-mini botao-claro" title="Duplicar" onclick="msgDuplicar(${m.id})">⧉</button>
            <button class="botao-mini botao-perigo" title="Excluir" onclick="msgExcluir(${m.id})">✕</button>
          </td>
        </tr>`).join('');
  }

  function desenharHistorico(lista) {
    const t = $('tabela-disparos');
    if (!lista.length) { t.innerHTML = '<tr><td>Nenhuma mensagem enviada ainda.</td></tr>'; return; }
    const situacoes = {
      andamento: '<span class="selo selo-enviado">Enviando…</span>',
      concluido: '<span class="selo selo-confirmado">Concluído</span>',
      interrompido: '<span class="selo selo-cancelado">Interrompido</span>',
    };
    t.innerHTML = `<tr><th>Data</th><th>Mensagem</th><th>Enviados</th><th>Falhas</th><th>Situação</th><th></th></tr>` +
      lista.map(d => `
        <tr>
          <td>${dataHoraBr(d.iniciado_em)}<br><small style="color:var(--texto-suave)">${esc(d.criado_por)}</small></td>
          <td><strong>${esc(d.mensagem_nome)}</strong><br><small style="color:var(--texto-suave)">${esc(legivel(d.assunto))}</small></td>
          <td>${d.enviados} de ${d.total}${d.sem_email ? `<br><small style="color:var(--texto-suave)">${d.sem_email} sem e-mail</small>` : ''}</td>
          <td>${d.falhas || 0}</td>
          <td>${situacoes[d.situacao] || esc(d.situacao)}</td>
          <td><button class="botao-mini botao-claro" onclick="msgDetalhesDisparo(${d.id})">Detalhes</button></td>
        </tr>`).join('');
  }

  // ── Editor ──
  $('msg-campos-lista').innerHTML = GRUPOS_CAMPOS.map(([grupo, campos]) => `
    <div class="msg-grupo-campos"><span class="msg-grupo-rotulo">${grupo}:</span>
      <div class="msg-grupo-botoes">${campos.map(([c, rot, ex]) =>
        `<button type="button" class="msg-campo" data-campo="${c}" ${ex ? `title="Ex.: ${esc(ex)}"` : ''}>+ ${esc(rot)}</button>`).join('')}</div>
    </div>`).join('');
  // mousedown sem foco: o cursor continua onde o organizador clicou no texto
  $('msg-campos-lista').addEventListener('mousedown', e => { if (e.target.closest('[data-campo]')) e.preventDefault(); });
  $('msg-campos-lista').addEventListener('click', e => {
    const b = e.target.closest('[data-campo]');
    if (b) inserirCampo(b.dataset.campo);
  });

  function abrirEditor(m) {
    msg.editandoId = m?.id ?? null;
    $('msg-editor-titulo').textContent = msg.editandoId ? 'Editar mensagem' : 'Nova mensagem';
    $('msg-modelo-pronto-campo').classList.toggle('oculto', !!msg.editandoId);
    $('msg-modelo-pronto').value = '';
    form.elements.nome.value = m?.nome || '';
    definirEditor(edAssunto, m?.assunto || '');
    definirEditor(edCorpo, m?.corpo || '');
    form.elements.incluir_botoes.checked = m ? m.incluir_botoes !== 0 : true;
    $('msg-painel-editor').classList.remove('oculto');
    $('msg-painel-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    atualizarPreview();
  }

  function fecharEditor() {
    $('msg-painel-editor').classList.add('oculto');
    msg.editandoId = null;
  }

  $('btn-nova-mensagem').onclick = () => abrirEditor(null);
  $('btn-msg-cancelar').onclick = fecharEditor;

  $('msg-modelo-pronto').onchange = e => {
    const p = MODELOS_PRONTOS[e.target.value];
    if (!p) return;
    const temTexto = doEditor(edCorpo) || doEditor(edAssunto, false);
    if (temTexto && !confirm('Substituir o texto atual pelo modelo escolhido?')) { e.target.value = ''; return; }
    form.elements.nome.value = p.nome;
    definirEditor(edAssunto, p.assunto);
    definirEditor(edCorpo, p.corpo);
    atualizarPreview();
  };

  window.msgEditar = id => abrirEditor(msg.lista.find(m => m.id === id));
  window.msgDuplicar = id => {
    const m = msg.lista.find(x => x.id === id);
    abrirEditor({ ...m, id: null, nome: m.nome + ' (cópia)' });
  };
  window.msgExcluir = id => {
    const m = msg.lista.find(x => x.id === id);
    const modal = abrirModal(`
      <h3>Excluir mensagem?</h3>
      <p><strong>${esc(m.nome)}</strong> será excluída. O histórico de envios dela continua disponível.</p>
      <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
      <button class="botao-perigo" id="mx-conf">Excluir</button></div>`);
    modal.querySelector('#mx-conf').onclick = async () => {
      try {
        await api(`/api/admin/mensagens/${id}`, { method: 'DELETE' });
        modal.remove();
        if (msg.editandoId === id) fecharEditor();
        toast('Mensagem excluída.', 'ok');
        carregarMensagens();
      } catch (e) { toast(e.message, 'erro'); }
    };
  };

  function dadosForm() {
    return {
      nome: form.elements.nome.value, assunto: doEditor(edAssunto, false),
      corpo: doEditor(edCorpo), incluir_botoes: form.elements.incluir_botoes.checked,
    };
  }

  function validarEditor() {
    const d = dadosForm();
    if (!d.nome.trim()) { toast('Dê um nome para a mensagem (só você vê — ex.: "Lembrete 7 dias antes").', 'erro'); form.elements.nome.focus(); return false; }
    if (!d.assunto) { toast('Escreva o assunto do e-mail.', 'erro'); edAssunto.focus(); return false; }
    if (!d.corpo) { toast('Escreva o texto da mensagem.', 'erro'); edCorpo.focus(); return false; }
    return true;
  }

  async function salvar() {
    const dados = dadosForm();
    if (msg.editandoId) {
      await api(`/api/admin/mensagens/${msg.editandoId}`, { method: 'PUT', body: dados });
    } else {
      const r = await api(url(), { method: 'POST', body: dados });
      msg.editandoId = r.id;
      $('msg-editor-titulo').textContent = 'Editar mensagem';
      $('msg-modelo-pronto-campo').classList.add('oculto');
    }
    await carregarMensagens();
    return msg.editandoId;
  }

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (!validarEditor()) return;
    try { await salvar(); toast('Mensagem salva.', 'ok'); } catch (e) { toast(e.message, 'erro'); }
  });

  $('btn-msg-salvar-enviar').onclick = async () => {
    if (!validarEditor()) return;
    try { const id = await salvar(); abrirSelecaoDestinatarios(id); } catch (e) { toast(e.message, 'erro'); }
  };

  $('btn-msg-teste').onclick = async () => {
    if (!validarEditor()) return;
    const btn = $('btn-msg-teste');
    btn.disabled = true; btn.classList.add('carregando');
    try {
      const r = await api(url('/teste'), { method: 'POST', body: dadosForm() });
      toast(r.mensagem, 'ok');
    } catch (e) { toast(e.message, 'erro'); }
    finally { btn.disabled = false; btn.classList.remove('carregando'); }
  };

  // ── Pré-visualização ──
  function preencherConvidadosPreview() {
    const sel = $('msg-preview-convidado');
    const atual = sel.value;
    const ativos = estado.convidados.filter(c => c.status !== 'cancelado');
    sel.innerHTML = ativos.length
      ? ativos.map(c => `<option value="${c.id}">Ver como: ${esc(c.nome)}</option>`).join('')
      : '<option value="">Convidado de exemplo</option>';
    if (atual && ativos.some(c => String(c.id) === atual)) sel.value = atual;
  }
  $('msg-preview-convidado').onchange = () => atualizarPreview();

  function agendarPreview() {
    clearTimeout(msg.previewTimer);
    msg.previewTimer = setTimeout(atualizarPreview, 450);
  }
  ['input', 'change'].forEach(ev => form.addEventListener(ev, agendarPreview));

  async function atualizarPreview() {
    if ($('msg-painel-editor').classList.contains('oculto')) return;
    try {
      const r = await api(url('/preview'), { method: 'POST', body: {
        ...dadosForm(), convidado_id: Number($('msg-preview-convidado').value) || null,
      }});
      $('msg-preview-assunto').textContent = r.assunto ? 'Assunto: ' + r.assunto : '(sem assunto)';
      $('msg-preview-frame').srcdoc = r.html;
    } catch (e) { /* silencioso: pré-visualização não deve atrapalhar a digitação */ }
  }

  // ── Escolha de destinatários e disparo ──
  window.msgEnviar = id => abrirSelecaoDestinatarios(id);

  function abrirSelecaoDestinatarios(mensagemId) {
    const m = msg.lista.find(x => x.id === mensagemId);
    const ativos = estado.convidados.filter(c => c.status !== 'cancelado');
    if (!ativos.length) { toast('Este evento ainda não tem convidados.', 'erro'); return; }
    const selecionados = new Set();
    let filtroStatus = 'todos';

    const FILTROS = {
      todos: { rotulo: 'Todos', teste: () => true },
      nao_confirmados: { rotulo: 'Não confirmados', teste: c => c.status === 'pendente' || c.status === 'enviado' },
      confirmados: { rotulo: 'Confirmados', teste: c => c.status === 'confirmado' },
      checkin: { rotulo: 'Fizeram check-in', teste: c => c.status === 'checkin' },
    };

    const modal = abrirModal(`
      <h3>Enviar “${esc(m.nome)}”</h3>
      <p>Clique num filtro rápido para selecionar o grupo inteiro (ex.: todos os que ainda não confirmaram)
      ou marque os convidados um a um. Cada convidado recebe um e-mail individual.</p>
      <div class="msg-filtros" id="ds-filtros">
        ${Object.entries(FILTROS).map(([k, f]) =>
          `<button type="button" class="botao-mini ${k === 'todos' ? 'botao-ouro' : 'botao-claro'}" data-filtro="${k}">${f.rotulo} (${ativos.filter(f.teste).length})</button>`).join('')}
      </div>
      <input id="ds-busca" placeholder="Buscar por nome, empresa ou e-mail…" style="margin-top:10px">
      <div class="msg-sel-acoes">
        <label class="msg-check" style="margin:0"><input type="checkbox" id="ds-todos"> Marcar todos da lista</label>
        <span id="ds-contador"></span>
      </div>
      <div class="lista-destinatarios" id="ds-lista"></div>
      <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
      <button class="botao-ouro" id="ds-enviar" disabled>Enviar</button></div>`);
    modal.querySelector('.modal').style.maxWidth = '680px';

    const lista = modal.querySelector('#ds-lista');
    const busca = modal.querySelector('#ds-busca');

    function visiveis() {
      const q = busca.value.trim().toLowerCase();
      return ativos.filter(FILTROS[filtroStatus].teste).filter(c =>
        !q || [c.nome, c.empresa_nome, c.email].join(' ').toLowerCase().includes(q));
    }

    function desenhar() {
      const vis = visiveis();
      lista.innerHTML = vis.length ? vis.map(c => {
        const semEmail = !String(c.email || '').trim();
        return `<label class="item-destinatario ${semEmail ? 'desabilitado' : ''}">
          <input type="checkbox" data-id="${c.id}" ${selecionados.has(c.id) ? 'checked' : ''} ${semEmail ? 'disabled' : ''}>
          <span class="dest-info"><strong>${esc(c.nome)}</strong>
            <small>${esc(c.empresa_nome || 'Individual')} · ${semEmail ? '<em>sem e-mail cadastrado</em>' : esc(c.email)}</small></span>
          ${seloStatus(c.status)}
        </label>`;
      }).join('') : '<p style="padding:12px">Nenhum convidado neste filtro.</p>';
      const elegiveis = vis.filter(c => String(c.email || '').trim());
      const todos = modal.querySelector('#ds-todos');
      todos.checked = elegiveis.length > 0 && elegiveis.every(c => selecionados.has(c.id));
      todos.disabled = !elegiveis.length;
      atualizarContador();
    }

    function atualizarContador() {
      const n = selecionados.size;
      modal.querySelector('#ds-contador').textContent = `${n} selecionado(s)`;
      const btn = modal.querySelector('#ds-enviar');
      btn.disabled = !n;
      btn.textContent = n ? `Enviar para ${n} convidado(s)` : 'Enviar';
    }

    modal.querySelector('#ds-filtros').onclick = e => {
      const b = e.target.closest('[data-filtro]');
      if (!b) return;
      filtroStatus = b.dataset.filtro;
      modal.querySelectorAll('#ds-filtros [data-filtro]').forEach(x => {
        x.classList.toggle('botao-ouro', x === b); x.classList.toggle('botao-claro', x !== b);
      });
      // Trocar o filtro rápido já seleciona o grupo inteiro — atalho para o envio em massa
      selecionados.clear();
      visiveis().filter(c => String(c.email || '').trim()).forEach(c => selecionados.add(c.id));
      desenhar();
    };
    busca.oninput = desenhar;
    lista.onchange = e => {
      const cb = e.target.closest('input[data-id]');
      if (!cb) return;
      const id = Number(cb.dataset.id);
      cb.checked ? selecionados.add(id) : selecionados.delete(id);
      desenhar();
    };
    modal.querySelector('#ds-todos').onchange = e => {
      visiveis().filter(c => String(c.email || '').trim()).forEach(c => e.target.checked ? selecionados.add(c.id) : selecionados.delete(c.id));
      desenhar();
    };

    modal.querySelector('#ds-enviar').onclick = () => {
      const n = selecionados.size;
      const minutos = Math.max(1, Math.ceil(n * 2 / 60));
      const conf = abrirModal(`
        <h3>Confirmar envio?</h3>
        <p>A mensagem <strong>${esc(m.nome)}</strong> será enviada por e-mail para
        <strong>${n}</strong> convidado(s).</p>
        <p>Os e-mails saem com um pequeno intervalo entre eles para não serem bloqueados pelo provedor
        ${n > 30 ? `(estimativa: cerca de <strong>${minutos} min</strong>)` : ''}. Você pode continuar usando o
        sistema enquanto isso.</p>
        <div class="acoes"><button class="botao-claro" data-fechar>Voltar</button>
        <button class="botao-ouro" id="dc-conf">Enviar agora</button></div>`);
      conf.querySelector('#dc-conf').onclick = async () => {
        const btn = conf.querySelector('#dc-conf');
        btn.disabled = true; btn.classList.add('carregando');
        try {
          const r = await api(`/api/admin/mensagens/${mensagemId}/disparar`, { method: 'POST', body: { convidado_ids: [...selecionados] } });
          conf.remove(); modal.remove();
          toast(`Envio iniciado para ${r.total} convidado(s).`, 'ok');
          carregarMensagens();
        } catch (e) {
          toast(e.message, 'erro');
          btn.disabled = false; btn.classList.remove('carregando');
        }
      };
    };

    desenhar();
  }

  // ── Progresso do envio em andamento ──
  function desenharProgresso(p) {
    const el = $('msg-progresso');
    if (!p || p.nenhum) { el.classList.add('oculto'); return; }
    el.classList.remove('oculto');
    const pct = p.total ? Math.round(p.feitos / p.total * 100) : 0;
    if (p.processando) {
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="margin:0">Enviando “${esc(p.mensagem_nome)}”…</h2>
          <button type="button" class="botao-mini botao-perigo" id="btn-msg-interromper">Interromper envio</button>
        </div>
        <p>${p.feitos} de ${p.total} processados · ${p.enviados} enviados${p.falhas.length ? ` · ${p.falhas.length} falha(s)` : ''}</p>
        <div class="msg-barra"><div style="width:${pct}%"></div></div>`;
      $('btn-msg-interromper').onclick = async () => {
        try { await api(url('/disparo/interromper'), { method: 'POST' }); toast('Interrompendo o envio…', 'ok'); }
        catch (e) { toast(e.message, 'erro'); }
      };
    } else {
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="margin:0">${p.motivo_parada ? '⚠️ Envio interrompido' : '✅ Envio concluído'} — “${esc(p.mensagem_nome)}”</h2>
          <button type="button" class="botao-mini botao-claro" id="btn-msg-fechar-progresso">Fechar</button>
        </div>
        <p><strong>${p.enviados}</strong> de <strong>${p.total}</strong> e-mail(s) enviados.</p>
        ${p.motivo_parada ? `<p class="aviso-caixa aviso-info">${esc(p.motivo_parada)}</p>` : ''}
        ${p.sem_email.length ? `<p>⚠️ ${p.sem_email.length} selecionado(s) sem e-mail cadastrado: ${esc(p.sem_email.join(', '))}.</p>` : ''}
        ${p.falhas.length ? `<p>❌ ${p.falhas.length} falha(s): ${esc(p.falhas.slice(0, 10).map(f => `${f.nome} (${f.erro})`).join('; '))}${p.falhas.length > 10 ? '…' : ''}</p>` : ''}`;
      $('btn-msg-fechar-progresso').onclick = () => el.classList.add('oculto');
    }
  }

  function iniciarPolling() {
    if (msg.pollTimer) return;
    const eventoDoPoll = estado.eventoId;
    msg.pollTimer = setInterval(async () => {
      try {
        if (estado.eventoId !== eventoDoPoll) throw new Error('evento trocado');
        const p = await api(url('/disparo/status'));
        desenharProgresso(p);
        if (!p.processando) {
          pararPolling();
          carregarMensagens();
        }
      } catch { pararPolling(); }
    }, 1500);
  }
  function pararPolling() { clearInterval(msg.pollTimer); msg.pollTimer = null; }

  // ── Detalhes de um disparo ──
  window.msgDetalhesDisparo = async id => {
    try {
      const d = await api(`/api/admin/disparos/${id}`);
      abrirModal(`
        <h3>${esc(d.mensagem_nome)}</h3>
        <p>${esc(legivel(d.assunto))}<br>Enviado em ${dataHoraBr(d.iniciado_em)} por ${esc(d.criado_por)} ·
        <strong>${d.enviados}</strong> de ${d.total} enviados${d.sem_email ? ` · ${d.sem_email} sem e-mail` : ''}</p>
        <div class="lista-destinatarios">
          ${d.destinatarios.length ? d.destinatarios.map(x => `
            <div class="item-destinatario">
              <span class="dest-info"><strong>${esc(x.nome)}</strong><small>${esc(x.destino)}</small></span>
              ${x.status === 'enviado'
                ? '<span class="selo selo-confirmado">Enviado</span>'
                : `<span class="selo selo-cancelado" title="${esc(x.status)}">Falhou</span>`}
            </div>`).join('') : '<p style="padding:12px">Nenhum e-mail registrado.</p>'}
        </div>
        <div class="acoes"><button class="botao-ouro" data-fechar>Fechar</button></div>`)
        .querySelector('.modal').style.maxWidth = '640px';
    } catch (e) { toast(e.message, 'erro'); }
  };
})();
