#!/usr/bin/env node
/* =============================================================================
 * themes-chrome-to-declarative.mjs
 * -----------------------------------------------------------------------------
 * Moves a theme's hand-written chrome CSS into theme.json's declarative `styles`
 * block, mechanically.
 *
 * WHY A SCRIPT AND NOT A MODEL. This exact conversion was first attempted by
 * delegating it, one agent per theme. It failed on 8 of 10, and every failure
 * was the same shape: the converter exercised JUDGEMENT where none was wanted.
 *   · `var(--wjs-color-primary)` was replaced with the literal it resolves to —
 *     compile-time identical, and it BREAKS the live customizer, because a token
 *     override no longer reaches a hard-coded value.
 *   · a `:first-child` was dropped, widening a heading rule to every text node.
 *   · an unscoped `.wjs-header-nav a` was scoped to `.wjs-chrome-header`, which
 *     is absent from the DOM unless a composed chrome is saved.
 *   · a header rule was retargeted to the footer.
 *
 * A script cannot do any of that. Its safety is structural, not disciplinary:
 *   1. Declarations are copied BYTE-FOR-BYTE. var() survives by construction.
 *   2. A selector either matches the manifest EXACTLY or is left hand-written.
 *      There is no nearest-match, so a wrong path is not reachable.
 *   3. Suffixes (:hover, ::before, :first-child) map through an exact table; an
 *      unknown one leaves the whole rule alone.
 *
 * Usage:
 *   node scripts/themes-chrome-to-declarative.mjs --check <slug…>   # report only
 *   node scripts/themes-chrome-to-declarative.mjs --write <slug…>   # apply
 * With no slugs, every theme in marketplace/themes that has a manual block.
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const THEMES = path.join(ROOT, 'marketplace', 'themes');
const MANIFEST = path.join(ROOT, 'backend', 'public', 'theme-tokens.json');
const END_MARKER = /\/\* @wjs-generated:end \*\//;

// Suffix → the declarative key that produces it. Exact strings only.
const SUFFIX = {
    ':hover': 'hover', ':focus': 'focus', ':active': 'active', ':disabled': 'disabled',
    ':first-child': 'first', ':last-child': 'last',
    '::before': 'before', '::after': 'after', '::placeholder': 'placeholder',
};
const MEDIA = {
    '(max-width: 767.98px)': 'mobile',
    '(min-width: 768px) and (max-width: 1023.98px)': 'tablet',
    '(min-width: 1024px)': 'desktop',
    '(max-width: 1023.98px)': 'belowDesktop',
};

/** selector → ['element'] or ['element','child'], built from the manifest. */
function buildIndex() {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const idx = new Map();
    for (const [el, def] of Object.entries(m.elements || {})) {
        if (def.selector) idx.set(def.selector, [el]);
        for (const [child, cd] of Object.entries(def.children || {})) {
            if (cd.selector) idx.set(cd.selector, [el, child]);
        }
    }
    // body/headings/links are compiler globals, not manifest elements.
    idx.set('body', ['body']); idx.set('a', ['links']);
    idx.set('h1,h2,h3,h4,h5,h6', ['headings']);
    return idx;
}

const norm = (s) => s.trim().replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, ' $1 ');

/** Split a selector into its base and an ordered list of suffix keys. */
function decompose(sel) {
    let base = sel, keys = [];
    for (;;) {
        const m = base.match(/(::?[a-z-]+(?:\([^)]*\))?)$/);
        if (!m) break;
        const key = SUFFIX[m[1]];
        if (!key) return null; // unknown pseudo (e.g. :nth-child) → not convertible
        keys.unshift(key);
        base = base.slice(0, -m[1].length);
    }
    return { base: norm(base), keys };
}

