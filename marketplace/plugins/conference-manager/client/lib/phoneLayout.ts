/**
 * The conference screens on a phone (2.16.0) — the layout rules behind ConferenceManagerContent and the
 * role editor, as plain CSS strings each component renders in its own <style>, plus one pure helper.
 *
 * - `SHELL_CSS`: on a desktop the conference screen is an app shell — title and tabs fixed, the tab's
 *   content scrolling inside a white panel of `h-full` / `overflow-auto` (a fixed-height box). On a phone
 *   that box was all that was left under the admin header, the title and the tab strip: a ~500 px window
 *   scrolling inside the page, its headings («Estructura de campos») and buttons cut at its edges. Below
 *   768 px wide (where the admin swaps its sidebar for the mobile header), or below 600 px high (a phone
 *   held sideways), the shell takes its natural height and the whole screen scrolls with the page —
 *   the plugin wrapper of the admin shell is the one scroller. From there up nothing changes, so the
 *   desktop layouts (the fields list beside the form simulator) stay exactly as they were. Below 640 px
 *   the shell's three nested 24 px paddings are compacted (they took 100 px of a 390 px screen).
 * - `PERM_MATRIX_CSS`: the role editor's sections × levels table needed 560 px; on a phone it scrolled
 *   sideways inside the dialog and only «Sin acceso» was in view — «Ver» and «Gestionar» looked absent.
 *   Below PERM_MATRIX_TABLE_MIN_WIDTH each section is a row of its own: name and description on top, its
 *   three levels side by side under it, each with its caption. At every width the header row (the level
 *   names; «Sección» too on the table) stays at the top of the dialog's scroller while the sections scroll
 *   under it — it used to scroll away, leaving eleven rows of unlabelled radio columns.
 * - `revealDelta(strip, tab, fade)`: how far to scroll a tab strip so the active tab is in view — clear of
 *   the strip's edge fade (a phone shows three of twelve tabs; after a reload the active «Campos» was
 *   off-screen, and a tab tapped at the edge stayed under the fade, its label and underline faded out).
 *
 * UNLAYERED on purpose (like OVERLAY_CSS in overlay.ts): the rules win over the Tailwind utilities on the
 * same elements (`h-full`, `overflow-hidden`, `flex-1`, `min-w-[560px]`…, all in @layer utilities, the
 * plugin's own one sub-layer lower) without !important, and they do not depend on any plugin class having
 * been compiled. No DOM access here.
 */
import { COARSE_FIELDS_CSS } from './overlay';

/** Below this width or this height the conference screen scrolls with the page instead of in a panel. */
export const SHELL_PANEL_MIN_WIDTH = 768;
export const SHELL_PANEL_MIN_HEIGHT = 600;

/**
 * Where the panel IS the scroller (from SHELL_PANEL_MIN_WIDTH wide and SHELL_PANEL_MIN_HEIGHT high), its top
 * padding (`p-6`, 24 px) is where a sticky element inside it stops (see PERM_MATRIX_STICKY_TOP): the lodging
 * explorer's breadcrumb (`[data-explorer-crumbs]`, `sticky top-0`) stopped 24 px below the panel's top, and
 * the explorer's content scrolled visibly through that band above it. In the panel its `top` is minus that
 * padding, flush with the panel's top. Where the page scrolls instead (the admin's plugin wrapper, which has
 * no padding) `top: 0` is already flush, so the rule only exists in the panel's media query.
 */
export const SHELL_PANEL_STICKY_TOP = '-1.5rem';

export const SHELL_CSS = `
@media (max-width: ${SHELL_PANEL_MIN_WIDTH - 0.02}px), (max-height: ${SHELL_PANEL_MIN_HEIGHT - 0.02}px) {
  [data-cm-shell] { height: auto; min-height: 100%; overflow: visible; }
  [data-cm-shell-body] { flex: none; min-height: 0; overflow: visible; }
  [data-cm-shell-panel] { height: auto; overflow: visible; }
}
@media (min-width: ${SHELL_PANEL_MIN_WIDTH}px) and (min-height: ${SHELL_PANEL_MIN_HEIGHT}px) {
  [data-cm-shell-panel] [data-explorer-crumbs] { top: ${SHELL_PANEL_STICKY_TOP}; }
}
@media (max-width: 639.98px) {
  [data-cm-shell-head] { padding: 1rem 1rem 0; }
  [data-cm-shell-head] > :first-child { margin-bottom: 1.25rem; }
  [data-cm-shell-tabs] { margin-bottom: 1rem; }
  [data-cm-shell-tabs] > button { padding-left: 1rem; padding-right: 1rem; }
  [data-cm-shell-body] { padding: 0 0.75rem 1rem; }
  [data-cm-shell-panel] { padding: 1rem; }
}
${COARSE_FIELDS_CSS('[data-cm-shell]')}
`;

