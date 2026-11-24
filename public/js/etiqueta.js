'use strict';
// Motor de etiquetas para impressora térmica (Zebra e compatíveis com ZPL).
//
// A etiqueta é DESENHADA como imagem (canvas) na resolução da impressora e enviada como
// gráfico ZPL (^GFA). Assim qualquer tamanho/modelo funciona, com acentos e fontes do
// navegador, sem depender das fontes internas da impressora.
//
// Envio: WebUSB (Chrome no Android/tablet com cabo OTG ou no computador sem driver que
// "segure" a impressora). Alternativa: impressão pelo navegador (janela de impressão /
// Chrome em --kiosk-printing no Windows).
//
// Medidas do modelo em milímetros; fontes em pontos (pt).

(function (global) {
  const PT_MM = 0.3528; // 1 pt em mm

  const CAMPOS = [
    { valor: 'nome', rotulo: 'Nome' },
    { valor: 'primeiro_nome', rotulo: 'Primeiro nome' },
    { valor: 'empresa', rotulo: 'Empresa' },
    { valor: 'cargo', rotulo: 'Cargo' },
    { valor: 'categoria', rotulo: 'Categoria (VISITANTE, PALESTRANTE…)' },
    { valor: 'codigo', rotulo: 'Código do convite' },
    { valor: 'mesa', rotulo: 'Mesa / assento' },
    { valor: 'evento', rotulo: 'Nome do evento' },
  ];

  const FONTES = [
    'Arial, Helvetica, sans-serif',
    'Roboto, Arial, sans-serif',
    '"Arial Narrow", "Roboto Condensed", Arial, sans-serif',
    'Verdana, Arial, sans-serif',
    'Tahoma, Arial, sans-serif',
    '"Trebuchet MS", Arial, sans-serif',
    'Georgia, "Times New Roman", serif',
    '"Courier New", monospace',
  ];

  // ── Código de barras CODE 128 (subconjuntos B e C) ──
  const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
    '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 ' +
    '111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
    '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 ' +
    '141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 ' +
    '124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 ' +
    '311141 411131 211412 211214 211232 2331112').split(' ');

  /** Larguras (em módulos) das barras/espaços alternados, começando por barra */
  function code128(texto) {
    const s = String(texto).replace(/[^\x20-\x7e]/g, '');
    if (!s) return null;
    const soDigitos = /^\d+$/.test(s) && s.length % 2 === 0 && s.length >= 4;
    const codigos = [];
    if (soDigitos) { codigos.push(105); for (let i = 0; i < s.length; i += 2) codigos.push(Number(s.substr(i, 2))); }
    else { codigos.push(104); for (const ch of s) codigos.push(ch.charCodeAt(0) - 32); }
    let soma = codigos[0];
    for (let i = 1; i < codigos.length; i++) soma += codigos[i] * i;
    codigos.push(soma % 103, 106);
    return codigos.map(c => C128[c]).join('').split('').map(Number);
  }

  // Tamanhos comuns de etiqueta térmica (largura × altura, mm)
  const TAMANHOS = [[100, 50], [100, 70], [90, 50], [80, 40], [70, 40], [60, 40], [60, 30], [50, 30], [100, 150]];

  const EXEMPLO = {
    nome: 'Helena Albuquerque Silva', empresa: 'Distribuidora Exemplo Ltda.', cargo: 'Executiva de Vendas',
    categoria: 'CONVIDADO', codigo: '958958', evento: 'Evento de Teste', qr: 'https://convites.mais.tur.br/convite/exemplo',
  };

  /** Modelo padrão proporcional ao tamanho: nome em destaque, empresa, cargo, faixa de categoria e QR à direita */
  function modeloPadrao(largura = 100, altura = 50, { comQr = true } = {}) {
    const m = Math.max(2, Math.round(Math.min(largura, altura) * 0.06));
    const qr = comQr ? Math.round(Math.min(altura * 0.62, largura * 0.32)) : 0;
    const larguraTexto = largura - 2 * m - (qr ? qr + m : 0);
    const h = altura - 2 * m;
    const pt = mm => Math.round(mm / PT_MM * 0.78);
    const els = [
      { id: 'nome', tipo: 'campo', campo: 'nome', x: m, y: m, w: larguraTexto, h: h * 0.36, fonte: pt(h * 0.2), negrito: true, alinhar: 'left', maiusculas: true, ajustar: true, linhas: 2 },
      { id: 'empresa', tipo: 'campo', campo: 'empresa', x: m, y: m + h * 0.38, w: larguraTexto, h: h * 0.2, fonte: pt(h * 0.13), negrito: false, alinhar: 'left', maiusculas: true, ajustar: true, linhas: 2 },
      { id: 'cargo', tipo: 'campo', campo: 'cargo', x: m, y: m + h * 0.59, w: larguraTexto, h: h * 0.13, fonte: pt(h * 0.1), negrito: false, alinhar: 'left', maiusculas: false, ajustar: true, linhas: 1 },
      { id: 'categoria', tipo: 'campo', campo: 'categoria', x: m, y: m + h * 0.78, w: larguraTexto, h: h * 0.22, fonte: pt(h * 0.14), negrito: true, alinhar: 'center', maiusculas: true, ajustar: true, linhas: 1, inverter: true },
    ];
    if (qr) {
      els.push({ id: 'qr', tipo: 'qrcode', x: largura - m - qr, y: m, tamanho: qr });
      els.push({ id: 'codigo', tipo: 'campo', campo: 'codigo', x: largura - m - qr, y: m + qr + 0.5, w: qr, h: Math.max(3, h - qr - 0.5), fonte: pt(Math.min(3.2, h * 0.08)), negrito: true, alinhar: 'center', maiusculas: true, ajustar: true, linhas: 1 });
    }
    return {
      largura, altura, rotacao: 0, ajusteX: 0, ajusteY: 0, escurecimento: 0, dpmm: 8,
      fonte: 'Arial, Helvetica, sans-serif',
      elementos: els.map(e => ({ ...e, x: r1(e.x), y: r1(e.y), w: e.w && r1(e.w), h: e.h && r1(e.h) })),
    };
  }
  const r1 = n => Math.round(n * 10) / 10;

  function valorCampo(dados, campo) {
    if (campo === 'primeiro_nome') return String(dados.nome || '').trim().split(/\s+/)[0] || '';
    return dados[campo] ?? '';
  }

  // ── Texto: quebra em linhas e reduz a fonte até caber na caixa ──
  function quebrar(ctx, texto, larguraMax, maxLinhas) {
    const palavras = texto.split(/\s+/).filter(Boolean);
    const linhas = [];
    let atual = '';
    for (const p of palavras) {
      const t = atual ? atual + ' ' + p : p;
      if (ctx.measureText(t).width <= larguraMax || !atual) atual = t;
      else { linhas.push(atual); atual = p; }
    }
    if (atual) linhas.push(atual);
    if (linhas.length > maxLinhas) {
      const cab = linhas.slice(0, maxLinhas - 1);
      cab.push(linhas.slice(maxLinhas - 1).join(' '));
      return cab;
    }
    return linhas;
  }

  function encaixar(ctx, texto, el, familia, px) {
    let pt = el.fonte || 12;
    const maxLinhas = Math.max(1, el.linhas || 1);
    const folga = el.inverter ? 2 : 0; // mm de respiro na faixa invertida
    for (;;) {
      ctx.font = `${el.negrito ? 700 : 400} ${pt * PT_MM * px}px ${familia}`;
      const linhas = maxLinhas === 1 ? [texto] : quebrar(ctx, texto, (el.w - folga) * px, maxLinhas);
      const larg = Math.max(...linhas.map(l => ctx.measureText(l).width)) / px;
      const alt = linhas.length * pt * PT_MM * 1.12;
      if ((larg <= el.w - folga + 0.01 && alt <= el.h + 0.01) || !el.ajustar || pt <= 5) return { pt, linhas };
      pt = Math.round((pt - 0.5) * 10) / 10;
    }
  }

  /**
   * Desenha a etiqueta num canvas na resolução da impressora (dpmm pontos por mm) e já em
   * preto e branco puro (é exatamente o que sai na térmica).
   * dados.qr_matriz = { n, bits } (gerado no servidor) para o QR code.
   * Retorna o canvas final, já com rotação e ajuste fino aplicados.
   */
  function desenhar(modelo, dados, destino) {
    const px = modelo.dpmm || 8;
    const W = Math.round(modelo.largura * px), H = Math.round(modelo.altura * px);
    const base = document.createElement('canvas');
    base.width = W; base.height = H;
    const ctx = base.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate((modelo.ajusteX || 0) * px, (modelo.ajusteY || 0) * px);
    const familia = modelo.fonte || 'Arial, Helvetica, sans-serif';

    const categoria = String(dados.categoria || '').trim().toLocaleUpperCase('pt-BR');
    for (const el of modelo.elementos || []) {
      if (el.oculto) continue;
      // Elemento que só aparece para certas categorias (ex.: faixa PALESTRANTE)
      if (el.soCategorias?.length && !el.soCategorias.some(c => String(c).trim().toLocaleUpperCase('pt-BR') === categoria)) continue;
      const x = el.x * px, y = el.y * px;
      if (el.tipo === 'codigobarras') {
        const valor = el.campo ? valorCampo(dados, el.campo) : dados.codigo;
        const barras = code128(valor || '');
        if (!barras) continue;
        const total = barras.reduce((a, b) => a + b, 0);
        const altTexto = el.mostrarTexto ? Math.min(el.h * 0.3, 3.2) * px : 0;
        const modulo = (el.w * px) / total;
        ctx.fillStyle = '#000';
        let cx = x;
        barras.forEach((larg, i) => { if (i % 2 === 0) ctx.fillRect(Math.round(cx), y, Math.max(1, Math.round(cx + larg * modulo) - Math.round(cx)), el.h * px - altTexto); cx += larg * modulo; });
        if (altTexto) {
          ctx.font = `400 ${altTexto * 0.85}px ${familia}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(String(valor), x + el.w * px / 2, y + el.h * px);
        }
        continue;
      }
      if (el.tipo === 'qrcode') {
        const q = dados.qr_matriz;
        if (!q || !q.n) continue;
        const lado = el.tamanho * px, mod = lado / q.n;
        ctx.fillStyle = '#000';
        for (let i = 0; i < q.n; i++) for (let j = 0; j < q.n; j++) {
          if (q.bits[i * q.n + j] === '1') ctx.fillRect(Math.floor(x + j * mod), Math.floor(y + i * mod), Math.ceil(mod), Math.ceil(mod));
        }
        continue;
      }
      if (el.tipo === 'caixa') {
        const esp = (el.borda || 0.4) * px, raio = Math.max(0, (el.raio || 0) * px);
        ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; ctx.lineWidth = esp;
        ctx.beginPath();
        const ix = el.preencher ? x : x + esp / 2, iy = el.preencher ? y : y + esp / 2;
        const iw = el.w * px - (el.preencher ? 0 : esp), ih = el.h * px - (el.preencher ? 0 : esp);
        if (ctx.roundRect) ctx.roundRect(ix, iy, iw, ih, Math.min(raio, iw / 2, ih / 2)); else ctx.rect(ix, iy, iw, ih);
        if (el.preencher) ctx.fill(); else ctx.stroke();
        continue;
      }
      let texto = el.tipo === 'texto' ? (el.texto || '') : valorCampo(dados, el.campo);
      texto = String(texto).trim().replace(/\s+/g, ' ');
      if (el.maiusculas) texto = texto.toLocaleUpperCase('pt-BR');
      if (!texto) continue;
      const { pt, linhas } = encaixar(ctx, texto, el, familia, px);
      const alturaLinha = pt * PT_MM * 1.12 * px;
      const blocoAlt = linhas.length * alturaLinha;
      if (el.inverter) {
        ctx.fillStyle = '#000'; ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, el.w * px, el.h * px, Math.min((el.raio ?? 1) * px, el.h * px / 2)); else ctx.rect(x, y, el.w * px, el.h * px);
        ctx.fill();
      }
      ctx.fillStyle = el.inverter ? '#fff' : '#000';
      ctx.textBaseline = 'middle';
      ctx.textAlign = el.alinhar === 'center' ? 'center' : el.alinhar === 'right' ? 'right' : 'left';
      const folga = el.inverter ? px : 0;
      const tx = el.alinhar === 'center' ? x + el.w * px / 2 : el.alinhar === 'right' ? x + el.w * px - folga : x + folga;
      const topo = el.valign === 'top' ? y : el.valign === 'bottom' ? y + el.h * px - blocoAlt : y + (el.h * px - blocoAlt) / 2;
      linhas.forEach((l, i) => ctx.fillText(l, tx, topo + alturaLinha * (i + 0.5)));
    }
    ctx.restore();
    monocromatico(base);

    // Rotação (impressoras que alimentam a etiqueta "deitada")
    const rot = ((Number(modelo.rotacao) || 0) % 360 + 360) % 360;
    const final = destino || document.createElement('canvas');
    const troca = rot === 90 || rot === 270;
    final.width = troca ? H : W; final.height = troca ? W : H;
    const c2 = final.getContext('2d');
    c2.fillStyle = '#fff'; c2.fillRect(0, 0, final.width, final.height);
    c2.save();
    if (rot === 90) { c2.translate(H, 0); c2.rotate(Math.PI / 2); }
    else if (rot === 180) { c2.translate(W, H); c2.rotate(Math.PI); }
    else if (rot === 270) { c2.translate(0, W); c2.rotate(-Math.PI / 2); }
    c2.drawImage(base, 0, 0);
    c2.restore();
    return final;
  }

  function monocromatico(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) < 150 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Converte o canvas (preto e branco) num comando ZPL com o gráfico da etiqueta */
  function paraZpl(canvas, { escurecimento = 0, copias = 1 } = {}) {
    const w = canvas.width, h = canvas.height;
    const bpl = Math.ceil(w / 8);
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const hex = new Array(h);
    const HEXA = '0123456789ABCDEF';
    for (let y = 0; y < h; y++) {
      let linha = '';
      for (let b = 0; b < bpl; b++) {
        let byte = 0;
        for (let k = 0; k < 8; k++) {
          const x = b * 8 + k;
          if (x < w && d[(y * w + x) * 4] < 128) byte |= 0x80 >> k; // 1 = ponto preto
        }
        linha += HEXA[byte >> 4] + HEXA[byte & 15];
      }
      hex[y] = linha;
    }
    const total = bpl * h;
    const md = Math.max(-30, Math.min(30, Math.round(Number(escurecimento) || 0)));
    return `^XA^PW${w}^LL${h}^LH0,0^MD${md}^FO0,0^GFA,${total},${total},${bpl},${hex.join('')}^FS^PQ${Math.max(1, copias | 0)}^XZ`;
  }

  /** Etiqueta de calibração: borda, cruz central e régua a cada 5 mm */
  function desenharCalibracao(modelo) {
    const px = modelo.dpmm || 8;
    const W = Math.round(modelo.largura * px), H = Math.round(modelo.altura * px);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate((modelo.ajusteX || 0) * px, (modelo.ajusteY || 0) * px);
    ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
    for (let x = 5; x < modelo.largura; x += 5) ctx.fillRect(x * px, 0, 2, (x % 10 ? 2 : 4) * px);
    for (let y = 5; y < modelo.altura; y += 5) ctx.fillRect(0, y * px, (y % 10 ? 2 : 4) * px, 2);
    ctx.setLineDash([8, 8]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `700 ${4 * px}px Arial`; ctx.textBaseline = 'top';
    ctx.fillText(`${modelo.largura} × ${modelo.altura} mm`, 6 * px, 6 * px);
    ctx.font = `400 ${2.6 * px}px Arial`;
    ctx.fillText(`ajuste X ${modelo.ajusteX || 0} · Y ${modelo.ajusteY || 0} · rotação ${modelo.rotacao || 0}°`, 6 * px, 11.5 * px);
    ctx.restore();
    monocromatico(c);
    const rot = ((Number(modelo.rotacao) || 0) % 360 + 360) % 360;
    if (!rot) return c;
    const f = document.createElement('canvas');
    const troca = rot === 90 || rot === 270;
    f.width = troca ? H : W; f.height = troca ? W : H;
    const c2 = f.getContext('2d'); c2.fillStyle = '#fff'; c2.fillRect(0, 0, f.width, f.height);
    if (rot === 90) { c2.translate(H, 0); c2.rotate(Math.PI / 2); }
    else if (rot === 180) { c2.translate(W, H); c2.rotate(Math.PI); }
    else if (rot === 270) { c2.translate(0, W); c2.rotate(-Math.PI / 2); }
    c2.drawImage(c, 0, 0);
    return f;
  }

  // ── Impressora por USB (WebUSB) ──
  const ZEBRA = 0x0a5f;
  const usb = {
    dispositivo: null, interfaceNum: null, saida: null,
    suportado: () => !!(global.navigator && navigator.usb) && global.isSecureContext,
    get conectada() { return !!(this.dispositivo && this.dispositivo.opened && this.saida != null); },
    get nome() { return this.dispositivo ? (this.dispositivo.productName || 'Impressora USB') : ''; },

    async abrir(dev) {
      if (!dev.opened) await dev.open();
      if (dev.configuration === null) await dev.selectConfiguration(1);
      for (const itf of dev.configuration.interfaces) {
        for (const alt of itf.alternates) {
          const ep = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
          if (ep) {
            if (!itf.claimed) await dev.claimInterface(itf.interfaceNumber);
            this.dispositivo = dev; this.interfaceNum = itf.interfaceNumber; this.saida = ep.endpointNumber;
            return dev;
          }
        }
      }
      throw new Error('Este aparelho USB não tem saída de dados de impressora.');
    },

    /** Pede ao usuário para escolher a impressora (precisa de um toque/clique) */
    async escolher() {
      if (!this.suportado()) throw new Error(global.isSecureContext ? 'Este navegador não tem WebUSB. Use o Google Chrome.' : 'A impressão USB exige o endereço com https://.');
      const dev = await navigator.usb.requestDevice({ filters: [{ vendorId: ZEBRA }, { classCode: 7 }] });
      return this.abrir(dev);
    },

    /** Reconecta sozinho a uma impressora já autorizada antes (sem toque) */
    async reconectar() {
      if (!this.suportado()) return null;
      const devs = await navigator.usb.getDevices();
      const dev = devs.find(d => d.vendorId === ZEBRA) || devs[0];
      if (!dev) return null;
      try { return await this.abrir(dev); } catch { return null; }
    },

    async enviar(texto) {
      if (!this.conectada) throw new Error('Impressora não conectada.');
      const bytes = new TextEncoder().encode(texto);
      for (let i = 0; i < bytes.length; i += 16384) {
        const r = await this.dispositivo.transferOut(this.saida, bytes.subarray(i, i + 16384));
        if (r.status !== 'ok') throw new Error('Falha ao enviar para a impressora (' + r.status + ').');
      }
    },

    aoMudar(fn) {
      if (!this.suportado()) return;
      navigator.usb.addEventListener('disconnect', e => { if (e.device === this.dispositivo) { this.dispositivo = null; this.saida = null; } fn('desconectada'); });
      navigator.usb.addEventListener('connect', async () => { await this.reconectar(); fn(this.conectada ? 'conectada' : 'desconectada'); });
    },
  };

  /** Imprime pela janela do navegador (alternativa; no Windows com Chrome --kiosk-printing sai direto) */
  function imprimirNavegador(canvas, modelo) {
    const rot = ((Number(modelo.rotacao) || 0) % 360 + 360) % 360;
    const troca = rot === 90 || rot === 270;
    const lw = troca ? modelo.altura : modelo.largura, lh = troca ? modelo.largura : modelo.altura;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${lw}mm ${lh}mm;margin:0}html,body{margin:0}img{width:${lw}mm;height:${lh}mm;display:block;image-rendering:pixelated}</style></head><body><img src="${canvas.toDataURL('image/png')}"></body></html>`);
    doc.close();
    return new Promise(resolve => {
      const img = doc.querySelector('img');
      const ir = () => { iframe.contentWindow.focus(); iframe.contentWindow.print(); setTimeout(() => { iframe.remove(); resolve(); }, 1500); };
      if (img.complete) setTimeout(ir, 100); else img.onload = () => setTimeout(ir, 100);
    });
  }

  /** Imprime várias etiquetas de uma vez pela janela do navegador (uma por página) */
  function imprimirNavegadorLote(canvases, modelo) {
    const rot = ((Number(modelo.rotacao) || 0) % 360 + 360) % 360;
    const troca = rot === 90 || rot === 270;
    const lw = troca ? modelo.altura : modelo.largura, lh = troca ? modelo.largura : modelo.altura;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${lw}mm ${lh}mm;margin:0}html,body{margin:0}img{width:${lw}mm;height:${lh}mm;display:block;image-rendering:pixelated;break-after:page}img:last-child{break-after:auto}</style></head><body>${canvases.map(c => `<img src="${c.toDataURL('image/png')}">`).join('')}</body></html>`);
    doc.close();
    return new Promise(resolve => setTimeout(() => { iframe.contentWindow.focus(); iframe.contentWindow.print(); setTimeout(() => { iframe.remove(); resolve(); }, 1500); }, 300));
  }

  /** Garante que um modelo salvo tenha todos os campos (modelos antigos / importados) */
  function normalizar(m) {
    const base = modeloPadrao(Number(m?.largura) || 100, Number(m?.altura) || 50);
    const r = { ...base, ...(m || {}) };
    r.elementos = Array.isArray(m?.elementos) ? m.elementos.map((e, i) => ({ id: e.id || 'el' + (i + 1), ...e })) : base.elementos;
    r.dpmm = 8;
    return r;
  }

  global.Etiqueta = { CAMPOS, FONTES, TAMANHOS, EXEMPLO, modeloPadrao, normalizar, desenhar, desenharCalibracao, paraZpl, usb, imprimirNavegador, imprimirNavegadorLote, valorCampo, code128 };
})(typeof window !== 'undefined' ? window : globalThis);
