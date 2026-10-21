/**
 * White text on an editor accent fill must sit on --ed-primary-solid, never on --ed-primary.
 *
 * The two are the same indigo in the light scheme, but in the editor's dark scheme --ed-primary is a
 * light lavender (#aaa5ff, the accent for TEXT and outlines on dark surfaces) while --ed-primary-solid
 * is the fill (#6559d8). "Add comment" and the selected chips of the Appearance / Animation /
 * Visibility fields painted white on the lavender — 2.2:1.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
        if (e === "__tests__" || e === "node_modules") continue;
        const f = join(dir, e);
        if (statSync(f).isDirectory()) walk(f, out);
        else if (/\.tsx?$/.test(e)) out.push(f);
    }
    return out;
}

describe("editor accent fills", () => {
    it("white text never sits on the --ed-primary text accent", () => {
        const offenders: string[] = [];
        for (const file of walk(SRC)) {
            for (const m of readFileSync(file, "utf8").matchAll(/["'`][^"'`]*["'`]/g)) {
                const cls = m[0];
                if (/(^|\s|["'`])bg-\[var\(--ed-primary\)\](\s|["'`])/.test(cls) && /(^|\s)text-white\b/.test(cls)) {
                    offenders.push(`${file.slice(SRC.length + 1)}: ${cls.slice(0, 80)}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
