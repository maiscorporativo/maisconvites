'use strict';
// Mapa interativo de mesas (SVG): hover mostra ocupantes; arrastar reorganiza (modo editável)

function criarMapa(container, opcoes = {}) {
  const { editavel = false, aoMover = null, aoClicar = null } = opcoes;
  let mesas = [], ocupantes = [];

  container.classList.add('mapa-envoltorio');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  container.appendChild(svg);

  const dica = document.createElement('div');
  dica.className = 'dica-mesa oculto';
  container.appendChild(dica);

  let arrasto = null; // { mesa, grupo, dx, dy, moveu }

  function dimensoes() {
    const maxX = Math.max(600, ...mesas.map(m => m.x + 120));
    const maxY = Math.max(400, ...mesas.map(m => m.y + 120));
    svg.setAttribute('width', maxX);
    svg.setAttribute('height', maxY);
    svg.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
    return { maxX, maxY };
  }

  function ocupantesDa(mesaId) {
    return ocupantes.filter(o => o.mesa_id === mesaId).sort((a, b) => (a.cadeira || 0) - (b.cadeira || 0));
  }

  function mostrarDica(mesa, evt) {
    const ocs = ocupantesDa(mesa.id);
    const titulo = `Mesa ${mesa.numero}${mesa.nome ? ' — ' + esc(mesa.nome) : ''}`;
    let html = `<h4>${titulo} <small>(${ocs.length}/${mesa.capacidade})</small></h4>`;
    if (!ocs.length) {
      html += `<div class="vazio">Mesa livre</div>`;
    } else {
      html += '<ul>' + ocs.map(o =>
        `<li>${o.cadeira ? `<strong>${o.cadeira}.</strong> ` : ''}${esc(o.nome)}${o.empresa_nome ? ` <span style="color:#f7ad40">· ${esc(o.empresa_nome)}</span>` : ''}</li>`
      ).join('') + '</ul>';
    }
    dica.innerHTML = html;
    dica.classList.remove('oculto');
    posicionarDica(evt);
  }

  function posicionarDica(evt) {
    const r = container.getBoundingClientRect();
    let x = evt.clientX - r.left + container.scrollLeft + 16;
    let y = evt.clientY - r.top + container.scrollTop + 16;
    if (x + 260 > container.scrollLeft + container.clientWidth) x -= 280;
    dica.style.left = x + 'px';
    dica.style.top = y + 'px';
  }

  function esconderDica() { dica.classList.add('oculto'); }

  function pontoSvg(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  function desenhar() {
    svg.innerHTML = '';
    const { maxX } = dimensoes();

    // Palco / referência do salão
    const palco = document.createElementNS(NS, 'rect');
    palco.setAttribute('x', maxX / 2 - 130); palco.setAttribute('y', 8);
    palco.setAttribute('width', 260); palco.setAttribute('height', 30);
    palco.setAttribute('rx', 8);
    palco.classList.add('palco');
    svg.appendChild(palco);
    const palcoTxt = document.createElementNS(NS, 'text');
    palcoTxt.setAttribute('x', maxX / 2); palcoTxt.setAttribute('y', 28);
    palcoTxt.classList.add('palco-texto');
    palcoTxt.textContent = 'PALCO / ENTRADA';
    svg.appendChild(palcoTxt);

    for (const mesa of mesas) {
      const g = document.createElementNS(NS, 'g');
      g.classList.add('mesa-grupo');
      g.setAttribute('transform', `translate(${mesa.x},${mesa.y})`);
      const ocs = ocupantesDa(mesa.id);
      if (ocs.length >= mesa.capacidade) g.classList.add('mesa-cheia');

      let forma;
      if (mesa.formato === 'retangular') {
        forma = document.createElementNS(NS, 'rect');
        forma.setAttribute('x', -55); forma.setAttribute('y', -32);
        forma.setAttribute('width', 110); forma.setAttribute('height', 64);
        forma.setAttribute('rx', 10);
      } else {
        forma = document.createElementNS(NS, 'circle');
        forma.setAttribute('r', 44);
      }
      forma.classList.add('mesa-forma');
      g.appendChild(forma);

      const num = document.createElementNS(NS, 'text');
      num.classList.add('mesa-numero');
      num.setAttribute('y', 2);
      num.textContent = mesa.numero;
      g.appendChild(num);

      const lot = document.createElementNS(NS, 'text');
      lot.classList.add('mesa-lotacao');
      lot.setAttribute('y', 20);
      lot.textContent = `${ocs.length}/${mesa.capacidade}`;
      g.appendChild(lot);

      g.addEventListener('pointerenter', e => { if (!arrasto) mostrarDica(mesa, e); });
      g.addEventListener('pointermove', e => { if (!arrasto) posicionarDica(e); });
      g.addEventListener('pointerleave', esconderDica);

      g.addEventListener('pointerdown', e => {
        if (!editavel) return;
        e.preventDefault();
        const p = pontoSvg(e);
        arrasto = { mesa, grupo: g, dx: p.x - mesa.x, dy: p.y - mesa.y, moveu: false };
        g.setPointerCapture(e.pointerId);
        esconderDica();
      });
      g.addEventListener('pointermove', e => {
        if (!arrasto || arrasto.mesa !== mesa) return;
        const p = pontoSvg(e);
        const nx = Math.max(60, p.x - arrasto.dx);
        const ny = Math.max(60, p.y - arrasto.dy);
        if (Math.abs(nx - mesa.x) > 2 || Math.abs(ny - mesa.y) > 2) arrasto.moveu = true;
        mesa.x = nx; mesa.y = ny;
        g.setAttribute('transform', `translate(${nx},${ny})`);
      });
      g.addEventListener('pointerup', () => {
        if (!arrasto || arrasto.mesa !== mesa) return;
        const foiArrasto = arrasto.moveu;
        arrasto = null;
        if (foiArrasto) {
          if (aoMover) aoMover(mesa.id, Math.round(mesa.x), Math.round(mesa.y));
          dimensoes();
        } else if (aoClicar) {
          aoClicar(mesa);
        }
      });
      if (!editavel && aoClicar) {
        g.addEventListener('click', () => aoClicar(mesa));
      }

      svg.appendChild(g);
    }
  }

  return {
    atualizar(novasMesas, novosOcupantes) {
      mesas = novasMesas || [];
      ocupantes = novosOcupantes || [];
      desenhar();
    },
  };
}
