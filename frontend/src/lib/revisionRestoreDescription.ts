import type { Revision, RevisionRestoreField } from "@/lib/api";

const LEGACY_FIELDS: RevisionRestoreField[] = [
    { name: "title", description: "Editorial title", storage: "column", present: true, willClear: false },
    { name: "content", description: "Primary document content", storage: "column", present: true, willClear: false },
    { name: "excerpt", description: "Editorial summary", storage: "column", present: true, willClear: false },
    { name: "meta:_puck_data", description: "Page layout", storage: "meta", present: true, willClear: false },
    { name: "meta:_wjs_template", description: "Theme template", storage: "meta", present: true, willClear: false },
    { name: "meta:_thumbnail_id", description: "Featured image", storage: "meta", present: true, willClear: false },
    { name: "meta:seo_title", description: "SEO title", storage: "meta", present: true, willClear: false },
    { name: "meta:seo_description", description: "SEO description", storage: "meta", present: true, willClear: false },
    { name: "meta:og_image", description: "Social image", storage: "meta", present: true, willClear: false },
    { name: "meta:noindex", description: "Search indexing preference", storage: "meta", present: true, willClear: false },
];

/**
 * What an author calls each field. The snapshot carries the content schema's own descriptions, written
 * for developers («Publication lifecycle state.», «Stable URL slug.»), and the dialog listed those
 * (QA S1-19). Known fields get their everyday name; anything else (a plugin's) its description, tidied.
 */
const FRIENDLY_NAMES: Record<string, string> = {
    title: "the title",
    content: "the content",
    excerpt: "the excerpt",
    status: "the status",
    slug: "the URL slug",
    date: "the publication date",
    parent: "the parent page",
    menu_order: "the page order",
    comment_status: "whether comments are open",
    password: "the password",
    "meta:_puck_data": "the page layout",
    "meta:_wjs_template": "the theme template",
    "meta:_thumbnail_id": "the featured image",
    "meta:seo_title": "the SEO title",
    "meta:seo_description": "the SEO description",
    "meta:og_image": "the social image",
    "meta:noindex": "the search indexing choice",
};

function readableName(field: RevisionRestoreField): string {
    const known = FRIENDLY_NAMES[field.name];
    if (known) return known;
    const text = (field.description || field.name.replace(/^meta:/, "")).trim().replace(/\.$/, "");
    return text ? text.charAt(0).toLowerCase() + text.slice(1) : field.name;
}

function naturalList(values: string[]): string {
    if (values.length === 0) return "none";
    if (values.length === 1) return values[0];
    return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

/** Build the destructive disclosure from the snapshot itself, including plugin-declared fields. */
export function buildRevisionRestoreMessage(revision: Pick<Revision, "restore">, when: string): string {
    if (revision.restore?.compatible === false) {
        return `The version from ${when} cannot be restored because its snapshot codec is invalid or unsupported. No data will be changed.`;
    }
    const fields = revision.restore?.fields?.length ? revision.restore.fields : LEGACY_FIELDS;
    const restored = fields.map(readableName);
    const cleared = fields.filter((field) => field.willClear).map(readableName);
    const clearText = cleared.length > 0
        ? ` The snapshot does not contain ${naturalList(cleared)}, so those fields will be cleared.`
        : " A declared field that is absent from this snapshot will be cleared.";
    return `Restoring the version from ${when} brings back ${naturalList(restored)}.` +
        clearText + ` Whatever you changed in them since that version, plus current unsaved changes, is lost.\n\n` +
        `Everything outside that frozen list is untouched, including comments, the editorial review thread, ` +
        `tags, categories and plugin data that this snapshot did not declare.`;
}
