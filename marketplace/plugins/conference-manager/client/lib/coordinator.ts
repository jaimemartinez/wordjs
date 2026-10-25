/**
 * A locality's coordinator data (conference-manager 2.36.12, «Editar encargado»): what the edit sheet sends and
 * what the card says about the welcome e-mail. Pure functions — the sheet (client/admin/CoordinatorSheet.tsx) and
 * the card (CoordinatorMail.tsx) use them, the tests pin them.
 */
import { toE164 } from "./phone";

export const COORDINATOR_EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const COORDINATOR_NAME_MAX = 120;

export type CoordinatorDraft = { name: string; phone: string; email: string };
export type CoordinatorPatch = { responsible_name?: string; responsible_phone?: string; responsible_email?: string };
export type CoordinatorErrors = Partial<Record<'name' | 'phone' | 'email', string>>;

const norm = (v: unknown) => String(v == null ? '' : v).trim();

/** The sheet's starting values: what the locality has stored. */
export const draftOf = (loc: { responsible_name?: string | null; responsible_phone?: string | null; responsible_email?: string | null }): CoordinatorDraft =>
    ({ name: norm(loc.responsible_name), phone: norm(loc.responsible_phone), email: norm(loc.responsible_email) });

/**
 * The fields that changed — and only those (an old phone typed before E.164 is not re-checked while it is left
 * alone) — or the errors, by field. `msg(key, fallback)` gives the texts in the admin's language.
 */
export function coordinatorPatch(loc: Parameters<typeof draftOf>[0], draft: CoordinatorDraft, defaultCountry: string | null | undefined,
    msg: (key: string, fallback: string) => string = (_k, f) => f): { patch: CoordinatorPatch; errors: CoordinatorErrors; changed: ('name' | 'phone' | 'email')[] } {
    const before = draftOf(loc);
    const patch: CoordinatorPatch = {};
    const errors: CoordinatorErrors = {};
    const changed: ('name' | 'phone' | 'email')[] = [];
    const name = norm(draft.name).replace(/\s+/g, ' ');
    if (name !== before.name) {
        if (name.length > COORDINATOR_NAME_MAX) errors.name = msg('loc.coord.name.long', 'El nombre es demasiado largo (120 caracteres como máximo).');
        patch.responsible_name = name; changed.push('name');
    }
    const phone = norm(draft.phone);
    if (phone !== before.phone) {
        if (phone && !toE164(phone, defaultCountry)) errors.phone = msg('loc.coord.phone.invalid', 'Escoge el país y escribe un número válido.');
        patch.responsible_phone = phone; changed.push('phone');
    }
    const email = norm(draft.email);
    if (email !== before.email) {
        if (email && (email.length > 254 || !COORDINATOR_EMAIL_RE.test(email))) errors.email = msg('loc.mail.invalid', 'Escribe un correo válido.');
        patch.responsible_email = email; changed.push('email');
    }
    return { patch, errors, changed };
}

/**
 * The welcome e-mail's state on the card: 'none' (no e-mail), 'never' (never sent), 'sent' (sent to this address)
 * or 'stale' (sent, but to an address the coordinator no longer has: «No enviado al nuevo correo»).
 */
export function welcomeState(loc: { responsible_email?: string | null; welcome_sent_s?: number | string | null; welcome_sent_to?: string | null }): 'none' | 'never' | 'sent' | 'stale' {
    const email = norm(loc.responsible_email).toLowerCase();
    if (!email) return 'none';
    if (!loc.welcome_sent_s) return 'never';
    const to = norm(loc.welcome_sent_to).toLowerCase();
    return to && to !== email ? 'stale' : 'sent';
}
