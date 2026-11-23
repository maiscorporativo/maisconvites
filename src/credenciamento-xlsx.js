'use strict';
// Planilha da lista de credenciamento (download pelo link da recepção).
// Mesmo formato da planilha de trabalho do organizador:
//   aba "Convidados por empresa": Empresa | Nome | Tipo | Status | Compareceu: Sim ou Não?
//   aba "Empresas":               Empresa | Responsável | Cargo
// Formatadas como TABELA do Excel (cabeçalho azul, linhas alternadas, botões de filtro).
// A biblioteca xlsx (versão comunitária) não grava tabelas nem estilos: geramos o arquivo
// com ela e acrescentamos as partes de tabela/estilo diretamente no pacote (zip).

const XLSX = require('xlsx');
const { db } = require('./db');

const CFB = XLSX.CFB;
const alfa = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const limpo = s => String(s || '').trim().replace(/\s+/g, ' ');
const NOMES_STATUS = { pendente: 'Pendente', enviado: 'Convite enviado', confirmado: 'Confirmado' };
const TIPOS = { responsavel: 'Responsável', convidado: 'Convidado', individual: 'Individual' };
const QUEBRA = '\n';
const COL_COMPARECEU = 'Compareceu:' + QUEBRA + 'Sim ou Não?';

// Status do convite (para quem já chegou, o status de antes do check-in — a presença vai na última coluna)
function statusConvite(c) {
  if (c.status !== 'checkin') return c.status;
  if (['pendente', 'enviado', 'confirmado'].includes(c.status_antes_checkin)) return c.status_antes_checkin;
  return c.confirmado_em ? 'confirmado' : 'enviado';
}

function dados(eventoId) {
  const convidados = db.prepare(`
    SELECT c.nome, c.tipo, c.status, c.status_antes_checkin, c.confirmado_em, c.empresa_id, u.empresa_nome
    FROM convidados c LEFT JOIN usuarios u ON u.id = c.empresa_id
    WHERE c.evento_id=? AND c.status!='cancelado'`).all(eventoId)
    .map(c => ({ ...c, empresa: c.empresa_id ? (limpo(c.empresa_nome) || 'Empresa sem nome') : '' }))
    // Igual à planilha de referência: convites individuais primeiro, depois empresas A→Z; nomes A→Z
    .sort((a, b) => (b.empresa === '') - (a.empresa === '') || alfa.compare(a.empresa, b.empresa) || alfa.compare(limpo(a.nome), limpo(b.nome)));

  const linhasConvidados = convidados.map(c => [
    c.empresa || 'Individual',
    limpo(c.nome),
    TIPOS[c.tipo] || c.tipo,
    NOMES_STATUS[statusConvite(c)] || c.status,
    // Quem já foi marcado na lista do link vem "Sim"; os demais ficam em branco para escolher na lista (Sim/Não)
    c.status === 'checkin' ? 'Sim' : '',
  ]);

  const empresas = db.prepare(`SELECT empresa_nome, nome, cargo FROM usuarios WHERE evento_id=? AND role='convidado_principal'`).all(eventoId)
    .map(e => [limpo(e.empresa_nome), limpo(e.nome), limpo(e.cargo)])
    .sort((a, b) => alfa.compare(a[0], b[0]) || alfa.compare(a[1], b[1]));

  return { linhasConvidados, empresas };
}

// ── Pós-processamento do pacote xlsx ──
const escXml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// nome de coluna de tabela: quebra de linha vira _x000a_ (como o Excel grava)
const nomeColuna = s => escXml(String(s).replace(/\r?\n/g, '_x000a_'));
const letra = n => String.fromCharCode(65 + n);

function lerParte(zip, caminho) {
  const i = zip.FullPaths.findIndex(p => p.endsWith('/' + caminho));
  return i >= 0 ? Buffer.from(zip.FileIndex[i].content).toString('utf8') : null;
}
function gravarParte(zip, caminho, texto) {
  const i = zip.FullPaths.findIndex(p => p.endsWith('/' + caminho));
  if (i >= 0) zip.FileIndex[i].content = Buffer.from(texto, 'utf8');
  else CFB.utils.cfb_add(zip, caminho, Buffer.from(texto, 'utf8'));
}

