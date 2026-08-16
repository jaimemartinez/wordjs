/**
 * Verso F6 (d) — flujo COMPLETO solo-teclado (el gate a11y de F2):
 * insertar (⌘K), mover (M + flechas, con anuncio en el live region), editar
 * props (navegación por Tab hasta el panel) y guardar (Ctrl+S) — SIN UN SOLO
 * CLICK en todo el spec.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { canvas, directChildIds, prepPage, ROOT_SLOT_SELECTOR } from "./helpers";

/**
 * Shift+Tab en bucle acotado hasta enfocar un input/textarea cuyo <label>
 * asociado matchee `labelRe`. El panel de propiedades es lo ÚLTIMO del orden
 * del DOM, así que navegar hacia atrás desde el body llega en pocos saltos
 * (hacia delante habría que atravesar header, rail, paleta y canvas).
 */
async function shiftTabToField(page: Page, labelRe: RegExp, cap = 40): Promise<void> {
    for (let i = 0; i < cap; i++) {
        await page.keyboard.press("Shift+Tab");
        const label = await page.evaluate(() => {
            const el = document.activeElement;
            if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return null;
            if (!el.id) return null;
            const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            return l?.textContent?.trim() ?? null;
        });
        if (label && labelRe.test(label)) return;
    }
    throw new Error(`no se alcanzó por teclado un campo con label ${labelRe}`);
}

/**
 * Match EXACTO del label del campo de título ("title" crudo en el bloque,
 * "Title"/"Título" en los campos root según idioma). Un regex laxo matcheaba
 * "Color del título (vacío = tema)" — el campo de estilo del Heading — y el
 * tecleo acababa en el color (cazado en la primera corrida del spec).
 */
const TITLE_LABEL = /^(t[ií]tulo|title)$/i;

/** Inserta un bloque vía ⌘K (la búsqueda matchea por NOMBRE de tipo, estable entre idiomas). */
async function insertViaPalette(page: Page, type: string): Promise<void> {
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // El foco llega al combobox 20ms tras abrir (deja pintar el portal):
    // teclear antes escribiría en el body y el Enter no llegaría al diálogo.
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.keyboard.type(type);
    await expect(dialog.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
}

test("keyboard-only: insertar, mover, editar y guardar sin un solo click", async ({ page }) => {
    await prepPage(page);
    await page.goto("/admin/pages/new");
    const frame = canvas(page);
    await expect(frame.locator(ROOT_SLOT_SELECTOR)).toBeAttached({ timeout: 60_000 });
    const stamp = Date.now().toString(36);

    // --- INSERTAR: dos Heading vía ⌘K (funciona desde cualquier foco) -------
    await insertViaPalette(page, "Heading");
    await expect(frame.locator("[data-wjs-block-id]")).toHaveCount(1);
    await insertViaPalette(page, "Heading");
    await expect(frame.locator("[data-wjs-block-id]")).toHaveCount(2);
    const before = await directChildIds(frame, "verso:root:content");
    expect(before).toHaveLength(2);

    // --- MOVER: el 2º insertado queda seleccionado → M + ArrowUp + Escape ---
    await page.keyboard.press("m");
    const live = page.locator("[data-wjs-dnd-live]");
    await expect(live).toContainText(/modo mover/i);
    await page.keyboard.press("ArrowUp");
    const after = await directChildIds(frame, "verso:root:content");
    expect(after).toEqual([before[1], before[0]]);
    await expect(live).not.toHaveText(/^\s*$/); // el movimiento se ANUNCIA (live region)
    await page.keyboard.press("Escape");

    // --- EDITAR: campo del bloque seleccionado en el panel (Shift+Tab) ------
    const headingText = `Solo teclado ${stamp}`;
    await shiftTabToField(page, TITLE_LABEL);
    await page.keyboard.press("Control+a");
    await page.keyboard.type(headingText);
    await expect(frame.locator(`[data-wjs-block-id="${before[1]}"]`)).toContainText(headingText);

    // --- TÍTULO DE PÁGINA: acción "Ajustes de página" de la ⌘K -------------
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("combobox")).toBeFocused();
    await page.keyboard.type("Ajustes");
    await expect(page.getByRole("dialog").getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    // El panel debe haber conmutado a modo ROOT antes de teclear: si no, el
    // Shift+Tab aterriza en el campo del BLOQUE, el payload va sin `title` y el
    // backend responde 400 "Title is required" (cazado en CI, más lento que local).
    await expect(page.locator('[data-verso-panel="root"]')).toBeVisible({ timeout: 30_000 });
    const pageTitle = `Página teclado ${stamp}`;
    await shiftTabToField(page, TITLE_LABEL);
    await page.keyboard.press("Control+a");
    await page.keyboard.type(pageTitle);
    await expect(
        page.locator('[data-verso-panel="root"]').getByLabel(TITLE_LABEL).first(),
    ).toHaveValue(pageTitle);

    // --- GUARDAR: Ctrl+S (bypassa el guard de tecleo — contrato W03) --------
    const [res] = await Promise.all([
        page.waitForResponse(
            (r) =>
                /\/api\/v1\/posts(\/\d+)?$/.test(new URL(r.url()).pathname) &&
                ["POST", "PUT"].includes(r.request().method()),
        ),
        page.keyboard.press("Control+s"),
    ]);
    expect(
        res.ok(),
        `guardado por teclado falló: ${res.status()} ${await res.text().catch(() => "")}`,
    ).toBeTruthy();
});
