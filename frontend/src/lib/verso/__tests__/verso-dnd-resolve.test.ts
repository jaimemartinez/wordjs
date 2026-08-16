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
