'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

// DATA_DIR pode ser movida para fora da pasta do app (ex.: deploy via GitHub, em que
// cada redeploy substitui os arquivos do app): defina DATA_DIR=/caminho/persistente no .env.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'sistema.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  data_evento TEXT NOT NULL,          -- YYYY-MM-DD
  hora_evento TEXT DEFAULT '20:00',
  local_nome TEXT NOT NULL,
  endereco TEXT NOT NULL,
  descricao TEXT DEFAULT '',
  dress_code TEXT DEFAULT '',
  deadline TEXT NOT NULL,             -- YYYY-MM-DD: data de expiração dos convites das empresas
  hoteis TEXT DEFAULT '[]',           -- JSON [{nome, endereco, telefone, distancia}]
  facilities TEXT DEFAULT '[]',       -- JSON [{titulo, descricao}]
  pool_individual INTEGER DEFAULT 0,  -- convites individuais disponíveis (pós-expiração + adicionados)
  expirado INTEGER DEFAULT 0,         -- 1 = expiração já processada
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER REFERENCES eventos(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  senha_provisoria TEXT,              -- senha gerada pelo admin, para envio à empresa; limpa ao trocar
  role TEXT NOT NULL CHECK (role IN ('master','admin_evento','convidado_principal')),
  empresa_nome TEXT DEFAULT '',
  nome TEXT DEFAULT '',               -- responsável
  cargo TEXT DEFAULT '',
  email TEXT DEFAULT '',
  telefone TEXT DEFAULT '',
  cota INTEGER DEFAULT 4,             -- nº de convites da empresa
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mesas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  nome TEXT DEFAULT '',
  capacidade INTEGER DEFAULT 8,
  x REAL DEFAULT 100,
  y REAL DEFAULT 100,
  formato TEXT DEFAULT 'redonda' CHECK (formato IN ('redonda','retangular'))
);

CREATE TABLE IF NOT EXISTS convidados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  empresa_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL, -- NULL = convite individual
  tipo TEXT NOT NULL CHECK (tipo IN ('responsavel','convidado','individual')),
  nome TEXT NOT NULL,
  cargo TEXT DEFAULT '',
  email TEXT DEFAULT '',
  telefone TEXT DEFAULT '',
  mesa_id INTEGER REFERENCES mesas(id) ON DELETE SET NULL,
  cadeira INTEGER,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','enviado','confirmado','checkin','cancelado')),
  confirmado_em TEXT,
  checkin_em TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  convidado_id INTEGER NOT NULL REFERENCES convidados(id) ON DELETE CASCADE,
  canal TEXT NOT NULL CHECK (canal IN ('email','whatsapp')),
  destino TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'enviado' | 'simulado' | 'link_gerado' | 'erro: ...'
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS evento_envio (
  evento_id INTEGER PRIMARY KEY REFERENCES eventos(id) ON DELETE CASCADE,
  remetente_nome TEXT DEFAULT '',     -- nome exibido como remetente do e-mail
  reply_to TEXT DEFAULT '',           -- e-mail pessoal do admin do evento (respostas caem aqui)
  smtp_modo TEXT DEFAULT 'global' CHECK (smtp_modo IN ('global','proprio')),
  smtp_host TEXT DEFAULT '',
  smtp_port INTEGER DEFAULT 587,
  smtp_secure INTEGER DEFAULT 0,
  smtp_user TEXT DEFAULT '',
  smtp_pass TEXT DEFAULT '',
  wa_instancia_criada INTEGER DEFAULT 0, -- 1 = instância Evolution 'evento_<id>' já criada
  atualizado_em TEXT DEFAULT (datetime('now'))
);
`);

// Migrações leves (colunas adicionadas após a 1ª versão; ignora se já existem)
for (const sql of [
  `ALTER TABLE eventos ADD COLUMN banner TEXT DEFAULT ''`,
  `ALTER TABLE eventos ADD COLUMN email_titulo TEXT DEFAULT ''`,
  `ALTER TABLE eventos ADD COLUMN email_texto TEXT DEFAULT ''`,
  `ALTER TABLE eventos ADD COLUMN email_rodape TEXT DEFAULT ''`,
  `ALTER TABLE eventos ADD COLUMN timbrado TEXT DEFAULT ''`,
  `ALTER TABLE eventos ADD COLUMN mapa_mesas INTEGER DEFAULT 1`,
  `ALTER TABLE convidados ADD COLUMN codigo TEXT`,
  `ALTER TABLE eventos ADD COLUMN whatsapp_mensagem TEXT DEFAULT ''`,
  `ALTER TABLE eventos ADD COLUMN mensagem_cancelamento TEXT DEFAULT ''`,
  `ALTER TABLE convidados ADD COLUMN cancelado_em TEXT`,
  `ALTER TABLE convidados ADD COLUMN cancelado_por TEXT`,
  `ALTER TABLE eventos ADD COLUMN mostrar_logo_marca INTEGER DEFAULT 1`,
]) {
  try { db.exec(sql); } catch { /* coluna já existe */ }
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_convidados_codigo ON convidados(codigo)`);

