# Reglas de `tunnel`

- Este directorio contiene solo el túnel público del dashboard; el destino predeterminado del contenedor es `http://127.0.0.1:8080` y Compose usa `network_mode: host`.
- Configura `BOT_TOKEN` desde `../grammy/.env` y `NOTIFY_CHAT_IDS` desde `tunnel/.env`. No escribas ni registres secretos en este archivo, scripts o logs versionados.
- `notify-tunnel.sh` inicia Cloudflare Quick Tunnel, espera hasta 60 segundos por una URL `trycloudflare.com` y la notifica a los chats configurados. Si `cloudflared` termina, `restart: always` inicia un proceso nuevo y puede generar otra URL.
- Cada 15 minutos consulta la página pública. Solo conserva la URL si recibe HTTP 200; ante otro estado o error de conexión termina `cloudflared` para que `restart: always` genere y notifique un enlace nuevo.
- Comparte la URL con cuidado; el mensaje de Telegram la identifica como privada. La renovación diaria a las 06:00 depende de un timer de systemd externo, no versionado en este directorio.
- Si un `git pull` trae cambios bajo `tunnel/`, ejecutar `./pull` desde la carpeta base `proyecto nutri` reconstruye y recrea este servicio. El Dockerfile descarga la versión `latest` de `cloudflared` para ARM64.
