/**
 * «Localidades» filters (conference-manager 2.36.19, owner: «que la parte de localidades tenga filtro»): a search by
 * the locality's name or its coordinator (name, phone, e-mail), and one quick filter at a time with its count.
 * Pure: the screen and the tests use it.
 */
import { welcomeState } from "./coordinator";

export type LocationFilter = 'all' | 'lodging_submitted' | 'lodging_validated' | 'no_coordinator' | 'no_email' | 'welcome_pending' | 'full';
export const LOCATION_FILTERS: LocationFilter[] = ['all', 'lodging_submitted', 'lodging_validated', 'no_coordinator', 'no_email', 'welcome_pending', 'full'];

const norm = (s: unknown) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Does the locality match the quick filter? */
export function matchesFilter(l: any, f: LocationFilter): boolean {
    switch (f) {
        case 'lodging_submitted': return l.lodging_status === 'submitted';
        case 'lodging_validated': return l.lodging_status === 'validated';
        case 'no_coordinator': return !String(l.responsible_name || '').trim();
        case 'no_email': return !String(l.responsible_email || '').trim();
        // A coordinator with an e-mail whose welcome was never sent, or went to an old address.
        case 'welcome_pending': { const w = welcomeState(l); return w === 'never' || w === 'stale'; }
        case 'full': return l.capacity != null && Number(l.capacity) > 0 && Number(l.inscribed || 0) >= Number(l.capacity);
        default: return true;
    }
}

/** The localities shown: every word of the search in the name or the coordinator's data, and the quick filter. */
export function filterLocations(list: any[], q: string, f: LocationFilter): any[] {
    const words = norm(q).trim().split(/\s+/).filter(Boolean);
    return list.filter((l) => {
        if (!matchesFilter(l, f)) return false;
        if (!words.length) return true;
        const text = norm([l.name, l.responsible_name, l.responsible_phone, l.responsible_email].filter(Boolean).join(' '));
        const digits = String(l.responsible_phone || '').replace(/\D/g, '');
        return words.every((w) => text.includes(w) || (/^\d+$/.test(w) && digits.includes(w)));
    });
}

/** How many localities each quick filter shows. */
export function locationCounts(list: any[]): Record<LocationFilter, number> {
    const out: any = {};
    for (const f of LOCATION_FILTERS) out[f] = list.filter((l) => matchesFilter(l, f)).length;
    return out;
}