// ── Migração: roles antigos ('admin','empresa') → níveis novos ─
// SQLite não altera CHECK via ALTER; recria a tabela preservando os dados.
(function migrarRoles() {
  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='usuarios'`).get();
  if (!ddl || !ddl.sql.includes(`'admin','empresa'`)) return; // já migrado
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE usuarios_nova (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        evento_id INTEGER REFERENCES eventos(id) ON DELETE CASCADE,
        username TEXT NOT NULL UNIQUE,
        senha_hash TEXT NOT NULL,
        senha_provisoria TEXT,
        role TEXT NOT NULL CHECK (role IN ('master','admin_evento','convidado_principal')),
        empresa_nome TEXT DEFAULT '',
        nome TEXT DEFAULT '',
        cargo TEXT DEFAULT '',
        email TEXT DEFAULT '',
        telefone TEXT DEFAULT '',
        cota INTEGER DEFAULT 4,
        criado_em TEXT DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      INSERT INTO usuarios_nova (id, evento_id, username, senha_hash, senha_provisoria, role,
                                 empresa_nome, nome, cargo, email, telefone, cota, criado_em)
      SELECT id, evento_id, username, senha_hash, senha_provisoria,
             CASE role WHEN 'admin' THEN 'master' WHEN 'empresa' THEN 'convidado_principal' ELSE role END,
             empresa_nome, nome, cargo, email, telefone, cota, criado_em
      FROM usuarios;
    `);
    db.exec(`DROP TABLE usuarios`);
    db.exec(`ALTER TABLE usuarios_nova RENAME TO usuarios`);
    db.exec('COMMIT');
    console.log('[migração] Roles atualizados: admin→master, empresa→convidado_principal.');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
})();

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function novoToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Código curto de credenciamento (6 dígitos, único): digitável na recepção quando
// não há celular para ler o QR. O token longo continua sendo o segredo dos links.
function novoCodigo() {
  const existe = db.prepare(`SELECT 1 FROM convidados WHERE codigo=?`);
  for (let i = 0; i < 50; i++) {
    const c = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!existe.get(c)) return c;
  }
  // espaço quase esgotado (improvável): passa para 8 dígitos
  return String(crypto.randomInt(0, 100000000)).padStart(8, '0');
}

// Retro-preenche o código dos convidados criados antes desta coluna existir
(function preencherCodigos() {
  const pendentes = db.prepare(`SELECT id FROM convidados WHERE codigo IS NULL`).all();
  if (!pendentes.length) return;
  const upd = db.prepare(`UPDATE convidados SET codigo=? WHERE id=?`);
  for (const c of pendentes) upd.run(novoCodigo(), c.id);
  console.log(`[migração] Código curto de credenciamento gerado para ${pendentes.length} convidado(s).`);
})();

function gerarSenha(tam = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const bytes = crypto.randomBytes(tam);
  for (let i = 0; i < tam; i++) s += chars[bytes[i] % chars.length];
  return s;
}

// ── Seed: usuário admin + evento exemplo ──────────────────────
function seed() {
  const temMaster = db.prepare(`SELECT COUNT(*) c FROM usuarios WHERE role='master'`).get().c;
  if (!temMaster) {
    db.prepare(`INSERT INTO usuarios (username, senha_hash, role, nome) VALUES (?,?,?,?)`)
      .run('admin', bcrypt.hashSync('admin123', 10), 'master', 'Administrador Master');
    console.log('[seed] Usuário master criado — login: admin / senha: admin123 (troque após o primeiro acesso)');
  }

  const temEvento = db.prepare(`SELECT COUNT(*) c FROM eventos`).get().c;
  if (!temEvento) {
    db.prepare(`
      INSERT INTO eventos (nome, data_evento, hora_evento, local_nome, endereco, descricao, dress_code, deadline, hoteis, facilities)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      'Jantar FECOFAR 2026',
      '2026-09-15',
      '20:00',
      'Casa Bizutt',
      'Rua do Ator, 577 - São Paulo/SP',
      'Jantar de confraternização FECOFAR 2026. Uma noite especial de networking e celebração com as indústrias parceiras.',
      'Traje esporte fino',
      '2026-08-31',
      JSON.stringify([]), // hotéis: em branco — o admin cadastra os reais no painel (Evento → Hotéis próximos)
      JSON.stringify([
        { titulo: 'Estacionamento', descricao: 'Com manobrista no local' },
        { titulo: 'Recepção', descricao: 'Credenciamento a partir das 19h30 com QR code' }
      ])
    );
    console.log('[seed] Evento "Jantar FECOFAR 2026" criado (edite os dados no painel do administrador).');
  }
}
seed();

module.exports = { db, novoToken, novoCodigo, gerarSenha, UPLOADS_DIR };
