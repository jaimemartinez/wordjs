/**
 * Portal-wide rules that no Tailwind utility can express reliably (a plain module: PortalFrame and the tests import it,
 * so it must not be a "use client" module, whose exports would reach a server component as references).
 *
 * PORTAL_COARSE_FIELDS_CSS — 16 px fields on EVERY touch screen (`pointer: coarse`), whatever its width. The
 * fields are `text-base sm:text-sm` (16 px below 640 px, 14 px from there): an iPhone held sideways is 667–932 px
 * wide, so its fields were 14 px (12 px in the pager) and iOS Safari zoomed the page into the field a coordinator
 * tapped — «Referencia» of «Registrar pago» — and stayed zoomed. Unlayered, so it wins over the Tailwind
 * utilities (`@layer utilities`) without !important. Scoped to the portal page (`data-portal-safe-area`, the
 * layout's wrapper) and to its sheets, which are portalled to <body> (`data-portal-overlay`). A large field
 * (text-lg and up: the «Monto total») keeps its own size.
 */
/**
 * PORTAL_SHORT_SHEET_CSS — a SHORT screen (an iPhone held sideways: 390 px tall) keeps a sheet's room for its body.
 * The header, body and footer paddings and the title size come from `sm:` (640 px WIDE) variants: sideways the
 * header was ~116 px and the footer ~109 px of a 359 px sheet, and the body — what the coordinator fills — had
 * ~130 px, about one field. Below 500 px of height they are compact, and the sheet may take the whole height.
 * Unlayered (wins over the utilities); the sheets are portalled to <body>, so the rules key on their data
 * attributes, not on the page wrapper.
 */
export const PORTAL_SHORT_SHEET_CSS = `@media (max-height: 500px) {
  [data-portal-overlay] { padding-top: 0.25rem; padding-bottom: 0.25rem; }
  [data-portal-sheet] { max-height: calc(100dvh - 0.5rem); }
  [data-portal-sheet-head] { padding: 0.5rem 0.75rem 0.5rem 1.25rem; }
  [data-portal-sheet-head] h3 { font-size: 1.125rem; line-height: 1.5rem; }
  [data-portal-sheet-body] { padding: 0.75rem 1.25rem; }
  [data-portal-sheet-foot] { padding-top: 0.5rem; padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0px)); }
  [data-portal-sheet-foot] [data-portal-sheet-note] { margin-bottom: 0; }
}`;

export const PORTAL_COARSE_FIELDS_CSS = `@media (pointer: coarse) {
  :is([data-portal-safe-area], [data-portal-overlay]) :is(input, select, textarea):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([class*="text-lg"]):not([class*="text-xl"]):not([class*="text-2xl"]):not([class*="text-3xl"]) { font-size: 16px; }
}`;
