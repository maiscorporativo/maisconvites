'use strict';
// Convite: cadastro opcional do rosto para o credenciamento expresso no totem.
// Consentimento explícito (LGPD, dado biométrico), captura guiada e remoção a qualquer momento.
(function () {
  const token = location.pathname.split('/').filter(Boolean).pop();
  const API = '/api/convite/' + encodeURIComponent(token) + '/facial';
  let estado = null;

  const css = document.createElement('style');
  css.textContent = `
    .facial-cartao { border: 1.5px solid #e7dcc6; border-radius: 16px; padding: 18px 18px 16px; margin: 6px 0 26px; background: linear-gradient(180deg,#fffaf0,#fff); text-align: left; }
    .facial-cartao h3 { margin: 0 0 6px; font-size: 17px; color: var(--dourado-escuro, #9a6b12); }
    .facial-cartao p { margin: 0 0 10px; font-size: 14px; line-height: 1.5; }
    .facial-consent { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; line-height: 1.45; color: #4a4a4a; background: #f7f3ea; border-radius: 10px; padding: 10px 12px; margin: 10px 0 12px; cursor: pointer; }
    .facial-consent input { margin-top: 3px; width: 18px; height: 18px; flex: none; }
    .facial-ok { display: flex; gap: 14px; align-items: center; }
    .facial-ok img { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; border: 3px solid #16a34a; }
    .facial-acoes { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
    .facial-link { background: none; border: 0; color: #777; text-decoration: underline; font-size: 13px; cursor: pointer; padding: 6px 0; }
    .facial-modal { position: fixed; inset: 0; z-index: 9999; background: #04101f; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 20px; font-family: inherit; }
    .facial-quadro { position: relative; width: min(78vw, 360px); aspect-ratio: 3/4; border-radius: 50% / 42%; overflow: hidden; background: #000; box-shadow: 0 0 0 5px rgba(255,255,255,.18); transition: box-shadow .25s; }
    .facial-quadro.bom { box-shadow: 0 0 0 5px #4ade80; }
    .facial-quadro video, .facial-quadro img { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
    .facial-quadro img { transform: none; }
    .facial-dica { font-size: 19px; font-weight: 700; text-align: center; min-height: 28px; }
    .facial-sub { font-size: 14px; opacity: .7; text-align: center; max-width: 420px; }
    .facial-barra { width: min(78vw, 360px); height: 6px; border-radius: 6px; background: rgba(255,255,255,.15); overflow: hidden; }
    .facial-barra i { display: block; height: 100%; width: 0; background: #4ade80; transition: width .2s; }
    .facial-modal .botao-ouro, .facial-modal .botao-claro-f { font-size: 16px; padding: 13px 24px; border-radius: 12px; }
    .botao-claro-f { background: rgba(255,255,255,.12); color: #fff; border: 1px solid rgba(255,255,255,.25); cursor: pointer; font-weight: 600; }
  `;
  document.head.appendChild(css);

  function dataBrF(s) { return s ? s.split('-').reverse().join('/') : ''; }

  async function iniciar() {
    const area = document.getElementById('area-facial');
    if (!area) return;
    try {
      const r = await fetch(API, { cache: 'no-store' });
      if (!r.ok) return;
      estado = await r.json();
    } catch { return; }
    desenhar();
  }

  function desenhar(msg) {
    const area = document.getElementById('area-facial');
    if (!estado || (!estado.ativo && !estado.cadastrado)) { area.innerHTML = ''; return; }
    if (estado.cadastrado) {
      area.innerHTML = `<div class="facial-cartao">
        <div class="facial-ok">${estado.foto ? `<img src="${estado.foto}" alt="Sua foto cadastrada">` : ''}
          <div><h3>✅ Rosto cadastrado</h3>
          <p style="margin:0">No dia do evento, é só <b>olhar para o totem</b> na entrada. O QR code continua valendo.</p></div></div>
        <div class="facial-acoes">
          ${estado.ativo ? '<button class="facial-link" id="f-refazer">Tirar outra foto</button>' : ''}
          <button class="facial-link" id="f-remover">Remover meu cadastro facial</button></div>
        ${msg ? `<p style="margin-top:8px;color:#16a34a;font-size:13px">${msg}</p>` : ''}
      </div>`;
      const ref = document.getElementById('f-refazer'); if (ref) ref.onclick = () => abrirCaptura();
      document.getElementById('f-remover').onclick = remover;
      return;
    }
    area.innerHTML = `<div class="facial-cartao">
      <h3>⚡ Credenciamento expresso (opcional)</h3>
      <p>Cadastre uma selfie e, na entrada do evento, é só <b>olhar para o totem</b> — sem procurar o QR code no celular.</p>
      <label class="facial-consent"><input type="checkbox" id="f-consent">
        <span>Autorizo o uso da imagem do meu rosto (dado biométrico) <b>somente para o meu credenciamento neste evento</b>.
        Os dados não são compartilhados com terceiros e serão <b>apagados automaticamente${estado.apagar_ate ? ' até ' + dataBrF(estado.apagar_ate) : ' após o evento'}</b>.
        Posso remover o cadastro a qualquer momento nesta página.</span></label>
      <button class="botao-ouro" id="f-cadastrar" disabled style="opacity:.5">📸 Cadastrar meu rosto</button>
      ${msg ? `<p style="margin-top:10px;color:#b42318;font-size:13px">${msg}</p>` : ''}
    </div>`;
    const ch = document.getElementById('f-consent'), bt = document.getElementById('f-cadastrar');
    ch.onchange = () => { bt.disabled = !ch.checked; bt.style.opacity = ch.checked ? 1 : .5; };
    bt.onclick = () => { if (ch.checked) abrirCaptura(); };
  }

  async function remover() {
    if (!confirm('Remover o seu cadastro facial? No evento você usará o QR code do convite.')) return;
    try { await fetch(API, { method: 'DELETE' }); estado.cadastrado = false; estado.foto = ''; desenhar(); }
    catch { alert('Não foi possível remover agora. Tente de novo.'); }
  }

  // ── Captura guiada ──
  function abrirCaptura() {
    const F = window.Facial;
    const modal = document.createElement('div');
    modal.className = 'facial-modal';
    modal.innerHTML = `
      <div class="facial-quadro" id="f-quadro"><video id="f-video" playsinline muted autoplay></video></div>
      <div class="facial-barra"><i id="f-prog"></i></div>
      <div class="facial-dica" id="f-dica">Abrindo a câmera…</div>
      <div class="facial-sub" id="f-sub">Tire óculos escuros e boné. Procure um lugar bem iluminado.</div>
      <div class="facial-acoes" id="f-botoes"><button class="botao-claro-f" id="f-cancelar">Cancelar</button>
        <label class="botao-claro-f" style="display:inline-block">Enviar uma foto<input type="file" accept="image/*" capture="user" id="f-arquivo" hidden></label></div>`;
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';
    const $ = id => modal.querySelector('#' + id);
    let stream = null, ativo = true, leituras = [], ultimaLeitura = 0;

    const fechar = () => { ativo = false; if (stream) stream.getTracks().forEach(t => t.stop()); modal.remove(); document.body.style.overflow = ''; };
    $('f-cancelar').onclick = fechar;
    const dica = (t, bom = false) => { $('f-dica').textContent = t; $('f-quadro').classList.toggle('bom', bom); };

    $('f-arquivo').onchange = async e => {
      const arq = e.target.files[0]; if (!arq) return;
      ativo = false; if (stream) stream.getTracks().forEach(t => t.stop());
      dica('Analisando a foto…');
      try {
        await F.carregar();
        const img = new Image(); img.src = URL.createObjectURL(arq); await img.decode();
        const det = await F.detectar(img, { tamanhos: [224, 160, 320, 416] });
        const av = F.avaliar(det, img, { tamanhoMin: 0.12, umSo: true });
        if (!av.ok) { dica(det ? av.dica : 'Não encontramos um rosto nesta foto'); $('f-sub').textContent = 'Tente outra foto, de frente e bem iluminada.'; return; }
        revisar([await F.descritor(det)], F.miniatura(img, det.caixa));
      } catch (er) { dica(er.message || 'Não foi possível ler a foto'); }
    };

    (async () => {
      try {
        const carregou = F.carregar(t => { if (ativo) $('f-sub').textContent = t; });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } }, audio: false });
        const v = $('f-video'); v.srcObject = stream; await v.play();
        dica('Preparando…');
        await carregou;
        $('f-sub').textContent = 'Fique parado(a) olhando para a câmera.';
        laco(v);
      } catch (er) {
        dica(er.name === 'NotAllowedError' ? 'Permita o acesso à câmera' : 'Câmera indisponível');
        $('f-sub').textContent = 'Você também pode enviar uma foto de rosto, de frente.';
      }
    })();

    async function laco(v) {
      if (!ativo) return;
      try {
        const det = await F.detectar(v, { tamanhos: [224, 160] });
        const av = F.avaliar(det, v, { tamanhoMin: 0.3, umSo: true });
        if (!av.ok) { leituras = []; $('f-prog').style.width = '0'; dica(av.dica); }
        else if (performance.now() - ultimaLeitura > 220) {
          dica('Perfeito, fique parado(a)…', true);
          ultimaLeitura = performance.now();
          leituras.push({ d: await F.descritor(det), det });
          $('f-prog').style.width = (leituras.length / 3 * 100) + '%';
          if (leituras.length >= 3) {
            const ds = leituras.map(l => l.d);
            if (!F.coerentes(ds)) { leituras = []; dica('Fique parado(a), vamos de novo'); }
            else {
              ativo = false;
              const foto = F.miniatura(v, leituras[1].det.caixa, 200, true);
              stream.getTracks().forEach(t => t.stop());
              return revisar(ds, foto);
            }
          }
        }
      } catch {}
      if (ativo) setTimeout(() => laco(v), 60);
    }

    function revisar(descritores, foto) {
      $('f-quadro').innerHTML = `<img src="${foto}" alt="">`;
      $('f-quadro').classList.add('bom');
      $('f-prog').style.width = '100%';
      dica('Ficou bom?');
      $('f-sub').textContent = 'Seu rosto aparece nítido e de frente?';
      $('f-botoes').innerHTML = `<button class="botao-claro-f" id="f-outra">Tirar outra</button><button class="botao-ouro" id="f-usar">Usar esta foto</button>`;
      $('f-outra').onclick = () => { fechar(); abrirCaptura(); };
      $('f-usar').onclick = async () => {
        $('f-usar').disabled = true; dica('Salvando…');
        try {
          const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ descritores, foto, consentimento: true }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.erro || 'Não foi possível salvar.');
          estado.cadastrado = true; estado.foto = d.foto || foto;
          fechar(); desenhar('Pronto! Seu rosto foi cadastrado.');
        } catch (er) { dica(er.message); $('f-usar').disabled = false; }
      };
    }
  }

  // Espera o convite terminar de desenhar a página
  const espera = setInterval(() => { if (document.getElementById('area-facial')) { clearInterval(espera); iniciar(); } }, 150);
  setTimeout(() => clearInterval(espera), 15000);
})();