function formatarComoTabelas(buffer, tabelas) {
  const zip = CFB.read(buffer, { type: 'buffer' });

  // Estilo extra (índice 1): cabeçalho centralizado com quebra de texto
  let estilos = lerParte(zip, 'xl/styles.xml');
  estilos = estilos.replace(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/, (m, n, xfs) =>
    `<cellXfs count="${Number(n) + 1}">${xfs}<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">` +
    `<alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs>`);
  const indiceCabecalho = Number((estilos.match(/<cellXfs count="(\d+)">/) || [])[1]) - 1;
  gravarParte(zip, 'xl/styles.xml', estilos);

  let tipos = lerParte(zip, '[Content_Types].xml');
  tabelas.forEach((t, i) => {
    const n = i + 1;
    const caminhoAba = `xl/worksheets/sheet${n}.xml`;
    let aba = lerParte(zip, caminhoAba);
    const ref = `A1:${letra(t.colunas.length - 1)}${t.linhas + 1}`;
    // cabeçalho: estilo com quebra + altura maior; congela a 1ª linha
    aba = aba.replace(/<row r="1"([^>]*)>([\s\S]*?)<\/row>/, (m, attrs, celulas) =>
      `<row r="1"${attrs.replace(/\s*(ht|customHeight)="[^"]*"/g, '')} ht="34" customHeight="1">` +
      celulas.replace(/<c r="([A-Z]+1)"( s="\d+")?/g, `<c r="$1" s="${indiceCabecalho}"`) + '</row>');
    aba = aba.replace(/<sheetView workbookViewId="0"\/>/,
      '<sheetView workbookViewId="0" zoomScale="110" zoomScaleNormal="110"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>');
    // Lista suspensa (validação de dados) — ex.: coluna "Compareceu" com Sim/Não
    if (t.listas?.length) {
      aba = aba.replace('</sheetData>', '</sheetData><dataValidations count="' + t.listas.length + '">' +
        t.listas.map(l => `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" ` +
          `errorTitle="Valor inválido" error="Escolha Sim ou Não na lista." sqref="${letra(l.coluna)}2:${letra(l.coluna)}${t.linhas + 1}">` +
          `<formula1>"${escXml(l.opcoes.join(','))}"</formula1></dataValidation>`).join('') + '</dataValidations>');
    }
    aba = aba.replace('</worksheet>', `<tableParts count="1"><tablePart r:id="rIdTabela${n}"/></tableParts></worksheet>`);
    gravarParte(zip, caminhoAba, aba);

    gravarParte(zip, `xl/worksheets/_rels/sheet${n}.xml.rels`,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rIdTabela${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${n}.xml"/>` +
      '</Relationships>');

    gravarParte(zip, `xl/tables/table${n}.xml`,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${n}" name="${t.nome}" displayName="${t.nome}" ref="${ref}" totalsRowShown="0">` +
      `<autoFilter ref="${ref}"/><tableColumns count="${t.colunas.length}">` +
      t.colunas.map((c, j) => `<tableColumn id="${j + 1}" name="${nomeColuna(c)}"/>`).join('') +
      '</tableColumns><tableStyleInfo name="TableStyleMedium9" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>');

    tipos = tipos.replace('</Types>', `<Override PartName="/xl/tables/table${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`);
  });
  gravarParte(zip, '[Content_Types].xml', tipos);
  return Buffer.from(CFB.write(zip, { fileType: 'zip', type: 'buffer', compression: true }));
}

/** @returns {{buffer: Buffer, nomeArquivo: string}} */
function gerarPlanilhaCredenciamento(evento) {
  const { linhasConvidados, empresas } = dados(evento.id);
  const colConvidados = ['Empresa', 'Nome', 'Tipo', 'Status', COL_COMPARECEU];
  const colEmpresas = ['Empresa', 'Responsável', 'Cargo'];
  // Tabela do Excel precisa de ao menos uma linha de dados
  const lc = linhasConvidados.length ? linhasConvidados : [['', '', '', '', '']];
  const le = empresas.length ? empresas : [['', '', '']];

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([colConvidados, ...lc]);
  ws1['!cols'] = [26, 30, 14, 18, 15].map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Convidados por empresa');
  const ws2 = XLSX.utils.aoa_to_sheet([colEmpresas, ...le]);
  ws2['!cols'] = [28, 24, 33].map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws2, 'Empresas');

  const bruto = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const buffer = formatarComoTabelas(bruto, [
    { nome: 'Convidados', colunas: colConvidados, linhas: lc.length, listas: [{ coluna: 4, opcoes: ['Sim', 'Não'] }] },
    { nome: 'Empresas', colunas: colEmpresas, linhas: le.length },
  ]);

  const slug = String(evento.nome).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const agora = new Date().toLocaleString('sv-SE', { timeZone: process.env.FUSO_HORARIO || 'America/Sao_Paulo' });
  const carimbo = `${agora.slice(8, 10)}${agora.slice(5, 7)}_${agora.slice(11, 13)}h${agora.slice(14, 16)}`;
  return { buffer, nomeArquivo: `convidados_${slug}_${carimbo}.xlsx` };
}

module.exports = { gerarPlanilhaCredenciamento };
