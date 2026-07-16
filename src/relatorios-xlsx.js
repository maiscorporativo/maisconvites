'use strict';
// Geração dos relatórios em Excel (.xlsx) — espelham os relatórios de impressão

const XLSX = require('xlsx');
const { db } = require('./db');
const { linkConvite } = require('./mensagens');

const NOMES_STATUS = {
  pendente: 'Pendente', enviado: 'Convite enviado', confirmado: 'Confirmado',
  checkin: 'Presente (check-in)', cancelado: 'Cancelado',
};

const TITULOS = {
  geral: 'Lista geral', credenciamento: 'Credenciamento', empresas: 'Por empresa',
  mapa: 'Mapa de mesas', presenca: 'Presença', etiquetas: 'Convites e links',
};

function assento(c, mapaAtivo) {
  if (!mapaAtivo || c.mesa_numero == null) return '';
  return `Mesa ${c.mesa_numero}${c.cadeira != null ? ' · Cad. ' + c.cadeira : ''}`;
}

function buscarConvidados(eventoId, filtros) {
  let lista = db.prepare(`
    SELECT c.*, u.empresa_nome, m.numero AS mesa_numero, m.nome AS mesa_nome
    FROM convidados c
    LEFT JOIN usuarios u ON u.id = c.empresa_id
    LEFT JOIN mesas m ON m.id = c.mesa_id
    WHERE c.evento_id = ?
    ORDER BY u.empresa_nome, c.nome
  `).all(eventoId);
  lista = lista.filter(c => filtros.status ? c.status === filtros.status : c.status !== 'cancelado');
  if (filtros.empresa === 'individual') lista = lista.filter(c => !c.empresa_id);
  else if (filtros.empresa) lista = lista.filter(c => c.empresa_id === Number(filtros.empresa));
  return lista;
}

function aba(wb, nome, cabecalho, linhas, larguras) {
  const ws = XLSX.utils.aoa_to_sheet([cabecalho, ...linhas]);
  ws['!cols'] = (larguras || cabecalho.map(() => 18)).map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, nome.slice(0, 31));
}

/**
 * @returns {{buffer: Buffer, nomeArquivo: string}}
 */
