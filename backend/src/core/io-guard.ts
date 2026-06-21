/**
 * WordJS - IO Guard
 * Monkey-patches 'fs' to prevent plugins from modifying their own code or system files.
 */

const fs = require('fs');
const path = require('path');
// Use the EFFECTIVE plugin (context OR call stack), not ALS-only, so this global-fs backstop
// also applies to detached plugin code that reaches the real fs.
const { getEffectivePlugin } = require('./plugin-context');

const ORIGINALS = {
    // Write Ops
    writeFile: fs.writeFile,
    writeFileSync: fs.writeFileSync,
    unlink: fs.unlink,
    unlinkSync: fs.unlinkSync,
    rm: fs.rm,
    rmSync: fs.rmSync,
    rename: fs.rename,
    renameSync: fs.renameSync,
    mkdir: fs.mkdir,
    mkdirSync: fs.mkdirSync,
    symlink: fs.symlink,
    symlinkSync: fs.symlinkSync,
    appendFile: fs.appendFile,
    appendFileSync: fs.appendFileSync,
    truncate: fs.truncate,
    truncateSync: fs.truncateSync,
    chmod: fs.chmod,
    chmodSync: fs.chmodSync,

    // Read Ops
    readFile: fs.readFile,
    readFileSync: fs.readFileSync,
    readdir: fs.readdir,
    readdirSync: fs.readdirSync,
    createReadStream: fs.createReadStream,
    createWriteStream: fs.createWriteStream
};

const ROOT_DIR = path.resolve(__dirname, '../../');

// Resolve the operator-configured DB file path(s) so an attacker can't dodge the extension block
// above by pointing the DB at a custom-named file. Lazily read + cached (this is a per-fs-op hot
// path) and fully defensive — config may not be loaded yet, and the extension check is the primary.
let _cfgDbPaths: string[] | null = null;
function getConfiguredDbPaths(): string[] {
    if (_cfgDbPaths) return _cfgDbPaths;
    const out = new Set<string>();
    for (const mod of ['../config/app', '../config/database', '../config']) {
        try {
            const c = require(mod);
            for (const v of [c && c.dbPath, c && c.config && c.config.dbPath, c && c.DB_PATH]) {
                if (typeof v === 'string' && v) out.add(path.resolve(v));
            }
        } catch { /* config not available / different shape */ }
    }
    _cfgDbPaths = Array.from(out);
    return _cfgDbPaths;
}

/**
 * Check if a path is safe to access
 */
