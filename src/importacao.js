'use strict';
// Importação de convidados principais (empresas) via planilha (.xlsx, .xls ou .csv)

const XLSX = require('xlsx');

const LIMITE_LINHAS = 500;

// Cabeçalhos aceitos (normalizados sem acento/caixa) → campo interno
const MAPA_COLUNAS = {
  empresa: 'empresa_nome', organizacao: 'empresa_nome', 'empresa/organizacao': 'empresa_nome',
  'nome da empresa': 'empresa_nome', 'razao social': 'empresa_nome',
  cota: 'cota', convites: 'cota', 'cota de convites': 'cota',
  'quantidade de convites': 'cota', quantidade: 'cota', qtd: 'cota',
  responsavel: 'nome', 'nome do responsavel': 'nome', nome: 'nome', contato: 'nome',
  cargo: 'cargo', funcao: 'cargo',
  email: 'email', 'e-mail': 'email', 'email do responsavel': 'email',
  telefone: 'telefone', whatsapp: 'telefone', celular: 'telefone',
  'telefone/whatsapp': 'telefone', 'telefone / whatsapp': 'telefone',
};

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// Planilha-modelo para o usuário preencher
function gerarModeloXlsx() {
  const dados = [
    ['Empresa', 'Cota de convites', 'Responsável', 'Cargo', 'E-mail', 'Telefone/WhatsApp'],
    ['Farmácia Exemplo Ltda', 4, 'Maria Silva', 'Diretora', 'maria@exemplo.com.br', '(11) 99999-0001'],
    ['Distribuidora Modelo S/A', 6, 'João Souza', 'Gerente comercial', 'joao@modelo.com.br', '(11) 99999-0002'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(dados);
  ws['!cols'] = [{ wch: 30 }, { wch: 16 }, { wch: 24 }, { wch: 20 }, { wch: 28 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Convidados principais');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// CSV: decodifica o texto (UTF-8 com/sem BOM ou Latin-1) e faz o parse
// detectando o delimitador (';' padrão do Excel brasileiro, ',' ou tab).
function parsearCsv(buf) {
  let texto = buf.toString('utf8');
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1); // BOM
  if (texto.includes('�')) texto = buf.toString('latin1'); // não era UTF-8 válido
  const primeiraLinha = texto.slice(0, texto.indexOf('\n') === -1 ? texto.length : texto.indexOf('\n'));
  const contar = d => (primeiraLinha.match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) || []).length;
  const delim = [';', ',', '\t'].reduce((a, b) => (contar(b) > contar(a) ? b : a));

  const linhas = [];
  let linha = [], celula = '', aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (aspas) {
      if (ch === '"' && texto[i + 1] === '"') { celula += '"'; i++; }
      else if (ch === '"') aspas = false;
      else celula += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === delim) { linha.push(celula); celula = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      linha.push(celula); linhas.push(linha); linha = []; celula = '';
    } else celula += ch;
  }
  if (celula !== '' || linha.length) { linha.push(celula); linhas.push(linha); }
  return linhas;
}

function ehCsv(buf) {
  const assinatura = buf.subarray(0, 4).toString('hex');
  return assinatura !== '504b0304' /* zip = .xlsx */ && assinatura !== 'd0cf11e0' /* OLE = .xls */;
}

/**
 * Lê a planilha (base64 ou data URL) e devolve as linhas mapeadas.
 * @returns {{linhas: object[], erro?: string}}
 */
function lerPlanilha(arquivoBase64) {
  const base64 = String(arquivoBase64 || '').replace(/^data:[^;]*;base64,/, '');
  if (!base64) return { erro: 'Arquivo vazio.' };
  const buf = Buffer.from(base64, 'base64');
  let brutas;
  if (ehCsv(buf)) {
    brutas = parsearCsv(buf);
  } else {
    let wb;
    try {
      wb = XLSX.read(buf, { type: 'buffer' });
    } catch {
      return { erro: 'Não foi possível ler o arquivo. Envie uma planilha .xlsx, .xls ou .csv.' };
    }
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return { erro: 'A planilha não tem nenhuma aba com dados.' };
    brutas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  }
  if (!brutas.length) return { erro: 'A planilha está vazia.' };

  // Identifica a linha de cabeçalho (primeira que contenha uma coluna de empresa)
  let idxCab = brutas.findIndex(l => l.some(c => MAPA_COLUNAS[normalizar(c)] === 'empresa_nome'));
  if (idxCab === -1) {
    return { erro: 'Cabeçalho não encontrado. A planilha precisa de uma coluna "Empresa" (baixe o modelo).' };
  }
  const campos = brutas[idxCab].map(c => MAPA_COLUNAS[normalizar(c)] || null);

  const linhas = [];
  for (let i = idxCab + 1; i < brutas.length; i++) {
    const bruta = brutas[i];
    if (!bruta.some(c => String(c).trim())) continue; // linha em branco
    const obj = { linha: i + 1 }; // nº da linha na planilha (1-based)
    campos.forEach((campo, j) => {
      if (campo && obj[campo] === undefined) obj[campo] = String(bruta[j] ?? '').trim();
    });
    linhas.push(obj);
    if (linhas.length > LIMITE_LINHAS) {
      return { erro: `A planilha tem mais de ${LIMITE_LINHAS} linhas. Divida em arquivos menores.` };
    }
  }
  return { linhas };
}

/**
 * Valida as linhas contra o evento (duplicidades na planilha e no banco).
 * Cada item recebe: valida (bool), problemas (string[]) e cota normalizada.
 */
function validarLinhas(linhas, empresasExistentes) {
  const existentes = new Set(empresasExistentes.map(e => normalizar(e.empresa_nome)));
  const vistas = new Set();
  return linhas.map(l => {
    const problemas = [];
    const chave = normalizar(l.empresa_nome);
    if (!l.empresa_nome) problemas.push('sem nome de empresa');
    else if (existentes.has(chave)) problemas.push('já cadastrada neste evento');
    else if (vistas.has(chave)) problemas.push('duplicada na planilha');
    vistas.add(chave);

    let cota = parseInt(String(l.cota || '').replace(/\D/g, ''), 10);
    if (!cota || cota < 1) cota = 4; // padrão do sistema
    if (l.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.email)) problemas.push('e-mail com formato inválido');

    return { ...l, cota, valida: problemas.length === 0 || problemas.every(p => p === 'e-mail com formato inválido'), problemas };
  });
}

module.exports = { gerarModeloXlsx, lerPlanilha, validarLinhas };
