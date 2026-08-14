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

// Individual public-surface components that live OUTSIDE those trees. Listed one by one rather than
// widening the walk to all of frontend/src/components: that directory is mostly ADMIN markup, and a
// selector "found" in the admin UI would be a false pass — the manifest only promises public surfaces.
const SOURCE_FILES = [
    'frontend/src/components/CommentsSection.tsx',
];

/**
 * Comments are NOT markup. A selector named only in a code comment — `wjs-content`, say, written
 * while explaining why a class was not added — satisfied the grep below and let the manifest promise
 * a selector that matches zero elements. That is the precise failure this file exists to catch, so
 * comments come out before anything is searched.
 *
 * Deliberately naive: this strips `//…`, `/*…*` + `/` and nothing else. It can mangle a `//` inside a
 * string literal, which for THIS test only risks a false FAILURE (a class that is emitted looking
 * absent) — never a false pass. Erring that way round is the whole point.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readSources(): string {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.tsx?$/.test(e.name)) out.push(stripComments(fs.readFileSync(p, 'utf8')));
        }
    };
    for (const d of SOURCE_DIRS) walk(path.join(REPO, d));
    for (const f of SOURCE_FILES) {
        const p = path.join(REPO, f);
        // A listed file that has moved would silently stop being scanned, so fail loudly instead.
        if (!fs.existsSync(p)) throw new Error(`SOURCE_FILES entry does not exist: ${f}`);
        out.push(stripComments(fs.readFileSync(p, 'utf8')));
    }
    return out.join('\n');
}

describe('chrome selector contract', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const sources = readSources();

    // Only the .wjs-* chrome entries: the .wp-block-* ones come from wordjs-ui.css, which the
    // generator scrapes — those cannot be promised without existing. `footer` is a bare tag name.
    // CHILDREN ARE CHECKED TOO. This used to read only each element's own `selector`, which left the
    // named composites — chromeFooter.socialLink, chromeHeader.logoText, … — promised to theme authors
    // and verified by nothing. That is the same gap this file was written to close, one level down.
    //
    // And a chrome selector is no longer necessarily a single class: a composite like
    // `.wjs-chrome-footer .wjs-chrome-row > .wjs-chrome-text` scopes a part to its container, so the
    // check is per CLASS TOKEN. (The previous version did `selector.slice(1)` and searched the whole
    // string as one class name, which silently failed the moment a compound selector appeared.)
    const chromeSelectors: (readonly [string, string])[] = [];
    for (const [name, def] of Object.entries(manifest.elements as Record<string, { selector: string; children?: Record<string, { selector: string }> }>)) {
        if (def.selector && def.selector.startsWith('.wjs-')) chromeSelectors.push([name, def.selector] as const);
        for (const [child, cd] of Object.entries(def.children || {})) {
            if (cd.selector && cd.selector.includes('.wjs-')) chromeSelectors.push([`${name}.${child}`, cd.selector] as const);
        }
    }

    it('has chrome entries to check (guards against an empty-filter false pass)', () => {
        expect(chromeSelectors.length).toBeGreaterThanOrEqual(3);
        // The composites must be in scope, or this file is back to checking only the easy half.
        expect(chromeSelectors.some(([n]) => n.includes('.'))).toBe(true);
    });

    // The manifest now names the four PUBLIC CONTENT surfaces too — blog roll, search results, the
    // single post's meta row, the comment thread — which until then had no framework class at all and
    // so could not be styled by a theme except through Tailwind utilities. Those hooks are `className`
    // strings in React with nothing else referencing them: delete one while renaming and the manifest
    // keeps promising a selector that matches zero elements, which is the exact failure this file
    // exists to catch. Asserting the ELEMENT KEYS are present is what keeps them inside the walk above
    // — dropping a seed would otherwise just shrink the it.each list and still pass green.
    it('covers the public content surfaces, not just the chrome', () => {
        const names = new Set(chromeSelectors.map(([n]) => n));
        for (const required of [
            'postList', 'postCard', 'postCard.title', 'postCard.excerpt', 'postCard.meta',
            'searchResults', 'searchResult', 'searchResult.title', 'searchForm',
            'singlePost', 'postMeta', 'postMeta.author',
            'comments', 'comments.form', 'comment', 'comment.author', 'comment.content',
        ]) {
            expect(names.has(required), `manifest element "${required}" is missing — the public-surface hooks are no longer covered`).toBe(true);
        }
    });

    it.each(chromeSelectors)('%s → %s is emitted by the chrome markup', (_name, selector) => {
        // Every .wjs-* class the selector names must exist in the chrome source. Bare tags (a, span,
        // input, button, nav) and combinators are structure, not promises — the framework's own markup
        // decides those, and a tag is not something a grep can meaningfully confirm.
        const classes = selector.match(/\.wjs-[a-z0-9-]+/gi) || [];
        expect(classes.length).toBeGreaterThan(0);
        for (const cls of classes) {
            const className = cls.slice(1);
            // Word-boundary match so `.wjs-header` is not "found" inside `wjs-header-logo`.
            const re = new RegExp(`(^|[\\s"'\`])${className}([\\s"'\`$]|$)`, 'm');
            expect(re.test(sources), `${className} is promised by the manifest but never emitted`).toBe(true);
        }
    });
});
