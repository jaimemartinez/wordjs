/**
 * Data-safety guards for the block editor's save path.
 *
 * The editor pages (admin/posts/[id] and admin/pages/[id]) load an existing record's content, then
 * mount the Puck editor with it. If that load FAILS (a transient GET 500 / network blip), the old code
 * only console.error'd and dropped through to an editor mounted with the EMPTY default
 * ({content:[],root:{}}). A subsequent save — manual or the 8s autosave — would then PUT that empty
 * content over the real record, silently and (because autosave skips the revision snapshot)
 * irrecoverably destroying the post/page body.
 *
 * These guards make that impossible: an EXISTING record is never saved until its content has
 * successfully hydrated. A NEW record has nothing to hydrate, so an empty body is correct and always
 * saveable.
 */

/**
 * Should a save be BLOCKED because the editor hasn't hydrated the existing record's content yet?
 * Returns true only for an existing record whose load has not completed successfully — blocking both
 * the manual save and the background autosave from overwriting real content with an empty editor.
 */
export function unhydratedSaveBlocked(opts: { isNew: boolean; loaded: boolean }): boolean {
    return !opts.isNew && !opts.loaded;
}
