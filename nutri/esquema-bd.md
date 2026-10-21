# Esquema de `nutri_app`

El SQL de inicialización para un contenedor MySQL nuevo está en `mysql/init/001-schema.sql`. Se generó desde las definiciones de tabla de la base configurada en `.env`; el contenedor oficial de MySQL lo ejecuta únicamente al inicializar un volumen vacío. Este archivo crea el esquema, no copia registros de la base existente.

## `schema_migrations`

El runner `mysql/migrate.sh` crea y mantiene esta tabla al iniciar la app: `version VARCHAR(120)` como PK, `checksum BINARY(32)` SHA-256 del archivo SQL y `applied_at DATETIME(3)` UTC por defecto. Las migraciones nuevas se guardan en `mysql/migrations/` con prefijo numérico; las ya aplicadas son inmutables. Cambios manuales hechos directamente en MySQL no se exportan automáticamente.

## `usuarios`

Una fila por cuenta: `id BIGINT UNSIGNED` PK autoincremental, `nombre VARCHAR(150)`, `edad TINYINT UNSIGNED` (13–120), `sexo VARCHAR(10)` restringido a `masculino`, `femenino` u `otro`, estatura `DECIMAL(5,2) NULL` en cm (80–250), `pais_iso CHAR(2)`, celular normalizado `celular_e164 VARCHAR(16)` con índice único, `password_salt BINARY(16)`, `password_hash BINARY(64)` (scrypt), `es_prueba` y `activo` booleanos, y `creado_en TIMESTAMP`. La estatura se captura al registrar la cuenta y se puede actualizar junto con sexo desde Más; la cuenta y sesión autenticada limitan la actualización a la propia fila. La contraseña nunca se guarda en claro.

## `dashboard_sessions`

Sesiones JWT revocables: `session_id CHAR(36)` PK aleatoria enlazada al claim `sid`, `usuario_id BIGINT UNSIGNED` FK a `usuarios.id`, `expires_at DATETIME`, `revoked_at DATETIME NULL` y `created_at TIMESTAMP`. Índices por usuario y vencimiento. Cada petición protegida valida firma, expiración, cuenta activa y esta fila.

Relación: `usuarios (1) → (N) dashboard_sessions`, con borrado en cascada de las sesiones asociadas.

## `notificaciones_usuario`

Centro persistente de alertas del dashboard. Cada fila pertenece a un usuario y guarda categoría (`comida`, `entrenamiento`, `plan`), estado (`requiere_respuesta`, `guardado`, `generado`, `error`, `resuelta`), título, mensaje breve, referencia opcional al registro relacionado, fecha UTC y fecha de lectura. Índice por cuenta/lectura/fecha para cargar las 50 más recientes y contar las no leídas; al borrar una cuenta se eliminan sus alertas. Las preguntas de comida enlazan a su borrador recuperable; las alertas de entrenamiento abren el registro y las de planes reflejan generación o guardado. Al completarse una respuesta, los avisos de pregunta anteriores de esa categoría se marcan como resueltos. Esquema en `mysql/migrations/0001_notificaciones_usuario.sql`; `0002_notificacion_dummy.sql` agrega solo a las cuentas `es_prueba=1` un aviso de demostración identificado como sintético.

## `preferencias_usuario`

Una fila por cuenta (`usuario_id` PK/FK a `usuarios.id`): `modo_dispositivo`, `patron_alimentario`, `zona_horaria`, `nutrition_day_start TIME`, `nutrition_day_end TIME`, `alimentos_preferidos`, `alimentos_evitar` y `actualizado_en`. La zona horaria define cómo interpretar los límites guardados en hora local; los campos generales admiten NULL para no inventar datos en perfiles antiguos.

## `credenciales_integracion_usuario`

Una fila por cuenta y proveedor (`usuario_id`, `proveedor` PK compuesta; FK a `usuarios.id` con borrado en cascada). Las credenciales Garmin se guardan cifradas con AES-256-GCM: `ciphertext VARBINARY(2048)`, `nonce BINARY(12)`, `auth_tag BINARY(16)` y `key_version SMALLINT UNSIGNED`; `created_at` y `updated_at` registran altas y cambios. La clave se deriva mediante HKDF-SHA-256 del secreto de sesión del servidor y nunca se devuelve al navegador. Tabla creada/verificada en MySQL el 2026-10-15.

