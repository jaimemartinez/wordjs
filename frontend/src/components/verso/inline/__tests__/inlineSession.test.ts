/**
 * Verso — tests de la edición inline declarativa (F2): lógica PURA de
 * inlineSession.ts contra el editor REAL (createEditor) — sin React ni DOM.
 *
 * Cubre exactamente lo extraíble a node:
 * - el par {subscribe,getSnapshot} del mount store (montaje/desmontaje
 *   condicionado a inlineEditingId, referencia estable, sin notificaciones
 *   por setProps);
 * - el throttle de commits con reloj y timers inyectados;
 * - que el flush emite setProps con el prop correcto y coalesceKey estable;
 * - que la transformación (sanitización) se aplica ANTES de setProps;
 * - el flush por suscripción: setInlineEditing(null|otro) y commitInline()
 *   vacían el pendiente sin esperar al timer.
 *
 * El montaje real de Tiptap (VersoInline.tsx) queda para la verificación en
 * navegador del orquestador.
 */
import { describe, expect, it, vi } from "vitest";
import { createEditor, type EditorHandle } from "@/lib/verso/store";
import { createBlockRegistry, makeSlotResolver, type BlockRegistry } from "@/lib/verso/registry";
import type { VersoData } from "@/lib/verso/types";
import {
    INLINE_COMMIT_THROTTLE_MS,
    createInlineMountStore,
    createInlineSession,
    inlineCoalesceKey,
    type InlineSessionDeps,
} from "../inlineSession";

function makeRegistry(): BlockRegistry {
    const registry = createBlockRegistry();
    const render = () => null;
    registry.register([
        {
            type: "Heading",
            label: "Encabezado",
            fields: { title: { type: "text" } },
            defaultProps: {},
            inline: { prop: "title", schema: "plain" },
            render,
        },
        {
            type: "Text",
            label: "Texto",
            fields: { content: { type: "textarea" } },
            defaultProps: {},
            inline: { prop: "content", schema: "rich" },
            render,
        },
        { type: "Card", label: "Tarjeta", fields: { title: { type: "text" } }, defaultProps: {}, render },
    ]);
    return registry;
}

// Raíz: [h1(Heading title:"Hola"), t1(Text content:"<p>Hola</p>"), c1(Card)]
function makeData(): VersoData {
    return {
        content: [
            { type: "Heading", props: { id: "h1", title: "Hola" } },
            { type: "Text", props: { id: "t1", content: "<p>Hola</p>" } },
            { type: "Card", props: { id: "c1", title: "Tarjeta" } },
        ],
        root: { props: {} },
    };
}

/** Reloj mutable compartido entre el store (coalescencia) y la sesión (throttle). */
function makeClock(): { now: () => number; set: (t: number) => void } {
    let t = 0;
    return { now: () => t, set: (v: number) => { t = v; } };
}

/** Scheduler manual: registra {cb, ms} y dispara bajo demanda. */
function makeScheduler() {
    let seq = 0;
    const tasks = new Map<number, { cb: () => void; ms: number }>();
    return {
        schedule: (cb: () => void, ms: number): unknown => {
            seq += 1;
            tasks.set(seq, { cb, ms });
            return seq;
        },
        cancel: (h: unknown): void => {
            tasks.delete(h as number);
        },
        /** Dispara TODAS las tareas pendientes (vaciando antes: un cb puede re-programar). */
        fire(): void {
            const list = [...tasks.values()];
            tasks.clear();
            for (const t of list) t.cb();
        },
        pending: () => [...tasks.values()],
    };
}

function setup(now?: () => number) {
    const registry = makeRegistry();
    const handle = createEditor({
        initialData: makeData(),
        isSlot: makeSlotResolver(registry),
        ...(now ? { now } : {}),
    });
    return { registry, handle };
}

