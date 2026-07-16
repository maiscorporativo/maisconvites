# Sistema de Convites — Jantar FECOFAR 2026

Plataforma web para emissão e gestão de convites de eventos: credenciamento com QR code,
cotas de convites por empresa, mapa interativo de mesas e disparo de convites por e-mail e WhatsApp.

## Como executar

```
npm install
npm start
```

Acesse **http://localhost:3000**

> Primeiro acesso: login `admin` / senha `admin123` — **troque a senha** no botão "Trocar senha" do painel.

O evento **Jantar FECOFAR 2026** (Casa Bizutt — Rua do Ator, 577 - São Paulo/SP) já vem pré-cadastrado.
Edite datas, descrição, hotéis próximos e comodidades na aba **Evento**.

## Perfis de acesso

| Perfil | O que faz |
|---|---|
| **Administrador (organização)** | Cria/edita eventos; cadastra empresas gerando login, senha e cota de convites; vê todos os convidados; monta o mapa de mesas; define assentos; dispara convites; processa a expiração; faz o credenciamento (check-in). |
| **Empresa (responsável)** | Faz login com as credenciais recebidas; preenche seus dados (nome, empresa, cargo, e-mail, telefone); inscreve convidados (nome, e-mail, telefone/WhatsApp) até a cota; dispara o convite digital por e-mail/WhatsApp; consulta o mapa das mesas. |

## Fluxo de trabalho sugerido

1. **Admin** revisa os dados do evento na aba *Evento* (hotéis, comodidades, deadline).
2. **Admin** cadastra as ~70 indústrias na aba *Empresas*, definindo a cota de cada uma (padrão 4).
   O sistema gera login e senha automaticamente.
3. **Admin** envia o convite do responsável (botões ✉️/💬 na aba *Convidados*) — a mensagem do
   responsável **já inclui login e senha** de acesso à plataforma, além do QR code, mapa, endereço e hotéis.
4. **Empresas** acessam, completam seus dados e inscrevem seus convidados, disparando os convites.
5. **Admin** monta o mapa na aba *Mapa de mesas*: cria as mesas, arrasta para organizar o layout,
   clica em uma mesa para acomodar convidados (mesa + cadeira). Passe o mouse para ver os ocupantes.
6. Na data-limite (**deadline**), o admin clica em **Processar expiração**: os convites não utilizados
   pelas empresas são recolhidos ao **pool de convites individuais**, distribuídos depois conforme
   indicação da organização (aba *Convidados* → "Convite individual").
7. No dia do evento, a aba **Credenciamento** faz o check-in lendo o QR code pela câmera
   (Chrome/Edge) ou colando o código/link.

## Convite digital

Cada convidado recebe um link único (`/convite/<código>`) com:
- QR code para o credenciamento;
- data, horário, local com **mapa do Google** e link de rota;
- mesa e cadeira (quando definidas);
- hotéis próximos e comodidades;
- botão **Confirmar presença**;
- para responsáveis de empresa: link, login e senha da plataforma.

## Relatórios (impressão / PDF)

Na aba **Relatórios** do painel do administrador: lista geral de convidados, lista de credenciamento
com campo de assinatura, relatório por empresa (cotas × usos), mapa de mesas com ocupação, relatório
de presença (confirmados × check-ins) e etiquetas/credenciais com QR code. Os relatórios abrem em
página otimizada para impressão com o **timbrado do evento** (imagem configurada na aba *Evento* →
Personalização) — use "Imprimir / Salvar PDF" do navegador para gerar o PDF.

## Envio de e-mail e WhatsApp

Configure copiando `.env.example` para `.env`:

- **E-mail (SMTP)**: preencha `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` etc. Sem configuração, o sistema
  opera em *modo simulação*: gera a mensagem pronta na tela para copiar e enviar manualmente.
- **WhatsApp**: sem configuração, o sistema gera um link **wa.me** com a mensagem pronta (abre o
  WhatsApp para envio com um clique). Para envio automático em massa, preencha `WHATSAPP_TOKEN` e
  `WHATSAPP_PHONE_ID` da API oficial (WhatsApp Cloud API / Meta).
- **BASE_URL**: em produção, defina a URL pública (ex.: `https://convites.suaempresa.com.br`) para
  que os links e QR codes dos convites funcionem fora da sua máquina.

## Detalhes técnicos

- **Stack**: Node.js (≥ 22.13) + Express + SQLite nativo (`node:sqlite`) — sem banco externo.
- **Dados**: gravados em `data/sistema.db` (faça backup deste arquivo).
- Senhas armazenadas com hash bcrypt. A senha gerada pelo admin fica visível no painel
  (coluna "Senha") apenas até o responsável trocá-la.
- Para recomeçar do zero, apague a pasta `data/` com o servidor parado (recria o admin e o evento exemplo).

## Estrutura

```
server.js            → servidor Express
src/db.js            → banco SQLite + seed
src/rotas/           → API (autenticação, admin, empresa, público)
src/mensagens.js     → modelos das mensagens de convite
src/envio.js         → e-mail (nodemailer), WhatsApp, QR code
public/              → telas (login, admin, empresa, convite digital)
```
