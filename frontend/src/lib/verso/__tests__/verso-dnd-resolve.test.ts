/**
 * GATE F2 — resolutor DnD puro contra el fixture ejecutable.
 *
 * Carga los 48 casos de `__fixtures__/dnd-cases.json` (contrato derivado del
 * comportamiento observable del fork @wordjs/puck, ver
 * documentation/verso/dnd-spec.md) y ejecuta cada uno como table-driven test:
 * `resolveDragTarget(entrada geométrica)` debe producir exactamente
 * `expected.{slotId,index}` — incluidos los `{null,null}` de "no actualizar el
 * preview este tick" (F-4, F-9, guardas §3.5).
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import fixtureJson from "../__fixtures__/dnd-cases.json";
import { resolveDragTarget } from "../dnd/resolve";
import type { DndPoint, DragGeom, DragTarget, ZoneGeom } from "../dnd/types";

interface FixtureCase {
  name: string;
  category: string;
  layout: ZoneGeom;
  pointer: DndPoint;
  dragging: DragGeom;
  hitOrder?: string[];
  pointerOverDrawer?: boolean;
  expected: DragTarget;
  rationale: string;
}

// resolveJsonModule infiere literales anchos (string en vez de uniones): el cast
// via unknown re-tipa el fixture al contrato de dnd/types.ts.
const cases = (fixtureJson as unknown as { cases: FixtureCase[] }).cases;

describe("verso dnd — resolutor puro vs fixture", () => {
  it("el fixture contiene exactamente los 48 casos del contrato", () => {
    expect(cases).toHaveLength(48);
    // Nombres únicos: un duplicado enmascararía un caso perdido en it.each.
    expect(new Set(cases.map((c) => c.name)).size).toBe(48);
  });

  it.each(cases.map((c) => [`${c.category} › ${c.name}`, c] as const))(
    "%s",
    (_label, c) => {
      const result = resolveDragTarget({
        layout: c.layout,
        pointer: c.pointer,
        dragging: c.dragging,
        hitOrder: c.hitOrder,
        pointerOverDrawer: c.pointerOverDrawer,
      });
      expect(result, c.rationale).toEqual(c.expected);
    },
  );
});

/* ------------------------------------------------------------------ */
/* Un contenedor VACÍO tiene que poder llenarse                        */
/* ------------------------------------------------------------------ */

/**
 * El defecto que esto cierra se midió en el editor real: una sección recién creada era un AGUJERO
 * NEGRO para el arrastre — se soltaba un bloque encima y no pasaba nada, sin error ni pista.
 *
 * La causa era geométrica y estaba a un paso del resolutor: el slot de un contenedor sin hijos se
 * pintaba como un `div` sin contenido, o sea de altura CERO, y el hit-test contrae además cada
 * candidato 6px por lado. Un rectángulo de altura cero no puede contener a un puntero JAMÁS. Y el
 * relleno del contenedor tampoco sirve de refugio: sobre el chrome de un componente con una zona
 * activa, el resolutor devuelve "sin destino" a propósito (regla F-9, réplica fiel del fork, con su
 * propio caso en el fixture).
 *
 * Por eso el lienzo del editor pinta un área de suelta en todo slot vacío (`data-verso-empty-slot`,
 * VersoSlot). Lo que se fija aquí es la ARITMÉTICA que lo obliga: con altura, la zona acepta; sin
 * altura, es inalcanzable por construcción.
 */
describe("una zona vacía solo recibe si TIENE altura", () => {
  const rect = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b });

  const pageWith = (slotRect: ReturnType<typeof rect>) =>
    ({
      id: "root:default-zone",
      kind: "zone",
      areaId: "root",
      depth: 0,
      direction: "column",
      dir: "ltr",
      accepts: null,
      rect: rect(89, 128, 1181, 928),
      items: [
        {
          id: "s1",
          kind: "component",
          componentType: "Section",
          depth: 1,
          rect: rect(89, 128, 1181, 928),
          zones: [
            {
              id: "s1:children",
              kind: "zone",
              areaId: "s1",
              depth: 2,
              direction: "column",
              dir: "ltr",
              accepts: null,
              rect: slotRect,
              items: [],
            },
          ],
        },
      ],
    }) as unknown as Parameters<typeof resolveDragTarget>[0]["layout"];

  const dropAt = (layout: Parameters<typeof resolveDragTarget>[0]["layout"], x: number, y: number) =>
    resolveDragTarget({
      layout,
      pointer: { x, y },
      dragging: {
        type: "new",
        sourceId: null,
        componentType: "Button",
        rect: rect(x - 100, y - 24, x + 100, y + 24),
        direction: null,
        fallbackEnabled: true,
      },
    });

  it("con el área de suelta (48px) el bloque entra en el contenedor, en el índice 0", () => {
    const layout = pageWith(rect(113, 528, 1157, 576));
    expect(dropAt(layout, 635, 552)).toEqual({ slotId: "s1:children", index: 0 });
  });

  it("con altura CERO no hay dónde soltar — y el relleno del contenedor tampoco vale (F-9)", () => {
    const layout = pageWith(rect(113, 528, 1157, 528));
    expect(dropAt(layout, 635, 528)).toEqual({ slotId: null, index: null }); // sobre la línea
    expect(dropAt(layout, 635, 300)).toEqual({ slotId: null, index: null }); // sobre el relleno
    expect(dropAt(layout, 635, 800)).toEqual({ slotId: null, index: null }); // relleno de abajo
  });

  it("y por qué 48px y no «lo mínimo»: el hit-test se come 6px por lado", () => {
    // Con 11px de banda no queda NADA vivo (11 − 12 < 0): inalcanzable.
    expect(dropAt(pageWith(rect(113, 528, 1157, 539)), 635, 533)).toEqual({ slotId: null, index: null });
    // Con 12px queda exactamente UNA línea: acertar ahí con el ratón es cuestión de suerte.
    expect(dropAt(pageWith(rect(113, 528, 1157, 540)), 635, 534)).toEqual({ slotId: "s1:children", index: 0 });
    expect(dropAt(pageWith(rect(113, 528, 1157, 540)), 635, 536)).toEqual({ slotId: null, index: null });
    // Los 48px que pinta el lienzo dejan ±18px de holgura, que es lo que hace el gesto humano.
    const real = pageWith(rect(113, 528, 1157, 576));
    for (const y of [535, 552, 569]) {
      expect(dropAt(real, 635, y), `y=${y}`).toEqual({ slotId: "s1:children", index: 0 });
    }
  });
});

/** El lienzo TIENE que pintar esa área: la aritmética de arriba no sirve sin ella. */
describe("el lienzo del editor pinta el área de suelta de un slot vacío", () => {
  it("VersoSlot renderiza `data-verso-empty-slot` cuando no hay entradas", () => {
    const src = readFileSync(
      resolvePath(process.cwd(), "src/components/verso/render/VersoSlot.tsx"),
      "utf-8",
    );
    expect(src).toContain("data-verso-empty-slot");
    expect(src).toMatch(/entries\.length === 0/);
    // Con altura suficiente para sobrevivir a la contracción de 6px por lado.
    expect(src).toMatch(/min-h-12/);
  });
});
