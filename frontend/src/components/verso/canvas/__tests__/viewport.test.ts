/**
 * Verso — tests de la aritmética pura del device-preview (canvas/viewport.ts)
 * y de su invariante de coordenadas con el DnD (toFramePoint, dnd/driverCore).
 *
 * ENTORNO: node (sin jsdom — mismo patrón que dndDriver.test.ts): todo lo
 * geométrico es puro por diseño; el disparo real de media queries y el pintado
 * escalado quedan para la verificación en navegador del orquestador.
 */
import { describe, expect, it } from "vitest";
import {
    DEVICE_ORDER,
    DEVICE_WIDTHS,
    canvasContainerLayout,
    fitScale,
} from "../viewport";
import { frameScaleOf, toFramePoint } from "../../dnd/driverCore";

describe("DEVICE_WIDTHS — contrato de breakpoints con wordjs-ui.css", () => {
    it("móvil cae bajo el corte 767.98 (banda .wjs-hide-mobile)", () => {
        expect(DEVICE_WIDTHS.mobile).toBe(375);
        expect(DEVICE_WIDTHS.mobile).toBeLessThan(768);
    });

    it("tableta cae en la banda 768–1023.98 (.wjs-hide-tablet)", () => {
        expect(DEVICE_WIDTHS.tablet).toBe(768);
        expect(DEVICE_WIDTHS.tablet).toBeGreaterThanOrEqual(768);
        expect(DEVICE_WIDTHS.tablet).toBeLessThan(1024);
    });

    it("escritorio dispara min-width:1024 (.wjs-hide-desktop) — 960 NO lo haría", () => {
        expect(DEVICE_WIDTHS.desktop).toBe(1280);
        expect(DEVICE_WIDTHS.desktop).toBeGreaterThanOrEqual(1024);
    });

    it("el toolbar enumera los tres dispositivos", () => {
        expect(DEVICE_ORDER).toEqual(["desktop", "tablet", "mobile"]);
    });
});

describe("fitScale", () => {
    it("encoge para caber: área 960 / escritorio 1280 → 0.75", () => {
        expect(fitScale(960, 1280)).toBe(0.75);
    });

    it("nunca amplía (cap 1): área 960 / móvil 375 → 1", () => {
        expect(fitScale(960, 375)).toBe(1);
    });

    it("área sin medir (0, negativa o no finita) → 1, fail-soft", () => {
        expect(fitScale(0, 1280)).toBe(1);
        expect(fitScale(-5, 1280)).toBe(1);
        expect(fitScale(Number.NaN, 1280)).toBe(1);
        expect(fitScale(960, 0)).toBe(1);
    });
});

describe("canvasContainerLayout", () => {
    it("escritorio 1280 en área 960×600: scale 0.75, alto compensado 800, sin offset", () => {
        const vp = canvasContainerLayout(960, 600, 1280);
        expect(vp).toEqual({ width: 1280, height: 800, scale: 0.75, offsetX: 0 });
        // Tras el scale, el canvas llena el área EXACTA: 1280·0.75 × 800·0.75.
        expect(vp.width * vp.scale).toBe(960);
        expect(vp.height * vp.scale).toBe(600);
    });

    it("móvil 375 en área 960×600: scale 1 y centrado con offsetX", () => {
        const vp = canvasContainerLayout(960, 600, 375);
        expect(vp.scale).toBe(1);
        expect(vp.width).toBe(375);
        expect(vp.height).toBe(600);
        expect(vp.offsetX).toBe((960 - 375) / 2);
    });

    it("área aún sin medir (0×0): scale 1 y alto 0 (nada que pintar todavía)", () => {
        const vp = canvasContainerLayout(0, 0, 1280);
        expect(vp.scale).toBe(1);
        expect(vp.height).toBe(0);
        expect(vp.offsetX).toBe(0);
    });
});

describe("invariante de coordenadas bajo transform: scale()", () => {
    it("frameScaleOf recupera la escala CSS de la caja: rect.width = clientWidth·s", () => {
        // Contenedor a escala 0.75: el iframe de 1280 CSS px mide 960 visuales.
        expect(frameScaleOf(960, 1280)).toBe(0.75);
        // Sin transform: identidad.
        expect(frameScaleOf(768, 768)).toBe(1);
        // clientWidth 0 (sin layout): fail-soft a 1.
        expect(frameScaleOf(500, 0)).toBe(1);
    });

    it("toFramePoint con escala 0.75: ida y vuelta exacta padre↔iframe", () => {
        // Iframe 1280 CSS px escalado 0.75 y colocado en (100, 50) del padre.
        const box = { left: 100, top: 50, width: 960, clientWidth: 1280 };
        // Un punto interno del iframe (x, y) se pinta en el padre en
        // (left + x·0.75, top + y·0.75); toFramePoint debe invertirlo exacto.
        const inner = { x: 400, y: 240 };
        const parentClient = { x: 100 + 400 * 0.75, y: 50 + 240 * 0.75 };
        expect(toFramePoint(parentClient.x, parentClient.y, box)).toEqual(inner);
        // La esquina del iframe mapea al origen del sistema interno.
        expect(toFramePoint(100, 50, box)).toEqual({ x: 0, y: 0 });
    });

    it("por qué el overlay no necesita término de escala (mapeo identidad)", () => {
        // Un bloque con rect interno (x,y,w,h) y un hijo del overlay con
        // left:x/top:y/width:w/height:h viven en el MISMO contenedor
        // transformado: ambos se pintan en (containerLeft + x·s, …, w·s, …).
        // La igualdad de las dos proyecciones es independiente de s:
        const s = 0.75;
        const containerLeft = 100;
        const rect = { x: 200, y: 120, width: 300, height: 80 };
        const paintedBlockLeft = containerLeft + rect.x * s;
        const paintedOverlayLeft = containerLeft + rect.x * s; // misma fórmula
        expect(paintedOverlayLeft).toBe(paintedBlockLeft);
        // Con s=1 (sin transform) la igualdad es la misma: no hay caso especial.
        expect(containerLeft + rect.x * 1).toBe(containerLeft + rect.x);
    });
});
