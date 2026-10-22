import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The payment and forms plugins' admin screens follow the admin language (X4-12): each ships a
 * client/admin/i18n.ts with es / en / pt tables, the three with the same keys, and its pages hold no
 * Spanish UI text outside that file.
 */

const PLUGINS = path.resolve(__dirname, "../../../../marketplace/plugins");
const SLUGS = ["contact-forms", "bookings", "donations", "digital-downloads", "memberships", "invoices", "event-tickets"];
const SPANISH = /[áéíóúñ¿¡]/i;

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
        if (text && SPANISH.test(text)) hits.push(`${path.basename(file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${JSON.stringify(text.slice(0, 60))}`);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return hits;
}

describe("payment and forms plugin admin screens are translated", () => {
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
