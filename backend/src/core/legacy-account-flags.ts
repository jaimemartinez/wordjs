/**
 * WordJS — DEPRECATED: the legacy "professional mailbox" account flag, kept ONLY as a bridge onto the
 * generic account capabilities (core/account-capabilities.ts). Delete this file in the next major release.
 *
 * Until this release the core itself owned a mail-specific per-account grant: user_meta
 * `professional_mailbox`, projected to plugins as `hasProfessionalMailbox` and honoured on admin menu items
 * as `requiresProfessionalMailbox`. That knowledge now belongs to the plugin that serves mail, which
 * declares the capability `mail_server_mailbox` in its manifest. This file is the whole of what remains,
 * and it exists for three transitions that must neither LOSE nor WIDEN a grant:
 *
 *   1. THE DATA (schema migration 0019). Every stored `professional_mailbox` value is copied, as is, to
 *      `account_capability:mail_server_mailbox` before any route serves (migrations run at boot).
 *   2. MIXED VERSIONS. The legacy row is kept and every later write of the capability is mirrored onto it
 *      (mirrorLegacyWrite), so a node still running the previous release during a rolling upgrade — or a
 *      rollback — reads the same answer. A legacy row that says "not granted" also VETOES the new grant
 *      (applyLegacyVeto): a revocation made on an old node is honoured here, so the two keys can only ever
 *      disagree in the deny direction.
 *   3. AN OUTDATED PLUGIN. An install still running a mail plugin from before this release (no
 *      `accountCapabilities` declaration) keeps working: its routes still receive `hasProfessionalMailbox`,
 *      its menu item still carries `requiresProfessionalMailbox`, and the address lock still applies.
 *      Changing a grant needs the updated plugin (its declaration is what renders the toggle).
 *
 * Every field here is confined to the plugin whose namespace owns the capability: no other plugin is told.
 */

const LEGACY_META_KEY = 'professional_mailbox';
const LEGACY_CAPABILITY = 'mail_server_mailbox';
const LEGACY_PROJECTION_FIELD = 'hasProfessionalMailbox';
const LEGACY_MENU_FLAG = 'requiresProfessionalMailbox';

/** Drop the legacy capability from `granted` when the legacy row exists and does not say granted. */
function applyLegacyVeto(meta: Record<string, any>, granted: string[]): string[] {
    if (!meta || !Object.prototype.hasOwnProperty.call(meta, LEGACY_META_KEY)) return granted;
    if (String(meta[LEGACY_META_KEY] ?? '') === '1') return granted;
    return granted.filter((slug) => slug !== LEGACY_CAPABILITY);
}

/** Keep the legacy row in step with a write of the capability (mixed-version clusters, rollback). */
async function mirrorLegacyWrite(userId: number, slug: string, value: string): Promise<void> {
    if (slug !== LEGACY_CAPABILITY) return;
    await require('../models/User').updateMeta(userId, LEGACY_META_KEY, value === '1' ? '1' : '0');
}

/** Whether no installed plugin declares the capability — i.e. the installed mail plugin predates this. */
function undeclared(): boolean {
    try {
        return !require('./account-capabilities').installedDeclarations().some((d: any) => d.slug === LEGACY_CAPABILITY);
    } catch { return true; }
}

/** The capability still binds the address while an outdated plugin cannot declare `locksEmail` for it. */
function legacyLockingCapabilities(): string[] {
    return undeclared() ? [LEGACY_CAPABILITY] : [];
}

/** The legacy projection field, for the plugin owning the capability's namespace only. */
function legacyProjectionFields(pluginId: string, ownCapabilities: string[]): Record<string, boolean> {
    if (!require('./plugin-roles').isInPluginNamespace(LEGACY_CAPABILITY, pluginId)) return {};
    return { [LEGACY_PROJECTION_FIELD]: Array.isArray(ownCapabilities) && ownCapabilities.includes(LEGACY_CAPABILITY) };
}

/** The capability an outdated menu item's legacy flag stands for, or null. */
function legacyMenuRequirement(item: any): string | null {
    return item && item[LEGACY_MENU_FLAG] ? LEGACY_CAPABILITY : null;
}

type MigrationCtx = { run: (sql: string, params?: any[]) => Promise<any>; all: (sql: string, params?: any[]) => Promise<any>; get: (sql: string, params?: any[]) => Promise<any> };

/**
 * Schema migration 0019: copy every legacy value onto the generic key, unchanged. Idempotent (an existing
 * generic row is never overwritten) and it deletes nothing, so a re-run, a crash half-way or a rollback is
 * harmless. Returns how many rows were copied.
 */
async function migrateLegacyFlags(ctx: MigrationCtx): Promise<number> {
    const target = 'account_capability:' + LEGACY_CAPABILITY;
    const rows = (await ctx.all('SELECT user_id, meta_value FROM user_meta WHERE meta_key = ?', [LEGACY_META_KEY])) || [];
    let copied = 0;
    for (const r of rows) {
        const exists = await ctx.get('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [r.user_id, target]);
        if (exists) continue;
        await ctx.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)',
            [r.user_id, target, String(r.meta_value ?? '') === '1' ? '1' : '0']);
        copied++;
    }
    return copied;
}

module.exports = {
    LEGACY_META_KEY,
    LEGACY_CAPABILITY,
    applyLegacyVeto,
    mirrorLegacyWrite,
    legacyLockingCapabilities,
    legacyProjectionFields,
    legacyMenuRequirement,
    migrateLegacyFlags,
};
