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

/**
 * Legacy-HTML seeding (admin/pages/[id] and admin/posts/[id], loadPage/loadPost): a post/page saved
 * before the block editor existed (or imported via WXR) has its body as raw HTML in `content` with no
 * `_puck_data`. Rather than opening a blank canvas, that HTML is wrapped in a single editable
 * HTMLEmbed block so it is visible and round-trips back into `content` on the next change/save.
 *
 * `recordId` must be the record's real id (not "new") — it becomes part of the block's `id`, which is
 * also used as a DOM/selection key elsewhere, so it must be stable across a page's lifetime.
 *
 * Returns BOTH the seeded Puck `data` to mount the canvas with, and `legacyHtml` — the exact string
 * that must be kept in editorGuards' companion function `applyLegacyHtmlFallback` (via the caller's
 * `legacyHtmlRef`) until the user actually builds real blocks.
 */
export function seedLegacyPuckData(opts: {
    html: string;
    title: string;
    slug: string;
    recordId: number | string;
    wjsTemplate: string;
    extraRootProps?: Record<string, unknown>;
}): {
    data: {
        content: Array<{ type: string; props: Record<string, unknown> }>;
        root: { title: string; slug: string; props: Record<string, unknown> };
    };
    legacyHtml: string | null;
} {
    const legacyHtml = opts.html || "";
    return {
        data: {
            content: legacyHtml
                ? [{ type: "HTMLEmbed", props: { id: `HTMLEmbed-legacy-${opts.recordId}`, html: legacyHtml } }]
                : [],
            root: {
                title: opts.title,
                slug: opts.slug,
                props: {
                    title: opts.title,
                    slug: opts.slug,
                    category: "",
                    _wjs_template: opts.wjsTemplate,
                    ...opts.extraRootProps,
                },
            },
        },
        // "" seeds to null, matching the original `legacyHtml || null` — an empty body is not a legacy
        // body to protect, it's just a new/empty record.
        legacyHtml: legacyHtml || null,
    };
}

/**
 * Legacy-HTML save-time preservation (admin/pages/[id] and admin/posts/[id], handleSubmit): a legacy
 * record seeded by seedLegacyPuckData() whose canvas is STILL EMPTY (the user hasn't built/kept any
 * real block, e.g. they deleted the seeded HTMLEmbed) must not be saved as blank. Instead the save
 * payload's `content` is restored to the original HTML and `_puck_data` is dropped from `meta` entirely
 * (an empty _puck_data next to a non-empty content would be a lie — the record isn't really block-based
 * yet). Returns `payload` UNCHANGED (same reference) when the fallback does not apply.
 */
export function applyLegacyHtmlFallback<T extends { content: unknown; meta: Record<string, unknown> }>(
    payload: T,
    liveContentLength: number,
    legacyHtml: string | null
): T {
    if (liveContentLength > 0 || !legacyHtml) return payload;
    const meta = { ...payload.meta };
    delete meta._puck_data;
    return { ...payload, content: legacyHtml, meta };
}

/**
 * `meta._wjs_template` must be sent on EVERY save (manual or auto) — the backend merges `meta`
 * per-key, so omitting the key leaves a previous assignment stale forever, while '' explicitly clears
 * it. This coerces whatever is on the live root props to a string, defaulting to '' for anything that
 * isn't already a string (undefined, null, a stale non-string value from old data, ...).
 */
export function resolveWjsTemplateForSave(rootProps: unknown): string {
    const value = (rootProps as { _wjs_template?: unknown } | null | undefined)?._wjs_template;
    return typeof value === "string" ? value : "";
}

/**
 * Post-mount grace window (admin/pages/[id] and admin/posts/[id], the editor's onChange): Puck MAY
 * fire onChange during initialization (migrate/resolveData). Skipping "the first event" by counting
 * was fragile — when no init event fired, the user's FIRST real change got swallowed (save stayed
 * disabled, autosave never armed). Instead, onChange events inside this short window after mount are
 * treated as init noise and do NOT mark the record dirty; anything after it is a human edit.
 */
export const POST_MOUNT_GRACE_MS = 800;

/**
 * Is `nowMs` still inside the post-mount grace window that started at `mountedAtMs`?
 * Inclusive at the boundary: elapsed === POST_MOUNT_GRACE_MS is still WITHIN the grace (not dirty);
 * elapsed of POST_MOUNT_GRACE_MS + 1 is outside (marks dirty). This preserves the original inline
 * check's direction exactly: `setIsDirty(true)` ran only when `now - mountedAt > 800`.
 */
export function isWithinPostMountGrace(mountedAtMs: number, nowMs: number): boolean {
    return nowMs - mountedAtMs <= POST_MOUNT_GRACE_MS;
}
