/**
 * WordJS — Plugin install provenance ("origin binding").
 *
 * A one-click Marketplace UPDATE reinstalls new code over an installed plugin AND replays the admin's
 * approved grants (network + egress included, which the host reads from the grant map, NOT re-gated by
 * the new manifest) AND hands it the preserved `plugins/<slug>/data/` dir (for mail-server: the AES root
 * key + DKIM private keys). The catalog is merged across every configured source, so two sources can
 * both list `mail-server`. If "same id" meant "same plugin", ANY source an admin adds could push an
 * "update" that takes over an installed plugin — with its approved permissions and its secrets.
 *
 * So every catalog install records where it came from — `{ source, catalogId, version }` — in the
 * server-side `plugin_origins` option, and an update is gated to the SAME source. The option lives in
 * the DB next to `plugin_grants`/`plugin_egress_hosts`, NOT in `plugins/<slug>/` (that directory *is*
 * the attacker-supplied zip payload, so a package could otherwise ship its own provenance and forge
 * itself into being an "update" of any plugin). It is on the protected-option denylists, so a
 * settings:write plugin cannot rewrite its own origin.
 */

const OPTION = 'plugin_origins';

export type PluginOrigin = { source: string; catalogId: string; version: string | null };

/** Normalize a source URL for comparison (trailing slashes + case are not identity). */
function normSource(s: any): string {
    // Trailing slashes are trimmed by walking back from the end — linear in the length. A regex anchored
    // at the end (`/\/+$/`) retries from every slash of a long run that is followed by another character,
    // which is quadratic on a crafted catalog or admin URL.
    const str = String(s == null ? '' : s);
    let end = str.length;
    while (end > 0 && str.charCodeAt(end - 1) === 47 /* '/' */) end--;
    return str.slice(0, end).toLowerCase();
}

async function getAllOrigins(): Promise<Record<string, PluginOrigin>> {
    const { getOption } = require('./options');
    const v = await getOption(OPTION, {});
    return v && typeof v === 'object' ? v : {};
}

/** The recorded install origin for a plugin, or null (uploaded by zip / installed before this feature). */
async function getPluginOrigin(slug: string): Promise<PluginOrigin | null> {
    const all = await getAllOrigins();
    const o = all[String(slug)];
    return o && typeof o === 'object' && o.source ? o : null;
}

/**
 * Record (or overwrite) a plugin's install origin. Host/admin code only — never callable from a
 * plugin/theme context, so a plugin cannot forge its own provenance and claim to be an update of another.
 */
async function setPluginOrigin(slug: string, origin: { source: string; catalogId: string; version?: any }): Promise<void> {
    if (require('./plugin-context').getEffectivePlugin()) {
        throw new Error('🛡️ setPluginOrigin is not permitted from plugin/theme context.');
    }
    const all = await getAllOrigins();
    all[String(slug)] = {
        source: String(origin.source || ''),
        catalogId: String(origin.catalogId || slug),
        version: origin.version != null ? String(origin.version) : null,
    };
    const { updateOption } = require('./options');
    await updateOption(OPTION, all);
}

/** Drop a plugin's recorded origin (on uninstall). Best-effort. */
async function removePluginOrigin(slug: string): Promise<void> {
    const all = await getAllOrigins();
    if (Object.prototype.hasOwnProperty.call(all, String(slug))) {
        delete all[String(slug)];
        const { updateOption } = require('./options');
        await updateOption(OPTION, all);
    }
}

/**
 * Gate an update: it must come from the SAME source the plugin was installed from. Throws an Error
 * carrying `.status` (409/400) and a `.body` shaped for the HTTP response. The gate lives here (not in a
 * route) so EVERY caller is covered.
 *  - no recorded origin  → 409 originMismatch, recordedOrigin: null (uploads + pre-feature installs; they
 *    take a catalog version through assertAdoptableFrom instead: fresh consent, never replayed grants).
 *  - different source     → 409 naming both, so a second catalog source cannot take over an installed plugin.
 */
