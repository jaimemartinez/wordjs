/**
 * THE MARKETPLACE PLUGINS' CLIENT CODE IS LINTED, AND ITS BASELINE ONLY SHRINKS (FALLOS 146).
 *
 * `npm run lint` covered only frontend/, so an unused import in marketplace/plugins/<slug>/client was first
 * caught by CodeQL after the push. scripts/lint-marketplace-clients.mjs lints that code as part of
 * `npm run lint`, with the existing unused-variable hits held by marketplace/lint-baseline.json.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { compare, lintCounts } from "../../../scripts/lint-marketplace-clients.mjs";

describe("marketplace client lint gate", () => {
    it("a file above its entry, or not listed, fails; a file below its entry fails until it is lowered", () => {
        expect(compare({ "a.tsx": 1 }, {})).toHaveLength(1);
        expect(compare({ "a.tsx": 2 }, { "a.tsx": 1 })).toHaveLength(1);
        expect(compare({ "a.tsx": 1 }, { "a.tsx": 1 })).toEqual([]);
        expect(compare({}, { "a.tsx": 1 })[0]).toMatch(/delete it/);
        expect(compare({ "a.tsx": 1 }, { "a.tsx": 2 })[0]).toMatch(/lower its entry/);
    });

    it("runs as part of `npm run lint`, and the code on disk matches the baseline", async () => {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"));
        expect(pkg.scripts.lint).toContain("node scripts/lint-marketplace-clients.mjs");
        const baseline = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../marketplace/lint-baseline.json"), "utf8"));
        const { counts, others, files } = await lintCounts();
        expect(files).toBeGreaterThan(50);
        expect(others).toEqual([]);
        expect(compare(counts, baseline)).toEqual([]);
    }, 120000);
});
