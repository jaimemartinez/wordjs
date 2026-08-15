import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * PLUGIN → theme-manifest trust edge (OLA 6 / F5). A plugin may DECLARE its themable block surfaces
 * in its manifest.json under `themeSurfaces`; the generator merges the namespace-validated ones into
 * backend/public/theme-tokens.json as `plugin:<slug>:<element>` elements, and a theme styles them
 * exactly like any framework element.
 *
 * Two things must hold and are proven here, at the same strength as the chrome contract:
 *
 *   1. SECURITY — the namespace validator is the load-bearing control. A plugin may name ONLY classes
 *      under its own derived prefix `.wjs-p-<slug>-`; a selector claiming a framework class, a bare tag,
 *      an id/attribute selector, or another plugin's prefix is REJECTED. These are mutation tests: each
 *      hostile selector must fail, or the boundary is a fiction.
 *
 *   2. PROMISE-VS-MARKUP — every class a declared surface promises must actually be EMITTED by that
 *      plugin's block markup (a className string), and the built manifest must carry the declared
 *      surface. A promise the plugin never renders is a dead selector; a manifest out of sync with the
 *      declaration is a stale regeneration. Both go red here.
 */

const REPO = path.resolve(__dirname, '../../../..');
const MANIFEST = path.join(REPO, 'backend/public/theme-tokens.json');
const VALIDATOR = path.join(REPO, 'scripts/plugin-theme-surfaces.js');
const PLUGINS_DIR = path.join(REPO, 'marketplace/plugins');

// The generator's OWN validator, required (not re-typed) so this test cannot drift from the rule the
// build enforces. CommonJS, outside the frontend package → createRequire; it has no side effects.
const { validateSelector, validateThemeSurfaces, requiredPrefix, collectPluginThemeElements } =
    createRequire(VALIDATOR)(VALIDATOR) as {
        validateSelector: (slug: string, selector: string, where: string) => string[];
        validateThemeSurfaces: (slug: string, surfaces: unknown) => { elements: Record<string, { selector: string; children?: Record<string, { selector: string }> }>; errors: string[] };
        requiredPrefix: (slug: string) => string;
        collectPluginThemeElements: (dir: string) => { elements: Record<string, unknown>; errors: string[] };
    };

// Comments are not markup (same reason as chromeSelectorContract): a class named only in a comment
// must not satisfy the grep. Naive on purpose — can only cause a false FAILURE, never a false pass.
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

type Surface = { element: string; selector: string; children?: Record<string, { selector: string }> };
type PluginDecl = { slug: string; surfaces: Surface[]; markup: string };

// Every committed plugin that declares themeSurfaces, with its block markup source read for the
// promise-vs-markup check.
function readDeclaringPlugins(): PluginDecl[] {
    const out: PluginDecl[] = [];
    if (!fs.existsSync(PLUGINS_DIR)) return out;
    for (const slug of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
        const manifestPath = path.join(PLUGINS_DIR, slug, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        let m: { id?: string; themeSurfaces?: Surface[]; frontend?: { puckComponents?: { entry?: string } } };
        try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }
        if (!Array.isArray(m.themeSurfaces) || m.themeSurfaces.length === 0) continue;
        // Read the plugin's Puck block source — that is where the classes must actually be emitted.
        const entry = m.frontend?.puckComponents?.entry;
        let markup = '';
        if (entry) {
            const p = path.join(PLUGINS_DIR, slug, entry);
            if (!fs.existsSync(p)) throw new Error(`[${slug}] puckComponents entry does not exist: ${entry}`);
            markup = stripComments(fs.readFileSync(p, 'utf8'));
        }
        out.push({ slug, surfaces: m.themeSurfaces, markup });
    }
    return out;
}

