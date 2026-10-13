// Tof service worker: caches the app for offline use and receives files shared from Android's Share menu.
const APP = 'tof-app-v20';
const INBOX = 'tof-inbox';
const FILES = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== APP && k !== INBOX).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first so updates land, cache as the offline fallback.
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(APP).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

async function receiveShare(request) {
  const form = await request.formData();
  const inbox = await caches.open(INBOX);
  const stamp = Date.now();
  let n = 0;
  for (const f of form.getAll('exports')) {
    if (!(f instanceof File)) continue;
    await inbox.put(`./inbox/${stamp}-${n++}`, new Response(f, { headers: { 'x-name': encodeURIComponent(f.name || 'shared.html') } }));
  }
  const text = form.get('text');
  if (!n && text) {
    await inbox.put(`./inbox/${stamp}-text`, new Response(String(text), { headers: { 'x-name': encodeURIComponent((form.get('title') || 'shared') + '.txt') } }));
  }
  return Response.redirect('./?shared=' + stamp, 303);
}
