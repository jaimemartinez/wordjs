/**
 * Verso F6 (a) — crear página real en /admin/pages/new?engine=verso:
 * 3 bloques por paleta, edición de props, guardar, recargar, persistencia.
 *
 * REGRESIÓN QUE ESTE SPEC PINEA (cazada por él en CI): en un checkout limpio el
 * proceso arranca en SETUP MODE e instala IN-PROCESS, y los post types se
 * registraban solo en la rama `if (isInstalled())` del boot — la primera página
 * creada tras el asistente moría con 400 rest_invalid_post_type. El instalador
 * los registra ahora (routes/setup.ts); este spec es el único gate que recorre
 * ese camino entero (instalar → crear contenido) sin reiniciar el servidor.
 */
import { expect, test } from "@playwright/test";
import {
    blockIdsIn,
    canvas,
    insertFromPalette,
    openNewPageVerso,
    saveAndGetId,
    setRootTitle,
} from "./helpers";

test("crear página: 3 bloques por paleta, editar props, guardar, recargar y verificar persistencia", async ({ page }) => {
    const frame = await openNewPageVerso(page);
    const stamp = Date.now().toString(36);

    // --- 3 bloques desde la paleta lateral (tap-to-insert) -----------------
    await insertFromPalette(page, "Heading");
    await expect(frame.locator("[data-wjs-block-id]")).toHaveCount(1);
    await insertFromPalette(page, "Text");
    await expect(frame.locator("[data-wjs-block-id]")).toHaveCount(2);
    await insertFromPalette(page, "Card");
    await expect(frame.locator("[data-wjs-block-id]")).toHaveCount(3);

    // --- editar props del Heading vía panel de propiedades -----------------
    // Selección por click en el canvas (listener capture del VersoEditor).
    const ids = await blockIdsIn(frame.locator("body"));
    expect(ids.length).toBe(3);
    await frame.locator(`[data-wjs-block-id="${ids[0]}"]`).click();
    const headingText = `Encabezado E2E ${stamp}`;
    // El campo del bloque: input asociado a <label htmlFor> (VersoFieldControl).
    const titleField = page.getByLabel(/^(title|título)/i).first();
    await expect(titleField).toBeVisible();
    await titleField.fill(headingText);
    await expect(frame.locator(`[data-wjs-block-id="${ids[0]}"]`)).toContainText(headingText);

    // --- título de la página (campos ROOT): rail "Ajustes" deselecciona ----
    const pageTitle = `Página E2E ${stamp}`;
    await setRootTitle(page, pageTitle);

    // --- guardar ------------------------------------------------------------
    const id = await saveAndGetId(page, async () => {
        await page.getByRole("button", { name: /^(guardar|save)$/i }).click();
    });
    expect(id).toBeGreaterThan(0);

    // --- recargar y verificar persistencia ----------------------------------
    await page.goto(`/admin/pages/${id}?engine=verso`);
    const frame2 = canvas(page);
    await expect(frame2.locator("[data-wjs-block-id]")).toHaveCount(3, { timeout: 60_000 });
    const idsAfter = await blockIdsIn(frame2.locator("body"));
    expect(idsAfter).toEqual(ids); // mismos ids estables, mismo orden
    await expect(frame2.locator(`[data-wjs-block-id="${ids[0]}"]`)).toContainText(headingText);

    // El título de la página persiste (breadcrumb del header lo enseña).
    await expect(page.getByText(pageTitle, { exact: true }).first()).toBeVisible();
});
