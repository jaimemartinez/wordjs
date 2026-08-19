/**
 * Audit wave-2 hardening — the meta sanitizer never writes a prototype-bearing key.
 *
 * `_puck_data` arrives as a JSON STRING on several write paths (the editor's PUT, the WXR importer,
 * a bundle import), and `JSON.parse('{"__proto__":{…}}')` DOES create `__proto__` as an OWN property:
 * it survives Object.entries and reaches sanitizePuckTree's generic rebuild loop, where `out[k] = …`
 * is not an assignment but a call to the Object.prototype setter — it swaps the prototype of the node
 * being built. The blast radius is local (a fresh `{}`, never Object.prototype), which is why this is
 * hardening rather than a finding; but the sanitized tree is what gets PERSISTED and then read back by
 * every public render site, and a node that inherits attacker-shaped properties is not a node any
 * caller can reason about (`node.type`, `node.props`, `isSet(look.x)` all start answering wrongly).
 *
 * The `css` branch was already safe — it copies only names on a CLOSED allowlist — but `look` rebuilt
 * with the key as-is, exactly like the generic walk, so both are pinned here.
 *
 * NOTE the payloads below are RAW JSON TEXT on purpose. Writing `{ __proto__: … }` as a JS object
 * literal would set that literal's prototype instead of creating the own property, and the test would
 * silently exercise nothing — only JSON.parse produces the own property this guard is about.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { sanitizeMetaValue, sanitizePuckTree, sanitizeLookSpec } = require('../core/sanitize-meta');

// What a client actually POSTs as the serialized Puck tree.
const HOSTILE_TREE_JSON =
    '{"content":[{"type":"Hero","props":{"id":"a","title":"Hi",' +
    '"__proto__":{"isAdmin":true,"type":"Injected"}}}],"root":{"props":{}}}';

test('_puck_data as a JSON STRING: a parsed __proto__ never becomes the sanitized node prototype', () => {
    // Sanity: the payload really does carry the own property (guards the test itself).
    assert.ok(Object.prototype.hasOwnProperty.call(JSON.parse(HOSTILE_TREE_JSON).content[0].props, '__proto__'),
        'JSON.parse must have produced an OWN __proto__ — otherwise this test proves nothing');

    // 1. Through the real entry point: the value round-trips, the hostile key is gone, siblings survive.
    const out = sanitizeMetaValue('_puck_data', HOSTILE_TREE_JSON);
    assert.strictEqual(typeof out, 'string', '_puck_data given as a string must come back as a string');
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.content[0].props.title, 'Hi', 'ordinary props are untouched');
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed.content[0].props, '__proto__'),
        'the sanitized tree must not carry a __proto__ own property');

    // 2. On the live object the walk produces (JSON.stringify would hide an INHERITED property, so the
    //    prototype swap is only observable here — this is the assertion that actually fails without the
    //    guard: `props.isAdmin` would read `true`, inherited from the attacker's object).
    const node = sanitizePuckTree(JSON.parse(HOSTILE_TREE_JSON));
    const props = node.content[0].props;
    assert.strictEqual(Object.getPrototypeOf(props), Object.prototype, 'prototype must be untouched');
    assert.strictEqual(props.isAdmin, undefined, 'no inherited property may appear on a sanitized node');
    assert.strictEqual(node.content[0].type, 'Hero', 'the real type is not shadowed');
});

test('the `look` branch drops the same keys (it rebuilds with the key as-is, like the generic walk)', () => {
    const json =
        '{"content":[{"type":"Hero","props":{"look":{"bgColor":"#fff",' +
        '"__proto__":{"overlayColor":"red"}}}}]}';
    const node = sanitizePuckTree(JSON.parse(json));
    const look = node.content[0].props.look;
    assert.strictEqual(look.bgColor, '#fff', 'the real Appearance value survives');
    assert.strictEqual(Object.getPrototypeOf(look), Object.prototype);
    assert.strictEqual(look.overlayColor, undefined, 'nothing is inherited into the Appearance spec');
});

test('`constructor` / `prototype` are dropped too, and the CSS branch stays allowlist-only', () => {
    const json =
        '{"content":[{"type":"Hero","props":{"constructor":{"evil":1},"prototype":{"evil":1},' +
        '"color":"red","css":{"color":"red","__proto__":{"position":"fixed"}}}}]}';
    const props = sanitizePuckTree(JSON.parse(json)).content[0].props;
    assert.ok(!Object.prototype.hasOwnProperty.call(props, 'constructor'));
    assert.ok(!Object.prototype.hasOwnProperty.call(props, 'prototype'));
    assert.strictEqual(props.color, 'red', 'an ordinary string leaf is not collateral damage');
    assert.strictEqual(props.css.color, 'red');
    assert.strictEqual(Object.getPrototypeOf(props.css), Object.prototype);
    assert.strictEqual(props.css.position, undefined, 'the closed CSS allowlist already refused this name');
});

test('sanitizeLookSpec keeps its shape for the ordinary case (no regression from the key filter)', () => {
    const look = sanitizeLookSpec({ bgColor: '#000', pad: 4, on: true, tb: { pad: 2 } });
    assert.deepStrictEqual(look, { bgColor: '#000', pad: 4, on: true, tb: { pad: 2 } });
});
