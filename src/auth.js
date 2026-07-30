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

// Identificação legível do usuário logado, para registros de auditoria (ex.: quem cancelou um convidado).
function descreverUsuario(usuario) {
  if (!usuario) return 'sistema';
  if (usuario.role === 'master') return `Master (${usuario.username})`;
  if (usuario.role === 'admin_evento') return `Admin do evento — ${usuario.nome || usuario.username}`;
  if (usuario.role === 'convidado_principal') return `Convidado principal — ${usuario.empresa_nome || usuario.nome || usuario.username}`;
  return usuario.username || 'sistema';
}

module.exports = {
  exigirLogin, exigirMaster, exigirAdminEvento, exigirConvidadoPrincipal, podeAcessarEvento,
  descreverUsuario,
};
