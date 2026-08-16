/**
 * Verso F6 (f) — asserts de roles/ARIA básicos del chrome del editor
 * (sustituto pactado de axe-core: sin dependencia nueva extra).
 *
 * Cubre: segmented control de viewports (aria-pressed), historia con nombre
 * accesible, live region del DnD (role=status + aria-live), paleta lateral
 * (tarjetas role=button + tabindex, buscador etiquetado), rail (aria-pressed)
 * y la ⌘K (combobox ARIA completo: aria-expanded/controls/activedescendant,
 * listbox + options con aria-selected).
 */
import { expect, test } from "@playwright/test";
import { canvas, openLab, ROOT_SLOT_SELECTOR } from "./helpers";

test("chrome del editor: roles y ARIA básicos", async ({ page }) => {
    await page.goto("/admin/pages/new");
    await expect(canvas(page).locator(ROOT_SLOT_SELECTOR)).toBeAttached({ timeout: 60_000 });

    // Viewports: 3 botones etiquetados, aria-pressed y EXACTAMENTE uno activo.
    for (const name of ["Escritorio", "Tableta", "Móvil"]) {
        await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", /true|false/);
    }
    await expect(page.locator('button[aria-pressed="true"][aria-label="Escritorio"]')).toHaveCount(1);

    // Historia: nombres accesibles presentes aunque estén deshabilitados.
    await expect(page.getByRole("button", { name: /deshacer/i })).toBeAttached();
    await expect(page.getByRole("button", { name: /rehacer/i })).toBeAttached();

    // Live region del DnD/teclado: role=status + aria-live=polite.
    const live = page.locator("[data-wjs-dnd-live]");
    await expect(live).toHaveAttribute("role", "status");
    await expect(live).toHaveAttribute("aria-live", "polite");

    // Paleta lateral: buscador etiquetado y tarjetas operables por teclado.
    await expect(page.getByRole("textbox", { name: /buscar bloque/i })).toBeVisible();
    const firstCard = page.locator("[data-wjs-palette] [data-wjs-palette-type]").first();
    await expect(firstCard).toHaveAttribute("role", "button");
    await expect(firstCard).toHaveAttribute("tabindex", "0");

    // Rail: pestañas con estado (aria-pressed) — Bloques activo por defecto.
    await expect(page.locator('nav button[aria-pressed="true"]').first()).toBeVisible();

    // ⌘K: diálogo con combobox ARIA completo.
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const combo = dialog.getByRole("combobox");
    await expect(combo).toHaveAttribute("aria-expanded", "true");
    await expect(combo).toHaveAttribute("aria-controls", /.+/);
    const listbox = dialog.getByRole("listbox");
    await expect(listbox).toBeVisible();
    await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-selected", /true|false/);
    // activedescendant apunta a la fila activa real.
    const activeId = await combo.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    await expect(dialog.locator(`#${activeId}`)).toBeAttached();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
});

test("verso-lab: controles del banco accesibles", async ({ page }) => {
    await openLab(page, "30");
    await expect(page.getByRole("button", { name: "Deshacer" })).toBeAttached();
    await expect(page.getByRole("button", { name: "Rehacer" })).toBeAttached();
    // Tarjetas de la paleta del lab con label accesible de inserción.
    await expect(page.getByRole("button", { name: /insertar bloque/i }).first()).toBeVisible();
    // Live region del DnD presente también en el banco.
    await expect(page.locator("[data-wjs-dnd-live]")).toHaveAttribute("aria-live", "polite");
});
