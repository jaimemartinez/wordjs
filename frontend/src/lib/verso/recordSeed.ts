import type { VersoData } from "@/lib/verso/types";

/**
 * Re-applies the RECORD's root fields over a document that arrived from the live-collaboration room.
 *
 * The editor host seeds the root from the database (title, slug, category, tags, excerpt, featured
 * image, SEO, template…), because the record is the source of truth for those fields. The room's
 * document is the stored `_puck_data`, which may lack them — a copy made with "Duplicate", an entry
 * written through the API, an older document — and the room's welcome replaced the whole document, so
 * the Slug field and the category picker went blank. Only keys the room's root does NOT have are
 * filled: whatever a collaborator has set in the room is never overridden. Works on the stored shape
 * (VersoData) and on the collaboration layer's normalized one (VersoDoc): both carry the same `root`.
 */
export function withRecordSeed<T extends { root: VersoData["root"] }>(doc: T, seed: VersoData["root"] | undefined | null): T {
    if (!seed || !doc) return doc;
    const seedRoot = seed as Record<string, any>;
    const docRoot = (doc.root || {}) as Record<string, any>;
    const seedProps = (seedRoot.props && typeof seedRoot.props === "object" ? seedRoot.props : {}) as Record<string, unknown>;
    const docProps = (docRoot.props && typeof docRoot.props === "object" ? docRoot.props : {}) as Record<string, unknown>;
    let changed = false;
    const props: Record<string, unknown> = { ...docProps };
    for (const [key, value] of Object.entries(seedProps)) {
        if (value !== undefined && props[key] === undefined) { props[key] = value; changed = true; }
    }
    const root: Record<string, any> = { ...docRoot, props };
    for (const key of ["title", "slug"]) {
        if (seedRoot[key] !== undefined && root[key] === undefined) { root[key] = seedRoot[key]; changed = true; }
    }
    if (!changed) return doc;
    // The collaboration layer hands a normalized document (lib/verso/types VersoDoc) that records whether
    // the stored data had a `root` key; it does now.
    const out = { ...doc, root } as T & { rootKeyPresent?: boolean };
    if ("rootKeyPresent" in out) out.rootKeyPresent = true;
    return out;
}
