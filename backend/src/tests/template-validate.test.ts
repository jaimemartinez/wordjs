/**
 * Declarative page-template validator (contract v1).
 *
 * A theme template is the one thing this theme system could not express: a LAYOUT. It is a block tree,
 * which means the framework still owns the markup — and it means the validator is the entire trust
 * boundary. These tests pin the properties that boundary exists for, in the order they matter:
 *
 *   1. DATA NEVER CHOOSES STRUCTURE. A stored-XSS critical shipped from a block that used an
 *      author-controlled prop as the React element type (`level: "script"`). Every prop here is a
 *      type or a closed enum, so nothing in a template can name an element.
 *   2. FAIL-CLOSED. One bad block rejects the whole template — never a half-rendered page.
 *   3. EXACTLY ONE content slot. None and the page's content vanishes; two and it renders twice,
 *      duplicating every heading and id.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    validateTemplate, CONTENT_SLOT, TEMPLATE_BLOCKS, FORBIDDEN_TEMPLATE_BLOCKS, TEMPLATE_LIMITS
} = require('../core/template-validate');

const tpl = (content: any) => ({ content });
const slot = { type: CONTENT_SLOT, props: {} };
const codes = (r: any) => r.errors.map((e: any) => e.code).sort();

test('a minimal template — a section wrapping the content slot — is valid', () => {
    const r = validateTemplate(tpl([
        { type: 'Section', props: { maxWidth: '72rem', padding: '3rem 1rem', items: [slot] } }
    ]));
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('a real layout a theme could not previously express is valid', () => {
    // Hero-less magazine front: a posts grid beside the content, inside a section.
    const r = validateTemplate(tpl([
        {
            type: 'Section', props: {
                maxWidth: '80rem', padding: '4rem', items: [
                    { type: 'Grid', props: { columns: 2, gap: '2rem', columnsMobile: 1, items: [slot, { type: 'Spacer', props: { height: '4rem' } }] } },
                    { type: 'Divider', props: { width: '3px', color: '#eee' } },
                    { type: 'FlexRow', props: { gap: '1rem', justify: 'between', wrap: true, direction: 'row', items: [{ type: 'Columns', props: { columns: 3, gap: '1rem' } }] } }
                ]
            }
        }
    ]));
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

// ── 1. data never chooses structure ───────────────────────────────────────────────────────────────

test('a prop outside its enum is refused — this is what stops a prop naming an element', () => {
    // The shape of the XSS that shipped: a value that looks like a tag reaching a structural prop.
    const r = validateTemplate(tpl([{ type: 'FlexRow', props: { justify: 'script', items: [slot] } }]));
    assert.strictEqual(r.ok, false);
    assert.ok(codes(r).includes('TPL_INVALID_PROP'), JSON.stringify(r.errors));

    // And a prop no block HONOURS is refused too, not silently ignored. `align` on a Section and
    // `minColumnWidth` on a Grid were both in an earlier draft of this contract; neither reached the
    // component that renders it, so a template using them validated and did nothing.
    for (const bad of [
        { type: 'Section', props: { align: 'center', items: [slot] } },
        { type: 'Grid', props: { minColumnWidth: '20rem', items: [slot] } },
    ]) {
        const rr = validateTemplate(tpl([bad]));
        assert.strictEqual(rr.ok, false, JSON.stringify(bad));
        assert.ok(codes(rr).includes('TPL_UNKNOWN_PROP'), JSON.stringify(rr.errors));
    }
});

test('a prop the block does not define is refused, never ignored', () => {
    // Silently dropping an unknown prop is how a theme author ends up debugging a template that
    // validates and does nothing.
    const r = validateTemplate(tpl([{ type: 'Section', props: { as: 'script', items: [slot] } }]));
    assert.strictEqual(r.ok, false);
    assert.ok(codes(r).includes('TPL_UNKNOWN_PROP'), JSON.stringify(r.errors));
});

test('a prop of the wrong primitive type is refused', () => {
    const r = validateTemplate(tpl([{ type: 'Grid', props: { columns: 'three', items: [slot] } }]));
    assert.strictEqual(r.ok, false);
    assert.ok(codes(r).includes('TPL_INVALID_PROP'), JSON.stringify(r.errors));
});

// ── 2. the allowlist is closed, and "not here" differs from "no such thing" ────────────────────────

test('an unknown block type is refused', () => {
    const r = validateTemplate(tpl([{ type: 'ScriptBlock', props: {} }, slot]));
    assert.strictEqual(r.ok, false);
    assert.ok(codes(r).includes('TPL_UNKNOWN_TYPE'), JSON.stringify(r.errors));
});

test('a REAL block that a theme template may not ship is refused, and says why', () => {
    // HTMLEmbed exists and works on a page; a theme shipping raw HTML is a different question.
    // Reported distinctly so the author is told "not here" rather than hunting a typo.
    for (const type of ['HTMLEmbed', 'Symbol', 'Form', 'Heading', 'Text', 'Image']) {
        const r = validateTemplate(tpl([{ type, props: {} }, slot]));
        assert.strictEqual(r.ok, false, `${type} must be refused`);
        assert.ok(codes(r).includes('TPL_FORBIDDEN_TYPE'), `${type}: ${JSON.stringify(r.errors)}`);
        assert.match(JSON.stringify(r.errors), /not allowed in a theme template/);
    }
    // …and every forbidden name is a real block, not a straw man: none of them is also in the allowlist.
    for (const f of FORBIDDEN_TEMPLATE_BLOCKS) assert.ok(!TEMPLATE_BLOCKS.includes(f), f);
});

test('a leaf block may not smuggle children', () => {
    const r = validateTemplate(tpl([{ type: 'Spacer', props: { items: [{ type: 'Section', props: {} }] } }, slot]));
    assert.strictEqual(r.ok, false);
    assert.ok(codes(r).includes('TPL_INVALID_PROP'), JSON.stringify(r.errors));
});

// ── 3. exactly one content slot ───────────────────────────────────────────────────────────────────

test('no content slot is an error — the page content would silently vanish', () => {
    const r = validateTemplate(tpl([{ type: 'Section', props: { items: [{ type: 'Spacer', props: {} }] } }]));
    assert.strictEqual(r.ok, false);
    assert.ok(codes(r).includes('TPL_SLOT_MISSING'), JSON.stringify(r.errors));
});

test('two content slots is an error — the content would render twice', () => {
    const r = validateTemplate(tpl([slot, { type: 'Section', props: { items: [slot] } }]));
    assert.strictEqual(r.ok, false);
    assert.ok(codes(r).includes('TPL_SLOT_DUPLICATE'), JSON.stringify(r.errors));
    assert.match(JSON.stringify(r.errors), /more than once/);
});

test('the slot is reported as missing even when the tree has other errors', () => {
    // Two round-trips to learn two things is worse than one message listing both.
    const r = validateTemplate(tpl([{ type: 'Nope', props: {} }]));
    assert.ok(codes(r).includes('TPL_UNKNOWN_TYPE'));
    assert.ok(codes(r).includes('TPL_SLOT_MISSING'), JSON.stringify(r.errors));
});

// ── budgets and malformed input ───────────────────────────────────────────────────────────────────

test('depth, block count and byte budgets are enforced', () => {
    // Deeper than MAX_DEPTH.
    let deep: any = slot;
    for (let i = 0; i <= TEMPLATE_LIMITS.MAX_DEPTH + 1; i++) deep = { type: 'Section', props: { items: [deep] } };
    assert.ok(codes(validateTemplate(tpl([deep]))).includes('TPL_TOO_DEEP'));

    // More blocks than the budget.
    const many = Array.from({ length: TEMPLATE_LIMITS.MAX_BLOCKS + 5 }, () => ({ type: 'Spacer', props: { height: '1rem' } }));
    assert.ok(codes(validateTemplate(tpl([...many, slot]))).includes('TPL_TOO_MANY_BLOCKS'));

    // Over the byte budget, as raw text.
    const huge = JSON.stringify(tpl([{ type: 'Section', props: { padding: 'x'.repeat(TEMPLATE_LIMITS.MAX_BYTES), items: [slot] } }]));
    assert.ok(codes(validateTemplate(huge)).includes('TPL_TOO_LARGE'));
});

test('malformed input is refused rather than throwing', () => {
    assert.strictEqual(validateTemplate('{ not json').errors[0].code, 'TPL_INVALID_JSON');
    assert.strictEqual(validateTemplate('[]').errors[0].code, 'TPL_INVALID_SHAPE');
    assert.strictEqual(validateTemplate(null).errors[0].code, 'TPL_INVALID_SHAPE');
    assert.ok(codes(validateTemplate(tpl('not-an-array'))).includes('TPL_INVALID_SHAPE'));
    assert.ok(codes(validateTemplate(tpl([null]))).includes('TPL_INVALID_SHAPE'));
    assert.ok(codes(validateTemplate(tpl([{ props: {} }]))).includes('TPL_INVALID_SHAPE'));
});

test('accepts the raw JSON string form as well as the parsed object', () => {
    const obj = tpl([{ type: 'Section', props: { items: [slot] } }]);
    assert.strictEqual(validateTemplate(JSON.stringify(obj)).ok, true);
    assert.strictEqual(validateTemplate(obj).ok, true);
});
