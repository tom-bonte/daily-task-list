// Offline shell: serve the app from cache, refresh it in the background.
const CACHE = 'dtl-shell-v2';
const SHELL = ['./', 'index.html', 'manifest.json', 'css/app.css', 'js/app.js', 'js/model.js', 'js/stats.js', 'js/ui.js', 'js/firebase.js', 'js/local-store.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'favicon.webp'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === location.origin;
  const isSdk = url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
  // Everything else (Firestore/Auth traffic) goes straight to the network.
  if (!sameOrigin && !isSdk) return;

  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(request, { ignoreSearch: sameOrigin });
    const fresh = fetch(request).then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    }).catch(() => cached);
    // Cache first so the app opens instantly and works offline; update behind it.
    return cached || fresh;
  }));
});
