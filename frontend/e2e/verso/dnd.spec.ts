/**
 * Verso F6 (b) — DRAG REAL con mouse.move incremental (pointer events reales,
 * los que escucha el DnDDriver): mover un bloque raíz a un slot ANIDADO del
 * fixture determinista del lab, verificar orden y UNA sola entrada de undo.
 *
 * Fixture 30 (labFixtures.makeLabData): lab-t-top es el 2º hijo de la raíz
 * (arriba del todo — fuente y destino caben JUNTOS en el viewport, requisito
 * de un drag sin autoscroll); lab-g1 es un Grid (3 col) dentro de lab-s1 con
 * slot children data-wjs-slot="lab-g1:children" y primer hijo lab-c1.
 */
import { expect, test } from "@playwright/test";
import { centerOf, directChildIds, dragWithMouse, openLab } from "./helpers";

const SOURCE = "lab-t-top";

test("drag real: bloque raíz a slot anidado, orden verificado y UNA entrada de undo", async ({ page }) => {
    const frame = await openLab(page, "30");

    const source = frame.locator(`[data-wjs-block-id="${SOURCE}"]`);
    const firstNested = frame.locator('[data-wjs-block-id="lab-c1"]');
    await source.scrollIntoViewIfNeeded();
    await expect(source).toBeVisible();
    await expect(firstNested).toBeVisible();

    const rootBefore = await directChildIds(frame, "verso:root:content");
    const nestedBefore = await directChildIds(frame, "lab-g1:children");
    expect(rootBefore).toContain(SOURCE);
    expect(nestedBefore[0]).toBe("lab-c1");

    // El lab arranca sin historia: Deshacer deshabilitado (base del "UNA entrada").
    const undoBtn = page.getByRole("button", { name: "Deshacer" });
    await expect(undoBtn).toBeDisabled();

    // Drag: del centro del bloque fuente al BORDE SUPERIOR-IZQUIERDO de lab-c1
    // (dentro del slot anidado lab-g1:children) → índice 0 del slot.
    const from = await centerOf(source);
    const box = await firstNested.boundingBox();
    expect(box).toBeTruthy();
    const to = { x: box!.x + 8, y: box!.y + 4 };
    await dragWithMouse(page, from, to);

    // Verificación de orden: el bloque ahora vive DENTRO del slot anidado, primero.
    await expect(
        frame.locator(`[data-wjs-slot="lab-g1:children"] [data-wjs-block-id="${SOURCE}"]`),
    ).toHaveCount(1);
    const nestedAfter = await directChildIds(frame, "lab-g1:children");
    expect(nestedAfter[0]).toBe(SOURCE);
    expect(nestedAfter.slice(1)).toEqual(nestedBefore);
    const rootAfter = await directChildIds(frame, "verso:root:content");
    expect(rootAfter).toEqual(rootBefore.filter((id) => id !== SOURCE));

    // UNA entrada de undo: un solo Deshacer restaura EXACTAMENTE el estado
    // inicial y la historia queda vacía (botón deshabilitado de nuevo).
    await expect(undoBtn).toBeEnabled();
    await undoBtn.click();
    const nestedRestored = await directChildIds(frame, "lab-g1:children");
    const rootRestored = await directChildIds(frame, "verso:root:content");
    expect(nestedRestored).toEqual(nestedBefore);
    expect(rootRestored).toEqual(rootBefore);
    await expect(undoBtn).toBeDisabled();
});