function isPathSafe(targetPath, isWrite = false) {
    const pluginSlug = getEffectivePlugin();
    if (!pluginSlug) return true; // Core code is trusted

    // No plugin is exempt: EVERY plugin is uniformly confined by io-guard (no trust tier). Plugins
    // reach scoped DB rows / their own data via the bridge; the raw DB file + secret files stay blocked.

    // Normalize Windows extended-length / UNC prefixes (\\?\C:\... or \\?\UNC\...) that
    // require.resolve / realpath can produce, otherwise the safe-zone startsWith() checks
    // fail to match ROOT_DIR and legitimate in-dir reads get wrongly blocked.
    let resolved = path.resolve(targetPath);
    resolved = resolved.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
    const filename = path.basename(resolved).toLowerCase();

    // SECURITY: Explicitly blocked files (contain secrets)
    const BLOCKED_FILES = [
        '.env',
        '.env.local',
        '.env.production',
        '.env.development',
        'wordjs-config.json',
        'wordjs-config.backup.json',
        'package-lock.json', // Can reveal dependency tree for attacks
        'id_rsa',
        'id_ed25519',
        '.htpasswd',
        'shadow',
        'passwd'
    ];

    // Block files by name
    if (BLOCKED_FILES.includes(filename)) {
        console.warn(`[Security Block] Plugin '${pluginSlug}' tried to access sensitive file: ${resolved}`);
        return false;
    }

    // SECURITY: the live database files hold EVERY credential, session token, and secret-named option,
    // so plugin code must never open + parse the raw DB file. Enforce this ONLY in the isolated CHILD,
    // where plugin code actually runs. On the HOST the only fs access under a plugin's context is the
    // BRIDGE's own DB driver doing legitimate scoped work — callApi runs inside runWithContext(slug), so
    // getEffectivePlugin() returns the slug while the host driver opens data/wordjs.db. That file lives
    // in the data/ safe zone (allowed below); a plugin still can't reach it raw (its bridge fs.read is
    // confined to its own dir). Blocking it on the host would wrongly break every plugin's DB access.
    const g: any = (typeof global !== 'undefined') ? global : {};
    if (g.__WORDJS_ISOLATED__) {
        if (/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(filename)) {
            console.warn(`[Security Block] Plugin '${pluginSlug}' tried to access a database file: ${resolved}`);
            return false;
        }
        const cfgDbPaths = getConfiguredDbPaths();
        if (cfgDbPaths.some(db => resolved === db || resolved.startsWith(db + '-'))) {
            console.warn(`[Security Block] Plugin '${pluginSlug}' tried to access the configured database file: ${resolved}`);
            return false;
        }
    }

    // SECURITY: a plugin must NOT rewrite any manifest.json at runtime — permissions are read
    // live from it, so a self-rewrite would be a permission-escalation primitive. Block all writes.
    if (isWrite && filename === 'manifest.json') {
        console.warn(`[Security Block] Plugin '${pluginSlug}' tried to write a manifest.json: ${resolved}`);
        return false;
    }

    // Block any file with secret-like patterns in name
    const sensitivePatterns = ['secret', 'credential', 'private', 'key.pem', 'cert.pem'];
    if (sensitivePatterns.some(pattern => filename.includes(pattern))) {
        console.warn(`[Security Block] Plugin '${pluginSlug}' tried to access sensitive pattern file: ${resolved}`);
        return false;
    }

    // Common Safe Zones for Reading. NOTE: the whole `plugins/` tree is intentionally NOT here — a
    // plugin reading a SIBLING plugin's files is cross-plugin data/secret exfiltration (e.g. another
    // plugin's encryption-key file). A plugin reads its OWN dir via the per-plugin `ownDir` allowance
    // below; require() of its own files + deps still resolve via node_modules/src. themes/ stays (shared
    // display assets, no secrets).
    const SAFE_READ_DIRS = [
        path.join(ROOT_DIR, 'uploads'),
        path.join(ROOT_DIR, 'data'),
        path.join(ROOT_DIR, 'themes'),
        path.join(ROOT_DIR, 'logs'),
        path.join(ROOT_DIR, 'os-tmp'),
        path.join(ROOT_DIR, 'node_modules'), // Allow plugins to require dependencies
        path.join(ROOT_DIR, 'src') // Allow plugins to require core modules (careful)
    ];

    // Safe Zones for Writing (Stricter)
    const SAFE_WRITE_DIRS = [
        path.join(ROOT_DIR, 'uploads'),
        path.join(ROOT_DIR, 'data'),
        path.join(ROOT_DIR, 'logs'),
        path.join(ROOT_DIR, 'os-tmp'),
        path.join(ROOT_DIR, 'themes')
    ];

    // A plugin may always read+write within its OWN dir (plugins/<slug> or themes/<slug>) — that's its
    // private storage (data files, caches, attachments). It's still subject to the file-name blocks
    // above (manifest.json / DB-in-child / secret-named) and to the per-plugin disk quota at the bridge.
    const ownDir = pluginSlug.startsWith('theme:')
        ? path.join(ROOT_DIR, 'themes', pluginSlug.slice('theme:'.length))
        : path.join(ROOT_DIR, 'plugins', pluginSlug);
    const dirsToCheck = (isWrite ? SAFE_WRITE_DIRS : SAFE_READ_DIRS).concat([ownDir]);
    // Exact-match or trailing-separator prefix so safe dir 'foo' does not also whitelist
    // a sibling 'foo-bar' that merely shares a string prefix.
    let isAllowed = dirsToCheck.some(dir => resolved === dir || resolved.startsWith(dir + path.sep));

    // Module-resolution metadata is NOT a secret, and Node reads it from ancestors of the plugin entry
    // (incl. the shared plugins/ parent) + dependency trees. Since plugins/ is intentionally NOT a broad
    // read safe-zone (that would expose another plugin's private files like an encryption key), allow
    // READS of any package.json and anything under a node_modules/ dir so require()/import resolution
    // keeps working — without re-opening cross-plugin reads of source/data/secrets.
    if (!isAllowed && !isWrite) {
        const base = path.basename(resolved);
        if (base === 'package.json' || resolved.split(path.sep).includes('node_modules')) {
            // ...but NEVER inside a SIBLING plugin's dir. Module resolution only reads the plugin's OWN
            // tree + shared ancestors (plugins/package.json, backend/, root node_modules) — never a sibling
            // plugin's package.json/node_modules — so deny those to keep cross-plugin reads closed. (IO-1)
            const pluginsRoot = path.join(ROOT_DIR, 'plugins');
            let underSibling = false;
            if (resolved.startsWith(pluginsRoot + path.sep)) {
                const after = resolved.slice(pluginsRoot.length + 1);
                const firstSeg = after.split(path.sep)[0];
                if (after.includes(path.sep) && firstSeg && firstSeg !== pluginSlug) underSibling = true;
            }
            if (!underSibling) isAllowed = true;
        }
    }

    if (!isAllowed) {
        console.warn(`[Security Block] Plugin '${pluginSlug}' tried to ${isWrite ? 'WRITE' : 'READ'} outside safe zones: ${resolved}`);
        return false;
    }

    return true;
}

