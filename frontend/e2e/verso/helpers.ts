/**
 * Verso F6 — helpers compartidos de los specs E2E.
 *
 * Contratos DOM en los que se apoyan (fuente única, verificados en el código):
 *  - canvas = <iframe src="/admin/canvas-frame"> (FrameController);
 *  - cada bloque estampa data-wjs-block-id (VersoBlock / EditorRenderer);
 *  - cada slot estampa data-wjs-slot="<parentId>:<slotKey>" (VersoSlot; la raíz
 *    es "verso:root:content");
 *  - la paleta marca el contenedor con data-wjs-palette y cada tarjeta con
 *    data-wjs-palette-type="<Type>" (BlockPalette y el panel del lab);
 *  - la sesión inline marca el host con data-wjs-inline="<nodeId>" y
 *    contenteditable=true (VersoTextSurface).
 */
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const CANVAS_IFRAME_SELECTOR = 'iframe[src*="/admin/canvas-frame"]';
export const ROOT_SLOT_SELECTOR = '[data-wjs-slot="verso:root:content"]';

/**
 * Neutraliza el overlay de dev de Next (<nextjs-portal>): su indicador flotante
 * INTERCEPTA pointer events (cazado en la primera corrida: tapaba el botón
 * "Ajustes" del rail y convertía el click del BubbleMenu en un outside-press
 * que cerraba la sesión inline). Solo existe en dev; en build de producción el
 * estilo es un no-op. Llamar ANTES del primer goto de cada spec.
 */
export async function prepPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const inject = (): void => {
            const style = document.createElement("style");
            // nextjs-portal: overlay de dev de Next. [data-verso-engine-toggle]: el
            // pill "Motor" (EngineToggle, solo dev) — fixed bottom-left z-9999, tapa
            // el botón "Ajustes" del rail en viewports bajos (hallazgo F6, solo dev).
            style.textContent =
                "nextjs-portal{display:none !important;pointer-events:none !important}" +
                "[data-verso-engine-toggle]{display:none !important;pointer-events:none !important}";
            (document.head ?? document.documentElement)?.appendChild(style);
        };
        if (document.documentElement) inject();
        else document.addEventListener("DOMContentLoaded", inject, { once: true });
    });
}

export function canvas(page: Page): FrameLocator {
    return page.frameLocator(CANVAS_IFRAME_SELECTOR);
}

/** Ids de bloque en orden DOM dentro de un contenedor del canvas. */
export async function blockIdsIn(scope: Locator): Promise<string[]> {
    return scope.locator("[data-wjs-block-id]").evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-wjs-block-id") ?? ""),
    );
}

/** Ids de los HIJOS DIRECTOS de un slot (sin descender a slots anidados). */
export async function directChildIds(frame: FrameLocator, slotAttr: string): Promise<string[]> {
    return frame.locator(`[data-wjs-slot="${slotAttr}"]`).evaluate((slot) => {
        const out: string[] = [];
        const walk = (el: Element): void => {
            for (const child of Array.from(el.children)) {
                const id = child.getAttribute("data-wjs-block-id");
                if (id) {
                    out.push(id);
                    continue; // hijo directo encontrado: no descender dentro de él
                }
                walk(child); // envoltorios sin id (wrappers del renderer/plantilla)
            }
        };
        walk(slot);
        return out;
    });
}

/** Abre el Verso Lab con la fixture pedida y espera el canvas hidratado. */
export async function openLab(page: Page, fixture: "30" | "500" = "30"): Promise<FrameLocator> {
    await prepPage(page);
    await page.goto(`/admin/verso-lab?lab=1&fixture=${fixture}`);
    const frame = canvas(page);
    await expect(frame.locator("[data-wjs-block-id]").first()).toBeVisible({ timeout: 60_000 });
    return frame;
}

/** Abre el editor de páginas NUEVA en motor Verso y espera el chrome montado. */
export async function openNewPageVerso(page: Page): Promise<FrameLocator> {
    await prepPage(page);
    await page.goto("/admin/pages/new?engine=verso");
    // El chrome del VersoEditor: botón Guardar (estado draft) del header.
    await expect(page.getByRole("button", { name: /guardar|publicar/i }).first()).toBeVisible({
        timeout: 60_000,
    });
    const frame = canvas(page);
    // El slot raíz existe en cuanto EditorRenderer monta dentro del iframe.
    await expect(frame.locator(ROOT_SLOT_SELECTOR)).toBeAttached({ timeout: 60_000 });
    return frame;
}

/** Inserta un bloque desde la paleta lateral (tap-to-insert) y espera el conteo. */
export async function insertFromPalette(page: Page, type: string): Promise<void> {
    await page.locator(`[data-wjs-palette] [data-wjs-palette-type="${type}"]`).first().click();
}

/**
 * Drag REAL con movimientos incrementales del ratón (pointer events reales —
 * los que escucha el DnDDriver en capture). Umbral de arranque: 5px; los moves
 * se batchean por rAF, de ahí las esperas cortas entre pasos.
 */
export async function dragWithMouse(
    page: Page,
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 14,
): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await page.mouse.move(x, y);
        await page.waitForTimeout(30); // deja correr el rAF del driver
    }
    await page.mouse.up();
}

/** Centro de la caja visual de un locator (coordenadas de página). */
export async function centerOf(loc: Locator): Promise<{ x: number; y: number }> {
    const box = await loc.boundingBox();
    expect(box, "el elemento debe tener caja visible").toBeTruthy();
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** Guarda vía el chrome y devuelve el id del registro creado/actualizado. */
export async function saveAndGetId(page: Page, trigger: () => Promise<void>): Promise<number> {
    const [res] = await Promise.all([
        page.waitForResponse(
            (r) =>
                /\/api\/v1\/posts(\/\d+)?$/.test(new URL(r.url()).pathname) &&
                (r.request().method() === "POST" || r.request().method() === "PUT"),
        ),
        trigger(),
    ]);
    expect(res.ok(), `guardado falló: ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as { id?: number };
    if (typeof body.id === "number") return body.id;
    const m = new URL(res.url()).pathname.match(/\/posts\/(\d+)$/);
    expect(m, "no se pudo determinar el id del registro guardado").toBeTruthy();
    return Number(m![1]);
}
