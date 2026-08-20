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

function privateStorageDirs(appRoot: string, slug: string): string[] {
    const key = storageKey(slug);
    return [
        path.join(appRoot, 'data', 'plugins', key),
        path.join(appRoot, 'logs', 'plugins', key),
        path.join(appRoot, 'os-tmp', 'plugins', key),
    ];
}

function sandboxPaths(appRoot: string, slug: string, coreDir: string): {
    own: string;
    readOnly: string[];
    writable: string[];
    traverse: string[];
    storage: string[];
} {
    const root = path.resolve(appRoot);
    const own = ownPluginDir(root, slug);
    const storage = privateStorageDirs(root, slug);
    return {
        own,
        // No APP_ROOT grant: configuration, the database and sibling plugins are deliberately absent.
        readOnly: [path.resolve(coreDir), path.join(root, 'node_modules'), own],
        // Own code remains writable for backwards-compatible private storage, but executable-file writes
        // are rejected by io-guard and the native layers never grant executable mapping/FS_EXECUTE here.
        writable: [own, ...storage],
        // Windows needs directory traversal to reach the narrow descendants without inheriting a read ACE.
        traverse: [root, path.dirname(own)],
        storage,
    };
}

module.exports = { storageKey, ownPluginDir, privateStorageDirs, sandboxPaths };
