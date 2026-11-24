'use strict';
// Editor de etiquetas de crachá por evento + impressão em lote + categorias + link do totem.
(function () {
  const E = window.Etiqueta;
  const $ = id => document.getElementById(id);
  const eventoId = Number(new URLSearchParams(location.search).get('evento'));
  const alfa = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
  const NOMES_TIPO = { campo: 'Campo', texto: 'Texto', qrcode: 'QR code', codigobarras: 'Código de barras', caixa: 'Moldura' };
  const nomeCampo = v => (E.CAMPOS.find(c => c.valor === v) || {}).rotulo || v;

  let info = null;          // resposta de GET /etiqueta
  let cfg = {};             // configurações do evento (sem o modelo)
  let modelo = null;        // modelo em edição
  let selId = null;
  let sujo = false;
  const historico = [], futuro = [];
  let amostra = { ...E.EXEMPLO };
  let convidados = [];      // lista enxuta (lote / categorias / amostra)
  let modelos = [];         // biblioteca

  if (!eventoId) { document.body.innerHTML = '<p style="padding:40px">Abra esta página pelo painel do evento.</p>'; return; }

  // ═══════════ Utilidades ═══════════
  const copia = o => JSON.parse(JSON.stringify(o));
  const r05 = n => Math.round(n * 2) / 2;
  function log(msg) { const r = $('registro'); r.textContent = (new Date().toLocaleTimeString('pt-BR') + '  ' + msg + '\n' + r.textContent).slice(0, 3000); }
  function marcarSujo(v = true) {
    sujo = v;
    const s = $('estado-salvo');
    s.textContent = v ? '● Alterações não salvas' : (info?.config?.atualizado_em ? 'Salvo ' + dataHoraBr(info.config.atualizado_em) : '');
    s.className = 'salvo' + (v ? ' pendente' : '');
  }
  window.addEventListener('beforeunload', e => { if (sujo) { e.preventDefault(); e.returnValue = ''; } });

  function registrar() { historico.push(copia(modelo)); if (historico.length > 80) historico.shift(); futuro.length = 0; marcarSujo(); }
  function desfazer() { if (!historico.length) return; futuro.push(copia(modelo)); modelo = historico.pop(); marcarSujo(); tudo(); }
  function refazer() { if (!futuro.length) return; historico.push(copia(modelo)); modelo = futuro.pop(); marcarSujo(); tudo(); }

  // ═══════════ Carregamento ═══════════
  async function carregar() {
    info = await api(`/api/admin/eventos/${eventoId}/etiqueta`);
    document.title = 'Etiquetas · ' + info.evento.nome;
    $('nome-evento').textContent = info.evento.nome;
    cfg = { ...info.config }; delete cfg.modelo;
    modelo = E.normalizar(info.config.modelo || E.modeloPadrao(100, 50));
    preencherConfig();
    marcarSujo(false);
    tudo();
    desenharTotem();
    carregarModelos();
    carregarConvidados();
  }

  function preencherConfig() {
    $('cfg-imprime').checked = !!cfg.imprime;
    $('cfg-automatica').checked = !!cfg.automatica;
    $('cfg-qr').value = cfg.qr_conteudo || 'link';
    $('cfg-categoria').value = cfg.categoria_padrao || '';
    $('cfg-reimp').value = cfg.max_reimpressoes ?? 1;
    $('cfg-titulo').value = cfg.totem_titulo || '';
  }
  [['cfg-imprime', 'imprime', el => el.checked ? 1 : 0], ['cfg-automatica', 'automatica', el => el.checked ? 1 : 0],
    ['cfg-qr', 'qr_conteudo', el => el.value], ['cfg-categoria', 'categoria_padrao', el => el.value.toLocaleUpperCase('pt-BR')],
    ['cfg-reimp', 'max_reimpressoes', el => Number(el.value) || 0], ['cfg-titulo', 'totem_titulo', el => el.value],
  ].forEach(([id, chave, ler]) => $(id).addEventListener('input', () => { cfg[chave] = ler($(id)); marcarSujo(); if (chave === 'categoria_padrao') atualizarAmostraCategoria(); }));

  async function salvar() {
    const b = $('btn-salvar');
    b.disabled = true;
    try {
      const r = await api(`/api/admin/eventos/${eventoId}/etiqueta`, { method: 'PUT', body: { ...cfg, modelo } });
      info.config = r.config;
      marcarSujo(false);
      toast('Etiqueta e configurações salvas.', 'ok');
    } catch (e) { toast(e.message, 'erro'); }
    b.disabled = false;
  }
  $('btn-salvar').addEventListener('click', salvar);

  // ═══════════ Página (tamanho/impressão) ═══════════
  E.TAMANHOS.forEach(([w, h]) => $('pg-tamanho').add(new Option(`${w} × ${h} mm`, `${w}x${h}`)));
  $('pg-tamanho').add(new Option('Personalizado', 'outro'));
  E.FONTES.forEach(f => $('pg-fonte').add(new Option(f.split(',')[0].replace(/"/g, ''), f)));

  function preencherPagina() {
    const k = `${modelo.largura}x${modelo.altura}`;
    $('pg-tamanho').value = [...$('pg-tamanho').options].some(o => o.value === k) ? k : 'outro';
    $('pg-largura').value = modelo.largura; $('pg-altura').value = modelo.altura;
    $('pg-rotacao').value = modelo.rotacao || 0; $('pg-ax').value = modelo.ajusteX || 0; $('pg-ay').value = modelo.ajusteY || 0;
    $('pg-escuro').value = modelo.escurecimento || 0;
    if (![...$('pg-fonte').options].some(o => o.value === modelo.fonte)) $('pg-fonte').add(new Option(modelo.fonte.split(',')[0], modelo.fonte));
    $('pg-fonte').value = modelo.fonte;
  }
  function redimensionarPagina(w, h) {
    // Mantém a proporção dos elementos ao trocar o tamanho da etiqueta
    const fx = w / modelo.largura, fy = h / modelo.altura, f = Math.min(fx, fy);
    for (const el of modelo.elementos) {
      el.x = r05(el.x * fx); el.y = r05(el.y * fy);
      if (el.tipo === 'qrcode') el.tamanho = r05(el.tamanho * f);
      else { el.w = r05(el.w * fx); el.h = r05(el.h * fy); }
      if (el.fonte) el.fonte = Math.max(5, Math.round(el.fonte * f * 2) / 2);
    }
    modelo.largura = w; modelo.altura = h;
  }
  $('pg-tamanho').addEventListener('change', () => {
    const v = $('pg-tamanho').value;
    if (v === 'outro') return;
    const [w, h] = v.split('x').map(Number);
    registrar(); redimensionarPagina(w, h); tudo();
  });
  for (const [id, chave] of [['pg-largura', 'largura'], ['pg-altura', 'altura']]) {
    $(id).addEventListener('change', () => {
      const w = Math.min(104, Math.max(15, Number($('pg-largura').value) || modelo.largura));
      const h = Math.min(300, Math.max(10, Number($('pg-altura').value) || modelo.altura));
      registrar(); redimensionarPagina(w, h); tudo();
    });
  }
  for (const [id, chave, conv] of [['pg-rotacao', 'rotacao', Number], ['pg-ax', 'ajusteX', Number], ['pg-ay', 'ajusteY', Number], ['pg-escuro', 'escurecimento', Number], ['pg-fonte', 'fonte', String]]) {
    $(id).addEventListener('change', () => { registrar(); modelo[chave] = conv($(id).value) || (chave === 'fonte' ? E.FONTES[0] : 0); tudo(); });
  }

  // ═══════════ Palco (pré-visualização + arrastar) ═══════════
  let escala = 6; // px de tela por mm
  function desenharPalco() {
    const palco = $('palco');
    const disp = Math.max(240, palco.clientWidth - 56);
    escala = Math.min(disp / modelo.largura, 560 / modelo.altura, 9);
    const folha = $('folha');
    folha.style.width = modelo.largura * escala + 'px';
    folha.style.height = modelo.altura * escala + 'px';
    // No editor a etiqueta aparece "em pé", sem rotação/ajuste (eles só valem na impressão)
    E.desenhar({ ...modelo, rotacao: 0, ajusteX: 0, ajusteY: 0 }, amostra, $('tela'));
    folha.querySelectorAll('.caixa-el').forEach(n => n.remove());
    modelo.elementos.forEach(el => {
      if (el.oculto) return;
      const d = document.createElement('div');
      d.className = 'caixa-el' + (el.id === selId ? ' sel' : '');
      d.dataset.id = el.id;
      const w = el.tipo === 'qrcode' ? el.tamanho : el.w, h = el.tipo === 'qrcode' ? el.tamanho : el.h;
      Object.assign(d.style, { left: el.x * escala + 'px', top: el.y * escala + 'px', width: w * escala + 'px', height: h * escala + 'px' });
      d.innerHTML = `<span class="rot">${esc(rotuloEl(el))}</span><span class="alca"></span>`;
      folha.appendChild(d);
    });
    const rot = modelo.rotacao ? ` · imprime girada ${modelo.rotacao}°` : '';
    $('info-medidas').textContent = `${modelo.largura} × ${modelo.altura} mm${rot}`;
  }
  function rotuloEl(el) {
    if (el.tipo === 'campo') return nomeCampo(el.campo);
    if (el.tipo === 'texto') return 'Texto: ' + (el.texto || '…');
    if (el.tipo === 'codigobarras') return 'Código de barras (' + nomeCampo(el.campo || 'codigo') + ')';
    return NOMES_TIPO[el.tipo];
  }

  let arrasto = null;
  $('folha').addEventListener('pointerdown', e => {
    const caixa = e.target.closest('.caixa-el');
    if (!caixa) { selecionar(null); return; }
    const el = modelo.elementos.find(x => x.id === caixa.dataset.id);
    if (!el) return;
    selecionar(el.id, false);
    caixa.setPointerCapture(e.pointerId);
    arrasto = { el, modo: e.target.classList.contains('alca') ? 'tamanho' : 'mover', sx: e.clientX, sy: e.clientY, orig: copia(el), antes: copia(modelo), caixa };
    e.preventDefault();
  });
  $('folha').addEventListener('pointermove', e => {
    if (!arrasto) return;
    const dx = (e.clientX - arrasto.sx) / escala, dy = (e.clientY - arrasto.sy) / escala;
    const { el, orig } = arrasto;
    if (arrasto.modo === 'mover') { el.x = r05(orig.x + dx); el.y = r05(orig.y + dy); }
    else if (el.tipo === 'qrcode') el.tamanho = Math.max(4, r05(orig.tamanho + Math.max(dx, dy)));
    else { el.w = Math.max(1, r05(orig.w + dx)); el.h = Math.max(0.5, r05(orig.h + dy)); }
    // Atualiza só a caixa durante o arrasto (rápido); redesenha a etiqueta no fim
    const w = el.tipo === 'qrcode' ? el.tamanho : el.w, h = el.tipo === 'qrcode' ? el.tamanho : el.h;
    Object.assign(arrasto.caixa.style, { left: el.x * escala + 'px', top: el.y * escala + 'px', width: w * escala + 'px', height: h * escala + 'px' });
    clearTimeout(arrasto.t); arrasto.t = setTimeout(() => E.desenhar({ ...modelo, rotacao: 0, ajusteX: 0, ajusteY: 0 }, amostra, $('tela')), 40);
  });
  const soltar = () => {
    if (!arrasto) return;
    const mudou = JSON.stringify(arrasto.orig) !== JSON.stringify(arrasto.el);
    if (mudou) { historico.push(arrasto.antes); futuro.length = 0; marcarSujo(); }
    arrasto = null;
    tudo();
  };
  $('folha').addEventListener('pointerup', soltar);
  $('folha').addEventListener('pointercancel', soltar);
  window.addEventListener('resize', () => desenharPalco());

  document.addEventListener('keydown', e => {
    const emCampo = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); salvar(); return; }
    if (emCampo) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? refazer() : desfazer(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); refazer(); return; }
    const el = modelo?.elementos.find(x => x.id === selId);
    if (!el || !$('aba-editor').classList.contains('ativa')) return;
    const passo = e.shiftKey ? 2 : 0.5;
    const mov = { ArrowLeft: [-passo, 0], ArrowRight: [passo, 0], ArrowUp: [0, -passo], ArrowDown: [0, passo] }[e.key];
    if (mov) { e.preventDefault(); registrar(); el.x = r05(el.x + mov[0]); el.y = r05(el.y + mov[1]); tudo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remover(el.id); }
  });
  $('desfazer').addEventListener('click', desfazer);
  $('refazer').addEventListener('click', refazer);

  // ═══════════ Elementos ═══════════
  function selecionar(id, redesenhar = true) {
    selId = id;
    if (redesenhar) { desenharPalco(); }
    else $('folha').querySelectorAll('.caixa-el').forEach(n => n.classList.toggle('sel', n.dataset.id === id));
    desenharLista(); desenharProps();
  }
  function novoId() { let i = modelo.elementos.length + 1; while (modelo.elementos.some(e => e.id === 'el' + i)) i++; return 'el' + i; }
  function adicionar(tipo) {
    registrar();
    const m = 3, base = { id: novoId(), tipo, x: m, y: m };
    const el = {
      campo: { ...base, campo: 'nome', w: Math.min(50, modelo.largura - 2 * m), h: 8, fonte: 14, negrito: true, alinhar: 'left', valign: 'middle', maiusculas: false, ajustar: true, linhas: 1 },
      texto: { ...base, texto: 'TEXTO', w: Math.min(40, modelo.largura - 2 * m), h: 6, fonte: 11, negrito: false, alinhar: 'left', valign: 'middle', maiusculas: false, ajustar: true, linhas: 1 },
      qrcode: { ...base, tamanho: Math.min(20, modelo.altura - 2 * m) },
      codigobarras: { ...base, campo: 'codigo', w: Math.min(40, modelo.largura - 2 * m), h: 10, mostrarTexto: true },
      caixa: { ...base, x: 1, y: 1, w: modelo.largura - 2, h: modelo.altura - 2, borda: 0.5, raio: 2, preencher: false },
    }[tipo];
    modelo.elementos.push(el);
    selId = el.id;
    tudo();
  }
  document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => adicionar(b.dataset.add)));
  function remover(id) { registrar(); modelo.elementos = modelo.elementos.filter(e => e.id !== id); if (selId === id) selId = null; tudo(); }
  function duplicar(id) {
    const el = modelo.elementos.find(e => e.id === id); if (!el) return;
    registrar();
    const n = { ...copia(el), id: novoId(), x: r05(el.x + 2), y: r05(el.y + 2) };
    modelo.elementos.splice(modelo.elementos.indexOf(el) + 1, 0, n);
    selId = n.id; tudo();
  }
  function mover(id, d) {
    const i = modelo.elementos.findIndex(e => e.id === id), j = i + d;
    if (i < 0 || j < 0 || j >= modelo.elementos.length) return;
    registrar();
    [modelo.elementos[i], modelo.elementos[j]] = [modelo.elementos[j], modelo.elementos[i]];
    tudo();
  }

  function desenharLista() {
    $('lista-el').innerHTML = modelo.elementos.map((el, i) => `
      <li class="${el.id === selId ? 'sel' : ''} ${el.oculto ? 'oculto-el' : ''}" data-id="${esc(el.id)}">
        <span class="nome-el">${esc(rotuloEl(el))}${el.soCategorias?.length ? ` <small style="color:var(--texto-suave)">(só ${esc(el.soCategorias.join(', '))})</small>` : ''}</span>
        <button data-acao="cima" title="Trazer para trás" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-acao="baixo" title="Trazer para frente" ${i === modelo.elementos.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-acao="ver" title="${el.oculto ? 'Mostrar' : 'Ocultar'}">${el.oculto ? '◌' : '●'}</button>
        <button data-acao="dup" title="Duplicar">⧉</button>
        <button data-acao="del" title="Remover">✕</button>
      </li>`).join('') || '<li class="vazio-props">Nenhum elemento. Use os botões “＋” acima.</li>';
  }
  $('lista-el').addEventListener('click', e => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    const id = li.dataset.id, acao = e.target.closest('button')?.dataset.acao;
    if (!acao) return selecionar(id);
    if (acao === 'del') remover(id);
    if (acao === 'dup') duplicar(id);
    if (acao === 'cima') mover(id, -1);
    if (acao === 'baixo') mover(id, 1);
    if (acao === 'ver') { registrar(); const el = modelo.elementos.find(x => x.id === id); el.oculto = !el.oculto; tudo(); }
  });

  // ── Painel de propriedades ──
  const num = (rot, chave, el, extra = '') => `<div><label>${rot}</label><input type="number" data-p="${chave}" value="${el[chave] ?? ''}" step="0.5" ${extra}></div>`;
  const chk = (rot, chave, el) => `<label class="chave" style="margin-top:8px"><input type="checkbox" data-p="${chave}" ${el[chave] ? 'checked' : ''}> <span>${rot}</span></label>`;
  function desenharProps() {
    const el = modelo.elementos.find(x => x.id === selId);
    if (!el) { $('props').innerHTML = '<p class="vazio-props">Clique num elemento da etiqueta para editar.</p>'; return; }
    let h = '';
    if (el.tipo === 'campo' || el.tipo === 'codigobarras') {
      h += `<label>Campo</label><select data-p="campo">${E.CAMPOS.map(c => `<option value="${c.valor}" ${c.valor === el.campo ? 'selected' : ''}>${esc(c.rotulo)}</option>`).join('')}</select>`;
    }
    if (el.tipo === 'texto') h += `<label>Texto</label><input data-p="texto" value="${esc(el.texto || '')}">`;
    h += `<div class="d2">${num('X (mm)', 'x', el)}${num('Y (mm)', 'y', el)}</div>`;
    if (el.tipo === 'qrcode') h += `<div class="d2">${num('Tamanho (mm)', 'tamanho', el, 'min="4"')}</div>`;
    else h += `<div class="d2">${num('Largura (mm)', 'w', el, 'min="1"')}${num('Altura (mm)', 'h', el, 'min="0.5"')}</div>`;
    if (el.tipo === 'campo' || el.tipo === 'texto') {
      h += `<div class="d2">${num('Fonte (pt)', 'fonte', el, 'min="4"')}<div><label>Máx. linhas</label><input type="number" data-p="linhas" value="${el.linhas || 1}" min="1" max="6" step="1"></div></div>`;
      h += `<div class="d2"><div><label>Alinhamento</label><select data-p="alinhar">${[['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita']].map(([v, r]) => `<option value="${v}" ${el.alinhar === v ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
        <div><label>Vertical</label><select data-p="valign">${[['top', 'Topo'], ['middle', 'Meio'], ['bottom', 'Base']].map(([v, r]) => `<option value="${v}" ${(el.valign || 'middle') === v ? 'selected' : ''}>${r}</option>`).join('')}</select></div></div>`;
      h += chk('Negrito', 'negrito', el) + chk('MAIÚSCULAS', 'maiusculas', el) + chk('Reduzir a fonte para caber', 'ajustar', el) + chk('Faixa invertida (fundo preto)', 'inverter', el);
      if (el.inverter) h += `<div class="d2">${num('Cantos da faixa (mm)', 'raio', { raio: el.raio ?? 1 })}</div>`;
    }
    if (el.tipo === 'codigobarras') h += chk('Mostrar o número abaixo das barras', 'mostrarTexto', el);
    if (el.tipo === 'caixa') {
      h += `<div class="d2">${num('Espessura (mm)', 'borda', el, 'min="0.1" step="0.1"')}${num('Cantos (mm)', 'raio', el, 'min="0"')}</div>` + chk('Preenchida (preta)', 'preencher', el);
    }
    const cats = info?.categorias || [];
    h += `<label>Mostrar só para as categorias <small style="font-weight:400">(nenhuma marcada = todas)</small></label>
      <div class="cats">${cats.map(c => `<label><input type="checkbox" data-cat="${esc(c)}" ${el.soCategorias?.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('') || '<small style="color:var(--texto-suave)">Defina categorias na aba Categorias.</small>'}</div>`;
    $('props').innerHTML = h;
  }
  let snapshotProps = null;
  $('props').addEventListener('focusin', () => { snapshotProps = copia(modelo); });
  $('props').addEventListener('input', e => {
    const el = modelo.elementos.find(x => x.id === selId); if (!el) return;
    if (!snapshotProps) snapshotProps = copia(modelo);
    const t = e.target;
    if (t.dataset.cat !== undefined) {
      const marcadas = [...$('props').querySelectorAll('[data-cat]:checked')].map(c => c.dataset.cat);
      if (marcadas.length) el.soCategorias = marcadas; else delete el.soCategorias;
    } else if (t.dataset.p) {
      const p = t.dataset.p;
      el[p] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? el[p] : Number(t.value)) : t.value;
      if (p === 'inverter') { desenharProps(); }
    }
    if (JSON.stringify(snapshotProps) !== JSON.stringify(modelo)) { historico.push(snapshotProps); futuro.length = 0; snapshotProps = copia(modelo); marcarSujo(); }
    desenharPalco(); desenharLista();
  });

  function tudo() { preencherPagina(); desenharPalco(); desenharLista(); desenharProps(); }

  // ═══════════ Amostra (pré-visualizar com um convidado real) ═══════════
  function atualizarAmostraCategoria() { if (!$('amostra').value) { amostra = { ...amostra, categoria: cfg.categoria_padrao || 'CONVIDADO' }; desenharPalco(); } }
  async function carregarQrExemplo() {
    try { amostra.qr_matriz = await (await fetch('/api/totem/qr?texto=' + encodeURIComponent(E.EXEMPLO.qr))).json(); } catch {}
    amostra.categoria = cfg.categoria_padrao || 'CONVIDADO';
    amostra.evento = info?.evento?.nome || amostra.evento;
    desenharPalco();
  }
  $('amostra').addEventListener('change', async () => {
    const id = $('amostra').value;
    if (!id) { amostra = { ...E.EXEMPLO }; await carregarQrExemplo(); return; }
    try {
      const r = await api(`/api/admin/eventos/${eventoId}/etiqueta/dados?ids=${id}`);
      if (r.convidados[0]) { amostra = r.convidados[0]; desenharPalco(); }
    } catch (e) { toast(e.message, 'erro'); }
  });

  // ═══════════ Impressora ═══════════
  function statusImpressora() {
    const ok = E.usb.conectada;
    $('pilula-impressora').className = 'pilula' + (ok ? ' ok' : '');
    $('txt-impressora').textContent = ok ? E.usb.nome : (E.usb.suportado() ? 'Impressora desconectada' : 'USB indisponível neste navegador');
    $('btn-impressora').textContent = ok ? 'Trocar' : 'Conectar impressora';
  }
  $('btn-impressora').addEventListener('click', async () => {
    try { await E.usb.escolher(); toast('Impressora conectada: ' + E.usb.nome, 'ok'); }
    catch (e) { if (e.name !== 'NotFoundError') toast(mensagemErroUsb(e), 'erro'); }
    statusImpressora();
  });
  function mensagemErroUsb(e) {
    if (e.name === 'SecurityError' || /Access denied|Unable to claim/i.test(e.message)) return 'O Windows está usando a impressora pelo driver dela. Use “Pela janela do navegador” neste computador — a impressão USB direta é para o tablet.';
    return e.message;
  }
  async function enviarUsb(zpl) {
    if (!E.usb.conectada) await E.usb.escolher();
    statusImpressora();
    await E.usb.enviar(zpl);
  }
  async function testar(fn, rotulo) {
    try { await fn(); log(rotulo + ': enviado.'); }
    catch (e) { if (e.name === 'NotFoundError') log('Nenhuma impressora escolhida.'); else { log('Erro: ' + mensagemErroUsb(e)); toast(mensagemErroUsb(e), 'erro'); } statusImpressora(); }
  }
  $('t-imprimir').addEventListener('click', () => testar(() => enviarUsb(E.paraZpl(E.desenhar(modelo, amostra), { escurecimento: modelo.escurecimento })), 'Etiqueta'));
  $('t-calib').addEventListener('click', () => testar(() => enviarUsb(E.paraZpl(E.desenharCalibracao(modelo), { escurecimento: modelo.escurecimento })), 'Calibração'));
  $('t-sensor').addEventListener('click', () => testar(() => enviarUsb('~JC'), 'Calibração do sensor'));
  $('t-navegador').addEventListener('click', () => E.imprimirNavegador(E.desenhar(modelo, amostra), modelo));
  E.usb.aoMudar(() => statusImpressora());
  E.usb.reconectar().finally(statusImpressora);

  // ═══════════ Biblioteca de modelos ═══════════
  async function carregarModelos() {
    try { modelos = (await api('/api/admin/etiqueta-modelos')).modelos; } catch { modelos = []; }
    const s = $('mod-lista');
    s.innerHTML = modelos.length ? modelos.map(m => `<option value="${m.id}">${esc(m.nome)} — ${m.modelo.largura}×${m.modelo.altura} mm</option>`).join('') : '<option value="">Nenhum modelo salvo ainda</option>';
  }
  $('mod-aplicar').addEventListener('click', () => {
    const m = modelos.find(x => String(x.id) === $('mod-lista').value);
    if (!m) return;
    if (!confirm(`Substituir a etiqueta atual pelo modelo “${m.nome}”? (Dá para desfazer com Ctrl+Z)`)) return;
    registrar(); modelo = E.normalizar(copia(m.modelo)); selId = null; tudo();
    toast('Modelo aplicado. Clique em Salvar para usar neste evento.', 'ok');
  });
  $('mod-excluir').addEventListener('click', async () => {
    const m = modelos.find(x => String(x.id) === $('mod-lista').value);
    if (!m || !confirm(`Excluir o modelo “${m.nome}” da biblioteca? Os eventos que já usam este layout não mudam.`)) return;
    try { await api('/api/admin/etiqueta-modelos/' + m.id, { method: 'DELETE' }); toast('Modelo excluído.', 'ok'); carregarModelos(); } catch (e) { toast(e.message, 'erro'); }
  });
  $('mod-salvar').addEventListener('click', () => {
    const md = abrirModal(`<h3>Salvar como modelo</h3><p>O modelo fica disponível para todos os eventos.</p>
      <label>Nome do modelo</label><input id="md-nome" placeholder="Ex.: Crachá congresso 100×50" value="">
      <div class="acoes"><button class="botao-claro" data-fechar>Cancelar</button><button class="botao-ouro" id="md-ok">Salvar modelo</button></div>`);
    const inp = md.querySelector('#md-nome'); inp.focus();
    const ok = async (substituir = false) => {
      const nome = inp.value.trim(); if (!nome) return inp.focus();
      try {
        await api('/api/admin/etiqueta-modelos', { method: 'POST', body: { nome, modelo, substituir } });
        md.remove(); toast('Modelo salvo na biblioteca.', 'ok'); carregarModelos();
      } catch (e) {
        if (/Já existe/.test(e.message) && confirm(e.message + ' Substituir?')) return ok(true);
        toast(e.message, 'erro');
      }
    };
    md.querySelector('#md-ok').addEventListener('click', () => ok());
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  });
  $('mod-padrao').addEventListener('click', () => {
    if (!confirm('Recomeçar a etiqueta do modelo padrão, no tamanho atual? (Dá para desfazer com Ctrl+Z)')) return;
    registrar();
    const m = E.modeloPadrao(modelo.largura, modelo.altura);
    modelo = { ...m, rotacao: modelo.rotacao, ajusteX: modelo.ajusteX, ajusteY: modelo.ajusteY, escurecimento: modelo.escurecimento, fonte: modelo.fonte };
    selId = null; tudo();
  });

  // ═══════════ Convidados (lote, categorias, amostra) ═══════════
  async function carregarConvidados() {
    try { convidados = (await api(`/api/admin/eventos/${eventoId}/etiqueta/convidados`)).convidados; } catch (e) { toast(e.message, 'erro'); return; }
    const sel = $('amostra'), atual = sel.value;
    sel.innerHTML = '<option value="">Pré-visualizar com: dados de exemplo</option>' +
      convidados.map(c => `<option value="${c.id}">${esc(c.nome)}${c.empresa ? ' — ' + esc(c.empresa) : ''}</option>`).join('');
    sel.value = atual;
    const empresas = [...new Map(convidados.filter(c => c.empresa_id).map(c => [c.empresa_id, c.empresa])).entries()].sort((a, b) => alfa.compare(a[1], b[1]));
    const opEmp = '<option value="">Todas</option>' + empresas.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('') +
      (convidados.some(c => !c.empresa_id) ? '<option value="individual">Convites individuais</option>' : '');
    for (const id of ['l-empresa', 'c-empresa']) { const v = $(id).value; $(id).innerHTML = opEmp; $(id).value = v; }
    const cats = [...new Set(convidados.map(c => c.categoria_efetiva).filter(Boolean))].sort(alfa.compare);
    info.categorias = [...new Set([...(info.categorias || []), ...cats])].sort(alfa.compare);
    const opCat = '<option value="">Todas</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
    for (const id of ['l-categoria', 'c-filtro']) { const v = $(id).value; $(id).innerHTML = opCat; $(id).value = v; }
    $('c-sugestoes').innerHTML = ['VISITANTE', 'PALESTRANTE', 'EXPOSITOR', 'IMPRENSA', 'STAFF', 'ORGANIZAÇÃO', 'PATROCINADOR', 'VIP', ...cats]
      .filter((v, i, a) => a.indexOf(v) === i).map(c => `<option value="${esc(c)}">`).join('');
    desenharLote(); desenharCategorias(); desenharProps();
  }

  function filtrar(prefixo) {
    const busca = textoBusca($(prefixo + '-busca').value).trim();
    const emp = $(prefixo + '-empresa').value;
    const cat = prefixo === 'l' ? $('l-categoria').value : $('c-filtro').value;
    const sit = prefixo === 'l' ? $('l-situacao').value : 'todos';
    return convidados.filter(c =>
      (!busca || textoBusca(c.nome, c.empresa, c.codigo).includes(busca)) &&
      (!emp || (emp === 'individual' ? !c.empresa_id : String(c.empresa_id) === emp)) &&
      (!cat || c.categoria_efetiva === cat) &&
      (sit === 'todos' || (sit === 'confirmados' && ['confirmado', 'checkin'].includes(c.status)) || (sit === 'presentes' && c.status === 'checkin') || (sit === 'nao_impressos' && !c.etiquetas_impressas)));
  }

  function tabelaSelecionavel(prefixo, lista, selecionados, colunasExtra) {
    let grupo = null, h = `<tr><th style="width:36px"></th><th>Nome</th><th>Empresa</th><th>Código</th>${colunasExtra.cab}</tr>`;
    for (const c of lista) {
      const g = c.empresa || 'Convites individuais';
      if (g !== grupo) { grupo = g; h += `<tr class="grupo"><td colspan="${4 + colunasExtra.n}">${esc(g)}</td></tr>`; }
      h += `<tr><td><input type="checkbox" data-id="${c.id}" ${selecionados.has(c.id) ? 'checked' : ''}></td><td>${esc(c.nome)}</td><td>${esc(c.empresa || '—')}</td><td>${esc(c.codigo)}</td>${colunasExtra.linha(c)}</tr>`;
    }
    $(prefixo + '-tabela').innerHTML = lista.length ? h : '<tr><td style="padding:20px;color:var(--texto-suave)">Ninguém nesse filtro.</td></tr>';
    $(prefixo + '-todos').checked = lista.length > 0 && lista.every(c => selecionados.has(c.id));
    $(prefixo + '-cont').textContent = `${selecionados.size} selecionado(s) · ${lista.length} na lista`;
  }

  // ── Lote ──
  const selLote = new Set();
  function desenharLote() {
    tabelaSelecionavel('l', filtrar('l'), selLote, {
      n: 3, cab: '<th>Categoria</th><th>Situação</th><th>Etiquetas</th>',
      linha: c => `<td><span class="etq-cat">${esc(c.categoria_efetiva || '—')}</span></td><td>${seloStatus(c.status)}</td><td>${c.etiquetas_impressas ? c.etiquetas_impressas + '×' : '—'}</td>`,
    });
  }
  ['l-busca', 'l-empresa', 'l-situacao', 'l-categoria'].forEach(id => $(id).addEventListener('input', desenharLote));
  $('l-tabela').addEventListener('change', e => { const id = Number(e.target.dataset.id); if (!id) return; e.target.checked ? selLote.add(id) : selLote.delete(id); desenharLote(); });
  $('l-todos').addEventListener('change', e => { for (const c of filtrar('l')) e.target.checked ? selLote.add(c.id) : selLote.delete(c.id); desenharLote(); });

  async function imprimirLote(viaNavegador) {
    const ids = [...selLote];
    if (!ids.length) return toast('Selecione os convidados.', 'erro');
    if (sujo && !confirm('Há alterações não salvas no modelo. Imprimir com o modelo como está na tela?')) return;
    if (viaNavegador && ids.length > 300) return toast('Pela janela do navegador, imprima até 300 por vez.', 'erro');
    if (!viaNavegador) { try { if (!E.usb.conectada) await E.usb.escolher(); statusImpressora(); } catch (e) { if (e.name !== 'NotFoundError') toast(mensagemErroUsb(e), 'erro'); return; } }
    const prog = $('l-prog'), barra = prog.firstElementChild;
    prog.style.display = 'block'; barra.style.width = '0';
    $('l-imprimir').disabled = $('l-navegador').disabled = true;
    let feitos = 0;
    const canvases = [];
    try {
      for (let i = 0; i < ids.length; i += 50) {
        const parte = ids.slice(i, i + 50);
        const { convidados: dados } = await api(`/api/admin/eventos/${eventoId}/etiqueta/dados?ids=${parte.join(',')}`);
        const impressos = [];
        for (const d of dados) {
          const tela = E.desenhar(modelo, d);
          if (viaNavegador) canvases.push(tela);
          else { await E.usb.enviar(E.paraZpl(tela, { escurecimento: modelo.escurecimento })); }
          impressos.push(d.id);
          feitos++; barra.style.width = (feitos / ids.length * 100) + '%';
        }
        if (!viaNavegador) await api(`/api/admin/eventos/${eventoId}/etiqueta/impressas`, { method: 'POST', body: { ids: impressos } });
      }
      if (viaNavegador) {
        await E.imprimirNavegadorLote(canvases, modelo);
        if (confirm(`Marcar as ${canvases.length} etiquetas como impressas?`)) await api(`/api/admin/eventos/${eventoId}/etiqueta/impressas`, { method: 'POST', body: { ids } });
      }
      toast(`${feitos} etiqueta(s) ${viaNavegador ? 'preparadas' : 'enviadas à impressora'}.`, 'ok');
      selLote.clear();
    } catch (e) {
      toast(`Parou na etiqueta ${feitos + 1} de ${ids.length}: ${mensagemErroUsb(e)}`, 'erro');
    }
    $('l-imprimir').disabled = $('l-navegador').disabled = false;
    setTimeout(() => { prog.style.display = 'none'; }, 1500);
    carregarConvidados();
  }
  $('l-imprimir').addEventListener('click', () => imprimirLote(false));
  $('l-navegador').addEventListener('click', () => imprimirLote(true));

  // ── Categorias ──
  const selCat = new Set();
  function desenharCategorias() {
    tabelaSelecionavel('c', filtrar('c'), selCat, {
      n: 1, cab: '<th>Categoria</th>',
      linha: c => `<td><span class="etq-cat">${esc(c.categoria_efetiva || '—')}</span>${c.categoria ? '' : ' <small style="color:var(--texto-suave)">(padrão)</small>'}</td>`,
    });
  }
  ['c-busca', 'c-empresa', 'c-filtro'].forEach(id => $(id).addEventListener('input', desenharCategorias));
  $('c-tabela').addEventListener('change', e => { const id = Number(e.target.dataset.id); if (!id) return; e.target.checked ? selCat.add(id) : selCat.delete(id); desenharCategorias(); });
  $('c-todos').addEventListener('change', e => { for (const c of filtrar('c')) e.target.checked ? selCat.add(c.id) : selCat.delete(c.id); desenharCategorias(); });
  async function aplicarCategoria(categoria) {
    if (!selCat.size) return toast('Selecione os convidados.', 'erro');
    try {
      const r = await api(`/api/admin/eventos/${eventoId}/categorias`, { method: 'PUT', body: { ids: [...selCat], categoria } });
      info.categorias = r.categorias;
      toast(`${r.alterados} convidado(s) ${categoria ? 'agora são ' + categoria : 'voltaram à categoria padrão'}.`, 'ok');
      selCat.clear(); $('c-nova').value = '';
      carregarConvidados();
    } catch (e) { toast(e.message, 'erro'); }
  }
  $('c-aplicar').addEventListener('click', () => { const v = $('c-nova').value.trim(); if (!v) return $('c-nova').focus(); aplicarCategoria(v); });
  $('c-limpar').addEventListener('click', () => aplicarCategoria(''));

  // ═══════════ Totem ═══════════
  function desenharTotem() {
    const t = info.totem, area = $('totem-area');
    if (!t.ativo) {
      area.innerHTML = `<button class="botao-ouro" id="tt-gerar">Gerar link do totem</button>`;
      $('tt-gerar').onclick = async () => { info.totem = await api(`/api/admin/eventos/${eventoId}/totem-link`, { method: 'POST' }); desenharTotem(); };
      return;
    }
    area.innerHTML = `<div class="link-caixa"><input readonly value="${esc(t.url)}" id="tt-url">
      <button class="botao-claro botao-mini" id="tt-copiar" style="height:42px">Copiar</button>
      <button class="botao-claro botao-mini" id="tt-abrir" style="height:42px">Abrir</button></div>
      <div class="link-caixa"><button class="botao-claro botao-mini" id="tt-novo">Gerar novo link</button>
      <button class="botao-claro botao-mini" id="tt-desativar">Desativar totem</button></div>
      ${t.criado_em ? `<p style="font-size:12px;color:var(--texto-suave);margin-top:8px">Criado em ${dataHoraBr(t.criado_em)}${t.criado_por ? ' por ' + esc(t.criado_por) : ''}</p>` : ''}`;
    $('tt-copiar').onclick = async () => { try { await navigator.clipboard.writeText(t.url); toast('Link copiado.', 'ok'); } catch { $('tt-url').select(); document.execCommand('copy'); toast('Link copiado.', 'ok'); } };
    $('tt-abrir').onclick = () => window.open(t.url, '_blank', 'noopener');
    $('tt-novo').onclick = async () => { if (!confirm('Gerar um novo link? O atual para de funcionar na hora (inclusive no tablet).')) return; info.totem = await api(`/api/admin/eventos/${eventoId}/totem-link`, { method: 'POST' }); desenharTotem(); toast('Novo link gerado.', 'ok'); };
    $('tt-desativar').onclick = async () => { if (!confirm('Desativar o totem? O link para de funcionar.')) return; info.totem = await api(`/api/admin/eventos/${eventoId}/totem-link`, { method: 'DELETE' }); desenharTotem(); };
  }

  // ═══════════ Abas ═══════════
  $('abas').addEventListener('click', e => {
    const b = e.target.closest('button[data-aba]'); if (!b) return;
    document.querySelectorAll('#abas button').forEach(x => x.classList.toggle('ativa', x === b));
    document.querySelectorAll('.aba').forEach(s => s.classList.toggle('ativa', s.id === 'aba-' + b.dataset.aba));
    if (b.dataset.aba === 'editor') desenharPalco();
  });

  carregar().then(carregarQrExemplo).catch(e => toast(e.message, 'erro'));
})();
