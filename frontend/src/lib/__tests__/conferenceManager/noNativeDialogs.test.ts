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
 *
 * Nor the browser's validation bubble («Completa este campo»), which is native too: every <form> of the plugin
 * is `noValidate` (directly or through useFieldErrors().form), and every `required` field carries a
 * `data-field` key so its message is shown in-app, under the field (lib/useFieldErrors.tsx).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fieldMessage, invalidFields } from '../../../../../marketplace/plugins/conference-manager/client/lib/fieldErrors';

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

    it('no browser validation bubble: every form is noValidate', () => {
        const offenders: string[] = [];
        let forms = 0;
        for (const f of FILES) {
            const code = codeOf(fs.readFileSync(f, 'utf8'));
            const re = /<form\b/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(code))) {
                // The opening tag: up to the next JSX element (its attributes may hold arrow functions).
                const rest = code.slice(m.index + 5);
                const next = rest.search(/\n\s*<[A-Za-z]/);
                const tag = next < 0 ? rest : rest.slice(0, next);
                forms++;
                if (!/\bnoValidate\b|\.form\(/.test(tag)) offenders.push(`${path.relative(CLIENT, f)}:${code.slice(0, m.index).split('\n').length}`);
            }
        }
        expect(forms).toBeGreaterThan(10);
        expect(offenders).toEqual([]);
    });

    it('no bare required: every required input / select / textarea has an in-app error key', () => {
        const offenders: string[] = [];
        let seen = 0;
        for (const f of FILES) {
            const code = codeOf(fs.readFileSync(f, 'utf8'));
            const re = /\srequired(?=[\s>={/])/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(code))) {
                const before = code.slice(0, m.index);
                const open = before.search(/<[A-Za-z][\w.]*[^<]*$/);
                if (open < 0) continue;
                const tagName = (before.slice(open).match(/^<([\w.]+)/) || [])[1];
                if (!/^(input|select|textarea)$/.test(tagName)) continue; // a component's own `required` prop
                seen++;
                const after = code.slice(m.index);
                const end = after.search(/\/>|>\s*\n/);
                const tag = before.slice(open) + (end < 0 ? after : after.slice(0, end));
                if (!/\bdata-field=/.test(tag)) offenders.push(`${path.relative(CLIENT, f)}:${before.split('\n').length}`);
            }
        }
        expect(seen).toBeGreaterThan(10);
        expect(offenders).toEqual([]);
    });

    describe('the in-app field messages (lib/fieldErrors.ts)', () => {
        const validity = (v: Partial<ValidityState>) => ({ valueMissing: false, badInput: false, rangeUnderflow: false, rangeOverflow: false, typeMismatch: false, tooShort: false, ...v }) as ValidityState;
        const field = (v: Partial<ValidityState>, attrs: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
            willValidate: true,
            validity: validity(v),
            checkValidity: () => !Object.values(v).some(Boolean),
            getAttribute: (n: string) => attrs[n] ?? null,
            ...extra,
        });

        it('says what is wrong, in es / en / pt', () => {
            expect(fieldMessage(field({ valueMissing: true }), 'es')).toBe('Este campo es obligatorio.');
            expect(fieldMessage(field({ valueMissing: true }), 'en')).toMatch(/required/i);
            expect(fieldMessage(field({ valueMissing: true }), 'pt')).toMatch(/obrigatório/i);
            expect(fieldMessage(field({ rangeUnderflow: true }, { min: '1' }), 'es')).toBe('El valor mínimo es 1.');
            expect(fieldMessage(field({ rangeOverflow: true }, { max: '10' }), 'en')).toContain('10');
            expect(fieldMessage(field({ badInput: true }, {}, { type: 'number' }), 'es')).toBe('Escribe un número.');
            expect(fieldMessage(field({ typeMismatch: true }, {}, { type: 'email' }), 'es')).toBe('Escribe un correo válido.');
        });

        it('lists the invalid fields in order, keyed by data-field, then name, then id', () => {
            const els = [
                field({}, { 'data-field': 'ok' }),
                field({ valueMissing: true }, { 'data-field': 'hotel_name' }),
                { ...field({ valueMissing: true }), willValidate: false },
                field({ rangeUnderflow: true }, { min: '1' }, { name: 'capacity' }),
                field({ valueMissing: true }, {}, { id: 'fee-date' }),
            ];
            expect(invalidFields(els, 'es').map((x) => [x.key, x.message])).toEqual([
                ['hotel_name', 'Este campo es obligatorio.'],
                ['capacity', 'El valor mínimo es 1.'],
                ['fee-date', 'Este campo es obligatorio.'],
            ]);
        });
    });
});
