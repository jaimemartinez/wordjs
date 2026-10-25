/**
 * «Mi escarapela» without a connection (conference-manager 2.36.15). The owner: «si está offline debería de
 * guardarse igualmente en el teléfono, y mostrar simplemente un icono de offline».
 *
 * - The badge part of «Mi inscripción» — name, conference, locality, code and the badge itself — is kept on the
 *   phone (localStorage) each time the page loads it, ONLY when the person chose «Recordar en este teléfono». Nothing
 *   else (answers, meals, hotel) is kept. «Salir» removes it with the session.
 * - With no connection the page shows that copy and a small offline icon; back online it loads the live page.
 * - The service worker (portal/sw.js) keeps the page itself, so it opens offline too.
 */

export const OFFLINE_KEY = "cm-mi-escarapela-offline";
/** Past this size (photos in the badge) the copy is kept without its images rather than not at all. */
const MAX_BYTES = 1_500_000;

export type OfflineCopy = {
    v: 1;
    code: string;
    saved_at: string;
    name: string;
    conference: string;
    location: string | null;
    badge: { badge: unknown; plate: string | null; images?: Record<string, string> | null } | null;
    expires_on: string | null;
};

/** The part of the view that is kept: the badge and who it is — never the answers, meals or hotel. */
export function offlineCopyOf(view: any, code: string, now = new Date()): OfflineCopy {
    return {
        v: 1, code, saved_at: now.toISOString(),
        name: String(view?.name || ''), conference: String(view?.conference || ''), location: view?.location || null,
        badge: view?.badge ? { badge: view.badge.badge, plate: view.badge.plate || null, images: view.badge.images || null } : null,
        expires_on: view?.expires_on || null,
    };
}

/** Keep the copy (without the images if it would be too big). false when the phone refuses (private mode, full). */
export function saveOffline(copy: OfflineCopy, store: Pick<Storage, "setItem"> | null = safeStorage()): boolean {
    if (!store) return false;
    let text = JSON.stringify(copy);
    if (text.length > MAX_BYTES && copy.badge) text = JSON.stringify({ ...copy, badge: { ...copy.badge, images: null } });
    try { store.setItem(OFFLINE_KEY, text); return true; } catch { return false; }
}

/** The copy kept for this badge code — none for another person's code, an expired event or a broken entry. */
export function readOffline(code: string, store: Pick<Storage, "getItem"> | null = safeStorage(), today = new Date()): OfflineCopy | null {
    if (!store) return null;
    try {
        const v = JSON.parse(store.getItem(OFFLINE_KEY) || "null");
        if (!v || v.v !== 1 || typeof v.code !== "string" || v.code !== code || !v.badge) return null;
        if (v.expires_on && String(v.expires_on).slice(0, 10) < today.toISOString().slice(0, 10)) return null;
        return v;
    } catch { return null; }
}

export function clearOffline(store: Pick<Storage, "removeItem"> | null = safeStorage()) {
    try { store && store.removeItem(OFFLINE_KEY); } catch { /* nothing kept */ }
}

/** A failed request that means «no connection» (or the server unreachable), not «no access». */
export const isOfflineFailure = (status: number | null) => status == null || status === 0 || status >= 500;

function safeStorage(): Storage | null {
    try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

/** The page's own worker (the same one as the bus notices) — it keeps the page so it opens offline. */
export async function registerOfflineWorker(url = "/portal/conference/sw.js", scope = "/portal/conference/yo") {
    try {
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
        const existing = await navigator.serviceWorker.getRegistration(scope);
        const current = existing && (existing.active || existing.waiting || existing.installing);
        if (existing && current && new URL(current.scriptURL).pathname === url) { existing.update().catch(() => {}); return; }
        await navigator.serviceWorker.register(url, { scope });
    } catch { /* no worker: the page still works online */ }
}
