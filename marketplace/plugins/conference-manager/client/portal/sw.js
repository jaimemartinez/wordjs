/*
 * «Mi inscripción» service worker (conference-manager 2.27.0): shows the bus notices the transport team sends
 * («Tu bus está embarcando», «Tu bus salió», their messages) as notifications, and a tap on one opens (or
 * focuses) the person's page. Registered by /portal/conference/yo with that page as its scope; it caches
 * nothing and serves no request. 2.36.5: also the meal call of the person's group («Tu grupo ya puede pasar a comer»).
 */
'use strict';

const PAGE = '/portal/conference/yo';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
