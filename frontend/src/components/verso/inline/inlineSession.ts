/**
 * Verso — edición inline declarativa (F2): lógica PURA, sin React ni DOM.
 *
 * Dos piezas, ambas testeables en node (vitest sin jsdom):
 *
 * 1. `createInlineMountStore(handle, registry, nodeId)` — par {subscribe,
 *    getSnapshot} para useSyncExternalStore: el snapshot es la declaración
 *    `BlockDefinition.inline` del type del nodo cuando `inlineEditingId ===
 *    nodeId`, y `null` en cualquier otro caso. La referencia del snapshot es
 *    ESTABLE (el objeto `inline` vive en el registry), y la suscripción usa el
 *    selector `s => s.inlineEditingId`: el store solo notifica al entrar/salir
 *    del modo inline — jamás por un setProps (base del montaje/desmontaje
 *    selectivo de VersoInline en VersoBlock).
 *
 * 2. `createInlineSession(deps)` — la sesión de commits de una edición inline:
 *    - `onContent(raw)` recibe el contenido del editor Tiptap y programa un
 *      commit throttled: el primero inmediato, los siguientes como pronto
 *      `INLINE_COMMIT_THROTTLE_MS` tras el último commit (reloj y timers
 *      inyectables para tests).
 *    - Cada commit pasa el contenido por `transform` (la sanitizeHTML
 *      isomórfica en rich; identidad en plain — defensa en profundidad, el
 *      saneado del servidor NO cambia) y emite UNA transacción
 *      `setProps(nodeId, { [prop]: value })` con `coalesceKey`
 *      `inline:<nodeId>` estable: la coalescencia del store agrupa los commits
 *      que caigan dentro de su ventana en una sola entrada de undo.
 *    - La sesión se SUSCRIBE a `inlineEditingId`: en cuanto deja de ser su
 *      nodo (Escape/click fuera → `end()`, `handle.commitInline()`, o el
 *      propio store al desaparecer el nodo) hace flush del pendiente y se
 *      desuscribe — así `commitInline()` implica flush sin que el store
 *      conozca a Tiptap.
 *
 * INVARIANTE Verso: la sesión solo emite comandos vía `transact` — jamás muta
 * el doc por otra vía; un contenido idéntico al último committeado no abre
 * transacción (sin entradas de historia vacías), y un nodo desaparecido hace
 * el commit no-op (fail-soft).
 */

import type { VersoDoc, VersoEditorState } from "@/lib/verso/types";
import type { BlockDefinition, BlockRegistry } from "@/lib/verso/registry";

/** Intervalo mínimo entre commits parciales de una sesión inline (ms). */
export const INLINE_COMMIT_THROTTLE_MS = 300;

/** Declaración inline de un bloque (BlockDefinition.inline materializado). */
export type InlineSpec = NonNullable<BlockDefinition["inline"]>;

/** Clave de coalescencia de TODOS los commits de la sesión inline de un nodo. */
export function inlineCoalesceKey(nodeId: string): string {
    return `inline:${nodeId}`;
}

/* ------------------------------------------------------------------ */
/* Handle estructural: el EditorHandle real encaja (mismo patrón que    */
/* KeyboardMoverDeps en dnd/driverCore.ts).                             */
/* ------------------------------------------------------------------ */

export interface InlineStoreHandle {
    getDoc(): VersoDoc;
    getState(): VersoEditorState;
    subscribe<T>(listener: (slice: T) => void, selector?: (state: VersoEditorState) => T): () => void;
}

export interface InlineSessionHandle extends InlineStoreHandle {
    transact(
        fn: (tx: { setProps(nodeId: string, patch: Record<string, unknown>): void }) => void,
        opts?: { coalesceKey?: string; label?: string },
    ): boolean;
    setInlineEditing(nodeId: string | null): void;
}

/* ------------------------------------------------------------------ */
/* Mount store: cuándo debe montarse VersoInline sobre un nodo.         */
/* ------------------------------------------------------------------ */

export interface InlineMountStore {
    subscribe(onStoreChange: () => void): () => void;
    /** Declaración inline del nodo activo, o null. Referencia estable (vive en el registry). */
    getSnapshot(): InlineSpec | null;
}

const selectInlineEditingId = (s: VersoEditorState): string | null => s.inlineEditingId;

export function createInlineMountStore(
    handle: InlineStoreHandle,
    registry: BlockRegistry,
    nodeId: string,
): InlineMountStore {
    return {
        subscribe: (onStoreChange) =>
            handle.subscribe<string | null>(() => onStoreChange(), selectInlineEditingId),
        getSnapshot: () => {
            if (handle.getState().inlineEditingId !== nodeId) return null;
            const node = handle.getDoc().nodes[nodeId];
            if (!node) return null;
            return registry.get(node.type)?.inline ?? null;
        },
    };
}

