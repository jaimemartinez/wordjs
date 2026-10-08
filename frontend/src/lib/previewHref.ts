/**
 * The draft-preview URL of one entry: /preview/<slug>?type=<its type>.
 *
 * The type is part of the address because a slug alone does not name one entry: a post and a page may
 * share one (pairs older than the backend's shared slug namespace, and the importers' per-type slugs), and
 * the backend resolves the bare slug to the PAGE. Without the type, previewing a post's draft opened the
 * published page that shares its slug. Only a well-formed type is added (the backend refuses any other
 * spelling with a 400); without one the URL is what it always was.
 */
const POST_TYPE = /^[a-z0-9_-]{1,64}$/;

export function previewHref(slugOrId: string | number, type?: string | null): string {
    const base = `/preview/${encodeURIComponent(String(slugOrId))}`;
    return typeof type === "string" && POST_TYPE.test(type) ? `${base}?type=${encodeURIComponent(type)}` : base;
}
