/** Stable names shared by the declarative schema, snapshot codec and request guards. */

/**
 * Metadata restored by revisions created before F4. This list is immutable compatibility data: new
 * snapshots obtain their field set from the content schema, but a row without an F4 manifest must
 * always mean what it meant when it was written.
 */
export const LEGACY_REVISIONABLE_META_KEYS = Object.freeze([
    '_puck_data',
    '_wjs_template',
    '_thumbnail_id',
    'seo_title',
    'seo_description',
    'og_image',
    'noindex',
] as const);

/** Core-owned post_meta row containing the F4 snapshot envelope. */
export const REVISION_SNAPSHOT_META_KEY = '_wjs_revision_snapshot';

/**
 * Core-owned post_meta row on a REVISION naming who made the write that revision was taken before — set
 * only when it was an AI agent (core/agent-publishing revisionSourceFor). Never part of the snapshot
 * envelope, so a restore never copies it onto the live entry.
 */
export const REVISION_SOURCE_META_KEY = '_wjs_revision_source';

module.exports = {
    LEGACY_REVISIONABLE_META_KEYS,
    REVISION_SNAPSHOT_META_KEY,
    REVISION_SOURCE_META_KEY,
};
