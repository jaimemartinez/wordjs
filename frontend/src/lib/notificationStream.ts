/**
 * The live notification stream (GET /notifications/stream), shared.
 *
 * Every admin tab used to open its own EventSource — two, in fact, because NotificationCenter is
 * mounted twice in the admin layout (mobile header and sidebar). The server caps streams per user, so a
 * handful of tabs exhausted the cap; past it the server answered 200 with an `error` frame, `onopen`
 * reset the backoff before that frame arrived, and each refused tab reconnected about twice a second
 * for ever, with no notifications and nothing on screen to say so. Over HTTP/1.1 the open streams also
 * ate the browser's six connections per host and stalled the admin.
 *
 * Now:
 *  • one stream per BROWSER and user: the tab holding a Web Lock opens it and relays every frame to the
 *    other tabs over a BroadcastChannel; when that tab closes, the lock passes to the next one. Without
 *    Web Locks (old browsers) each tab opens one stream, still one per tab, not per component;
 *  • any number of subscribers in a tab share it (reference counted);
 *  • the backoff only resets after the connection has stayed up a while or delivered a frame, so a
 *    refused or flapping stream backs off 1 s, 2 s, 4 s … up to 60 s instead of looping.
 */

export type NotificationListener = (notification: any) => void;

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** A connection that stayed open this long counts as healthy: its next failure starts over at 1 s. */
const HEALTHY_AFTER_MS = 30_000;

/** Delay before reconnect attempt `attempt` (0-based). Exported for the test. */
export function reconnectDelay(attempt: number): number {
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt)), BACKOFF_MAX_MS);
}

/** Whether a frame carries a notification (keepalives and the server's refusal frame do not). */
export function parseNotificationFrame(data: unknown): any | null {
    if (typeof data !== "string" || !data || data.startsWith(":")) return null;
    try {
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || "error" in parsed) return null;
        return parsed;
    } catch {
        return null;
    }
}

interface StreamDeps {
    url: string;
    EventSourceImpl: typeof EventSource;
    onNotification: (n: any) => void;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (id: unknown) => void;
}

/** One reconnecting EventSource. Returns a stop function. Exported for the test. */
export function openReconnectingStream(deps: StreamDeps): () => void {
    const now = deps.now || Date.now;
    const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer || ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    let attempt = 0;
    let stopped = false;
    let es: EventSource | null = null;
    let timer: unknown = null;

    const connect = () => {
        if (stopped) return;
        let openedAt: number | null = null;
        let refused = false;
        es = new deps.EventSourceImpl(deps.url, { withCredentials: true });
        es.onopen = () => { openedAt = now(); };
        es.onmessage = (event: MessageEvent) => {
            const n = parseNotificationFrame(event.data);
            if (!n) return;
            attempt = 0; // a delivered notification proves the stream works
            deps.onNotification(n);
        };
        // A named `error` frame (older servers refuse a stream past the cap with one, inside a 200; the
        // server closes a stream whose session ended with `unauthorized`) arrives on the same listener as
        // a network error; only the frame carries data. Either way, back off before trying again.
        es.addEventListener("error", (event: Event) => {
            const data = (event as MessageEvent).data;
            if (typeof data === "string" && (data.includes("too_many_streams") || data.includes("unauthorized"))) refused = true;
        });
        es.onerror = () => {
            if (stopped || !es) return;
            es.close();
            es = null;
            if (!refused && openedAt !== null && now() - openedAt >= HEALTHY_AFTER_MS) attempt = 0;
            const delay = reconnectDelay(attempt);
            attempt++;
            timer = setTimer(connect, delay);
        };
    };

    connect();
    return () => {
        stopped = true;
        if (timer !== null) clearTimer(timer);
        if (es) { es.close(); es = null; }
    };
}

/**
 * True the FIRST time a notification uuid is seen in this tab. Several components subscribe; the
 * side effects of a new notification (toast, vibration, the window event) must happen once.
 */
const claimed = new Set<string>();
export function claimNotification(uuid: unknown): boolean {
    const key = String(uuid ?? "");
    if (!key || claimed.has(key)) return false;
    claimed.add(key);
    if (claimed.size > 500) claimed.delete(claimed.values().next().value as string);
    return true;
}

/* ------------------------------------------------------------------ */
/* Per-tab sharing + cross-tab leader                                  */
/* ------------------------------------------------------------------ */

const listeners = new Set<NotificationListener>();
let activeKey: string | null = null;
let teardown: (() => void) | null = null;

function dispatch(n: any) {
    for (const l of Array.from(listeners)) {
        try { l(n); } catch { /* one listener's failure must not starve the others */ }
    }
}

function start(url: string, userKey: string) {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return () => {};
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(`wjs-notifications:${userKey}`) : null;
    if (channel) channel.onmessage = (e: MessageEvent) => dispatch(e.data);
    const relay = (n: any) => {
        dispatch(n);
        try { channel?.postMessage(n); } catch { /* a closed channel only loses the relay */ }
    };

    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks || !channel) {
        const stop = openReconnectingStream({ url, EventSourceImpl: EventSource, onNotification: relay });
        return () => { stop(); channel?.close(); };
    }

    const abort = new AbortController();
    let releaseLock: (() => void) | null = null;
    let stopStream: (() => void) | null = null;
    locks.request(`wjs-notifications-stream:${userKey}`, { signal: abort.signal }, () => {
        // This tab leads: it holds the one stream until it unsubscribes or closes.
        stopStream = openReconnectingStream({ url, EventSourceImpl: EventSource, onNotification: relay });
        return new Promise<void>((resolve) => { releaseLock = resolve; });
    }).catch(() => { /* aborted while waiting for the lock: nothing to release */ });

    return () => {
        abort.abort();
        if (stopStream) stopStream();
        if (releaseLock) releaseLock();
        channel.close();
    };
}

/**
 * Subscribe to live notifications for `userKey` (the signed-in user's id). Returns the unsubscribe
 * function. Subscribers in one tab share one connection, and tabs share one stream between them.
 */
export function subscribeNotifications(url: string, userKey: string, listener: NotificationListener): () => void {
    if (activeKey !== null && activeKey !== userKey) {
        // A different user signed in in this tab: drop the old stream before sharing a new one.
        teardown?.();
        teardown = null;
        listeners.clear();
        activeKey = null;
    }
    listeners.add(listener);
    if (!teardown) {
        activeKey = userKey;
        teardown = start(url, userKey);
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && teardown) {
            teardown();
            teardown = null;
            activeKey = null;
        }
    };
}
