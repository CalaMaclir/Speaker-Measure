const CACHE = 'speaker-measure-pro-v4-0-1';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=4.0.1',
  './dsp-core.js?v=4.0.1',
  './app.js?v=4.0.1',
  './recorder-worklet.js?v=4.0.1',
  './analyzer-worker.js?v=4.0.1',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      const cache = await caches.open(CACHE);
      cache.put(event.request, response.clone());
      return response;
    } catch {
      return (await caches.match(event.request)) || (await caches.match('./index.html'));
    }
  })());
});
