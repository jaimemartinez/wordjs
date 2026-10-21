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
 * Record that `slug` is about to write option `key`. Call BEFORE the write: whether the option existed is
 * what decides ownership. Best-effort — a failure here never blocks the plugin's own write.
 */
async function noteOptionWrite(slug: string, key: string): Promise<void> {
    if (!slug || typeof key !== 'string' || !key) return;
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

module.exports = { LEDGER_OPTION, noteOptionWrite, purgePluginOptions, optionsOwnedBy };
