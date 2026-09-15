#!/usr/bin/env bash
#
# Canjea un código de configuración de 1clic.ai e instala la clave en Cloud Run.
#
# Corre en Cloud Shell o en Git Bash de Windows con el Cloud SDK instalado
# (tiene que haber gcloud, curl y node). Cubre los pasos A, B y C
# del bloque de conexión y la rotación a los 90 días, que es el mismo camino:
#
#   A. avisa a 1clic de que un agente llegó (sin clave)
#   B. canjea el código (un solo uso, caduca a los 60 minutos)
#   C. escribe ONECLIC_API_KEY y ONECLIC_CONNECTION_ID en el servicio y se lo
#      dice a 1clic (step=key_installed)
#
# La clave solo vive en una variable de este proceso: no se imprime, no va al
# historial y no queda en ningún archivo. Si necesitas verla, no la necesitas.
#
# Uso:
#   bash scripts/oneclic-install-key.sh 1CLC-XXXX-XXXX-XXXX
#
# Variables opcionales (con sus valores por defecto para producción):
#   ONECLIC_CONNECTION_ID  1767800c-c10e-491d-8ee7-19dc0a24aae7
#   SERVICE                jiffy-backend
#   REGION                 europe-west1
#   PROJECT                project-d2f55c96-6c64-431f-b40   (el de Cloud Run, NO el de Firebase)
#   REPO                   jiffyus2-cloud/jiffy-backend   (origen que se ata a la clave)
#   HOST                   jiffyphotos.com

set -euo pipefail

SETUP_CODE="${1:-}"
if [[ ! "$SETUP_CODE" =~ ^1CLC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$ ]]; then
  echo "Uso: $0 1CLC-XXXX-XXXX-XXXX" >&2
  exit 2
fi

ONECLIC_CONNECTION_ID="${ONECLIC_CONNECTION_ID:-1767800c-c10e-491d-8ee7-19dc0a24aae7}"
SERVICE="${SERVICE:-jiffy-backend}"
REGION="${REGION:-europe-west1}"
PROJECT="${PROJECT:-project-d2f55c96-6c64-431f-b40}"
REPO="${REPO:-jiffyus2-cloud/jiffy-backend}"
HOST="${HOST:-jiffyphotos.com}"
API="https://www.1clic.ai/api/v1"
EVENTS="$API/connections/$ONECLIC_CONNECTION_ID/events"

# En Git Bash (Windows) el wrapper gcloud.cmd rompe con argumentos con espacios;
# si está el Python empaquetado del SDK se llama a lib/gcloud.py directamente.
if ! command -v gcloud >/dev/null; then
  for sdk in "${CLOUDSDK_ROOT_DIR:-}" "${LOCALAPPDATA:-}/Google/Cloud SDK/google-cloud-sdk" "/c/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk"; do
    if [[ -n "$sdk" && -f "$sdk/lib/gcloud.py" && -f "$sdk/platform/bundledpython/python.exe" ]]; then
      SDK_ROOT="$sdk"
      gcloud() { "$SDK_ROOT/platform/bundledpython/python.exe" "$SDK_ROOT/lib/gcloud.py" "$@"; }
      break
    fi
  done
fi

for tool in curl node gcloud; do
  command -v "$tool" >/dev/null || { echo "Falta $tool" >&2; exit 2; }
done

# JSON con node (está en Cloud Shell y en cualquier máquina con este repo); así no dependemos de jq.
json_get() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))}catch{}})' "$1"; }

# ── A. Anunciarse (sin clave) ────────────────────────────────────────────────
echo "A. Avisando a 1clic (agent_connected)…"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$EVENTS" \
  -H 'Content-Type: application/json' -d '{"step":"agent_connected"}')
echo "   HTTP $code"

# ── B. Canjear el código ─────────────────────────────────────────────────────
echo "B. Canjeando el código de configuración…"
provision=$(curl -sS -w '\n%{http_code}' -X POST "$API/keys/provision" \
  -H 'Content-Type: application/json' \
  -d "$(node -e 'process.stdout.write(JSON.stringify({setup_code:process.argv[1],origin:{repo:process.argv[2],host:process.argv[3],agent:"Claude Code (Opus 5)"}}))' "$SETUP_CODE" "$REPO" "$HOST")")
code=${provision##*$'\n'}
body=${provision%$'\n'*}

if [[ "$code" != "200" ]]; then
  echo "   1clic respondió HTTP $code: $(printf '%s' "$body" | json_get error.code) — $(printf '%s' "$body" | json_get error.message)" >&2
  exit 1
fi

KEY=$(printf '%s' "$body" | json_get key)
ROTATED=$(printf '%s' "$body" | json_get rotated)
MISMATCH=$(printf '%s' "$body" | json_get scope.repo_mismatch)
unset body provision
[[ -n "$KEY" ]] || { echo "   La respuesta no trae clave." >&2; exit 1; }
[[ "$ROTATED" == "true" ]] && echo "   (rotación: la clave anterior sigue valiendo 24 h)"
[[ "$MISMATCH" == "true" ]] && echo "   AVISO: el repo declarado no coincide con el que el dueño escribió en 1clic." >&2

# Todo lo que se imprime de aquí es metadato, nunca la clave.
echo "   Clave recibida (prefijo $(printf '%s' "$KEY" | cut -c1-8)…)."

# ── C. Instalarla donde el servidor lee sus secretos ─────────────────────────
echo "C. Escribiendo ONECLIC_API_KEY y ONECLIC_CONNECTION_ID en Cloud Run ($SERVICE, $REGION)…"
# `^##^` cambia el separador de variables a `##`: así ningún valor con comas rompe la lista.
gcloud run services update "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "^##^ONECLIC_API_KEY=${KEY}##ONECLIC_CONNECTION_ID=${ONECLIC_CONNECTION_ID}" \
  >/dev/null

echo "   Hecho. Avisando a 1clic (key_installed)…"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$EVENTS" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"step":"key_installed","env_var":"ONECLIC_API_KEY"}')
echo "   HTTP $code"

unset KEY
echo
echo "Listo. Siguiente paso (D): entra en https://jiffyphotos.com/lab/1clic con la cuenta de administración → Verificar ahora."
echo "Si el panel dice 'agent_not_allowed', no es un fallo: asigna un agente a la conexión en 1clic."