describe("createInlineMountStore — par subscribe/getSnapshot", () => {
    it("snapshot null fuera del modo inline; la declaración del registry (referencia ESTABLE) dentro", () => {
        const { registry, handle } = setup();
        const store = createInlineMountStore(handle, registry, "h1");
        expect(store.getSnapshot()).toBeNull();

        handle.setInlineEditing("h1");
        const spec = store.getSnapshot();
        expect(spec).toEqual({ prop: "title", schema: "plain" });
        // Referencia estable: ES el objeto inline del registry (apto para useSyncExternalStore).
        expect(spec).toBe(registry.get("Heading")?.inline);
        expect(store.getSnapshot()).toBe(spec);

        handle.setInlineEditing(null);
        expect(store.getSnapshot()).toBeNull();
    });

    it("snapshot null para OTRO nodo activo y para un type sin declaración inline", () => {
        const { registry, handle } = setup();
        const storeH1 = createInlineMountStore(handle, registry, "h1");
        const storeC1 = createInlineMountStore(handle, registry, "c1");

        handle.setInlineEditing("t1");
        expect(storeH1.getSnapshot()).toBeNull();

        handle.setInlineEditing("c1"); // Card no declara inline
        expect(storeC1.getSnapshot()).toBeNull();
    });

    it("notifica al entrar/salir del modo inline y NUNCA por un setProps", () => {
        const { registry, handle } = setup();
        const store = createInlineMountStore(handle, registry, "h1");
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        handle.transact((tx) => tx.setProps("h1", { title: "Otro" }));
        expect(listener).not.toHaveBeenCalled();

        handle.setInlineEditing("h1");
        expect(listener).toHaveBeenCalledTimes(1);

        handle.transact((tx) => tx.setProps("h1", { title: "Más" }));
        expect(listener).toHaveBeenCalledTimes(1);

        handle.commitInline();
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });
});

