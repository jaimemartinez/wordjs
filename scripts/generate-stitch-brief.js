#!/usr/bin/env node
/**
 * Emits documentation/stitch-brief.md — the canonical prompt for generating a WordJS theme design
 * in Stitch (or any design tool that takes a written brief).
 *
 * WHY IT IS GENERATED. A hand-written brief drifts from the contract the moment a block gains a
 * token or a layout variant is added, and the drift is invisible: the design simply comes back with
 * components WordJS cannot express, or missing the ones it needs values for. This reads the same
 * three sources the runtime does — the token manifest (element registry + token groups), the layout
 * schema, and the composable-chrome allowlist — so the brief always asks for exactly what a theme
 * can express, and nothing that would have to be thrown away.
 *
 * Deterministic: no timestamps, stable ordering. Regenerate with
 *   node scripts/generate-stitch-brief.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'backend/public/theme-tokens.json');
const LAYOUTS = path.join(ROOT, 'backend/public/theme-layouts.schema.json');
const CHROME = path.join(ROOT, 'backend/src/core/chrome-validate.ts');
const OUT = path.join(ROOT, 'documentation/stitch-brief.md');

// ONE SCREEN PER GROUP, and each group is small.
//
// Measured on this repo, not assumed. One prompt listing all twelve surfaces DOES come back — well
// after the tool's own timeout — but it drops roughly half: pricing, testimonial, accordion, tabs,
// the search field and the CTA band were all missing from the screen it returned. A prompt asking
// for four components delivered four out of four. Stitch generates PRODUCT SCREENS, so a long rigid
// inventory gets condensed into a plausible page; small asks are honoured literally.
const SCREENS = [
    {
        title: 'Chrome and hero',
        elements: ['header', 'logo', 'nav', 'button', 'hero'],
        note: 'A landing top: slim header with a wordmark left, a horizontal nav and one small outlined button at the right end; below it a hero band with a display headline, one paragraph and two buttons side by side (one solid, one outlined)',
    },
    {
        title: 'Editorial column',
        elements: ['heading', 'text', 'quote'],
        note: 'An article page: H1 through H4 in order, body paragraphs with one inline link, and a pull quote with its citation',
    },
    {
        title: 'Cards, pricing and figures',
        elements: ['card', 'grid', 'pricing', 'stats'],
        note: 'A plans page: a row of three feature cards (icon, title, description), a pricing row of three tiers with the middle one featured, and a strip of three big figures with captions',
    },
    {
        title: 'Disclosure and forms',
        elements: ['accordion', 'tabs', 'search', 'testimonial'],
        note: 'A support page: an FAQ accordion with one item open and one closed, a tab bar with one tab selected, a search field, and a single customer testimonial with author and role',
    },
    {
        title: 'Post list and footer',
        elements: ['posts-grid', 'category-posts', 'cta-banner', 'footer', 'social-links'],
        note: 'A blog index: three post cards (placeholder image, date, title, excerpt), a full-width call-to-action band with a headline and one button, and the site footer with a wordmark, three link columns and social icons',
    },
];

// Components Stitch has no vocabulary for. Asking makes the screen worse, not better: the request is
// dropped and the rest of the page drifts to fill the space. They inherit the framework's defaults,
// already driven by the same tokens the design system supplies, so nothing is lost by not asking.
const DERIVED_ONLY = ['audio-player', 'video-embed', 'html-embed', 'divider', 'spacer', 'columns', 'flex-row', 'section', 'table', 'icon-list', 'image', 'search-wrap'];

// Token groups worth calling out by name: these are the ones a designer decides, as opposed to the
// per-block plumbing a theme inherits.
const HEADLINE_GROUPS = ['color', 'font', 'radius', 'shadow', 'border', 'space'];

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Block types the composable chrome accepts, straight from the validator's allowlist. */
function chromeBlocks() {
    const src = fs.readFileSync(CHROME, 'utf8');
    const names = new Set();
    // The allowlist is the key set of the per-block prop contract: `ChromeLogo: { … }`.
    for (const match of src.matchAll(/^\s{4}(Chrome[A-Za-z]+):\s*\{/gm)) names.add(match[1]);
    return [...names].sort();
}

/** header/footer/sidebar variants a theme may declare, from the layout schema's enums. */
function layoutVariants() {
    const schema = readJson(LAYOUTS);
    const out = [];
    const props = (schema.properties || {});
    for (const [part, spec] of Object.entries(props)) {
        const inner = (spec.properties || {});
        const variant = inner.variant && Array.isArray(inner.variant.enum) ? inner.variant.enum : null;
        if (variant) out.push({ part, variants: variant, extras: Object.keys(inner).filter((k) => k !== 'variant') });
    }
    return out;
}

function build() {
    const manifest = readJson(MANIFEST);
    const elements = manifest.elements || {};
    const groups = {};
    for (const token of Object.values(manifest.tokens || {})) {
        groups[token.group] = (groups[token.group] || 0) + 1;
    }

    const lines = [];
    const L = (s = '') => lines.push(s);

    L('<!-- GENERATED by scripts/generate-stitch-brief.js — do not edit by hand. -->');
    L('# Stitch brief for a WordJS theme');
    L();
    L('Paste the two blocks below into Stitch: the **design system** fields first, then the **screen');
    L('prompt**. They are generated from the live contract, so what comes back maps onto a theme');
    L('without leftovers — every component listed is one WordJS styles, and nothing else is asked for.');
    L();
    L(`Contract at time of generation: **${manifest.counts.tokens} tokens**, **${manifest.counts.elements} styleable elements**, source \`${manifest.source}\`.`);
    L();

    L('## 1. Design system');
    L();
    L('These are the fields WordJS reads back, with the theme.json key each one becomes:');
    L();
    L('| Stitch field | Becomes |');
    L('| --- | --- |');
    L('| `customColor` / `overridePrimaryColor` | `seeds.primary` |');
    L('| `overrideSecondaryColor` | `seeds.secondary` |');
    L('| `overrideNeutralColor` + `colorMode` | `seeds.bg`, `seeds.text` |');
    L('| `headlineFont` / `bodyFont` | `--wjs-font-family-heading` / `-base` |');
    L('| `roundness` | `--wjs-radius`, `-md`, `-lg`, `-pill` |');
    L('| `typography[*].fontSize/letterSpacing/lineHeight` | `--wjs-h1…h6` and their tracking |');
    L('| `spacing` | `--wjs-xs … --wjs-2xl` |');
    L();
    L('After generating, `get_project` returns the RESOLVED palette under `namedColors`');
    L('(`surface`, `on_surface`, `outline`, `primary`, `secondary`, `error`, and their containers).');
    L('Map those verbatim — they are exact values, so nothing has to be eyeballed from a screenshot.');
    L();

    L('## 2. What to ask Stitch for, and what not to');
    L();
    L('**The design system above is the deliverable.** It maps onto a theme field by field and its');
    L('resolved palette is exact — a theme can be finished from it without a single screen.');
    L();
    L('**Screens are reference, and they must be asked for in small pieces.** Measured here: asking');
    L('for all twelve surfaces in one prompt returns a screen — long after the tool times out — that');
    L('is missing about half of them (pricing, testimonial, accordion, tabs, search field, CTA band).');
    L('Asking for four components returned four out of four. Stitch generates product screens, so a');
    L('long inventory gets condensed into a plausible page while a short one is honoured literally.');
    L('Generate the screens below ONE AT A TIME with the same design system id, and expect each call');
    L('to outlive its timeout: poll `list_screens` afterwards instead of retrying.');
    L();
    SCREENS.forEach((screen, i) => {
        const present = screen.elements.filter((el) => elements[el]);
        if (present.length === 0) return;
        const children = present.map((el) => Object.keys((elements[el] || {}).children || {})).flat();
        const parts = [...new Set(children)];
        L(`### Screen ${i + 1} — ${screen.title}`);
        L();
        L(`> ${screen.note}.`);
        if (parts.length > 0) L(`> Make these parts visible: ${parts.join(', ')}.`);
        L('> Show each button and link at rest and hovered. Flat fills, hairline borders, no drop');
        L('> shadows, one accent used sparingly, body copy on the neutral ink colour. No carousels,');
        L('> collages, overlapping cards or diagonal dividers, and no sidebar — the renderer owns the');
        L('> markup and cannot reproduce them.');
        L();
    });

    const derived = DERIVED_ONLY.filter((el) => elements[el]);
    if (derived.length > 0) {
        L('### Do not ask for these');
        L();
        L(`${derived.map((el) => `\`${el}\``).join(', ')} — Stitch has no vocabulary for them, so the`);
        L('request is dropped and the rest of the screen drifts to fill the space. They inherit the');
        L('framework defaults, already driven by the same tokens the design system supplies.');
        L();
    }

    L('## 3. Structure the theme can switch on');
    L();
    L('Do not design new navigation patterns — a theme selects one of these:');
    L();
    for (const { part, variants, extras } of layoutVariants()) {
        L(`- **${part}**: ${variants.map((v) => `\`${v}\``).join(', ')}${extras.length ? ` (also: ${extras.join(', ')})` : ''}`);
    }
    L();
    L('For a header or footer beyond those variants, the theme ships a COMPOSITION built only from');
    L(`these blocks: ${chromeBlocks().map((b) => `\`${b}\``).join(', ')}. Design accordingly — a header`);
    L('that cannot be expressed as a row of those blocks cannot be shipped as a theme.');
    L();

    L('## 4. What gets read back');
    L();
    L('The design is mined for these token families (count = how many exist today):');
    L();
    const headline = HEADLINE_GROUPS.filter((g) => groups[g]).map((g) => `\`${g}\` (${groups[g]})`);
    L(`- Global: ${headline.join(', ')}`);
    const perBlock = Object.entries(groups)
        .filter(([g]) => !HEADLINE_GROUPS.includes(g))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 14)
        .map(([g, n]) => `\`${g}\` (${n})`);
    L(`- Per component: ${perBlock.join(', ')}`);
    L();
    L('Anything the design expresses that has no token is either a per-instance choice the page');
    L('author makes in the editor, or it does not survive into the theme.');
    L();

    L('## 5. Fonts');
    L();
    L('Stitch fonts are Google Fonts. A WordJS theme self-hosts them: the doctor flags an external');
    L('`@import` (EXTERNAL_REF) because it is a render-blocking third-party request on every page.');
    L('Pick the families in Stitch, then vendor the files into the theme directory.');
    L();

    fs.writeFileSync(OUT, lines.join('\n') + '\n');
    return { screens: SCREENS.length, elements: manifest.counts.elements, tokens: manifest.counts.tokens };
}

const result = build();
console.log(`✅ documentation/stitch-brief.md — ${result.screens} screens, ${result.elements} elements, ${result.tokens} tokens`);
