/**
 * Verso — THE CANVAS MUST SELECT BY THE STORE KEY, NOT BY THE AUTHOR'S `props.id`.
 *
 * A block in the canvas carries two identifiers and they are different things:
 *
 *   • `data-wjs-block-id` = `props.id` — the AUTHOR's id. Ordinary document data: what an
 *     interaction targets when it animates "that other block" (whose validator,
 *     `/^[A-Za-z0-9_-]{1,64}$/`, could not even hold the other one), and what the public site emits.
 *   • the STORE KEY — how `VersoDoc.nodes` is keyed, and the only value `handle.select`,
 *     `setInlineEditing`, the geometry registry and every transaction accept.
 *
 * They coincide only while a node has never left the tab that created it. `crdt/state.ts` says so
 * itself (DESVIACIÓN DECLARADA respecto a D8): a node created by an op is identified by its causal
 * dot `site@counter` and "`props.id` sigue siendo un dato normal"; `normalize.ts` mints `#dupN` keys
 * for duplicates for the same reason.
 *
 * The editor read the AUTHOR's id and handed it to the store. `select()` DROPS an id it cannot find
 * (`store.ts`: `doc.nodes[nodeId] ? nodeId : null`) instead of complaining, so the failure was
 * silent and total: the moment a document had been through the collaboration room — the second
 * author, or the first one after a reload — clicking a block in the canvas selected nothing,
 * double-clicking opened no inline editor, and dragging picked up nothing. The page rendered
 * perfectly and could not be touched. Found in the browser with two frontends against two backends;
 * the same block was selectable from the Outline panel, which already carries store keys.
 *
 * Two tests, because the bug had two halves. The RESOLVER must return the store key (it never sees a
 * real DOM in this suite — the frontend package has no jsdom — so it is driven through the same
 * `closest()` contract the browser gives it). And the CALL SITES must actually use it: a correct
 * resolver nobody calls is exactly the state the code was already in, so the second test reads the
 * editor's own sources, in the grep-shaped style this suite already uses for promise-vs-markup
 * contracts (see lib/__tests__/chromeSelectorContract.test.ts).
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NODE_KEY_ATTR, NODE_KEY_SELECTOR, nodeKeyFromTarget } from '../nodeKey';

const VERSO = path.resolve(__dirname, '../..');

/**
 * An element as the browser hands it to a listener: `closest(selector)` walks up and answers with
 * the nearest ancestor-or-self carrying that attribute. Only the two attributes in play are modelled
 * — the point is which one the resolver ASKS for.
 */
function elementLike(attrs: Record<string, string>, parent: any = null): any {
    const self: any = {
        attrs,
        parent,
        getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
        closest(selector: string) {
            const wanted = selector.replace(/^\[|\]$/g, '');
            let node: any = self;
            while (node) {
                if (wanted in node.attrs) return node;
                node = node.parent;
            }
            return null;
        },
    };
    return self;
}

/** A block root as VersoBlock renders it, with a descendant the click actually lands on. */
function block(propsId: string, storeKey: string, parent: any = null) {
    const root = elementLike({ 'data-wjs-block-id': propsId, [NODE_KEY_ATTR]: storeKey }, parent);
    const text = elementLike({}, root);
    return { root, text };
}

describe('nodeKeyFromTarget — which id the canvas resolves', () => {
    test('a block that came over the wire resolves to its STORE key, not the author id', () => {
        // The pair the CRDT actually produces: internal identity is the causal dot, props.id rides
        // along unchanged. This is the whole bug in one fixture.
        const { root, text } = block('c57fc0ba-a238-4959-a460-4244333b970c', 's_2mq44qoycecaeqse@7');
        expect(nodeKeyFromTarget(text)).toBe('s_2mq44qoycecaeqse@7');
        expect(nodeKeyFromTarget(root)).toBe('s_2mq44qoycecaeqse@7');
        expect(nodeKeyFromTarget(text)).not.toBe('c57fc0ba-a238-4959-a460-4244333b970c');
    });

    test('a duplicate resolves to its `#dupN` key', () => {
        // normalize.ts already mints these: two nodes can legitimately share one props.id, so the
        // author id was never a usable key even before collaboration existed.
        expect(nodeKeyFromTarget(block('hero', 'hero#dup1').text)).toBe('hero#dup1');
    });

    test('a freshly inserted local block still resolves (the case that never broke)', () => {
        const id = 'eb863a64-d6d8-476a-93a5-12f0240ac187';
        expect(nodeKeyFromTarget(block(id, id).text)).toBe(id);
    });

    test('the INNERMOST block wins when blocks nest (a text inside a column)', () => {
        const outer = block('cols', 'site@1');
        const inner = block('text', 'site@2', outer.root);
        expect(nodeKeyFromTarget(inner.text)).toBe('site@2');
        expect(nodeKeyFromTarget(outer.text)).toBe('site@1');
    });

    test('outside any block it is null — clicking the canvas background deselects', () => {
        expect(nodeKeyFromTarget(elementLike({}))).toBeNull();
        expect(nodeKeyFromTarget(null)).toBeNull();
        expect(nodeKeyFromTarget(undefined)).toBeNull();
        // `document`/`window` reach these listeners too and have no closest(): a stray click must
        // deselect, not throw inside the canvas event handler.
        expect(nodeKeyFromTarget({})).toBeNull();
    });

    test('markup carrying ONLY the author id is not a selectable block', () => {
        // The public site emits data-wjs-block-id and has no store. If such markup reaches the
        // canvas the honest answer is "I do not know this node" — never the author id by accident.
        expect(nodeKeyFromTarget(elementLike({ 'data-wjs-block-id': 'public-block' }))).toBeNull();
    });

    test('the attribute name and its selector are one definition', () => {
        expect(NODE_KEY_ATTR).toBe('data-wjs-node-key');
        expect(NODE_KEY_SELECTOR).toBe(`[${NODE_KEY_ATTR}]`);
        // The author id keeps its own attribute: interactions target it and it must not move.
        expect(NODE_KEY_ATTR).not.toBe('data-wjs-block-id');
    });
});

describe('the canvas call sites use it', () => {
    // Every place that turns a pointer event into a nodeId for the STORE. Each of these read
    // `data-wjs-block-id` and fed it straight to select / setInlineEditing / geometry.getRect.
    const CALL_SITES = [
        'editor/VersoEditor.tsx', // click → select, dblclick → inline editing
        'overlay/OverlayLayer.tsx', // hover outline (geometry lookup)
        'dnd/DnDDriver.tsx', // drag source
    ];

    for (const rel of CALL_SITES) {
        test(`${rel} resolves the node from the store key, never from data-wjs-block-id`, () => {
            const src = fs.readFileSync(path.join(VERSO, rel), 'utf8');
            expect(src).toContain('nodeKeyFromTarget');
            // The give-away shape of the bug: reading the author id back out of the DOM in a file
            // whose only use for an id is to hand it to the store.
            expect(src).not.toMatch(/getAttribute\(\s*["']data-wjs-block-id["']\s*\)/);
        });
    }

    test('VersoBlock stamps BOTH ids — the author id stays for interactions and the public site', () => {
        const src = fs.readFileSync(path.join(VERSO, 'render/VersoBlock.tsx'), 'utf8');
        expect(src).toContain('data-wjs-block-id={props.id}');
        expect(src).toContain('NODE_KEY_ATTR');
        expect(src).toContain('nodeId');
    });
});
