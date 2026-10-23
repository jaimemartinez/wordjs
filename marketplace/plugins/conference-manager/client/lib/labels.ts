/**
 * Display labels for values the plugin STORES in Spanish (conference-manager 2.33.1, FALLOS 141): the forms of
 * payment («Efectivo» / «Transferencia») and a switch field's answer («Sí» / «No»). The stored values never
 * change — the server, the rules, the exports and existing data keep reading them — only what the admin shows
 * follows its language (es / en / pt). `tr` is the screen's translator: (key, Spanish fallback) → text.
 */
type Tr = (key: string, fallback: string) => string;

const METHOD_KEYS: Record<string, [string, string]> = {
    Efectivo: ['payment.method.cash', 'Efectivo'],
    Transferencia: ['payment.method.transfer', 'Transferencia'],
};

/** «Efectivo» → «Cash» in English; an unknown method (an older ledger entry) is shown as stored. */
export function paymentMethodLabel(tr: Tr, method: string | null | undefined): string {
    const m = String(method ?? '');
    const k = METHOD_KEYS[m];
    return k ? tr(k[0], k[1]) : m;
}

/** A switch field's answer shown in the admin's language («Sí» → «Yes»). */
export const switchLabel = (tr: Tr, on: boolean): string => (on ? tr('switch.yes', 'Sí') : tr('switch.no', 'No'));

/** A form value as a list shows it: a switch field's stored «Sí» / «No» in the admin's language, anything else as is. */
export const shownFieldValue = (tr: Tr, field: { type?: string | null } | null | undefined, value: string): string =>
    field && field.type === 'switch' && value ? switchLabel(tr, value.trim().toLowerCase() !== 'no') : value;
