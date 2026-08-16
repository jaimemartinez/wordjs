/**
 * Verso — GeometryStore: mapa id→rect de los bloques del canvas (F2).
 *
 * Alimentado por el `onBlockElement` del EditorRenderer (registerElement). Cada
 * elemento se observa con UN ResizeObserver compartido; `attachFrame` engancha
 * scroll en fase CAPTURE sobre el documento del iframe (los contenedores con
 * overflow interno no burbujean scroll) y resize en la ventana del iframe y en
 * la del padre. TODA invalidación (registro, RO, scroll, resize, o invalidate()
 * externo tras un transact/dragPreview — un reflow por mutación de doc NO
 * dispara RO) se batchea por requestAnimationFrame: N invalidaciones en un
 * frame = UNA medición + UNA notificación.
 *
 * Coordenadas: getBoundingClientRect dentro del documento del iframe = viewport
 * del iframe = coordenadas del canvas. La capa overlay vive DENTRO del mismo
 * contenedor escalado del device-preview (hermana del iframe), así que el mapeo
 * es 1:1 sin término de escala.
 *
 * El snapshot (`getRects`) solo cambia de referencia cuando algún rect cambió:
 * apto para useSyncExternalStore sin re-renders vacíos.
 *
 * Testeable en node (vitest sin jsdom): scheduler y factoría de ResizeObserver
 * inyectables; los "elementos" solo necesitan getBoundingClientRect.
 */

export interface BlockRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type GeometryListener = (rects: ReadonlyMap<string, BlockRect>) => void;

export interface ResizeObserverLike {
    observe(el: Element): void;
    unobserve(el: Element): void;
    disconnect(): void;
}

import { cancelFrame, scheduleFrame } from "../frameScheduler";

export interface GeometryStoreOptions {
    /** Scheduler del batching (default: requestAnimationFrame; en node, setTimeout 16ms). */
    schedule?: (cb: () => void) => number;
    cancel?: (handle: number) => void;
    /** Factoría del ResizeObserver (default: el global; null = sin observación de tamaño). */
    createResizeObserver?: (onResize: () => void) => ResizeObserverLike | null;
}

// rAF con backstop de visibilidad (un pane oculto congela rAF y dejaría el
// overlay sin medir): ver frameScheduler.ts.
const defaultSchedule = (cb: () => void): number => scheduleFrame(cb);

const defaultCancel = (handle: number): void => cancelFrame(handle);

const defaultCreateResizeObserver = (onResize: () => void): ResizeObserverLike | null =>
    typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;

const sameRect = (a: BlockRect | undefined, b: BlockRect): boolean =>
    !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export class GeometryStore {
    private readonly schedule: (cb: () => void) => number;
    private readonly cancel: (handle: number) => void;
    private readonly resizeObserver: ResizeObserverLike | null;

    private readonly elements = new Map<string, HTMLElement>();
    private rects: ReadonlyMap<string, BlockRect> = new Map();
    private readonly listeners = new Set<GeometryListener>();
    private frame: number | null = null;
    private detachEnv: Array<() => void> = [];
    private destroyed = false;

    constructor(options: GeometryStoreOptions = {}) {
        this.schedule = options.schedule ?? defaultSchedule;
        this.cancel = options.cancel ?? defaultCancel;
        const factory = options.createResizeObserver ?? defaultCreateResizeObserver;
        this.resizeObserver = factory(() => this.invalidate());
    }

    /** Canal onBlockElement del EditorRenderer: el (id interno) monta con `el` y desmonta con null. */
    registerElement(id: string, el: HTMLElement | null): void {
        if (this.destroyed) return;
        const previous = this.elements.get(id);
        if (previous && previous !== el) this.resizeObserver?.unobserve(previous);
        if (el) {
            this.elements.set(id, el);
            this.resizeObserver?.observe(el);
        } else {
            this.elements.delete(id);
        }
        this.invalidate();
    }

    /**
     * Engancha los listeners de entorno: scroll CAPTURE en el documento del
     * iframe, resize en su ventana y en la del padre. Re-attach limpia el
     * enganche anterior (un reload del frame trae documento nuevo).
     */
    attachFrame(frameDoc: Document, frameWindow: Window | null, parentWindow: Window | null): void {
        if (this.destroyed) return;
        this.detachFrame();
        const onAny = () => this.invalidate();
        frameDoc.addEventListener("scroll", onAny, { capture: true, passive: true });
        this.detachEnv.push(() => frameDoc.removeEventListener("scroll", onAny, { capture: true }));
        for (const win of [frameWindow, parentWindow]) {
            if (!win) continue;
            win.addEventListener("resize", onAny);
            this.detachEnv.push(() => win.removeEventListener("resize", onAny));
        }
        this.invalidate();
    }

    detachFrame(): void {
        for (const detach of this.detachEnv.splice(0)) detach();
    }

    /** Marca la geometría sucia; la medición se batchea a un frame. */
    invalidate(): void {
        if (this.destroyed || this.frame !== null) return;
        this.frame = this.schedule(() => {
            this.frame = null;
            this.flush();
        });
    }

    getRects(): ReadonlyMap<string, BlockRect> {
        return this.rects;
    }

    getRect(id: string): BlockRect | undefined {
        return this.rects.get(id);
    }

    subscribe(listener: GeometryListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.frame !== null) {
            this.cancel(this.frame);
            this.frame = null;
        }
        this.detachFrame();
        this.resizeObserver?.disconnect();
        this.elements.clear();
        this.listeners.clear();
    }

    private flush(): void {
        if (this.destroyed) return;
        const next = new Map<string, BlockRect>();
        let changed = this.rects.size !== this.elements.size;
        for (const [id, el] of this.elements) {
            const r = el.getBoundingClientRect();
            const rect: BlockRect = { x: r.x, y: r.y, width: r.width, height: r.height };
            const previous = this.rects.get(id);
            next.set(id, sameRect(previous, rect) ? (previous as BlockRect) : rect);
            if (!sameRect(previous, rect)) changed = true;
        }
        if (!changed) return; // snapshot estable: sin notificación vacía
        this.rects = next;
        for (const listener of [...this.listeners]) listener(this.rects);
    }
}
