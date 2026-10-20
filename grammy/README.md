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

- Si mandas varios mensajes seguidos, se encolan y se responden en orden.
- Si el modelo pide permiso, llegan botones: ✅ una vez / ♾️ siempre / ❌ rechazar
  (o configura `OPENCODE_PERMISSION_MODE=once|always|reject` en `.env`).
- Si el modelo pregunta algo (herramienta question), llega como formulario;
  responde en un solo mensaje, una línea por pregunta, en orden.

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
