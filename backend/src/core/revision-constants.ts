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

module.exports = {
    LEGACY_REVISIONABLE_META_KEYS,
    REVISION_SNAPSHOT_META_KEY,
};
