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
   * tamanhoMin: fração mínima da largura da imagem ocupada pelo rosto.
   */
  function avaliar(det, fonte, { tamanhoMin = 0.22, umSo = false } = {}) {
    if (!det) return { ok: false, dica: 'Posicione seu rosto no quadro' };
    if (umSo && det.quantos > 1) return { ok: false, dica: 'Só uma pessoa na foto, por favor' };
    const { w, h } = dimensoes(fonte);
    const b = det.caixa;
    if (b.width / w < tamanhoMin) return { ok: false, dica: 'Aproxime-se um pouco' };
    const cx = (b.x + b.width / 2) / w, cy = (b.y + b.height / 2) / h;
    if (cx < 0.22 || cx > 0.78 || cy < 0.18 || cy > 0.82) return { ok: false, dica: 'Centralize o rosto no quadro' };
    if (b.width / w > 0.92) return { ok: false, dica: 'Afaste-se um pouco' };
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

  /** Miniatura quadrada do rosto (JPEG ~10 KB) para conferência visual */
  function miniatura(fonte, caixa, lado = 200, espelhar = false) {
    const { w, h } = dimensoes(fonte);
    const m = Math.max(caixa.width, caixa.height) * 1.6;
    const x = Math.max(0, caixa.x + caixa.width / 2 - m / 2), y = Math.max(0, caixa.y + caixa.height / 2 - m / 2 - caixa.height * 0.08);
    const lw = Math.min(m, w - x), lh = Math.min(m, h - y), l = Math.min(lw, lh);
    const c = document.createElement('canvas'); c.width = c.height = lado;
    const cx = c.getContext('2d');
    if (espelhar) { cx.translate(lado, 0); cx.scale(-1, 1); }
    cx.drawImage(fonte, x, y, l, l, 0, 0, lado, lado);
    return c.toDataURL('image/jpeg', 0.82);
  }

  function distancia(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }

  /** Leituras coerentes entre si? (evita cadastrar com uma leitura ruim) */
  function coerentes(lista, max = 0.42) {
    for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) if (distancia(lista[i], lista[j]) > max) return false;
    return true;
  }

  window.Facial = { carregar, detectar, descritor, avaliar, ear, detectorPiscada, miniatura, distancia, coerentes };
})();
