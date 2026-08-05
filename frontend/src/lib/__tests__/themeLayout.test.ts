import { describe, it, expect } from 'vitest';
import { parseThemeLayout } from '../themeLayout';

// The normalized defaults are the contract for default-parity: with no `layout` (or garbage), the
// chrome must render exactly today's markup, so every default here mirrors the hard-coded rendering.
const DEFAULTS = {
    header: { variant: 'classic', sticky: true, transparent: false },
    footer: { variant: 'columns', columns: 4 },
    sidebar: { enabled: false, position: 'right' },
    containerWidth: null,
};

describe('parseThemeLayout', () => {
    it('returns exact defaults when layout is absent or empty', () => {
        expect(parseThemeLayout(undefined)).toEqual(DEFAULTS);
        expect(parseThemeLayout(null)).toEqual(DEFAULTS);
        expect(parseThemeLayout({})).toEqual(DEFAULTS);
    });

    it('passes a fully valid config through', () => {
        expect(parseThemeLayout({
            header: { variant: 'centered', sticky: false, transparent: true },
            footer: { variant: 'minimal', columns: 2 },
            sidebar: { position: 'left' },
            containerWidth: '72rem',
        })).toEqual({
            header: { variant: 'centered', sticky: false, transparent: true },
            footer: { variant: 'minimal', columns: 2 },
            sidebar: { enabled: true, position: 'left' },
            containerWidth: '72rem',
        });
    });

    it('accepts partial configs, defaulting the missing keys', () => {
        const cfg = parseThemeLayout({ header: { variant: 'minimal' }, footer: { columns: 3 } });
        expect(cfg.header).toEqual({ variant: 'minimal', sticky: true, transparent: false });
        expect(cfg.footer).toEqual({ variant: 'columns', columns: 3 });
        expect(cfg.sidebar).toEqual(DEFAULTS.sidebar);
    });

    it('maps the legacy boolean sidebar (and its historical "true" string)', () => {
        expect(parseThemeLayout({ sidebar: true }).sidebar).toEqual({ enabled: true, position: 'right' });
        expect(parseThemeLayout({ sidebar: 'true' }).sidebar).toEqual({ enabled: true, position: 'right' });
        expect(parseThemeLayout({ sidebar: false }).sidebar).toEqual({ enabled: false, position: 'right' });
        // Object form defaults its position to right (≡ legacy true).
        expect(parseThemeLayout({ sidebar: {} }).sidebar).toEqual({ enabled: true, position: 'right' });
    });

    it('silently falls back to defaults on invalid values (the doctor reports them)', () => {
        expect(parseThemeLayout({
            header: { variant: 'mega', sticky: 'nope', transparent: 'yes' },
            footer: { variant: 'stacked', columns: 7 },
            sidebar: { position: 'top' },
            containerWidth: 42,
        })).toEqual({
            ...DEFAULTS,
            // An object sidebar is still a sidebar request — only its bad position falls back.
            sidebar: { enabled: true, position: 'right' },
        });
        // Numeric-string columns are invalid too (the schema wants an integer).
        expect(parseThemeLayout({ footer: { columns: '2' } }).footer.columns).toBe(4);
    });

    // containerWidth reaches an INLINE style (max-width on <main>), so it is the one string value a
    // theme controls end-to-end: it must be a CSS length and nothing else.
    it('accepts plain CSS lengths, percentages and a simple calc() for containerWidth', () => {
        for (const width of ['72rem', '1200px', '100%', '90vw', '48.5em', '80VH', 'calc(100% - 2rem)', 'calc((100% - 4rem)/2)']) {
            expect(parseThemeLayout({ containerWidth: width }).containerWidth).toBe(width);
        }
        // Surrounding whitespace is trimmed, not rejected.
        expect(parseThemeLayout({ containerWidth: '  72rem  ' }).containerWidth).toBe('72rem');
    });

    it('drops a containerWidth that could smuggle CSS into the inline style', () => {
        for (const width of [
            '72rem; background: url(http://evil.example/x)',
            '100px}body{display:none',
            'url(http://evil.example/x)',
            'var(--anything)',
            'expression(alert(1))',
            'calc(100%) ; color: red',
            'calc(url(x))',
            'calc()',
            'calc(1e3px)',
            '/* */72rem',
            '72',           // unitless
            'auto',         // keyword, not a length
            '-10px',        // negative max-width
            'a'.repeat(65) + 'px',
            // A long digit run ending in garbage: the reject must be immediate (no backtracking blowup).
            `calc(${'9'.repeat(40)}!)`,
        ]) {
            expect(parseThemeLayout({ containerWidth: width }).containerWidth).toBe(null);
        }
    });

    it('ignores non-object shapes entirely', () => {
        expect(parseThemeLayout('nonsense')).toEqual(DEFAULTS);
        expect(parseThemeLayout([])).toEqual(DEFAULTS);
        expect(parseThemeLayout({ header: [], footer: 3, sidebar: [] })).toEqual(DEFAULTS);
    });
});
