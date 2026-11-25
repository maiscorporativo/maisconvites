'use strict';
// Reconhecimento facial no navegador (face-api, servido do nosso próprio servidor em /vendor).
// Usado no convite (cadastro da selfie) e no totem (reconhecimento). Transforma um rosto numa
// "assinatura" de 128 números; a comparação com os cadastros é feita no servidor.
(function () {
  const BASE = '/vendor/face-api';
  let carregando = null;

  function carregarScript(src) {
    return new Promise((ok, erro) => {
      if (window.faceapi) return ok();
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => ok(); s.onerror = () => erro(new Error('Não foi possível carregar o reconhecimento facial. Verifique a internet.'));
      document.head.appendChild(s);
    });
  }

  /** Carrega biblioteca + modelos (~7 MB na 1ª vez; depois fica no cache). */
  function carregar(aoProgresso = () => {}) {
    if (carregando) return carregando;
    carregando = (async () => {
      aoProgresso('Carregando o reconhecimento facial…');
      await carregarScript(BASE + '/face-api.js');
      const fa = window.faceapi;
      try { await fa.tf.setBackend('webgl'); } catch { /* usa o padrão */ }
      if (fa.tf.getBackend() !== 'webgl') { try { await fa.tf.setBackend('cpu'); } catch {} }
      await fa.tf.ready();
      aoProgresso('Preparando os modelos (só na primeira vez demora mais)…');
      const m = BASE + '/model';
      await Promise.all([
        fa.nets.tinyFaceDetector.loadFromUri(m),
        fa.nets.faceLandmark68Net.loadFromUri(m),
        fa.nets.faceRecognitionNet.loadFromUri(m),
      ]);
      // "Aquece" a GPU: a 1ª inferência é lenta; melhor que aconteça agora
      const c = document.createElement('canvas'); c.width = c.height = 160;
      try { await fa.detectAllFaces(c, new fa.TinyFaceDetectorOptions({ inputSize: 160 })).withFaceLandmarks(); } catch {}
      return fa;
    })();
    carregando.catch(() => { carregando = null; });
    return carregando;
  }

  const area = b => b.width * b.height;

  /**
   * Detecta o MAIOR rosto da imagem (quem está na frente) com os pontos do rosto.
   * Retorna { caixa, score, pontos, alinhado, quantos } ou null.
   */
  // Rosto de perto (selfie, totem) é achado com mais confiança em resolução menor (224/160);
  // por isso tenta em sequência até encontrar.
  async function detectar(fonte, { tamanhos = [224, 160, 320], minScore = 0.4 } = {}) {
    const fa = await carregar();
    let r = [];
    for (const t of tamanhos) {
      r = await fa.detectAllFaces(fonte, new fa.TinyFaceDetectorOptions({ inputSize: t, scoreThreshold: minScore })).withFaceLandmarks();
      if (r.length) break;
    }
    if (!r.length) return null;
    r.sort((a, b) => area(b.detection.box) - area(a.detection.box));
    const p = r[0];
    return { caixa: p.detection.box, score: p.detection.score, pontos: p.landmarks, alinhado: p.alignedRect, quantos: r.length, _fonte: fonte };
  }

  /** Assinatura (128 números) do rosto já detectado */
  async function descritor(det) {
    const fa = await carregar();
    const [rosto] = await fa.extractFaces(det._fonte, [det.alinhado]);
    const d = await fa.computeFaceDescriptor(rosto);
    return Array.from(d);
  }

  function dimensoes(fonte) {
    return { w: fonte.videoWidth || fonte.naturalWidth || fonte.width, h: fonte.videoHeight || fonte.naturalHeight || fonte.height };
  }

  /**
   * O rosto está bom para ler? Devolve { ok, dica }.
   * Medidas relativas à imagem analisada — use capturarVisivel() para que sejam relativas
   * ao que a pessoa VÊ na tela.
   *  tamanhoMin/tamanhoMax: fração da largura ocupada pelo rosto
   *  folga: quanto o centro do rosto pode se afastar do centro (fração da imagem)
   *  centroY: altura ideal do centro do rosto (0,5 = meio; menor = mais para cima)
   */
  function avaliar(det, fonte, { tamanhoMin = 0.22, tamanhoMax = 0.92, folga = 0.28, centroY = 0.5, umSo = false } = {}) {
    if (!det) return { ok: false, dica: 'Posicione seu rosto no quadro' };
    if (umSo && det.quantos > 1) return { ok: false, dica: 'Só uma pessoa na foto, por favor' };
    const { w, h } = dimensoes(fonte);
    const b = det.caixa;
    if (b.width / w < tamanhoMin) return { ok: false, dica: 'Aproxime-se um pouco' };
    if (b.width / w > tamanhoMax) return { ok: false, dica: 'Afaste-se um pouco' };
    const cx = (b.x + b.width / 2) / w, cy = (b.y + b.height / 2) / h;
    if (Math.abs(cx - 0.5) > folga || Math.abs(cy - centroY) > folga) return { ok: false, dica: 'Centralize o rosto no quadro' };
    // a caixa inteira do rosto precisa estar dentro da imagem (nada cortado)
    if (b.x < 0 || b.y < 0 || b.x + b.width > w || b.y + b.height > h) return { ok: false, dica: 'Centralize o rosto no quadro' };
    // De frente: o nariz fica no meio dos olhos
    const pts = det.pontos.positions;
    const olhoE = media(pts.slice(36, 42)), olhoD = media(pts.slice(42, 48)), nariz = pts[30];
    const entreOlhos = Math.hypot(olhoD.x - olhoE.x, olhoD.y - olhoE.y);
    const desvio = Math.abs(nariz.x - (olhoE.x + olhoD.x) / 2) / entreOlhos;
    const inclinacao = Math.abs(Math.atan2(olhoD.y - olhoE.y, olhoD.x - olhoE.x)) * 180 / Math.PI;
    if (desvio > 0.22 || inclinacao > 18) return { ok: false, dica: 'Olhe de frente para a câmera' };
    if (det.score < 0.5) return { ok: false, dica: 'Melhore a iluminação do rosto' };
    return { ok: true, dica: '' };
  }

  function media(pts) { let x = 0, y = 0; for (const p of pts) { x += p.x; y += p.y; } return { x: x / pts.length, y: y / pts.length }; }

  // ── Piscada (prova de vida): razão de abertura dos olhos (EAR) ──
  function ear(pontos) {
    const p = pontos.positions;
    const d = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);
    const e1 = (d(37, 41) + d(38, 40)) / (2 * d(36, 39));
    const e2 = (d(43, 47) + d(44, 46)) / (2 * d(42, 45));
    return (e1 + e2) / 2;
  }
  /** Detecta uma piscada: olho aberto → fechado (≤ 72% do normal) → aberto de novo */
  function detectorPiscada() {
    let hist = [], fechou = false;
    return {
      alimentar(valor) {
        const t = performance.now();
        hist.push({ t, v: valor }); hist = hist.filter(h => t - h.t < 2500);
        const base = Math.max(...hist.map(h => h.v));
        if (base < 0.18 || hist.length < 3) return false;
        if (valor < base * 0.72) fechou = true;
        else if (fechou && valor > base * 0.88) { fechou = false; hist = []; return true; }
        return false;
      },
      zerar() { hist = []; fechou = false; },
    };
  }

  /**
   * Parte do vídeo que aparece na tela num elemento com object-fit: cover (centralizado).
   * Devolve o retângulo em coordenadas do vídeo.
   */
  function regiaoVisivel(video, elemento) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const ar = elemento.clientWidth / elemento.clientHeight || 1;
    let w = vw, h = vw / ar;
    if (h > vh) { h = vh; w = vh * ar; }
    return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  }

  /**
   * Copia para um canvas EXATAMENTE o que a pessoa vê no elemento (sem espelhar).
   * Detecção, assinatura e foto saem desse mesmo quadro → o que se vê é o que se grava.
   */
  function capturarVisivel(video, elemento, larguraMax = 640) {
    const r = regiaoVisivel(video, elemento);
    const esc = Math.min(1, larguraMax / r.w);
    const c = document.createElement('canvas');
    c.width = Math.round(r.w * esc); c.height = Math.round(r.h * esc);
    c.getContext('2d').drawImage(video, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    return c;
  }

  /** Foto do quadro capturado, como apareceu na tela (espelhada, igual a um espelho) */
  function fotoDoQuadro(quadro, { largura = 300, proporcao = null, espelhar = true, qualidade = 0.85 } = {}) {
    // proporcao (largura/altura) fixa o formato final; o desvio do arredondamento da tela é < 1%
    const c = document.createElement('canvas');
    c.width = largura; c.height = Math.round(largura / (proporcao || quadro.width / quadro.height));
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    if (espelhar) { cx.translate(c.width, 0); cx.scale(-1, 1); }
    cx.drawImage(quadro, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', qualidade);
  }

  /**
   * Recorte 3:4 centrado no rosto (foto enviada da galeria). Mantém o rosto no centro:
   * se o recorte passar da borda, ele é DESLOCADO para dentro (nunca encolhido num canto);
   * só encolhe — continuando centrado — se for maior que a própria imagem.
   */
  function recorteRosto(fonte, caixa, { largura = 300, proporcao = 3 / 4, fator = 2.1 } = {}) {
    const { w, h } = dimensoes(fonte);
    let rw = caixa.width * fator, rh = rw / proporcao;
    if (rw > w) { rw = w; rh = rw / proporcao; }
    if (rh > h) { rh = h; rw = rh * proporcao; }
    const cxr = caixa.x + caixa.width / 2, cyr = caixa.y + caixa.height * 0.45;
    const x = Math.min(Math.max(0, cxr - rw / 2), w - rw), y = Math.min(Math.max(0, cyr - rh / 2), h - rh);
    const c = document.createElement('canvas');
    c.width = largura; c.height = Math.round(largura / proporcao);
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(fonte, x, y, rw, rh, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  function distancia(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }

  /** Leituras coerentes entre si? (evita cadastrar com uma leitura ruim) */
  function coerentes(lista, max = 0.42) {
    for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) if (distancia(lista[i], lista[j]) > max) return false;
    return true;
  }

  window.Facial = { carregar, detectar, descritor, avaliar, ear, detectorPiscada, regiaoVisivel, capturarVisivel, fotoDoQuadro, recorteRosto, distancia, coerentes };
})();