## `perfil_salud_usuario`

Una fila por cuenta con estados y detalles de alergias y medicamentos (`usuario_id` PK/FK). Los detalles son NULL si el estado es `ninguna_conocida`/`ninguno` o `sin_informacion`; solo se guardan cuando la persona indica registros concretos. La existencia de esta fila completa la parte de salud del paso de preferencias.

## `dashboard_terms_decisions`

Una decisión por versión y cuenta: PK compuesta (`usuario_id`, `terms_version`), decisión restringida a `accepted`/`rejected` y hora `decided_at`. FK con borrado en cascada. Solo la aceptación de la versión vigente permite entrar al dashboard; el rechazo revoca la sesión actual.

## `errores_aplicacion`

Registro consultable de fallos de aplicación: `id BIGINT UNSIGNED` PK; `ocurrido_en DATETIME(3)` en UTC; `area`, `evento`, `etapa`, `accion_realizada`, `metodo_http`, `ruta`, `trace_id`, `usuario_id`, `codigo_error`, `nombre_error`, `http_status`, `upstream_http_status` y `descripcion_error`. `http_status` es la respuesta del dashboard; `upstream_http_status` conserva el estado devuelto por OpenCode cuando está disponible. `usuario_id` referencia `usuarios.id` con `ON DELETE SET NULL`, preservando el registro al eliminar una cuenta. Índices por fecha, `trace_id`/fecha, área/fecha y usuario/fecha. La descripción es una síntesis controlada; no se guardan mensajes crudos de excepciones, texto de usuario, credenciales ni contenido del request. El flujo de registro de comidas inserta eventos de fallo y permite consultarlos por MySQL usando `trace_id`, área o fecha; por ejemplo: `SELECT ocurrido_en,area,trace_id,evento,etapa,accion_realizada,codigo_error,http_status,upstream_http_status,descripcion_error FROM errores_aplicacion WHERE BINARY trace_id=BINARY '...' ORDER BY ocurrido_en,id;`. Tabla creada en MySQL el 2026-10-19.

## `registros_biometricos`

Una fila por medición: `id` PK, `usuario_id` FK con borrado en cascada, `fuente` (`manual`/`bia`/`mifflin`), `medido_en`, `peso_kg DECIMAL(6,2)` obligatorio, `edad_corporal`, `grasa_pct`, `metabolismo_basal_kcal`, `grasa_visceral`, `imc`, `musculo_pct` y `notas` opcionales. Índice por usuario/fecha; BIA conserva las métricas reportadas, manual solo admite peso y Mifflin conserva peso + TMB estimada con las demás métricas NULL. Al guardar peso biométrico o actualizar el perfil, Mifflin-St Jeor usa edad, sexo y estatura de `usuarios` más el peso manual/BIA más reciente; solo se calcula entre 19–78 años para `masculino`/`femenino` y crea una fila `mifflin` si no existe ninguna TMB previa. No reemplaza una medición BIA.

La cuenta dummy que ya existía al documentar la base tenía tres mediciones BIA sintéticas entre 2026-09-29 y 2026-10-13. Cada fila está marcada en `notas` como dato ficticio; no usarla como medición real.

## `registros_biometricos`

Una fila por medición: `id` PK, `usuario_id` FK con borrado en cascada, `medido_en`, fuente (`manual`/`bia`/`mifflin`), peso obligatorio y edad corporal, grasa %, metabolismo basal, grasa visceral, IMC, músculo % y notas opcionales. Índice por usuario y fecha; Mifflin guarda peso y TMB estimada, dejando NULL las demás métricas de composición; sus notas registran variante, edad y estatura utilizadas. La restricción de fuente admite `mifflin` y su regla permite únicamente peso + TMB estimada.

## `registros_plicometro`

Una fila por medición con `id` PK, `usuario_id` FK con borrado en cascada, `fecha DATE`, `creado_en TIMESTAMP` e índice por usuario/fecha. Tríceps, bíceps, subescapular, suprailíaco, abdominal, muslo anterior y pantorrilla usan `DECIMAL(5,2)` opcional en milímetros. Una restricción exige al menos un pliegue y limita cada valor a 0–120 mm. Tabla creada en MySQL el 2026-10-13 tras autorización.

## `registros_entrenamientos`

