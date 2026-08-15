/**
 * Verso — presencia/colaboración v1 (F3, checklist W09) COMO MÓDULO.
 *
 * Espec: el heartbeat inline del PuckEditor legacy (L1398-1430) — POST /api/v1/presence/:pageId
 * cada 10s con body "{}"; la respuesta trae los OTROS editores activos ({ editors: [{id,name}] });
 * sendBeacon con { action: "leave" } en beforeunload Y al parar (para que el servidor no espere el
 * TTL completo). Un tick offline/!ok conserva el último estado conocido (nunca borra el chip por
 * un fallo transitorio), exactamente como el legacy.
 *
 * POR QUÉ MÓDULO Y NO INLINE (crítica del blueprint al legacy): el ciclo de vida completo
 * (ping inmediato → interval → leave doble en unload/parada, con guard `dead` contra el ping en
 * vuelo que resuelve tras parar) es testeable en node con timers falsos y deps inyectadas; el
 * componente solo cablea `startPresenceHeartbeat(pageId, setCoEditors)` en un efecto.
 */

export interface PresenceEditor {
    id: number;
    name: string;
}

export const PRESENCE_INTERVAL_MS = 10_000;

export function presenceUrl(pageId: number): string {
    return `/api/v1/presence/${pageId}`;
}

/** Forma mínima estructural de fetch — lo justo que usa el ping (inyectable en tests de node). */
export type PresenceFetch = (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; credentials: "same-origin"; body: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface PresenceDeps {
    fetchFn?: PresenceFetch;
    intervalMs?: number;
    /** Emisor del beacon de salida; default navigator.sendBeacon (best-effort, jamás lanza). */
    sendLeaveBeacon?: (url: string) => void;
    /** Ventana para beforeunload; default window si existe (SSR/node: sin listener). */
    win?: Pick<Window, "addEventListener" | "removeEventListener">;
}

function defaultLeaveBeacon(url: string): void {
    try {
        navigator.sendBeacon?.(url, new Blob([JSON.stringify({ action: "leave" })], { type: "application/json" }));
    } catch {
        /* el beacon es best-effort */
    }
}

/**
 * Arranca el heartbeat de presencia: ping inmediato + uno cada `intervalMs`. Devuelve `stop()`,
 * que corta el interval, retira el listener de beforeunload y emite el leave (misma secuencia que
 * el cleanup del efecto legacy). Tras `stop()` ningún ping en vuelo vuelve a invocar `onEditors`.
 */
export function startPresenceHeartbeat(
    pageId: number,
    onEditors: (editors: PresenceEditor[]) => void,
    deps: PresenceDeps = {},
): () => void {
    const fetchFn: PresenceFetch | undefined =
        deps.fetchFn ?? (typeof fetch === "function" ? (fetch as unknown as PresenceFetch) : undefined);
    const intervalMs = deps.intervalMs ?? PRESENCE_INTERVAL_MS;
    const url = presenceUrl(pageId);
    const win = deps.win ?? (typeof window !== "undefined" ? window : undefined);
    const leave = deps.sendLeaveBeacon ?? defaultLeaveBeacon;

    let dead = false;
    const ping = async (): Promise<void> => {
        if (!fetchFn) return;
        try {
            const res = await fetchFn(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: "{}",
            });
            if (!res.ok) return; // tick fallido — conserva el último estado (legacy)
            const data: unknown = await res.json();
            const editors = (data as { editors?: unknown } | null)?.editors;
            if (!dead) onEditors(Array.isArray(editors) ? (editors as PresenceEditor[]) : []);
        } catch {
            /* tick offline — conserva el último estado conocido */
        }
    };

    void ping();
    const timer = setInterval(() => {
        void ping();
    }, intervalMs);
    const onBeforeUnload = (): void => leave(url);
    win?.addEventListener("beforeunload", onBeforeUnload);

    return () => {
        dead = true;
        clearInterval(timer);
        win?.removeEventListener("beforeunload", onBeforeUnload);
        leave(url);
    };
}
