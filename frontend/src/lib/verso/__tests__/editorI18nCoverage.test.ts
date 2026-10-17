/**
 * Verso editor chrome is written in its Spanish source form and rendered through trStr / tr() in
 * the admin language. A string that reaches the screen without a { es, en, pt } dictionary entry
 * shows up in Spanish in an English admin — which is how "Editando · Untitled", "Lienzo del editor",
 * the motion presets and the style sections leaked. This suite parses the editor's UI sources and
 * fails on:
 *  - any literal passed to tr / trf / trStr / trFmt that the dictionary does not know, and
 *  - any Spanish-looking literal (accents, ¿, ¡) in an editor UI file that the dictionary does not
 *    know, even if it is not wrapped yet — wrapping it is then the only missing step.
 * Starter content (a block's defaultProps, built-in patterns) is checked against the separate
 * starter-text dictionary (lib/verso/defaultContent.ts) instead.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { editorStringMatches, trFmt, trStr } from "@/lib/editorI18n";
import { localizedDefaults, starterText, starterTextMatches } from "@/lib/verso/defaultContent";
import { humanizeBlockType, adaptPluginBlock } from "@/lib/verso/pluginBlocks";
import { createBlockRegistry } from "@/lib/verso/registry";
import { registerCoreBlocks } from "@/lib/verso/coreBlocks";
import { PATTERNS } from "@/lib/blockPatterns";
import * as ixModel from "@/components/verso/editor/ixPanelModel";
import { statusView } from "@/components/verso/editor/collabModel";
import { DEVICE_LABELS } from "@/components/verso/canvas/viewport";
import { BLOCK_META, GROUP_ORDER } from "@/lib/blockCatalog";
import { SYS_IX_PRESETS } from "@/lib/verso/interactions/presets";
import { IX_WARNING_TEMPLATES, localizeIxWarning } from "@/lib/verso/interactions/warningsI18n";

const SRC = path.resolve(import.meta.dirname, "../../..");

/** Editor UI sources: everything a Verso author sees. Dev-only lab screens are excluded. */
function editorUiFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === "__tests__" || e.name === "__fixtures__" || e.name === "lab") continue;
                walk(p);
            } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
        }
    };
    walk(path.join(SRC, "components/verso"));
    for (const f of [
        "components/blocks/AnimationField.tsx",
        "components/blocks/AppearanceField.tsx",
        "components/blocks/VisibilityField.tsx",
        "components/blocks/CSSControls.tsx",
        "components/blocks/LinkField.tsx",
        "components/blocks/SymbolBlock.tsx",
        "lib/blockCatalog.ts",
        "lib/blockPatterns.ts",
        "lib/verso/coreBlocks.tsx",
        "lib/verso/sharedFields.tsx",
        "lib/verso/interactions/presets.ts",
        // Collaboration notices: shown by CollabPresence (tr / trFmt on message or template).
        "lib/verso/collab/client.ts",
    ]) out.push(path.join(SRC, f));
    return out;
}

const TR_CALLEES = /^(tr|trf|trStr|trFmt|d\.tr)$/;
// Calls whose string arguments never reach the screen: logs, thrown developer errors, undo-history
// labels (store transactions — never displayed).
const SILENT_CALLEES = /(^console\.|^Error$|transact$|insertItemsAtEnd$|^Promise\.reject$)/;
const SPANISH = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
// Values of these properties in an editor UI file are display text (option tables, block metadata,
// tab definitions…), whatever language they are written in.
const DISPLAY_PROPS = /^(label|title|placeholder|desc|description|text|detail|group)$/;
const DISPLAY_ATTRS = /^(label|title|placeholder|aria-label|alt)$/;

interface Hit {
    where: string;
    text: string;
    wrapped: boolean;
    starter: boolean;
}

/** The expression a literal stands for as a translator argument: climbs ternary branches and parentheses. */
function keyExpression(n: ts.Node): ts.Node {
    let cur = n;
    for (;;) {
        const p = cur.parent;
        if (p && ts.isParenthesizedExpression(p)) cur = p;
        else if (p && ts.isConditionalExpression(p) && (p.whenTrue === cur || p.whenFalse === cur)) cur = p;
        else return cur;
    }
}

