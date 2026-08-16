/**
 * F3 ola 4 — auditoría a11y re-apuntada a Verso (checklist W25): el mapeo issue→bloque vía
 * `data-wjs-block-id` y el salto del scaffolding de guías, con un DOM STUB mínimo (el proyecto no
 * tiene jsdom — mismo criterio que editorRenderer.test.tsx). El stub implementa exactamente lo que
 * las reglas consultan (closest/getAttribute/attributes/textContent y querySelectorAll por
 * selector); la regla de contraste exige getComputedStyle real → defaultView:null la salta aquí y
 * queda para el gate de navegador, documentado.
 */
import { describe, expect, it } from "vitest";
import { runVersoA11yAudit, VERSO_BLOCK_ATTR } from "../a11y";

/* ── stub DOM mínimo ─────────────────────────────────────────────────────── */

type Attrs = Record<string, string>;

interface StubEl {
    tagName: string;
    attributes: { length: number; [i: number]: { name: string; value: string } };
    parentElement: StubEl | null;
    textContent: string;
    firstChild: null;
    getAttribute(n: string): string | null;
    hasAttribute(n: string): boolean;
    closest(sel: string): StubEl | null;
    querySelector(sel: string): StubEl | null;
}

/** Matcher de lo justo que usan las reglas: "#id", "[attr]" y nombres de tag, en listas por coma. */
function matches(e: StubEl, selector: string): boolean {
    return selector
        .split(",")
        .map((s) => s.trim())
        .some((s) => {
            if (s.startsWith("#")) return e.getAttribute("id") === s.slice(1);
            if (s.startsWith("[") && s.endsWith("]")) return e.hasAttribute(s.slice(1, -1));
            return e.tagName === s.toUpperCase();
        });
}

function el(tag: string, attrs: Attrs = {}, text = ""): StubEl {
    const entries = Object.entries(attrs);
    const attributes = Object.assign(
        entries.map(([name, value]) => ({ name, value })),
        { length: entries.length },
    ) as unknown as StubEl["attributes"];
    const node: StubEl = {
        tagName: tag.toUpperCase(),
        attributes,
        parentElement: null,
        textContent: text,
        firstChild: null,
        getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
        hasAttribute: (n) => Object.prototype.hasOwnProperty.call(attrs, n),
        closest(sel: string) {
            let cur: StubEl | null = node;
            while (cur) {
                if (matches(cur, sel)) return cur;
                cur = cur.parentElement;
            }
            return null;
        },
        querySelector: () => null,
    };
    return node;
}

function inBlock(blockId: string, child: StubEl): StubEl {
    const wrapper = el("div", { [VERSO_BLOCK_ATTR]: blockId });
    child.parentElement = wrapper;
    return child;
}

/** Documento stub: cada regla pide su selector a body.querySelectorAll — se sirve del mapa. */
function docStub(bySelector: Record<string, StubEl[]>): Document {
    return {
        body: { querySelectorAll: (sel: string) => bySelector[sel] ?? [] },
        getElementById: () => null,
        defaultView: null, // sin ventana → la regla de contraste (computed styles) se salta
    } as unknown as Document;
}

/* ── tests ───────────────────────────────────────────────────────────────── */

describe("runVersoA11yAudit — mapeo issue→bloque vía data-wjs-block-id", () => {
    it("img sin alt mapea al bloque contenedor; alt='' (decorativa) no es issue", () => {
        const issues = runVersoA11yAudit(
            docStub({
                img: [inBlock("b-hero", el("img", { src: "/a.png" })), inBlock("b-ok", el("img", { src: "/b.png", alt: "" }))],
            }),
        );
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ rule: "img-alt", severity: "error", blockId: "b-hero" });
        expect(issues[0].snippet).toContain("<img");
    });

    it("enlace sin nombre accesible mapea a su bloque; con texto no hay issue", () => {
        const issues = runVersoA11yAudit(
            docStub({
                "a[href], button, [role='button']": [
                    inBlock("b-cta", el("a", { href: "/x" }, "")),
                    inBlock("b-nav", el("a", { href: "/y" }, "Leer más")),
                ],
            }),
        );
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ rule: "accessible-name", blockId: "b-cta" });
    });

    it("salto de jerarquía de encabezados (h2→h4) mapea al bloque del heading ofensor", () => {
        const h2 = inBlock("b-1", el("h2", {}, "Sección"));
        const h4 = inBlock("b-2", el("h4", {}, "Detalle"));
        const issues = runVersoA11yAudit(docStub({ "h1,h2,h3,h4,h5,h6": [h2, h4] }));
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ rule: "heading-order", severity: "warning", blockId: "b-2" });
    });

    it("un issue FUERA de bloque (chrome de la plantilla del tema) llega con blockId undefined", () => {
        const issues = runVersoA11yAudit(docStub({ "[tabindex]": [el("div", { tabindex: "3" }, "x")] }));
        expect(issues).toHaveLength(1);
        expect(issues[0].rule).toBe("tabindex-positive");
        expect(issues[0].blockId).toBeUndefined(); // el panel no puede seleccionar nada — no-op
    });

    it("el scaffolding de guías (#wjs-spacing-overlay) se salta aunque contenga ofensores", () => {
        const overlay = el("div", { id: "wjs-spacing-overlay" });
        const img = el("img", { src: "/g.png" });
        img.parentElement = overlay;
        const issues = runVersoA11yAudit(docStub({ img: [img] }));
        expect(issues).toEqual([]);
    });
});
