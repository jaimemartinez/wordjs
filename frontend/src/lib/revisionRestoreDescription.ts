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

function readableName(field: RevisionRestoreField): string {
    return (field.description || field.name.replace(/^meta:/, "")).trim();
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
    return `Restoring the version from ${when} replaces these declared fields: ${naturalList(restored)}.` +
        clearText + ` Whatever you changed in them since that version, plus current unsaved changes, is lost.\n\n` +
        `Everything outside that frozen list is untouched, including comments, the editorial review thread, ` +
        `tags, categories and plugin data that this snapshot did not declare.`;
}
