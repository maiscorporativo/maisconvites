#!/bin/sh
# Teste da importação de convidados principais via planilha (xlsx, xls e csv)
B=${BASE_TESTE:-http://localhost:3000}
D="$(dirname "$0")"
J="$D/cookies-imp.txt"; rm -f "$J"
falhas=0
ok()   { echo "  [OK]   $1"; }
erro() { echo "  [FALHA] $1"; falhas=$((falhas+1)); }
esperar() { case "$3" in *"$2"*) ok "$1";; *) erro "$1 — obtido: $(echo "$3" | head -c 300)";; esac; }

curl -s -c "$J" -X POST "$B/api/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' >/dev/null

echo "== Modelo para download =="
ct=$(curl -s -b "$J" -o /dev/null -w '%{content_type}' "$B/api/admin/importar/modelo")
esperar "modelo .xlsx servido" "spreadsheetml" "$ct"

echo "== Evento de teste =="
r=$(curl -s -b "$J" -X POST "$B/api/admin/eventos" -H 'Content-Type: application/json' \
  -d '{"nome":"EVENTO TESTE IMPORT","data_evento":"2026-12-01","local_nome":"L","endereco":"E","deadline":"2026-11-20"}')
EV=$(echo "$r" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
[ -n "$EV" ] && ok "evento criado (id=$EV)" || { erro "criar evento"; exit 1; }

testar_formato() { # <arquivo> <rotulo>
  b64=$(base64 -w0 "$D/$1" 2>/dev/null || base64 "$D/$1" | tr -d '\n')
  r=$(curl -s -b "$J" -X POST "$B/api/admin/eventos/$EV/importar" -H 'Content-Type: application/json' \
    -d "{\"arquivo\":\"$b64\",\"confirmar\":false}")
  esperar "$2: preview lê a planilha" '"preview":true' "$r"
  esperar "$2: 5 linhas detectadas" '"total":5' "$r"
  esperar "$2: 3 válidas (2 inválidas)" '"validas":3' "$r"
  esperar "$2: acusa linha sem empresa" 'sem nome de empresa' "$r"
  esperar "$2: acusa duplicada na planilha" 'duplicada na planilha' "$r"
  esperar "$2: acusa e-mail inválido (aviso)" 'formato inv' "$r"
}

echo "== Preview .xlsx =="; testar_formato teste-import.xlsx "xlsx"
echo "== Preview .xls  =="; testar_formato teste-import.xls  "xls"
echo "== Preview .csv  =="; testar_formato teste-import.csv  "csv"

echo "== Confirmar importação (.xlsx) =="
b64=$(base64 -w0 "$D/teste-import.xlsx" 2>/dev/null || base64 "$D/teste-import.xlsx" | tr -d '\n')
r=$(curl -s -b "$J" -X POST "$B/api/admin/eventos/$EV/importar" -H 'Content-Type: application/json' \
  -d "{\"arquivo\":\"$b64\",\"confirmar\":true}")
esperar "3 criadas" '"username":"gama.medicamentos"' "$r"
esperar "cota vazia virou padrão 4" '"empresa_nome":"Beta Distribuidora","nome":"Bruno Beta","cota":4' "$r"
esperar "cota não numérica virou padrão 4" '"empresa_nome":"Gama Medicamentos","nome":"Carla Gama","cota":4' "$r"
echo "$r" | grep -qF '"ignoradas":[{"linha"' && ok "2 ignoradas devolvidas" || erro "2 ignoradas devolvidas"

echo "== Estado no banco =="
r=$(curl -s -b "$J" "$B/api/admin/eventos/$EV/empresas")
n=$(echo "$r" | grep -o '"username"' | wc -l | tr -d ' ')
esperar "3 convidados principais no evento" "3" "$n"
esperar "responsável da Alfa inscrito consumiu cota" '"usados":1' "$r"
r=$(curl -s -b "$J" "$B/api/admin/eventos/$EV/stats")
esperar "cota_total = 5+4+4 = 13" '"cota_total":13' "$r"

echo "== Reimportar mesmo arquivo → tudo já cadastrado =="
r=$(curl -s -b "$J" -X POST "$B/api/admin/eventos/$EV/importar" -H 'Content-Type: application/json' \
  -d "{\"arquivo\":\"$b64\",\"confirmar\":false}")
esperar "0 válidas na reimportação" '"validas":0' "$r"
esperar "acusa já cadastrada" 'cadastrada neste evento' "$r"

echo "== Limpeza =="
r=$(curl -s -b "$J" -X DELETE "$B/api/admin/eventos/$EV")
esperar "evento de teste excluído" '"ok":true' "$r"

echo ""
if [ "$falhas" -eq 0 ]; then echo "✅ TODOS OS TESTES DE IMPORTAÇÃO PASSARAM"; else echo "❌ $falhas FALHA(S)"; fi
rm -f "$J"
exit "$falhas"