/**
 * From this width the role editor's levels are a table (its 560 px fit: the dialog at 680 px is 648 px wide,
 * 582 px inside its padding); below it, a row per section.
 *
 * The header row is STICKY in the dialog's scroller (its body, `overflow-y-auto`). A sticky element sticks
 * in its nearest scroll container, and the matrix's own wrapper was one (`overflow-x-auto`, which makes
 * overflow-y auto too) that never scrolls vertically, so the header scrolled away with the rows. The wrapper
 * now only clips its rounded corners (`overflow: clip` is not a scroll container; a browser without it keeps
 * `visible`), and the table needs no sideways scroll: below this width it is the phone layout.
 *
 * A sticky element stops at its scroller's PADDING edge, not at the scroller's top: with `top: 0` the header
 * stopped 32 px (24 px on a phone) down, and the sections scrolled visibly through that band above it. Its
 * `top` is therefore minus the body's own top padding — PERM_MATRIX_STICKY_TOP, the body's `p-6 sm:p-8` —
 * so it sits flush with the top of the scroller.
 */
export const PERM_MATRIX_TABLE_MIN_WIDTH = 680;
export const PERM_MATRIX_STICKY_TOP = { belowSm: '-1.5rem', fromSm: '-2rem' } as const;

const HEAD_BG = 'background-color: #f9fafb; box-shadow: inset 0 -1px 0 #f3f4f6;';
export const PERM_MATRIX_CSS = `
[data-perm-matrix] { overflow: visible; overflow: clip; }
[data-perm-matrix] thead th { position: sticky; top: ${PERM_MATRIX_STICKY_TOP.fromSm}; z-index: 2; ${HEAD_BG} }
@media (min-width: ${PERM_MATRIX_TABLE_MIN_WIDTH}px) {
  [data-perm-matrix] [data-perm-caption=""] { display: none; }
}
@media (max-width: ${PERM_MATRIX_TABLE_MIN_WIDTH - 0.02}px) {
  [data-perm-matrix] table { display: block; min-width: 0; }
  [data-perm-matrix] thead { display: block; position: sticky; top: ${PERM_MATRIX_STICKY_TOP.fromSm}; z-index: 2; }
  [data-perm-matrix] thead tr { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 0 0.25rem; ${HEAD_BG} }
  [data-perm-matrix] thead th { position: static; display: block; width: auto; padding: 0.5rem 0.25rem; text-align: center; box-shadow: none; }
  [data-perm-matrix] thead th:first-child { display: none; }
  [data-perm-matrix] tbody { display: block; }
  [data-perm-matrix] tr[data-perm-row] { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 0.5rem 0.25rem 0.75rem; }
  [data-perm-matrix] tr[data-perm-row] + tr[data-perm-row] { border-top: 1px solid #f9fafb; }
  [data-perm-matrix] tr[data-perm-row] > th { grid-column: 1 / -1; display: block; padding: 0.25rem 0.75rem 0.5rem; }
  [data-perm-matrix] tr[data-perm-row] > td { display: flex; justify-content: center; align-items: flex-start; padding: 0.25rem; }
}
@media (max-width: 639.98px) {
  [data-perm-matrix] thead { top: ${PERM_MATRIX_STICKY_TOP.belowSm}; }
}
`;

type Box = { left: number; right: number };

/** Width of the strip's edge fade (TAB_STRIP_CSS), in px. */
export const STRIP_FADE_PX = 48;

/** The fade on each side of a strip, given which sides have more tabs (stripOverflow). */
export function stripFade(more: { left: boolean; right: boolean }): { left: number; right: number } {
    return { left: more.left ? STRIP_FADE_PX : 0, right: more.right ? STRIP_FADE_PX : 0 };
}

/**
 * Horizontal scroll (px, to ADD to the strip's scrollLeft) that brings `tab` into the CLEAR part of
 * `strip` — inside it and out from under its edge fades (`fade`, stripFade) — centring it; 0 when it is
 * already there. A tab tapped at the strip's edge was "in view" but under the 48 px fade: «Campos» and its
 * underline faded out on an iPhone SE. Only the strip scrolls — never the page.
 */
