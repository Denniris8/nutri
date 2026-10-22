# grammy — Puente Telegram ⇄ OpenCode

Bot de Telegram (grammY) que conecta tus mensajes **directamente con el modelo**
del servicio OpenCode de la Raspberry. Cada mensaje tuyo se convierte en un
prompt de una sesión que trabaja sobre el proyecto `nutricion_app`
(`/home/pcp/Desktop/app`), con todas sus herramientas (mysql, Garmin, archivos,
reportes…), y la respuesta del modelo regresa a Telegram. Es tiempo real: el
modelo puede pedirte permisos (botones) y hacerte preguntas (formularios) por
Telegram y tú respondes ahí mismo.

## Arquitectura

```
Telegram ⇄ grammY (contenedor, red host)
              │  HTTP + Basic auth (registro ~/.local/state/opencode/service.json)
              ▼
        OpenCode service (opencode serve --service, puerto dinámico en 127.0.0.1)
              │  sesión por chat (persistida en ./data/sessions.json)
              ▼
        Modelo con AGENTS.md del proyecto + herramientas
```

## Configuración (una sola vez)

1. Token del bot: en Telegram habla con **@BotFather** → `/newbot` → copia el token.
2. Tu chat id: habla con **@userinfobot** → copia tu Id.
3. Edita `app/grammy/.env`:
   ```
   BOT_TOKEN=123456789:AA...
   ALLOWED_CHAT_IDS=tu_id
   ```
4. Levanta el contenedor:
   ```bash
   cd /home/pcp/Desktop/app/grammy && sudo docker compose up -d --build
   ```
5. Prueba: escribe algo al bot → debe llegar al modelo y volver su respuesta.

## Comandos del bot

| Comando | Acción |
|---|---|
| `/start` `/help` | Info y ayuda |
| `/stop` | Interrumpe el turno en curso |
| `/nueva` | Borra la sesión y empieza una nueva en el próximo mensaje |
| `/sesion` | Estado: sesión, si está ocupado, cola, modo de permisos |
| `/ping` | Prueba de vida |
| `/dashboard` `/api` | Muestra rutas y métodos de la API Nutri |
| `/ssh` | Consulta si SSH está encendido o apagado |
| `/ssh on` | Enciende el servicio SSH |
| `/ssh off` | Pide confirmación y después apaga SSH |

- Si mandas varios mensajes seguidos, se encolan y se responden en orden.
- Si el modelo pide permiso, llegan botones: ✅ una vez / ♾️ siempre / ❌ rechazar
  (o configura `OPENCODE_PERMISSION_MODE=once|always|reject` en `.env`).
- Si el modelo pregunta algo (herramienta question), llega como formulario;
  responde en un solo mensaje, una línea por pregunta, en orden.
- Consulta rutas con `/api`, por ejemplo `/api GET /api/biometrics`.
  Para escribir: `/api POST /api/biometrics {"source":"manual","weightKg":75}`;
  cada POST/DELETE requiere confirmación en Telegram.

### Dashboard API Nutri

Añade al `.env` del bot las credenciales de la cuenta que iniciará sesión:

```env
NUTRI_API_URL=http://127.0.0.1:8080
NUTRI_API_PHONE=+52...
NUTRI_API_PASSWORD=...
```

El bot inicia sesión bajo demanda y mantiene la cookie solo en memoria; todas
las operaciones usan la identidad de esa sesión. `/dashboard` o `/api` lista
las rutas/métodos permitidos; `/api <GET|POST|DELETE> /api/ruta [JSON]` los invoca.
Registro/eliminación de cuentas y verificación Garmin (recibe una contraseña)
no se exponen en Telegram. Las demás escrituras y eliminaciones piden
confirmación.

### Configurar control de SSH en la Raspberry

El helper se limita a `systemctl start/stop/is-active ssh.service`, escucha solo
en `127.0.0.1:8765` y requiere un token.

```bash
TOKEN="$(openssl rand -hex 32)"
sudo install -m 0755 ssh_control.py /usr/local/bin/ssh_control.py
echo "SSH_CONTROL_TOKEN=$TOKEN" | sudo tee /etc/ssh-control.env >/dev/null
sudo chmod 600 /etc/ssh-control.env
sudo install -m 0644 ssh-control.service /etc/systemd/system/ssh-control.service
sudo systemctl daemon-reload
sudo systemctl enable --now ssh-control.service
```

Añade ese mismo `TOKEN` como `SSH_CONTROL_TOKEN` en `grammy/.env` y reconstruye
el bot (`sudo docker compose up -d --build`). `/ssh off` solo detiene SSH hasta
el siguiente arranque de la Raspberry; confirma antes porque puede cortar tu
conexión remota.

## Dependencia: servicio OpenCode

El bot necesita que el servicio OpenCode esté corriendo en la Raspberry
(`opencode serve --service`). Para que también arranque solo al encender la Pi
(igual que los contenedores), existe la unidad de systemd en
`~/.config/systemd/user/opencode.service`. Ya está *enable*; en el siguiente
arranque de la Raspberry subirá sola. Para activarla sin reiniciar:

```bash
systemctl --user start opencode.service
```

## Operación

```bash
sudo docker compose logs -f          # ver logs del bot
sudo docker compose restart          # reiniciarlo
sudo docker compose up -d --build    # reconstruir tras cambios de código
```
