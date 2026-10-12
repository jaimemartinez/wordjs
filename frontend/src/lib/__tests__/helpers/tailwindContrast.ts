/**
 * WCAG 2 contrast of Tailwind colour classes, computed from Tailwind's OWN palette (the oklch values in
 * node_modules/tailwindcss/theme.css), so a test can say "this text meets AA on this background" about the
 * class names a component renders instead of about a hand-copied hex value.
 *
 *   contrastOf("text-slate-400", "white")                      → 2.56
 *   contrastOf("text-slate-600", "white", "bg-amber-50/60")    → foreground over a tinted row on white
 *
 * Background layers are composited bottom-up; a class with `/NN` is that colour at NN % alpha, blended in
 * gamma-encoded sRGB like the browser does. Test-only helper (not collected: no `.test.` in the name).
 */
import fs from "node:fs";
import path from "node:path";

const THEME = fs.readFileSync(path.resolve(__dirname, "../../../../node_modules/tailwindcss/theme.css"), "utf8");

type RGB = [number, number, number];

/** sRGB (gamma-encoded, 0..1) of a Tailwind colour name: "slate-400", "white", "black". */
export function twColour(name: string): RGB {
    if (name === "white") return [1, 1, 1];
    if (name === "black") return [0, 0, 0];
    const m = new RegExp(String.raw`--color-${name}:\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)`).exec(THEME);
    if (!m) throw new Error(`Tailwind colour "${name}" is not in theme.css`);
    const L = Number(m[1]) / 100, C = Number(m[2]), h = (Number(m[3]) * Math.PI) / 180;
    const a = C * Math.cos(h), b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin: RGB = [
        4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
    ];
    const enc = (x: number) => {
        const c = Math.min(1, Math.max(0, x));
        return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    };
    return [enc(lin[0]), enc(lin[1]), enc(lin[2])];
}

/** "text-slate-400/80" | "bg-amber-50/60" | "slate-400" | "white" → colour name and alpha. */
export function parseColourClass(token: string): { name: string; alpha: number } {
    const bare = token.replace(/^(?:[a-z-]+:)*(?:text|bg|border|from|to|via)-/, "");
    const [name, pct] = bare.split("/");
    return { name, alpha: pct === undefined ? 1 : Number(pct) / 100 };
}

function over(top: { name: string; alpha: number }, under: RGB): RGB {
    const c = twColour(top.name);
    return [0, 1, 2].map((i) => c[i] * top.alpha + under[i] * (1 - top.alpha)) as RGB;
}

function luminance([r, g, b]: RGB): number {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio of a text colour class over background layers (bottom first; default white). */
export function contrastOf(text: string, ...backgrounds: string[]): number {
    let bg: RGB = [1, 1, 1];
    for (const layer of backgrounds.length ? backgrounds : ["white"]) bg = over(parseColourClass(layer), bg);
    const fg = over(parseColourClass(text), bg);
    const x = luminance(fg), y = luminance(bg);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The single `text-<colour>` class in a class list (fails loudly when there is none or several). */
export function textClassOf(classes: string): string {
    const found = classes.split(/\s+/).filter((k) => /^text-(?:white|black|[a-z]+-\d{2,3})(?:\/\d+)?$/.test(k));
    if (found.length !== 1) throw new Error(`expected exactly one text colour in "${classes}", got ${JSON.stringify(found)}`);
    return found[0];
}

/** WCAG AA for normal-size text. */
export const AA = 4.5;
