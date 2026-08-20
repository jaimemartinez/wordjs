/**
 * Availability contract for the stored page tree.
 *
 * A byte limit alone does not bound JSON shape: a compact object can be nested deeply enough to
 * overflow the recursive sanitizer/JSON.stringify path. These tests pin an explicit structural
 * ceiling and, just as importantly, prove the failure is branded rather than a VM RangeError.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    sanitizePuckTree,
    sanitizeLookSpec,
    MAX_META_VALUE_DEPTH,
    MAX_META_VALUE_NODES,
    isMetaValueComplexityError,
} = require('../core/sanitize-meta');

function nestedObject(levels: number, leaf: any = '<b>safe</b>') {
    let value = leaf;
    for (let i = 0; i < levels; i++) value = { child: value };
    return value;
}

test('a deeply nested _puck_data tree is rejected before recursive sanitization overflows', () => {
    const hostile = nestedObject(MAX_META_VALUE_DEPTH + 2);
    assert.throws(
        () => sanitizePuckTree(hostile),
        (error: any) => {
            assert.ok(isMetaValueComplexityError(error));
            assert.strictEqual(error.reason, 'depth');
            assert.ok(!(error instanceof RangeError));
            return true;
        },
    );
});

test('the node budget bounds work even when the JSON is shallow', () => {
    const hostile = { content: new Array(MAX_META_VALUE_NODES).fill('x') };
    assert.throws(
        () => sanitizePuckTree(hostile),
        (error: any) => isMetaValueComplexityError(error) && error.reason === 'nodes',
    );
});

test('shared/cyclic object graphs are refused before JSON.stringify sees them', () => {
    const cyclic: any = { content: [] };
    cyclic.self = cyclic;
    assert.throws(
        () => sanitizePuckTree(cyclic),
        (error: any) => isMetaValueComplexityError(error) && error.reason === 'cycle',
    );
});

test('a shared but acyclic object is counted as serialized shape, not mistaken for a cycle', () => {
    const shared = { color: 'red' };
    assert.deepStrictEqual(
        sanitizeLookSpec({ desktop: shared, mobile: shared }),
        { desktop: { color: 'red' }, mobile: { color: 'red' } },
    );
});

test('ordinary trees and direct Appearance sanitization keep their existing behavior', () => {
    const tree = sanitizePuckTree({
        content: [{ type: 'Text', props: { text: '<img src=x onerror=alert(1)><b>ok</b>' } }],
        root: { props: {} },
    });
    assert.strictEqual(tree.content[0].props.text, '<img src="x" /><b>ok</b>');
    assert.ok(!tree.content[0].props.text.includes('onerror'));

    const look = sanitizeLookSpec({ tb: { bgImage: 'javascript:alert(1)', color: 'red' } });
    assert.deepStrictEqual(look, { tb: { bgImage: '', color: 'red' } });
});

test('the _puck_data sanitizer follows SQL collation, not JavaScript casing', () => {
    const { sanitizeMetaValue } = require('../core/sanitize-meta');
    const hostile = {
        content: [{ type: 'Text', props: { text: '<img src=x onerror=alert(1)><b>ok</b>' } }],
        root: { props: {} },
    };
    for (const key of ['_PUCK_DATA', '_puck_datá', '_puck_data ']) {
        const clean = sanitizeMetaValue(key, hostile);
        assert.ok(!clean.content[0].props.text.includes('onerror'), `${key} bypassed sanitization`);
    }
});

test('a deeply nested JSON-string _puck_data cannot hide the structural refusal', () => {
    const { sanitizeMetaValue } = require('../core/sanitize-meta');
    const hostile = JSON.stringify(nestedObject(MAX_META_VALUE_DEPTH + 2));
    assert.throws(
        () => sanitizeMetaValue('_puck_data', hostile),
        (error: any) => isMetaValueComplexityError(error) && error.reason === 'depth',
    );
    assert.strictEqual(sanitizeMetaValue('_puck_data', 'not-json'), 'not-json');
});