export function revealDelta(strip: Box, tab: Box, fade: { left: number; right: number } = { left: 0, right: 0 }): number {
    if (tab.left >= strip.left + fade.left && tab.right <= strip.right - fade.right) return 0;
    return Math.round((tab.left + tab.right) / 2 - (strip.left + strip.right) / 2);
}

/**
 * The «Panel» tab's six stat cards: as many columns as fit cards of 15rem (padding, the 56 px icon, the
 * gap and a label such as «INSCRIPCIONES»). The grid was `xl:grid-cols-6`, chosen by the WINDOW's width:
 * at 1280 px the panel beside the sidebar is ~860 px wide, so six ~120 px cards squeezed each icon into a
 * pill and clipped the labels («INSCRIP», «HOTELE»).
 */
export const STAT_GRID_CLASS = 'grid gap-6 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]';

/**
 * The layer that holds a card's decorative blobs (`absolute -right-20 -top-20 w-80 h-80 …`): the card's
 * own size, clipping them itself, under the card's content.
 *
 * The blobs used to be direct children of an `overflow-hidden` card. Hidden overflow still SCROLLS — by
 * script, by a focus or a scrollIntoView, by find-in-page — and a blob hanging 80 px below the card gave
 * the card 80 px to scroll: on an iPhone SE the «Campos» builder card, scrolled to show its «no puedes
 * publicar» notice, slid its own content up inside itself — «Constructor» and the top of the wand icon cut
 * off by the card's rounded top edge, an empty band at its bottom — and nothing could scroll it back.
 * Inside this layer (inset-0, the same box the card gave them) the blobs look exactly as before, and the
 * card has nothing left to scroll; neither has the layer anything focusable or findable to scroll to.
 */
export const DECO_LAYER_CLASS = 'pointer-events-none absolute inset-0 overflow-hidden';

/**
 * The icon + title row of those cards («Constructor Visual de Formularios», «Link del Portal Público»):
 * below 640 px the 56 px icon goes above the title instead of beside it. Beside it, a 320 px phone left
 * the 30 px italic title ~140 px — narrower than «Formularios» (~166 px) — and the card cut the word at
 * its edge; above it, the title has the card's whole width (~212 px at 320, ~267 at 375).
 */
export const HERO_HEAD_CLASS = 'flex items-center gap-4 mb-5 max-sm:flex-col max-sm:items-start';

/**
 * The conference tab strip scrolls sideways (twelve tabs; a phone shows three, a 1280 px desktop about
 * seven) and a tab at its edge was simply cut — «Campo» on an iPhone SE, «…es» on the desktop — with nothing
 * saying there was more. The strip now fades out on the side that has more tabs: the strip sets
 * `data-more-left` / `data-more-right` from stripOverflow() as it scrolls and resizes (lib/useStripOverflow.ts),
 * and these rules (every width, unlayered like SHELL_CSS) draw the fade. Any other scrolling tab strip of
 * the plugin opts in with `data-cm-scroll-strip` (the «Alimentación» sub-tabs). The fade is STRIP_FADE_PX
 * wide, and revealDelta keeps the active tab out from under it (lib/useStripOverflow.ts useRevealActive).
 */
const F = `${STRIP_FADE_PX}px`;
export const TAB_STRIP_CSS = `
:is([data-cm-shell-tabs], [data-cm-scroll-strip])[data-more-right] { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - ${F}), transparent); mask-image: linear-gradient(to right, #000 calc(100% - ${F}), transparent); }
:is([data-cm-shell-tabs], [data-cm-scroll-strip])[data-more-left] { -webkit-mask-image: linear-gradient(to left, #000 calc(100% - ${F}), transparent); mask-image: linear-gradient(to left, #000 calc(100% - ${F}), transparent); }
:is([data-cm-shell-tabs], [data-cm-scroll-strip])[data-more-left][data-more-right] { -webkit-mask-image: linear-gradient(to right, transparent, #000 ${F}, #000 calc(100% - ${F}), transparent); mask-image: linear-gradient(to right, transparent, #000 ${F}, #000 calc(100% - ${F}), transparent); }
`;

/** Whether a horizontally scrolling strip has content hidden to its left / right (1 px tolerance). */
export function stripOverflow(strip: { scrollLeft: number; scrollWidth: number; clientWidth: number }): { left: boolean; right: boolean } {
    const max = strip.scrollWidth - strip.clientWidth;
    if (!(max > 1)) return { left: false, right: false };
    return { left: strip.scrollLeft > 1, right: strip.scrollLeft < max - 1 };
}
