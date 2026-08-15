/**
 * THE ANNOUNCEMENT / TOP BAR — OLA 4 (B).
 *
 * A third site chrome slot the public layout resolves itself (chrome/announcement.json + option
 * site_chrome_announcement), rendered full-bleed above the header. It is validated by chrome-validate
 * exactly like header/footer — SAME contract, SAME error codes — but at its OWN position, which bars
 * the document-scoped blocks (ChromeNav). The reason is not "a template part renders N times" (the
 * announcement bar renders ONCE): it is that the HEADER already mounts the one ChromeNav mobile drawer,
 * so a second ChromeNav anywhere on the page — announcement bar included — is a second owner of the
 * body-scroll-lock global. Refusing it here is the same document-scoped rule a template part enforces.
 *
 * These pin: (1) the presentational blocks the bar is built from validate; (2) ChromeNav is refused,
 * at every depth, with the shared CHROME_BLOCK_NOT_IN_PART code and an announcement-specific message;
 * (3) the slot name is reserved so it can never be a template part. Mutation proof: flip the
 * `|| state.position === 'announcement'` in chrome-validate's gate off and test (2) goes green-broken.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    validateChromeData, chromePositionFor,
    CHROME_ANNOUNCEMENT_PART, CHROME_LAYOUT_SLOTS,
} = require('../core/chrome-validate');

const codes = (r: any) => r.errors.map((e: any) => e.code).sort();
const comp = (content: any) => ({ root: { props: {} }, content });
const ANN = CHROME_ANNOUNCEMENT_PART; // 'announcement'

test('the announcement part maps to its own position', () => {
    assert.strictEqual(ANN, 'announcement');
    assert.strictEqual(chromePositionFor(ANN), 'announcement');
    assert.ok(CHROME_LAYOUT_SLOTS.includes(ANN), 'announcement is a layout-resolved slot');
});

test('a presentational announcement composition validates (ChromeText + ChromeButton in a ChromeRow)', () => {
    const data = comp([
        {
            type: 'ChromeRow',
            props: {
                align: 'center', gap: 'md', items: [
                    { type: 'ChromeText', props: { text: 'Free shipping this week' } },
                    { type: 'ChromeButton', props: { label: 'Shop', href: '/shop', variant: 'primary' } },
                ],
            },
        },
    ]);
    const r = validateChromeData(data, { part: ANN });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('ChromeNav is REFUSED in the announcement bar — the header already owns the one drawer', () => {
    const nav = { type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } };
    const r = validateChromeData(comp([nav]), { part: ANN });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(codes(r), ['CHROME_BLOCK_NOT_IN_PART']);
    const [e] = r.errors;
    assert.strictEqual(e.path, 'content[0]');
    assert.match(e.message, /ChromeNav/);
    assert.match(e.message, /announcement bar/);       // names WHERE it is barred
    assert.match(e.message, /document\.body/);          // names the global fought over
    assert.match(e.message, /chrome\/header\.json/);    // tells the author where it belongs
});

test('a ChromeNav of ANY shape is refused, at every depth — the rule is the block, not a prop pair', () => {
    for (const location of ['header', 'footer']) {
        for (const orientation of ['horizontal', 'vertical']) {
            const nav = { type: 'ChromeNav', props: { location, orientation } };
            // top level
            assert.strictEqual(validateChromeData(comp([nav]), { part: ANN }).ok, false, `${location}/${orientation} top`);
            // nested two ChromeRows deep — a Row is not a laundering route
            const nested = comp([{
                type: 'ChromeRow', props: { align: 'start', gap: 'sm', items: [
                    { type: 'ChromeRow', props: { align: 'start', gap: 'sm', items: [nav] } },
                ] },
            }]);
            const rn = validateChromeData(nested, { part: ANN });
            assert.strictEqual(rn.ok, false, `${location}/${orientation} nested`);
            assert.deepStrictEqual(codes(rn), ['CHROME_BLOCK_NOT_IN_PART']);
            assert.strictEqual(rn.errors[0].path, 'content[0].props.items[0].props.items[0]');
        }
    }
});

test('the SAME tree that is refused as the announcement bar is legal as the site header', () => {
    const nav = { type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } };
    assert.strictEqual(validateChromeData(comp([nav]), { part: ANN }).ok, false);
    assert.strictEqual(validateChromeData(comp([nav]), { part: 'header' }).ok, true);
});
