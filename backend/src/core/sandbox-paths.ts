/**
 * Filesystem authority shared by every isolated-plugin layer.
 *
 * Keeping this in one module is security-significant: Node permissions, Landlock, Seatbelt,
 * AppContainer ACLs and the JavaScript I/O guard must not each invent a different answer.
 */
const path = require('path');
const crypto = require('crypto');
const OWNED_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function storageKey(slug: string): string {
    const raw = String(slug || 'plugin');
    const readable = raw.toLowerCase().replace(/^theme:/, 'theme-').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'plugin';
    const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
    return `${readable}-${digest}`;
}

function ownPluginDir(appRoot: string, slug: string): string {
    const raw = String(slug || '');
    const theme = raw.startsWith('theme:');
    const segment = theme ? raw.slice('theme:'.length) : raw;
    // This module feeds kernel paths and persistent ACLs. Never rely on an HTTP-route validator having
    // run earlier: a poisoned DB row, directory listing or internal call must fail closed here rather
    // than turn `..`, a separator or an absolute path into authority outside plugins/ or themes/.
    if (!OWNED_SEGMENT.test(segment)) throw new Error('invalid isolated-plugin slug');
    const base = path.resolve(appRoot, theme ? 'themes' : 'plugins');
    const owned = path.resolve(base, segment);
    if (path.dirname(owned) !== base) throw new Error('isolated-plugin path escaped its ownership root');
    return owned;
}

/**
 * MULTISITE: a plugin runs one worker per site, and each site's worker gets its OWN private storage —
 * site 1 keeps the directories it always had, any other site's are keyed by `s<id>:<slug>` (so they
 * never collide with site 1's, nor with each other). Its own code directory is shared by every site and
 * is READ-ONLY to all of them; site 1's private data directory (ownDataDir) is where the plugin's own
 * `data/` folder lives, reached through the `data` link in its code directory (see plugin-own-data).
 */
function siteStorageSlug(slug: string, siteId: number = 1): string {
    return siteId === 1 ? String(slug || '') : `s${siteId}:${String(slug || '')}`;
}

function privateStorageDirs(appRoot: string, slug: string, siteId: number = 1): string[] {
    const key = storageKey(siteStorageSlug(slug, siteId));
    return [
        path.join(appRoot, 'data', 'plugins', key),
        path.join(appRoot, 'logs', 'plugins', key),
        path.join(appRoot, 'os-tmp', 'plugins', key),
    ];
}

/**
 * Where the host stages a multipart upload for one of this plugin's routes: a fixed subdirectory of its
 * private tmp storage (M4-04 / S4-19 / X4-05). It used to be the OS temp dir, which no layer of the sandbox
 * lets a plugin read, so `req.file.path` named a file the handler could never open — every attachment was
 * dropped. Inside the plugin's own storage every native layer already admits it, and io-guard admits a READ
 * here without a filesystem grant (the upload IS the request's input; writes stay gated like any storage).
 */
/**
 * The plugin's own data directory: what used to be `<code dir>/data`, kept OUTSIDE the code so the code
 * directory can be read-only at every layer. `<code dir>/data` is a link to it (a junction on Windows), so
 * a plugin that writes `path.join(__dirname, 'data', …)` keeps working. It needs no filesystem grant —
 * it is the private storage every plugin has always had — and only site 1's worker writes it.
 */
function ownDataDir(appRoot: string, slug: string): string {
    return path.join(path.resolve(appRoot), 'data', 'plugin-own', storageKey(String(slug || '')));
}

function uploadStagingDir(appRoot: string, slug: string, siteId: number = 1): string {
    return path.join(privateStorageDirs(path.resolve(appRoot), slug, siteId)[2], 'uploads');
}

function sandboxPaths(appRoot: string, slug: string, coreDir: string, siteId: number = 1): {
    own: string;
    /** The plugin's own data directory (see ownDataDir), and the link to it inside the code directory. */
    ownData: string;
    ownDataLink: string;
    /** Whether this worker uses ownData (site 1 only; the code directory is never writable). */
    ownWritable: boolean;
    readOnly: string[];
    writable: string[];
    traverse: string[];
    storage: string[];
} {
    const root = path.resolve(appRoot);
    const own = ownPluginDir(root, slug);
    const storage = privateStorageDirs(root, slug, siteId);
    const ownWritable = siteId === 1;
    const ownData = ownDataDir(root, slug);
    return {
        own,
        ownData,
        ownDataLink: path.join(own, 'data'),
        ownWritable,
        // No APP_ROOT grant: configuration, the database and sibling plugins are deliberately absent.
        readOnly: [path.resolve(coreDir), path.join(root, 'node_modules'), own],
        // The code directory is READ-ONLY at every layer: a plugin can never rewrite its own code or
        // manifest. What it writes without a grant goes to its own data directory (site 1).
        writable: ownWritable ? [ownData, ...storage] : [...storage],
        // Windows needs directory traversal to reach the narrow descendants without inheriting a read ACE.
        traverse: [root, path.dirname(own)],
        storage,
    };
}

module.exports = { storageKey, siteStorageSlug, ownPluginDir, ownDataDir, privateStorageDirs, uploadStagingDir, sandboxPaths };
