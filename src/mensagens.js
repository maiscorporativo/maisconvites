'use strict';
// Montagem das mensagens de convite (e-mail e WhatsApp)

const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = () => (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// Logos da Mais Corporativo embutidos no e-mail (data URL; nodemailer converte em anexo cid)
function logoDataUrl(arquivo) {
  try {
    const caminho = path.join(__dirname, '..', 'public', arquivo);
    return 'data:image/png;base64,' + fs.readFileSync(caminho).toString('base64');
  } catch { return null; }
}
const LOGO_BRANCO = logoDataUrl('logo-branco.png');
const LOGO_AZUL = logoDataUrl('logo-azul.png');

function dataBr(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

function linkConvite(token) {
  return `${BASE_URL()}/convite/${token}`;
}

// Link de confirmação em 1 clique: abre o convite digital e já confirma a presença
// automaticamente (a confirmação em si só ocorre via JS no carregamento da página,
// nunca pela simples requisição GET do link — protege contra pré-carregamento de
// links por scanners de segurança de e-mail).
function linkConfirmar(token) {
  return `${linkConvite(token)}?confirmar=1`;
}

function infoAssento(convidado, evento) {
  if (evento && evento.mapa_mesas === 0) return null; // mapa de mesas desativado no evento
  if (convidado.mesa_numero != null && convidado.cadeira != null) {
    return `Mesa ${convidado.mesa_numero}, Cadeira ${convidado.cadeira}`;
  }
  if (convidado.mesa_numero != null) return `Mesa ${convidado.mesa_numero}`;
  return null;
}

function blocoHoteis(evento) {
  let hoteis = [];
  try { hoteis = JSON.parse(evento.hoteis || '[]'); } catch {}
  if (!hoteis.length) return '';
  const linhas = hoteis
    .map(h => `• ${h.nome}${h.distancia ? ` (${h.distancia})` : ''}${h.endereco ? ` — ${h.endereco}` : ''}${h.telefone ? ` — ${h.telefone}` : ''}`)
    .join('\n');
  return `\n🏨 *Hotéis próximos:*\n${linhas}\n`;
}

// Mensagem de texto (WhatsApp / corpo simples)
function textoConvite(evento, convidado, credenciais) {
  const assento = infoAssento(convidado, evento);
  let msg = `🥂 *Convite — ${evento.nome}*\n\n`;
  msg += `Olá, *${convidado.nome}*!\n\n`;
  msg += `${evento.email_texto || `Você está convidado(a) para o *${evento.nome}*.`}\n\n`;
  msg += `📅 *Data:* ${dataBr(evento.data_evento)} às ${evento.hora_evento}\n`;
  msg += `📍 *Local:* ${evento.local_nome} — ${evento.endereco}\n`;
  if (evento.dress_code) msg += `👔 *Traje:* ${evento.dress_code}\n`;
  if (assento) msg += `🪑 *Seu lugar:* ${assento}\n`;
  msg += `\n🎫 *Seu convite digital com QR code:*\n${linkConvite(convidado.token)}\n`;
  msg += `\nApresente o QR code na recepção para o credenciamento.\n`;
  msg += blocoHoteis(evento);
  if (credenciais) {
    msg += `\n🔐 *Seu acesso à plataforma* (para gerenciar os convites da sua empresa):\n`;
    msg += `Link: ${BASE_URL()}\n`;
    msg += `Login: ${credenciais.username}\n`;
    msg += `Senha: ${credenciais.senha}\n`;
  }
  msg += `\nAguardamos você!`;
  return msg;
}

// HTML do e-mail
// bannerDataUrl: imagem de cabeçalho personalizada (opcional, data URL)
function htmlConvite(evento, convidado, credenciais, qrDataUrl, bannerDataUrl) {
  const assento = infoAssento(convidado, evento);
  const podeConfirmar = !['confirmado', 'checkin', 'cancelado'].includes(convidado.status);
  let hoteis = [];
  try { hoteis = JSON.parse(evento.hoteis || '[]'); } catch {}
  let facilities = [];
  try { facilities = JSON.parse(evento.facilities || '[]'); } catch {}
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(evento.local_nome + ' ' + evento.endereco)}`;
  const titulo = evento.email_titulo || evento.nome;
  const abertura = evento.email_texto || evento.descricao || 'Temos o prazer de convidá-lo(a) para este evento especial.';
  const rodape = evento.email_rodape || `Convite pessoal e intransferível · ${evento.nome}`;

  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:0;background:#f2f5f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#1c2733;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  ${bannerDataUrl ? `<tr><td><img src="${bannerDataUrl}" alt="" width="600" style="display:block;width:100%;height:auto;"></td></tr>` : ''}
  <tr><td style="background:#002042;padding:${bannerDataUrl ? '26px 32px' : '40px 32px'};text-align:center;">
    ${LOGO_BRANCO ? `<img src="${LOGO_BRANCO}" alt="Mais Corporativo" height="36" style="height:36px;margin-bottom:14px;">` : ''}
    <div style="color:#f7ad40;font-size:13px;letter-spacing:4px;text-transform:uppercase;">Convite</div>
    <div style="color:#eef4fb;font-size:30px;font-weight:700;margin-top:10px;">${titulo}</div>
  </td></tr>
  <tr><td style="padding:36px 40px;">
    <p style="font-size:17px;margin:0 0 16px;">Olá, <strong>${convidado.nome}</strong>!</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">${abertura}</p>
    <table role="presentation" width="100%" style="background:#f6f8fb;border:1px solid #d9e2ee;border-radius:10px;" cellpadding="0" cellspacing="0"><tr><td style="padding:20px 24px;font-size:15px;line-height:2;">
      📅 <strong>Data:</strong> ${dataBr(evento.data_evento)} às ${evento.hora_evento}<br>
      📍 <strong>Local:</strong> ${evento.local_nome} — ${evento.endereco}<br>
      ${evento.dress_code ? `👔 <strong>Traje:</strong> ${evento.dress_code}<br>` : ''}
      ${assento ? `🪑 <strong>Seu lugar:</strong> ${assento}<br>` : ''}
      🗺️ <a href="${mapsUrl}" style="color:#e84e27;">Ver no mapa</a>
    </td></tr></table>
    <div style="text-align:center;padding:28px 0 8px;">
      ${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR code do convite" width="180" height="180" style="border:1px solid #d9e2ee;border-radius:8px;">` : ''}
      <p style="font-size:13px;color:#64748b;margin:12px 0 0;">Apresente este QR code na recepção para o credenciamento.</p>
      ${podeConfirmar ? `
      <p style="margin:22px 0 0;"><a href="${linkConfirmar(convidado.token)}" style="display:inline-block;background-color:#e84e27;color:#ffffff;text-decoration:none;padding:14px 34px;border-radius:8px;font-size:16px;font-weight:bold;">✅ Confirmar minha presença</a></p>
      ` : `
      <p style="margin:22px 0 0;font-size:14px;color:#15803d;font-weight:bold;">✅ ${convidado.status === 'checkin' ? 'Presença já registrada no evento.' : 'Presença confirmada. Até lá!'}</p>
      `}
      <p style="margin:14px 0 0;"><a href="${linkConvite(convidado.token)}" style="display:inline-block;background-color:#f7ad40;color:#002042;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:13px;font-weight:600;">Abrir meu convite digital</a></p>
    </div>
    ${hoteis.length ? `<h3 style="font-size:15px;color:#e84e27;border-bottom:1px solid #d9e2ee;padding-bottom:6px;margin:28px 0 12px;">🏨 Hotéis próximos</h3>
    <ul style="font-size:14px;line-height:1.8;padding-left:18px;margin:0;">${hoteis.map(h => `<li><strong>${h.nome}</strong>${h.distancia ? ` (${h.distancia})` : ''}${h.endereco ? ` — ${h.endereco}` : ''}${h.telefone ? ` — ${h.telefone}` : ''}</li>`).join('')}</ul>` : ''}
    ${facilities.length ? `<h3 style="font-size:15px;color:#e84e27;border-bottom:1px solid #d9e2ee;padding-bottom:6px;margin:28px 0 12px;">✨ Comodidades</h3>
    <ul style="font-size:14px;line-height:1.8;padding-left:18px;margin:0;">${facilities.map(f => `<li><strong>${f.titulo}:</strong> ${f.descricao}</li>`).join('')}</ul>` : ''}
    ${credenciais ? `<table role="presentation" width="100%" style="background:#002042;border-radius:10px;margin-top:28px;" cellpadding="0" cellspacing="0"><tr><td style="padding:20px 24px;color:#eef4fb;font-size:14px;line-height:2;">
      🔐 <strong style="color:#f7ad40;">Seu acesso à plataforma</strong> — gerencie os convites da sua empresa:<br>
      Link: <a href="${BASE_URL()}" style="color:#f7ad40;">${BASE_URL()}</a><br>
      Login: <strong>${credenciais.username}</strong> &nbsp;|&nbsp; Senha: <strong>${credenciais.senha}</strong>
    </td></tr></table>` : ''}
  </td></tr>
  <tr><td style="background:#f6f8fb;border-top:1px solid #d9e2ee;padding:18px;text-align:center;font-size:12px;color:#8ba0b8;">
    ${rodape}
    ${LOGO_AZUL ? `<div style="margin-top:10px;"><img src="${LOGO_AZUL}" alt="Mais Corporativo" height="24" style="height:24px;"></div>` : ''}
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = { textoConvite, htmlConvite, linkConvite, linkConfirmar, dataBr };
