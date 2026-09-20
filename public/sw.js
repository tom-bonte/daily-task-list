// App shell cache.
//
// Code (HTML/CSS/JS) is network-first: a deploy must never leave the app running
// a mix of old and new files. Falling back to the cache keeps it working offline.
// Static assets (icons, the Firebase SDK) are cache-first, since they rarely change.
const CACHE = 'dtl-shell-v3';
const SHELL = ['./', 'index.html', 'manifest.json', 'css/app.css', 'js/app.js', 'js/model.js', 'js/stats.js', 'js/ui.js', 'js/firebase.js', 'js/local-store.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'favicon.webp'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isCode = url => url.origin === location.origin && /\.(html|css|js|json)$|\/$/.test(url.pathname);

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
    const fromNetwork = fetch(request).then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    });
    if (isCode(url)) return fromNetwork.catch(() => cached || Promise.reject(new Error('offline')));
    return cached || fromNetwork;
  }));
});
