/**
 * C5 — «dónde se mueve mi sitio»: el inventario del movimiento.
 *
 * Lo que se fija aquí es que el inventario cuenta lo que la página EMITE (no lo que el autor
 * escribió), porque es la única cifra sobre la que se puede actuar: dos bloques con la misma
 * interacción son un solo trozo de CSS, y un bloque cuya spec no compila no mueve nada.
 */
import { describe, expect, it } from "vitest";
import { ixInventoryOf, type IxInventoryEntry } from "../inventory";
import { SYS_IX_PRESETS } from "../presets";

const spec = (over: Record<string, unknown> = {}) => ({
  v: 1,
  trigger: { on: "view", once: false },
  tracks: [
    {
      target: { kind: "self" },
      steps: [{ at: 0, set: { opacity: 0 } }, { at: 100, set: { opacity: 1 } }],
      ...over,
    },
  ],
});

const doc = (...specs: unknown[]) => ({
  root: { props: {} },
  content: specs.map((ix, i) => ({ type: "Heading", props: { id: `h${i}`, ix } })),
});

const entry = (id: number, title: string, data: unknown): IxInventoryEntry => ({
  id,
  title,
  slug: `p${id}`,
  type: "page",
  data,
});

describe("inventario del movimiento", () => {
  it("cuenta bloques y unidades por separado: dos bloques iguales son UN trozo de CSS", () => {
    const inv = ixInventoryOf([entry(1, "Home", doc(spec(), spec()))]);
    expect(inv.rows[0].blocks).toBe(2);
    expect(inv.rows[0].units).toBe(1);
  });

  it("las páginas QUIETAS no salen en la lista (y sí en el total de páginas miradas)", () => {
    const inv = ixInventoryOf([
      entry(1, "Quieta", doc()),
      entry(2, "Con movimiento", doc(spec())),
      entry(3, "Sin puck", null),
    ]);
    expect(inv.rows.map((r) => r.id)).toEqual([2]);
    expect(inv.totals.pages).toBe(3);
    expect(inv.totals.moving).toBe(1);
  });

  it("señala lo perpetuo y lo que baja JavaScript — que es sobre lo que se actúa", () => {
    const inv = ixInventoryOf([
      entry(1, "Bucles", doc(spec({ repeat: "inf" }))),
      entry(2, "Con clic", doc({ v: 1, trigger: { on: "click" }, tracks: spec().tracks })),
    ]);
    const bucles = inv.rows.find((r) => r.id === 1)!;
    const clic = inv.rows.find((r) => r.id === 2)!;
    expect(bucles.infinite).toBe(1);
    expect(clic.infinite).toBe(0);
    expect(clic.runtime).toBe(1); // el clic no es expresable en CSS: isla de eventos
    // Y el orden pone delante lo perpetuo, que es lo primero que hay que revisar.
    expect(inv.rows[0].id).toBe(1);
  });

  it("lista los preajustes usados, sin repetir y en orden", () => {
    const inv = ixInventoryOf(
      [entry(1, "Con presets", doc({ v: 1, preset: "sys:tilt" }, { v: 1, preset: "sys:tilt" }, { v: 1, preset: "sys:parallax-puntero" }))],
      { presets: SYS_IX_PRESETS },
    );
    expect(inv.rows[0].presets).toEqual(["sys:parallax-puntero", "sys:tilt"]);
  });

  it("un preajuste que YA NO EXISTE deja la página sin movimiento — y así sale en el inventario", () => {
    // Es lo que de verdad pasa al borrar un preajuste: el bloque se sigue viendo y deja de moverse.
    const inv = ixInventoryOf([entry(1, "Roto", doc({ v: 1, preset: "sys:no-existe" }))], {
      presets: SYS_IX_PRESETS,
    });
    expect(inv.rows).toHaveLength(0);
  });

  it("la política del sitio se refleja en el inventario: con el movimiento apagado, no hay filas", () => {
    const entries = [entry(1, "Bucles", doc(spec({ repeat: "inf" })))];
    expect(ixInventoryOf(entries).rows).toHaveLength(1);
    expect(ixInventoryOf(entries, { motion: "off" }).rows).toHaveLength(0);
    // Y en modo tranquilo la página sigue moviéndose, pero ya no perpetuamente.
    expect(ixInventoryOf(entries, { motion: "calm" }).rows[0].infinite).toBe(0);
  });

  it("dato hostil: contenidos rotos no rompen el recuento", () => {
    const inv = ixInventoryOf([
      entry(1, "Basura", { content: "no soy un array" }),
      entry(2, "Spec inválida", doc({ v: 99, tracks: "nope" })),
      entry(3, "Buena", doc(spec())),
    ]);
    expect(inv.rows.map((r) => r.id)).toEqual([3]);
  });
});
