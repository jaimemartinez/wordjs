/**
 * ONE FORM KIT FOR THE ADMIN — the gate (scripts/form-controls-gate.mjs).
 *
 * Every IN-scope file is counted exactly (TypeScript parser) and compared with formControlsAllowlist.json,
 * which only shrinks: each migration batch lowers or deletes its files' entries, and nothing may add a raw
 * <input>/<select>/<textarea>/<button> back. ESLint enforces the same rule on every file that is not on
 * the allowlist, so a new admin file starts at zero.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
    ALLOWLIST_FILE, EXCLUDE, SRC, countRawControls, eslintGlobs, inScope, readAllowlist, scan,
} from "../../../../scripts/form-controls-gate.mjs";

const allow = readAllowlist() as Record<string, number>;
const counts = scan() as Record<string, number>;

describe("the counter is exact", () => {
    it("counts raw intrinsic controls only — not the kit's components, nor text that merely mentions them", () => {
        const src = `
            // <button> in a comment
            const s = "<input>";
            export default function F() {
                return (<form>
                    <button type="submit">ok</button>
                    <input value={s} />
                    <Button>kit</Button><Input /><select><option /></select>
                    <textarea />
                    {/* <button /> */}
                </form>);
            }`;
        expect(countRawControls(src)).toBe(4);
    });
});

describe("the allowlist only shrinks", () => {
    it("every IN-scope file has exactly its allowlisted count (above: a regression; below: lower the entry)", () => {
        const problems: string[] = [];
        for (const [file, n] of Object.entries(counts)) {
            if (!(file in allow)) problems.push(`${file}: ${n} raw control(s) in a file that must have none — use @/components/ui`);
            else if (n > allow[file]) problems.push(`${file}: ${n} raw control(s), the allowlist permits ${allow[file]} — use @/components/ui`);
        }
        for (const [file, n] of Object.entries(allow)) {
            const now = counts[file] ?? 0;
            if (now < n) problems.push(`${file}: down to ${now} — lower its entry in formControlsAllowlist.json to ${now}${now === 0 ? " (delete it)" : ""}`);
        }
        expect(problems).toEqual([]);
    });

    it("no entry is zero, every entry is an existing IN-scope file, and the file is sorted", () => {
        for (const [file, n] of Object.entries(allow)) {
            expect(n, file).toBeGreaterThan(0);
            expect(inScope(file), `${file} is not under the gate`).toBe(true);
            expect(fs.existsSync(path.join(SRC, file)), `${file} does not exist`).toBe(true);
        }
        const keys = Object.keys(allow);
        expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
        expect(fs.readFileSync(ALLOWLIST_FILE, "utf8").endsWith("\n")).toBe(true);
    });
});

describe("the scope", () => {
    it("covers the admin, the sign-in and system screens, and the admin's components", () => {
        for (const f of ["app/admin/page.tsx", "app/login/page.tsx", "app/install/page.tsx", "app/reset-password/page.tsx",
            "components/Sidebar.tsx", "components/verso/editor/VersoEditor.tsx", "components/versoConfig.tsx"]) {
            expect(inScope(f), f).toBe(true);
        }
    });

    it("leaves out the kit itself and everything rendered in the visitor's theme (a theme never ships admin JS)", () => {
        for (const f of ["components/ui/Button.tsx", "app/(public)/page.tsx", "components/content/TabsBlock.tsx", "components/public/Header.tsx",
            "components/chrome/ChromeSearch.tsx", "components/blocks/FormBlock.tsx", "components/CommentsSection.tsx",
            "lib/verso/coreBlocks.tsx", "app/error.tsx", "app/admin/__tests__/x.test.tsx"]) {
            expect(inScope(f), f).toBe(false);
        }
        for (const f of Object.keys(allow)) expect(EXCLUDE.some((p: string) => f.startsWith(p) || f === p), f).toBe(false);
    });

    it("ESLint reads the same scope and allowlist", () => {
        const config = fs.readFileSync(path.resolve(SRC, "..", "eslint.config.mjs"), "utf8");
        expect(config).toContain('import { eslintGlobs } from "./scripts/form-controls-gate.mjs"');
        expect(config).toContain("JSXOpeningElement[name.name=/^(input|select|textarea|button)$/]");
        const { files, ignores } = eslintGlobs(allow);
        expect(files).toContain("src/app/admin/**/*.{tsx,jsx}");
        expect(ignores).toContain("src/components/ui/**/*.{tsx,jsx}");
        for (const f of Object.keys(allow)) expect(ignores).toContain(`src/${f.replace(/[[\]]/g, "[$&]")}`);
        // users/[id]: brackets matched literally, not as a character class
        expect(ignores).toContain("src/app/admin/users/[[]id[]]/page.tsx");
    });
});