Una fila por sesión guardada: `id` PK, `usuario_id` FK con borrado en cascada, `origen VARCHAR(32)` identifica el canal (`manual`, `garmin` u otro dispositivo), `external_activity_id VARCHAR(128) NULL` identifica la sesión externa, descripción `VARCHAR(1200)`, actividad `VARCHAR(120)`, duración `DECIMAL(6,2)` en minutos, peso `DECIMAL(6,2)` nullable, MET `DECIMAL(4,2)` nullable, energía `DECIMAL(8,1)` en kcal, distancia opcional en metros y `tipo_energia ENUM('estimada_met','reportada_dispositivo')`. `creado_en DATETIME(3)` se inserta en UTC; hay un índice por usuario/fecha y una clave única (`usuario_id`,`origen`,`external_activity_id`) para evitar duplicados importados. Las filas manuales exigen peso+MET y guardan kcal recalculadas por servidor; las filas de dispositivos guardan su ID externo, dejan peso/MET NULL y conservan las kcal reportadas sin aplicar la fórmula MET. El filtrado por fecha del dashboard usa la ventana nutricional y zona horaria guardadas: una ventana que cruza medianoche consulta desde su fecha seleccionada hasta el día calendario siguiente; antes de la hora de inicio, la fecha calendario actual corresponde al día nutricional anterior. El registro manual toma la fecha nutricional seleccionada y Garmin consulta/importa solo las actividades dentro de ese intervalo. La lista muestra las sesiones con su origen; el balance agrega MET neto manual y kcal reportadas por dispositivos. Tabla creada en MySQL el 2026-10-15 y extendida para Garmin el 2026-10-15.

## `registros_pasos_diarios`

Una fila por usuario y día calendario local: PK compuesta (`usuario_id`,`fecha DATE`), `pasos INT UNSIGNED`, `fuente ENUM('manual','garmin')`, `creado_en DATETIME(3)` y `actualizado_en DATETIME(3)` en UTC; FK a `usuarios.id` con borrado en cascada. Se escribe desde «Describir sesión» cuando la persona menciona explícitamente un total, o desde la sincronización Garmin cuando `get_steps` devuelve `totalSteps` válido. La fecha explícita/manual se resuelve con la zona horaria local; Garmin actualiza cada fecha calendario dentro del intervalo sincronizado. Un nuevo total para la misma fecha reemplaza el anterior mediante upsert y actualiza la fuente; los pasos no se suman a las calorías ni al registro de entrenamiento. Tabla creada en MySQL el 2026-10-16 y ampliada con la fuente el 2026-10-16.

## `planes_entrenamiento`

Una fila por plan guardado por la persona: `id BIGINT UNSIGNED` PK, `usuario_id BIGINT UNSIGNED` FK a `usuarios.id` con borrado en cascada, `objetivos VARCHAR(2000)`, `contenido MEDIUMTEXT` con el plan generado en Markdown, cuatro columnas `objetivo_*` para la única meta estructurada de reposo y cuatro columnas `objetivo_entrenamiento_*` heredadas de la versión anterior. Las metas numéricas de reposo pueden ser NULL si no se calculan responsablemente; los CHECK limitan gramos a 0–10.000 y kcal a 0–100.000. Los planes nuevos ya no escriben ni leen metas estructuradas de entrenamiento; las columnas heredadas se mantienen para no alterar el esquema ni los registros previos. El dashboard toma la meta de reposo y, en días con ejercicio registrado, suma el ajuste de energía del entrenamiento a calorías y su equivalente energético a carbohidratos. Un índice (`usuario_id`,`creado_en`,`id`) permite ordenar los planes por fecha. La propiedad proviene del usuario autenticado. Las altas dummy reciben un plan sintético marcado; el usuario puede eliminar cada plan y la API limita el borrado a su cuenta. El 2026-10-20 se eliminaron los siete planes de la cuenta identificada como `Usuario de prueba` (usuario_id 24), previa solicitud explícita. Tabla creada/verificada en MySQL el 2026-10-15; las columnas heredadas se añadieron con `mysql/migrations/0003_macros_entrenamiento_plan.sql`.

## `sesiones_comidas_opencode`

