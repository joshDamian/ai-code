// The service worker. Two jobs, and they are unrelated: cache the app shell so an
// installed dashboard opens when the tailnet is down, and receive the push that wakes a
// backgrounded phone.
//
// Nothing under /api is ever cached. Every write in this app is followed by a re-read,
// so a cached API response is a page that disagrees with the database - the one thing
// the web client is built not to do - and a subscribe POST answered from cache would
// never reach the server at all.

const CACHE = 'bench-shell-v4';

// The entry points only. The rest of the module graph is cached as it is fetched, which
// keeps this list from having to name every view the app grows.
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon.svg', '/icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // Individually rather than `addAll`: one asset missing from a stale checkout
      // would otherwise reject the whole install and leave the worker with no cache.
      .then((c) => Promise.all(SHELL.map((p) => c.add(p).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;

  // Network first. This is a live dashboard on a live machine: when the server is
  // reachable, its answer is the right one every time, and the cache exists only for
  // the moment it is not.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Only a real same-origin asset is worth keeping; an error page is not.
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((c) => c.put(e.request, copy))
            .catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});

// A push, composed by the server. The payload carries the same title and body the
// in-page notifier writes, plus the task id to open - a notification that cannot be
// tapped through to the thing it is about is one the user has to go hunting after.
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    // A payload that is not JSON is not one this server sent. The default below is
    // still a truthful notification.
  }
  const title = data.title || 'Bench';
  e.waitUntil(
    (async () => {
      // A window already on screen has the same news first, live over the socket: a
      // banner on top of it is the app interrupting itself. The page's own badge and the
      // approval bar carry it there, so nothing is missed by staying quiet.
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (open.some((c) => c.visibilityState === 'visible')) return;
      const options = {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        // The status-bar badge on Android is drawn as a white-on-transparent mask.
        badge: '/icons/badge-96.png',
        // Collapses repeats for the same task rather than stacking a lock screen full of
        // them, which is what a repair loop failing three times would otherwise do.
        tag: data.tag || title,
        // A payload may name its own screen (a permission prompt opens its
        // conversation); otherwise the task, otherwise the dashboard. The approval id,
        // when there is one, is what the buttons below answer.
        data: { url: data.url || '/', approvalId: data.approvalId || null },
      };
      // An approval can be settled from the shade, without opening the app. Only a
      // permission prompt gets these; a plan or a question needs the card that shows it,
      // so those arrive as a plain notification that opens the conversation.
      if (data.approvalId) options.actions = [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }];
      await self.registration.showNotification(title, options);
    })()
  );
});

self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data || {};
  const action = e.action;
  e.notification.close();
  // Answered here rather than by opening the app: the whole point of the button is that
  // it works from a locked phone. The same endpoint the card posts to, with the session
  // cookie the worker sends for this origin.
  if (d.approvalId && (action === 'allow' || action === 'deny')) {
    e.waitUntil(
      fetch(`/api/approvals/${encodeURIComponent(d.approvalId)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'allow' ? { allow: true } : { allow: false, message: '' }),
      }).catch(() => {})
    );
    return;
  }
  const url = d.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // An open window is reused rather than a second copy opened beside it. It is
      // focused and told where to route, because a window that is already showing the
      // dashboard is showing the wrong task.
      for (const c of clients) {
        if (new URL(c.url).origin === self.location.origin) {
          c.postMessage({ type: 'navigate', url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// The page telling the worker something it cannot see for itself: an approval was
// answered here (by this window or another), so the banner for it is stale and goes.
self.addEventListener('message', (e) => {
  const m = e.data;
  if (m?.type === 'close-notification' && m.tag) {
    e.waitUntil(self.registration.getNotifications({ tag: m.tag }).then((list) => list.forEach((n) => n.close())));
  }
});