describe('plugin theme-surface namespace enforcement (the safety property)', () => {
    const slug = 'faq';
    const prefix = requiredPrefix(slug);

    it('accepts a selector under the plugin\'s own derived prefix', () => {
        expect(validateSelector(slug, `${prefix}item`, 'x')).toEqual([]);
        expect(validateSelector(slug, `${prefix}item ${prefix}icon`, 'x')).toEqual([]);
        expect(validateSelector(slug, `${prefix}item--open`, 'x')).toEqual([]);
    });

    // ── MUTATION: every one of these hostile shapes MUST be refused ──────────────────────────────────
    // If any returns [] the namespace boundary has a hole — a plugin could claim a surface it does not
    // own and inject an unvalidated selector into the manifest a theme trusts.
    const hostile: [string, string][] = [
        ['a framework block class', '.wp-block-heading'],
        ['a framework block child', '.wp-block-accordion__item'],
        ['chrome', '.wjs-header'],
        ['a public surface', '.wjs-post-card'],
        ['another plugin\'s prefix', '.wjs-p-newsletter-form'],
        ['a bare tag', 'div'],
        ['a tag compounded with an owned class', `div${prefix}item`],
        ['body', 'body'],
        ['an id', '#hero'],
        ['an attribute selector', `${prefix}item[data-open]`],
        ['the universal selector', '*'],
        ['a pseudo-class', `${prefix}item:hover`],
        ['a selector list smuggling a foreign class', `${prefix}item, .wp-block-heading`],
        ['a descendant reaching a foreign class', `${prefix}item .wp-block-heading`],
        ['the bare prefix with nothing after', prefix],
    ];
    it.each(hostile)('rejects %s', (_label, selector) => {
        expect(validateSelector(slug, selector, 'x').length).toBeGreaterThan(0);
    });

    it('rejects a whole declaration that names a framework class, and refuses the element', () => {
        const { elements, errors } = validateThemeSurfaces('faq', [
            { element: 'item', selector: '.wp-block-heading' },
        ]);
        expect(errors.length).toBeGreaterThan(0);
        expect(elements['plugin:faq:item']).toBeUndefined(); // never lands when its selector is invalid
    });

    it('rejects a child key that collides with a compiler reserved nesting name', () => {
        const { errors } = validateThemeSurfaces('faq', [
            { element: 'item', selector: `${prefix}item`, children: { hover: { selector: `${prefix}item` } } },
        ]);
        expect(errors.some((e) => /reserved nesting name/.test(e))).toBe(true);
    });

    it('rejects an unknown top-level key in a surface (a typo must not pass silently)', () => {
        const { errors } = validateThemeSurfaces('faq', [
            { element: 'item', selector: `${prefix}item`, selctor: `${prefix}item` } as unknown as Surface,
        ]);
        expect(errors.some((e) => /unknown key "selctor"/.test(e))).toBe(true);
    });
});

describe('plugin selector contract (promise vs markup vs manifest)', () => {
    const plugins = readDeclaringPlugins();
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

    it('at least one committed plugin declares themeSurfaces (guards an empty-suite false pass)', () => {
        expect(plugins.length).toBeGreaterThanOrEqual(1);
    });

    // The declared surfaces must all be namespace-valid — the same collect the generator runs, over the
    // real committed catalog, must produce zero errors (a shipped plugin with an invalid declaration is
    // a build failure, so it must also be a test failure).
    it('the committed catalog collects with no namespace errors', () => {
        const { errors } = collectPluginThemeElements(PLUGINS_DIR);
        expect(errors).toEqual([]);
    });

    for (const { slug, surfaces, markup } of plugins) {
        // Flatten every declared class across every surface + child.
        const classChecks: [string, string][] = [];
        for (const s of surfaces) {
            const push = (sel: string) => {
                for (const m of sel.match(/\.wjs-p-[a-z0-9-]+/gi) || []) classChecks.push([`${slug}:${s.element}`, m.slice(1)]);
            };
            push(s.selector);
            for (const cd of Object.values(s.children || {})) push(cd.selector);
        }

        it.each(classChecks)(`[${slug}] class %s -> %s is emitted by the block markup`, (_where, className) => {
            // Word-boundary match: `.wjs-p-faq-item` in the CSS-in-JS is preceded by a dot (not matched),
            // so only a real className string counts — the class must be RENDERED, not merely styled.
            const re = new RegExp(`(^|[\\s"'\`])${className}([\\s"'\`$]|$)`, 'm');
            expect(re.test(markup), `${className} is promised by plugin "${slug}" but never emitted in its markup`).toBe(true);
        });

        it(`[${slug}] every declared surface is present in the built manifest with the same selector`, () => {
            for (const s of surfaces) {
                const key = `plugin:${slug}:${s.element}`;
                const el = manifest.elements[key];
                expect(el, `manifest is missing ${key} — regenerate theme-tokens.json`).toBeTruthy();
                expect(el.selector).toBe(s.selector);
                for (const [child, cd] of Object.entries(s.children || {})) {
                    expect(el.children?.[child]?.selector, `manifest ${key}.${child} missing or renamed`).toBe(cd.selector);
                }
            }
        });
    }
});
