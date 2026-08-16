/**
 * Verso F6 (c) — edición inline con el motor de texto PROPIO (F3.5):
 * doble-click abre sesión, tecleo, selección por teclado (Shift+flechas),
 * negrita por Ctrl+B y por BubbleMenu, Escape cierra, y el undo GLOBAL
 * restaura la sesión.
 *
 * Nota de historia: los commits de la sesión coalescen por
 * `coalesceKey inline:<id>` dentro de la ventana del store (250ms) — una
 * sesión RÁPIDA es exactamente UNA entrada (segundo test); una sesión con
 * pausas humanas (>throttle 300ms entre commits) puede partir en pocas
 * entradas, por eso el primer test deshace en bucle acotado hasta el estado
 * original (y verifica que la historia quedó VACÍA — nada más que deshacer).
 */
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { openLab } from "./helpers";

const ORIGINAL_TEXT = "Raíz, tras las secciones.";
const NODE = "lab-t7";

async function openInlineSession(page: Page, frame: FrameLocator): Promise<Locator> {
    const block = frame.locator(`[data-wjs-block-id="${NODE}"]`);
    await block.dblclick();
    const host = frame.locator(`[data-wjs-inline="${NODE}"][contenteditable="true"]`);
    await expect(host).toBeVisible();
    return host;
}

/** El bubble puede vivir en el doc del iframe o portalear al padre: el que exista. */
async function bubbleIn(page: Page, frame: FrameLocator): Promise<Locator> {
    const inFrame = frame.locator("[data-wjs-inline-bubble]");
    if ((await inFrame.count()) > 0) return inFrame.first();
    return page.locator("[data-wjs-inline-bubble]").first();
}

test("inline: dblclick, tecleo, Shift+flechas, Ctrl+B, BubbleMenu, Escape y undo de la sesión", async ({ page }) => {
    const frame = await openLab(page, "30");
    const block = frame.locator(`[data-wjs-block-id="${NODE}"]`);
    await expect(block).toContainText(ORIGINAL_TEXT);

    const host = await openInlineSession(page, frame);

    // Tecleo: el caret autoenfoca al FINAL (paridad autofocus:"end").
    await page.keyboard.type(" extra");
    await expect(host).toContainText(`${ORIGINAL_TEXT} extra`);

    // Selección por teclado: Shift+ArrowLeft x5 selecciona "extra".
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");

    // Negrita por atajo (el motor la intercepta, jamás execCommand).
    await page.keyboard.press("Control+b");
    await expect(host.locator("strong")).toContainText("extra");

    // BubbleMenu sobre la selección (visible al terminar la selección):
    // Cursiva por botón — y el estado activo de Negrita reflejado (aria-pressed).
    const bubble = await bubbleIn(page, frame);
    await expect(bubble).toBeVisible();
    await expect(bubble.getByRole("button", { name: "Negrita" })).toHaveAttribute("aria-pressed", "true");
    await bubble.getByRole("button", { name: "Cursiva" }).click();
    await expect(host.locator("em")).toContainText("extra");

    // Escape: fin de sesión (flush + commit) — el host deja de ser editable y
    // el bloque muestra el contenido COMMITTEADO con sus marcas.
    await page.keyboard.press("Escape");
    await expect(frame.locator(`[data-wjs-inline="${NODE}"]`)).toHaveCount(0);
    await expect(block).toContainText(`${ORIGINAL_TEXT} extra`);
    await expect(block.locator("strong")).toContainText("extra");
    await expect(block.locator("em")).toContainText("extra");

    // Undo GLOBAL: deshacer en bucle acotado restaura la sesión entera; al
    // final la historia queda VACÍA (el lab arrancó sin entradas).
    const undoBtn = page.getByRole("button", { name: "Deshacer" });
    for (let i = 0; i < 6 && (await undoBtn.isEnabled()); i++) await undoBtn.click();
    await expect(undoBtn).toBeDisabled();
    await expect(block).toContainText(ORIGINAL_TEXT);
    await expect(block).not.toContainText("extra");
    await expect(block.locator("strong")).toHaveCount(0);
});

test("inline: una sesión rápida coalesce en UNA sola entrada de undo", async ({ page }) => {
    const frame = await openLab(page, "30");
    const block = frame.locator(`[data-wjs-block-id="${NODE}"]`);
    const undoBtn = page.getByRole("button", { name: "Deshacer" });
    await expect(undoBtn).toBeDisabled();

    const host = await openInlineSession(page, frame);
    // Todo dentro de la ventana de coalescencia del store (250ms): primer
    // commit inmediato + flush del Escape con la misma coalesceKey.
    await page.keyboard.type("XY", { delay: 5 });
    await expect(host).toContainText("XY");
    await page.keyboard.press("Escape");
    await expect(frame.locator(`[data-wjs-inline="${NODE}"]`)).toHaveCount(0);
    await expect(block).toContainText(`${ORIGINAL_TEXT}XY`);

    // UNA entrada: un solo Deshacer restaura y la historia queda vacía.
    await expect(undoBtn).toBeEnabled();
    await undoBtn.click();
    await expect(block).toContainText(ORIGINAL_TEXT);
    await expect(block).not.toContainText("XY");
    await expect(undoBtn).toBeDisabled();
});