// === PATCHES ===

function patch(methodName, isSync = false) {
    const original = ORIGINALS[methodName];
    if (!original) return;

    const isWrite = [
        'writeFile', 'writeFileSync',
        'unlink', 'unlinkSync',
        'rm', 'rmSync',
        'rename', 'renameSync',
        'mkdir', 'mkdirSync',
        'symlink', 'symlinkSync',
        'appendFile', 'appendFileSync',
        'createWriteStream', 'truncate', 'truncateSync',
        'chmod', 'chmodSync', 'lchmod', 'chown', 'chownSync'
    ].includes(methodName);

    fs[methodName] = function (...args) {
        // Different methods have path at different positions
        let pathsToCheck = [args[0]];

        if (methodName.startsWith('rename') || methodName.startsWith('symlink') || methodName.startsWith('link')) {
            // Check BOTH (Source/Dest or Target/Path)
            pathsToCheck = [args[0], args[1]];
        }

        for (const p of pathsToCheck) {
            if (!p) continue;
            // Validate
            if (!isPathSafe(p, isWrite)) {
                const error: any = new Error(`EACCES: Permission denied, plugin cannot access: ${p}`);
                error.code = 'EACCES';
                if (isSync) throw error;
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(error);
                return;
            }
        }

        return original.apply(this, args);
    };
}

// Write Ops
patch('writeFile'); patch('writeFileSync', true);
patch('unlink'); patch('unlinkSync', true);
patch('rm'); patch('rmSync', true);
patch('rename'); patch('renameSync', true);
patch('mkdir'); patch('mkdirSync', true);
patch('symlink'); patch('symlinkSync', true);
patch('appendFile'); patch('appendFileSync', true);
patch('createWriteStream');
patch('truncate'); patch('truncateSync', true);
patch('chmod'); patch('chmodSync', true);

// Read Ops
patch('readFile'); patch('readFileSync', true);
patch('readdir'); patch('readdirSync', true);
patch('createReadStream');

module.exports = {
    isPathSafe
};
