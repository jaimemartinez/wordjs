#!/usr/bin/env node
/* =============================================================================
 * generate-token-manifest.js — wordjs-ui.css → backend/public/theme-tokens.json
 * -----------------------------------------------------------------------------
 * Hand-rolled CSS scan (zero dependencies) over the token framework stylesheet.
 * A token exists if it is DECLARED in the top-level `:root` of ui.css or
 * CONSUMED through some `var(--wjs-...)`. Nested fallbacks count too:
 * `var(--wjs-a, var(--wjs-b, x))` records the fallback on --wjs-a AND registers
 * --wjs-b as consumed.
 *
 * DETERMINISM IS A CONTRACT (CI drift gate): token/element keys sorted
 * alphabetically, consumers in file order, no timestamps, no randomness —
 * the output must be byte-identical between runs on the same input.
 *
 * Usage: node scripts/generate-token-manifest.js
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.resolve(__dirname, '../backend/public/css/wordjs-ui.css');
const OUT_PATH = path.resolve(__dirname, '../backend/public/theme-tokens.json');
const SOURCE_REL = 'backend/public/css/wordjs-ui.css';
const TOKEN_PREFIX = '--wjs-';

// ── Alias zone ────────────────────────────────────────────────────────────────
// The `alias` flag is anchored to the "Visual-editor (Puck) block aliases"
// comment inside :root, NOT to the "value is exactly var()" shape alone: the
// canonical derived defaults earlier in :root (--wjs-color-heading,
// --wjs-color-link, --wjs-shadow-md, ...) are also plain var() remaps but ARE
// meant to be overridden by themes. Only the Puck-block remap zone is
// do-not-override for theme authors.
const ALIAS_ZONE_MARKER = 'Visual-editor (Puck) block aliases';

// Consumed by the React chrome via Tailwind arbitrary values — invisible to any
// CSS scan, so they are force-included in the manifest.
const CHROME_PHANTOM_TOKENS = [
    '--wjs-bg-footer',
    '--wjs-color-text-footer-main',
    '--wjs-color-text-footer-dim',
    '--wjs-bg-surface-glass',
];

// Seeded chrome entries for the future declarations layer (F3). A .wp-block-*
// entry with the same key keeps its platform selector; seeds only fill gaps.
// Chrome elements the .wp-block-* scan cannot discover.
//
// The block registry is derived by parsing wordjs-ui.css, which only works for surfaces the FRAMEWORK
// stylesheet actually styles. The composable chrome does not qualify: its hook classes (.wjs-chrome-*)
// are emitted by the React chrome components and styled there, so ui.css contains almost nothing for
// them and the parser sees nothing to register.
//
// The consequence was concrete: 10 of the 64 catalogue themes carry hand-written CSS purely because
// there was no NAME to say. One of them documents it in its own stylesheet — "the declarative `styles`
// registry has no entry for those hooks, so this is the seam." Seeding the names closes that seam for
// the rules a theme can express as an element (+ state); rules that need a combinator or a
// pseudo-element still cannot be said, and this does not pretend otherwise.
//
// A seed may be a bare selector string or { selector, children }. Children carry a FULL selector, so a
// part that appears inside both regions (a row, a text run) is scoped by its container here rather
// than by the theme writing a descendant selector itself — the whole point is that a theme names
// things and never writes a selector.
const CHROME_ELEMENT_SEEDS = {
    header: {
        selector: '.wjs-header',
        // UNSCOPED variants, because that is what the catalogue actually writes: `.wjs-header-nav a`
        // appears 22 times bare, never scoped to the chrome container. Functionally the scoped form
        // under chromeHeader is equivalent (the nav only exists there), but a theme should be able to
        // say the thing it means, and the shorter name is the one it reaches for.
        children: { actionButton: { selector: '.wjs-header-actions button' } },
    },
    logo: {
        selector: '.wjs-header-logo',
        children: { text: { selector: '.wjs-header-logo span' } }, // the wordmark — 6 themes
    },
    nav: {
        selector: '.wjs-header-nav',
        children: { link: { selector: '.wjs-header-nav a' } }, // the single most hand-written selector
    },
    footer: 'footer',
    // The chrome's own search field, unscoped — three themes style it without naming a region, because
    // the same field appears in the header and the footer and they want it to match.
    chromeSearch: {
        selector: '.wjs-chrome-search',
        children: { input: { selector: '.wjs-chrome-search input' } },
    },

    // The composed header's nav keeps the PLATFORM class `.wjs-header-nav` (ChromeNav emits it), not
    // `.wjs-chrome-nav` — two different classes in the same region, which is exactly why both get a name.
    headerNav: { selector: '.wjs-chrome-header .wjs-header-nav' },

    chromeHeader: {
        selector: '.wjs-chrome-header',
        children: {
            container: { selector: '.wjs-chrome-header .wjs-header-container' },
            logo: { selector: '.wjs-chrome-header .wjs-header-logo' },
            nav: { selector: '.wjs-chrome-header .wjs-chrome-nav' },
            navLink: { selector: '.wjs-chrome-header .wjs-header-nav a' },
            actions: { selector: '.wjs-chrome-header .wjs-header-actions' },
            button: { selector: '.wjs-chrome-header .wjs-chrome-button' },
            search: { selector: '.wjs-chrome-header .wjs-chrome-search' },
            searchInput: { selector: '.wjs-chrome-header .wjs-chrome-search input' },
            siteTitle: { selector: '.wjs-chrome-header .wjs-chrome-site-title' },
            socials: { selector: '.wjs-chrome-header .wjs-chrome-socials' },
            text: { selector: '.wjs-chrome-header .wjs-chrome-text' },
            row: { selector: '.wjs-chrome-header .wjs-chrome-row' },
            spacer: { selector: '.wjs-chrome-header .wjs-chrome-spacer' },
            mobilePanel: { selector: '.wjs-header-mobile-panel' },
            // Composites. The catalogue's hand-written CSS is dominated by a bare TAG under a hook
            // class — `a` 24 times, `span` 16, `input` 6 — because that is where the link, the wordmark
            // and the field actually live. Naming those composites is what lets a theme reach them
            // without writing a selector, and it is why the COMBINATOR lives here (framework-owned)
            // rather than in the theme's grammar.
            logoText: { selector: '.wjs-chrome-header .wjs-header-logo span' },
            siteTitleLink: { selector: '.wjs-chrome-header .wjs-chrome-site-title a' },
            siteTitleText: { selector: '.wjs-chrome-header .wjs-chrome-site-title span' },
            socialLink: { selector: '.wjs-chrome-header .wjs-chrome-socials a' },
            actionButton: { selector: '.wjs-chrome-header .wjs-header-actions button' },
            navHorizontal: { selector: '.wjs-chrome-header .wjs-chrome-nav-horizontal' },
            navVertical: { selector: '.wjs-chrome-header .wjs-chrome-nav-vertical' },
            rowNested: { selector: '.wjs-chrome-header .wjs-chrome-row .wjs-chrome-row' },
            mobilePanelLink: { selector: '.wjs-header-mobile-panel nav a' },
        },
    },
    chromeFooter: {
        selector: '.wjs-chrome-footer',
        children: {
            container: { selector: '.wjs-chrome-footer .wjs-footer-container' },
            nav: { selector: '.wjs-chrome-footer .wjs-chrome-nav' },
            navLink: { selector: '.wjs-chrome-footer .wjs-chrome-nav a' },
            button: { selector: '.wjs-chrome-footer .wjs-chrome-button' },
            search: { selector: '.wjs-chrome-footer .wjs-chrome-search' },
            searchInput: { selector: '.wjs-chrome-footer .wjs-chrome-search input' },
            siteTitle: { selector: '.wjs-chrome-footer .wjs-chrome-site-title' },
            socials: { selector: '.wjs-chrome-footer .wjs-chrome-socials' },
            text: { selector: '.wjs-chrome-footer .wjs-chrome-text' },
            row: { selector: '.wjs-chrome-footer .wjs-chrome-row' },
            spacer: { selector: '.wjs-chrome-footer .wjs-chrome-spacer' },
            // Same composites as the header (see there). socialLink and siteTitleLink are used by 10 of
            // 10 themes and rowNested by 7 — these are not speculative names, they are the selectors
            // every theme was already writing by hand.
            socials: { selector: '.wjs-chrome-footer .wjs-chrome-socials' },
            socialLink: { selector: '.wjs-chrome-footer .wjs-chrome-socials a' },
            siteTitleLink: { selector: '.wjs-chrome-footer .wjs-chrome-site-title a' },
            siteTitleText: { selector: '.wjs-chrome-footer .wjs-chrome-site-title span' },
            navHorizontal: { selector: '.wjs-chrome-footer .wjs-chrome-nav-horizontal' },
            navVertical: { selector: '.wjs-chrome-footer .wjs-chrome-nav-vertical' },
            rowNested: { selector: '.wjs-chrome-footer .wjs-chrome-row .wjs-chrome-row' },
            rowChild: { selector: '.wjs-chrome-footer .wjs-chrome-row > .wjs-chrome-row' },
            rowNestedText: { selector: '.wjs-chrome-footer .wjs-chrome-row .wjs-chrome-row > .wjs-chrome-text' },
            // The container's DIRECT rows. Themes reach for `> .wjs-chrome-row` (7 uses) and the nested
            // `> row > row` (5) to build the footer's column grid, and for `row + row` (4) to style
            // "every row after the first" — the divider idiom. Named here so the combinator stays
            // framework-owned; `containerRow.first` / `.last` now cover part of what `+` was doing.
            containerRow: { selector: '.wjs-chrome-footer .wjs-footer-container > .wjs-chrome-row' },
            containerRowNested: { selector: '.wjs-chrome-footer .wjs-footer-container > .wjs-chrome-row > .wjs-chrome-row' },
            containerRowAfterFirst: { selector: '.wjs-chrome-footer > .wjs-footer-container > .wjs-chrome-row + .wjs-chrome-row' },
        },
    },

    // ── Public content surfaces ───────────────────────────────────────────────
    // Same gap as the chrome, one floor down: the blog roll, the search results, the single post's
    // meta row and the comment thread are hardcoded React with Tailwind utilities and no framework
    // class, so ui.css contains nothing for them and the .wp-block-* scan finds nothing to register.
    // A theme therefore had NO NAME for the four surfaces a blog is mostly made of — the only handle
    // was a utility like `rounded-2xl`, which is unscoped and changes the next time anyone edits the
    // JSX. (The post BODY was the exception: it already carried `.wjs-content`.)
    //
    // The classes are appended alongside the Tailwind utilities and carry no styling of their own, so
    // the default render is unchanged; frontend/src/lib/__tests__/chromeSelectorContract.test.ts is
    // what keeps every name below matching a real element.
    postList: {
        selector: '.wjs-post-list',
        // NOTE: header/title/empty are UNSCOPED and are DOM siblings of `.wjs-post-list`, not
        // descendants — the roll's heading sits above the grid and the empty state replaces it. They
        // are grouped here because that is the surface a theme author means, and children carry a full
        // selector precisely so grouping can follow meaning rather than nesting (same reason
        // `header.actionButton` is the bare `.wjs-header-actions button`).
        children: {
            header: { selector: '.wjs-post-list-header' },
            title: { selector: '.wjs-post-list-title' },
            empty: { selector: '.wjs-post-list-empty' },
        },
    },
    postCard: {
        selector: '.wjs-post-card',
        children: {
            badge: { selector: '.wjs-post-card-badge' },
            body: { selector: '.wjs-post-card-body' },
            meta: { selector: '.wjs-post-card-meta' },
            titleLink: { selector: '.wjs-post-card-link' },
            title: { selector: '.wjs-post-card-title' },
            excerpt: { selector: '.wjs-post-card-excerpt' },
            more: { selector: '.wjs-post-card-more' },
        },
    },
    // `search` and `search-wrap` are already taken by the .wp-block-search registration (the Puck
    // block), hence the longer keys — a seed never overwrites a real block entry, it is skipped.
    searchPage: {
        selector: '.wjs-search-page',
        children: {
            header: { selector: '.wjs-search-header' },
            title: { selector: '.wjs-search-title' },
            summary: { selector: '.wjs-search-summary' },
            empty: { selector: '.wjs-search-empty' },
        },
    },
    searchForm: {
        selector: '.wjs-search-form',
        children: {
            input: { selector: '.wjs-search-form input' },
            submit: { selector: '.wjs-search-form button' },
        },
    },
    searchResults: { selector: '.wjs-search-results' },
    searchResult: {
        selector: '.wjs-search-result',
        children: {
            meta: { selector: '.wjs-search-result-meta' },
            badge: { selector: '.wjs-search-result-badge' },
            titleLink: { selector: '.wjs-search-result-link' },
            title: { selector: '.wjs-search-result-title' },
            excerpt: { selector: '.wjs-search-result-excerpt' },
            more: { selector: '.wjs-search-result-more' },
        },
    },
    singlePost: {
        selector: '.wjs-post',
        children: {
            header: { selector: '.wjs-post-header' },
            title: { selector: '.wjs-post-title' },
            // The body REGION, not the framework's content styling. This was `.wjs-post .wjs-content`,
            // which held on the classic body only: a post opened in the visual editor renders through
            // ContentRenderer, which emits `.puck-content` and no `.wjs-content` — so the promise
            // evaporated exactly when an author touched the post. `.wjs-content` cannot simply be added
            // to Puck output either, because ui.css STYLES it (heading margins, image radii, tables,
            // form fields) and that would restyle every block. So the region gets its own name, emitted
            // on both paths by PostContent.tsx.
            body: { selector: '.wjs-post-body' },
        },
    },
    postMeta: {
        selector: '.wjs-post-meta',
        children: {
            category: { selector: '.wjs-post-meta-category' },
            date: { selector: '.wjs-post-meta-date' },
            author: { selector: '.wjs-post-meta-author' },
        },
    },
    comments: {
        selector: '.wjs-comments',
        children: {
            title: { selector: '.wjs-comments-title' },
            list: { selector: '.wjs-comment-list' },
            empty: { selector: '.wjs-comments-empty' },
            form: { selector: '.wjs-comment-form' },
            formTitle: { selector: '.wjs-comment-form-title' },
            field: { selector: '.wjs-comment-field' },
            submit: { selector: '.wjs-comment-submit' },
        },
    },
    comment: {
        selector: '.wjs-comment',
        children: {
            avatar: { selector: '.wjs-comment-avatar' },
            avatarImage: { selector: '.wjs-comment-avatar img' },
            body: { selector: '.wjs-comment-body' },
            head: { selector: '.wjs-comment-head' },
            author: { selector: '.wjs-comment-author' },
            date: { selector: '.wjs-comment-date' },
            content: { selector: '.wjs-comment-content' },
        },
    },
};

const FLAG_ORDER = ['alias', 'editor-internal', 'chrome-phantom'];

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

// Replace comments with same-length whitespace so character offsets survive
// (the alias-zone marker offset is taken on the RAW file).
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// Minimal block tokenizer: tracks the open-rule stack ({} nesting), quotes and
// parens (so `;` inside url(...)/data URIs never splits a declaration), and
// emits every `prop: value` declaration with its enclosing stack + file offset.
function walkDeclarations(css, onRuleOpen, onDeclaration) {
    const stack = []; // { prelude, openOffset }
    let buf = '';
    let bufStart = -1;
    let quote = null;
    let paren = 0;

    const flushDeclaration = () => {
        const text = buf.trim();
        buf = '';
        const start = bufStart;
        bufStart = -1;
        if (!text || stack.length === 0) return;
        const colon = text.indexOf(':');
        // Skip pseudo-selector fragments etc. — a declaration needs `name: value`.
        if (colon <= 0) return;
        onDeclaration({
            property: text.slice(0, colon).trim(),
            value: collapse(text.slice(colon + 1)),
            stack,
            offset: start,
        });
    };

    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (quote) {
            buf += ch;
            if (ch === quote && css[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            if (bufStart < 0) bufStart = i;
            quote = ch;
            buf += ch;
            continue;
        }
        if (ch === '(') {
            paren++;
        } else if (ch === ')') {
            paren = Math.max(0, paren - 1);
        } else if (paren === 0) {
            if (ch === '{') {
                const frame = { prelude: collapse(buf), openOffset: i };
                stack.push(frame);
                onRuleOpen(frame, stack);
                buf = '';
                bufStart = -1;
                continue;
            }
            if (ch === '}') {
                flushDeclaration();
                stack.pop();
                continue;
            }
            if (ch === ';') {
                flushDeclaration();
                continue;
            }
        }
        if (bufStart < 0 && !/\s/.test(ch)) bufStart = i;
        buf += ch;
    }
}

// Effective consumer context: selector path (keyframe steps keep their
// `@keyframes <name>` prefix), plus the @media condition when present.
function contextOf(stack) {
    const media = [];
    const sel = [];
    for (const frame of stack) {
        const p = frame.prelude;
        if (p.startsWith('@media')) media.push(p.slice('@media'.length).trim());
        else if (p.startsWith('@keyframes')) sel.push(p);
        else if (p.startsWith('@')) continue; // @supports etc. — no selector part
        else sel.push(p);
    }
    return { selector: sel.join(' '), media: media.length ? media.join(' and ') : null };
}

// Find every var(--wjs-...) use, including uses nested inside fallbacks.
function scanVarUses(value, cb) {
    let idx = 0;
    while ((idx = value.indexOf('var(', idx)) !== -1) {
        // guard against identifiers ending in "var" (e.g. `myvar(`)
        if (idx > 0 && /[A-Za-z0-9_-]/.test(value[idx - 1])) {
            idx += 4;
            continue;
        }
        const start = idx + 4;
        let depth = 1;
        let comma = -1;
        let j = start;
        while (j < value.length && depth > 0) {
            const c = value[j];
            if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (c === ',' && depth === 1 && comma === -1) comma = j;
            j++;
        }
        const name = value.slice(start, comma === -1 ? j - 1 : comma).trim();
        const fallback = comma === -1 ? null : value.slice(comma + 1, j - 1).trim();
        if (name.startsWith(TOKEN_PREFIX)) cb(name, fallback);
        idx = start; // re-scan from inside so nested var() uses are found too
    }
}

const BASE_RE = /\.wp-block-((?:[A-Za-z0-9]+-)*[A-Za-z0-9]+)/g; // stops before `--` modifiers and `__` children
const CHILD_RE = /\.wp-block-((?:[A-Za-z0-9]+-)*[A-Za-z0-9]+)__((?:[A-Za-z0-9]+-)*[A-Za-z0-9]+)/g;

function main() {
    const raw = fs.readFileSync(CSS_PATH, 'utf8');
    const aliasMarkerOffset = raw.indexOf(ALIAS_ZONE_MARKER);
    if (aliasMarkerOffset === -1) {
        console.warn(`WARN: alias-zone marker not found ("${ALIAS_ZONE_MARKER}"); falling back to exact-var() heuristic for the alias flag.`);
    }
    const css = stripComments(raw);

    const tokens = new Map();
    const ensureToken = (name) => {
        let t = tokens.get(name);
        if (!t) {
            t = { declaredDefault: null, fallbacks: [], consumers: [], consumerKeys: new Set(), flags: new Set() };
            if (name.startsWith('--wjs-r-')) t.flags.add('editor-internal');
            tokens.set(name, t);
        }
        return t;
    };

    let varUses = 0;
    const elementBases = new Set();
    const childPairs = new Set();

    walkDeclarations(
        css,
        // element registry: one entry per .wp-block-<x> class seen anywhere
        (frame) => {
            if (frame.prelude.startsWith('@')) return;
            for (const m of frame.prelude.matchAll(BASE_RE)) elementBases.add(m[1]);
        },
        ({ property, value, stack, offset }) => {
            const topRoot = stack.length === 1 && stack[0].prelude === ':root';
            if (topRoot && property.startsWith(TOKEN_PREFIX)) {
                const t = ensureToken(property);
                t.declaredDefault = value; // last :root declaration wins (cascade)
                const isAlias = aliasMarkerOffset !== -1
                    ? offset > aliasMarkerOffset && stack[0].openOffset < aliasMarkerOffset
                    : /^var\(\s*--wjs-[A-Za-z0-9-]+\s*\)$/.test(value);
                if (isAlias) t.flags.add('alias');
            }
            const { selector, media } = contextOf(stack);
            scanVarUses(value, (name, fallback) => {
                varUses++;
                const t = ensureToken(name);
                if (fallback !== null && !t.fallbacks.includes(fallback)) t.fallbacks.push(fallback);
                const key = `${selector} ${property} ${media || ''}`;
                if (!t.consumerKeys.has(key)) {
                    t.consumerKeys.add(key);
                    const consumer = { selector, property };
                    if (media) consumer.media = media;
                    t.consumers.push(consumer);
                }
                // children only from selectors observed consuming tokens
                for (const m of selector.matchAll(CHILD_RE)) childPairs.add(`${m[1]} ${m[2]}`);
            });
        }
    );

    for (const name of CHROME_PHANTOM_TOKENS) {
        const existed = tokens.has(name);
        const t = ensureToken(name);
        t.flags.add('chrome-phantom');
        if (!existed) t.consumers.push({ selector: '(react-chrome)', property: '(tailwind-arbitrary)' });
    }

    // ── tokens: sorted keys, stable field order ──────────────────────────────
    const tokensOut = {};
    for (const name of [...tokens.keys()].sort()) {
        const t = tokens.get(name);
        const entry = {
            group: name.slice(TOKEN_PREFIX.length).split('-')[0],
            declaredDefault: t.declaredDefault,
            fallbacks: t.fallbacks,
            consumers: t.consumers,
        };
        const flags = FLAG_ORDER.filter((f) => t.flags.has(f));
        if (flags.length) entry.flags = flags;
        tokensOut[name] = entry;
    }

    // ── elements: .wp-block-* registry + BEM children + chrome seeds ─────────
    const elements = {};
    for (const base of elementBases) elements[base] = { selector: `.wp-block-${base}` };
    for (const pair of childPairs) {
        const [base, child] = pair.split(' ');
        const el = elements[base] || (elements[base] = { selector: `.wp-block-${base}` });
        (el.children || (el.children = {}))[child] = { selector: `.wp-block-${base}__${child}` };
    }
    for (const [key, seed] of Object.entries(CHROME_ELEMENT_SEEDS)) {
        if (elements[key]) continue; // a real .wp-block-* registration always wins over a seed
        elements[key] = typeof seed === 'string'
            ? { selector: seed }
            : { selector: seed.selector, ...(seed.children ? { children: { ...seed.children } } : {}) };
    }
    const elementsOut = {};
    for (const key of Object.keys(elements).sort()) {
        const el = elements[key];
        const entry = { selector: el.selector };
        if (el.children) {
            entry.children = {};
            for (const child of Object.keys(el.children).sort()) entry.children[child] = el.children[child];
        }
        elementsOut[key] = entry;
    }

    const manifest = {
        version: 1,
        source: SOURCE_REL,
        counts: {
            tokens: Object.keys(tokensOut).length,
            varUses,
            elements: Object.keys(elementsOut).length,
        },
        tokens: tokensOut,
        elements: elementsOut,
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n');

    // ── sanity report ────────────────────────────────────────────────────────
    const aliasNames = Object.keys(tokensOut).filter((n) => (tokensOut[n].flags || []).includes('alias'));
    const heroNames = Object.keys(tokensOut).filter((n) => n.startsWith('--wjs-hero-'));
    const heroGroupsOk = heroNames.length > 0 && heroNames.every((n) => tokensOut[n].group === 'hero');
    const editorInternal = Object.keys(tokensOut).filter((n) => (tokensOut[n].flags || []).includes('editor-internal'));
    const phantomsOk = CHROME_PHANTOM_TOKENS.every((n) => (tokensOut[n].flags || []).includes('chrome-phantom'));

    console.log(`theme-tokens.json written: ${path.relative(process.cwd(), OUT_PATH)}`);
    console.log(`counts: tokens=${manifest.counts.tokens} varUses=${manifest.counts.varUses} elements=${manifest.counts.elements}`);
    console.log(`alias flags: ${aliasNames.length}`);
    console.log(`hero tokens: ${heroNames.length} (group "hero": ${heroGroupsOk ? 'OK' : 'FAIL'})`);
    console.log(`editor-internal (--wjs-r-*): ${editorInternal.length}`);
    console.log(`chrome-phantom present: ${phantomsOk ? 'OK' : 'FAIL'}`);

    let failed = false;
    if (manifest.counts.tokens < 700) { console.error(`FAIL: expected ~700+ unique tokens, got ${manifest.counts.tokens}`); failed = true; }
    if (!heroGroupsOk) { console.error('FAIL: --wjs-hero-* tokens missing or not grouped as "hero"'); failed = true; }
    if (!phantomsOk) { console.error('FAIL: chrome-phantom tokens missing'); failed = true; }
    if (aliasNames.length !== 21) console.warn(`WARN: alias-flagged tokens = ${aliasNames.length} (expected 21): ${aliasNames.join(', ')}`);
    if (failed) process.exitCode = 1;
}

// The seed table is the SOURCE of every chrome/public-surface element in the manifest, so the contract
// test derives its expectations from it rather than hand-copying a list that drifts (a hand-copied list
// covered 17 of 108 names, and deleting any seed outside those 17 just made the test smaller).
// Exported behind a require.main guard — same pattern as scripts/create-40-themes.js — so requiring
// this file cannot rewrite backend/public/theme-tokens.json as a side effect.
module.exports = { CHROME_ELEMENT_SEEDS, CHROME_PHANTOM_TOKENS };

if (require.main === module) main();
