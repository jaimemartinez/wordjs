/**
 * Verso F6 (e) — cross-engine: una página GUARDADA con Verso, abierta en el
 * editor legacy (sin flag → default absoluto), debe presentar contenido
 * IDÉNTICO — verificado vía window.puckGetData() (el hook del editor legacy)
 * contra el _puck_data persistido por Verso (contrato byte-exacto de F4).
 */
import { expect, test } from "@playwright/test";
import { blockIdsIn, insertFromPalette, openNewPageVerso, saveAndGetId, setRootTitle } from "./helpers";

test("cross-engine: guardar en Verso y abrir en legacy — contenido idéntico vía window.puckGetData", async ({ page }) => {
    const frame = await openNewPageVerso(page);
    const stamp = Date.now().toString(36);

    // Página con estructura no trivial: contenedor + hojas.
    await insertFromPalette(page, "Section");
    await expect(frame.locator("[data-wjs-block-id]")).toHaveCount(1);
    await insertFromPalette(page, "Heading");
    await insertFromPalette(page, "Text");
    await expect(frame.locator("[data-wjs-block-id]")).toHaveCount(3);
    const ids = await blockIdsIn(frame.locator("body"));

    // Título (root) para poder guardar — helper que ESPERA al modo root del panel.
    await setRootTitle(page, `Cross-engine ${stamp}`);

    const id = await saveAndGetId(page, async () => {
        await page.getByRole("button", { name: /^(guardar|save)$/i }).click();
    });

    // Lo PERSISTIDO por Verso (la fuente de verdad del contrato).
    const saved = await page.request.get(`/api/v1/posts/${id}`);
    expect(saved.ok()).toBeTruthy();
    const savedJson = (await saved.json()) as { meta?: { _puck_data?: { content?: unknown[] } } };
    const savedContent = savedJson.meta?._puck_data?.content;
    expect(Array.isArray(savedContent), "la página guardada debe llevar _puck_data.content").toBeTruthy();
    expect((savedContent as unknown[]).length).toBeGreaterThan(0);

    // Abrir SIN flag Verso (legacy es el default absoluto) — pero explícito
    // aquí para blindar el spec contra un localStorage contaminado.
    await page.goto(`/admin/pages/${id}?engine=legacy`);
    await page.waitForFunction(
        () => typeof (window as unknown as { puckGetData?: () => unknown }).puckGetData === "function",
        undefined,
        { timeout: 60_000 },
    );
    // Puck puede terminar de hidratar async: esperar a que el doc vivo tenga contenido.
    await page.waitForFunction(() => {
        const data = (window as unknown as { puckGetData: () => { content?: unknown[] } }).puckGetData();
        return Array.isArray(data?.content) && data.content.length > 0;
    });
    const legacyContent = await page.evaluate(
        () => (window as unknown as { puckGetData: () => { content: unknown[] } }).puckGetData().content,
    );

    // Contenido IDÉNTICO en profundidad (toEqual ignora el ORDEN de claves).
    // HALLAZGO DOCUMENTADO (F6): la identidad es semántica, no byte a byte —
    // el motor legacy re-emite las claves de SLOT al principio de props
    // (children primero) mientras Verso conserva el orden persistido (children
    // al final si el slot se materializó al insertar). Deep-equal exacto, pero
    // alternar motores ensucia el diff de revisiones por reordenación de claves.
    expect(legacyContent).toEqual(savedContent);
    // Y los ids estables del canvas Verso siguen siendo los del doc legacy.
    const legacyIds = (legacyContent as Array<{ props: { id: string } }>).map((i) => i.props.id);
    for (const rootId of legacyIds) expect(ids).toContain(rootId);
});
