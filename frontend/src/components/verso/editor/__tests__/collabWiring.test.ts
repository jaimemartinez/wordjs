/**
 * EL CABLEADO DEL EDITOR, DE PUNTA A PUNTA (F8.4) — sin navegador.
 *
 * `VersoEditor` es un componente y la suite corre en `node` sin DOM, así que aquí no se monta: se
 * reproduce EXACTAMENTE el cableado que hace (las cuatro líneas que importan) sobre las piezas
 * reales — `createEditor` de verdad, `VersoCollabSession` de verdad, el CRDT de verdad y el
 * servidor de mentira que ya se usa para la convergencia:
 *
 *   1. salida:   store.subscribeCommands → session.sendCommand(comando efectivo)
 *   2. entrada:  session.onReady    → store.applyRemoteDoc(doc, { resetHistory: true })
 *   3. entrada:  session.onRemoteDoc → store.applyRemoteDoc(doc)
 *   4. inline:   la superficie ADOPTA el texto ajeno ya fusionado antes de seguir escribiendo
 *
 * Si este fichero pasa, lo que queda por verificar en el navegador es la piel y el caret — no la
 * corrección de la fusión.
 */

import { describe, expect, it } from "vitest";
import { createEditor, type EditorHandle } from "@/lib/verso/store";
import { VersoCollabSession } from "@/lib/verso/collab";
import { ROOT_ID, ROOT_SLOT, type SlotResolver, type VersoData } from "@/lib/verso/types";
import { FakeCollabServer, ManualTimers, settleMicrotasks } from "@/lib/verso/collab/__tests__/fakeServer";

const isSlot: SlotResolver = (_type, key) => (key === "items" ? true : undefined);
const isRichText = (type: string, key: string): boolean => type === "Text" && key === "content";

function initialData(): VersoData {
    return {
        content: [
            { type: "Text", props: { id: "t1", content: "<p>uno</p>" } },
            { type: "Heading", props: { id: "h1", title: "Hola" } },
            { type: "Text", props: { id: "t2", content: "<p>dos</p>" } },
        ],
        root: { props: { title: "Página" } },
    };
}

/**
 * Una pestaña: el store del editor + su sesión, cableados como en `VersoEditor`. `surface` imita
 * la superficie inline no controlada — guarda el texto que se está viendo y lo ADOPTA cuando el
 * documento trae uno ajeno, que es justo lo que hace `VersoInline` con `applyExternal`/`adopt`.
 */
class Tab {
    readonly handle: EditorHandle;
    readonly session: VersoCollabSession;
    /** Texto que el editable ENSEÑA por nodo (lo que la persona ve mientras escribe). */
    private readonly surface = new Map<string, string>();
    /** Último valor que ESTA pestaña comiteó por nodo (el `lastCommitted` de la sesión inline). */
    private readonly committed = new Map<string, string>();

    constructor(server: FakeCollabServer, site: string, timers: ManualTimers) {
        this.handle = createEditor({ initialData: initialData(), isSlot });
        this.session = new VersoCollabSession(
            {
                postId: 7,
                transport: server.transport(),
                siteId: site,
                isSlot,
                isRichText,
                now: () => 1_700_000_000_000,
                setTimer: timers.set,
                clearTimer: timers.clear,
            },
            {
                onReady: (doc) => {
                    this.handle.applyRemoteDoc(doc, { resetHistory: true });
                },
                onRemoteDoc: (doc) => {
                    this.handle.applyRemoteDoc(doc);
                    this.adoptForeignText();
                },
            },
        );
        // 1. Salida: los comandos EFECTIVOS del store, los tres orígenes.
        this.handle.subscribeCommands(({ commands }) => {
            for (const command of commands) this.session.sendCommand(command);
        });
        this.session.start();
    }

    /** El id interno del nodo cuyo `props.id` es `propId`. */
    nodeOf(propId: string): string {
        const doc = this.handle.getDoc();
        const key = Object.keys(doc.nodes).find((k) => doc.nodes[k].props.id === propId);
        if (!key) throw new Error(`no hay nodo con props.id "${propId}"`);
        return key;
    }

    text(propId: string): string {
        return String(this.handle.getDoc().nodes[this.nodeOf(propId)].props.content ?? "");
    }

