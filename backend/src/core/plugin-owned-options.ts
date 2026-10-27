/**
 * WordJS - Which options a plugin created (S4-21).
 *
 * Plugins write site options through the options bridge with plain names (`mail_port`, `mail_domain`…):
 * there is no namespace to tell them apart from the core's, so "delete this plugin's data" left every one of
 * them behind and a reinstall inherited the configuration the administrator had asked to erase. The bridge now
 * records, here, each option a plugin CREATED — a name that did not exist when that plugin first wrote it, or
 * one another plugin had created. An option the site already had (a core setting a plugin merely changes) is
 * never recorded, so it can never be deleted on the plugin's behalf.
 *
 * Host bookkeeping: the ledger option is protected from plugins (plugin-api PROTECTED_OPTION_NAMES) and every
 * read/write here runs as the host.
 */
const LEDGER_OPTION = 'plugin_owned_options';

type Ledger = Record<string, string[]>;

function asHost<T>(fn: () => Promise<T>): Promise<T> {
    return require('./plugin-context').runAsHost(fn);
}

async function readLedger(): Promise<Ledger> {
    const { getOption } = require('./options');
    const raw = await getOption(LEDGER_OPTION, {});
    const out: Ledger = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [slug, keys] of Object.entries(raw)) {
            if (Array.isArray(keys)) out[slug] = keys.filter((k) => typeof k === 'string');
        }
    }
    return out;
}

function ownedByAnyone(ledger: Ledger, key: string): boolean {
    return Object.values(ledger).some((keys) => keys.includes(key));
}

// One ledger write at a time in this process: two plugins (or two requests) writing options concurrently
// must not lose each other's entry in a read-modify-write.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
}

/**
 * THE PLUGIN'S OWN OPTIONS: every option whose name starts with the plugin's slug, normalized the way its
 * table prefix is (`photo-carousel` → `photo_carousel_…`, a theme `theme:x` → `theme_x_…`). The options
 * bridge lets a plugin write only these — an allowlist, so a site setting added to the core tomorrow is
 * out of a plugin's reach without anyone having to remember to list it.
 */
function optionNamespace(slug: string): string {
    return String(slug || '').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase().replace(/^_+|_+$/g, '') + '_';
}

/**
 * Values the core reads from the site's MAIL PROVIDER under a shared name (core/email-address
 * `mail_domain`, core/account-mail `mail_delivery_ready`). Only a plugin holding the admin-approved
 * `email:provider` grant publishes them.
 */
const PROVIDER_PUBLISHED_OPTIONS = new Set(['mail_domain', 'mail_delivery_ready']);

function isPluginWritableOption(slug: string, key: unknown): boolean {
    const { canonicalOptionName } = require('./option-names');
    const name = canonicalOptionName(key);
    if (name === null || !slug) return false;
    const ns = optionNamespace(slug);
    if (ns.length > 1 && name.startsWith(ns) && name.length > ns.length) return true;
    if (PROVIDER_PUBLISHED_OPTIONS.has(name)) {
        try { return require('./plugin-permissions').isGranted(slug, 'email', 'provider') === true; } catch { return false; }
    }
    return false;
}

/**
 * Record that `slug` is about to write option `key`. Call BEFORE the write: whether the option existed is
 * what decides ownership. Best-effort — a failure here never blocks the plugin's own write.
 *
 * Only an option the plugin may write at all can be recorded as its own: a site option the plugin could
 * not write must never become "the plugin's", or uninstalling it would delete the site's setting.
 */
async function noteOptionWrite(slug: string, key: string): Promise<void> {
    if (!slug || typeof key !== 'string' || !key) return;
    if (!isPluginWritableOption(slug, key)) return;
    try {
        await serialized(() => asHost(async () => {
            const ledger = await readLedger();
            if ((ledger[slug] || []).includes(key)) return;
            const { readStoredOption, updateOption } = require('./options');
            const existed = (await readStoredOption(key)).raw !== null;
            // An option the site already had is the site's, unless another plugin created it.
            if (existed && !ownedByAnyone(ledger, key)) return;
            ledger[slug] = [...(ledger[slug] || []), key];
            await updateOption(LEDGER_OPTION, ledger);
        }));
    } catch { /* bookkeeping only */ }
}

/**
 * Delete the options `slug` created, except those another plugin also created; forget its ledger entry.
 * Returns the names deleted.
 */
async function purgePluginOptions(slug: string): Promise<string[]> {
    return serialized(() => asHost(async () => {
        const ledger = await readLedger();
        const mine = ledger[slug] || [];
        delete ledger[slug];
        const { deleteOption, updateOption } = require('./options');
        const removed: string[] = [];
        for (const key of mine) {
            if (ownedByAnyone(ledger, key)) continue;
            try { await deleteOption(key); removed.push(key); } catch { /* left in place, still reported below */ }
        }
        await updateOption(LEDGER_OPTION, ledger);
        return removed;
    }));
}

/** The options `slug` is recorded as having created (for the uninstall summary and tests). */
async function optionsOwnedBy(slug: string): Promise<string[]> {
    return asHost(async () => (await readLedger())[slug] || []);
}

module.exports = { LEDGER_OPTION, noteOptionWrite, purgePluginOptions, optionsOwnedBy, optionNamespace, isPluginWritableOption, PROVIDER_PUBLISHED_OPTIONS };
