/**
 * conference-manager 2.31.1 — no browser-native dialog anywhere in the plugin's interface. alert(), confirm()
 * and prompt() block the page, ignore the app's language and theme, and are suppressed by embedded browsers
 * (a confirm() there answers «no» without ever being shown). Every question goes through an in-app dialog: the
 * host's useModal() (ModalContext) or a page's own promise-based sheet.
 *
 * The sweep: every source file of the plugin's client (admin and portal; the vendored QR reader aside) —
 *   - never `window.alert(` / `window.confirm(` / `window.prompt(` / `globalThis.…`;
 *   - never a bare `alert(` or `prompt(` call;
 *   - a bare `confirm(` only in a file that defines its own `confirm` (useModal(), a local promise-based one, or
 *     a `confirm` it receives as a prop/argument), so it can never fall through to the global.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');

function sources(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor') out.push(...sources(p)); continue; }
        if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
    }
    return out;
}

/** The code without comments and string/template contents, so prose about the rule never trips it. */
function codeOf(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
        .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
        .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

const FILES = sources(CLIENT);

describe('conference-manager: no browser-native dialog', () => {
    it('the sweep reaches the admin and the portal', () => {
        const rel = FILES.map((f) => path.relative(CLIENT, f).replace(/\\/g, '/'));
        expect(rel).toContain('admin/page.tsx');
        expect(rel).toContain('admin/BadgeEditor.tsx');
        expect(rel).toContain('portal/CoordinatorPortal.tsx');
        expect(rel.some((f) => f.startsWith('lib/vendor/'))).toBe(false);
    });

    it('no window.alert / confirm / prompt, and no bare alert() or prompt()', () => {
        const offenders: string[] = [];
        for (const f of FILES) {
            const code = codeOf(fs.readFileSync(f, 'utf8'));
            code.split('\n').forEach((line, i) => {
                if (/\b(?:window|globalThis|self)\s*\.\s*(?:alert|confirm|prompt)\s*\(/.test(line)
                    || /(?:^|[^.\w$])(?:alert|prompt)\s*\(/.test(line)) {
                    offenders.push(`${path.relative(CLIENT, f)}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        expect(offenders).toEqual([]);
    });

    it('a bare confirm() is always the file\'s own in-app confirm', () => {
        const offenders: string[] = [];
        for (const f of FILES) {
            const code = codeOf(fs.readFileSync(f, 'utf8'));
            if (!/(?:^|[^.\w$])confirm\s*\(/m.test(code)) continue;
            const defines = /\{\s*confirm\s*\}\s*=\s*useModal\(\)|\bconst\s+confirm\s*=|[{,(]\s*confirm\s*[,}:)]/.test(code);
            if (!defines) offenders.push(path.relative(CLIENT, f));
        }
        expect(offenders).toEqual([]);
    });

    it('the badge designer asks before replacing a design with a template through the host dialog', () => {
        const src = fs.readFileSync(path.join(CLIENT, 'admin/BadgeEditor.tsx'), 'utf8');
        expect(src).toContain('const { confirm } = useModal();');
        expect(src).toMatch(/const applyTemplate = async \(t: any\) => \{\r?\n\s+if \(d\.elements\.length > 1 && !await confirm\(/);
    });
});