describe("createInlineSession — throttle, prop, coalesceKey y sanitización", () => {
    function makeSession(
        handle: EditorHandle,
        overrides: Partial<InlineSessionDeps> & Pick<InlineSessionDeps, "nodeId" | "prop">,
    ) {
        const clock = makeClock();
        const scheduler = makeScheduler();
        const transform = overrides.transform ?? vi.fn((raw: string) => raw);
        const session = createInlineSession({
            handle,
            now: clock.now,
            schedule: scheduler.schedule,
            cancel: scheduler.cancel,
            ...overrides,
            transform,
        });
        return { session, clock, scheduler, transform };
    }

    it("primer commit inmediato (wait 0); los siguientes esperan THROTTLE-elapsed desde el último commit", () => {
        const { handle } = setup();
        handle.setInlineEditing("t1");
        const { session, clock, scheduler } = makeSession(handle, { nodeId: "t1", prop: "content" });

        session.onContent("<p>a</p>");
        expect(scheduler.pending()).toHaveLength(1);
        expect(scheduler.pending()[0].ms).toBe(0); // lastCommitAt = -Infinity → sin espera
        // Hasta que el timer dispara NO hay commit.
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>Hola</p>");
        scheduler.fire(); // commit a t=0
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>a</p>");

        clock.set(100);
        session.onContent("<p>b</p>");
        expect(scheduler.pending()).toHaveLength(1);
        // Programado para completar los 300ms desde el commit de t=0.
        expect(scheduler.pending()[0].ms).toBe(INLINE_COMMIT_THROTTLE_MS - 100);
    });

    it("varios onContent dentro de la ventana → UN timer que comitea el ÚLTIMO contenido", () => {
        const { handle } = setup();
        handle.setInlineEditing("t1");
        const { session, scheduler } = makeSession(handle, { nodeId: "t1", prop: "content" });

        session.onContent("<p>a</p>");
        session.onContent("<p>ab</p>");
        session.onContent("<p>abc</p>");
        expect(scheduler.pending()).toHaveLength(1);
        scheduler.fire();
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>abc</p>");
    });

    it("emite setProps con el PROP declarado y coalesceKey estable inline:<nodeId> en TODOS los commits", () => {
        const { handle } = setup();
        handle.setInlineEditing("h1");
        const optsSeen: Array<{ coalesceKey?: string; label?: string } | undefined> = [];
        const spyHandle = {
            ...handle,
            transact: ((fn, opts) => {
                optsSeen.push(opts);
                return handle.transact(fn, opts);
            }) as EditorHandle["transact"],
        };
        const { session, clock, scheduler } = makeSession(spyHandle as EditorHandle, {
            nodeId: "h1",
            prop: "title",
        });

        session.onContent("Uno");
        scheduler.fire();
        clock.set(1000);
        session.onContent("Dos");
        scheduler.fire();

        expect(handle.getDoc().nodes["h1"].props.title).toBe("Dos");
        expect(optsSeen).toHaveLength(2);
        expect(inlineCoalesceKey("h1")).toBe("inline:h1");
        for (const opts of optsSeen) expect(opts?.coalesceKey).toBe("inline:h1");
    });

    it("la sanitización (transform) se aplica ANTES de setProps", () => {
        const { handle } = setup();
        handle.setInlineEditing("t1");
        const transform = vi.fn((raw: string) => `sane:${raw}`);
        const { session, scheduler } = makeSession(handle, { nodeId: "t1", prop: "content", transform });

        session.onContent("<p>x<script>evil()</script></p>");
        scheduler.fire();
        expect(transform).toHaveBeenCalledWith("<p>x<script>evil()</script></p>");
        expect(handle.getDoc().nodes["t1"].props.content).toBe(
            "sane:<p>x<script>evil()</script></p>",
        );
    });

    it("contenido idéntico al último committeado NO abre transacción (sin entradas de undo vacías)", () => {
        const { handle } = setup();
        handle.setInlineEditing("t1");
        let transacts = 0;
        const spyHandle = {
            ...handle,
            transact: ((fn, opts) => {
                transacts += 1;
                return handle.transact(fn, opts);
            }) as EditorHandle["transact"],
        };
        const { session, clock, scheduler } = makeSession(spyHandle as EditorHandle, {
            nodeId: "t1",
            prop: "content",
        });

        session.onContent("<p>a</p>");
        scheduler.fire();
        clock.set(1000);
        session.onContent("<p>a</p>"); // sin cambios efectivos
        scheduler.fire();
        expect(transacts).toBe(1);
        expect(session.flush()).toBe(false); // nada pendiente
    });

    it("commits dentro de la ventana de coalescencia del store = UNA entrada de undo", () => {
        const clock = makeClock();
        const { handle } = setup(clock.now); // el store coalesce con el MISMO reloj
        handle.setInlineEditing("t1");
        const scheduler = makeScheduler();
        const session = createInlineSession({
            handle,
            nodeId: "t1",
            prop: "content",
            transform: (raw) => raw,
            now: clock.now,
            schedule: scheduler.schedule,
            cancel: scheduler.cancel,
        });

        session.onContent("<p>a</p>");
        scheduler.fire(); // commit a t=0
        clock.set(200); // dentro de VERSO_HISTORY_COALESCE_MS (250)
        session.onContent("<p>ab</p>");
        expect(session.flush()).toBe(true); // commit a t=200 → coalesce con el anterior

        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>ab</p>");
        expect(handle.undo()).toBe(true); // UNA entrada: un solo undo restaura el original
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>Hola</p>");
        expect(handle.canUndo()).toBe(false);
    });

    it("setInlineEditing(null) hace flush del pendiente SIN esperar al timer y sella la sesión", () => {
        const { handle } = setup();
        handle.setInlineEditing("t1");
        const { session, scheduler } = makeSession(handle, { nodeId: "t1", prop: "content" });

        session.onContent("<p>pendiente</p>");
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>Hola</p>");
        handle.setInlineEditing(null); // la suscripción de la sesión dispara el flush
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>pendiente</p>");
        expect(session.isDisposed()).toBe(true);
        expect(scheduler.pending()).toHaveLength(0); // timer cancelado

        session.onContent("<p>tarde</p>"); // sesión sellada: no-op
        expect(scheduler.pending()).toHaveLength(0);
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>pendiente</p>");
    });

    it("handle.commitInline() implica flush del contenido pendiente (vía suscripción)", () => {
        const { handle } = setup();
        handle.setInlineEditing("h1");
        const { session } = makeSession(handle, { nodeId: "h1", prop: "title" });

        session.onContent("Título nuevo");
        handle.commitInline();
        expect(handle.getDoc().nodes["h1"].props.title).toBe("Título nuevo");
        expect(handle.getState().inlineEditingId).toBeNull();
        expect(session.isDisposed()).toBe(true);
    });

    it("cambiar la edición a OTRO nodo también hace flush y sella la sesión del anterior", () => {
        const { handle } = setup();
        handle.setInlineEditing("t1");
        const { session } = makeSession(handle, { nodeId: "t1", prop: "content" });

        session.onContent("<p>pendiente</p>");
        handle.setInlineEditing("h1");
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>pendiente</p>");
        expect(session.isDisposed()).toBe(true);
    });

    it("end(): commit final + setInlineEditing(null); dispose() es idempotente después", () => {
        const { handle } = setup();
        handle.setInlineEditing("t1");
        const { session } = makeSession(handle, { nodeId: "t1", prop: "content" });

        session.onContent("<p>final</p>");
        session.end();
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>final</p>");
        expect(handle.getState().inlineEditingId).toBeNull();
        expect(session.isDisposed()).toBe(true);
        session.dispose(); // idempotente
        expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>final</p>");
    });

    it("nodo eliminado durante la edición: el flush es no-op (fail-soft, doc intacto)", () => {
        const { handle } = setup();
        handle.setInlineEditing("t1");
        const { session } = makeSession(handle, { nodeId: "t1", prop: "content" });

        session.onContent("<p>huérfano</p>");
        // removeNode limpia inlineEditingId → la suscripción de la sesión hace
        // flush, que detecta el nodo desaparecido y NO emite comando alguno.
        expect(handle.transact((tx) => tx.removeNode("t1"))).toBe(true);
        expect(session.isDisposed()).toBe(true);
        expect(handle.getDoc().nodes["t1"]).toBeUndefined();
        expect(session.flush()).toBe(false);
    });

    /* ------------------------------------------------------------------ */
    /* Modo colaboración (F8.4)                                            */
    /* ------------------------------------------------------------------ */

    describe("modo colaboración: throttleMs 0 + adopción de lo ajeno", () => {
        it("sin throttle, cada pulsación se comitea EN EL ACTO (sin programar nada)", () => {
            const { handle } = setup();
            handle.setInlineEditing("t1");
            const { session, scheduler } = makeSession(handle, { nodeId: "t1", prop: "content", throttleMs: 0 });

            session.onContent("<p>H</p>");
            expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>H</p>");
            session.onContent("<p>Ho</p>");
            expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>Ho</p>");
            // Nada diferido: la ventana entre "lo tecleado" y "lo que dice el documento" es la que
            // este modo existe para cerrar; un timer a 0ms la dejaría abierta.
            expect(scheduler.pending()).toHaveLength(0);
        });

        it("aun así sigue siendo UNA entrada de deshacer (la coalescencia no cambia)", () => {
            const clock = makeClock();
            const { handle } = setup(clock.now);
            handle.setInlineEditing("t1");
            const { session } = makeSession(handle, { nodeId: "t1", prop: "content", throttleMs: 0 });

            for (const v of ["<p>H</p>", "<p>Ho</p>", "<p>Hol</p>", "<p>Hola!</p>"]) session.onContent(v);
            expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>Hola!</p>");
            expect(handle.undo()).toBe(true);
            expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>Hola</p>");
            expect(handle.canUndo()).toBe(false);
        });

        it("`lastCommitted` distingue lo tuyo de lo ajeno", () => {
            const { handle } = setup();
            handle.setInlineEditing("t1");
            const { session } = makeSession(handle, { nodeId: "t1", prop: "content", throttleMs: 0 });

            expect(session.lastCommitted()).toBeNull();
            session.onContent("<p>mío</p>");
            expect(session.lastCommitted()).toBe("<p>mío</p>");
            // Escritura AJENA publicada por applyRemoteDoc: el documento ya no dice lo que yo puse.
            const doc = handle.getDoc();
            handle.applyRemoteDoc({
                ...doc,
                nodes: { ...doc.nodes, t1: { ...doc.nodes.t1, props: { ...doc.nodes.t1.props, content: "<p>ajeno</p>" } } },
            });
            expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>ajeno</p>");
            expect(session.lastCommitted()).toBe("<p>mío</p>");
        });

        it("`adopt` evita el eco: lo adoptado no se reenvía como edición propia", () => {
            const { handle } = setup();
            handle.setInlineEditing("t1");
            const { session } = makeSession(handle, { nodeId: "t1", prop: "content", throttleMs: 0 });

            session.adopt("<p>ajeno</p>");
            expect(session.lastCommitted()).toBe("<p>ajeno</p>");
            // Reofrecer EXACTAMENTE lo adoptado no abre transacción (no hay nada que contar).
            session.onContent("<p>ajeno</p>");
            expect(handle.canUndo()).toBe(false);
            // Pero seguir escribiendo encima sí, y parte de lo adoptado.
            session.onContent("<p>ajeno+</p>");
            expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>ajeno+</p>");
        });

        it("`adopt` descarta lo pendiente: comitearlo borraría justo lo que se acaba de adoptar", () => {
            const { handle } = setup();
            handle.setInlineEditing("t1");
            const { session, scheduler } = makeSession(handle, { nodeId: "t1", prop: "content" });

            session.onContent("<p>a medio escribir</p>"); // queda pendiente (throttle por defecto)
            session.adopt("<p>lo ajeno ya fusionado</p>");
            scheduler.fire();
            expect(session.flush()).toBe(false);
            expect(handle.getDoc().nodes["t1"].props.content).toBe("<p>Hola</p>");
        });
    });
});
