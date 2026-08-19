export const THEME_ACTIVATION_EVENT = "wordjs:theme-activated";
export const THEME_ACTIVATION_CHANNEL = "wordjs-theme-activation";
export const THEME_ACTIVATION_STORAGE_KEY = "wordjs:last-theme-activation";

export interface ThemeActivationSignal {
    type: "theme-activated";
    slug: string;
    id: string;
    timestamp: number;
}

const normalizeSlug = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

export function parseThemeActivationSignal(value: unknown): ThemeActivationSignal | null {
    let candidate = value;
    if (typeof candidate === "string") {
        try {
            candidate = JSON.parse(candidate);
        } catch {
            return null;
        }
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;

    const record = candidate as Record<string, unknown>;
    const slug = normalizeSlug(record.slug);
    if (record.type !== "theme-activated" || !slug || typeof record.id !== "string" || !record.id) {
        return null;
    }

    return {
        type: "theme-activated",
        slug,
        id: record.id,
        timestamp: typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
            ? record.timestamp
            : 0,
    };
}

export function publishThemeActivation(slugValue: unknown): void {
    if (typeof window === "undefined") return;
    const slug = normalizeSlug(slugValue);
    if (!slug) return;

    const timestamp = Date.now();
    const signal: ThemeActivationSignal = {
        type: "theme-activated",
        slug,
        id: `${timestamp}:${Math.random().toString(36).slice(2)}`,
        timestamp,
    };

    // Same-document listeners (including an embedded public preview).
    window.dispatchEvent(new CustomEvent(THEME_ACTIVATION_EVENT, { detail: signal }));

    // BroadcastChannel is the primary cross-tab path. localStorage is a fallback for browsers that
    // do not expose it and also wakes tabs whose channel was created after the admin page mounted.
    try {
        if (typeof window.BroadcastChannel === "function") {
            const channel = new window.BroadcastChannel(THEME_ACTIVATION_CHANNEL);
            channel.postMessage(signal);
            channel.close();
        }
    } catch {
        // Focus/visibility reconciliation remains available if the channel is blocked.
    }

    try {
        window.localStorage.setItem(THEME_ACTIVATION_STORAGE_KEY, JSON.stringify(signal));
    } catch {
        // Storage may be unavailable in privacy-restricted contexts.
    }
}

export function subscribeToThemeActivation(listener: (signal: ThemeActivationSignal) => void): () => void {
    if (typeof window === "undefined") return () => undefined;

    const delivered = new Set<string>();
    const deliver = (value: unknown) => {
        const signal = parseThemeActivationSignal(value);
        if (!signal || delivered.has(signal.id)) return;
        delivered.add(signal.id);
        listener(signal);
    };

    const onCustomEvent = (event: Event) => {
        deliver((event as CustomEvent<unknown>).detail);
    };
    const onStorage = (event: StorageEvent) => {
        if (event.key === THEME_ACTIVATION_STORAGE_KEY) deliver(event.newValue);
    };

    window.addEventListener(THEME_ACTIVATION_EVENT, onCustomEvent);
    window.addEventListener("storage", onStorage);

    let channel: BroadcastChannel | null = null;
    try {
        if (typeof window.BroadcastChannel === "function") {
            channel = new window.BroadcastChannel(THEME_ACTIVATION_CHANNEL);
            channel.addEventListener("message", (event) => deliver(event.data));
        }
    } catch {
        channel = null;
    }

    return () => {
        window.removeEventListener(THEME_ACTIVATION_EVENT, onCustomEvent);
        window.removeEventListener("storage", onStorage);
        channel?.close();
    };
}