    /** Teclea EN EL EDITABLE: transforma lo que se ve y lo comitea (throttle 0, F8.4). */
    type(propId: string, mutate: (visible: string) => string): void {
        const node = this.nodeOf(propId);
        const visible = this.surface.get(node) ?? this.text(propId);
        const next = mutate(visible);
        this.surface.set(node, next);
        this.committed.set(node, next);
        this.handle.transact((tx) => tx.setProps(node, { content: next }), {
            coalesceKey: `inline:${node}`,
            label: "Edición inline",
        });
    }

    /** Lo que la persona VE en el editable de ese nodo. */
    visible(propId: string): string {
        const node = this.nodeOf(propId);
        return this.surface.get(node) ?? this.text(propId);
    }

    /**
     * Reconciliación: para cada campo que esta pestaña esté "editando", si el documento trae un
     * valor que no comiteó ella, el editable lo adopta. Sin esto, la siguiente pulsación mandaría
     * un texto SIN las letras del otro y el diff del puente las borraría — el fallo exacto que
     * esta prueba tiene que poder detectar.
     */
    private adoptForeignText(): void {
        const doc = this.handle.getDoc();
        for (const [node, mine] of this.committed) {
            const value = doc.nodes[node]?.props.content;
            if (typeof value !== "string" || value === mine) continue;
            this.surface.set(node, value);
            this.committed.set(node, value);
        }
    }
}

/** Arranca la sala con dos pestañas ya sincronizadas. */
async function room(): Promise<{
    server: FakeCollabServer;
    timers: ManualTimers;
    A: Tab;
    B: Tab;
    sync: () => Promise<void>;
}> {
    const server = new FakeCollabServer(initialData());
    server.register({ siteId: "s_a", userId: 1, name: "Ana" });
    server.register({ siteId: "s_b", userId: 2, name: "Beto" });
    const timers = new ManualTimers();
    const A = new Tab(server, "s_a", timers);
    const B = new Tab(server, "s_b", timers);
    const sync = async (): Promise<void> => {
        for (let i = 0; i < 6; i++) {
            await timers.run();
            server.drain();
            await settleMicrotasks();
        }
    };
    await sync();
    return { server, timers, A, B, sync };
}

const data = (tab: Tab): string => JSON.stringify(tab.handle.getData());

