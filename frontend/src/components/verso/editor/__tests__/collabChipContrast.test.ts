/**
 * EL CHIP DE ESTADO SE TIENE QUE LEER — contraste calculado, no confiado.
 *
 * El defecto que cierra esto se vio en pantalla antes que en ningún test: el tono `live` llegó a
 * pintar dos índigos oscuros con apenas **1,39:1**, cuando AA pide 4,5:1 para texto pequeño. El
 * sistema visual actual mantiene el texto primario sobre un contenedor claro y este gate verifica
 * que futuros cambios de paleta no vuelvan a introducir esa regresión.
 *
 * Nadie lo cazó porque la única regla de contraste del proyecto necesita `getComputedStyle` y en
 * node se salta (ver a11y.test.ts). Aquí no hace falta un navegador: los dos extremos del par están
 * ESCRITOS —los tokens en `editor-theme.css`, la pareja en el `TONE_CLASS` de CollabPresence— así
 * que el contraste se puede calcular leyendo los ficheros. Cualquier tono futuro que empareje mal
 * pone esto rojo antes de llegar a una pantalla.
 *
 * El chip es texto de 11px: el umbral es 4,5:1 (AA texto normal), no el 3:1 del texto grande.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf-8");

/** Tokens `--ed-*: #rrggbb` declarados en la hoja del editor. */
function editorTokens(): Record<string, string> {
    const css = read("src/components/editor-theme.css");
    const out: Record<string, string> = {};
    for (const m of css.matchAll(/(--ed-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
        if (!(m[1] in out)) out[m[1]] = m[2]; // el PRIMERO gana: el bloque raíz va antes que las variantes
    }
    return out;
}

/** Literales de Tailwind que el chip usa a propósito (el tono de aviso). Sin adivinar: escritos. */
const TAILWIND: Record<string, string> = {
    "amber-800": "#92400e",
    "amber-50": "#fffbeb",
    "amber-200": "#fde68a",
};

/** `text-[var(--x)]` / `bg-[var(--y,#fallback)]` / `text-amber-800` → color resuelto. */
function resolveClassColor(cls: string, tokens: Record<string, string>): string | null {
    const varMatch = /^(?:text|bg)-\[var\((--[a-z0-9-]+)(?:,\s*(#[0-9a-fA-F]{3,8}))?\)\]$/.exec(cls);
    if (varMatch) return tokens[varMatch[1]] ?? varMatch[2] ?? null;
    const twMatch = /^(?:text|bg)-((?:amber|red|green|blue|slate|gray)-\d{2,3})$/.exec(cls);
    if (twMatch) return TAILWIND[twMatch[1]] ?? null;
    return null;
}

/** Las parejas texto/fondo declaradas por tono en CollabPresence. */
function chipTones(): Record<string, { fg: string; bg: string }> {
    const src = read("src/components/verso/editor/CollabPresence.tsx");
    const block = src.slice(src.indexOf("const TONE_CLASS"), src.indexOf("};", src.indexOf("const TONE_CLASS")));
    const out: Record<string, { fg: string; bg: string }> = {};
    for (const m of block.matchAll(/(\w+):\s*"([^"]+)"/g)) {
        const classes = m[2].split(/\s+/);
        const fg = classes.find((c) => c.startsWith("text-"));
        const bg = classes.find((c) => c.startsWith("bg-"));
        if (fg && bg) out[m[1]] = { fg, bg };
    }
    return out;
}

const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function luminance(hex: string): number {
    let h = hex.replace("#", "");
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string): number => {
    const [l1, l2] = [luminance(a), luminance(b)];
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

describe("chip de estado de colaboración: todos los tonos se leen", () => {
    const tokens = editorTokens();
    const tones = chipTones();

    it("la lectura de ficheros encuentra lo que dice encontrar (o el gate sería un adorno)", () => {
        expect(Object.keys(tokens).length).toBeGreaterThan(20);
        expect(tokens["--ed-primary"]).toBe("#5146d8");
        expect(tokens["--ed-primary-container"]).toBe("#e8e7ff");
        expect(Object.keys(tones).sort()).toEqual(["idle", "live", "off", "warn"]);
    });

    for (const tone of ["live", "warn", "off", "idle"]) {
        it(`tono \`${tone}\`: texto sobre su fondo llega a AA (4,5:1)`, () => {
            const pair = tones[tone];
            const fg = resolveClassColor(pair.fg, tokens);
            const bg = resolveClassColor(pair.bg, tokens);
            // Un color que este test no sepa resolver es un agujero en el gate, no un aprobado.
            expect(fg, `no se pudo resolver ${pair.fg}`).not.toBeNull();
            expect(bg, `no se pudo resolver ${pair.bg}`).not.toBeNull();
            const ratio = contrast(fg!, bg!);
            expect(+ratio.toFixed(2), `${pair.fg} sobre ${pair.bg}`).toBeGreaterThanOrEqual(4.5);
        });
    }

    it("el par principal del sistema visual también conserva contraste AA", () => {
        expect(
            +contrast(tokens["--ed-primary"], tokens["--ed-primary-container"]).toFixed(2),
        ).toBeGreaterThanOrEqual(4.5);
    });
});
