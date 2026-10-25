/**
 * «Plantillas de correo» editor helpers (conference-manager 2.36.14) — the pure part, pinned by the tests.
 *
 * - Placeholders read as names: what is stored (and sent to the server) is `{name}`; what the admin sees and types
 *   is `{Nombre de la persona}` in the admin's language. `toDisplay` / `fromDisplay` swap ONLY the template's own
 *   placeholders, so any other text in braces stays exactly as typed.
 * - The formatting toolbar writes the existing small markup for the admin: **negrita**, «- » lists and
 *   [texto](https://…) links — nobody has to know it.
 * - Checks said in place: an empty subject, a link that is not https:// (or mailto:).
 */

export type Placeholder = { key: string; label: Record<string, string>; sample?: Record<string, string>; subject_only?: boolean };
export type Edit = { value: string; start: number; end: number };

const labelOf = (p: Placeholder, lang: string) => (p.label && (p.label[lang] || p.label.es)) || p.key;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `{name}` → `{Nombre de la persona}` for this template's placeholders. */
export function toDisplay(text: string, placeholders: Placeholder[], lang: string): string {
    let out = String(text || '');
    for (const p of placeholders || []) out = out.split(`{${p.key}}`).join(`{${labelOf(p, lang)}}`);
    return out;
}

/** `{Nombre de la persona}` → `{name}` (the longest names first, so one name inside another never breaks it). */
export function fromDisplay(text: string, placeholders: Placeholder[], lang: string): string {
    let out = String(text || '');
    const list = [...(placeholders || [])].sort((a, b) => labelOf(b, lang).length - labelOf(a, lang).length);
    for (const p of list) out = out.replace(new RegExp(`\\{${escapeRe(labelOf(p, lang))}\\}`, 'g'), `{${p.key}}`);
    return out;
}

/** The chip text a placeholder inserts (`{Nombre de la persona}`). */
export const chipToken = (p: Placeholder, lang: string) => `{${labelOf(p, lang)}}`;

/** `token` replaces the selection; the caret goes right after it. */
export function insertAt(value: string, start: number, end: number, token: string): Edit {
    const v = String(value || '');
    const a = Math.max(0, Math.min(start, v.length)), b = Math.max(a, Math.min(end, v.length));
    const next = v.slice(0, a) + token + v.slice(b);
    return { value: next, start: a + token.length, end: a + token.length };
}

/** «Negrita»: the selection between ** **; with nothing selected, `**word**` with `word` selected to type over. */
export function applyBold(value: string, start: number, end: number, word = 'texto'): Edit {
    const v = String(value || '');
    const sel = v.slice(start, end);
    if (sel) {
        const next = `${v.slice(0, start)}**${sel}**${v.slice(end)}`;
        return { value: next, start: start + 2, end: end + 2 };
    }
    const next = `${v.slice(0, start)}**${word}**${v.slice(end)}`;
    return { value: next, start: start + 2, end: start + 2 + word.length };
}

/** «Lista»: every line the selection touches (or the caret's line) starts with «- » (lines that already do are left). */
export function applyList(value: string, start: number, end: number): Edit {
    const v = String(value || '');
    const from = v.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const nl = v.indexOf('\n', end);
    const to = nl === -1 ? v.length : nl;
    const lines = v.slice(from, to).split('\n');
    let added = 0;
    const out = lines.map((l) => {
        if (/^\s*- /.test(l)) return l;
        added += 2;
        return `- ${l}`;
    }).join('\n');
    const next = v.slice(0, from) + out + v.slice(to);
    return { value: next, start: from, end: to + added };
}

/** «Enlace»: `[text](url)` replaces the selection; the caret goes after it. */
export function applyLink(value: string, start: number, end: number, text: string, url: string): Edit {
    const label = String(text || '').replace(/[[\]\n]/g, ' ').trim() || String(url || '').trim();
    return insertAt(value, start, end, `[${label}](${String(url || '').trim()})`);
}

/** A link the e-mail can carry: https:// or mailto:. */
export const isSafeUrl = (url: string) => /^(https:\/\/[^\s()<>]+|mailto:[^\s()<>@]+@[^\s()<>]+)$/i.test(String(url || '').trim());

/** The links of a text whose address is not https:// or mailto: (what the server would refuse to link). */
export function badLinks(text: string): string[] {
    const out: string[] = [];
    const re = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(text || '')))) if (!isSafeUrl(m[2])) out.push(m[2]);
    return out;
}

/** Has the draft changed from what is stored (or from the default when nothing is)? */
export function isDirty(draft: Record<string, string>, base: Record<string, string>): boolean {
    return ['subject', 'body', 'after', 'action'].some((k) => String(draft[k] || '') !== String(base[k] || ''));
}

/** The most recent edit of a template across its languages (ISO string), or null. */
export function lastEdited(edits: Record<string, { updated_at?: string | null }> | null | undefined): string | null {
    let best: string | null = null;
    for (const e of Object.values(edits || {})) if (e && e.updated_at && (!best || e.updated_at > best)) best = e.updated_at;
    return best;
}
