'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { exigirLogin } = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ erro: 'Informe login e senha.' });
  const u = db.prepare(`SELECT * FROM usuarios WHERE username = ?`).get(String(username).trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.senha_hash)) {
    return res.status(401).json({ erro: 'Login ou senha inválidos.' });
  }
  req.session.usuario = { id: u.id, username: u.username, role: u.role, nome: u.nome, empresa_nome: u.empresa_nome, evento_id: u.evento_id };
  res.json({ ok: true, role: u.role, nome: u.nome, empresa_nome: u.empresa_nome, evento_id: u.evento_id });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', exigirLogin, (req, res) => {
  const u = db.prepare(`SELECT id, username, role, nome, empresa_nome, cargo, email, telefone, cota, evento_id FROM usuarios WHERE id=?`)
    .get(req.session.usuario.id);
  res.json(u);
});

router.post('/trocar-senha', exigirLogin, (req, res) => {
  const { senha_atual, senha_nova } = req.body || {};
  if (!senha_nova || senha_nova.length < 6) return res.status(400).json({ erro: 'A nova senha deve ter ao menos 6 caracteres.' });
  const u = db.prepare(`SELECT * FROM usuarios WHERE id=?`).get(req.session.usuario.id);
  if (!bcrypt.compareSync(senha_atual || '', u.senha_hash)) return res.status(401).json({ erro: 'Senha atual incorreta.' });
  db.prepare(`UPDATE usuarios SET senha_hash=?, senha_provisoria=NULL WHERE id=?`)
    .run(bcrypt.hashSync(senha_nova, 10), u.id);
  res.json({ ok: true });
});

module.exports = router;
