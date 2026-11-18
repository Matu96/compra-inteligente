// Service worker: la app abre sin conexión con los últimos precios descargados.
const VERSION = 'ci-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'motor.js', 'fotos.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const esDato = url.pathname.includes('/data/') || url.pathname.endsWith('promos.json');
  if (esDato) {
    // datos: primero la red (precios del día), si no hay conexión lo último guardado
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copia = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copia)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  } else {
    // app: lo guardado al instante y se actualiza en segundo plano
    e.respondWith(caches.match(e.request).then(enCache => {
      const red = fetch(e.request).then(r => { if (r.ok) { const copia = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copia)); } return r; }).catch(() => enCache);
      return enCache || red;
    }));
  }
});
