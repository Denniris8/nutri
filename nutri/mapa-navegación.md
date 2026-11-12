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
| PWA, caché e instalación | `html/manifest.webmanifest`, `html/service-worker.js`, `html/pwa-register.js`, `html/pwa-icon.*` |

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
| Recuperación temporal de planes (24 h), firma y propiedad del respaldo | `training-analysis.js`; `POST /api/training-plan/restore` en `server.js`; `draftStorage()` en `onboarding-flow.js` | `training-plan.test.js`, `server.test.js`, `onboarding-flow.test.js` |
| Validación, guardado, activación y lectura de planes | `training-plans.js` | `training-plans.test.js`, `server.test.js` |
| Fechas y zona horaria del calendario | `calendar-day.js` | `calendar-day.test.js` |
| Notificaciones | `notifications.js` | `notifications.test.js`, `server.test.js` |
| Eventos de progreso de análisis: lotes de hasta 20, hora UTC capturada por evento | `analysis-progress.js` | `analysis-progress.test.js` |
| Registro de errores | `application-errors.js`; errores de OpenCode de comidas en `opencode-food.js` | `application-errors.test.js` |
| Correo de verificación y recuperación | `email.js` | `email.test.js`, `server.test.js` |

`html/server.test.js` cubre integración de rutas y flujos HTTP. Los módulos con sufijo `.test.js` junto al código cubren lógica más acotada.

Los reintentos de guardado de entrenamientos reutilizan el payload completo en `savePendingTraining()` sin volver a analizar. Su respaldo y el de planes viven en `sessionStorage`, separados por cuenta mediante un ámbito opaco insertado por el servidor en el dashboard; no son registros definitivos ni se trasladan entre navegadores. El respaldo de planes incluye firma, propiedad y vencimiento; no expone IDs de sesión OpenCode. Cambiar la clave JWT invalida estos respaldos.

El borrador de comida se recupera con sus mensajes/candidatos en una ejecución MySQL con snapshot de solo lectura (`readPendingFoodDraft`). El entrenamiento se verifica después de `COMMIT` en la misma ejecución que lo guarda; las lecturas independientes de su vista diaria se lanzan en paralelo en `server.js`. El sondeo compartido de entrenamientos/planes (`startTrainingProgress`) adapta su intervalo entre 1 y 5 segundos y termina ante HTTP 401. Se conserva la petición independiente de pasos diarios.

`html/api/food-entry-flow.test.js` distingue la orquestación simulada de la prueba optativa de análisis real de salchicha/tortillas/huevo (`NUTRI_TEST_REAL_EGG_ANALYSIS=1`). Esta última envía el texto original, imprime la respuesta y usa una sesión temporal de diagnóstico sin cuenta ni escrituras MySQL; no prueba autenticación ni persistencia real. Requiere autorización antes de ejecutarla y consume una solicitud real al modelo configurado.

## Fuentes de comportamiento y persistencia

- `comportamiento-sesion-comidas.md`: contrato e instrucciones del agente para comidas.
- El contrato activo de comidas utiliza solo energía, proteína, carbohidratos y grasa. Retirada física de columnas obsoletas preparada en `mysql/migrations/0015_remove_unused_nutrient.sql`; revisar despliegue/recuperación en `esquema-bd.md` antes de aplicarla.
- `comportamiento-sesion-entrenamientos.md`: contrato e instrucciones del análisis de entrenamientos.
- `comportamiento-sesion-plan.md`: generación y refinamiento de planes; fuente canónica del prompt enviado a OpenCode.
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
