/**
 * Verso — tests del GeometryStore (F2).
 *
 * ENTORNO: node (sin jsdom). El store es testeable por diseño: scheduler y
 * factoría de ResizeObserver inyectables; los "elementos" solo necesitan
 * getBoundingClientRect. El batching por rAF se verifica con fake timers
 * (scheduler inyectado sobre setTimeout, que vi.useFakeTimers controla).
 * La geometría con layout REAL (scroll del iframe, escala del device-preview)
 * queda para la verificación en navegador del orquestador — jsdom/node no
 * tienen motor de layout (regla de memoria: exacto y verificado en pantalla).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    GeometryStore,
    type BlockRect,
    type ResizeObserverLike,
} from "../GeometryStore";

const FRAME_MS = 16;

function makeEl(initial: BlockRect): { el: HTMLElement; set: (r: Partial<BlockRect>) => void } {
    const state: BlockRect = { ...initial };
    const el = {
        getBoundingClientRect: () => ({ ...state }),
    } as unknown as HTMLElement;
    return { el, set: (r) => Object.assign(state, r) };
}

function makeStore() {
    let roCallback: (() => void) | null = null;
    const observed = new Set<Element>();
    const ro: ResizeObserverLike = {
        observe: (el) => observed.add(el),
        unobserve: (el) => observed.delete(el),
        disconnect: () => observed.clear(),
    };
    const store = new GeometryStore({
        schedule: (cb) => setTimeout(cb, FRAME_MS) as unknown as number,
        cancel: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
        createResizeObserver: (onResize) => {
            roCallback = onResize;
            return ro;
        },
    });
    return { store, observed, triggerResize: () => roCallback?.() };
}

describe("GeometryStore — batching por frame y ciclo de vida de rects", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("N registros en el mismo frame = UNA medición y UNA notificación", () => {
        const { store, observed } = makeStore();
        const listener = vi.fn();
        store.subscribe(listener);

        const a = makeEl({ x: 0, y: 10, width: 100, height: 20 });
        const b = makeEl({ x: 0, y: 40, width: 100, height: 30 });
        store.registerElement("a", a.el);
        store.registerElement("b", b.el);

        // Nada síncrono: el flush espera al frame.
        expect(listener).not.toHaveBeenCalled();
        expect(store.getRects().size).toBe(0);

        vi.advanceTimersByTime(FRAME_MS);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getRect("a")).toEqual({ x: 0, y: 10, width: 100, height: 20 });
        expect(store.getRect("b")).toEqual({ x: 0, y: 40, width: 100, height: 30 });
        // Ambos elementos quedaron bajo el ResizeObserver compartido.
        expect(observed.size).toBe(2);
        store.destroy();
    });

    it("varias invalidaciones (ResizeObserver + invalidate) coalescen en un flush con el rect nuevo", () => {
        const { store, triggerResize } = makeStore();
        const listener = vi.fn();
        const a = makeEl({ x: 0, y: 10, width: 100, height: 20 });
        store.registerElement("a", a.el);
        vi.advanceTimersByTime(FRAME_MS);
        store.subscribe(listener);
        const before = store.getRects();

        a.set({ y: 300, height: 50 });
        triggerResize();
        triggerResize();
        store.invalidate();
        expect(listener).not.toHaveBeenCalled();

        vi.advanceTimersByTime(FRAME_MS);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getRect("a")).toEqual({ x: 0, y: 300, width: 100, height: 50 });
        // Snapshot nuevo por referencia (contrato useSyncExternalStore).
        expect(store.getRects()).not.toBe(before);
        store.destroy();
    });

    it("un flush sin cambios NO notifica y conserva la referencia del snapshot", () => {
        const { store } = makeStore();
        const listener = vi.fn();
        const a = makeEl({ x: 5, y: 5, width: 10, height: 10 });
        store.registerElement("a", a.el);
        vi.advanceTimersByTime(FRAME_MS);
        store.subscribe(listener);
        const snapshot = store.getRects();

        store.invalidate();
        vi.advanceTimersByTime(FRAME_MS);
        expect(listener).not.toHaveBeenCalled();
        expect(store.getRects()).toBe(snapshot);
        store.destroy();
    });

    it("desregistrar (el=null) limpia el rect en el siguiente flush y des-observa el elemento", () => {
        const { store, observed } = makeStore();
        const a = makeEl({ x: 0, y: 0, width: 10, height: 10 });
        const b = makeEl({ x: 0, y: 20, width: 10, height: 10 });
        store.registerElement("a", a.el);
        store.registerElement("b", b.el);
        vi.advanceTimersByTime(FRAME_MS);
        expect(store.getRects().size).toBe(2);

        store.registerElement("a", null);
        expect(observed.has(a.el)).toBe(false);
        vi.advanceTimersByTime(FRAME_MS);
        expect(store.getRect("a")).toBeUndefined();
        expect(store.getRects().size).toBe(1);
        expect(store.getRect("b")).toEqual({ x: 0, y: 20, width: 10, height: 10 });
        store.destroy();
    });

    it("re-registro del mismo id (remount) des-observa el elemento anterior y mide el nuevo", () => {
        const { store, observed } = makeStore();
        const v1 = makeEl({ x: 0, y: 0, width: 10, height: 10 });
        const v2 = makeEl({ x: 0, y: 99, width: 20, height: 20 });
        store.registerElement("a", v1.el);
        vi.advanceTimersByTime(FRAME_MS);
        store.registerElement("a", v2.el);
        expect(observed.has(v1.el)).toBe(false);
        expect(observed.has(v2.el)).toBe(true);
        vi.advanceTimersByTime(FRAME_MS);
        expect(store.getRect("a")).toEqual({ x: 0, y: 99, width: 20, height: 20 });
        store.destroy();
    });
});

describe("GeometryStore — listeners de entorno (scroll capture del iframe, resize de ambas ventanas)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function makeEnv() {
        const handlers: Record<string, Array<(e: Event) => void>> = {};
        const track = (type: string, fn: (e: Event) => void) => {
            (handlers[type] ??= []).push(fn);
        };
        const frameDoc = {
            addEventListener: vi.fn((t: string, fn: (e: Event) => void) => track(`doc:${t}`, fn)),
            removeEventListener: vi.fn(),
        } as unknown as Document;
        const frameWin = {
            addEventListener: vi.fn((t: string, fn: (e: Event) => void) => track(`frame:${t}`, fn)),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        const parentWin = {
            addEventListener: vi.fn((t: string, fn: (e: Event) => void) => track(`parent:${t}`, fn)),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        return { handlers, frameDoc, frameWin, parentWin };
    }

    it("scroll (capture) y resize re-miden batcheado; destroy desengancha todo", () => {
        const { store } = makeStore();
        const env = makeEnv();
        const listener = vi.fn();
        const a = makeEl({ x: 0, y: 100, width: 50, height: 10 });
        store.registerElement("a", a.el);
        vi.advanceTimersByTime(FRAME_MS);
        store.subscribe(listener);

        store.attachFrame(env.frameDoc, env.frameWin, env.parentWin);
        // Scroll en fase CAPTURE sobre el documento del iframe (contrato de la capa).
        expect(env.frameDoc.addEventListener).toHaveBeenCalledWith(
            "scroll",
            expect.any(Function),
            expect.objectContaining({ capture: true, passive: true }),
        );
        expect(env.frameWin.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
        expect(env.parentWin.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
        vi.advanceTimersByTime(FRAME_MS); // attach invalida; sin cambios no notifica
        expect(listener).not.toHaveBeenCalled();

        // El bloque "se mueve" con el scroll → el handler de scroll dispara la re-medición.
        a.set({ y: 40 });
        for (const fn of env.handlers["doc:scroll"] ?? []) fn(new Event("scroll"));
        vi.advanceTimersByTime(FRAME_MS);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getRect("a")).toEqual({ x: 0, y: 40, width: 50, height: 10 });

        // resize de la ventana padre también invalida.
        a.set({ width: 80 });
        for (const fn of env.handlers["parent:resize"] ?? []) fn(new Event("resize"));
        vi.advanceTimersByTime(FRAME_MS);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.getRect("a")?.width).toBe(80);

        store.destroy();
        expect(env.frameDoc.removeEventListener).toHaveBeenCalled();
        expect(env.frameWin.removeEventListener).toHaveBeenCalled();
        expect(env.parentWin.removeEventListener).toHaveBeenCalled();
        // Tras destroy, invalidate es no-op.
        store.invalidate();
        vi.advanceTimersByTime(FRAME_MS);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("re-attach (reload del iframe) limpia el enganche anterior antes de enganchar el nuevo", () => {
        const { store } = makeStore();
        const first = makeEnv();
        const second = makeEnv();
        store.attachFrame(first.frameDoc, first.frameWin, first.parentWin);
        store.attachFrame(second.frameDoc, second.frameWin, second.parentWin);
        expect(first.frameDoc.removeEventListener).toHaveBeenCalledWith(
            "scroll",
            expect.any(Function),
            expect.objectContaining({ capture: true }),
        );
        expect(first.frameWin.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
        expect(second.frameDoc.addEventListener).toHaveBeenCalled();
        store.destroy();
    });
});
