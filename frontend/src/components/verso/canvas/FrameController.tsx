"use client";
/**
 * Verso — controlador del iframe del canvas (F2).
 *
 * Monta <iframe src="/admin/canvas-frame"> (el documento mínimo de
 * app/admin/canvas-frame/page.tsx), espera a que el documento cargue Y a que
 * `#verso-canvas-root` exista (el root aparece tras la hidratación/auth del
 * documento interno), y portalea `children` a ese root vía createPortal: el
 * árbol React es EL MISMO, así que el contexto del EditorHandle fluye al canvas
 * sin puentes por window.* (la lección de los ~7 globals del editor actual).
 *
 * Readiness SIN polling persistente: un único await de `whenCanvasRootReady`
 * — listener de `load` + MutationObserver hasta que el root aparece, y ambos
 * se desconectan al resolver o cancelar. Nada queda corriendo después.
 *
 * swapThemeCss(url): reemplaza el <link id="wjs-theme-stylesheet"> del
 * documento del iframe SIN FOUC — añade el link nuevo, espera su onload y solo
 * entonces retira el viejo (onerror: retira el nuevo y rechaza, el viejo queda).
 *
 * `overlay` se renderiza como HERMANO del iframe en el DOCUMENTO PADRE (dentro
 * del provider, así puede leer getFrameDocument): el contenedor del canvas debe
 * ser position:relative para que la capa absolute inset-0 coincida 1:1 con el
 * iframe.
 */
import React from "react";
import { createPortal } from "react-dom";

/** Id del root dentro del documento del iframe (contrato con canvas-frame/page.tsx). */
export const CANVAS_ROOT_ID = "verso-canvas-root";

/** Id del <link> del tema dentro del documento del iframe. */
export const THEME_LINK_ID = "wjs-theme-stylesheet";

export interface VersoCanvasApi {
    getFrameElement(): HTMLIFrameElement | null;
    getFrameDocument(): Document | null;
    /**
     * Cambia la hoja del tema del canvas sin FOUC: inserta el link nuevo, espera
     * onload y retira el viejo. Rechaza (y conserva el viejo) si la carga falla
     * o el iframe aún no tiene documento.
     */
    swapThemeCss(url: string): Promise<void>;
}

export const VersoCanvasContext = React.createContext<VersoCanvasApi | null>(null);

export function useVersoCanvas(): VersoCanvasApi {
    const value = React.useContext(VersoCanvasContext);
    if (!value) throw new Error("verso: useVersoCanvas debe usarse dentro de <FrameController>");
    return value;
}

interface CancellableWait {
    promise: Promise<HTMLElement>;
    cancel(): void;
}

/**
 * Un solo await: resuelve con el `#verso-canvas-root` del documento del iframe.
 * Sin polling — eventos `load` (el iframe puede recargar de about:blank al src
 * real) y un MutationObserver que muere al resolver. `cancel()` desconecta todo
 * (la promesa queda sin resolver, sin fugas).
 */
export function whenCanvasRootReady(iframe: HTMLIFrameElement): CancellableWait {
    let cancelled = false;
    let observer: MutationObserver | null = null;
    let onLoad: (() => void) | null = null;

    const cleanup = () => {
        observer?.disconnect();
        observer = null;
        if (onLoad) {
            iframe.removeEventListener("load", onLoad);
            onLoad = null;
        }
    };

    const promise = new Promise<HTMLElement>((resolve) => {
        const find = (): HTMLElement | null =>
            iframe.contentDocument?.getElementById(CANVAS_ROOT_ID) ?? null;
        const watchDocument = () => {
            if (cancelled) return;
            const found = find();
            if (found) {
                cleanup();
                resolve(found);
                return;
            }
            const doc = iframe.contentDocument;
            if (!doc) return; // sin documento aún: el próximo `load` re-engancha
            // Cada `load` trae un documento NUEVO: re-observar el actual.
            observer?.disconnect();
            observer = new MutationObserver(() => {
                const el = find();
                if (el) {
                    cleanup();
                    resolve(el);
                }
            });
            observer.observe(doc.documentElement ?? doc, { childList: true, subtree: true });
        };
        onLoad = watchDocument;
        iframe.addEventListener("load", watchDocument);
        watchDocument();
    });

    return {
        promise,
        cancel: () => {
            cancelled = true;
            cleanup();
        },
    };
}

export interface FrameControllerProps {
    /** Árbol del editor: se portalea a `#verso-canvas-root` cuando el frame está listo. */
    children: React.ReactNode;
    /**
     * Capa(s) de chrome en el DOCUMENTO PADRE, hermanas del iframe (overlay de
     * selección/hover/ActionBar). Renderizadas dentro del provider.
     */
    overlay?: React.ReactNode;
    /** Documento a cargar (default: /admin/canvas-frame). */
    src?: string;
    /** Clase del iframe (default: llena el contenedor). */
    className?: string;
    title?: string;
    /** Llamada UNA vez cuando el root existe (documento listo). Mantener estable. */
    onFrameReady?: (doc: Document) => void;
}

export default function FrameController({
    children,
    overlay,
    src = "/admin/canvas-frame",
    className = "block h-full w-full border-0 bg-white",
    title = "Lienzo de edición",
    onFrameReady,
}: FrameControllerProps) {
    const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
    const [root, setRoot] = React.useState<HTMLElement | null>(null);
    // Ref para no re-crear el watcher si el llamador pasa un callback inline
    // (actualizada en un efecto: las refs no se escriben durante el render).
    const onFrameReadyRef = React.useRef(onFrameReady);
    React.useEffect(() => {
        onFrameReadyRef.current = onFrameReady;
    }, [onFrameReady]);

    React.useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        let disposed = false;
        const wait = whenCanvasRootReady(iframe);
        void wait.promise.then((el) => {
            if (disposed) return;
            setRoot(el);
            const doc = iframe.contentDocument;
            if (doc) onFrameReadyRef.current?.(doc);
        });
        return () => {
            disposed = true;
            wait.cancel();
        };
    }, []);

    const swapThemeCss = React.useCallback((url: string): Promise<void> => {
        const doc = iframeRef.current?.contentDocument;
        if (!doc?.head) {
            return Promise.reject(new Error("verso: el canvas no tiene documento todavía"));
        }
        return new Promise<void>((resolve, reject) => {
            const old = doc.getElementById(THEME_LINK_ID);
            const next = doc.createElement("link");
            next.rel = "stylesheet";
            next.href = url;
            const settle = (ok: boolean) => {
                next.onload = null;
                next.onerror = null;
                if (ok) {
                    // El nuevo ya está aplicado: retirar el viejo AHORA no deja hueco.
                    old?.remove();
                    next.id = THEME_LINK_ID;
                    resolve();
                } else {
                    next.remove();
                    reject(new Error(`verso: no se pudo cargar la hoja de tema ${url}`));
                }
            };
            next.onload = () => settle(true);
            next.onerror = () => settle(false);
            doc.head.appendChild(next);
        });
    }, []);

    const api = React.useMemo<VersoCanvasApi>(
        () => ({
            getFrameElement: () => iframeRef.current,
            getFrameDocument: () => iframeRef.current?.contentDocument ?? null,
            swapThemeCss,
        }),
        [swapThemeCss],
    );

    return (
        <VersoCanvasContext.Provider value={api}>
            <iframe ref={iframeRef} src={src} title={title} className={className} />
            {root ? createPortal(children, root) : null}
            {overlay}
        </VersoCanvasContext.Provider>
    );
}
