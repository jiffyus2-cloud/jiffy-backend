#!/usr/bin/env bash
#
# Canjea un código de configuración de 1clic.ai e instala la clave en Cloud Run.
#
# Pensado para Cloud Shell (tiene gcloud, curl y jq). Cubre los pasos A, B y C
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
#   PROJECT                jiffy-photos-app
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
PROJECT="${PROJECT:-jiffy-photos-app}"
REPO="${REPO:-jiffyus2-cloud/jiffy-backend}"
HOST="${HOST:-jiffyphotos.com}"
API="https://www.1clic.ai/api/v1"
EVENTS="$API/connections/$ONECLIC_CONNECTION_ID/events"

for tool in curl jq gcloud; do
  command -v "$tool" >/dev/null || { echo "Falta $tool" >&2; exit 2; }
done

# ── A. Anunciarse (sin clave) ────────────────────────────────────────────────
echo "A. Avisando a 1clic (agent_connected)…"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$EVENTS" \
  -H 'Content-Type: application/json' -d '{"step":"agent_connected"}')
echo "   HTTP $code"

# ── B. Canjear el código ─────────────────────────────────────────────────────
echo "B. Canjeando el código de configuración…"
provision=$(curl -sS -w '\n%{http_code}' -X POST "$API/keys/provision" \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg code "$SETUP_CODE" --arg repo "$REPO" --arg host "$HOST" \
        '{setup_code:$code, origin:{repo:$repo, host:$host, agent:"Claude Code (Opus 5) via Cloud Shell"}}')")
code=${provision##*$'\n'}
body=${provision%$'\n'*}

if [[ "$code" != "200" ]]; then
  echo "   1clic respondió HTTP $code:" >&2
  echo "$body" | jq -r '.error | "   \(.code): \(.message)"' >&2 || echo "$body" >&2
  exit 1
fi

KEY=$(echo "$body" | jq -r '.key')
unset body provision
[[ -n "$KEY" && "$KEY" != "null" ]] || { echo "   La respuesta no trae clave." >&2; exit 1; }

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
echo "Listo. Siguiente paso (D): entra en jiffyphotos.com → Dashboard → Conexiones → 'Verificar ahora'."
echo "Si el panel dice 'agent_not_allowed', no es un fallo: asigna un agente a la conexión en 1clic."
