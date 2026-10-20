/**
 * Header & footer editor, out of beta: the starter templates gallery, the plain-language validation
 * messages and the i18n of every string the editor shows — each through the real producer.
 *
 * Mutation proof: add a block a part does not allow to a template (a ChromeNav in the announcement
 * bar) and the template test goes red; make describeChromeProblem return the raw message and the
 * plain-language tests go red; delete one locale's entry for any key the editor uses and the i18n test
 * names it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseChromeData } from "@/lib/chromeData";
import { chromeTemplates } from "@/lib/chromeTemplates";
import { t as translate, translations } from "@/lib/i18n";
import { describeChromeProblem, formatChromeProblem } from "../chromeErrors";
import { withBlockIds, toContractData } from "../chromeContract";
import { createChromeVersoSetup } from "../chromeVersoAdapter";
import { createEditor } from "@/lib/verso/store";
import type { VersoData } from "@/lib/verso/types";

const en = (key: string) => translate(key, "en");

describe("starter templates gallery", () => {
    const templates = chromeTemplates(en);

    it("every template is a valid composition FOR ITS PART, with a unique id", () => {
        expect(new Set(templates.map((tpl) => tpl.id)).size).toBe(templates.length);
        for (const tpl of templates) {
            const parsed = parseChromeData(tpl.data, { source: tpl.id, position: tpl.part === "announcement" ? "announcement" : undefined });
            expect(parsed.errors, tpl.id).toEqual([]);
        }
    });

    it("offers a real choice for every part (header ≥ 5, footer ≥ 4, announcement ≥ 2)", () => {
        const count = (part: string) => templates.filter((tpl) => tpl.part === part).length;
        expect(count("header")).toBeGreaterThanOrEqual(5);
        expect(count("footer")).toBeGreaterThanOrEqual(4);
        expect(count("announcement")).toBeGreaterThanOrEqual(2);
    });

    it("covers the GA chrome features: sticky, transparent over the hero, hamburger, multi-row, multi-column", () => {
        const byId = Object.fromEntries(templates.map((tpl) => [tpl.id, tpl]));
        expect(byId["header-transparent"].data.root.props).toMatchObject({ transparent: true, sticky: true });
        expect(JSON.stringify(byId["header-minimal"].data)).toContain('"collapse":"always"');
        expect(byId["header-two-rows"].data.content.length).toBe(2);
        expect(byId["footer-columns"].data.content[0].type).toBe("ChromeColumns");
    });

    it("visitor-facing texts follow the admin language", () => {
        const es = chromeTemplates((key) => translate(key, "es"));
        expect(JSON.stringify(es.find((tpl) => tpl.id === "header-cta")!.data)).toContain("Contacto");
        expect(JSON.stringify(templates.find((tpl) => tpl.id === "header-cta")!.data)).toContain("Contact");
    });

    it("applying a template through the real Verso store round-trips to the same contract", () => {
        for (const tpl of templates) {
            const setup = createChromeVersoSetup(tpl.part);
            const stamped = withBlockIds(tpl.data);
            const handle = createEditor({ initialData: stamped as unknown as VersoData, isSlot: setup.isSlot });
            expect(toContractData(handle.getData())).toEqual(stamped);
            // Every container's children must be real editor nodes (a slot), not an opaque prop — or the
            // canvas draws the container EMPTY (a ChromeColumns whose cells had no ids did exactly that).
            for (const node of Object.values(handle.getDoc().nodes)) {
                if (node.type === "ChromeRow" || node.type === "ChromeColumns") {
                    expect(Object.keys(node.slots), `${tpl.id} ${node.type}`).toEqual(["items"]);
                    expect(node.props.items, `${tpl.id} ${node.type}`).toBeUndefined();
                }
            }
            handle.destroy();
        }
    });
});

describe("plain-language validation messages", () => {
    const composition = {
        root: { props: {} },
        content: [{ type: "ChromeRow", props: { align: "between", gap: "md", items: [
            { type: "ChromeLogo", props: {} },
            { type: "ChromeButton", props: { label: "Go", href: "javascript:alert(1)", variant: "primary" } },
        ] } }],
    };

    it("a LOCAL parser error names the block, where it sits and what to do", () => {
        const parsed = parseChromeData(composition, { source: "editor" });
        expect(parsed.ok).toBe(false);
        const line = formatChromeProblem(describeChromeProblem(parsed.errors[0], composition, en));
        expect(line).toBe("Button (Row 1 › block 2): The link must start with / (a page on your site) or https://.");
    });

    it("a BACKEND error entry reads the same way", () => {
        const entry = { code: "CHROME_UNSAFE_HREF", path: "content[0].props.items[1].props.href", message: '"href" must be a site-relative path' };
        expect(formatChromeProblem(describeChromeProblem(entry, composition, en))).toBe(
            "Button (Row 1 › block 2): The link must start with / (a page on your site) or https://.",
        );
    });

    it("missing fields, nesting and budget problems are explained, not coded", () => {
        const missing = describeChromeProblem({ code: "CHROME_MISSING_PROP", path: "content[0].props.items[1].props.label", message: "x" }, composition, en);
        expect(missing.message).toBe("“Label” is missing.");
        expect(describeChromeProblem({ code: "CHROME_TOO_DEEP", path: "content[0]", message: "x" }, composition, en).message).toMatch(/Too many levels/);
        expect(describeChromeProblem("editor: composition exceeds 100 blocks", composition, en).message).toMatch(/Too many blocks/);
        expect(describeChromeProblem({ code: "CHROME_BLOCK_NOT_IN_PART", path: "content[0]", message: "x" }, composition, en).message).toMatch(/header or footer/);
    });

    it("an unrecognised problem keeps its original text — nothing is hidden behind a vaguer message", () => {
        expect(describeChromeProblem("something new and specific", composition, en).message).toBe("something new and specific");
    });

    it("speaks Spanish and Portuguese too", () => {
        const parsed = parseChromeData(composition, { source: "editor" });
        expect(formatChromeProblem(describeChromeProblem(parsed.errors[0], composition, (k) => translate(k, "es")))).toMatch(/^Botón \(Fila 1 › bloque 2\): El enlace debe empezar/);
        expect(formatChromeProblem(describeChromeProblem(parsed.errors[0], composition, (k) => translate(k, "pt")))).toMatch(/^Botão \(Linha 1 › bloco 2\): O link deve começar/);
    });
});

describe("i18n — every string the header & footer editor shows exists in en, es and pt", () => {
    it("no key used by the editor is missing from any locale", () => {
        const dir = join(__dirname, "..");
        const files = [
            ...readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f)),
            join(__dirname, "..", "..", "..", "..", "lib", "chromeTemplates.ts"),
        ];
        const keys = new Set<string>();
        for (const file of files) {
            const src = readFileSync(file, "utf8");
            for (const m of src.matchAll(/\b(?:t|tr|translate)\(\s*["'`]((?:chrome|nav)\.[A-Za-z0-9_.-]+)["'`]/g)) keys.add(m[1]);
            for (const m of src.matchAll(/["'`](chrome\.template\.[A-Za-z0-9_.-]+)["'`]/g)) keys.add(m[1]);
        }
        // Dynamic keys the editor builds from a closed set.
        for (const part of ["header", "footer", "announcement"]) keys.add(`chrome.admin.part.${part}`).add(`chrome.admin.rootSettings.${part}`);
        for (const source of ["site", "theme", "legacy", "starter"]) keys.add(`chrome.admin.source.${source}`).add(`chrome.admin.sourceHint.${source}`);
        for (const device of ["desktop", "tablet", "phone"]) keys.add(`chrome.admin.device.${device}`);
        for (const flag of ["hideMobile", "hideTablet", "hideDesktop"]) keys.add(`chrome.field.${flag}`);
        for (const outcome of ["migrated", "site-composition", "theme-composition", "nothing-to-migrate"]) keys.add(`chrome.migrate.outcome.${outcome}`);
        keys.add("nav.chrome");
        expect(keys.size).toBeGreaterThan(150);
        const missing: string[] = [];
        for (const lang of ["en", "es", "pt"] as const) {
            for (const key of keys) if (!translations[lang][key]) missing.push(`${lang}:${key}`);
        }
        expect(missing).toEqual([]);
    });

    it("nothing says beta any more", () => {
        for (const lang of ["en", "es", "pt"] as const) {
            for (const [key, value] of Object.entries(translations[lang])) {
                if (key.startsWith("chrome.") || key === "nav.chrome") expect(value.toLowerCase(), `${lang}:${key}`).not.toContain("beta");
            }
        }
    });
});
