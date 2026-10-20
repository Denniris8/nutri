#!/bin/sh
# =============================================================================
# Túnel gratuito diario del dashboard (Cloudflare quick tunnel).
# - Arranca cloudflared contra el contenedor del dashboard.
# - Captura la URL publica https://xxxx.trycloudflare.com de sus logs.
# - La envía por Telegram (Bot API) a los IDs configurados en NOTIFY_CHAT_IDS.
# - Si cloudflared muere, el contenedor termina y restart:always genera una
#   URL nueva (y vuelve a notificar).
# =============================================================================
set -u

TARGET_URL="${TUNNEL_TARGET:-http://nutricion-dashboard:8080}"
TOKEN="${BOT_TOKEN:-}"
IDS="${NOTIFY_CHAT_IDS:-}"
LOG=/tmp/cloudflared.log

notify() {
  url="$1"
  if [ -z "$TOKEN" ] || [ -z "$IDS" ]; then
    echo "[tunnel] Aviso: falta BOT_TOKEN o NOTIFY_CHAT_IDS; no notifico por Telegram."
    return 0
  fi
  for id in $(echo "$IDS" | tr ',' ' '); do
    curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d chat_id="$id" \
      --data-urlencode "text=🌐 Dashboard accesible desde fuera:
${url}

(Se renueva a diario ~06:00 y te llegará la nueva dirección. Este enlace es privado: no lo compartas — quien lo tenga puede ver tu dashboard.)" >/dev/null && \
      echo "[tunnel] URL enviada por Telegram a $id" || \
      echo "[tunnel] Fallo enviando mensaje a $id"
  done
}

echo "[tunnel] Iniciando cloudflared hacia $TARGET_URL ..."
cloudflared tunnel --url "$TARGET_URL" >"$LOG" 2>&1 &
CF_PID=$!

URL=""
i=0
while [ "$i" -lt 60 ]; do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [ -n "$URL" ] && break
  kill -0 "$CF_PID" 2>/dev/null || break
  sleep 1
  i=$((i + 1))
done

if [ -n "$URL" ]; then
  echo "[tunnel] URL publica: $URL"
  notify "$URL"
else
  echo "[tunnel] No se obtuvo URL en 60s. Ultimas lineas de cloudflared:"
  tail -5 "$LOG"
fi

# Mantener el contenedor vivo mientras corra cloudflared
wait "$CF_PID"
