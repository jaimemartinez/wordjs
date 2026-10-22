/**
 * What the canvas does to the blocks around a text that is being edited in place.
 *
 * Inline editing dims the OTHER blocks so the one being written stands out. "Other" used to mean every
 * block whose key is not the edited one, and that included the blocks that CONTAIN it: a heading
 * inside a Section or a column is drawn inside the Section's element, and `opacity` applies to an
 * element and everything painted inside it. So editing any text inside a container faded the text
 * being written to 40%, nearly invisible on a light background. An ancestor of the edited block is
 * never dimmed now; neither is the edited block itself.
 *
 * The same blocks — the edited one and its ancestors, the "inline path" — also stop their own
 * interactions and entrance animations while the text is edited (INLINE_PATH_CSS): a scroll-scrubbed
 * fade left the text frozen at whatever opacity the canvas scroll position gave it (12% in the demo's
 * "how it works" scene). While editing, the text shows its real colour and opacity; the animation comes
 * back when the session ends.
 */
import { ROOT_ID, type VersoNode } from "@/lib/verso/types";

/** Ancestors deeper than this are a broken (cyclic) tree: stop rather than loop. */
const MAX_DEPTH = 256;

/** Where a block stands while a text is edited inline: nothing being edited, on the path to it, or not. */
export type InlineEditRole = "idle" | "path" | "dimmed";

export function inlineEditRole(
    nodes: Record<string, VersoNode>,
    nodeKey: string,
    editingKey: string | null,
): InlineEditRole {
    if (editingKey === null) return "idle";
    let current: string | undefined = editingKey;
    for (let depth = 0; current && current !== ROOT_ID && depth < MAX_DEPTH; depth++) {
        if (current === nodeKey) return "path"; // the edited block, or one that contains it
        current = Object.hasOwn(nodes, current) ? nodes[current].parentId : undefined;
    }
    return "dimmed";
}

export function dimmedWhileEditing(
    nodes: Record<string, VersoNode>,
    nodeKey: string,
    editingKey: string | null,
): boolean {
    return inlineEditRole(nodes, nodeKey, editingKey) === "dimmed";
}

/** The attribute VersoBlock puts on its wrapper while it is on the inline path. */
export const INLINE_PATH_ATTR = "data-verso-inline-path";

/**
 * Canvas-only CSS: on the inline path, a block's own interaction (`data-wjs-ix-on`) and entrance
 * animation (`data-wjs-anim`) layers — direct children of its wrapper, or one level below the shell —
 * render their resting state. Never reaches the published site: the canvas engine writes it into the
 * editor's frame only.
 */
export const INLINE_PATH_CSS =
    `:is([${INLINE_PATH_ATTR}] > [data-wjs-ix-on], [${INLINE_PATH_ATTR}] > * > [data-wjs-ix-on],` +
    ` [${INLINE_PATH_ATTR}] > [data-wjs-anim], [${INLINE_PATH_ATTR}] > * > [data-wjs-anim])` +
    `{animation:none!important;transition:none!important;opacity:1!important;transform:none!important;filter:none!important}`;
