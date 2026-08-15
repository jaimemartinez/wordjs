/**
 * Verso — aritmética PURA del device-preview del canvas (sin React, sin DOM).
 *
 * CONTRATO DE BREAKPOINTS (wordjs-ui.css, verificado L1025-1027):
 *   .wjs-hide-mobile  → @media (max-width: 767.98px)
 *   .wjs-hide-tablet  → @media (min-width: 768px) and (max-width: 1023.98px)
 *   .wjs-hide-desktop → @media (min-width: 1024px)
 * El iframe del canvas llena su contenedor (className "h-full w-full" de
 * FrameController), así que fijar el ANCHO CSS del contenedor fija el viewport
 * del iframe y sus media queries REALES disparan: móvil = 375 (< 768),
 * tableta = 768 (banda 768–1023.98), escritorio = 1280 (≥ 1024 — un ancho
 * menor, como el max-w-[960px] previo del lab, JAMÁS dispararía
 * .wjs-hide-desktop).
 *
 * ESCALA (por qué el overlay sigue 1:1 con scale != 1): el contenedor del
 * canvas mantiene su ancho CSS = ancho del dispositivo y se encoge con
 * `transform: scale(s)` para caber en el área. Un transform NO cambia el
 * sistema de coordenadas INTERNO del contenedor: el iframe (rects de
 * getBoundingClientRect dentro de SU documento = viewport CSS del iframe) y la
 * capa overlay (hermana del iframe, absolute dentro del MISMO contenedor
 * transformado) comparten ese sistema local, y el navegador escala AMBOS
 * juntos al pintar. Un bloque cuyo rect interno es (x, y, w, h) se pinta en
 * pantalla en (left + x·s, top + y·s, w·s, h·s), y un hijo del overlay con
 * left:x/top:y/width:w/height:h se pinta EXACTAMENTE igual — el mapeo es la
 * identidad para todo s, sin término de escala en ningún consumidor
 * (GeometryStore/OverlayLayer no conocen s). La ÚNICA frontera que necesita s
 * son los eventos del documento PADRE (clientX/Y en px visuales), y ahí el
 * driver la deriva de la propia caja: s = rect.width / clientWidth
 * (toFramePoint, dnd/driverCore.ts) — cierto por definición bajo transform,
 * porque rect.width ES clientWidth·s.
 */

/** Dispositivos del toolbar del canvas. */
export type DeviceKind = "desktop" | "tablet" | "mobile";

/**
 * Ancho CSS del viewport de cada dispositivo. tablet=768 y mobile=375 son los
 * del encargo; desktop=1280 porque el corte .wjs-hide-desktop exige ≥1024.
 */
export const DEVICE_WIDTHS: Record<DeviceKind, number> = {
    desktop: 1280,
    tablet: 768,
    mobile: 375,
};

/** Orden estable del toolbar. */
export const DEVICE_ORDER: readonly DeviceKind[] = ["desktop", "tablet", "mobile"];

/** Etiquetas del toolbar (con el ancho visible: contrato verificable a ojo). */
export const DEVICE_LABELS: Record<DeviceKind, string> = {
    desktop: "Escritorio (1280)",
    tablet: "Tableta (768)",
    mobile: "Móvil (375)",
};

/**
 * Escala scale-to-fit: encoge (nunca amplía, cap 1) el ancho del dispositivo
 * para caber en el área disponible. Área no medida aún (<=0) → 1.
 */
export function fitScale(areaWidth: number, deviceWidth: number): number {
    if (!Number.isFinite(areaWidth) || areaWidth <= 0 || deviceWidth <= 0) return 1;
    return Math.min(1, areaWidth / deviceWidth);
}

export interface CanvasContainerLayout {
    /** Ancho CSS del contenedor = ancho del dispositivo (el iframe lo hereda). */
    width: number;
    /**
     * Alto CSS del contenedor: areaHeight / scale, para que TRAS el scale el
     * canvas llene visualmente el alto del área (transform no cambia layout).
     */
    height: number;
    scale: number;
    /** Offset horizontal (px visuales) que centra el canvas escalado en el área. */
    offsetX: number;
}

/**
 * Layout completo del contenedor transformado a partir del área medida
 * (ResizeObserver) y el ancho del dispositivo. Pura — testeada en node.
 */
export function canvasContainerLayout(
    areaWidth: number,
    areaHeight: number,
    deviceWidth: number,
): CanvasContainerLayout {
    const scale = fitScale(areaWidth, deviceWidth);
    const height = areaHeight > 0 ? areaHeight / scale : 0;
    const visualWidth = deviceWidth * scale;
    const offsetX = Math.max(0, (areaWidth - visualWidth) / 2);
    return { width: deviceWidth, height, scale, offsetX };
}
