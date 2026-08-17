/**
 * Verso — THE ATTRIBUTE THE CANVAS SELECTS BY.
 *
 * A block in the canvas carries TWO identifiers, and they are not the same thing:
 *
 *   • `data-wjs-block-id` = `props.id` — the AUTHOR's id. It is ordinary document data, it is what
 *     an interaction targets when it animates "that other block" (`interactions/runtime/targets.ts`,
 *     whose validator `/^[A-Za-z0-9_-]{1,64}$/` could not even accept the other one), and the public
 *     site emits it too. It is stable for a human, and it is NOT unique or authoritative.
 *
 *   • the STORE KEY — how `VersoDoc.nodes` is keyed, and the only value `handle.select`,
 *     `setInlineEditing`, the geometry registry and every transaction accept.
 *
 * They coincide only while a node has never left this tab. `crdt/state.ts` says so in its own words
 * (DESVIACIÓN DECLARADA respecto a D8): a node created by an op is identified by its causal dot
 * `site@counter`, "y `props.id` sigue siendo un dato normal" — and `normalize.ts` already mints
 * `#dupN` keys for duplicates for the same reason.
 *
 * Reading the AUTHOR's id and handing it to the store is therefore a category error, and it failed
 * in the worst possible way — silently. `select()` drops an id it cannot find (store.ts: `doc.nodes[
 * nodeId] ? nodeId : null`), so as soon as a document had been through the collaboration room —
 * i.e. for the second author, and for the first one after a reload — clicking a block in the canvas
 * selected nothing, double-clicking opened no inline editor, and dragging picked up nothing. The
 * page rendered perfectly and could not be touched. Selecting the very same block from the Outline
 * panel worked, because that panel already carries store keys.
 *
 * So the canvas stamps the store key under its own name and the editor reads THAT. `props.id` keeps
 * its meaning and its attribute; nothing about interactions or the public output changes.
 */

/** The attribute carrying a block's STORE KEY. Editor-only: the public site has no store. */
export const NODE_KEY_ATTR = "data-wjs-node-key";

/** Selector for the block root, for `closest()` from any descendant. */
export const NODE_KEY_SELECTOR = `[${NODE_KEY_ATTR}]`;

/**
 * The store key of the block containing `target`, or null when the target is outside every block
 * (canvas background, the inline bubble menu, chrome portalled into the frame).
 */
export function nodeKeyFromTarget(target: unknown): string | null {
    const el = target as { closest?: (s: string) => Element | null } | null;
    const block = el?.closest?.(NODE_KEY_SELECTOR) ?? null;
    return block ? block.getAttribute(NODE_KEY_ATTR) : null;
}
