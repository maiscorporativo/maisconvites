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

  // Espaço não separável (o navegador o coloca ao digitar espaços) e caractere invisível
  // que deixamos depois de cada etiqueta para o cursor ter onde ficar
  const NBSP = String.fromCharCode(0xa0);
  const ZW = String.fromCharCode(0x200b);
  const INVISIVEIS = new RegExp('[' + NBSP + ZW + ']', 'g');

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
        if (n.nodeType === 3) { out += n.nodeValue.replace(INVISIVEIS, m => (m === NBSP ? ' ' : '')); continue; }
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
    const espaco = document.createTextNode(ZW);
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
      const [lista, disparos, status, wa] = await Promise.all([
        api(url()), api(url('/disparos')), api(url('/disparo/status')), api(url('/whatsapp?leve=1')),
      ]);
      msg.lista = lista;
      desenharLista();
      desenharHistorico(disparos);
      desenharProgresso(status);
      if (status.processando) iniciarPolling();
      desenharProgressoWa(wa);
      if (wa.ativo) iniciarPollingWa();
      preencherConvidadosPreview();
    } catch (e) { toast(e.message, 'erro'); }
  };

  function desenharLista() {
    const t = $('tabela-mensagens');
    if (!msg.lista.length) {
      t.innerHTML = '<tr><td>Nenhuma mensagem criada ainda. Clique em “+ Nova mensagem” — há modelos prontos para começar.</td></tr>';
      return;
    }
    t.innerHTML = `<tr><th>Mensagem</th><th>Assunto</th><th>Último envio</th><th>Enviados</th><th>Ações</th></tr>` +
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
      pausado: '<span class="selo selo-individual">Pausado</span>',
      cancelado: '<span class="selo selo-cancelado">Cancelado</span>',
    };
    t.innerHTML = `<tr><th>Data</th><th>Canal</th><th>Mensagem</th><th>Enviados</th><th>Falhas</th><th>Situação</th><th></th></tr>` +
      lista.map(d => `
        <tr>
          <td>${dataHoraBr(d.iniciado_em)}<br><small style="color:var(--texto-suave)">${esc(d.criado_por)}</small></td>
          <td>${d.canal === 'whatsapp' ? '💬 WhatsApp' : '✉️ E-mail'}</td>
          <td><strong>${esc(d.mensagem_nome)}</strong>${d.canal === 'whatsapp' ? '' : `<br><small style="color:var(--texto-suave)">${esc(legivel(d.assunto))}</small>`}</td>
          <td>${d.enviados} de ${d.total}${d.sem_email ? `<br><small style="color:var(--texto-suave)">${d.sem_email} sem ${d.canal === 'whatsapp' ? 'telefone' : 'e-mail'}</small>` : ''}</td>
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

  // Abas da pré-visualização: como fica no e-mail e como fica no WhatsApp
  $('msg-preview-abas').addEventListener('click', e => {
    const b = e.target.closest('[data-aba]');
    if (!b) return;
    const wa = b.dataset.aba === 'whatsapp';
    $('msg-preview-abas').querySelectorAll('[data-aba]').forEach(x => x.classList.toggle('ativa', x === b));
    $('msg-preview-email').classList.toggle('oculto', wa);
    $('msg-preview-wa').classList.toggle('oculto', !wa);
  });

  // Formatação do WhatsApp para a pré-visualização: *negrito* e links
  function formatarWhatsapp(t) {
    return esc(t)
      .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a>$1</a>')
      .replace(/\n/g, '<br>');
  }

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
      $('msg-preview-wa-balao').innerHTML = formatarWhatsapp(r.texto_whatsapp || '');
    } catch (e) { /* silencioso: pré-visualização não deve atrapalhar a digitação */ }
  }

  // ── Escolha de destinatários e disparo ──
  window.msgEnviar = id => abrirSelecaoDestinatarios(id);

  // Mesmo critério do servidor: 55 + DDD + 8/9 dígitos
  function numeroWhatsapp(tel) {
    let d = String(tel || '').replace(/\D/g, '');
    if (d && !d.startsWith('55') && d.length <= 11) d = '55' + d;
    return d.length >= 12 && d.length <= 13 ? d : '';
  }

  const RITMOS = {
    cauteloso: { rotulo: 'Cauteloso', desc: 'Mais seguro. Recomendado para números novos ou listas grandes.' },
    moderado: { rotulo: 'Moderado', desc: 'Um pouco mais rápido. Para números já usados há tempo.' },
    personalizado: { rotulo: 'Personalizado', desc: 'Você define cada regra.' },
  };

  // Estimativa de duração do envio segmentado (aproximada: usa a média dos intervalos)
  function estimarWhatsapp(n, cfg) {
    const min = h => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
    const janela = (min(cfg.hora_fim) - min(cfg.hora_inicio)) * 60;
    const intervalo = (cfg.intervalo_min + cfg.intervalo_max) / 2;
    const pausa = (cfg.pausa_lote_min + cfg.pausa_lote_max) / 2 * 60;
    const duracao = k => k * intervalo + Math.floor(Math.max(0, k - 1) / cfg.lote) * pausa;
    let resta = n, dias = 0, ultimo = 0;
    while (resta > 0 && dias < 365) {
      let k = Math.min(resta, cfg.limite_diario);
      while (k > 1 && duracao(k) > janela) k--;
      ultimo = duracao(k); resta -= k; dias++;
    }
    const hm = s => { const h = Math.floor(s / 3600), m = Math.max(1, Math.round(s % 3600 / 60)); return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`; };
    return dias <= 1 ? `cerca de ${hm(ultimo)}` : `cerca de ${dias} dias (até ${cfg.limite_diario} mensagens por dia, das ${cfg.hora_inicio} às ${cfg.hora_fim})`;
  }

  async function abrirSelecaoDestinatarios(mensagemId) {
    const m = msg.lista.find(x => x.id === mensagemId);
    const ativos = estado.convidados.filter(c => c.status !== 'cancelado');
    if (!ativos.length) { toast('Este evento ainda não tem convidados.', 'erro'); return; }
    const selecionados = new Set();
    let filtroStatus = 'todos';
    let canal = 'email';
    let ritmo = 'cauteloso';
    let infoWa = null; // conexão / envio ativo / ritmos predefinidos (carregado ao escolher WhatsApp)

    const FILTROS = {
      todos: { rotulo: 'Todos', teste: () => true },
      nao_confirmados: { rotulo: 'Não confirmados', teste: c => c.status === 'pendente' || c.status === 'enviado' },
      confirmados: { rotulo: 'Confirmados', teste: c => c.status === 'confirmado' },
      checkin: { rotulo: 'Fizeram check-in', teste: c => c.status === 'checkin' },
    };
    // canal: 'email' | 'whatsapp' | 'ambos' (cada convidado recebe pelos canais que tiver cadastrados)
    const usaEmail = () => canal !== 'whatsapp';
    const usaWa = () => canal !== 'email';
    const temEmail = c => !!String(c.email || '').trim();
    const temWa = c => !!numeroWhatsapp(c.telefone);
    const elegivel = c => (usaEmail() && temEmail(c)) || (usaWa() && temWa(c));
    const idsSelecionados = teste => [...selecionados].filter(id => teste(ativos.find(c => c.id === id)));

    const modal = abrirModal(`
      <h3>Enviar “${esc(m.nome)}”</h3>
      <div class="msg-canais" id="ds-canais">
        <span>Enviar por:</span>
        <button type="button" class="botao-mini botao-ouro" data-canal="email">✉️ E-mail</button>
        <button type="button" class="botao-mini botao-claro" data-canal="whatsapp">💬 WhatsApp</button>
        <button type="button" class="botao-mini botao-claro" data-canal="ambos">✉️ + 💬 E-mail e WhatsApp</button>
      </div>
      <div id="ds-wa" class="msg-wa oculto"></div>
      <p id="ds-explica"></p>
      <div class="msg-filtros" id="ds-filtros">
        ${Object.entries(FILTROS).map(([k, f]) =>
          `<button type="button" class="botao-mini ${k === 'todos' ? 'botao-ouro' : 'botao-claro'}" data-filtro="${k}">${f.rotulo} (${ativos.filter(f.teste).length})</button>`).join('')}
      </div>
      <input id="ds-busca" placeholder="Buscar por nome, empresa, e-mail ou telefone…" style="margin-top:10px">
      <div class="msg-sel-acoes">
        <label class="msg-check" style="margin:0"><input type="checkbox" id="ds-todos"> <span>Marcar todos da lista</span></label>
        <span id="ds-contador"></span>
      </div>
      <div class="lista-destinatarios" id="ds-lista"></div>
      <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button>
      <button class="botao-ouro" id="ds-enviar" disabled>Enviar</button></div>`);
    modal.querySelector('.modal').style.maxWidth = '720px';

    const lista = modal.querySelector('#ds-lista');
    const busca = modal.querySelector('#ds-busca');
    const caixaWa = modal.querySelector('#ds-wa');

    function visiveis() {
      const q = textoBusca(busca.value).trim();
      return ativos.filter(FILTROS[filtroStatus].teste).filter(c =>
        !q || textoBusca(c.nome, c.empresa_nome, c.email, c.telefone).includes(q));
    }

    function desenhar() {
      const base = 'Clique num filtro rápido para selecionar o grupo inteiro ou marque os convidados um a um. ';
      modal.querySelector('#ds-explica').textContent = base + ({
        email: 'Cada convidado recebe um e-mail individual.',
        whatsapp: 'Convidados com o mesmo número recebem uma mensagem só.',
        ambos: 'Cada convidado recebe pelos canais que tiver cadastrados: e-mail, WhatsApp ou os dois. O e-mail sai na hora; o WhatsApp segue o ritmo de envio abaixo.',
      })[canal];
      const vis = visiveis();
      lista.innerHTML = vis.length ? vis.map(c => {
        const ok = elegivel(c);
        const semContato = canal === 'email' ? 'sem e-mail cadastrado'
          : canal === 'whatsapp' ? (c.telefone ? 'telefone inválido' : 'sem telefone cadastrado')
          : 'sem e-mail e sem telefone válido';
        const contatos = canal === 'email' ? esc(c.email) : canal === 'whatsapp' ? esc(c.telefone)
          : [temEmail(c) ? '✉️ ' + esc(c.email) : '', temWa(c) ? '💬 ' + esc(c.telefone) : ''].filter(Boolean).join(' · ');
        return `<label class="item-destinatario ${ok ? '' : 'desabilitado'}">
          <input type="checkbox" data-id="${c.id}" ${selecionados.has(c.id) ? 'checked' : ''} ${ok ? '' : 'disabled'}>
          <span class="dest-info"><strong>${esc(c.nome)}</strong>
            <small>${esc(c.empresa_nome || 'Individual')} · ${ok ? contatos : `<em>${semContato}</em>`}</small></span>
          ${seloStatus(c.status)}
        </label>`;
      }).join('') : '<p style="padding:12px">Nenhum convidado neste filtro.</p>';
      const elegiveis = vis.filter(elegivel);
      const todos = modal.querySelector('#ds-todos');
      todos.checked = elegiveis.length > 0 && elegiveis.every(c => selecionados.has(c.id));
      todos.disabled = !elegiveis.length;
      atualizarContador();
    }

    function configRitmo() {
      if (ritmo !== 'personalizado') return { preset: ritmo, ...infoWa.presets[ritmo] };
      const v = nome => caixaWa.querySelector(`[name="${nome}"]`).value;
      const n = nome => Number(v(nome));
      return {
        preset: 'personalizado',
        intervalo_min: n('intervalo_min'), intervalo_max: n('intervalo_max'),
        lote: n('lote'), pausa_lote_min: n('pausa_lote_min'), pausa_lote_max: n('pausa_lote_max'),
        limite_diario: n('limite_diario'), hora_inicio: v('hora_inicio'), hora_fim: v('hora_fim'),
      };
    }

    function regra(rotulo, valor) { return `<div class="msg-regra"><span>${rotulo}</span><span>${valor}</span></div>`; }
    function campo(nome, valor, tipo = 'number') {
      if (ritmo !== 'personalizado') return `<strong>${esc(valor)}</strong>`;
      return `<input name="${nome}" type="${tipo}" value="${esc(valor)}" ${tipo === 'number' ? 'min="1"' : ''} class="msg-regra-campo ${tipo === 'time' ? 'hora' : ''}">`;
    }

    function desenharWa() {
      if (!usaWa()) { caixaWa.classList.add('oculto'); return; }
      caixaWa.classList.remove('oculto');
      if (!infoWa) { caixaWa.innerHTML = '<p>Verificando o WhatsApp…</p>'; return; }
      if (!infoWa.disponivel) {
        caixaWa.innerHTML = '<p class="aviso-caixa aviso-erro">O servidor de WhatsApp não está configurado neste sistema.</p>';
        return;
      }
      const conexao = infoWa.conectado
        ? '<p class="aviso-caixa aviso-ok">✅ WhatsApp conectado.</p>'
        : '<p class="aviso-caixa aviso-erro">⚠️ O WhatsApp não está conectado. Conecte o número na aba <strong>Envio</strong> antes de enviar — sem conexão, o envio fica pausado.</p>';
      const ativo = infoWa.ativo
        ? `<p class="aviso-caixa aviso-erro">Já existe um envio por WhatsApp em andamento (“${esc(infoWa.ativo.mensagem_nome)}”). Para proteger o número, só um envio por WhatsApp acontece por vez.</p>`
        : '';
      // ao entrar no Personalizado, parte dos valores do Cauteloso
      const base = ritmo === 'personalizado' ? { ...infoWa.presets.cauteloso } : infoWa.presets[ritmo];
      caixaWa.innerHTML = `
        ${conexao}${ativo}
        <h4>Ritmo de envio <small>(proteção contra bloqueio do número)</small></h4>
        <p class="msg-wa-explica">O WhatsApp bloqueia números que mandam muitas mensagens seguidas. Por isso o sistema envia
        aos poucos, como uma pessoa faria: com intervalos variados, em lotes com pausas, até um limite por dia e só no horário
        permitido. Se o horário acabar ou o limite for atingido, <strong>o envio continua sozinho no dia seguinte</strong>.</p>
        <div class="msg-ritmos">
          ${Object.entries(RITMOS).map(([k, r]) => `
            <label class="msg-ritmo ${ritmo === k ? 'ativo' : ''}">
              <input type="radio" name="ritmo" value="${k}" ${ritmo === k ? 'checked' : ''}>
              <span><strong>${r.rotulo}${k === 'cauteloso' ? ' (recomendado)' : ''}</strong><small>${r.desc}</small></span>
            </label>`).join('')}
        </div>
        <div class="msg-regras">
          ${regra('Esperar entre uma mensagem e outra', `de ${campo('intervalo_min', base.intervalo_min)} a ${campo('intervalo_max', base.intervalo_max)} segundos`)}
          ${regra('Mensagens por lote', `${campo('lote', base.lote)} mensagens`)}
          ${regra('Pausa depois de cada lote', `de ${campo('pausa_lote_min', base.pausa_lote_min)} a ${campo('pausa_lote_max', base.pausa_lote_max)} minutos`)}
          ${regra('Limite por dia', `até ${campo('limite_diario', base.limite_diario)} mensagens`)}
          ${regra('Horário permitido', `das ${campo('hora_inicio', base.hora_inicio, 'time')} às ${campo('hora_fim', base.hora_fim, 'time')}`)}
        </div>
        <p class="msg-estimativa" id="ds-estimativa"></p>`;
      atualizarEstimativa();
    }

    // No WhatsApp, quem divide o mesmo número recebe uma mensagem só
    function mensagensWhatsapp() {
      return new Set([...selecionados].map(id => numeroWhatsapp(ativos.find(c => c.id === id)?.telefone)).filter(Boolean)).size;
    }
    const comWhatsapp = () => idsSelecionados(temWa).length;

    function atualizarEstimativa() {
      const el = modal.querySelector('#ds-estimativa');
      if (!el || !infoWa?.presets) return;
      const n = mensagensWhatsapp();
      const repetidos = comWhatsapp() - n;
      const cfg = configRitmo();
      const valido = [cfg.intervalo_min, cfg.intervalo_max, cfg.lote, cfg.pausa_lote_min, cfg.pausa_lote_max, cfg.limite_diario].every(x => x > 0)
        && /^\d\d:\d\d$/.test(cfg.hora_inicio) && /^\d\d:\d\d$/.test(cfg.hora_fim) && cfg.hora_fim > cfg.hora_inicio;
      el.innerHTML = !n ? 'Selecione os convidados para ver quanto tempo o envio vai levar.'
        : !valido ? 'Confira as regras: todos os valores precisam ser maiores que zero e o horário final depois do inicial.'
        : `⏱️ Tempo estimado para ${n} mensagem(ns)${repetidos ? ` (${repetidos} convidado(s) com número repetido recebem junto)` : ''}: <strong>${estimarWhatsapp(n, cfg)}</strong>. Você pode fechar o sistema — o envio continua no servidor.`;
    }

    function atualizarContador() {
      const n = selecionados.size;
      const nEmail = idsSelecionados(temEmail).length;
      const nWa = comWhatsapp();
      modal.querySelector('#ds-contador').textContent = canal === 'ambos' && n
        ? `${n} selecionado(s): ${nEmail} por e-mail, ${nWa} por WhatsApp` : `${n} selecionado(s)`;
      const btn = modal.querySelector('#ds-enviar');
      const bloqueado = usaWa() && (!infoWa || !infoWa.disponivel || !!infoWa.ativo);
      btn.disabled = !n || bloqueado;
      btn.textContent = !n ? 'Enviar'
        : canal === 'ambos' ? `Enviar por e-mail e WhatsApp (${n} convidado(s))`
        : `Enviar ${canal === 'email' ? 'e-mail' : 'WhatsApp'} para ${n} convidado(s)`;
      atualizarEstimativa();
    }

    modal.querySelector('#ds-canais').onclick = async e => {
      const b = e.target.closest('[data-canal]');
      if (!b || b.dataset.canal === canal) return;
      canal = b.dataset.canal;
      modal.querySelectorAll('#ds-canais [data-canal]').forEach(x => {
        x.classList.toggle('botao-ouro', x === b); x.classList.toggle('botao-claro', x !== b);
      });
      // quem não tem contato no novo canal sai da seleção
      for (const id of [...selecionados]) if (!elegivel(ativos.find(c => c.id === id))) selecionados.delete(id);
      desenharWa(); desenhar();
      if (usaWa() && !infoWa) {
        try { infoWa = await api(url('/whatsapp')); } catch (err) { infoWa = { disponivel: false }; toast(err.message, 'erro'); }
        desenharWa(); atualizarContador();
      }
    };
    caixaWa.addEventListener('change', e => {
      if (e.target.name === 'ritmo') { ritmo = e.target.value; desenharWa(); atualizarContador(); }
    });
    caixaWa.addEventListener('input', e => { if (e.target.classList.contains('msg-regra-campo')) atualizarEstimativa(); });

    modal.querySelector('#ds-filtros').onclick = e => {
      const b = e.target.closest('[data-filtro]');
      if (!b) return;
      filtroStatus = b.dataset.filtro;
      modal.querySelectorAll('#ds-filtros [data-filtro]').forEach(x => {
        x.classList.toggle('botao-ouro', x === b); x.classList.toggle('botao-claro', x !== b);
      });
      // Trocar o filtro rápido já seleciona o grupo inteiro — atalho para o envio em massa
      selecionados.clear();
      visiveis().filter(elegivel).forEach(c => selecionados.add(c.id));
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
      visiveis().filter(elegivel).forEach(c => e.target.checked ? selecionados.add(c.id) : selecionados.delete(c.id));
      desenhar();
    };

    modal.querySelector('#ds-enviar').onclick = () => {
      const idsEmail = usaEmail() ? idsSelecionados(temEmail) : [];
      const idsWa = usaWa() ? idsSelecionados(temWa) : [];
      const segmentacao = idsWa.length ? configRitmo() : null;
      const nEmail = idsEmail.length;
      const partes = [];
      if (nEmail) {
        partes.push(`<p>✉️ <strong>E-mail</strong> para <strong>${nEmail}</strong> convidado(s): os e-mails saem com um pequeno
          intervalo entre eles${nEmail > 30 ? ` (cerca de <strong>${Math.max(1, Math.ceil(nEmail * 2 / 60))} min</strong>)` : ''}.</p>`);
      }
      if (idsWa.length) {
        partes.push(`<p>💬 <strong>WhatsApp</strong> para <strong>${idsWa.length}</strong> convidado(s), no ritmo
          <strong>${RITMOS[ritmo].rotulo.toLowerCase()}</strong> — ${estimarWhatsapp(mensagensWhatsapp(), segmentacao)}.
          Você pode acompanhar, pausar ou cancelar a qualquer momento nesta tela.</p>`);
        if (!infoWa.conectado) partes.push('<p class="aviso-caixa aviso-erro">O WhatsApp está desconectado: o envio por WhatsApp vai ficar pausado até você conectar o número e clicar em “Retomar”.</p>');
      }
      const conf = abrirModal(`
        <h3>Confirmar envio?</h3>
        <p>A mensagem <strong>${esc(m.nome)}</strong> será enviada assim:</p>${partes.join('')}
        <div class="acoes"><button class="botao-claro" data-fechar>Voltar</button>
        <button class="botao-ouro" id="dc-conf">Enviar agora</button></div>`);
      conf.querySelector('#dc-conf').onclick = async () => {
        const btn = conf.querySelector('#dc-conf');
        btn.disabled = true; btn.classList.add('carregando');
        const disparar = (canalEnvio, ids) => api(`/api/admin/mensagens/${mensagemId}/disparar`, { method: 'POST', body: {
          canal: canalEnvio, convidado_ids: ids, segmentacao: canalEnvio === 'whatsapp' ? segmentacao : null,
        }});
        const avisos = []; let algumOk = false;
        // WhatsApp primeiro: é o que tem mais validações (envio já em andamento, configuração) —
        // se recusar, nada foi enviado ainda e o organizador decide o que fazer
        if (idsWa.length) {
          try {
            const r = await disparar('whatsapp', idsWa);
            algumOk = true;
            const extras = [
              r.duplicados ? `${r.duplicados} número(s) repetido(s) recebem uma mensagem só` : '',
              r.sem_telefone ? `${r.sem_telefone} sem telefone válido` : '',
            ].filter(Boolean).join('; ');
            avisos.push(['ok', `WhatsApp: envio iniciado para ${r.total} número(s).${extras ? ' (' + extras + ')' : ''}`]);
          } catch (e) {
            if (!idsEmail.length) { toast(e.message, 'erro'); btn.disabled = false; btn.classList.remove('carregando'); return; }
            conf.remove();
            const m2 = abrirModal(`
              <h3>O envio por WhatsApp não pôde começar</h3>
              <p class="aviso-caixa aviso-erro">${esc(e.message)}</p>
              <p>Nada foi enviado ainda. Quer enviar só o e-mail para os ${idsEmail.length} convidado(s) agora?</p>
              <div class="acoes"><button class="botao-claro" data-fechar>Não enviar nada</button>
              <button class="botao-ouro" id="so-email">Enviar só o e-mail</button></div>`);
            m2.querySelector('#so-email').onclick = async () => {
              try {
                const r = await disparar('email', idsEmail);
                m2.remove(); modal.remove();
                toast(`E-mail: envio iniciado para ${r.total} convidado(s).`, 'ok');
                carregarMensagens();
              } catch (err) { toast(err.message, 'erro'); }
            };
            return;
          }
        }
        if (idsEmail.length) {
          try {
            const r = await disparar('email', idsEmail);
            algumOk = true;
            avisos.push(['ok', `E-mail: envio iniciado para ${r.total} convidado(s).`]);
          } catch (e) { avisos.push(['erro', 'E-mail: ' + e.message]); }
        }
        if (algumOk) { conf.remove(); modal.remove(); carregarMensagens(); }
        else { btn.disabled = false; btn.classList.remove('carregando'); }
        avisos.forEach(([tipo, texto]) => toast(texto, tipo));
      };
    };

    desenhar();
  }

  // ── Envio por WhatsApp em andamento (segmentado: dura horas/dias, roda no servidor) ──
  function desenharProgressoWa(info) {
    const el = $('msg-progresso-wa');
    const p = info && info.ativo;
    if (!p) { el.classList.add('oculto'); el.innerHTML = ''; return; }
    el.classList.remove('oculto');
    const pct = p.total ? Math.round(p.processados / p.total * 100) : 0;
    const pausado = p.situacao === 'pausado';
    let status;
    if (pausado) status = `⏸️ <strong>Pausado.</strong> ${esc(p.motivo || '')}`;
    else if (p.motivo) status = `⏳ ${esc(p.motivo)}`;
    else if (p.proximo_envio_ts) {
      const seg = Math.max(0, Math.round((p.proximo_envio_ts - Date.now()) / 1000));
      status = seg > 0 ? `⏳ Próxima mensagem em <strong>${seg < 60 ? seg + ' s' : Math.ceil(seg / 60) + ' min'}</strong>.` : '📤 Enviando…';
    } else status = '📤 Enviando…';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">💬 Envio por WhatsApp — “${esc(p.mensagem_nome)}”</h2>
        <div class="linha-flex" style="flex:0 0 auto;gap:8px">
          ${pausado
            ? '<button type="button" class="botao-mini botao-ouro" data-acao-wa="retomar">▶ Retomar</button>'
            : '<button type="button" class="botao-mini botao-claro" data-acao-wa="pausar">⏸ Pausar</button>'}
          <button type="button" class="botao-mini botao-perigo" data-acao-wa="cancelar">Cancelar envio</button>
        </div>
      </div>
      <p class="msg-wa-status ${pausado ? 'pausado' : ''}">${status}</p>
      <div class="msg-barra"><div style="width:${pct}%"></div></div>
      <div class="msg-wa-numeros">
        <span><strong>${p.enviados}</strong> de ${p.total} enviadas</span>
        <span>Lote <strong>${p.lote_atual}</strong> de ${p.total_lotes}</span>
        <span>Hoje: <strong>${p.enviados_hoje}</strong> de ${p.config.limite_diario} permitidas</span>
        <span>Horário: ${esc(p.config.hora_inicio)}–${esc(p.config.hora_fim)}</span>
        ${p.falhas ? `<span>❌ <strong>${p.falhas}</strong> falha(s)</span>` : ''}
      </div>`;
    el.querySelectorAll('[data-acao-wa]').forEach(b => b.onclick = () => acaoWa(p, b.dataset.acaoWa));
  }

  async function acaoWa(p, acao) {
    if (acao === 'cancelar') {
      const m = abrirModal(`
        <h3>Cancelar o envio por WhatsApp?</h3>
        <p>Já foram enviadas <strong>${p.enviados}</strong> de ${p.total} mensagens. As <strong>${p.pendentes}</strong>
        restantes não serão enviadas. Esta ação não pode ser desfeita (mas você pode iniciar um novo envio depois).</p>
        <div class="acoes"><button class="botao-claro" data-fechar>Voltar</button>
        <button class="botao-perigo" id="cw-conf">Cancelar envio</button></div>`);
      m.querySelector('#cw-conf').onclick = async () => {
        try { await api(`/api/admin/disparos/${p.id}/cancelar`, { method: 'POST' }); m.remove(); toast('Envio cancelado.', 'ok'); carregarMensagens(); }
        catch (e) { toast(e.message, 'erro'); }
      };
      return;
    }
    try {
      await api(`/api/admin/disparos/${p.id}/${acao}`, { method: 'POST' });
      toast(acao === 'pausar' ? 'Envio pausado.' : 'Envio retomado.', 'ok');
      atualizarWa();
    } catch (e) { toast(e.message, 'erro'); }
  }

  async function atualizarWa() {
    try {
      const info = await api(url('/whatsapp?leve=1'));
      desenharProgressoWa(info);
      if (info.ativo) iniciarPollingWa();
      else if (msg.pollWa) { pararPollingWa(); carregarMensagens(); }
    } catch { /* a próxima rodada tenta de novo */ }
  }
  function iniciarPollingWa() {
    if (msg.pollWa) return;
    const eventoDoPoll = estado.eventoId;
    msg.pollWa = setInterval(() => {
      if (estado.eventoId !== eventoDoPoll || !$('secao-mensagens').classList.contains('ativa')) { pararPollingWa(); return; }
      atualizarWa();
    }, 5000);
  }
  function pararPollingWa() { clearInterval(msg.pollWa); msg.pollWa = null; }

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
        <p>${d.canal === 'whatsapp' ? '💬 WhatsApp' : '✉️ E-mail — ' + esc(legivel(d.assunto))}<br>Iniciado em ${dataHoraBr(d.iniciado_em)} por ${esc(d.criado_por)} ·
        <strong>${d.enviados}</strong> de ${d.total} enviados${d.sem_email ? ` · ${d.sem_email} sem ${d.canal === 'whatsapp' ? 'telefone válido' : 'e-mail'}` : ''}</p>
        <div class="lista-destinatarios">
          ${d.destinatarios.length ? d.destinatarios.map(x => `
            <div class="item-destinatario">
              <span class="dest-info"><strong>${esc(x.nome)}</strong><small>${esc(x.destino)}</small></span>
              ${x.status === 'enviado' ? '<span class="selo selo-confirmado">Enviado</span>'
                : x.status === 'pendente' ? '<span class="selo selo-pendente">Na fila</span>'
                : x.status === 'enviando' ? '<span class="selo selo-pendente">Enviando…</span>'
                : x.status === 'cancelado' ? '<span class="selo selo-pendente">Cancelado</span>'
                : `<span class="selo selo-cancelado" title="${esc(x.erro || x.status)}">Falhou</span>`}
            </div>`).join('') : '<p style="padding:12px">Nenhum envio registrado.</p>'}
        </div>
        <div class="acoes"><button class="botao-ouro" data-fechar>Fechar</button></div>`)
        .querySelector('.modal').style.maxWidth = '640px';
    } catch (e) { toast(e.message, 'erro'); }
  };
})();
