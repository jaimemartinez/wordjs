import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The token manifest (backend/public/theme-tokens.json) tells theme authors which elements they may
 * style: `styles.header` compiles to a rule on `.wjs-header`, `styles.nav` to `.wjs-header-nav`, and
 * so on. Those chrome selectors are SEEDED in the generator, not scraped from a stylesheet — nothing
 * verified that the React chrome ever emitted them.
 *
 * It didn't. `.wjs-header` was in the manifest, offered by the doctor, accepted by the compiler and
 * matched by nothing: every theme that declared a header style got a rule that silently applied to
 * zero elements. The child hooks (-logo, -nav, -container) were emitted all along, which is what made
 * the gap so easy to miss.
 *
 * So: every chrome selector the manifest promises must exist as a class in the chrome source. This is
 * a promise-vs-markup test, deliberately grep-shaped — a DOM test would only cover the one code path
 * it renders, and the header alone has three variants plus the composed slot.
 */

const REPO = path.resolve(__dirname, '../../../..');
const MANIFEST = path.join(REPO, 'backend/public/theme-tokens.json');

// Where chrome markup can legitimately live. The composed header/footer wrapper is in the public
// layout; the per-block classes are in components/chrome; the default chrome is in components/public.
const SOURCE_DIRS = [
    'frontend/src/components/chrome',
    'frontend/src/components/public',
    'frontend/src/app/(public)',
];

function readSources(): string {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.tsx?$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8'));
        }
    };
    for (const d of SOURCE_DIRS) walk(path.join(REPO, d));
    return out.join('\n');
}

describe('chrome selector contract', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const sources = readSources();

    // Only the .wjs-* chrome entries: the .wp-block-* ones come from wordjs-ui.css, which the
    // generator scrapes — those cannot be promised without existing. `footer` is a bare tag name.
    const chromeSelectors = Object.entries(manifest.elements as Record<string, { selector: string }>)
        .map(([name, def]) => [name, def.selector] as const)
        .filter(([, selector]) => selector.startsWith('.wjs-'));

    it('has chrome entries to check (guards against an empty-filter false pass)', () => {
        expect(chromeSelectors.length).toBeGreaterThanOrEqual(3);
    });

    it.each(chromeSelectors)('%s → %s is emitted by the chrome markup', (_name, selector) => {
        const className = selector.slice(1);
        // Word-boundary match so `.wjs-header` is not "found" inside `wjs-header-logo`.
        const re = new RegExp(`(^|[\\s"'\`])${className}([\\s"'\`$]|$)`, 'm');
        expect(re.test(sources)).toBe(true);
    });
});
