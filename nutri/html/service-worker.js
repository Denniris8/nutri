const cacheName = 'nutri-app-shell-v2';
const appShell = new Set([
  '/login.html',
  '/dashboard_nutricional.css', '/notifications.css', '/help-popups.css', '/onboarding-flow.js',
  '/manifest.webmanifest', '/pwa-icon.svg', '/pwa-icon-192.png', '/pwa-icon-512.png',
]);
const loginShell = new Request(new URL('/login.html', self.location.origin));

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await Promise.all((await caches.keys()).filter((key) => key.startsWith('nutri-app-shell-') && key !== cacheName).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !appShell.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const key = new Request(`${url.origin}${url.pathname}`);
    try {
      const response = await fetch(request);
      if (response.ok && !response.redirected) await cache.put(key, response.clone());
      return response;
    } catch {
      return await cache.match(key) || (request.mode === 'navigate' ? await cache.match(loginShell) : Response.error());
    }
  })());
});