describe("Cableado de colaboración del editor", () => {
    it("el documento inicial de la sala llega SIN dejar deshacer que no es tuyo", async () => {
        const { A } = await room();
        expect(A.handle.canUndo()).toBe(false);
        expect(A.text("t1")).toBe("<p>uno</p>");
    });

    it("escribir en un lado aparece en el otro", async () => {
        const { A, B, sync } = await room();
        A.type("t1", (v) => v.replace("</p>", " y medio</p>"));
        await sync();
        expect(B.text("t1")).toBe("<p>uno y medio</p>");
        expect(data(B)).toBe(data(A));
    });

    it("EDICIÓN SIMULTÁNEA en el mismo bloque: nada se pierde ni se duplica", async () => {
        const { A, B, sync } = await room();

        // Los dos escriben ANTES de que nada se entregue: concurrencia de verdad.
        A.type("t1", (v) => v.replace("</p>", "A</p>"));
        B.type("t1", (v) => v.replace("<p>", "<p>B"));
        await sync();

        expect(data(B)).toBe(data(A));
        expect(A.text("t1")).toBe("<p>BunoA</p>");
        // El párrafo base aparece UNA sola vez (el reemplazo entero lo duplicaba).
        expect(A.text("t1").split("uno")).toHaveLength(2);

        // Y siguen escribiendo: cada uno ya VE lo del otro, así que nadie borra nada.
        A.type("t1", (v) => v.replace("</p>", "!</p>"));
        B.type("t1", (v) => v.replace("<p>", "<p>¡"));
        await sync();

        expect(data(B)).toBe(data(A));
        expect(A.text("t1")).toBe("<p>¡BunoA!</p>");
    });

    it("una ráfaga larga a cuatro manos conserva TODAS las letras de los dos", async () => {
        const { A, B, sync } = await room();
        for (let i = 0; i < 8; i++) {
            A.type("t1", (v) => v.replace("</p>", `${i}</p>`));
            B.type("t1", (v) => v.replace("<p>", `<p>${i}`));
            await sync();
        }
        expect(data(B)).toBe(data(A));
        const html = A.text("t1");
        for (let i = 0; i < 8; i++) expect(html).toContain(String(i));
        expect(html).toBe("<p>76543210uno01234567</p>");
    });

    it("mover un bloque en un lado se refleja en el otro", async () => {
        const { A, B, sync } = await room();
        const t2 = A.nodeOf("t2");
        A.handle.transact((tx) => tx.moveNode(t2, ROOT_ID, ROOT_SLOT, 0), { label: "Mover" });
        await sync();
        const orden = (tab: Tab): string[] =>
            tab.handle.getDoc().rootChildren.map((id) => String(tab.handle.getDoc().nodes[id].props.id));
        expect(orden(A)).toEqual(["t2", "t1", "h1"]);
        expect(orden(B)).toEqual(["t2", "t1", "h1"]);
    });

    it("insertar y borrar bloques viaja igual que el resto", async () => {
        const { A, B, sync } = await room();
        A.handle.transact(
            (tx) => tx.insertNode({ type: "Heading", props: { id: "nuevo", title: "Nuevo" } }, ROOT_ID, ROOT_SLOT, 1),
            { label: "Insertar" },
        );
        await sync();
        expect(B.handle.getDoc().rootChildren).toHaveLength(4);

        B.handle.transact((tx) => tx.removeNode(B.nodeOf("h1")), { label: "Borrar" });
        await sync();
        expect(A.handle.getDoc().rootChildren).toHaveLength(3);
        expect(data(B)).toBe(data(A));
    });

    it("DESHACER también es una edición: el otro lo ve", async () => {
        const { A, B, sync } = await room();
        A.handle.transact((tx) => tx.setProps(A.nodeOf("h1"), { title: "Cambiado" }), { label: "Editar" });
        await sync();
        expect(B.handle.getDoc().nodes[B.nodeOf("h1")].props.title).toBe("Cambiado");

        expect(A.handle.undo()).toBe(true);
        await sync();
        expect(B.handle.getDoc().nodes[B.nodeOf("h1")].props.title).toBe("Hola");
        expect(data(B)).toBe(data(A));
    });

    it("lo que llega de fuera NO entra en tu pila de deshacer", async () => {
        const { A, B, sync } = await room();
        B.handle.transact((tx) => tx.setProps(B.nodeOf("h1"), { title: "de Beto" }), { label: "Editar" });
        await sync();
        expect(A.handle.getDoc().nodes[A.nodeOf("h1")].props.title).toBe("de Beto");
        // A no ha tocado nada: no tiene nada que deshacer (y su undo no puede revertir a Beto).
        expect(A.handle.canUndo()).toBe(false);
    });

    it("una tercera pestaña que entra tarde ve el documento ya fusionado", async () => {
        const { server, timers, A, B, sync } = await room();
        A.type("t1", (v) => v.replace("</p>", "A</p>"));
        B.type("t1", (v) => v.replace("<p>", "<p>B"));
        await sync();

        server.register({ siteId: "s_c", userId: 3, name: "Caro" });
        const C = new Tab(server, "s_c", timers);
        await sync();

        expect(data(C)).toBe(data(A));
        expect(C.text("t1")).toBe("<p>BunoA</p>");
    });

    it("el orden de entrega no cambia el resultado (entrega barajada)", async () => {
        const server = new FakeCollabServer(initialData());
        server.register({ siteId: "s_a", userId: 1, name: "Ana" });
        server.register({ siteId: "s_b", userId: 2, name: "Beto" });
        const timers = new ManualTimers();
        const A = new Tab(server, "s_a", timers);
        const B = new Tab(server, "s_b", timers);
        const shuffled = async (): Promise<void> => {
            for (let i = 0; i < 6; i++) {
                await timers.run();
                server.drain((items) => [...items].reverse());
                await settleMicrotasks();
            }
        };
        await shuffled();

        A.type("t1", (v) => v.replace("</p>", "A</p>"));
        B.type("t1", (v) => v.replace("<p>", "<p>B"));
        A.handle.transact((tx) => tx.setProps(A.nodeOf("h1"), { title: "T" }), { label: "x" });
        await shuffled();

        expect(data(B)).toBe(data(A));
    });

    it("sin tocar nada, el documento serializado es IDÉNTICO al de partida (byte a byte)", async () => {
        const { A, B } = await room();
        const original = JSON.stringify(initialData());
        expect(data(A)).toBe(original);
        expect(data(B)).toBe(original);
    });
});