function gerarRelatorioXlsx(tipo, evento, filtros = {}) {
  const mapaAtivo = evento.mapa_mesas !== 0;
  const wb = XLSX.utils.book_new();

  if (tipo === 'geral') {
    const lista = buscarConvidados(evento.id, filtros);
    aba(wb, 'Lista geral',
      ['#', 'Nome', 'Empresa', 'Cargo', 'E-mail', 'Telefone', ...(mapaAtivo ? ['Assento'] : []), 'Status'],
      lista.map((c, i) => [i + 1, c.nome, c.empresa_nome || 'Individual', c.cargo || '', c.email || '', c.telefone || '',
        ...(mapaAtivo ? [assento(c, mapaAtivo)] : []), NOMES_STATUS[c.status] || c.status]),
      [5, 28, 26, 18, 28, 18, ...(mapaAtivo ? [16] : []), 18]);
  } else if (tipo === 'credenciamento') {
    const lista = buscarConvidados(evento.id, filtros).sort((a, b) => a.nome.localeCompare(b.nome));
    aba(wb, 'Credenciamento',
      ['#', 'Nome', 'Empresa', ...(mapaAtivo ? ['Assento'] : []), 'Assinatura / Check'],
      lista.map((c, i) => [i + 1, c.nome, c.empresa_nome || 'Individual', ...(mapaAtivo ? [assento(c, mapaAtivo)] : []), '']),
      [5, 30, 26, ...(mapaAtivo ? [16] : []), 26]);
  } else if (tipo === 'empresas') {
    const empresas = db.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM convidados c WHERE c.empresa_id=u.id AND c.status!='cancelado') AS usados
      FROM usuarios u WHERE u.evento_id=? AND u.role='convidado_principal' ORDER BY u.empresa_nome
    `).all(evento.id);
    aba(wb, 'Empresas',
      ['Empresa', 'Responsável', 'Cargo', 'E-mail', 'Telefone', 'Cota', 'Usados', 'Disponíveis'],
      empresas.map(e => [e.empresa_nome, e.nome || '', e.cargo || '', e.email || '', e.telefone || '',
        e.cota, e.usados, Math.max(0, e.cota - e.usados)]),
      [28, 24, 18, 28, 18, 8, 8, 12]);
    const convidados = buscarConvidados(evento.id, {});
    aba(wb, 'Convidados por empresa',
      ['Empresa', 'Nome', 'Tipo', 'E-mail', 'Telefone', ...(mapaAtivo ? ['Assento'] : []), 'Status'],
      convidados.map(c => [c.empresa_nome || 'Individual', c.nome,
        c.tipo === 'responsavel' ? 'Responsável' : (c.tipo === 'individual' ? 'Individual' : 'Convidado'),
        c.email || '', c.telefone || '', ...(mapaAtivo ? [assento(c, mapaAtivo)] : []), NOMES_STATUS[c.status] || c.status]),
      [26, 28, 14, 28, 18, ...(mapaAtivo ? [16] : []), 18]);
  } else if (tipo === 'presenca') {
    const lista = buscarConvidados(evento.id, filtros);
    const presentes = lista.filter(c => c.status === 'checkin').length;
    aba(wb, 'Presença',
      ['Nome', 'Empresa', 'Confirmou em', 'Check-in em', 'Situação'],
      lista.map(c => [c.nome, c.empresa_nome || 'Individual', c.confirmado_em || '', c.checkin_em || '', NOMES_STATUS[c.status] || c.status]),
      [28, 26, 20, 20, 20]);
    aba(wb, 'Resumo',
      ['Indicador', 'Valor'],
      [['Inscritos', lista.length],
       ['Confirmaram', lista.filter(c => c.status === 'confirmado' || c.status === 'checkin').length],
       ['Presentes (check-in)', presentes],
       ['Comparecimento', lista.length ? Math.round(presentes / lista.length * 100) + '%' : '0%']],
      [24, 14]);
  } else if (tipo === 'mapa') {
    if (!mapaAtivo) throw new Error('O mapa de mesas está desativado neste evento.');
    const mesas = db.prepare(`SELECT * FROM mesas WHERE evento_id=? ORDER BY numero`).all(evento.id);
    const ocupantes = db.prepare(`
      SELECT c.nome, c.cadeira, c.mesa_id, u.empresa_nome
      FROM convidados c LEFT JOIN usuarios u ON u.id = c.empresa_id
      WHERE c.evento_id=? AND c.mesa_id IS NOT NULL AND c.status!='cancelado'
    `).all(evento.id);
    const linhas = [];
    for (const m of mesas) {
      const ocs = ocupantes.filter(o => o.mesa_id === m.id).sort((a, b) => (a.cadeira || 0) - (b.cadeira || 0));
      if (!ocs.length) linhas.push([m.numero, m.nome || '', m.capacidade, '', '(mesa livre)', '']);
      for (const o of ocs) linhas.push([m.numero, m.nome || '', m.capacidade, o.cadeira ?? '', o.nome, o.empresa_nome || 'Individual']);
    }
    aba(wb, 'Mapa de mesas',
      ['Mesa', 'Nome da mesa', 'Lugares', 'Cadeira', 'Convidado', 'Empresa'],
      linhas, [8, 20, 10, 10, 28, 26]);
  } else if (tipo === 'etiquetas') {
    const lista = buscarConvidados(evento.id, filtros);
    aba(wb, 'Convites e links',
      ['Nome', 'Empresa', 'Cargo', ...(mapaAtivo ? ['Assento'] : []), 'Status', 'Link do convite'],
      lista.map(c => [c.nome, c.empresa_nome || 'Individual', c.cargo || '',
        ...(mapaAtivo ? [assento(c, mapaAtivo)] : []), NOMES_STATUS[c.status] || c.status, linkConvite(c.token)]),
      [28, 26, 18, ...(mapaAtivo ? [16] : []), 18, 46]);
  } else {
    throw new Error('Tipo de relatório inválido.');
  }

  const slug = String(evento.nome).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return {
    buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
    nomeArquivo: `${tipo}-${slug}.xlsx`,
  };
}

module.exports = { gerarRelatorioXlsx, TITULOS };
