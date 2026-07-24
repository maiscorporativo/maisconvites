#!/bin/sh
# Teste end-to-end dos 3 níveis de usuário (cria um evento de teste e remove no final)
B=${BASE_TESTE:-http://localhost:3000}
D="$(dirname "$0")"
JM="$D/cookies-master.txt"; JA="$D/cookies-admin.txt"; JC="$D/cookies-cp.txt"
rm -f "$JM" "$JA" "$JC"
falhas=0
ok()   { echo "  [OK]   $1"; }
erro() { echo "  [FALHA] $1"; falhas=$((falhas+1)); }
esperar() { # esperar <descricao> <esperado_substring> <obtido>
  case "$3" in *"$2"*) ok "$1";; *) erro "$1 — obtido: $3";; esac
}

echo "== 1. Login master =="
r=$(curl -s -c "$JM" -X POST "$B/api/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}')
esperar "login master" '"role":"master"' "$r"

echo "== 2. Master cria evento de teste =="
r=$(curl -s -b "$JM" -X POST "$B/api/admin/eventos" -H 'Content-Type: application/json' \
  -d '{"nome":"EVENTO TESTE E2E","data_evento":"2026-12-01","local_nome":"Local Teste","endereco":"Rua Teste, 1","deadline":"2026-11-20"}')
esperar "criar evento" '"ok":true' "$r"
EV=$(echo "$r" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "  evento id=$EV"

echo "== 3. Master cria admin do evento =="
r=$(curl -s -b "$JM" -X POST "$B/api/admin/eventos/$EV/admins" -H 'Content-Type: application/json' \
  -d '{"nome":"Cliente Teste E2E","email":"cliente@teste.local"}')
esperar "criar admin_evento" '"ok":true' "$r"
AU=$(echo "$r" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
AS=$(echo "$r" | sed -n 's/.*"senha":"\([^"]*\)".*/\1/p')
echo "  admin_evento: $AU / $AS"

echo "== 4. Login admin do evento =="
r=$(curl -s -c "$JA" -X POST "$B/api/login" -H 'Content-Type: application/json' -d "{\"username\":\"$AU\",\"password\":\"$AS\"}")
esperar "login admin_evento" '"role":"admin_evento"' "$r"

echo "== 5. Escopo do admin do evento =="
r=$(curl -s -b "$JA" "$B/api/admin/eventos")
n=$(echo "$r" | grep -o '"id":' | wc -l)
[ "$n" -ge 1 ] && echo "$r" | grep -q "EVENTO TESTE E2E" && ! echo "$r" | grep -q "FECOFAR" && ok "GET /eventos devolve só o dele" || erro "GET /eventos vazou outros eventos"
r=$(curl -s -b "$JA" -o /dev/null -w '%{http_code}' "$B/api/admin/eventos/1/stats")
esperar "stats de evento alheio bloqueado (403)" "403" "$r"
r=$(curl -s -b "$JA" -o /dev/null -w '%{http_code}' -X POST "$B/api/admin/eventos" -H 'Content-Type: application/json' -d '{"nome":"x","data_evento":"2026-01-01","local_nome":"x","endereco":"x","deadline":"2026-01-01"}')
esperar "criar evento bloqueado p/ admin_evento (403)" "403" "$r"
r=$(curl -s -b "$JA" -o /dev/null -w '%{http_code}' -X PUT "$B/api/admin/eventos/$EV/mapa" -H 'Content-Type: application/json' -d '{"ativo":0}')
esperar "toggle mapa bloqueado p/ admin_evento (403)" "403" "$r"

echo "== 6. Toggle do mapa (master) =="
r=$(curl -s -b "$JM" -X PUT "$B/api/admin/eventos/$EV/mapa" -H 'Content-Type: application/json' -d '{"ativo":0}')
esperar "desligar mapa" '"mapa_mesas":0' "$r"
r=$(curl -s -b "$JA" -o /dev/null -w '%{http_code}' -X POST "$B/api/admin/eventos/$EV/mesas" -H 'Content-Type: application/json' -d '{"quantidade":2}')
esperar "criar mesas com mapa desligado → 400" "400" "$r"

echo "== 7. Config de envio do evento (admin_evento) =="
r=$(curl -s -b "$JA" -X PUT "$B/api/admin/eventos/$EV/envio" -H 'Content-Type: application/json' \
  -d '{"remetente_nome":"Cliente Teste","reply_to":"cliente@teste.local","smtp_modo":"global"}')
esperar "salvar config de envio" '"ok":true' "$r"
r=$(curl -s -b "$JA" "$B/api/admin/eventos/$EV/envio")
esperar "ler config (remetente)" '"remetente_nome":"Cliente Teste"' "$r"
echo "$r" | grep -q '"smtp_pass"' && erro "GET /envio expôs smtp_pass!" || ok "senha SMTP não exposta"
r=$(curl -s -b "$JA" "$B/api/admin/eventos/$EV/whatsapp/status")
esperar "status WhatsApp (nao_criada)" '"estado":"nao_criada"' "$r"

echo "== 8. Admin do evento cria convidado principal =="
r=$(curl -s -b "$JA" -X POST "$B/api/admin/empresas" -H 'Content-Type: application/json' \
  -d "{\"evento_id\":$EV,\"empresa_nome\":\"Empresa Teste E2E\",\"cota\":3,\"nome\":\"Resp Teste\"}")
esperar "criar convidado principal" '"ok":true' "$r"
CU=$(echo "$r" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
CS=$(echo "$r" | sed -n 's/.*"senha":"\([^"]*\)".*/\1/p')
echo "  convidado principal: $CU / $CS"

echo "== 9. Login convidado principal + painel =="
r=$(curl -s -c "$JC" -X POST "$B/api/login" -H 'Content-Type: application/json' -d "{\"username\":\"$CU\",\"password\":\"$CS\"}")
esperar "login convidado_principal" '"role":"convidado_principal"' "$r"
r=$(curl -s -b "$JC" "$B/api/empresa/painel")
esperar "painel carrega" '"empresa"' "$r"
esperar "mapa nulo (desligado)" '"mapa":null' "$r"
r=$(curl -s -b "$JC" -o /dev/null -w '%{http_code}' "$B/api/admin/eventos")
esperar "convidado principal bloqueado no /api/admin (403)" "403" "$r"

echo "== 10. Inserção dispara envio automático =="
r=$(curl -s -b "$JC" -X POST "$B/api/empresa/convidados" -H 'Content-Type: application/json' \
  -d '{"nome":"Convidado Sem Contato"}')
esperar "inserir sem contato → envio nulo nos 2 canais" '"envio":{"email":null,"whatsapp":null' "$r"
CID=$(echo "$r" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
r=$(curl -s -b "$JC" -X PUT "$B/api/empresa/convidados/$CID" -H 'Content-Type: application/json' \
  -d '{"nome":"Convidado Renomeado"}')
esperar "editar contato → devolve campo envio" '"envio":{' "$r"

echo "== 11. Convite público =="
TK=$(cd "$(dirname "$0")/.." && node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/sistema.db',{readOnly:true});console.log(db.prepare('SELECT token FROM convidados WHERE id=?').get($CID).token)")
r=$(curl -s "$B/api/convite/$TK")
esperar "dados do convite público" '"convidado"' "$r"
esperar "sem assento (mapa desligado)" '"mesa_numero":null' "$r"
r=$(curl -s -X POST "$B/api/convite/$TK/confirmar")
esperar "RSVP confirma presença" '"ok":true' "$r"

echo "== 12. Check-in (admin do evento) =="
r=$(curl -s -b "$JA" -X POST "$B/api/admin/checkin" -H 'Content-Type: application/json' -d "{\"token\":\"$TK\"}")
esperar "check-in" 'Check-in confirmado' "$r"

echo "== 13. Login antigo (empresa migrada p/ convidado_principal) =="
r=$(cd "$(dirname "$0")/.." && node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/sistema.db',{readOnly:true});const u=db.prepare(\"SELECT username, role, evento_id FROM usuarios WHERE role='convidado_principal' AND evento_id=1 LIMIT 1\").get();console.log(JSON.stringify(u))")
echo "  usuário migrado: $r"

echo "== 14. Limpeza: excluir evento de teste (master) =="
r=$(curl -s -b "$JM" -X DELETE "$B/api/admin/eventos/$EV")
esperar "excluir evento de teste" '"ok":true' "$r"
r=$(cd "$(dirname "$0")/.." && node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/sistema.db',{readOnly:true});console.log(db.prepare('SELECT COUNT(*) c FROM usuarios WHERE evento_id=?').get($EV).c)")
esperar "usuários do evento removidos em cascata" "0" "$r"

echo ""
if [ "$falhas" -eq 0 ]; then echo "✅ TODOS OS TESTES PASSARAM"; else echo "❌ $falhas FALHA(S)"; fi
rm -f "$JM" "$JA" "$JC"
exit "$falhas"
