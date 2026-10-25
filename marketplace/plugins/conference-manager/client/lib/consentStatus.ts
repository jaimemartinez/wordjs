/**
 * «Autorizaciones» at a glance (conference-manager 2.36.16) — one status per person, from the state the server
 * keeps (GET /consent/states), and the filters of the admin's list. Pure: the screen and the tests use it.
 *
 *   verbal           Autorizado (verbal): agreed when registered by the team, waiting for the written confirmation
 *   overdue          Vencido: that verbal authorization is past «Días para confirmar» without the written one
 *   confirmed_code   Confirmado (código): signed with the one-time code
 *   confirmed_paper  Confirmado (papel): signed on the paper sheet
 *   none             Sin autorización: nothing yet (a link may have been sent)
 *   revoked          Retirado: the person withdrew it
 */

export type ConsentStatus = 'verbal' | 'overdue' | 'confirmed_code' | 'confirmed_paper' | 'none' | 'revoked';
export const STATUS_ORDER: ConsentStatus[] = ['none', 'verbal', 'overdue', 'confirmed_code', 'confirmed_paper', 'revoked'];

/** Color and icon of each status (Font Awesome free). */
export const STATUS_LOOK: Record<ConsentStatus, { tone: string; icon: string }> = {
    none: { tone: 'bg-gray-100 text-gray-700 border-gray-200', icon: 'fa-circle-question' },
    verbal: { tone: 'bg-amber-50 text-amber-800 border-amber-200', icon: 'fa-comment-dots' },
    overdue: { tone: 'bg-rose-50 text-rose-800 border-rose-200', icon: 'fa-clock' },
    confirmed_code: { tone: 'bg-emerald-50 text-emerald-800 border-emerald-200', icon: 'fa-circle-check' },
    confirmed_paper: { tone: 'bg-emerald-50 text-emerald-800 border-emerald-200', icon: 'fa-file-signature' },
    revoked: { tone: 'bg-slate-100 text-slate-700 border-slate-300', icon: 'fa-ban' },
};

/** The person's status. `st` is their row of GET /consent/states (undefined: never asked). */
export function statusOf(st: any): ConsentStatus {
    if (!st) return 'none';
    if (st.state === 'revoked') return 'revoked';
    if (st.state === 'granted') return st.method === 'paper' ? 'confirmed_paper' : 'confirmed_code';
    if (st.verbal_general || st.verbal_health) return st.verbal_overdue ? 'overdue' : 'verbal';
    return 'none';
}

/** What to add under the status, as a key of the copy: where the request stands. */
export function detailOf(st: any, noEmail: boolean): 'no_email' | 'never_sent' | 'mail_failed' | 'link_expired' | 'link_sent' | 'health_verbal' | null {
    const s = statusOf(st);
    if (s === 'confirmed_code' || s === 'confirmed_paper') return st && st.verbal_health ? 'health_verbal' : null;
    if (s === 'revoked') return null;
    if (noEmail && !(st && st.email_masked)) return 'no_email';
    if (!st || (!st.email_masked && !st.mail_failed)) return 'never_sent';
    if (st.mail_failed) return 'mail_failed';
    if (st.link_expired) return 'link_expired';
    return 'link_sent';
}

/** May the team ask this person again (a link, a message, a paper sheet)? Not once confirmed. */
export const canRequest = (s: ConsentStatus) => s !== 'confirmed_code' && s !== 'confirmed_paper';

/** Counts per status (cancelled registrations left out). */
export function countsOf(people: any[], states: Record<string, any>): Record<ConsentStatus | 'all', number> {
    const c: any = { all: 0 };
    for (const k of STATUS_ORDER) c[k] = 0;
    for (const p of people) {
        if (p.status === 'cancelled') continue;
        c.all++;
        c[statusOf(states[p.id])]++;
    }
    return c;
}

const norm = (s: unknown) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The text a row is searched by: its name, its locality and every answer (the document among them). */
export function searchText(p: any): string {
    return norm(Object.entries(p || {}).filter(([k, v]) => v != null && typeof v !== 'object' && !/^(id|conference_id|location_id|status|registration_date|reg_code)$/.test(k)).map(([, v]) => v).join(' '));
}

/** The rows the list shows: the search (name, document, locality…), one status (or all) and one locality. */
export function filterPeople(people: any[], states: Record<string, any>, f: { q?: string; status?: ConsentStatus | 'all'; location?: string }): any[] {
    const words = norm(f.q || '').trim().split(/\s+/).filter(Boolean);
    return people.filter((p) => {
        if (p.status === 'cancelled') return false;
        if (f.status && f.status !== 'all' && statusOf(states[p.id]) !== f.status) return false;
        if (f.location && String(p.location_id ?? '') !== String(f.location)) return false;
        if (words.length) { const t = searchText(p); if (!words.every((w) => t.includes(w))) return false; }
        return true;
    });
}

/** Of a selection, who can be sent the e-mail request now (not confirmed, an e-mail on file). */
export function sendable(ids: number[], states: Record<string, any>, noEmail: Set<number>): number[] {
    return ids.filter((id) => canRequest(statusOf(states[id])) && !noEmail.has(Number(id)));
}

/** The one locality a selection belongs to (a paper sheet is per locality), or null when it spans several. */
export function oneLocation(ids: number[], people: any[]): string | null {
    const locs = new Set(people.filter((p) => ids.includes(Number(p.id))).map((p) => String(p.location_id ?? '')));
    return locs.size === 1 ? [...locs][0] || null : null;
}
