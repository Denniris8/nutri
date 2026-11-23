# Mapa de navegación del proyecto

Índice inicial para localizar las pantallas, flujos y lógica antes de modificar código. Las referencias son rutas desde `nutri/`; los números de línea se omiten para que no queden obsoletos.

## Recorrido rápido

1. Identifica la pantalla en `html/` y su JavaScript/CSS asociado.
2. Sigue la acción hasta el endpoint en `html/server.js`.
3. Localiza la lógica en el módulo correspondiente de `html/api/`.
4. Revisa las pruebas `*.test.js` cercanas y las reglas/prompt canónicos indicados abajo.
5. Busca referencias y llamadores antes de editar: `grep -R "nombreFuncionORuta" html`.

## Aplicación web

| Necesidad | Punto de entrada |
|---|---|
| Servidor HTTP, autenticación, rutas API y archivos servidos | `html/server.js` |
| Salud del proceso (`/healthz`) y disponibilidad MySQL (`/readyz`) | `html/server.js`; healthcheck en `docker-compose.yml`; pruebas en `html/server.test.js` |
| Dashboard y estructura de pantallas | `html/dashboard_nutricional.html` |
| Flujos de dashboard, formularios, chat de comidas/planes y eventos de UI | `html/onboarding-flow.js` |
| Estilos principales del dashboard y componentes | `html/dashboard_nutricional.css` |
| Acceso y autenticación | `html/login.html`; rutas y sesión en `html/server.js` |
| Preferencias | `html/preferencias.html`; módulo `html/api/preferences.js` |
| Términos | `html/terminos.html` |
| Avisos accesibles | `html/notifications.css`; renderizado y eventos en `html/server.js` |
| Consentimiento de cookies | `html/cookie-consent.js`, `html/cookie-consent.css` |
| Ayudas emergentes | `html/help-popups.css`; contenido y estructura en `html/dashboard_nutricional.html` |
| PWA, caché e instalación | `html/manifest.webmanifest`, `html/service-worker.js`, `html/service-worker.test.js`, `html/pwa-register.js`, `html/pwa-icon.*` |

## Lógica de API (`html/api/`)

| Funcionalidad | Módulo principal | Pruebas relacionadas |
|---|---|---|
| Perfil y datos de cuenta | `account-profile.js` | `server.test.js` |
| Biométricos y TMB Mifflin | `biometrics.js`, `mifflin.js` | `server.test.js` |
| Plicometría | `plicometrics.js` | `server.test.js` |
| Preferencias y credenciales Garmin | `preferences.js`, `integration-credentials.js` | `preferences.test.js`, `server.test.js` |
| Verificación y sincronización Garmin | `garmin-verification.js`, `garmin-training-sync.js` | `server.test.js` |
| Registro, validación, consulta y borradores de comidas | `food-entries.js` | `food-entries*.test.js`, `food-entry-flow.test.js`, `server.test.js` |
| Conexión OpenCode, fuentes alimentarias y sesión de comidas | `opencode-food.js` | `server.test.js`, pruebas de flujo de comidas |
| Chat del chef | `chef-chat.js` | `chef-chat.test.js` |
| Análisis y registro de entrenamientos, pasos y energía | `training-entries.js` | `training-entries.test.js`, `server.test.js` |
| Planes: generación, refinamiento y sesión pendiente | `training-analysis.js` | `training-analysis.test.js`, `training-plan.test.js`, `server.test.js` |
| Recuperación temporal de planes (24 h), propiedad y revisión | `html/api/plan-drafts.js`; `POST /api/training-plan/restore` en `server.js`; `draftStorage()` en `onboarding-flow.js` | `training-plan.test.js`, `server.test.js`, `onboarding-flow.test.js` |
| Validación, guardado, activación y lectura de planes | `training-plans.js` | `training-plans.test.js`, `server.test.js` |
| Fechas y zona horaria del calendario | `calendar-day.js` | `calendar-day.test.js` |
| Notificaciones | `notifications.js` | `notifications.test.js`, `server.test.js` |
| Eventos de progreso de análisis: lotes de hasta 20, hora UTC capturada por evento | `analysis-progress.js` | `analysis-progress.test.js` |
| Registro de errores | `application-errors.js`; errores de OpenCode de comidas en `opencode-food.js` | `application-errors.test.js` |
| Correo de verificación y recuperación | `email.js` | `email.test.js`, `server.test.js` |

`html/server.test.js` cubre integración de rutas y flujos HTTP. Los módulos con sufijo `.test.js` junto al código cubren lógica más acotada.

El servidor calcula hashes de contenido de JS/CSS al arrancar y reescribe sus URLs en las páginas HTML; solo el hash vigente recibe caché immutable. Reiniciar Nutri tras cambiar estáticos; el service worker conserva cada versión por URL completa. `nginx/default.conf` negocia gzip y amplía la espera de respuestas para reintentos del modelo; validar y recargar Nginx al desplegar esa configuración.

Tendencias biométricas: comparten solicitudes idénticas, caché local de 30 s e invalidación tras escrituras API; descartan respuestas antiguas y cancelan periodos reemplazados. Los pasos mantienen su petición independiente y también descartan/cancelan cargas reemplazadas. Notificaciones: listado y contador completo comparten una ejecución MySQL con snapshot de solo lectura. El resumen biométrico agrega ambos periodos desde una lectura de registros; la TMB y su fuente se obtienen de la misma fila.

