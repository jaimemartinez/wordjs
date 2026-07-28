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
    return String(s == null ? '' : s).replace(/\/+$/, '').toLowerCase();
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
 *  - no recorded origin  → 409 originMismatch, recordedOrigin: null (uploads + pre-feature installs; the
 *    safe adoption path is uninstall — data/ + tables are kept — then install from the catalog).
 *  - different source     → 409 naming both, so a second catalog source cannot take over an installed plugin.
 */
async function assertUpdatableFrom(slug: string, origin: { source: string; catalogId?: string } | null): Promise<PluginOrigin> {
    const recorded = await getPluginOrigin(slug);
    if (!recorded) {
        const e: any = new Error(
            `'${slug}' has no recorded install origin (it was installed by upload, or before one-click updates existed). ` +
            `To enable catalog updates, uninstall it — its data/ and its tables are kept — then install it from the Marketplace.`
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

module.exports = {
    getAllOrigins,
    getPluginOrigin,
    setPluginOrigin,
    removePluginOrigin,
    assertUpdatableFrom,
    normSource,
    PLUGIN_ORIGINS_OPTION: OPTION,
};
