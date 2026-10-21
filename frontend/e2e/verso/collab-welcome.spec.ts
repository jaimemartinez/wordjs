/**
 * Verso — el `welcome` de la sala colaborativa contra registros reales.
 *
 * La sala siembra su `base` con el `_puck_data` guardado, y su `welcome` SUSTITUYE el documento del
 * editor. Dos formas lo rompían:
 *
 *  1. Un registro SIN `_puck_data` (legacy, importado, creado por la API): la sala se sembraba con
 *     `{}` y el `welcome` pisaba el documento sembrado en local (HTML en un HTMLEmbed + los campos del
 *     registro) — lienzo, título y extracto vacíos. Ese editor ya no se une a la sala.
 *  2. Un `_puck_data` cuya clave `content` falta: el store publicaba la forma ausente y el `onChange`
 *     de la página lanzaba `data.content.length` en cada edición. El store garantiza ya el array.
 *
 * El segundo caso se prueba con DOS contextos de navegador (dos réplicas reales en la misma sala).
 */
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { ADMIN_STORAGE_STATE, E2E_BASE_URL } from "../../playwright.config";
import { canvas, openPageSettings, prepPage, ROOT_SLOT_SELECTOR } from "./helpers";

/** Crea un post por la API (doble envío CSRF: la cookie `wjs_csrf` repetida en la cabecera). */
async function createPost(ctx: BrowserContext, request: APIRequestContext, body: Record<string, unknown>): Promise<number> {
    const csrf = (await ctx.cookies()).find((c) => c.name === "wjs_csrf")?.value ?? "";
    const res = await request.post("/api/v1/posts", {
        headers: { Origin: E2E_BASE_URL, "X-CSRF-Token": csrf },
        data: { type: "post", status: "draft", ...body },
    });
    expect(res.ok(), `crear post falló: ${res.status()} ${await res.text().catch(() => "")}`).toBeTruthy();
    return ((await res.json()) as { id: number }).id;
}

/** Errores de página no capturados (el TypeError del `onChange` salía por aquí). */
function trackPageErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err?.message ?? err)));
    return errors;
}

async function openPostEditor(page: Page, id: number): Promise<void> {
    await prepPage(page);
    await page.goto(`/admin/posts/${id}`);
    await expect(page.getByRole("button", { name: /guardar|publicar/i }).first()).toBeVisible({ timeout: 60_000 });
    await expect(canvas(page).locator(ROOT_SLOT_SELECTOR)).toBeAttached({ timeout: 60_000 });
}

const presence = (page: Page) => page.locator("[data-wjs-collab-presence]");

test("un post sin _puck_data abre con su cuerpo y sus campos, y no se une a la sala", async ({ page, context, request }) => {
    const marker = `Cuerpo legacy ${Date.now()}`;
    const id = await createPost(context, request, { title: "Legacy sin documento", content: `<p>${marker}</p>` });
    const errors = trackPageErrors(page);
    const streams: string[] = [];
    page.on("request", (r) => {
        if (/\/api\/v1\/collab\/\d+\/stream/.test(r.url())) streams.push(r.url());
    });

    await openPostEditor(page, id);
    await expect(canvas(page).getByText(marker)).toBeVisible({ timeout: 30_000 });
    await openPageSettings(page);
    const title = page.locator('[data-verso-panel="root"]').getByLabel(/^(title|título)/i).first();
    await expect(title).toHaveValue("Legacy sin documento");

    // Pasado el instante en que llegaría el `welcome`, el lienzo SIGUE teniendo el cuerpo.
    await page.waitForTimeout(3_000);
    await expect(canvas(page).getByText(marker)).toBeVisible();
    await expect(title).toHaveValue("Legacy sin documento");
    await title.fill("Legacy editado");
    await expect(title).toHaveValue("Legacy editado");

    expect(streams, "un registro sin documento persistido no abre el canal colaborativo").toEqual([]);
    await expect(presence(page)).toHaveCount(0);
    expect(errors).toEqual([]);
});

test("un _puck_data sin `content`: dos contextos colaboran sin que el onChange lance", async ({ browser, context, request }) => {
    const id = await createPost(context, request, {
        title: "Documento sin content",
        content: "",
        meta: { _puck_data: { root: { props: { title: "Documento sin content" } } } },
    });

    const ctxA = await browser.newContext({ storageState: ADMIN_STORAGE_STATE, viewport: { width: 1440, height: 900 } });
    const ctxB = await browser.newContext({ storageState: ADMIN_STORAGE_STATE, viewport: { width: 1440, height: 900 } });
    try {
        const a = await ctxA.newPage();
        const b = await ctxB.newPage();
        const errorsA = trackPageErrors(a);
        const errorsB = trackPageErrors(b);

        await openPostEditor(a, id);
        await openPostEditor(b, id);
        // Los dos en la sala: el chip dice "Conectado" (el `welcome` ya se aplicó en ambos).
        await expect(presence(a)).toContainText(/conectado/i, { timeout: 30_000 });
        await expect(presence(b)).toContainText(/conectado/i, { timeout: 30_000 });

        // Una edición en A (el `onChange` corre en cada una) viaja a B.
        await openPageSettings(a);
        await openPageSettings(b);
        const titleA = a.locator('[data-verso-panel="root"]').getByLabel(/^(title|título)/i).first();
        const titleB = b.locator('[data-verso-panel="root"]').getByLabel(/^(title|título)/i).first();
        await titleA.fill("Título desde A");
        await expect(titleB).toHaveValue("Título desde A", { timeout: 30_000 });

        // Y un bloque insertado en B aparece en el lienzo de A.
        await b.locator('[data-wjs-palette] [data-wjs-palette-type="Heading"]').first().click();
        await expect(canvas(b).locator(`${ROOT_SLOT_SELECTOR} [data-wjs-block-id]`)).toHaveCount(1);
        await expect(canvas(a).locator(`${ROOT_SLOT_SELECTOR} [data-wjs-block-id]`)).toHaveCount(1, { timeout: 30_000 });

        expect(errorsA).toEqual([]);
        expect(errorsB).toEqual([]);
    } finally {
        await ctxA.close();
        await ctxB.close();
    }
});
