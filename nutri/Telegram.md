# Reglas del bot de Telegram (grammy)

## Usuario fijo por chat

- Para peticiones que lleguen por el bot de Telegram (grammy) con chat_id `1532527749` o `5847110512`, el usuario es siempre **Osiris** (`usuario_id=4`, timezone `America/Monterrey`).
- En esos chats NO preguntar por el usuario; solo preguntar si no se pudiera determinar el chat_id.
- Todas las operaciones en BD desde esos chats se apuntan al `usuario_id=4`.

## Respuesta al usuario

- Siempre esperar y entregar una respuesta en el bot de Telegram, sin importar cuánto tarde el procesamiento. No cancelar ni interrumpir la respuesta por timeout o demoras.
- Las respuestas del bot deben ser precisas y adaptadas para leer en pantalla de celular: texto corto, listas simples, tablas pequeñas (pocas columnas), sin bloques largos de ancho fijo.

## Reportes automáticos programados

- **Resumen diario 01:59**: resumen del día nutricional vigente (kcal vs objetivo, macros, eventos).
- **Resumen diario 17:00**: el mismo resumen del día nutricional vigente.
- **Reporte semanal (domingo 20:00)**: promedio de kcal consumidas, adherencia a objetivos, días de fuerza vs consumo, y cambio de peso semanal según biométricos.
- **Alerta de sueño/gym (diaria 10:00)**: si Garmin muestra entrenamiento ayer y sueño < 6 h, emitir alerta corta de recuperación.

## Dashboard en móvil

- En pantalla de celular (<=768px) el dashboard muestra el encabezado con usuario activo y objetivos personales guardados, los objetivos del día y la lista de comidas; se ocultan insights, Garmin, biométricos, plicómetro, calidad, composición corporal y gráficos de período.

## Historial de objetivos

- Cualquier cambio en `objetivos_diarios` queda versionado en `objetivos_diarios_historial` (via trigger), para poder revisar la evolución de los objetivos en el tiempo.
