/**
 * The sentence the WordPress import summary prints when menus were left without a theme location.
 *
 * The backend reports WHY as a stable code (`summary.menus.locations.reason`, core/wxr-menus), never as
 * prose: the page printed that English string verbatim inside a translated sentence (FALLOS 143).
 * `no_locations_in_export` — the export named no location at all (the normal WXR case); no code — it
 * named some, but they matched no imported menu.
 */
export function locationsNoteKey(reason: string | null | undefined): string {
    return reason ? "wpImport.menus.noLocation" : "wpImport.menus.unmatchedLocation";
}
