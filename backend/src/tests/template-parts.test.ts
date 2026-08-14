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
 *   5. THE ALLOWLIST IS NARROWER IN A PART THAN IN THE SITE CHROME. A part renders inside the page
 *      body and a template may place it N times, so a block that owns DOCUMENT-LEVEL state has no
 *      single-instance guarantee there. See the POSITION section at the bottom of this file.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    validateTemplateParts, TEMPLATE_PART_AREAS, TEMPLATE_PART_NAME, TEMPLATE_PART_RESERVED,
    MAX_TEMPLATE_PARTS,
    validateChromeData, chromePositionFor, CHROME_SITE_PARTS, CHROME_BLOCK_TYPES,
    CHROME_DOCUMENT_SCOPED_BLOCKS
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

// ── the POSITION gate ──────────────────────────────────────────────────────────────────────────────
//
// Template parts widened chrome from "two files the layout renders ONCE" to "arbitrary files a page
// body can pull in N times". ChromeNav's mobile drawer was written for the first world: it portals to
// document.body, writes document.body.style.overflow to lock page scroll, and binds a document-level
// keydown listener. Two instances save and restore that one global from each other, so closing one
// drawer can leave the page permanently unscrollable. The allowlist is therefore NARROWER in the
// template-part position than in the site header/footer, where a single instance is guaranteed.

const nav = { type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } };
const comp = (content: any) => ({ root: { props: {} }, content });

test('ChromeNav is allowed in the site header and footer — one instance per document is guaranteed', () => {
    for (const part of CHROME_SITE_PARTS) {
        const r = validateChromeData(comp([nav]), { part });
        assert.strictEqual(r.ok, true, `${part}: ${JSON.stringify(r.errors)}`);
    }
    // No name at all is the site chrome too — the only position PUT /api/v1/chrome/:part can write.
    assert.strictEqual(validateChromeData(comp([nav])).ok, true);
});

test('ChromeNav is REFUSED in a named template part, and the message says which block and why', () => {
    const r = validateChromeData(comp([nav]), { part: 'promo' });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(codes(r), ['CHROME_BLOCK_NOT_IN_PART']);
    const [e] = r.errors;
    assert.strictEqual(e.path, 'content[0]');
    assert.match(e.message, /ChromeNav/);
    assert.match(e.message, /document\.body/);          // names the state that is fought over
    assert.match(e.message, /more than once/);          // names the reason the guarantee is gone
    assert.match(e.message, /chrome\/header\.json/);    // tells the author where it DOES belong
});

test('the bar holds at every depth — a ChromeRow is not a laundering route', () => {
    const nested = comp([{
        type: 'ChromeRow',
        props: {
            align: 'between', gap: 'md', items: [
                { type: 'ChromeRow', props: { align: 'start', gap: 'sm', items: [nav] } }
            ]
        }
    }]);
    const r = validateChromeData(nested, { part: 'promo' });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(codes(r), ['CHROME_BLOCK_NOT_IN_PART']);
    assert.strictEqual(r.errors[0].path, 'content[0].props.items[0].props.items[0]');
    // …and the very same tree is fine as the site header.
    assert.strictEqual(validateChromeData(nested, { part: 'header' }).ok, true);
});

test('a ChromeNav of ANY shape is refused in a part — the rule is the block, not a prop pair', () => {
    // Only location:'header' + orientation:'horizontal' mounts the drawer TODAY. Pinning the rule to
    // that pair would make this contract depend on an internal of the component, so a later change
    // inside ChromeNav would re-open the hole with the validator still green.
    for (const location of ['header', 'footer']) {
        for (const orientation of ['horizontal', 'vertical']) {
            const r = validateChromeData(comp([{ type: 'ChromeNav', props: { location, orientation } }]), { part: 'promo' });
            assert.strictEqual(r.ok, false, `${location}/${orientation} must be refused`);
            assert.deepStrictEqual(codes(r), ['CHROME_BLOCK_NOT_IN_PART']);
        }
    }
});

test('every OTHER block in the allowlist is still legal in a part — this narrows, it does not gut', () => {
    // The audit behind CHROME_DOCUMENT_SCOPED_BLOCKS: the other eight blocks are presentational server
    // components with no "use client", no hooks and no document/window access, so N instances are fine.
    const legal: Record<string, any> = {
        ChromeLogo: { size: 'md' },
        ChromeSiteTitle: { showTagline: true },
        ChromeSearch: { placeholder: 'Search' },
        ChromeSocials: { source: 'settings' },
        ChromeText: { text: 'hello' },
        ChromeButton: { label: 'Go', href: '/x', variant: 'primary' },
        ChromeSpacer: { size: 'sm' },
        ChromeRow: { align: 'center', gap: 'md', items: [] },
    };
    for (const type of CHROME_BLOCK_TYPES) {
        if (CHROME_DOCUMENT_SCOPED_BLOCKS.includes(type)) continue;
        const r = validateChromeData(comp([{ type, props: legal[type] }]), { part: 'promo' });
        assert.strictEqual(r.ok, true, `${type}: ${JSON.stringify(r.errors)}`);
    }
    // And the barred set is exactly the one the audit found — a silent addition here is a contract change.
    assert.deepStrictEqual(CHROME_DOCUMENT_SCOPED_BLOCKS, ['ChromeNav']);
});

test('the position is DERIVED from the name, and no part name can reach the lenient branch', () => {
    assert.strictEqual(chromePositionFor(undefined), 'chrome');
    assert.strictEqual(chromePositionFor('header'), 'chrome');
    assert.strictEqual(chromePositionFor('footer'), 'chrome');
    assert.strictEqual(chromePositionFor('promo'), 'part');
    assert.strictEqual(chromePositionFor(''), 'part');
    // The lenient branch is reachable only by the two names validateTemplateParts REFUSES as part
    // names, which is what closes the loop: a declared part can never be called 'header'/'footer'.
    for (const name of CHROME_SITE_PARTS) {
        assert.deepStrictEqual(codes(validateTemplateParts([{ name, area: 'general' }])), ['PARTS_RESERVED_NAME']);
        assert.strictEqual(chromePositionFor(name), 'chrome');
    }
    assert.deepStrictEqual(CHROME_SITE_PARTS, TEMPLATE_PART_RESERVED);
});