Los reintentos de entrenamiento reutilizan el payload de `savePendingTraining()` en `sessionStorage`. Para planes solo se guarda una referencia por cuenta; el borrador, la revisión y el contexto residen en MySQL. No se exponen IDs de sesión OpenCode.

Entrenamientos: los reintentos conservan el respaldo ante HTTP 409 y no sondean progreso de análisis. El guardado advierte si falla el refresco del día sin ofrecer reenviar un registro confirmado. `loadTrainingEntries()` devuelve `false` ante fallo de carga. Las comprobaciones Garmin reutilizan la zona horaria resuelta en servidor y exigen modo Garmin conectado tanto al guardar como al consultar; duración y MET deben seguir siendo positivos después del redondeo.

Planes: generación/refinamiento y guardado son mutuamente excluyentes en la interfaz, incluidos dobles envíos; las respuestas de generaciones canceladas no reactivan sesiones ni controles. La limpieza remota del plan espera como máximo 5 segundos por DELETE y conserva la sesión pendiente si falla. Al guardar, la cobertura biométrica y de plicometría se agrega una vez por tabla conservando booleanos JSON y ausencia de datos.

Chef: `chef-chat.js` centraliza descubrimiento por propiedad y limpieza de sesiones remotas, incluso sin caché, en lotes de hasta tres DELETE. La UI bloquea envíos durante el cierre. Recupera una sesión desaparecida solo ante 404 del mensaje, con un único reenvío y sin repetir timeouts; regresiones en `chef-chat.test.js` y `onboarding-flow.test.js`.

El borrador de comida se recupera con sus mensajes/candidatos en una ejecución MySQL con snapshot de solo lectura (`readPendingFoodDraft`). El entrenamiento se verifica después de `COMMIT` en la misma ejecución que lo guarda; las lecturas independientes de su vista diaria se lanzan en paralelo en `server.js`. El sondeo compartido de entrenamientos/planes (`startTrainingProgress`) adapta su intervalo entre 1 y 5 segundos y termina ante HTTP 401. Se conserva la petición independiente de pasos diarios.

Comidas: el historial selecciona la última referencia completa por nombre sin límite global de filas; admite coma decimal en cantidades. Si falla la lectura tras confirmar el guardado, la API responde con `refreshRequired` y la interfaz refresca el día sin ofrecer reenvío. La limpieza remota tiene un timeout de 5 segundos y conserva su referencia si falla. El sondeo de comidas adapta su intervalo entre 1 y 5 segundos, termina ante 401 y se cancela al finalizar el envío.

`html/api/food-entry-flow.test.js` distingue la orquestación simulada de la prueba optativa de análisis real de salchicha/tortillas/huevo (`NUTRI_TEST_REAL_EGG_ANALYSIS=1`). Esta última envía el texto original, imprime la respuesta y usa una sesión temporal de diagnóstico sin cuenta ni escrituras MySQL; no prueba autenticación ni persistencia real. Requiere autorización antes de ejecutarla y consume una solicitud real al modelo configurado.

## Fuentes de comportamiento y persistencia

- `comportamiento-sesion-comidas.md`: contrato e instrucciones del agente para comidas.
- El contrato activo de comidas utiliza solo energía, proteína, carbohidratos y grasa. Retirada física de columnas obsoletas preparada en `mysql/migrations/0015_remove_unused_nutrient.sql`; revisar despliegue/recuperación en `esquema-bd.md` antes de aplicarla.
- `comportamiento-sesion-entrenamientos.md`: contrato e instrucciones del análisis de entrenamientos.
- `comportamiento-sesion-plan.md`: generación y refinamiento de planes; fuente canónica del prompt enviado a OpenCode.
- Crear plan: el modelo devuelve una pregunta o un informe listo. `training-analysis.js` compone datos y tabla de metas; `plan-drafts.js` bloquea el guardado hasta responder. El modal usa la misma revisión para continuar y recuperar aclaraciones.
- `comportamiento-sesion-chef.md`: comportamiento del chat del chef.
- `esquema-bd.md`: esquema y semántica documentada de tablas.
- `mysql/migrations/`: cambios persistentes; las migraciones aplicadas son inmutables.
- `mysql/migrate.sh` → `mysql/migrate.js`: runner con bloqueo MySQL por base y conexión única; pruebas en `mysql/migrate.test.js`.
- `../pull`: sincroniza el repositorio y solo actualiza/recrea servicios cuando detecta cambios pertinentes; los cambios de migraciones reinician Nutri para aplicarlas, no MySQL.
- `AGENTS.md`: reglas de trabajo del proyecto.
- `log.md`: bitácora de cambios.

## Si no sabes por dónde empezar

- Una interacción o control visible: busca el selector/ID en `dashboard_nutricional.html` y `onboarding-flow.js`.
- Un endpoint: busca la ruta `/api/...` en `html/server.js` y sigue la llamada al módulo API.
- Una consulta SQL o regla de negocio: busca el nombre de tabla/campo en `html/api/` y `esquema-bd.md`.
- Un comportamiento de IA: identifica el flujo en `html/api/` y lee su `comportamiento-sesion-*.md` antes de tocar el prompt.
- Una regresión: empieza por la prueba del módulo; usa `html/server.test.js` para el recorrido de extremo a extremo por API.

Actualiza este mapa cuando se agreguen, eliminen o reubiquen puntos de entrada o módulos principales.
