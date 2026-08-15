/**
 * F3 — serializeContentFallback: BYTE-IGUAL al switch inline del onChange de
 * admin/pages/[id]/page.tsx (la fuente canónica) para los 7 tipos soportados.
 *
 * Los fixtures esperados están EXTRAÍDOS del código actual de pages (whitespace del template
 * literal de Card incluido, construido aquí con \n + " ".repeat para que el pin sea explícito,
 * no un copy-paste del template que se auto-confirmaría). La divergencia con posts (4 tipos, sin
 * clases wp-block-*) se resolvió hacia ESTE lado — decisión ratificada W47.
 */
import { describe, expect, it } from "vitest";
import { serializeContentFallback } from "../contentFallback";

const sp = (n: number) => " ".repeat(n);

describe("serializeContentFallback — byte-igual al switch de pages", () => {
    it("Heading", () => {
        expect(
            serializeContentFallback([
                { type: "Heading", props: { id: "h1", level: "h2", title: "Hola" } },
            ]),
        ).toBe('<h2 class="wp-block-heading font-bold my-4">Hola</h2>');
    });

    it("Text", () => {
        expect(
            serializeContentFallback([{ type: "Text", props: { id: "t1", content: "<p>Cuerpo</p>" } }]),
        ).toBe('<div class="wp-block-text prose"><p>Cuerpo</p></div>');
    });

    it("Image", () => {
        expect(
            serializeContentFallback([
                { type: "Image", props: { id: "i1", src: "/uploads/a.png", alt: "Alt" } },
            ]),
        ).toBe('<img src="/uploads/a.png" alt="Alt" class="wp-block-image max-w-full my-4 rounded shadow-sm"/>');
    });

    it("Button — las 3 alineaciones", () => {
        const btn = (align: string) =>
            serializeContentFallback([
                { type: "Button", props: { id: "b1", align, href: "/x", variant: "primary", label: "Ir" } },
            ]);
        expect(btn("center")).toBe(
            '<div class="wp-block-button my-6 text-center"><a href="/x" class="wp-button button-primary">Ir</a></div>',
        );
        expect(btn("right")).toBe(
            '<div class="wp-block-button my-6 text-right"><a href="/x" class="wp-button button-primary">Ir</a></div>',
        );
        expect(btn("left")).toBe(
            '<div class="wp-block-button my-6 text-left"><a href="/x" class="wp-button button-primary">Ir</a></div>',
        );
    });

    it("Card — con icono (whitespace del template literal EXACTO)", () => {
        const expected =
            "\n" +
            sp(32) + '<div class="wp-block-card card-theme-dark p-8 rounded-3xl border my-6">\n' +
            sp(36) + '<i class="fa-solid fa-star text-2xl mb-4"></i>\n' +
            sp(36) + '<h3 class="text-xl font-bold mb-2">Título</h3>\n' +
            sp(36) + '<p class="opacity-80">Descripción</p>\n' +
            sp(32) + "</div>";
        expect(
            serializeContentFallback([
                {
                    type: "Card",
                    props: { id: "c1", theme: "dark", icon: "fa-star", title: "Título", description: "Descripción" },
                },
            ]),
        ).toBe(expected);
    });

    it("Card — sin icono (la interpolación vacía deja la línea de 36 espacios)", () => {
        const expected =
            "\n" +
            sp(32) + '<div class="wp-block-card card-theme-light p-8 rounded-3xl border my-6">\n' +
            sp(36) + "\n" +
            sp(36) + '<h3 class="text-xl font-bold mb-2">T</h3>\n' +
            sp(36) + '<p class="opacity-80">D</p>\n' +
            sp(32) + "</div>";
        expect(
            serializeContentFallback([
                { type: "Card", props: { id: "c2", theme: "light", icon: "", title: "T", description: "D" } },
            ]),
        ).toBe(expected);
    });

    it("Divider", () => {
        expect(
            serializeContentFallback([{ type: "Divider", props: { id: "d1", type: "solid" } }]),
        ).toBe('<hr class="wp-block-divider divider-solid my-10 border-gray-100" />');
    });

    it("HTMLEmbed — verbatim, y '' cae a cadena vacía", () => {
        expect(
            serializeContentFallback([{ type: "HTMLEmbed", props: { id: "e1", html: "<section>raw</section>" } }]),
        ).toBe("<section>raw</section>");
        expect(serializeContentFallback([{ type: "HTMLEmbed", props: { id: "e2", html: "" } }])).toBe("");
    });

    it("tipos no soportados se omiten y el resto concatena en orden", () => {
        const out = serializeContentFallback([
            { type: "Heading", props: { id: "h", level: "h3", title: "A" } },
            { type: "Hero", props: { id: "x" } }, // no serializado — igual que hoy
            { type: "HTMLEmbed", props: { id: "e", html: "<b>B</b>" } },
        ]);
        expect(out).toBe('<h3 class="wp-block-heading font-bold my-4">A</h3><b>B</b>');
    });

    it("lienzo vacío → cadena vacía", () => {
        expect(serializeContentFallback([])).toBe("");
    });
});
