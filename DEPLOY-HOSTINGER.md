# Deploy na Hostinger — Sistema de Convites

## Opção A (recomendada p/ plano Cloud): Deploy Web App via GitHub

No hPanel: **Sites → Adicionar site → Deploy Web App → GitHub**, repositório
`maiscorporativo/maisconvites`, branch `main`.

Configurações do app:

- **Runtime:** Node.js **22 ou superior** (obrigatório — o sistema usa o SQLite
  embutido do Node, disponível a partir do 22.13; em Node 18/20 o app não inicia).
- **Build command:** `npm install`
- **Start command:** `node server.js`
- **Variáveis de ambiente** (no painel do web app — não suba o `.env` para o GitHub):

| Variável | Valor |
|---|---|
| `BASE_URL` | `https://SEU-DOMINIO` (essencial: links e QR dos convites) |
| `SESSION_SECRET` | string aleatória longa |
| `TRUST_PROXY` | `1` |
| `DATA_DIR` | caminho persistente fora da pasta do app (ver abaixo) |
| `SMTP_*` | se for usar e-mail global (ver `.env.example`) |

### SQLite: os 2 cuidados que importam

1. **Nada para instalar** — o banco é um arquivo criado pelo próprio app no primeiro
   start (login inicial `admin`/`admin123`). Não existe "criar banco MySQL" no painel.
2. **Persistência entre deploys** — em deploy via GitHub, cada novo deploy substitui a
   pasta do app. Se o banco estiver dentro dela (padrão `./data`), **um redeploy pode
   apagar todos os cadastros**. Por isso defina `DATA_DIR` apontando para uma pasta
   fora do diretório do app (ex.: `/home/SEU_USUARIO/dados-convites`). Faça um deploy
   de teste, cadastre algo, redeploye e confira se os dados sobreviveram **antes** de
   usar em produção. Se a plataforma não oferecer nenhum caminho gravável persistente,
   use a Opção B (VPS), onde isso não é um problema.

Backup: baixe periodicamente os arquivos `sistema.db`, `sistema.db-wal` e `sistema.db-shm`
(e a pasta `uploads/`) do `DATA_DIR`.

---

## Opção B: VPS da Hostinger

## ⚠️ Antes de tudo: qual plano você tem?

Este sistema é uma aplicação **Node.js (Express + SQLite)** — ele **NÃO roda em
hospedagem compartilhada** da Hostinger (planos "Web/Business Hosting", que são
PHP/estático). Você precisa de um **VPS da Hostinger** (qualquer KVM serve; o
KVM 1 é suficiente) ou de outro serviço que rode Node.js 22+.

Requisito de versão: **Node.js ≥ 22.13** (o sistema usa o SQLite embutido do Node —
não há banco externo para instalar; os dados ficam no arquivo `data/sistema.db`).

## 1. Criar o VPS

1. No hPanel → **VPS** → escolha o template **Ubuntu 24.04** (limpo) ou
   "Ubuntu com Node.js" se disponível.
2. Anote o IP e aponte o DNS do seu domínio/subdomínio (ex.: `convites.seudominio.com.br`)
   para esse IP (registro A).

## 2. Instalar Node 22 e utilitários (SSH)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx unzip
sudo npm i -g pm2
node -v   # deve mostrar v22.x
```

## 3. Subir o pacote

Envie o arquivo `sistema-convite-deploy.zip` (via SFTP/painel) e:

```bash
sudo mkdir -p /var/www/sistema-convite && cd /var/www/sistema-convite
sudo unzip ~/sistema-convite-deploy.zip -d .
sudo npm install --omit=dev
cp .env.example .env
nano .env
```

No `.env`, ajuste:

```
PORT=3000
BASE_URL=https://convites.seudominio.com.br   ← ESSENCIAL: os QR codes e links dos convites usam isso
SESSION_SECRET=<string aleatória longa — ex.: saída de: openssl rand -hex 32>
TRUST_PROXY=1                                  ← atrás do nginx com HTTPS
SMTP_...                                       ← se for usar e-mail global
```

> O banco é criado sozinho no primeiro start (login inicial `admin` / `admin123` — troque a senha).
> **Para levar os dados já cadastrados no seu computador:** copie a pasta `data/` local
> (arquivos `sistema.db`, `sistema.db-wal`, `sistema.db-shm` e `data/uploads/`) para
> `/var/www/sistema-convite/data/` ANTES do primeiro start, com o servidor local desligado.

## 4. Rodar com PM2 (reinicia sozinho)

```bash
cd /var/www/sistema-convite
pm2 start server.js --name sistema-convite
pm2 save && pm2 startup   # siga a instrução que ele imprimir
```

## 5. HTTPS com nginx + certificado gratuito

```bash
sudo tee /etc/nginx/sites-available/sistema-convite <<'EOF'
server {
  server_name convites.seudominio.com.br;
  client_max_body_size 8m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
EOF
sudo ln -s /etc/nginx/sites-available/sistema-convite /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d convites.seudominio.com.br
```

Pronto: `https://convites.seudominio.com.br` com cadeado válido — **sem aviso de
certificado** e com a câmera do credenciamento funcionando em qualquer celular
(a pasta `certs/` local e a porta 3443 eram só para a rede interna; em produção
o HTTPS é do nginx e nada disso é usado).

## 6. Depois de subir — checklist

- [ ] Trocar a senha do `admin` no menu do usuário.
- [ ] Conferir `BASE_URL` gerando um convite e lendo o QR (deve abrir o domínio, não localhost).
- [ ] Testar credenciamento pela câmera no celular.
- [ ] Backup: agende cópia da pasta `data/` (ex.: `pm2` + cron com `sqlite3 .backup` ou cópia dos 3 arquivos com o app parado).

## Atualizações futuras

Substitua os arquivos do app (menos `.env` e `data/`) e rode `pm2 restart sistema-convite`.
