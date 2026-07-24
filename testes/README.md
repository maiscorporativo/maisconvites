# Testes E2E do sistema

Dois roteiros de teste de ponta a ponta, via API (curl):

| Script | O que cobre |
|---|---|
| `teste-e2e.sh` | Os 3 níveis de usuário: master cria evento e admin do evento; escopos/permissões (403); toggle do mapa; config de envio; convidado principal inscreve convidado (disparo automático); convite público + RSVP; check-in; exclusão em cascata. |
| `teste-importacao.sh` | Importação de planilhas (.xlsx, .xls, .csv): preview, validações (sem empresa, duplicada, e-mail inválido), confirmação, cotas padrão, reimportação e limpeza. |

## Como rodar

Com o servidor local no ar (`npm run dev`):

```sh
sh testes/teste-e2e.sh
sh testes/teste-importacao.sh
```

Requisitos: usuário master `admin`/`admin123` (padrão do seed) e Git Bash/sh no Windows.
Cada script cria seus próprios dados de teste ("EVENTO TESTE …") e os exclui ao final.

## Contra outro ambiente

`BASE_TESTE=https://seu-dominio sh testes/teste-importacao.sh`

⚠️ **Evite rodar contra produção**: os testes criam e excluem eventos reais no banco
e assumem a senha padrão do master. Algumas verificações do `teste-e2e.sh` leem o
arquivo `data/sistema.db` diretamente, portanto só funcionam na máquina onde o
servidor está rodando.
