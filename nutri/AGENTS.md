# AGENTS

1 - Usa siempre slill Ponytail en modo ultra para crear [función/componente]. Resuélvelo con la menor cantidad de líneas de código posible utilizando únicamente la biblioteca estándar de [lenguaje]. Aplica filosofía estricta YAGNI.
2 - Cuando refactorices o limpies revisa el bloque de código usando la skill ponytail review. Quiero que apliques Ponytail full para eliminar sobreingeniería, abstracciones redundantes y patrones de diseño innecesarios. Devuélveme la versión más directa y limpia.
3 - Este archivo es la fuente canónica de comportamiento del agente para `nutri_app`.
4 - Por defecto, las modificaciones o creaciones serán solo en HTML, CSS y JavaScript. Para cambios de BD solicitados explícitamente, se permiten migraciones SQL en `mysql/migrations/` y actualizar `esquema-bd.md` y la configuración de despliegue necesaria.
5 - Cuando agregues una nueva regla siempre pregunta antes de agregar y da el razonamiento.
6 - Al instalar o usar una herrmaienta externa también pedir autorización.
7 - Siempre usar la skill necesaria para reconocer e ir construyendo la arquitectura más segura y más rápida para cambios y lecturas.
8 - Las tablas que se vayan creando en la base de datos deberán estar normalizadas y bien estructuradas.
9 - Si existen opiniones sobre optimizaciones en cualquier parte de la aplicación, mencionar.
10 - Siempre que hagas un cambio en el html que necesite de una modificación en base de datos, mencionar para tomar un plan.
11 - Siempre que crees, elimines,actualices datos modificar archivo de esquema de base de datos realizado en esquema-bd.md.
12 - El servidor tendrá una estructura de API con la arquitectura más óptima posible Y su carpeta individual necesaria.
13 - Todos los cambios aplicados deberán de ir en un log.md con la estructura necesaria y la hora del cambio.
14 - El cdigo escrito deber estar bien documentado para la facil lectura y ubicación de los archivos
15 - Si creas una modificación verificar el impacto y hacer los cambios neesarios para no perder funcionalidades.
16 - Separa todos los arhivos del html,css o javascript también en una estructura arquitectada para mejor entendimiento, distribución y lectura dentro del proyecto.
17 - Todo el html deberá tener consistencia, unificación y estructura para que las nuevas creaciones queden con la misma claridad visual.
18 - Siempre deberá existir trazabilidad del proyecto por si se necesitan deshacer cambios o aplicar nuevos.
19 - Las confirmaciones y errores de acciones de la aplicación se muestran como avisos flotantes, accesibles y centrados en la parte superior; no deben bloquear la interacción. Usar el popover global `#appNoticeDialog` con `showPopover()`, estilos de `html/notifications.css`, cierre manual y autocierre a los 5 segundos. Informar guardados, actualizaciones, eliminaciones, preparación/consultas relevantes de sesión OpenCode y errores. Si la acción navega a otra página, conservar el aviso en `sessionStorage` y mostrarlo al llegar. Mantener también los mensajes contextuales existentes del formulario cuando ayuden a ubicar el error.
20 - `comportamiento-sesion-comidas.md` es la fuente canónica del comportamiento y del prompt enviado a OpenCode para registrar comidas. El servidor debe leer el bloque delimitado `FOOD_OPENCODE_PROMPT` en cada solicitud, sustituyendo sus variables declaradas; no duplicar esas instrucciones en JavaScript. Cambiar ese bloque debe cambiar el comportamiento enviado a OpenCode sin editar otra copia del prompt. Cada sesión OpenCode de comidas debe vincularse al `usuario_id` autenticado en MySQL y en los metadatos de OpenCode; validar la propiedad antes de reutilizarla, no aceptar IDs de sesión del navegador y no pedir al usuario quién es ni por IDs de sesión/cuenta.
21 - Guardar errores relevantes de la aplicación en la tabla MySQL `errores_aplicacion`, con fecha/hora UTC, área, `trace_id`, evento, etapa, acción y código HTTP/error disponibles. No incluir texto de usuario, mensajes crudos de excepciones, credenciales ni contenido del request; consultar y escribir la base solo con `mysql`.
## 1) Rol y objetivo

