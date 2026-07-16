'use strict';

function exigirLogin(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ erro: 'Não autenticado' });
  next();
}

function exigirMaster(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ erro: 'Não autenticado' });
  if (req.session.usuario.role !== 'master') return res.status(403).json({ erro: 'Acesso restrito ao usuário master' });
  next();
}

// Master também passa: tem acesso total a todos os eventos.
function exigirAdminEvento(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ erro: 'Não autenticado' });
  const { role } = req.session.usuario;
  if (role !== 'master' && role !== 'admin_evento') return res.status(403).json({ erro: 'Acesso restrito a administradores' });
  next();
}

function exigirConvidadoPrincipal(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ erro: 'Não autenticado' });
  if (req.session.usuario.role !== 'convidado_principal') return res.status(403).json({ erro: 'Acesso restrito a convidados principais' });
  next();
}

// Escopo: master acessa qualquer evento; admin_evento só o seu.
function podeAcessarEvento(usuario, eventoId) {
  if (!usuario) return false;
  if (usuario.role === 'master') return true;
  return Number(eventoId) === Number(usuario.evento_id);
}

module.exports = { exigirLogin, exigirMaster, exigirAdminEvento, exigirConvidadoPrincipal, podeAcessarEvento };