/** Rules of a CSS string, with the media query each sits in. */
function parseRules(css) {
    const out = [];
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    const atRe = /@media([^{]+)\{/g;
    const spans = [];
    let m;
    while ((m = atRe.exec(clean))) {
        let depth = 1, i = atRe.lastIndex;
        while (i < clean.length && depth > 0) { if (clean[i] === '{') depth++; else if (clean[i] === '}') depth--; i++; }
        spans.push({ media: norm(m[1]), from: m.index, bodyFrom: atRe.lastIndex, to: i });
    }
    const inSpan = (pos) => spans.find((s) => pos > s.bodyFrom && pos < s.to);
    for (const r of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = norm(r[1]);
        if (!sel || sel.startsWith('@')) continue;
        const decls = r[2].split(';').map((d) => d.trim()).filter(Boolean)
            .map((d) => { const i = d.indexOf(':'); return i < 0 ? null : [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()]; })
            .filter(Boolean);
        if (!decls.length) continue;
        const span = inSpan(r.index);
        out.push({ sel, decls, media: span ? MEDIA[span.media] || null : null, mediaRaw: span ? span.media : null, raw: r[0] });
    }
    return out;
}

function setDeep(obj, pathKeys, prop, value) {
    let node = obj;
    for (const k of pathKeys) node = (node[k] = node[k] || {});
    node[prop] = value;
}

function convert(slug, write) {
    const dir = path.join(THEMES, slug);
    const cssPath = path.join(dir, 'style.css');
    const jsonPath = path.join(dir, 'theme.json');
    if (!fs.existsSync(cssPath) || !fs.existsSync(jsonPath)) return null;

    const css = fs.readFileSync(cssPath, 'utf8');
    const endIdx = css.search(END_MARKER);
    if (endIdx < 0) return { slug, skipped: 'no generated markers' };
    const endOfMarker = endIdx + (css.match(END_MARKER)[0].length);
    const head = css.slice(0, endOfMarker);
    const manual = css.slice(endOfMarker);
    if (!manual.replace(/\/\*[\s\S]*?\*\//g, '').trim()) return { slug, skipped: 'nothing hand-written' };

    const idx = buildIndex();
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const styles = JSON.parse(JSON.stringify(json.styles || {}));

    const rules = parseRules(manual);
    const converted = [], left = [];
    for (const rule of rules) {
        // A comma group is several rules that happen to share a body — split it.
        const parts = rule.sel.split(',').map(norm).filter(Boolean);
        const paths = [];
        let ok = parts.length > 0;
        for (const part of parts) {
            const d = decompose(part);
            const elPath = d && idx.get(d.base);
            if (!d || !elPath || (rule.mediaRaw && !rule.media)) { ok = false; break; }
            paths.push([...elPath, ...(rule.media ? [rule.media] : []), ...d.keys]);
        }
        if (!ok) { left.push(rule); continue; }
        for (const p of paths) for (const [prop, value] of rule.decls) setDeep(styles, p, prop, value);
        converted.push(rule);
    }

    if (write && converted.length) {
        json.styles = styles;
        fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2) + '\n');
        // Keep only what could not be converted, preserving each rule's own text.
        const keep = left.map((r) => (r.mediaRaw ? `@media ${r.mediaRaw} { ${r.raw.trim()} }` : r.raw.trim())).join('\n\n');
        const note = keep
            ? `\n\n/* Not expressible in theme.json's \`styles\` grammar — left hand-written on purpose.\n   Converted by scripts/themes-chrome-to-declarative.mjs; everything it could name now lives\n   in theme.json. What remains needs a selector shape the grammar has no name for. */\n${keep}\n`
            : '\n';
        fs.writeFileSync(cssPath, head + note);
    }
    return { slug, converted: converted.length, left: left.length, leftSelectors: left.map((r) => r.sel) };
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const slugs = args.filter((a) => !a.startsWith('--'));
const targets = slugs.length ? slugs : fs.readdirSync(THEMES).filter((s) => fs.existsSync(path.join(THEMES, s, 'style.css')));

let totC = 0, totL = 0;
for (const slug of targets) {
    const r = convert(slug, write);
    if (!r || r.skipped) continue;
    totC += r.converted; totL += r.left;
    console.log(`  ${slug.padEnd(20)} convertidas: ${String(r.converted).padStart(3)}   a mano: ${String(r.left).padStart(3)}`);
    for (const s of r.leftSelectors.slice(0, 4)) console.log(`      queda: ${s}`);
}
console.log(`\n  TOTAL  convertidas ${totC}   sin convertir ${totL}   (${write ? 'ESCRITO' : 'solo comprobación'})`);
