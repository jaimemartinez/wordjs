/**
 * F3 ola 4 — presencia como módulo (checklist W09): heartbeat de 10s con timers falsos y deps
 * inyectadas — el contrato del inline legacy (PuckEditor L1398-1430) verificable en node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    PRESENCE_INTERVAL_MS,
    presenceUrl,
    startPresenceHeartbeat,
    type PresenceEditor,
    type PresenceFetch,
} from "../presence";

function okResponse(editors: unknown): ReturnType<PresenceFetch> {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ editors }) });
}

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe("startPresenceHeartbeat", () => {
    it("ping inmediato + uno cada 10s a la URL del pageId, con el init del legacy", async () => {
        const fetchFn = vi.fn<PresenceFetch>(() => okResponse([]));
        const stop = startPresenceHeartbeat(172, () => {}, { fetchFn, sendLeaveBeacon: () => {} });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(fetchFn).toHaveBeenCalledWith(presenceUrl(172), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: "{}",
        });
        expect(presenceUrl(172)).toBe("/api/v1/presence/172");

        await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS * 2);
        expect(fetchFn).toHaveBeenCalledTimes(4);
        stop();
    });

    it("entrega los coeditores de la respuesta; una forma no-array cae a []", async () => {
        const seen: PresenceEditor[][] = [];
        let payload: unknown = [{ id: 7, name: "Ana" }];
        const fetchFn: PresenceFetch = () => okResponse(payload);
        const stop = startPresenceHeartbeat(1, (e) => seen.push(e), { fetchFn, sendLeaveBeacon: () => {} });
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual([[{ id: 7, name: "Ana" }]]);
        payload = "corrupto";
        await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS);
        expect(seen[1]).toEqual([]);
        stop();
    });

    it("un tick !ok o un fetch que lanza CONSERVA el último estado (no invoca onEditors)", async () => {
        const onEditors = vi.fn();
        let mode: "ok" | "bad" | "throw" = "ok";
        const fetchFn: PresenceFetch = () => {
            if (mode === "throw") return Promise.reject(new Error("offline"));
            if (mode === "bad") return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
            return okResponse([{ id: 1, name: "Eva" }]);
        };
        const stop = startPresenceHeartbeat(2, onEditors, { fetchFn, sendLeaveBeacon: () => {} });
        await vi.advanceTimersByTimeAsync(0);
        expect(onEditors).toHaveBeenCalledTimes(1);
        mode = "bad";
        await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS);
        expect(onEditors).toHaveBeenCalledTimes(1); // sin llamada nueva
        mode = "throw";
        await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS);
        expect(onEditors).toHaveBeenCalledTimes(1);
        stop();
    });

    it("stop(): corta el interval, emite el leave y silencia el ping en vuelo", async () => {
        const onEditors = vi.fn();
        const leaves: string[] = [];
        // Objeto mutable (no `let`): TS no puede narrowear la asignación hecha dentro del executor.
        const gate: { release?: () => void } = {};
        const fetchFn: PresenceFetch = () =>
            new Promise((resolve) => {
                gate.release = () => resolve({ ok: true, json: () => Promise.resolve({ editors: [{ id: 3, name: "X" }] }) });
            });
        const stop = startPresenceHeartbeat(9, onEditors, { fetchFn, sendLeaveBeacon: (u) => leaves.push(u) });
        stop(); // el ping inmediato sigue EN VUELO
        expect(leaves).toEqual([presenceUrl(9)]);
        gate.release?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(onEditors).not.toHaveBeenCalled(); // resuelto tras stop → descartado
        await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS * 3);
        expect(leaves.length).toBe(1); // el interval murió con stop
    });

    it("beforeunload emite el leave por la ventana inyectada, y stop lo retira", async () => {
        const listeners = new Map<string, Set<() => void>>();
        const win = {
            addEventListener: (type: string, fn: () => void) => {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type)?.add(fn);
            },
            removeEventListener: (type: string, fn: () => void) => {
                listeners.get(type)?.delete(fn);
            },
        } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
        const leaves: string[] = [];
        const stop = startPresenceHeartbeat(4, () => {}, {
            fetchFn: () => okResponse([]),
            sendLeaveBeacon: (u) => leaves.push(u),
            win,
        });
        await vi.advanceTimersByTimeAsync(0);
        const unload = listeners.get("beforeunload");
        expect(unload?.size).toBe(1);
        unload?.forEach((fn) => fn());
        expect(leaves).toEqual([presenceUrl(4)]);
        stop();
        expect(listeners.get("beforeunload")?.size).toBe(0);
        expect(leaves.length).toBe(2); // stop también emite leave (paridad con el cleanup legacy)
    });
});