/* ------------------------------------------------------------------ */
/* Sesión de commits.                                                   */
/* ------------------------------------------------------------------ */

export interface InlineSessionDeps {
    handle: InlineSessionHandle;
    nodeId: string;
    /** Prop de destino declarada en BlockDefinition.inline. */
    prop: string;
    /**
     * Normalización/saneado del contenido crudo del editor ANTES de setProps.
     * VersoInline pasa la sanitizeHTML isomórfica (schema rich) o la identidad
     * (schema plain: el valor es texto de editor.getText(), no HTML).
     */
    transform: (raw: string) => string;
    /** Reloj inyectable (tests). Default: Date.now. */
    now?: () => number;
    /** Timers inyectables (tests). Default: setTimeout/clearTimeout. */
    schedule?: (cb: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
    /** Etiqueta de historia. Default: "Edición inline". */
    label?: string;
}

export interface InlineSession {
    /** Contenido nuevo del editor (crudo). Programa un commit throttled. */
    onContent(raw: string): void;
    /** Commit inmediato del pendiente. true si emitió setProps. */
    flush(): boolean;
    /** Commit final + salida del modo inline (setInlineEditing(null)) + desuscripción. */
    end(): void;
    /** Flush + desuscripción SIN tocar inlineEditingId (cleanup de React). Idempotente. */
    dispose(): void;
    /** true tras dispose/end o tras el flush automático por cambio de inlineEditingId. */
    isDisposed(): boolean;
}

export function createInlineSession(deps: InlineSessionDeps): InlineSession {
    const now = deps.now ?? (() => Date.now());
    const schedule =
        deps.schedule ?? ((cb: () => void, ms: number): unknown => setTimeout(cb, ms));
    const cancel =
        deps.cancel ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
    const coalesceKey = inlineCoalesceKey(deps.nodeId);
    const label = deps.label ?? "Edición inline";

    let pendingRaw: string | null = null;
    /** Último valor TRANSFORMADO committeado (para no abrir transacciones vacías). */
    let lastCommitted: string | null = null;
    /** -Infinity: el primer commit de la sesión no espera. */
    let lastCommitAt = Number.NEGATIVE_INFINITY;
    let timer: unknown = null;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const clearTimer = (): void => {
        if (timer !== null) {
            cancel(timer);
            timer = null;
        }
    };

    const commitPending = (): boolean => {
        if (pendingRaw === null) return false;
        const raw = pendingRaw;
        pendingRaw = null;
        const value = deps.transform(raw);
        if (value === lastCommitted) return false;
        // Nodo desaparecido (remove/undo/replace durante la edición): fail-soft.
        if (!deps.handle.getDoc().nodes[deps.nodeId]) return false;
        const ok = deps.handle.transact(
            (tx) => tx.setProps(deps.nodeId, { [deps.prop]: value }),
            { coalesceKey, label },
        );
        if (ok) {
            lastCommitted = value;
            lastCommitAt = now();
        }
        return ok;
    };

    const flush = (): boolean => {
        clearTimer();
        return commitPending();
    };

    const disposeInternal = (): void => {
        if (disposed) return;
        disposed = true;
        flush();
        unsubscribe?.();
        unsubscribe = null;
    };

    // El flush de commitInline()/setInlineEditing(otro|null) llega por aquí:
    // el store no conoce a Tiptap; la sesión observa inlineEditingId y cierra
    // sola en cuanto deja de ser su nodo.
    unsubscribe = deps.handle.subscribe<string | null>((id) => {
        if (id !== deps.nodeId) disposeInternal();
    }, selectInlineEditingId);

    return {
        onContent(raw: string): void {
            if (disposed) return;
            pendingRaw = raw;
            if (timer !== null) return; // ya hay un commit programado: recogerá el último pendiente
            const wait = Math.max(0, lastCommitAt + INLINE_COMMIT_THROTTLE_MS - now());
            timer = schedule(() => {
                timer = null;
                commitPending();
            }, wait);
        },
        flush,
        end(): void {
            // flush ANTES de salir del modo (la salida notifica la suscripción,
            // que a su vez es no-op porque el pendiente ya está vacío).
            if (!disposed) flush();
            deps.handle.setInlineEditing(null);
            disposeInternal();
        },
        dispose: disposeInternal,
        isDisposed: () => disposed,
    };
}
