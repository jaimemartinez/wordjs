/**
 * GATE F2 — store del editor Verso: transacciones, historia, coalescencia y
 * suscripción por nodo.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createEditor,
  VERSO_COALESCE_MAX_COMMANDS,
  VERSO_HISTORY_COALESCE_MS,
  VERSO_HISTORY_LIMIT,
  type CreateEditorOptions,
} from "../store";
import { VersoCommandError } from "../commands";
import { ROOT_ID, ROOT_SLOT, type VersoData } from "../types";
import { item } from "./helpers";

const baseData = (): VersoData => ({
  content: [
    item("Heading", "h1", { title: "Hola" }),
    { type: "Section", props: { id: "s1", items: [item("Text", "t1", { content: "a" })] } },
    item("Text", "t2", { content: "b" }),
  ],
  root: { props: { title: "Página", _wjs_template: "" } },
});

const makeEditor = (over: Partial<CreateEditorOptions> = {}) =>
  createEditor({ initialData: baseData(), ...over });

describe("verso store — básicos", () => {
  it("getData() serializa el estado inicial exacto", () => {
    const ed = makeEditor();
    expect(ed.getData()).toEqual(baseData());
  });

  it("una transacción con varios comandos = UNA entrada de historia y UNA llamada onChange", () => {
    const onChange = vi.fn();
    const ed = makeEditor({ onChange });
    const ok = ed.transact((tx) => {
      tx.setProps("h1", { title: "X" });
      tx.setProps("t2", { content: "Y" });
      tx.moveNode("t2", ROOT_ID, ROOT_SLOT, 0);
    });
    expect(ok).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(ed.getData());
    ed.undo();
    expect(ed.getData()).toEqual(baseData());
    expect(ed.canUndo()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2); // undo también dispara onChange
  });

  it("transacción vacía: true, sin historia, sin onChange", () => {
    const onChange = vi.fn();
    const ed = makeEditor({ onChange });
    expect(ed.transact(() => undefined)).toBe(true);
    expect(ed.canUndo()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("pegar 20 bloques en una transacción = 1 undo que los quita todos", () => {
    const ed = makeEditor();
    ed.transact((tx) => {
      for (let i = 0; i < 20; i++) {
        tx.insertNode(item("Text", `pega-${i}`, { content: `p${i}` }), ROOT_ID, ROOT_SLOT, i);
      }
    });
    expect((ed.getData().content ?? []).length).toBe(23);
    expect(ed.canUndo()).toBe(true);
    ed.undo();
    expect(ed.getData()).toEqual(baseData());
    expect(ed.canRedo()).toBe(true);
    ed.redo();
    expect((ed.getData().content ?? []).length).toBe(23);
  });
});

describe("verso store — onChange contenido (fix 5)", () => {
  it("un onChange que lanza NO revierte la transacción: transact=true, doc cambiado, suscriptores notificados", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const onChange = vi.fn(() => {
        throw new Error("boom-onChange");
      });
      const ed = makeEditor({ onChange });
      const listener = vi.fn();
      ed.subscribe(listener);
      const ok = ed.transact((tx) => tx.setProps("h1", { title: "X" }));
      expect(ok).toBe(true); // la excepción de onChange no se propaga ni cambia el boolean
      expect((ed.getData().content ?? [])[0].props.title).toBe("X"); // el commit se mantiene
      expect(listener).toHaveBeenCalledTimes(1); // los suscriptores SÍ fueron notificados
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
      // undo/redo también devuelven su boolean con normalidad aunque onChange siga lanzando:
      expect(ed.undo()).toBe(true);
      expect((ed.getData().content ?? [])[0].props.title).toBe("Hola");
      expect(ed.redo()).toBe(true);
      expect((ed.getData().content ?? [])[0].props.title).toBe("X");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("verso store — sellado de la transacción (fix 6)", () => {
  it("usar tx tras salir de transact (continuación async) lanza transaction-sealed; la historia solo guarda lo síncrono", async () => {
    const ed = makeEditor();
    let after!: Promise<void>;
    const ok = ed.transact((tx) => {
      after = (async () => {
        tx.setProps("h1", { title: "síncrono" }); // parte síncrona: entra en la transacción
        await Promise.resolve(); // a partir de aquí transact ya retornó y selló
        let err: unknown;
        try {
          tx.setProps("h1", { title: "tarde" });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(VersoCommandError);
        expect((err as VersoCommandError).code).toBe("transaction-sealed");
      })();
    });
    expect(ok).toBe(true);
    await after;
    // El intento sellado no tocó doc ni historia:
    expect((ed.getData().content ?? [])[0].props.title).toBe("síncrono");
    // La entrada quedó con SOLO el primer comando y su inverso simétrico:
    expect(ed.undo()).toBe(true);
    expect((ed.getData().content ?? [])[0].props.title).toBe("Hola");
    expect(ed.canUndo()).toBe(false);
    expect(ed.redo()).toBe(true);
    expect((ed.getData().content ?? [])[0].props.title).toBe("síncrono");
  });

  it("el sellado también aplica tras un rollback (fn lanzó)", async () => {
    const ed = makeEditor();
    let after!: Promise<void>;
    const ok = ed.transact((tx) => {
      after = (async () => {
        await Promise.resolve();
        expect(() => tx.setProps("h1", { title: "post-rollback" })).toThrow(VersoCommandError);
      })();
      throw new Error("boom");
    });
    expect(ok).toBe(false);
    await after;
    expect(ed.getData()).toEqual(baseData());
  });
});

describe("verso store — límites de historia (fix 8)", () => {
  it(`cap de historia: ${VERSO_HISTORY_LIMIT + 5} transacciones → ${VERSO_HISTORY_LIMIT} entradas, las más nuevas`, () => {
    const ed = makeEditor();
    const total = VERSO_HISTORY_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      ed.transact((tx) => tx.setProps("h1", { title: `v${i}` }));
    }
    let undos = 0;
    while (ed.undo()) undos += 1;
    expect(undos).toBe(VERSO_HISTORY_LIMIT); // las 5 más viejas fueron descartadas
    // Tras agotar el undo, el doc queda en el estado POSTERIOR a la entrada descartada más nueva:
    expect((ed.getData().content ?? [])[0].props.title).toBe(`v${total - VERSO_HISTORY_LIMIT - 1}`);
    expect(ed.canUndo()).toBe(false);
  });

  it("cap de coalescencia: una entrada deja de fundir al llegar a VERSO_COALESCE_MAX_COMMANDS", () => {
    const ed = makeEditor({ now: () => 0 }); // reloj constante: siempre dentro de la ventana
    const total = VERSO_COALESCE_MAX_COMMANDS + 1;
    for (let i = 1; i <= total; i++) {
      ed.transact((tx) => tx.setProps("h1", { title: `t${i}` }), { coalesceKey: "typing:h1" });
    }
    // Entrada 1 = comandos 1..MAX (fundidos); entrada 2 = el comando MAX+1.
    expect(ed.undo()).toBe(true);
    expect((ed.getData().content ?? [])[0].props.title).toBe(`t${VERSO_COALESCE_MAX_COMMANDS}`);
    expect(ed.undo()).toBe(true);
    expect((ed.getData().content ?? [])[0].props.title).toBe("Hola");
    expect(ed.canUndo()).toBe(false);
  });
});

describe("verso store — rollback", () => {
  it("si fn lanza a mitad, transact devuelve false y el doc queda EXACTO (misma referencia)", () => {
    const onChange = vi.fn();
    const ed = makeEditor({ onChange });
    const before = ed.getDoc();
    const beforeData = ed.getData();
    const ok = ed.transact((tx) => {
      tx.insertNode(item("Text", "x1"), ROOT_ID, ROOT_SLOT, 0);
      tx.removeNode("t2");
      tx.setProps("h1", { title: "mutado" });
      throw new Error("boom");
    });
    expect(ok).toBe(false);
    expect(ed.getDoc()).toBe(before); // referencia intacta: nada se publicó
    expect(ed.getData()).toEqual(beforeData);
    expect(ed.canUndo()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("un comando inválido dentro de la transacción también hace rollback total", () => {
    const ed = makeEditor();
    const before = ed.getData();
    const ok = ed.transact((tx) => {
      tx.setProps("h1", { title: "casi" });
      tx.removeNode("no-existe"); // VersoCommandError → rollback
    });
    expect(ok).toBe(false);
    expect(ed.getData()).toEqual(before);
    expect(ed.canUndo()).toBe(false);
  });
});

describe("verso store — coalescencia (reloj inyectado)", () => {
  it("transacciones consecutivas con el mismo coalesceKey dentro de la ventana se funden en UNA entrada", () => {
    let t = 0;
    const ed = makeEditor({ now: () => t });
    ed.transact((tx) => tx.setProps("h1", { title: "a" }), { coalesceKey: "typing:h1" });
    t = 100;
    ed.transact((tx) => tx.setProps("h1", { title: "ab" }), { coalesceKey: "typing:h1" });
    t = 100 + VERSO_HISTORY_COALESCE_MS; // justo en el borde: aún coalesce
    ed.transact((tx) => tx.setProps("h1", { title: "abc" }), { coalesceKey: "typing:h1" });
    ed.undo();
    expect((ed.getData().content ?? [])[0].props.title).toBe("Hola");
    expect(ed.canUndo()).toBe(false); // era UNA sola entrada
    ed.redo();
    expect((ed.getData().content ?? [])[0].props.title).toBe("abc");
  });

  it("fuera de la ventana (o con otra clave, o sin clave) NO coalesce", () => {
    let t = 0;
    const ed = makeEditor({ now: () => t });
    ed.transact((tx) => tx.setProps("h1", { title: "a" }), { coalesceKey: "k" });
    t = VERSO_HISTORY_COALESCE_MS + 1;
    ed.transact((tx) => tx.setProps("h1", { title: "b" }), { coalesceKey: "k" });
    t += 10;
    ed.transact((tx) => tx.setProps("h1", { title: "c" }), { coalesceKey: "otra" });
    t += 10;
    ed.transact((tx) => tx.setProps("h1", { title: "d" }));
    ed.undo();
    ed.undo();
    ed.undo();
    expect((ed.getData().content ?? [])[0].props.title).toBe("a");
    expect(ed.canUndo()).toBe(true); // quedan la primera entrada
  });

  it("undo/redo cortan la coalescencia aunque la ventana siga abierta", () => {
    let t = 0;
    const ed = makeEditor({ now: () => t });
    ed.transact((tx) => tx.setProps("h1", { title: "a" }), { coalesceKey: "k" });
    ed.undo();
    ed.redo();
    t = 50; // dentro de la ventana respecto a la entrada original
    ed.transact((tx) => tx.setProps("h1", { title: "b" }), { coalesceKey: "k" });
    ed.undo();
    expect((ed.getData().content ?? [])[0].props.title).toBe("a"); // NO se fundió
    expect(ed.canUndo()).toBe(true);
  });
});

describe("verso store — undo/redo", () => {
  it("redo se invalida con cada transacción nueva", () => {
    const ed = makeEditor();
    ed.transact((tx) => tx.setProps("h1", { title: "A" }));
    ed.undo();
    expect(ed.canRedo()).toBe(true);
    ed.transact((tx) => tx.setProps("h1", { title: "B" }));
    expect(ed.canRedo()).toBe(false);
    expect(ed.redo()).toBe(false);
  });

  it("secuencia profunda: N transacciones, N undos vuelven al origen, N redos al final", () => {
    const ed = makeEditor();
    for (let i = 0; i < 10; i++) {
      ed.transact((tx) => tx.insertNode(item("Text", `n${i}`), ROOT_ID, ROOT_SLOT, 0));
    }
    const final = ed.getData();
    for (let i = 0; i < 10; i++) ed.undo();
    expect(ed.getData()).toEqual(baseData());
    expect(ed.canUndo()).toBe(false);
    for (let i = 0; i < 10; i++) ed.redo();
    expect(ed.getData()).toEqual(final);
  });

  it("undo limpia una selección que apunta a un nodo desaparecido", () => {
    const ed = makeEditor();
    ed.transact((tx) => tx.insertNode(item("Text", "sel"), ROOT_ID, ROOT_SLOT, 0));
    ed.select("sel");
    expect(ed.getState().selection.nodeId).toBe("sel");
    ed.undo();
    expect(ed.getState().selection.nodeId).toBe(null);
  });
});

describe("verso store — replaceData", () => {
  it("es UNA entrada de historia: un solo undo restaura el documento anterior completo", () => {
    const onChange = vi.fn();
    const ed = makeEditor({ onChange });
    const next: VersoData = { content: [item("Hero", "hero1", { title: "Nuevo" })], root: { props: { title: "Plantilla" } } };
    expect(ed.replaceData(next)).toBe(true);
    expect(ed.getData()).toEqual(next);
    expect(onChange).toHaveBeenCalledTimes(1);
    ed.undo();
    expect(ed.getData()).toEqual(baseData());
    ed.redo();
    expect(ed.getData()).toEqual(next);
  });
});

describe("verso store — suscripción", () => {
  it("subscribeNode notifica SOLO al nodo tocado (contadores)", () => {
    const ed = makeEditor();
    const calls = { h1: 0, t1: 0, t2: 0 };
    ed.subscribeNode("h1", () => void (calls.h1 += 1));
    ed.subscribeNode("t1", () => void (calls.t1 += 1));
    ed.subscribeNode("t2", () => void (calls.t2 += 1));
    ed.transact((tx) => tx.setProps("t1", { content: "x" }));
    expect(calls).toEqual({ h1: 0, t1: 1, t2: 0 });
    ed.transact((tx) => tx.setProps("h1", { title: "y" }));
    expect(calls).toEqual({ h1: 1, t1: 1, t2: 0 });
    // selección/preview NO notifican a los nodos:
    ed.select("t2");
    ed.setDragPreview({ source: { kind: "new", type: "Text" }, targetParentId: ROOT_ID, targetSlotKey: ROOT_SLOT, targetIndex: 0 });
    expect(calls).toEqual({ h1: 1, t1: 1, t2: 0 });
  });

  it("subscribeNode notifica con undefined cuando el nodo desaparece", () => {
    const ed = makeEditor();
    const seen: Array<unknown> = [];
    ed.subscribeNode("t2", (node) => seen.push(node));
    ed.transact((tx) => tx.removeNode("t2"));
    expect(seen).toEqual([undefined]);
    ed.undo();
    expect(seen.length).toBe(2);
    expect((seen[1] as { id: string }).id).toBe("t2");
  });

  it("subscribe con selector solo notifica cuando la slice cambia por Object.is", () => {
    const ed = makeEditor();
    const slices: Array<string | null> = [];
    ed.subscribe<string | null>((s) => slices.push(s), (state) => state.selection.nodeId);
    ed.transact((tx) => tx.setProps("h1", { title: "z" })); // doc cambia, selección no
    expect(slices).toEqual([]);
    ed.select("h1");
    ed.select("h1"); // repetido: no notifica
    expect(slices).toEqual(["h1"]);
    ed.select(null);
    expect(slices).toEqual(["h1", null]);
  });

  it("subscribe sin selector recibe cada cambio de estado; unsubscribe corta", () => {
    const ed = makeEditor();
    const listener = vi.fn();
    const unsub = ed.subscribe(listener);
    ed.transact((tx) => tx.setProps("h1", { title: "1" }));
    ed.select("h1");
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    ed.transact((tx) => tx.setProps("h1", { title: "2" }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("verso store — estado UI fuera del doc y de la historia", () => {
  it("select/setInlineEditing/setDragPreview no tocan doc ni historia", () => {
    const ed = makeEditor();
    const doc = ed.getDoc();
    ed.select("h1");
    ed.setInlineEditing("h1");
    ed.setDragPreview({ source: { kind: "existing", nodeId: "t2" }, targetParentId: "s1", targetSlotKey: "items", targetIndex: 1 });
    expect(ed.getDoc()).toBe(doc);
    expect(ed.canUndo()).toBe(false);
    const st = ed.getState();
    expect(st.selection.nodeId).toBe("h1");
    expect(st.inlineEditingId).toBe("h1");
    expect(st.dragPreview?.targetParentId).toBe("s1");
  });

  it("commitInline cierra el modo inline sin tocar el doc", () => {
    const ed = makeEditor();
    ed.setInlineEditing("t1");
    expect(ed.getState().inlineEditingId).toBe("t1");
    const doc = ed.getDoc();
    ed.commitInline();
    expect(ed.getState().inlineEditingId).toBe(null);
    expect(ed.getDoc()).toBe(doc);
    expect(ed.canUndo()).toBe(false);
  });

  it("select de un id inexistente equivale a null", () => {
    const ed = makeEditor();
    ed.select("fantasma");
    expect(ed.getState().selection.nodeId).toBe(null);
  });
});

describe("verso store — generateId y destroy", () => {
  it("duplicateSubtree usa el generateId inyectado", () => {
    let n = 0;
    const ed = makeEditor({ generateId: () => `gen-${++n}` });
    ed.transact((tx) => tx.duplicateSubtree("h1"));
    const content = ed.getData().content ?? [];
    expect(content[1].props.id).toBe("gen-1");
    expect(content[1].type).toBe("Heading");
    ed.undo();
    expect(ed.getData()).toEqual(baseData());
  });

  it("transact reentrante lanza", () => {
    const ed = makeEditor();
    const ok = ed.transact(() => {
      expect(() => ed.transact(() => undefined)).toThrow(/reentrante/);
    });
    expect(ok).toBe(true);
  });

  it("destroy: transact devuelve false y los listeners no vuelven a dispararse", () => {
    const onChange = vi.fn();
    const ed = makeEditor({ onChange });
    const listener = vi.fn();
    ed.subscribe(listener);
    ed.destroy();
    expect(ed.transact((tx) => tx.setProps("h1", { title: "no" }))).toBe(false);
    expect(ed.undo()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
