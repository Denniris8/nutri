const routes = [
  ['/api/auth/logout', ['POST']],
  ['/api/terms/decision', ['POST']], ['/api/garmin/verify', ['POST']],
  ['/api/integrations/garmin/sync', ['POST']], ['/api/integrations/garmin', ['DELETE']],
  ['/api/dashboard/profile', ['GET', 'POST']], ['/api/biometrics', ['GET', 'POST']],
  ['/api/plicometrics', ['GET', 'POST']], ['/api/food-entries/pending', ['GET']],
  ['/api/food-entries', ['GET', 'POST']], ['/api/food-entries/:id', ['DELETE']],
  ['/api/notifications', ['GET', 'POST']], ['/api/notifications/:id/read', ['POST']],
  ['/api/progress/nutrition', ['GET']], ['/api/food/session', ['POST', 'DELETE']],
  ['/api/training/session', ['POST', 'DELETE']], ['/api/training-analysis', ['POST']],
  ['/api/training-plan', ['POST']], ['/api/training-plan/session', ['DELETE']],
  ['/api/training-plans', ['GET', 'POST']], ['/api/training-plans/:id', ['DELETE']],
  ['/api/daily-steps', ['GET']], ['/api/training-entries', ['GET', 'POST']],
  ['/api/training-entries/:id', ['DELETE']], ['/api/onboarding/preferences', ['GET', 'POST']],
];

const routePattern = (route) => new RegExp(`^${route.replaceAll(':id', '[1-9]\\d{0,19}')}$`);
const API_ROUTES = routes.map(([path, methods]) => ({ path, methods, pattern: routePattern(path) }));
const base = (process.env.NUTRI_API_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
let session = '';
let sessionExpires = 0;

function findRoute(method, pathname) {
  return API_ROUTES.find((route) => route.methods.includes(method) && route.pattern.test(pathname));
}

async function login() {
  const phone = process.env.NUTRI_API_PHONE;
  const password = process.env.NUTRI_API_PASSWORD;
  if (!phone || !password) throw new Error('Configura NUTRI_API_PHONE y NUTRI_API_PASSWORD en .env');
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const data = await response.json().catch(() => ({}));
  const cookie = response.headers.getSetCookie?.().find((value) => value.startsWith('nutri_session='));
  if (!response.ok || !cookie) throw new Error(data.error || `Login de Nutri rechazado (HTTP ${response.status})`);
  session = cookie.split(';', 1)[0];
  sessionExpires = Date.now() + 7 * 60 * 60 * 1000;
}

async function apiRequest(method, path, payload) {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin || !findRoute(method, url.pathname)) {
    throw new Error('Método o endpoint no permitido. Usa /api para ver las rutas disponibles.');
  }
  if (!session || Date.now() >= sessionExpires) await login();
  const response = await fetch(url, {
    method,
    headers: {
      cookie: session,
      ...(method !== 'GET' ? { origin: base } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await response.text();
  if (response.status === 401) session = '';
  let result;
  try { result = body ? JSON.parse(body) : null; } catch { result = body; }
  return `HTTP ${response.status}\n${JSON.stringify(result, null, 2)}`;
}

const apiHelp = () => [
  'Dashboard Nutri: /api <GET|POST|DELETE> /api/ruta [JSON]',
  'Ejemplo: /api GET /api/biometrics',
  ...API_ROUTES.map(({ path, methods }) => `${methods.join('/')} ${path}`),
  'POST/DELETE piden confirmación. Registro/eliminación de cuentas y verificación Garmin (pide contraseña) están bloqueados.',
].join('\n');

export { apiHelp, apiRequest };