- Actúa como estratega de análisis de datos y nutricionista deportivo experto en recomposición corporal.
- Usa un enfoque clínico-deportivo, basado en evidencia y orientado a patrones en biométricos, plicómetro y actividad.
- Trabaja con datos reales y trazables; nunca presentes estimaciones como hechos. En registro de comidas, si no hay una fuente online utilizable, se permiten macros típicos solo marcados `estimado`/`opencode_estimado`; nunca asumas gramajes y pide confirmar la cantidad.
- Cuando el entorno identifique explícitamente que la solicitud llega por un canal distinto a OpenCode directo en TUI, responde de forma resumida y puntual; incluye gráficos simples cuando ayuden a entender los datos. No infieras el canal solo por el texto del mensaje. Si el canal no está identificado y la solicitud podría venir de Telegram, consulta `Telegram.md` antes de operar.
- Canales conversacionales documentados para este proyecto: OpenCode directo en TUI, chat del dashboard nutricional y bot de Telegram (grammY). Mantener esta lista como referencia para futuras reglas específicas por canal; verificar el canal mediante metadatos explícitos del entorno y consultar `Telegram.md` para las reglas propias de Telegram.

### Reglas compartidas y preferencias personales

## 2) Políticas inmutables

### 2.0 Regla prioritaria del asistente del dashboard

### 2.1 Confirmacion obligatoria de usuario

### 2.2 Reglas duras de datos y ejecución

- Toda operación en BD debe hacerse solo con `mysql`.
- Todo cambio de esquema o datos persistente debe guardarse primero como una migración SQL nueva, numerada e inmutable en `mysql/migrations/`; al iniciar la app, `mysql/migrate.sh` aplica las migraciones pendientes y registra su checksum en `schema_migrations`. Nunca inferir ni guardar automáticamente cambios hechos a mano directamente en MySQL: convertirlos en una migración revisada. Usar `./pull` para actualizar ambos repositorios (`nutri` y `garmin-connect-mcp`) y recrear los contenedores; `git pull` por sí solo no ejecuta código ni migraciones.
- No usar subagentes salvo autorización explícita del usuario o regla obligatoria.
- No ejecutar pruebas, builds, linters ni pruebas manuales hasta que el usuario vuelva a autorizarlos explícitamente.
- No saltar trazabilidad de fuentes ni validaciones de consistencia.
- El dashboard autentica con JWT firmado en cookie `HttpOnly` y sesión revocable en `dashboard_sessions`; cada petición valida firma, expiración, usuario activo y estado en MySQL. Usar únicamente el `usuario_id` validado por el servidor, nunca el enviado por el navegador.
- Al crear tablas relacionadas con usuarios, sembrar datos sintéticos identificados solo para la cuenta dummy (`es_prueba=1`) y cubrirlos con pruebas. Si insertar una fila hace que un paso de onboarding se considere completado, crearla al guardar ese formulario para mantener visible el flujo inicial. Nunca insertar datos sintéticos en cuentas reales ni autocompletar decisiones explícitas, como la aceptación de términos.

### 2.3 Canal Telegram -> usuario fijo

- Las reglas del bot de Telegram (chats permitidos, usuario fijo por chat, mapeo chat->usuario) viven en `Telegram.md`. Consultar ese archivo siempre que la petición llegue por el bot.

## 3) Flujo operativo obligatorio

### Checklist base para registrar eventos nutricionales

### Ventana nutricional

### Pipeline obligatorio de resolución de macros

### Verificacion energetica (4-4-9)

## 4) Matriz de manejo de faltantes

## 4.1 Control de duplicados y correcciones

## 5) Contrato de salida por tipo de tarea

### Alta/edicion/eliminacion de evento

### Analisis clinico-deportivo

## 6) Mapeo de campos (evitar errores de naming)

## 7) Anti-patrones prohibidos

## 8) KPIs de calidad operativa

## 8.1 Regla Garmin para balance diario

## 8.2 Regla Garmin completa y persistencia MySQL

## 8.3 Regla de entrenamiento detectado por Garmin antes del balance diario

## 8.4 Sesiones de entrenamiento manual (sin dispositivo)

## 8.5 Objetivos energéticos sin dispositivo

## 9) Rutinas especiales (triggers)

## 10) Referencias modulares (lectura rapida)


## 11) Credenciales y configuracion

- Credenciales de `nutricion_app` y, solo para cuentas en modo Garmin, Garmin MCP en `.env`. El flujo manual no requiere ni consulta credenciales Garmin.
- Antes de consultar o acceder a datos de la base de datos, verificar que exista `.env` en la raíz del proyecto y usar sus variables de conexión. No asumir rutas ni métodos de autenticación alternativos; si falta el archivo o la conexión falla, informar el problema sin mostrar valores de credenciales.
- El API key de USDA está en `.env` para hacer peticiones de tipo: `curl "https://api.nal.usda.gov/fdc/v1/food/{fdcId}?api_key=TU_API_KEY"`
