/**
 * Verso F6 (3) — PRESUPUESTOS DE PERF como gate, sobre el banco determinista
 * /admin/verso-lab?fixture=500&lab=1 (500 bloques, PRNG con semilla fija).
 *
 * Protocolo:
 *  - TTI := tiempo desde el goto hasta que el canvas tiene >=500 bloques
 *    VISIBLES (el criterio pactado del encargo).
 *  - 100 teclas sintetizadas por CDP (Input.dispatchKeyEvent — el canal real
 *    de Chromium, no eventos JS sintéticos) sobre un campo del panel de
 *    propiedades; el lab mide input-latency (keydown→fin del transact) y el
 *    coste de cada transact, y publica window.__versoPerf (PerfHud).
 *  - GATE: falla si input.p95 >= 16ms, transact.p95 >= 30ms o TTI >= 2500ms.
 *
 * CALIBRACIÓN (F6b, documentado a propósito): estos números se midieron para
 * el runner de Actions con build de PRODUCCIÓN en mente; el webServer de este
 * programa arranca dev:mono (Next en dev, sin optimizar), así que el número
 * FINAL de CI se calibrará en el runner real. Mientras tanto los umbrales son
 * sobreescribibles por entorno para no bloquear en máquinas lentas:
 *   VERSO_PERF_INPUT_P95_MS · VERSO_PERF_TRANSACT_P95_MS · VERSO_PERF_TTI_MS
 */
import { expect, test } from "@playwright/test";
import { CANVAS_IFRAME_SELECTOR } from "./helpers";

const INPUT_P95_MS = Number(process.env.VERSO_PERF_INPUT_P95_MS ?? 16);
const TRANSACT_P95_MS = Number(process.env.VERSO_PERF_TRANSACT_P95_MS ?? 30);
const TTI_MS = Number(process.env.VERSO_PERF_TTI_MS ?? 2500);
const KEYSTROKES = 100;

interface PerfStats {
    count: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
}
interface PerfSnapshot {
    input: PerfStats;
    transact: PerfStats;
}

test("presupuestos: TTI del fixture 500, input p95 y transact p95 tras 100 teclas por CDP", async ({ page }) => {
    // --- TTI: goto → 500 bloques visibles en el canvas ----------------------
    const t0 = Date.now();
    await page.goto("/admin/verso-lab?fixture=500&lab=1");
    await page.waitForFunction(
        (sel) => {
            const iframe = document.querySelector<HTMLIFrameElement>(sel);
            const doc = iframe?.contentDocument;
            if (!doc) return false;
            const blocks = doc.querySelectorAll("[data-wjs-block-id]");
            if (blocks.length < 500) return false;
            const first = blocks[0] as HTMLElement;
            return first.offsetParent !== null || first.getClientRects().length > 0;
        },
        CANVAS_IFRAME_SELECTOR,
        { timeout: 120_000 },
    );
    const tti = Date.now() - t0;

    // --- foco en un campo del panel de propiedades --------------------------
    const frame = page.frameLocator(CANVAS_IFRAME_SELECTOR);
    await frame.locator("[data-wjs-block-id]").first().click();
    // El aside derecho del lab captura el keydown (perf.markInput); su primer
    // campo de texto es el objetivo del tecleo.
    const field = page.locator("aside input[type='text'], aside textarea").first();
    await expect(field).toBeVisible();
    await field.click();

    // Medición limpia: fuera el ruido del montaje/selección.
    await page.evaluate(() => {
        (window as unknown as { __versoPerf?: { reset(): void } }).__versoPerf?.reset();
    });

    // --- 100 teclas sintetizadas por CDP ------------------------------------
    const cdp = await page.context().newCDPSession(page);
    for (let i = 0; i < KEYSTROKES; i++) {
        await cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "a",
            code: "KeyA",
            text: "a",
            unmodifiedText: "a",
        });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
        await page.waitForTimeout(15); // cadencia de tecleo real; deja respirar al rAF
    }

    // --- leer y gatear -------------------------------------------------------
    const snapshot = await page.evaluate(
        () => (window as unknown as { __versoPerf: { snapshot(): unknown } }).__versoPerf.snapshot(),
    ) as PerfSnapshot;

    expect(snapshot.input.count, "el tecleo debe haber registrado muestras de input").toBeGreaterThanOrEqual(
        KEYSTROKES * 0.9,
    );
    expect(snapshot.transact.count).toBeGreaterThan(0);

    const summary =
        `TTI=${tti}ms (gate <${TTI_MS}) · input p95=${snapshot.input.p95}ms (gate <${INPUT_P95_MS}, ` +
        `n=${snapshot.input.count}) · transact p95=${snapshot.transact.p95}ms (gate <${TRANSACT_P95_MS}, ` +
        `n=${snapshot.transact.count})`;
    test.info().annotations.push({ type: "perf", description: summary });
    console.log(`[verso-perf] ${summary}`); // visible en el log de CI (calibración F6b)

    expect(tti, `TTI fuera de presupuesto — ${summary}`).toBeLessThan(TTI_MS);
    expect(snapshot.input.p95, `input p95 fuera de presupuesto — ${summary}`).not.toBeNull();
    expect(snapshot.input.p95!, `input p95 fuera de presupuesto — ${summary}`).toBeLessThan(INPUT_P95_MS);
    expect(snapshot.transact.p95, `transact p95 fuera de presupuesto — ${summary}`).not.toBeNull();
    expect(snapshot.transact.p95!, `transact p95 fuera de presupuesto — ${summary}`).toBeLessThan(TRANSACT_P95_MS);
});