/** Display text worth translating — not a CSS value, URL or path used as a placeholder ("16px", "/uploads/…"). */
function isProse(text: string): boolean {
    if (!/[a-záéíóúñ]{2}/.test(text) || text.startsWith("&")) return false;
    return /[A-ZÁÉÍÓÚÑ]/.test(text) || !/[\d/(]/.test(text);
}

function collect(): Hit[] {
    const hits: Hit[] = [];
    for (const file of editorUiFiles()) {
        const src = fs.readFileSync(file, "utf8");
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const rel = path.relative(SRC, file).replace(/\\/g, "/");
        const visit = (n: ts.Node) => {
            let text: string | null = null;
            if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
            else if (ts.isJsxText(n)) text = n.text.replace(/\s+/g, " ").trim();
            if (text) {
                let wrapped = false;
                let silent = false;
                let starter = false;
                const display =
                    (ts.isPropertyAssignment(n.parent) && n.parent.initializer === n && DISPLAY_PROPS.test(n.parent.name.getText(sf))) ||
                    (ts.isJsxAttribute(n.parent) && DISPLAY_ATTRS.test(n.parent.name.getText(sf)));
                for (let p: ts.Node | undefined = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
                    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) silent = true;
                    if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "defaultProps") starter = true;
                    if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "blocks" && rel === "lib/blockPatterns.ts") starter = true;
                    if (ts.isCallExpression(p)) {
                        const callee = p.expression.getText(sf);
                        if (SILENT_CALLEES.test(callee)) silent = true;
                        // Only the FIRST argument of a translator is a dictionary key — the literal itself or
                        // a branch of a ternary there, never the ternary's condition.
                        if (TR_CALLEES.test(callee) && p.arguments[0] === keyExpression(n)) wrapped = true;
                    }
                }
                if (!silent && (wrapped || ((display || ts.isJsxText(n)) && isProse(text)) || SPANISH.test(text))) {
                    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
                    hits.push({ where: `${rel}:${line + 1}`, text, wrapped, starter });
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
    }
    return hits;
}

// Spanish literals in editor UI files that are not editor chrome (kept on purpose).
const NOT_CHROME = new Set<string>([
    "Verso", // the product name in the editor header
]);

describe("Verso editor chrome — every string has an { es, en, pt } entry", () => {
    const hits = collect();

    it("scans a meaningful amount of the editor (sanity)", () => {
        expect(hits.filter((h) => h.wrapped).length).toBeGreaterThan(300);
    });

    it("every literal passed to tr / trf / trStr / trFmt is in the dictionary", () => {
        const missing = hits
            .filter((h) => h.wrapped && !h.starter && editorStringMatches(h.text).length === 0)
            .map((h) => `${h.where}  ${JSON.stringify(h.text)}`);
        expect(missing).toEqual([]);
    });

    it("no Spanish UI literal in the editor lacks a translation", () => {
        const missing = hits
            .filter((h) => !h.wrapped && !h.starter && !NOT_CHROME.has(h.text) && editorStringMatches(h.text).length === 0)
            .map((h) => `${h.where}  ${JSON.stringify(h.text)}`);
        expect(missing).toEqual([]);
    });

    it("every Spanish starter text of the core blocks and built-in patterns has a starter translation", () => {
        const missing = hits
            .filter((h) => h.starter && SPANISH.test(h.text) && starterTextMatches(h.text).length === 0)
            .map((h) => `${h.where}  ${JSON.stringify(h.text)}`);
        expect(missing).toEqual([]);
    });

    it("model tables rendered by the editor (ix labels, presets, devices, collab, block catalog) are all translated", () => {
        const strings = new Set<string>();
        for (const [name, value] of Object.entries(ixModel)) {
            if (/^IX_.*LABELS$|^IX_PRESET_GROUPS$/.test(name)) for (const v of Object.values(value as Record<string, string>)) strings.add(v);
        }
        strings.add(ixModel.IX_SITE_PRESET_GROUP);
        for (const o of ixModel.ixPresetOptions({ presets: SYS_IX_PRESETS } as never)) {
            strings.add(o.label);
            if (o.group) strings.add(o.group);
        }
        for (const v of Object.values(DEVICE_LABELS)) strings.add(v);
        for (const s of ["off", "connecting", "live", "degraded", "offline"] as const) {
            strings.add(statusView(s).text);
            strings.add(statusView(s).detail);
        }
        for (const m of Object.values(BLOCK_META)) {
            if (m.label) strings.add(m.label);
            if (m.desc) strings.add(m.desc);
            strings.add(m.group);
        }
        for (const g of GROUP_ORDER) strings.add(g);
        for (const p of PATTERNS) {
            strings.add(p.name);
            strings.add(p.description);
        }
        for (const t of IX_WARNING_TEMPLATES) strings.add(t);
        const registry = createBlockRegistry();
        registerCoreBlocks(registry);
        for (const def of registry.list()) {
            if (def.label) strings.add(def.label);
        }
        const missing = [...strings].filter((s) => s && /[a-zá-ú]{2}/i.test(s) && editorStringMatches(s).length === 0);
        expect(missing).toEqual([]);
    });

    it("every interaction-compiler warning reads in English", () => {
        const src = fs.readFileSync(path.join(SRC, "lib/verso/interactions/compile.ts"), "utf8");
        const sf = ts.createSourceFile("compile.ts", src, ts.ScriptTarget.Latest, true);
        const fixed: string[] = [];
        const visit = (n: ts.Node) => {
            if (ts.isCallExpression(n) && n.expression.getText(sf) === "warnings.push") {
                const a = n.arguments[0];
                if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) fixed.push(a.text);
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
        expect(fixed.length).toBeGreaterThan(10);
        expect(fixed.filter((w) => localizeIxWarning(w, "en") === w)).toEqual([]);
        expect(localizeIxWarning("un disparador de scroll ignora repeat, alt: el progreso lo marca la posición, no el reloj", "en")).toMatch(/^a scroll trigger ignores repeat, alt/i);
    });

    it("the strings from the bug report render in English", () => {
        for (const [es, en] of [
            ["Editando", "Editing"],
            ["Navegación", "Navigation"],
            ["Campo de partículas", "Particle field"],
            ["Lienzo del editor", "Editor canvas"],
            ["Lienzo de edición", "Editing canvas"],
            ["Aparecer subiendo", "Fade up"],
            ["Desvanecer", "Fade"],
            ["Rápida", "Fast"],
            ["Lenta", "Slow"],
            ["Sin retardo", "No delay"],
            ["URL de la imagen", "Image URL"],
            ["Escritorio", "Desktop"],
            ["Tableta", "Tablet"],
            ["Móvil", "Mobile"],
            ["Fondo", "Background"],
            ["Borde y sombra", "Border and shadow"],
            ["Espaciado y tamaño", "Spacing and size"],
            ["Tipografía", "Typography"],
            ["Movimiento al pasar el ratón", "Hover motion"],
            ["Seleccionar…", "Select…"],
        ] as const) {
            expect(trStr(es, "en"), es).toBe(en);
        }
        expect(trFmt("Añadir elemento a {label}", "en", { label: "Buttons" })).toBe("Add item to Buttons");
    });
});

describe("new blocks start with text in the admin language", () => {
    const registry = createBlockRegistry();
    registerCoreBlocks(registry);

    it("Hero, Button and Text defaults follow the language; ids and non-text values are kept", () => {
        const hero = localizedDefaults(registry.get("Hero")!.defaultProps, "en");
        expect(hero.title).toBe("A headline that grabs attention");
        expect(JSON.stringify(hero)).not.toMatch(/Empezar|Un titular/);
        expect(localizedDefaults(registry.get("Text")!.defaultProps, "en").content).toBe("Write here...");
        expect(localizedDefaults(registry.get("Button")!.defaultProps, "es").label).toBe("Haz clic");
        expect(localizedDefaults(registry.get("Button")!.defaultProps, "en").label).toBe("Click Me");
        // A fresh copy every time: inserting twice never shares nested objects with the definition.
        const a = localizedDefaults(registry.get("Hero")!.defaultProps, "es");
        expect(a).toEqual(registry.get("Hero")!.defaultProps);
        expect(a).not.toBe(registry.get("Hero")!.defaultProps);
    });

    it("an English admin gets no Spanish starter text in any core block", () => {
        const spanish = registry
            .list()
            .filter((def) => SPANISH.test(JSON.stringify(localizedDefaults(def.defaultProps, "en"))))
            .map((def) => def.type);
        expect(spanish).toEqual([]);
    });

    it("built-in pattern text follows the language too", () => {
        const intro = PATTERNS.find((p) => p.id === "intro")!;
        const texts = intro.blocks.map((b) => localizedDefaults(b.props, "en"));
        expect(JSON.stringify(texts)).not.toMatch(SPANISH);
        expect(starterText("Saber más", "en")).toBe("Learn more");
    });
});

describe("plugin block names", () => {
    it("a block without `label` gets its id split into words", () => {
        expect(humanizeBlockType("ReadingList")).toBe("Reading List");
        expect(humanizeBlockType("FAQSection")).toBe("FAQ Section");
        expect(humanizeBlockType("my_block")).toBe("My block");
        const render = () => null;
        expect(adaptPluginBlock("ReadingList", { render })!.label).toBe("Reading List");
        expect(adaptPluginBlock("ReadingList", { render, label: "  " })!.label).toBe("Reading List");
    });

    it("an explicit `label` wins", () => {
        expect(adaptPluginBlock("ReadingList", { render: () => null, label: "Reading list" })!.label).toBe("Reading list");
    });
});
