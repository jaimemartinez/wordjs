/**
 * WordJS — post editor fields contributed by plugins. A GENERIC SEAM.
 *
 * A plugin sometimes needs one setting per entry that the author picks while writing — "email this post
 * to members", "feature on the home page", "hide the share bar". It used to need its own screen for that.
 * Through the `post_editor_fields` filter a plugin DECLARES such a field (data, not code: no plugin
 * script runs in the editor) and core renders it in the entry's settings, seeds it from the entry's meta
 * and saves it back through the normal `meta` bag — so the value lives where every other author-written
 * value lives and the same capability gate applies.
 *
 * The declaration is validated here, whatever a plugin answers:
 *   · `metaKey` must be an UNPREFIXED key (`^[a-z][a-z0-9_]{1,63}$`), so it is ordinary author content,
 *     never a `_`-prefixed internal key and never one of core's own (SEO, template, access level);
 *   · `type` is `select`, `radio` or `text`; options are bounded and their values are short strings;
 *   · `postTypes` limits where it shows (default: posts only).
 * A plugin that acts on the value reads it from the entry (the posts bridge, or the hooks it already
 * receives) and must apply its own policy on WHO may trigger what — an author can write any meta value.
 */

const META_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;
const FIELDS_FILTER = 'post_editor_fields';
const TYPES = new Set(['select', 'radio', 'text']);
/** Keys core already owns as root fields; a plugin cannot claim them. */
const RESERVED_KEYS = new Set(['seo_title', 'seo_description', 'og_image', 'noindex', 'title', 'slug', 'excerpt', 'category', 'tags']);
const MAX_FIELDS = 16;
const MAX_OPTIONS = 24;

export interface EditorFieldOption { value: string; label: string }
export interface EditorField {
    metaKey: string;
    label: string;
    type: 'select' | 'radio' | 'text';
    options?: EditorFieldOption[];
    help?: string;
    postTypes: string[];
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanField(raw: any): EditorField | null {
    if (!raw || typeof raw !== 'object') return null;
    const metaKey = str(raw.metaKey, 64);
    if (!META_KEY_RE.test(metaKey) || RESERVED_KEYS.has(metaKey)) return null;
    const type = TYPES.has(raw.type) ? raw.type : 'select';
    const label = str(raw.label, 120) || metaKey;
    const field: EditorField = { metaKey, label, type, postTypes: ['post'] };
    if (Array.isArray(raw.postTypes)) {
        const types = raw.postTypes.map((t: unknown) => str(t, 32)).filter((t: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(t));
        if (types.length) field.postTypes = Array.from(new Set(types)) as string[];
    }
    const help = str(raw.help, 300);
    if (help) field.help = help;
    if (type !== 'text') {
        const options: EditorFieldOption[] = [];
        for (const o of Array.isArray(raw.options) ? raw.options : []) {
            if (!o || typeof o !== 'object' || typeof o.value !== 'string') continue;
            const value = o.value.slice(0, 64);
            options.push({ value, label: str(o.label, 120) || value || '—' });
            if (options.length >= MAX_OPTIONS) break;
        }
        if (!options.length) return null;
        field.options = options;
    }
    return field;
}

/** The validated fields every active plugin declares for `postType` (deduplicated by meta key). */
async function editorFieldsFor(postType: string): Promise<EditorField[]> {
    try {
        const { applyFilters, hasFilter } = require('./hooks');
        if (!hasFilter(FIELDS_FILTER)) return [];
        const value = await applyFilters(FIELDS_FILTER, [], { postType });
        const out: EditorField[] = [];
        const seen = new Set<string>();
        for (const raw of Array.isArray(value) ? value : []) {
            const field = cleanField(raw);
            if (!field || seen.has(field.metaKey) || !field.postTypes.includes(postType)) continue;
            seen.add(field.metaKey);
            out.push(field);
            if (out.length >= MAX_FIELDS) break;
        }
        return out;
    } catch {
        return [];
    }
}

module.exports = { FIELDS_FILTER, META_KEY_RE, RESERVED_KEYS, cleanField, editorFieldsFor };
