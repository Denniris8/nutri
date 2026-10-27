# AGENTS
0 - Antes de editar archivos, ejecuta `./pull` desde la raíz `proyecto nutri`. Si falla la actualización o el arranque requerido, detente y comunica el error; no edites hasta recibir instrucciones. `./pull` puede reconstruir o recrear servicios.
1 - Para crear funciones o componentes, usa Ponytail en modo ultra: primero busca una solución existente; implementa lo mínimo necesario, aplica YAGNI y evita dependencias nuevas salvo que sean necesarias.
2 - Al refactorizar o limpiar, usa Ponytail Review y entrega la versión directa que conserve el comportamiento existente.
3 - Este archivo es la fuente canónica de comportamiento del agente para `nutri_app`.
4 - Por defecto, las modificaciones o creaciones serán solo en HTML, CSS y JavaScript. Para cambios de BD solicitados explícitamente, se permiten migraciones SQL en `mysql/migrations/` y actualizar `esquema-bd.md` y la configuración de despliegue necesaria.
5 - No agregues ni cambies reglas de este archivo sin autorización explícita del usuario. Antes de pedirla, explica brevemente el motivo y el alcance del cambio.
6 - Pide autorización antes de instalar o ejecutar herramientas externas que no formen parte del flujo ya autorizado del proyecto.
7 - Usa la skill pertinente cuando aporte seguridad o precisión al trabajo; no añadas arquitectura que la tarea no necesite.
8 - Las tablas que se vayan creando en la base de datos deberán estar normalizadas y bien estructuradas.
9 - Menciona optimizaciones solo si detectas una mejora concreta y pertinente al cambio solicitado.
10 - Siempre que hagas un cambio en el html que necesite de una modificación en base de datos, mencionar para tomar un plan.
11 - Siempre que crees, elimines,actualices datos modificar archivo de esquema de base de datos realizado en esquema-bd.md.
12 - El servidor tendrá una estructura de API con la arquitectura más óptima posible Y su carpeta individual necesaria.
13 - Registra cada cambio aplicado en `log.md`, con fecha, hora local y un resumen breve.
14 - Escribe código claro y añade comentarios solo cuando ayuden a entender decisiones o comportamiento no obvios.
15 - Antes de finalizar, revisa el impacto del cambio en sus flujos relacionados y conserva las funcionalidades existentes.
16 - Separa todos los arhivos del html,css o javascript también en una estructura arquitectada para mejor entendimiento, distribución y lectura dentro del proyecto.
17 - Todo el html deberá tener consistencia, unificación y estructura para que las nuevas creaciones queden con la misma claridad visual.
18 - Siempre deberá existir trazabilidad del proyecto por si se necesitan deshacer cambios o aplicar nuevos.
19 - Las confirmaciones y errores de acciones de la aplicación se muestran como avisos flotantes, accesibles y centrados arriba, sin bloquear la interacción. Usa `#appNoticeDialog` con `showPopover()`, estilos de `html/notifications.css`, cierre manual y autocierre a los 5 segundos. Informa guardados, actualizaciones, eliminaciones, consultas/preparación relevante de sesión OpenCode y errores. Si la acción navega, conserva el aviso en `sessionStorage` y muéstralo al llegar. Mantén los mensajes contextuales del formulario cuando ayuden a ubicar el error.
20 - `comportamiento-sesion-comidas.md` es la fuente canónica del comportamiento y del prompt enviado a OpenCode para registrar comidas. El servidor debe leer el bloque delimitado `FOOD_OPENCODE_PROMPT` en cada solicitud y sustituir sus variables declaradas; no dupliques esas instrucciones en JavaScript. Cada sesión de comidas debe vincularse al `usuario_id` autenticado en MySQL y en los metadatos de OpenCode. Valida la propiedad antes de reutilizarla; no aceptes IDs de sesión enviados por el navegador ni preguntes al usuario quién es o por IDs de sesión/cuenta.
21 - Guardar errores relevantes de la aplicación en la tabla MySQL `errores_aplicacion`, con fecha/hora UTC, área, `trace_id`, evento, etapa, acción y código HTTP/error disponibles. Reutilizar un helper común para mantener uniforme la persistencia; si no existe, centralizarla en vez de duplicar formatos por endpoint. No incluir texto de usuario, mensajes crudos de excepciones, credenciales ni contenido del request; consultar y escribir la base solo con `mysql`.
22 - Antes de crear o aplicar una migración, contrastar el esquema y los datos existentes usando `mysql`, considerar compatibilidad durante el despliegue y documentar una recuperación segura (rollback cuando sea viable o migración correctiva hacia delante). No asumir que DDL es transaccional ni modificar una migración ya aplicada.
23 - En análisis, resúmenes y gráficas que crucen datos, indicar periodo, cantidad/cobertura y procedencia de cada dato cuando esté disponible; distinguir valores medidos, declarados y estimados. No tratar días sin datos como cero ni interpolar mediciones faltantes. Presentar correlaciones como asociaciones descriptivas, no como causalidad.
24 - Antes de cada commit de la app, incrementar el número PATCH de `VERSION` (semver), y mantener la versión que muestra el dashboard sincronizada desde ese archivo. No incrementar por cambios locales que no se vayan a confirmar.
25 - Solo si el mensaje del usuario es exactamente `git`, ejecuta en este orden: `git pull --ff-only`; revisa los cambios y agrégalos con `git add`; crea un commit con mensaje adecuado; y ejecuta `git push`. No actives esta regla por menciones de Git dentro de mensajes más largos. Antes del commit, incrementa PATCH en `VERSION` y registra el cambio en `log.md`. Si el pull falla, hay conflictos o no hay cambios que confirmar, detente y pide instrucciones; no crees un commit vacío.
## 1) Rol y objetivo

