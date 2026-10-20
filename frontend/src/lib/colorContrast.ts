/**
 * WCAG 2.x contrast, for the theme generator's live check (Admin → Themes → New theme). The server
 * judges the built theme again with the theme doctor (backend core/theme-doctor LOW_CONTRAST) before it
 * installs it; this copy only lets the screen show the ratios while the colours are being picked.
 */

const HEX = /^#[0-9a-f]{6}$/i;

function channels(hex: string): [number, number, number] {
    const h = HEX.test(hex) ? hex.slice(1) : "000000";
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** Relative luminance (WCAG). */
export function luminance(hex: string): number {
    const [r, g, b] = channels(hex).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

function toHex(rgb: number[]): string {
    return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/**
 * The colour closest to `fg` that reaches `min` against `bg`: mixed step by step toward black or white,
 * whichever the background needs. Returns `fg` itself when it already passes.
 */
export function readableColor(fg: string, bg: string, min = 4.5): string {
    if (contrastRatio(fg, bg) >= min) return fg;
    const target = luminance(bg) > 0.18 ? [0, 0, 0] : [255, 255, 255];
    const from = channels(fg);
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const c = toHex(from.map((v, i) => v + (target[i] - v) * t));
        if (contrastRatio(c, bg) >= min) return c;
    }
    return toHex(target);
}

/** The label colour WordJS puts on a filled button: white or near-black, whichever reads better. */
export function onColor(bg: string): string {
    return contrastRatio("#ffffff", bg) >= contrastRatio("#111111", bg) ? "#ffffff" : "#111111";
}