Una sesión OpenCode activa por usuario: `usuario_id` es PK/FK a `usuarios.id` con borrado en cascada; `session_id` es único y sus metadatos incluyen el mismo `foodUserId`. El servidor verifica la correspondencia antes de reutilizarla; el ID de sesión nunca viene del navegador. Cada registro usa una sesión limpia; al completarse se reemplaza por otra para el siguiente. Los borradores pendientes conservan la sesión necesaria para reanudar el chat. Solo `webfetch` está permitido. El borrado de cuenta elimina la sesión OpenCode asociada antes de borrar sus filas locales. Tabla creada en MySQL el 2026-10-13.

## `registros_comidas`

Una fila por registro o borrador: `id` PK, `usuario_id` FK, `registro_comida_destino_id` FK autorreferente nullable para anexos pendientes, `request_id` único por usuario para reintentos y continuidad del chat, `fecha_consumo`, `descripcion_original`, estado `ENUM('pendiente','requiere_aclaracion','completado','borrador_chat')`, pregunta pendiente y totales de macros/fuente frente a 4-4-9. `borrador_chat` identifica explícitamente borradores ocultos de la lista y sin totales; los registros anteriores con otros estados siguen siendo visibles. Solo `completado` participa en balances. El servidor solo anexa a un registro completado del mismo usuario y día, dentro de una transacción que guarda los nuevos ítems, recalcula los totales y registra el `request_id` idempotente antes de borrar el borrador. `creado_en` se guarda en UTC y alimenta el orden/hora de la lista diaria. El texto original se conserva durante las aclaraciones. Índice por usuario/fecha y FKs con borrado en cascada. Tabla creada en MySQL el 2026-10-13; `borrador_chat` y destino de anexo agregados el 2026-10-14.

## `alimentos_referencia` y `referencias_busqueda_alimentos`

`alimentos_referencia` conserva una ficha USDA por `fdc_id`, con nombre, nutrientes por 100 g y método de energía (`usda` o `4-4-9`). `referencias_busqueda_alimentos` mapea cada término normalizado a una ficha para consultar primero MySQL y evitar llamadas repetidas a USDA. Son referencias públicas compartidas, no datos personales. Los macros declarados por el usuario se guardan solo en su registro/ítem, nunca en esta caché global. Ambas tablas e índices fueron creados en MySQL el 2026-10-13.

## `registros_comida_items` y `registros_comida_interacciones`

`registros_comida_items` guarda cada alimento por separado, enlazado al evento y opcionalmente a una referencia USDA; conserva fragmento original, nombre incorporando las aclaraciones resueltas, cantidad/unidad, `base_macros ENUM('per_portion','per_100g')`, estado (`estimado` o `declarado`), `fuente_macros ENUM('usda_fdc','declarado_usuario','webfetch','opencode_estimado')`, `metodo_energia ENUM('usda','4-4-9','declarado_usuario','webfetch','opencode_estimado')`, cinco macros y energía 4-4-9. OpenCode aporta macros por 100 g; el servidor los escala por gramos consumidos y persiste el resultado por porción. No se insertan ítems hasta resolver aclaraciones y cantidades. Los totales del evento solo se suman con porciones conocidas. Los resultados web guardan además `nombre_fuente_web VARCHAR(255)`, `url_fuente_web VARCHAR(1000)` y `cita_fuente VARCHAR(1200)` por ítem; no se mezclan con la caché pública USDA. `registros_comida_interacciones` guarda el diálogo completo mientras el registro es borrador; al completarlo conserva solo el primer mensaje del usuario, la última aclaración y la confirmación final del asistente. `role` es `user` o `assistant`, `contenido` admite hasta 5.000 caracteres y `request_id CHAR(36) NULL UNIQUE` marca idempotencia al anexar alimentos. Las tablas eliminan sus filas en cascada al borrar el evento/usuario; las fichas nutricionales públicas permanecen. Enums y columnas de fuente OpenCode y base de macros agregados en MySQL el 2026-10-14.

## Datos iniciales de cuentas dummy

Al registrar una cuenta marcada `es_prueba=1`, en la misma transacción se insertan una medición manual ficticia de 75 kg, una lectura sintética de plicómetro y una descripción de comida marcada `DATO SINTÉTICO DE PRUEBA` en estado `pendiente`. No se inventan macros para esa comida. Preferencias, perfil de salud y objetivos se crean cuando el usuario completa sus formularios iniciales. Las cuentas normales no reciben datos sintéticos y el registro no marca los términos como aceptados. En esta implementación se sembró una descripción de prueba para la cuenta `es_prueba=1` existente; permanece pendiente y no afecta balances.
