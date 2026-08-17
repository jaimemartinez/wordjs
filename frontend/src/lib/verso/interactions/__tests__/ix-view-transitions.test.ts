/**
 * C1 — transiciones entre páginas: el ajuste hostil, el CSS emitido y sus dos garantías duras
 * (el at-rule NUNCA anidado, y el movimiento reducido cortando la animación con `!important`).
 */
import { describe, expect, it } from "vitest";
import { compileVtCss, normalizeVtStyle, IX_VT_STYLES, IX_VT_DUR_MS } from "../viewTransitions";

describe("normalizeVtStyle — el ajuste del sitio es dato hostil", () => {
    it("acepta la lista cerrada y NADA más", () => {
        expect([...IX_VT_STYLES]).toEqual(["off", "fade", "slide"]);
        for (const s of IX_VT_STYLES) expect(normalizeVtStyle(s)).toBe(s);
    });

    it("fail-safe: cualquier basura apaga la transición", () => {
        for (const bad of [undefined, null, "", "FADE", "auto", 1, true, {}, [], "slide;}"]) {
            expect(normalizeVtStyle(bad)).toBe("off");
        }
    });
});

describe("compileVtCss — el texto emitido", () => {
    it("apagado: ni un byte (el layout no emite ni la etiqueta)", () => {
        expect(compileVtCss("off")).toBe("");
    });

    it("el at-rule de navegación va al NIVEL SUPERIOR, jamás dentro de un @media", () => {
        for (const style of ["fade", "slide"] as const) {
            const css = compileVtCss(style);
            expect(css.startsWith("@view-transition{navigation:auto}")).toBe(true);
            // Si el at-rule quedara DENTRO de un bloque condicional, un motor podría ignorarlo
            // entero y la función desaparecería en silencio: se fija que nada lo preceda.
            expect(/@media[\s\S]*?@view-transition/.test(css)).toBe(false);
        }
    });

    it("el CHROME sale del grupo raíz para quedarse quieto, y por selector de hijo directo", () => {
        for (const style of ["fade", "slide"] as const) {
            const css = compileVtCss(style);
            expect(css).toContain(".wjs-shell>header{view-transition-name:wjs-vt-header}");
            expect(css).toContain(".wjs-shell>footer{view-transition-name:wjs-vt-footer}");
            // NUNCA un selector suelto: un bloque de contenido puede pintar su propio <header>
            // dentro de <main>, y un nombre DUPLICADO aborta la transición entera.
            expect(/[^>]header\{view-transition-name/.test(css.replace(".wjs-shell>", ">"))).toBe(false);
        }
    });

    it("fade: solo fija el tempo del fundido por defecto del navegador", () => {
        const css = compileVtCss("fade");
        expect(css).toContain(`::view-transition-old(root),::view-transition-new(root){animation-duration:${IX_VT_DUR_MS}ms}`);
        expect(css).not.toContain("@keyframes");
    });

    it("slide: dos keyframes propios, y SOLO opacity/transform (cero reflow)", () => {
        const css = compileVtCss("slide");
        expect(css).toContain("@keyframes wjs-vt-out{");
        expect(css).toContain("@keyframes wjs-vt-in{");
        expect(css).toContain("::view-transition-old(root){animation:wjs-vt-out");
        expect(css).toContain("::view-transition-new(root){animation:wjs-vt-in");
        // Toda declaración dentro de los keyframes: nada de layout (width/height/top/margin…).
        const decls = [...css.matchAll(/[{;]\s*([a-z-]+)\s*:/g)].map((m) => m[1]);
        const allowed = new Set([
            "opacity", "transform", "animation", "animation-duration", "navigation",
            // Identidad de transición, no layout: nombra un grupo para que el navegador lo capture
            // aparte. No pinta ni recoloca nada por sí misma.
            "view-transition-name",
        ]);
        for (const d of decls) expect(allowed.has(d), d).toBe(true);
    });

    it("movimiento reducido: la transición ocurre, pero SIN animación (corte instantáneo)", () => {
        for (const style of ["fade", "slide"] as const) {
            const css = compileVtCss(style);
            expect(css).toContain("@media (prefers-reduced-motion:reduce)");
            expect(css).toContain("animation:none!important");
            // Cubre los TRES pseudo-elementos con el selector universal: ningún nombre se escapa.
            expect(css).toContain("::view-transition-group(*)");
            expect(css).toContain("::view-transition-old(*)");
            expect(css).toContain("::view-transition-new(*)");
        }
    });

    it("determinista: dos compilaciones del mismo estilo dan bytes idénticos", () => {
        expect(compileVtCss("slide")).toBe(compileVtCss("slide"));
    });
});
