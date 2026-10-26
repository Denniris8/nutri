# =============================================================================
# Túnel público del dashboard (Cloudflare quick tunnel).
# - Arranca cloudflared contra el contenedor del dashboard.
# - Captura la URL publica https://xxxx.trycloudflare.com de sus logs.
# - La envía por Telegram (Bot API) a los IDs configurados en NOTIFY_CHAT_IDS.
# - Si cloudflared muere, el contenedor termina y restart:always genera una
#   URL nueva (y vuelve a notificar).
# =============================================================================
set -u

TARGET_URL="${TUNNEL_TARGET:-http://127.0.0.1:80}"
TOKEN="${BOT_TOKEN:-}"
IDS="${NOTIFY_CHAT_IDS:-}"
LOG=/tmp/cloudflared.log

notify() {
  url="$1"
  if [ -n "$TOKEN" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setChatMenuButton" \
      -H "Content-Type: application/json" \
      -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Dashboard\",\"web_app\":{\"url\":\"${url}/dashboard_nutricional.html\"}}}" >/dev/null
  fi
  if [ -z "$TOKEN" ] || [ -z "$IDS" ]; then
    echo "[tunnel] Aviso: falta BOT_TOKEN o NOTIFY_CHAT_IDS; no notifico por Telegram."
    return 0
  fi
  for id in $(echo "$IDS" | tr ',' ' '); do
    menu_result=$(curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/setChatMenuButton" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":${id},\"menu_button\":{\"type\":\"web_app\",\"text\":\"Dashboard\",\"web_app\":{\"url\":\"${url}/dashboard_nutricional.html\"}}}")
    case "$menu_result" in
      *'"ok":true'*) echo "[tunnel] Botón Dashboard actualizado para $id" ;;
      *) echo "[tunnel] Error actualizando botón para $id: $menu_result" ;;
    esac
    curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d chat_id="$id" \
       --data-urlencode "text=${url}" >/dev/null && \
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
  kill "$CF_PID" 2>/dev/null || true
  wait "$CF_PID" 2>/dev/null || true
  exit 1
fi

# Renovar si la página pública deja de responder con HTTP 200.
monitor_tunnel() {
  while kill -0 "$CF_PID" 2>/dev/null; do
    sleep 900
    kill -0 "$CF_PID" 2>/dev/null || return
    status=$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' "$URL/" 2>/dev/null)
    curl_status=$?
    [ "$curl_status" -eq 0 ] || status=000
    if [ "$status" != 200 ]; then
      echo "[tunnel] La página pública respondió HTTP $status; reiniciando para obtener otro enlace."
      kill "$CF_PID" 2>/dev/null || true
      return
    fi
    echo "[tunnel] Comprobación HTTP 200; se conserva la URL actual."
  done
}

monitor_tunnel &
MONITOR_PID=$!
wait "$CF_PID"
CF_STATUS=$?
kill "$MONITOR_PID" 2>/dev/null || true
wait "$MONITOR_PID" 2>/dev/null || true
exit "$CF_STATUS"
