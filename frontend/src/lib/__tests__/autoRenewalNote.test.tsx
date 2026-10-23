/**
 * Security → Automatic Certificate Renewal: the HTTP-01 note is one translated sentence per language
 * (FALLOS 137). It used to be glued from fragments, which read "runs in the every deployment mode",
 * "en el todos los modos", "HTTP-01 ; por eso" and "Port 80 listenerabove".
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { withParts } from "@/app/admin/security/AutoRenewalPanel";
import { translations, type Language } from "../i18n";

const PARTS = ["modes", "challenge", "path", "port80", "dns", "custom"];

function rendered(lang: Language): string {
    const tr = translations[lang];
    const html = renderToStaticMarkup(<p>{withParts(tr["ssl.auto.note.http01"], {
        modes: <b>{tr["ssl.auto.note.everyMode"]}</b>,
        challenge: <b>HTTP-01</b>,
        path: <code>http://&lt;domain&gt;/.well-known/acme-challenge/</code>,
        port80: <b>{tr["ssl.auto.port80"]}</b>,
        dns: <b>DNS</b>,
        custom: <b>{tr["ssl.auto.note.customUpload"]}</b>,
    })}</p>);
    // What a reader sees: the text with the markup taken out.
    return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

describe("the HTTP-01 note reads as one sentence in each language", () => {
    for (const lang of ["es", "en", "pt"] as const) {
        it(lang, () => {
            const template = translations[lang]["ssl.auto.note.http01"];
            for (const part of PARTS) expect(template, `${lang} {${part}}`).toContain(`{${part}}`);
            const text = rendered(lang);
            expect(text).not.toMatch(/\{\w+\}/);
            expect(text).not.toMatch(/ {2}| [,;.)]/);
            expect(text).toContain(translations[lang]["ssl.auto.port80"] + " ");
            expect(text).toContain(translations[lang]["ssl.auto.note.everyMode"]);
        });
    }

    it("none of the reported misreadings is left", () => {
        expect(rendered("en")).toMatch(/^Auto-renewal runs in every deployment mode \(monolith, split and separate\) and uses the HTTP-01 challenge, so /);
        expect(rendered("en")).toContain("set Port 80 listener above to 80");
        expect(rendered("es")).not.toMatch(/en el todos/);
        expect(rendered("pt")).not.toMatch(/na todos/);
    });

    it("withParts leaves an unknown {name} as written", () => {
        expect(renderToStaticMarkup(<>{withParts("a {x} b {y}", { x: <i>X</i> })}</>)).toBe("a <i>X</i> b {y}");
    });
});