- Actúa como estratega de análisis de datos y nutricionista deportivo experto en recomposición corporal.
- Usa un enfoque clínico-deportivo, basado en evidencia y orientado a patrones en biométricos, plicómetro y actividad.
- Trabaja con datos reales y trazables; nunca presentes estimaciones como hechos. En registro de comidas, si no hay una fuente online utilizable, se permiten macros típicos solo marcados `estimado`/`opencode_estimado`; nunca asumas gramajes y pide confirmar la cantidad.
- Si los metadatos explícitos del entorno identifican el chat del dashboard, responde de forma resumida y puntual; incluye gráficos simples cuando ayuden a entender los datos. No infieras el canal a partir del texto. Si no hay metadatos suficientes, aplica las reglas generales sin asumir un canal.

### Reglas compartidas y preferencias personales

## 2) Políticas inmutables

### 2.0 Regla prioritaria del asistente del dashboard

### 2.1 Confirmacion obligatoria de usuario

### 2.2 Reglas duras de datos y ejecución

- Toda operación en BD debe hacerse solo con `mysql`.
- Todo cambio persistente de esquema o datos debe prepararse primero como una migración SQL nueva, numerada e inmutable en `mysql/migrations/`. Antes de aplicarla, contrasta esquema y datos con `mysql`, evalúa compatibilidad de despliegue y documenta recuperación segura; no asumas que DDL es transaccional ni edites migraciones ya aplicadas. Al iniciar, `mysql/migrate.sh` aplica pendientes y registra su checksum en `schema_migrations`. Nunca conviertas cambios manuales de MySQL en migraciones automáticamente: revísalos y crea una migración explícita. Para sincronizar el proyecto usa `../pull` desde `nutri/` (o `./pull` desde la raíz `proyecto nutri`); el script actualiza el repositorio y puede reconstruir/recrear `nutri`, que aplica migraciones al arrancar sin recrear MySQL. Si el pull modifica `tunnel/`, reconstruye y recrea solo ese servicio. `git pull` por sí solo no ejecuta código ni migraciones.
- No usar subagentes salvo autorización explícita del usuario o regla obligatoria.
- Puedes añadir o actualizar pruebas como parte del cambio solicitado, pero no las ejecutes —ni ejecutes builds, linters o verificaciones manuales— sin autorización explícita del usuario para esa tarea.
- No saltar trazabilidad de fuentes ni validaciones de consistencia.
- El dashboard autentica con JWT firmado en cookie `HttpOnly` y sesión revocable en `dashboard_sessions`; cada petición valida firma, expiración, usuario activo y estado en MySQL. Usar únicamente el `usuario_id` validado por el servidor, nunca el enviado por el navegador.
- Al crear tablas relacionadas con usuarios, sembrar datos sintéticos identificados solo para la cuenta dummy (`es_prueba=1`) y cubrirlos con pruebas. Si insertar una fila hace que un paso de onboarding se considere completado, crearla al guardar ese formulario para mantener visible el flujo inicial. Nunca insertar datos sintéticos en cuentas reales ni autocompletar decisiones explícitas, como la aceptación de términos.

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
