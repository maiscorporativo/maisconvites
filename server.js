'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('node:path');

require('./src/db'); // inicializa banco e seed

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' })); // comporta o upload do banner (imagem em base64)

// Produção atrás de proxy reverso com HTTPS (nginx/painel da hospedagem): TRUST_PROXY=1 no .env
const atrasDeProxy = process.env.TRUST_PROXY === '1';
if (atrasDeProxy) app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo-dev-trocar-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: atrasDeProxy, maxAge: 1000 * 60 * 60 * 12 },
}));

app.use('/api', require('./src/rotas/autenticacao'));
app.use('/api/admin', require('./src/rotas/admin'));
app.use('/api/empresa', require('./src/rotas/empresa'));
app.use('/', require('./src/rotas/publico'));

app.use(express.static(path.join(__dirname, 'public')));

// Tratamento de erros da API
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Sistema de Convites rodando em http://localhost:${PORT}`);
  console.log(`Painel de acesso: http://localhost:${PORT}/`);
});

// HTTPS opcional: necessário para liberar a câmera (getUserMedia) em celulares na rede local.
// Gere os certificados em ./certs (cert.pem + key.pem) — se não existirem, só o HTTP sobe.
const fs = require('node:fs');
const CERT = path.join(__dirname, 'certs', 'cert.pem');
const KEY = path.join(__dirname, 'certs', 'key.pem');
if (fs.existsSync(CERT) && fs.existsSync(KEY)) {
  const https = require('node:https');
  const PORT_HTTPS = Number(process.env.PORT_HTTPS || 3443);
  https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, app)
    .listen(PORT_HTTPS, () => {
      console.log(`HTTPS (câmera no celular): https://localhost:${PORT_HTTPS}/`);
    });
}
