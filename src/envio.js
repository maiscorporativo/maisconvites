'use strict';
// Envio de convites por e-mail (SMTP) e WhatsApp.
// A configuração é resolvida POR EVENTO (tabela evento_envio), com
// fallback para as variáveis globais do .env quando não configurada.

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { db, UPLOADS_DIR } = require('./db');
const { textoConvite, htmlConvite, linkConvite } = require('./mensagens');
const evolution = require('./evolution');

// Banner do evento como data URL (embutido no e-mail; nodemailer converte em anexo cid)
function bannerDataUrl(evento) {
  if (!evento.banner) return null;
  try {
    const caminho = path.join(UPLOADS_DIR, path.basename(evento.banner));
    const ext = path.extname(caminho).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${fs.readFileSync(caminho).toString('base64')}`;
  } catch {
    return null;
  }
}

function whatsappApiConfigurada() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

// Extrai o endereço de '"Nome" <email>' ou devolve a string se já for só o e-mail
function enderecoDe(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return m ? m[1] : (from || '');
}

/**
 * Resolve a configuração de envio de um evento:
 * - SMTP: modo 'proprio' (conta pessoal do admin do evento) → senão SMTP global
 *   do .env com nome do remetente e Reply-To do admin do evento.
 * - WhatsApp: instância Evolution do evento (conectada por QR) → instância global.
 */
function carregarConfigEnvio(eventoId) {
  const ee = db.prepare(`SELECT * FROM evento_envio WHERE evento_id=?`).get(eventoId) || {};
  let smtp = null;

  if (ee.smtp_modo === 'proprio' && ee.smtp_host && ee.smtp_user) {
    smtp = {
      host: ee.smtp_host, port: Number(ee.smtp_port || 587), secure: !!ee.smtp_secure,
      user: ee.smtp_user, pass: ee.smtp_pass || '',
      from: ee.remetente_nome ? `"${ee.remetente_nome}" <${ee.smtp_user}>` : ee.smtp_user,
      replyTo: ee.reply_to || undefined,
      origem: 'evento',
    };
  } else if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    const endereco = enderecoDe(process.env.SMTP_FROM) || process.env.SMTP_USER;
    smtp = {
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
      from: ee.remetente_nome ? `"${ee.remetente_nome}" <${endereco}>` : (process.env.SMTP_FROM || process.env.SMTP_USER),
      replyTo: ee.reply_to || undefined,
      origem: 'global',
    };
  }

  const instancias = [];
  if (ee.wa_instancia_criada && evolution.evolutionGlobalConfigurada()) {
    instancias.push(evolution.nomeInstancia(eventoId));
  }
  if (evolution.evolutionGlobalConfigurada() && process.env.EVOLUTION_INSTANCE) {
    instancias.push(process.env.EVOLUTION_INSTANCE);
  }

  return { smtp, instancias };
}

function criarTransporte(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });
}

async function qrDoConvite(token) {
  // O QR contém o link do convite digital; a página de check-in extrai o token dele.
  return QRCode.toDataURL(linkConvite(token), { width: 360, margin: 2 });
}

function soDigitos(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (d && !d.startsWith('55') && d.length <= 11) d = '55' + d; // assume Brasil
  return d;
}

function registrarEnvio(convidadoId, canal, destino, status) {
  db.prepare(`INSERT INTO envios (convidado_id, canal, destino, status) VALUES (?,?,?,?)`)
    .run(convidadoId, canal, destino || '(vazio)', status);
  db.prepare(`UPDATE convidados SET status='enviado' WHERE id=? AND status='pendente'`).run(convidadoId);
}

/**
 * Envia (ou prepara) o convite.
 * @param {'email'|'whatsapp'} canal
 * @param {object} evento  linha de eventos
 * @param {object} convidado  linha de convidados (+ mesa_numero se houver)
 * @param {object|null} credenciais  {username, senha} p/ convidados principais
 * @param {object} [config]  resultado de carregarConfigEnvio (evita recarga em lote)
 * @returns {object} resultado p/ o frontend
 */
async function enviarConvite(canal, evento, convidado, credenciais, config) {
  config = config || carregarConfigEnvio(evento.id);

  if (canal === 'email') {
    if (!convidado.email) return { ok: false, erro: 'Convidado sem e-mail cadastrado.' };
    const qr = await qrDoConvite(convidado.token);
    const html = htmlConvite(evento, convidado, credenciais, qr, bannerDataUrl(evento));
    const texto = textoConvite(evento, convidado, credenciais);
    if (config.smtp) {
      try {
        await criarTransporte(config.smtp).sendMail({
          from: config.smtp.from,
          replyTo: config.smtp.replyTo,
          to: convidado.email,
          subject: `Convite — ${evento.nome}`,
          text: texto,
          html,
          attachDataUrls: true,
        });
        registrarEnvio(convidado.id, 'email', convidado.email, 'enviado');
        return { ok: true, modo: 'enviado', mensagem: `E-mail enviado para ${convidado.email}.` };
      } catch (e) {
        registrarEnvio(convidado.id, 'email', convidado.email, 'erro: ' + e.message);
        return { ok: false, erro: 'Falha no envio do e-mail: ' + e.message };
      }
    }
    // Modo simulação: devolve o conteúdo pronto para envio manual
    registrarEnvio(convidado.id, 'email', convidado.email, 'simulado');
    return {
      ok: true, modo: 'simulado',
      mensagem: 'SMTP não configurado. Mensagem gerada para envio manual.',
      assunto: `Convite — ${evento.nome}`,
      destinatario: convidado.email,
      texto,
    };
  }

  if (canal === 'whatsapp') {
    if (!convidado.telefone) return { ok: false, erro: 'Convidado sem telefone/WhatsApp cadastrado.' };
    const texto = textoConvite(evento, convidado, credenciais);
    const numero = soDigitos(convidado.telefone);

    // 1) Instâncias Evolution (do evento, depois a global), se conectadas
    for (const nome of config.instancias) {
      const estado = await evolution.estadoInstancia(nome);
      if (estado !== 'open') continue;
      try {
        await evolution.enviarTexto(nome, numero, texto);
        registrarEnvio(convidado.id, 'whatsapp', numero, 'enviado');
        return { ok: true, modo: 'enviado', mensagem: `WhatsApp enviado para +${numero}.` };
      } catch (e) {
        registrarEnvio(convidado.id, 'whatsapp', numero, 'erro: ' + e.message);
        return { ok: false, erro: 'Falha na Evolution API: ' + e.message };
      }
    }

    // 2) WhatsApp Cloud API oficial (Meta)
    if (whatsappApiConfigurada()) {
      try {
        const resp = await fetch(`https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: numero,
            type: 'text',
            text: { body: texto },
          }),
        });
        const dados = await resp.json();
        if (!resp.ok) throw new Error(JSON.stringify(dados.error || dados));
        registrarEnvio(convidado.id, 'whatsapp', numero, 'enviado');
        return { ok: true, modo: 'enviado', mensagem: `WhatsApp enviado para +${numero}.` };
      } catch (e) {
        registrarEnvio(convidado.id, 'whatsapp', numero, 'erro: ' + e.message);
        return { ok: false, erro: 'Falha na API do WhatsApp: ' + e.message };
      }
    }

    // 3) Sem API: gera link wa.me com a mensagem pronta (1 clique para enviar)
    const link = `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
    registrarEnvio(convidado.id, 'whatsapp', numero, 'link_gerado');
    return {
      ok: true, modo: 'link',
      mensagem: 'Link do WhatsApp gerado — abra para revisar e enviar.',
      link,
    };
  }

  return { ok: false, erro: 'Canal inválido.' };
}

/**
 * Dispara o convite automaticamente por todos os canais disponíveis
 * (e-mail se houver e-mail; WhatsApp se houver telefone), de forma independente.
 * @returns {{email:object|null, whatsapp:object|null, algum_enviado:boolean}}
 */
async function enviarConviteAutomatico(evento, convidado, credenciais = null) {
  const config = carregarConfigEnvio(evento.id);
  const resultado = { email: null, whatsapp: null, algum_enviado: false };

  if (convidado.email) {
    try {
      resultado.email = await enviarConvite('email', evento, convidado, credenciais, config);
    } catch (e) {
      resultado.email = { ok: false, erro: e.message };
    }
  }
  if (convidado.telefone) {
    try {
      resultado.whatsapp = await enviarConvite('whatsapp', evento, convidado, credenciais, config);
    } catch (e) {
      resultado.whatsapp = { ok: false, erro: e.message };
    }
  }
  resultado.algum_enviado = !!(resultado.email?.ok || resultado.whatsapp?.ok);
  return resultado;
}

module.exports = { enviarConvite, enviarConviteAutomatico, carregarConfigEnvio, qrDoConvite };
