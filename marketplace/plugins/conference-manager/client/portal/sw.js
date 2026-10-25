/*
 * «Mi inscripción» service worker (conference-manager 2.27.0): shows the bus notices the transport team sends
 * («Tu bus está embarcando», «Tu bus salió», their messages) as notifications, and a tap on one opens (or
 * focuses) the person's page. Registered by /portal/conference/yo with that page as its scope.
 * 2.36.5: also the meal call of the person's group («Tu grupo ya puede pasar a comer»).
 *
 * 2.36.15 («Mi escarapela» offline): the page itself opens without a connection. Every GET of the page and of the
 * files it loads (same site) goes to the network first and its answer is kept; with no network the kept one is
 * served. Never the plugin's API (the person's data — the badge copy the page keeps is its own, yo/offline.ts) nor
 * the PDF tickets: those always go to the network.
 */
'use strict';

const PAGE = '/portal/conference/yo';

const CACHE = 'cm-yo-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('cm-yo-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
})()));

/** The plugin's portal bundle and its styles (a plugin installed at runtime is loaded from there): code, not data. */
const BUNDLE = /^\/api\/v1\/plugins\/[^/]+\/bundle(\/css)?$/;
/** Kept for offline: same-site GETs, never the API (but the portal bundle), the PDF tickets or this worker. */
const keepable = (req) => {
    if (req.method !== 'GET') return false;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return false;
    if (url.pathname.startsWith('/api/')) return BUNDLE.test(url.pathname);
    return url.pathname !== '/portal/conference/file' && !url.pathname.endsWith('/sw.js');
};

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (!keepable(req)) return;
    const page = req.mode === 'navigate';
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        // The page is one entry whatever its fragment or query (the badge code lives in the fragment, never sent).
        const key = page ? new Request(new URL(PAGE, self.location.origin).href) : req;
        try {
            const res = await fetch(req);
            if (res && res.ok && (res.type === 'basic' || res.type === 'default')) cache.put(key, res.clone()).catch(() => {});
            return res;
        } catch (e) {
            const hit = await cache.match(key, { ignoreSearch: page });
            if (hit) return hit;
            throw e;
        }
    })());
});

self.addEventListener('push', (event) => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
    const meal = d.kind === 'meal_call';
    const title = typeof d.title === 'string' && d.title ? d.title.slice(0, 120) : (meal ? 'Tu grupo ya puede pasar a comer' : 'Aviso de tu bus');
    const body = typeof d.body === 'string' ? d.body.slice(0, 400) : '';
    const tag = typeof d.tag === 'string' ? d.tag.slice(0, 80) : 'cm-bus';
    event.waitUntil((async () => {
        await self.registration.showNotification(title, {
            body,
            tag,
            renotify: true,
            requireInteraction: d.kind === 'boarding' || meal,
            vibrate: [200, 100, 200, 100, 400],
            data: { kind: d.kind || null },
        });
        // An open page refreshes at once: its bus section, or its meals (a group called).
        const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of open) c.postMessage({ type: meal ? 'cm-meal-call' : 'cm-bus-notice' });
    })());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of open) {
            if (new URL(c.url).pathname.startsWith(PAGE) && 'focus' in c) return c.focus();
        }
        return self.clients.openWindow(PAGE);
    })());
});
