/**
 * Every form on the admin form kit still submits.
 *
 * The kit's buttons default to type="button" (a button added inside a form never submits it by accident),
 * so a screen moved to the kit must say which button submits: without one, Enter in a field and a click on
 * «Save» both do nothing. For every in-scope file the gate holds at zero raw controls (it is fully on the kit),
 * each JSX <form> must contain an element with type="submit". Files still on the allowlist keep raw buttons,
 * which submit by default, and join this check as their batch moves them.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SRC, readAllowlist, scopeFiles } from "../../../../scripts/form-controls-gate.mjs";

const allow = readAllowlist() as Record<string, number>;
const onTheKit = (scopeFiles() as string[]).filter((f) => !(f in allow));

/** The <form> elements of a source whose subtree has no element with type="submit". */
function formsWithoutSubmit(source: string, fileName: string): number[] {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const missing: number[] = [];
    const hasSubmit = (node: ts.Node): boolean => {
        if (ts.isJsxAttribute(node) && node.name.getText(sf) === "type" && node.initializer
            && ts.isStringLiteral(node.initializer) && node.initializer.text === "submit") return true;
        return ts.forEachChild(node, hasSubmit) ?? false;
    };
    const visit = (node: ts.Node) => {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === "form" && !hasSubmit(node)) {
            missing.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return missing;
}

describe("forms on the kit say which button submits them", () => {
    it("the check finds a form without a submit, and accepts one with a kit or raw submit", () => {
        expect(formsWithoutSubmit(`const a = <form onSubmit={f}><Input /><Button>Save</Button></form>;`, "a.tsx")).toEqual([1]);
        expect(formsWithoutSubmit(`const a = <form onSubmit={f}><Input /><Button type="submit">Save</Button></form>;`, "a.tsx")).toEqual([]);
        expect(formsWithoutSubmit(`const a = <form><button type="submit">ok</button></form>;`, "a.tsx")).toEqual([]);
    });

    it("every <form> of every file fully on the kit has an explicit submit", () => {
        expect(onTheKit.length).toBeGreaterThan(10);
        const problems: string[] = [];
        for (const rel of onTheKit) {
            const src = fs.readFileSync(path.join(SRC, rel), "utf8");
            if (!src.includes("<form")) continue;
            for (const line of formsWithoutSubmit(src, rel)) problems.push(`${rel}:${line}`);
        }
        expect(problems).toEqual([]);
    });

    it("this batch's forms are among them", () => {
        for (const f of ["app/admin/security/page.tsx", "app/admin/security/AutoRenewalPanel.tsx", "app/admin/security/ServerSettingsPanel.tsx", "app/login/page.tsx"]) {
            expect(onTheKit, f).toContain(f);
        }
    });
});
