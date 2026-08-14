/**
 * NAMED TEMPLATE PARTS — theme.json `templateParts` + the `TemplatePart` block.
 *
 * Two files own this feature and they must agree: core/chrome-validate.ts validates the DECLARATION
 * (which parts exist, and what area each occupies), core/template-validate.ts validates the REFERENCE
 * (a block naming one). The properties pinned here, in the order they matter:
 *
 *   1. A NAME IS A FILE NAME. It becomes /themes/<slug>/chrome/<name>.json, so the shape check is the
 *      whole containment story — and it is rejection, never sanitising, because a cleaned-up name is a
 *      theme author debugging a part that silently resolved to something else.
 *   2. `header` / `footer` ARE NOT PARTS. Those two files are the site chrome the public layout renders
 *      on every page; a template pulling one in would put a second masthead inside <main>.
 *   3. FAIL-CLOSED AS A WHOLE. One bad entry drops the entire declaration, so a theme can never
 *      half-load its parts.
 *   4. THE TWO COPIES OF THE CONSTANTS ARE IDENTICAL. template-validate re-declares the name pattern
 *      and the area enum so it keeps loading alone; nothing but a test stops those from drifting.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    validateTemplateParts, TEMPLATE_PART_AREAS, TEMPLATE_PART_NAME, TEMPLATE_PART_RESERVED,
    MAX_TEMPLATE_PARTS
} = require('../core/chrome-validate');
const {
    validateTemplate, CONTENT_SLOT, templatePartRefs,
    TEMPLATE_PART_NAME: TPL_PART_NAME, TEMPLATE_PART_AREAS: TPL_PART_AREAS
} = require('../core/template-validate');

const codes = (r: any) => r.errors.map((e: any) => e.code).sort();
const slot = { type: CONTENT_SLOT, props: {} };
const tpl = (content: any) => ({ content });

// ── the declaration ────────────────────────────────────────────────────────────────────────────────

test('a well-formed declaration is accepted and normalized to [{ name, area }]', () => {
    const r = validateTemplateParts([
        { name: 'sidebar-blog', area: 'sidebar' },
        { name: 'promo', area: 'general' },
    ]);
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.deepStrictEqual(r.parts, [
        { name: 'sidebar-blog', area: 'sidebar' },
        { name: 'promo', area: 'general' },
    ]);
});

test('every area in the enum is accepted, and nothing outside it is', () => {
    for (const area of TEMPLATE_PART_AREAS) {
        assert.strictEqual(validateTemplateParts([{ name: 'p', area }]).ok, true, area);
    }
    for (const area of ['main', 'aside', 'HEADER', '', null, 7]) {
        const r = validateTemplateParts([{ name: 'p', area }]);
        assert.strictEqual(r.ok, false, JSON.stringify(area));
        assert.deepStrictEqual(codes(r), ['PARTS_INVALID_AREA']);
    }
});

test('a name that could become a path, an attribute or a different file is REJECTED, not cleaned up', () => {
    // Each of these is a name that must never reach a URL: traversal, an absolute path, a second
    // extension, a scheme, a query, uppercase (a different file on a case-sensitive FS), and empty.
    for (const name of ['../secret', 'a/b', '/etc/passwd', 'part.json', 'http://x', 'p?x=1', 'Promo', '', 'x'.repeat(41), 'a b', null, 3]) {
        const r = validateTemplateParts([{ name, area: 'general' }]);
        assert.strictEqual(r.ok, false, JSON.stringify(name));
        assert.ok(codes(r).includes('PARTS_INVALID_NAME'), `${JSON.stringify(name)} → ${JSON.stringify(codes(r))}`);
        assert.deepStrictEqual(r.parts, [], 'a rejected declaration must yield no parts');
    }
});

test('"header" and "footer" are the site chrome, never a template part', () => {
    for (const name of TEMPLATE_PART_RESERVED) {
        const r = validateTemplateParts([{ name, area: 'header' }]);
        assert.strictEqual(r.ok, false);
        assert.deepStrictEqual(codes(r), ['PARTS_RESERVED_NAME']);
    }
});

test('duplicates, unknown keys, a non-array and an over-budget list all fail', () => {
    assert.deepStrictEqual(codes(validateTemplateParts([{ name: 'p', area: 'general' }, { name: 'p', area: 'sidebar' }])), ['PARTS_DUPLICATE_NAME']);
    assert.deepStrictEqual(codes(validateTemplateParts([{ name: 'p', area: 'general', title: 'Promo' }])), ['PARTS_UNKNOWN_KEY']);
    assert.deepStrictEqual(codes(validateTemplateParts({ p: 'general' })), ['PARTS_INVALID_SHAPE']);
    assert.deepStrictEqual(codes(validateTemplateParts(['promo'])), ['PARTS_INVALID_SHAPE']);
    const many = Array.from({ length: MAX_TEMPLATE_PARTS + 1 }, (_v: unknown, i: number) => ({ name: `p${i}`, area: 'general' }));
    assert.ok(codes(validateTemplateParts(many)).includes('PARTS_TOO_MANY'));
});

test('FAIL-CLOSED AS A WHOLE: one bad entry drops the good ones too', () => {
    const r = validateTemplateParts([{ name: 'good', area: 'general' }, { name: '../bad', area: 'general' }]);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.parts, [], 'a partly-valid declaration must not half-load a theme');
});

// ── the reference ──────────────────────────────────────────────────────────────────────────────────

test('a TemplatePart block is valid with a legal name and a declared area', () => {
    const r = validateTemplate(tpl([slot, { type: 'TemplatePart', props: { name: 'sidebar-blog', area: 'sidebar' } }]));
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('both props are REQUIRED — a nameless or arealess part would render nothing', () => {
    assert.deepStrictEqual(codes(validateTemplate(tpl([slot, { type: 'TemplatePart', props: {} }]))), ['TPL_MISSING_PROP', 'TPL_MISSING_PROP']);
    assert.deepStrictEqual(codes(validateTemplate(tpl([slot, { type: 'TemplatePart', props: { name: 'promo' } }]))), ['TPL_MISSING_PROP']);
    assert.deepStrictEqual(codes(validateTemplate(tpl([slot, { type: 'TemplatePart', props: { area: 'general' } }]))), ['TPL_MISSING_PROP']);
});

test('the block re-checks the name shape, so a template cannot name a path either', () => {
    for (const name of ['../../etc/passwd', 'chrome/header', 'Promo', '']) {
        const r = validateTemplate(tpl([slot, { type: 'TemplatePart', props: { name, area: 'general' } }]));
        assert.strictEqual(r.ok, false, name);
        assert.deepStrictEqual(codes(r), ['TPL_INVALID_PROP']);
    }
});

test('a TemplatePart is a leaf and nests nothing', () => {
    const r = validateTemplate(tpl([slot, { type: 'TemplatePart', props: { name: 'promo', area: 'general', items: [slot] } }]));
    assert.strictEqual(r.ok, false);
    assert.ok(codes(r).includes('TPL_INVALID_PROP'));
});

test('templatePartRefs finds every referenced name, nested and deduped', () => {
    const refs = templatePartRefs(tpl([
        { type: 'Section', props: { items: [
            { type: 'TemplatePart', props: { name: 'promo', area: 'general' } },
            { type: 'Grid', props: { items: [{ type: 'TemplatePart', props: { name: 'sidebar-blog', area: 'sidebar' } }] } },
        ] } },
        slot,
        { type: 'TemplatePart', props: { name: 'promo', area: 'general' } },
    ]));
    assert.deepStrictEqual(refs, ['promo', 'sidebar-blog']);
    assert.deepStrictEqual(templatePartRefs(tpl([slot])), []);
    assert.deepStrictEqual(templatePartRefs('{ not json'), []);
    assert.deepStrictEqual(templatePartRefs(null), []);
});

// ── the two copies of the constants ────────────────────────────────────────────────────────────────

test('template-validate mirrors chrome-validate exactly (name pattern + area enum)', () => {
    // template-validate re-declares these so it loads without chrome-validate. Nothing but this test
    // stops the copies from drifting, and a drift means a part the declaration accepts and the block
    // refuses (or worse, the reverse).
    assert.strictEqual(TPL_PART_NAME.source, TEMPLATE_PART_NAME.source);
    assert.strictEqual(TPL_PART_NAME.flags, TEMPLATE_PART_NAME.flags);
    assert.deepStrictEqual(TPL_PART_AREAS, TEMPLATE_PART_AREAS);
});

test('the part-name pattern is the one the renderer guards a URL with', () => {
    // frontend/src/lib/server-api.ts (getThemeTemplate / getThemeChrome) tests names against this exact
    // literal before fetching. If this assertion has to change, that guard changes with it.
    assert.strictEqual(TEMPLATE_PART_NAME.source, '^[a-z0-9-]{1,40}$');
});