async function assertUpdatableFrom(slug: string, origin: { source: string; catalogId?: string } | null): Promise<PluginOrigin> {
    const recorded = await getPluginOrigin(slug);
    if (!recorded) {
        const e: any = new Error(
            `'${slug}' has no recorded install origin (it was installed by upload, or before one-click updates existed). ` +
            `Update it from the Marketplace instead: from the official catalog it is updated in place and its permissions are asked again; from another source it is reinstalled from that source.`
        );
        e.status = 409;
        e.body = { error: e.message, code: 'originMismatch', recordedOrigin: null };
        throw e;
    }
    if (!origin || !origin.source) {
        const e: any = new Error('An update must be driven from a catalog entry (no origin supplied).');
        e.status = 400;
        e.body = { error: e.message };
        throw e;
    }
    if (normSource(recorded.source) !== normSource(origin.source)) {
        const e: any = new Error(
            `Refused: '${slug}' was installed from a different source. Updating it from another source would replay its ` +
            `approved permissions and hand its preserved data to code from elsewhere.`
        );
        e.status = 409;
        e.body = { error: e.message, code: 'originMismatch', recordedOrigin: recorded.source, attemptedOrigin: origin.source };
        throw e;
    }
    return recorded;
}

/**
 * How an installed plugin can take a catalog entry's newer version, given its recorded origin:
 *  - 'update'    the entry comes from the source it was installed from: the normal one-click update
 *                (grants and data/ carried over, as they always were).
 *  - 'adopt'     no recorded origin (uploaded by zip, or installed before origins were recorded) and the
 *                entry comes from the OFFICIAL catalog: one click, the verified code goes in place keeping
 *                data/ and tables, the permissions are asked again (nothing is replayed) and the origin is
 *                recorded from then on.
 *  - 'reinstall' any other source change (recorded A, entry B; or no origin and an unofficial entry): an
 *                explicit "reinstall from this source" with fresh consent, where keeping the plugin's data
 *                is a separate, explicit choice.
 */
export type CatalogApplyMode = 'update' | 'adopt' | 'reinstall';

function catalogApplyMode(recorded: PluginOrigin | null, entrySource: string, officialSource: string): CatalogApplyMode {
    if (recorded && recorded.source && normSource(recorded.source) === normSource(entrySource)) return 'update';
    if (!recorded && normSource(entrySource) === normSource(officialSource)) return 'adopt';
    return 'reinstall';
}

/**
 * Gate for the two paths that take a plugin over from another provenance (adopt / reinstall). Like
 * assertUpdatableFrom it lives here so every caller is covered, and it is decided on the origin read NOW,
 * not on what the client saw: the mode the request asks for must be the mode this plugin is in.
 *  - same source              → 409 useUpdate (the normal update applies; nothing to adopt).
 *  - 'adopt' requested         → only for a plugin with NO recorded origin and the official source.
 *  - 'reinstall' requested     → for any other source change; the caller must have confirmed it.
 */
async function assertAdoptableFrom(
    slug: string,
    origin: { source: string; catalogId?: string } | null,
    officialSource: string,
    mode: 'adopt' | 'reinstall',
    opts: { confirmedSourceChange?: boolean } = {}
): Promise<{ recorded: PluginOrigin | null }> {
    if (!origin || !origin.source) {
        const e: any = new Error('A reinstall must be driven from a catalog entry (no origin supplied).');
        e.status = 400;
        e.body = { error: e.message };
        throw e;
    }
    const recorded = await getPluginOrigin(slug);
    const actual = catalogApplyMode(recorded, origin.source, officialSource);
    if (actual === 'update') {
        const e: any = new Error(`'${slug}' was installed from this source: use the normal update.`);
        e.status = 409;
        e.body = { error: e.message, code: 'useUpdate' };
        throw e;
    }
    if (actual !== mode) {
        const e: any = new Error(actual === 'reinstall'
            ? `'${slug}' would change source: it can only be reinstalled from this source, with the source change confirmed.`
            : `'${slug}' can be updated from the official catalog in place; a reinstall is not needed.`);
        e.status = 409;
        e.body = { error: e.message, code: 'modeMismatch', mode: actual, recordedOrigin: recorded ? recorded.source : null, attemptedOrigin: origin.source };
        throw e;
    }
    if (mode === 'reinstall' && opts.confirmedSourceChange !== true) {
        const e: any = new Error(`Reinstalling '${slug}' from another source must be confirmed explicitly.`);
        e.status = 400;
        e.body = { error: e.message, code: 'sourceChangeNotConfirmed', recordedOrigin: recorded ? recorded.source : null, attemptedOrigin: origin.source };
        throw e;
    }
    return { recorded };
}

module.exports = {
    catalogApplyMode,
    assertAdoptableFrom,
    getAllOrigins,
    getPluginOrigin,
    setPluginOrigin,
    removePluginOrigin,
    assertUpdatableFrom,
    normSource,
    PLUGIN_ORIGINS_OPTION: OPTION,
};
