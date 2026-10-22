import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The marketplace plugins' admin screens follow the admin language (X4-12, S4-08): each ships a
 * client/admin/i18n.ts with es / en / pt tables, the three with the same keys, and its pages hold no
 * Spanish UI text outside that file.
 */

const PLUGINS = path.resolve(__dirname, "../../../../marketplace/plugins");
const SLUGS = [
    "contact-forms", "bookings", "donations", "digital-downloads", "memberships", "invoices", "event-tickets",
    // S4-08: every other marketplace plugin with an admin screen (mail-server has its own es/en table;
    // conference-manager follows its own release train).
    "analytics-tag", "auctions", "card-gallery", "cookie-consent", "events-calendar", "faq", "image-lightbox",
    "job-board", "newsletter", "notification-bar", "online-store", "photo-carousel", "polls", "popup-builder",
    "restaurant-menu", "social-share", "testimonials", "vendor-marketplace", "video-gallery", "youtube-videos",
];
const SPANISH = /[áéíóúñ¿¡]/i;
// Site content, not admin UI: the cookie-consent preview draws the banner exactly as the public banner script
// does, and that script's built-in link text is this literal.
const SITE_CONTENT = new Set(["Política de cookies"]);

function tables(file: string): Record<string, Set<string>> {
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out: Record<string, Set<string>> = {};
    sf.forEachChild((n) => {
        if (!ts.isVariableStatement(n)) return;
        for (const d of n.declarationList.declarations) {
            const name = d.name.getText(sf);
            if (!["es", "en", "pt"].includes(name) || !d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue;
            out[name] = new Set(d.initializer.properties.map((p) => (p.name ? p.name.getText(sf).replace(/^['"]|['"]$/g, "") : "")));
        }
    });
    return out;
}

/** String literals and JSX text in a page that carry Spanish (comments are not literals, so they are skipped). */
function spanishLiterals(file: string): string[] {
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hits: string[] = [];
    const visit = (n: ts.Node) => {
        let text: string | null = null;
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
        else if (ts.isJsxText(n)) text = n.text.trim();
        else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => s.literal.text).join("");
        if (text && SPANISH.test(text) && !SITE_CONTENT.has(text)) hits.push(`${path.basename(file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${JSON.stringify(text.slice(0, 60))}`);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return hits;
}

describe("marketplace plugin admin screens are translated", () => {
    for (const slug of SLUGS) {
        const dir = path.join(PLUGINS, slug, "client/admin");
        it(`${slug}: es / en / pt tables with the same keys`, () => {
            const t = tables(path.join(dir, "i18n.ts"));
            expect(Object.keys(t).sort()).toEqual(["en", "es", "pt"]);
            expect(t.es.size).toBeGreaterThan(20);
            expect([...t.es].filter((k) => !t.en.has(k))).toEqual([]);
            expect([...t.es].filter((k) => !t.pt.has(k))).toEqual([]);
            expect([...t.en].filter((k) => !t.es.has(k))).toEqual([]);
        });
        it(`${slug}: no Spanish UI text left in its pages`, () => {
            const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"));
            expect(pages.length).toBeGreaterThan(0);
            expect(pages.flatMap((f) => spanishLiterals(path.join(dir, f)))).toEqual([]);
        });
    }
});
