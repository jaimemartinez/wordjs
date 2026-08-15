/**
 * WordJS - IO Guard
 *
 * Monkey-patches 'fs' so plugin code (run in the isolated child) is confined to its own dir + a small
 * set of safe zones, and can never:
 *   - read/exfiltrate secret files or the raw DB (BLOCKED_FILES / db-file / secret-pattern checks),
 *   - rewrite its own manifest.json (permission-escalation primitive), or
 *   - CREATE or rename/copy a file into an executable code extension (.js/.cjs/.mjs/.node/.wasm/…) —
 *     which would let a plugin plant runtime code the static AST scanner never vetted, or overwrite its
 *     own scanned source. See EXECUTABLE_CODE_EXT below and secure-require.ts (require() is likewise
 *     confined to the plugin's own tree + node_modules so a planted file can't be loaded).
 *
 * This is a defence-in-depth backstop; the OS process isolation is the real boundary.
 */

const fs = require('fs');
const path = require('path');
// Use the EFFECTIVE plugin (context OR call stack), not ALS-only, so this global-fs backstop
// also applies to detached plugin code that reaches the real fs.
const { getEffectivePlugin } = require('./plugin-context');

// Coalesce repeated block warnings. A plugin in a tight fs-probe loop (e.g. a logger retrying a denied
// write) otherwise floods the host log with thousands of identical lines, drowning everything else.
// Per message key: emit the first, then at most one "(xN more suppressed)" every SUPPRESS_WINDOW_MS.
const SUPPRESS_WINDOW_MS = 10000;
const _warnState = new Map<string, { last: number; suppressed: number }>();
function throttledWarn(key: string, message: string): void {
    const now = Date.now();
    const st = _warnState.get(key);
    if (!st) { _warnState.set(key, { last: now, suppressed: 0 }); console.warn(message); return; }
    if (now - st.last >= SUPPRESS_WINDOW_MS) {
        console.warn(st.suppressed > 0 ? `${message} (${st.suppressed} similar suppressed in the last ${Math.round((now - st.last) / 1000)}s)` : message);
        st.last = now; st.suppressed = 0;
    } else {
        st.suppressed++;
    }
}

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
    // Copy/link ops read a SOURCE and create a DEST — both ends must be confined (a copy of the raw DB
    // or a hard link to a secret would otherwise be a read-confinement bypass / exfiltration primitive).
    copyFile: fs.copyFile,
    copyFileSync: fs.copyFileSync,
    cp: fs.cp,
    cpSync: fs.cpSync,
    link: fs.link,
    linkSync: fs.linkSync,

    // Read Ops
    readFile: fs.readFile,
    readFileSync: fs.readFileSync,
    readdir: fs.readdir,
    readdirSync: fs.readdirSync,
    createReadStream: fs.createReadStream,
    createWriteStream: fs.createWriteStream,
    // open/opendir/readlink take a PATH that readFile/readdir do NOT funnel through: a plugin doing
    // fs.openSync(p, 'r') + fs.readSync(fd) reads arbitrary file CONTENT completely unguarded (the biggest
    // read hole), opendir enumerates any dir, readlink discloses any symlink target. Confine them too.
    open: fs.open,
    openSync: fs.openSync,
    opendir: fs.opendir,
    opendirSync: fs.opendirSync,
    readlink: fs.readlink,
    readlinkSync: fs.readlinkSync
};

const ROOT_DIR = path.resolve(__dirname, '../../');

// Resolve the operator-configured DB file path(s) so an attacker can't dodge the extension block
// above by pointing the DB at a custom-named file. Lazily read + cached (this is a per-fs-op hot
// path) and fully defensive — config may not be loaded yet, and the extension check is the primary.
let _cfgDbPaths: string[] | null = null;
function getConfiguredDbPaths(): string[] {
    if (_cfgDbPaths) return _cfgDbPaths;
    const out = new Set<string>();
    let sawLoaded = false;
    for (const mod of ['../config/app', '../config/database', '../config']) {
        let resolved: string;
        try { resolved = require.resolve(mod); } catch { continue; }
        // Read straight from the module cache, and ONLY once the module has finished loading. Calling
        // require() here during boot — while config/* is still mid-load (this runs from an fs op that
        // can fire inside config's own load) — would read properties off a half-initialized circular
        // export, which makes Node print a "non-existent property … inside circular dependency" warning
        // on every plugin start. The .db/.sqlite extension block above is the primary defense meanwhile.
        const cached = require.cache[resolved];
        if (!cached || cached.loaded !== true) continue;
        sawLoaded = true;
        const c: any = cached.exports;
        for (const v of [c && c.dbPath, c && c.config && c.config.dbPath, c && c.DB_PATH]) {
            if (typeof v === 'string' && v) out.add(path.resolve(v));
        }
    }
    // Only freeze the cache once a config module was actually loaded; before that keep retrying, so an
    // early boot-time call can't permanently cache an empty set (which would silently disable this
    // custom-DB-path defense for the whole process lifetime).
    if (sawLoaded) _cfgDbPaths = Array.from(out);
    return sawLoaded ? (_cfgDbPaths as string[]) : Array.from(out);
}

// Executable/loadable code extensions. A plugin must never CREATE, overwrite, rename-into, or copy-into
// one of these ANYWHERE it can write. The AST scanner (plugins.ts) statically vets a plugin's committed
// code before activation; letting a plugin drop a fresh .js at runtime — directly, or by writing a .txt
// then renaming/copying it to .js — would be a scanner-evasion + self-code-modification primitive.
// Data files (.json/.txt/images/etc.) stay writable in the plugin's safe zones. Covers native addons
// (.node) and WebAssembly (.wasm) which are also loadable code, and TS variants defensively.
const EXECUTABLE_CODE_EXT = /\.(?:c|m)?jsx?$|\.(?:c|m)?tsx?$|\.node$|\.wasm$/i;

/**
 * Check if a path is safe to access
 */
function isPathSafe(targetPath: string, isWrite = false) {
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
        'wjp-prefix-registry.json', // per-plugin table-prefix ownership registry (#12) — plugin-untouchable
        'package-lock.json', // Can reveal dependency tree for attacks
        'id_rsa',
        'id_ed25519',
        '.htpasswd',
        'shadow',
        'passwd'
    ];

    // Block files by name — CASE-INSENSITIVE: Windows/macOS filesystems are case-insensitive, so an exact
    // match would let a plugin reach wordjs-config.json / the prefix registry / .env via a case variant
    // like WORDJS-CONFIG.JSON or WJP-Prefix-Registry.json (#12).
    if (BLOCKED_FILES.some(f => f.toLowerCase() === String(filename).toLowerCase())) {
        throttledWarn(`${pluginSlug}:sensitive-file`, `[Security Block] Plugin '${pluginSlug}' tried to access sensitive file: ${resolved}`);
        return false;
    }

    // SECURITY: the live database files hold EVERY credential, session token, and secret-named option,
    // so plugin code must never open + parse the raw DB file. Enforce this ONLY in the isolated CHILD,
    // where plugin code actually runs. On the HOST the only fs access under a plugin's context is the
    // BRIDGE's own DB driver doing legitimate scoped work — callApi runs inside runWithContext(slug), so
    // getEffectivePlugin() returns the slug while the host driver opens data/wordjs.db. That file lives
    // in the data/ safe zone (allowed below); a plugin still can't reach it raw (its bridge fs.read is
    // confined to its own dir). Blocking it on the host would wrongly break every plugin's DB access.
    // Read the isolation marker off `globalThis` (unreassignable per spec), NOT the writable `global`
    // identifier: a plugin doing `global = {}` would otherwise make __WORDJS_ISOLATED__ read undefined and
    // SKIP this DB-file block, and since data/ is an allowed write-zone below, the raw core DB (every
    // credential + secret-named option) would then be readable. globalThis defeats that reassignment.
    const g: any = (typeof globalThis !== 'undefined') ? globalThis : {};
    if (g.__WORDJS_ISOLATED__) {
        if (/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(filename)) {
            throttledWarn(`${pluginSlug}:db-file`, `[Security Block] Plugin '${pluginSlug}' tried to access a database file: ${resolved}`);
            return false;
        }
        const cfgDbPaths = getConfiguredDbPaths();
        if (cfgDbPaths.some(db => resolved === db || resolved.startsWith(db + '-'))) {
            throttledWarn(`${pluginSlug}:db-configured`, `[Security Block] Plugin '${pluginSlug}' tried to access the configured database file: ${resolved}`);
            return false;
        }
    }

    // SECURITY: a plugin must NOT rewrite any manifest.json at runtime — permissions are read
    // live from it, so a self-rewrite would be a permission-escalation primitive. Block all writes.
    if (isWrite && filename === 'manifest.json') {
        throttledWarn(`${pluginSlug}:manifest`, `[Security Block] Plugin '${pluginSlug}' tried to write a manifest.json: ${resolved}`);
        return false;
    }

    // SECURITY (self-code-modification / scanner-evasion): never let a plugin CREATE or rename/copy a
    // file into an executable code extension anywhere it can write — not even its own dir. Its committed
    // code is what the AST scanner vetted; a fresh runtime .js (directly, or written as .txt then renamed
    // to .js) would run un-scanned. Applies to every write path (write/append/rename-dest/copy-dest).
    if (isWrite && EXECUTABLE_CODE_EXT.test(filename)) {
        throttledWarn(`${pluginSlug}:exec-write`, `[Security Block] Plugin '${pluginSlug}' tried to write executable code: ${resolved}`);
        return false;
    }

    // Block any file with secret-like patterns in name
    const sensitivePatterns = ['secret', 'credential', 'private', 'key.pem', 'cert.pem'];
    if (sensitivePatterns.some(pattern => filename.includes(pattern))) {
        throttledWarn(`${pluginSlug}:sensitive-pattern`, `[Security Block] Plugin '${pluginSlug}' tried to access sensitive pattern file: ${resolved}`);
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

    // MONOLITH-mode carve-out: Next.js runs in-process and flushes its own dev log
    // (frontend/.next/dev/logs/*.log) from a timer that can inherit a plugin's ALS context —
    // secure-require wraps timers with creation-time context, so a console.log intercepted by
    // Next's log capture inside a plugin scope schedules the flusher "as" that plugin. The write
    // is Next's own, not the plugin's; denying it only breaks Next's logging and floods the
    // console with EACCES. Allow WRITES to *.log files under frontend/.next only — never code
    // (EXECUTABLE_CODE_EXT can't match *.log), log-injection at worst.
    if (!isAllowed && isWrite) {
        const nextDir = path.resolve(ROOT_DIR, '../frontend/.next');
        if (resolved.startsWith(nextDir + path.sep) && /\.log$/i.test(resolved)) {
            isAllowed = true;
        }
    }

    if (!isAllowed) {
        throttledWarn(`${pluginSlug}:outside-${isWrite ? 'write' : 'read'}`, `[Security Block] Plugin '${pluginSlug}' tried to ${isWrite ? 'WRITE' : 'READ'} outside safe zones: ${resolved}`);
        return false;
    }

    return true;
}

// === PER-PLUGIN DISK WRITE QUOTA ===
// io-guard governs raw fs; the bridge's byte quota (wordjs.fs.write) is BYPASSED when a plugin writes
// via require('fs') directly. Path checks confine WHERE a plugin writes but not HOW MUCH — an unbounded
// createWriteStream/appendFile loop to its own dir (no grant needed) fills the shared volume → ENOSPC on
// the DB → full-site outage. Meter it here. (#14) ALL byte-producing writers — writeFile*, append*, and
// createWriteStream — accumulate toward the rolling cap. The earlier exemption for whole-file writeFile
// ("it overwrites, so payload == final file size, so the single-write cap suffices") was FALSE: a loop of
// DISTINCT filenames (each ≤64MB, own dir, no grant) and a writeFile({flag:'a'}) append both grow the
// volume without bound under the single-cap-only branch. The single-write cap still bounds any individual
// payload; the rolling window bounds cumulative growth regardless of overwrite-vs-append or filename churn.
const SINGLE_WRITE_MAX = 64 * 1024 * 1024;        // 64MB — largest single write/chunk a plugin may make
const PLUGIN_GROW_QUOTA = 512 * 1024 * 1024;      // 512MB of append/stream growth per ROLLING WINDOW per plugin
const GROW_WINDOW_MS = 60 * 1000;                 // rolling window: a flood trips fast; slow legit appends never do
const QUOTA_METHODS = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']);
// Per-plugin rolling-window accounting for GROWING writes. A lifetime counter would eventually block a
// legitimate long-running plugin that appends a rotated log; a window (reset when stale) stops a burst
// disk-fill while never permanently throttling normal slow growth. Shared with the fs.promises path via
// the exported enforceGrowQuota so both APIs count against the same budget.
const _grownWindow = new Map<string, { start: number; bytes: number }>();

function quotaErr(slug: string, msg: string): any {
    const e: any = new Error(`EDQUOT: plugin '${slug}' disk write blocked — ${msg}`);
    e.code = 'EDQUOT';
    return e;
}
function byteLenOf(data: any): number {
    if (data == null) return 0;
    if (typeof data === 'string') return Buffer.byteLength(data);
    if (Buffer.isBuffer(data)) return data.length;
    if (data && typeof data.byteLength === 'number') return data.byteLength; // TypedArray/ArrayBuffer/DataView
    try { return Buffer.byteLength(String(data)); } catch { return 0; }
}
function enforceSingleWrite(slug: string, n: number): void {
    if (n > SINGLE_WRITE_MAX) throw quotaErr(slug, `single write of ${n} bytes exceeds the ${SINGLE_WRITE_MAX}-byte limit`);
}
function enforceGrowQuota(slug: string, n: number): void {
    enforceSingleWrite(slug, n);
    const now = Date.now();
    let w = _grownWindow.get(slug);
    if (!w || now - w.start > GROW_WINDOW_MS) { w = { start: now, bytes: 0 }; _grownWindow.set(slug, w); }
    if (w.bytes + n > PLUGIN_GROW_QUOTA) throw quotaErr(slug, `append/stream growth quota of ${PLUGIN_GROW_QUOTA} bytes per ${GROW_WINDOW_MS / 1000}s exceeded`);
    w.bytes += n;
}
// (#7) Count the directory entries a mkdir will actually create so each can be charged the block floor:
// 1 for a non-recursive mkdir, and for recursive:true the number of not-yet-existing ancestors up to the
// first existing dir (so a single deep `mkdir -p` is metered per NEW component, not once). Best-effort —
// stat errors fall back to 1, and a hard depth cap guarantees this can never loop unbounded. Uses the
// unpatched fs.existsSync (existence only, no content) exactly as the copyFile metering below uses statSync.
function mkdirCreateCount(target: any, recursive: boolean): number {
    if (!recursive) return 1;
    let count = 0;
    let cur = path.resolve(String(target));
    for (let i = 0; i < 4096; i++) {           // hard cap; real filesystem path depth is far below this
        let exists: boolean;
        try { exists = fs.existsSync(cur); } catch { exists = false; }
        if (exists) break;
        count++;
        const parent = path.dirname(cur);
        if (parent === cur) break;             // reached the filesystem root
        cur = parent;
    }
    return Math.max(1, count);
}
// Patch fs.WriteStream.PROTOTYPE._write/_writev ONCE (context-gated) — the instance-level stream.write
// shadow in wrapQuotaStream is trivially bypassed via Object.getPrototypeOf(stream).write.call(stream)
// (#14, same class of hole as FileHandle). _write/_writev are the single funnel EVERY buffered write
// passes through no matter how .write was reached, so metering there is authoritative; host streams
// (getEffectivePlugin()===null) are unaffected.
let _wsProtoPatched = false;
function patchWriteStreamProto(): void {
    if (_wsProtoPatched) return;
    try {
        const WS: any = (fs as any).WriteStream;
        if (!WS || !WS.prototype) return;
        const orig = WS.prototype._write;
        if (typeof orig === 'function') {
            WS.prototype._write = function (this: any, chunk: any, enc: any, cb: any) {
                const slug = getEffectivePlugin();
                if (slug && chunk != null) { try { enforceGrowQuota(slug, byteLenOf(chunk)); } catch (e) { return cb(e); } }
                return orig.call(this, chunk, enc, cb);
            };
        }
        const origV = WS.prototype._writev;
        if (typeof origV === 'function') {
            WS.prototype._writev = function (this: any, chunks: any[], cb: any) {
                const slug = getEffectivePlugin();
                if (slug && Array.isArray(chunks)) { try { let n = 0; for (const c of chunks) n += byteLenOf(c && c.chunk); enforceGrowQuota(slug, n); } catch (e) { return cb(e); } }
                return origV.call(this, chunks, cb);
            };
        }
        _wsProtoPatched = true;
    } catch { /* best-effort; the instance shadow below remains as defense */ }
}
// Wrap a createWriteStream result so each chunk is metered; on overflow the stream is destroyed with the
// quota error (surfaced as a normal stream 'error') instead of silently filling the disk.
function wrapQuotaStream(slug: string, stream: any): any {
    patchWriteStreamProto(); // authoritative prototype-level metering (covers getPrototypeOf(stream).write)
    if (!stream || typeof stream.write !== 'function') return stream;
    const origWrite = stream.write.bind(stream);
    const origEnd = stream.end.bind(stream);
    stream.write = function (chunk: any, enc?: any, cb?: any) {
        if (chunk != null && typeof chunk !== 'function') {
            try { enforceGrowQuota(slug, byteLenOf(chunk)); }
            catch (e) { stream.destroy(e as Error); return false; }
        }
        return origWrite(chunk, enc, cb);
    };
    stream.end = function (chunk?: any, enc?: any, cb?: any) {
        if (chunk != null && typeof chunk !== 'function') {
            try { enforceGrowQuota(slug, byteLenOf(chunk)); }
            catch (e) { stream.destroy(e as Error); return stream; }
        }
        return origEnd(chunk, enc, cb);
    };
    return stream;
}

// fs.open(path, flags?, mode?, cb) decides READ vs WRITE by its flags (default 'r' = read). A plugin that
// opens a file for WRITING outside its write-zones (e.g. into node_modules, a read-only zone) must be
// write-confined, not waved through as a read — else open is a write-confinement bypass. Handles the
// string forms (w/a/r+/w+/a+/wx/ax…, all of which contain w, a, or +; plain 'r'/'rs' do not) and the
// numeric O_* bitmask; a missing/callback flags arg means the default 'r'.
function openFlagsAreWrite(flags: any): boolean {
    if (flags == null || typeof flags === 'function') return false;
    if (typeof flags === 'number') {
        const acc = flags & 0o3; // O_ACCMODE: 0=RDONLY, 1=WRONLY, 2=RDWR
        const wbits = fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC;
        return acc !== 0 || (flags & wbits) !== 0;
    }
    return /[wa+]/.test(String(flags));
}

// === PATCHES ===

function patch(methodName: string, isSync = false) {
    const original = (ORIGINALS as any)[methodName];
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

    fs[methodName] = function (...args: any[]) {
        // Different methods have path(s) at different positions, with different read/write semantics.
        // pathsToCheck is a list of [path, isWriteForThisPath] pairs.
        let pathsToCheck: [any, boolean][] = [[args[0], isWrite]];

        if (methodName.startsWith('copy') || methodName.startsWith('cp') || methodName.startsWith('link')) {
            // (source, dest): source is READ, dest is WRITTEN. Checking the source with read semantics
            // still denies a secret/DB source (those blocks ignore the flag) while the dest gets the full
            // write confinement — including the executable-extension block, which stops copy/hard-link to
            // '<own>/x.js'. Read semantics on the source avoids over-blocking a legit copy out of a
            // read-only zone (e.g. node_modules) into a safe write dir.
            pathsToCheck = [[args[0], false], [args[1], true]];
        } else if (methodName.startsWith('rename') || methodName.startsWith('symlink')) {
            // rename modifies BOTH ends; symlink writes the link path. Check both with write semantics
            // (secret/DB source is still denied regardless, and rename-into-x.js is caught on the dest).
            pathsToCheck = [[args[0], true], [args[1], true]];
        } else if (methodName === 'open' || methodName === 'openSync') {
            // open's read/write intent lives in its flags (args[1]); confine with the correct semantics so
            // open-for-write outside the write-zones is denied as a write, not passed through as a read.
            pathsToCheck = [[args[0], openFlagsAreWrite(args[1])]];
        }

        for (const [p, w] of pathsToCheck) {
            if (!p) continue;
            // Validate
            if (!isPathSafe(p, w)) {
                const error: any = new Error(`EACCES: Permission denied, plugin cannot access: ${p}`);
                error.code = 'EACCES';
                if (isSync) throw error;
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(error);
                return;
            }
        }

        // (#14) truncate(path,len)/truncateSync ALLOCATE `len` bytes — a byte-producing write QUOTA_METHODS
        // omits. Meter by the target length against the same rolling grow quota (metered only under plugin
        // context; core/host is unmetered).
        if (methodName === 'truncate' || methodName === 'truncateSync') {
            const cslug = getEffectivePlugin();
            if (cslug) {
                try { enforceGrowQuota(cslug, Math.max(0, Number(args[1]) || 0)); }
                catch (error: any) {
                    if (isSync) throw error;
                    const cb = args[args.length - 1];
                    if (typeof cb === 'function') { cb(error); return; }
                    throw error;
                }
            }
        }
        // (#14) copyFile/copyFileSync DUPLICATE a file — a real byte-writer that QUOTA_METHODS omits. Meter
        // the SOURCE file's size against the same rolling grow quota so a distinct-dest copy loop can't fill
        // the disk unmetered. (Metered only under plugin context; core/host is unmetered.)
        if (methodName === 'copyFile' || methodName === 'copyFileSync' || methodName === 'cp' || methodName === 'cpSync') {
            const cslug = getEffectivePlugin();
            if (cslug) {
                try {
                    let sz = 0; try { sz = fs.statSync(args[0]).size; } catch { sz = 0; }
                    enforceGrowQuota(cslug, sz);
                } catch (error: any) {
                    if (isSync) throw error;
                    const cb = args[args.length - 1];
                    if (typeof cb === 'function') { cb(error); return; }
                    throw error;
                }
            }
        }
        // (#7) mkdir/mkdirSync CREATE directory entries — an inode/dir-entry producer QUOTA_METHODS omits, so
        // an unbounded mkdir loop (each dir in the plugin's OWN dir, no grant needed) exhausts inodes / fills
        // the shared volume → ENOSPC on data/wordjs.db → full-site outage, entirely unmetered. Charge each
        // directory actually created at least one filesystem-block floor (4096 B) against the SAME rolling
        // grow-quota the write ops use; for recursive:true, charge per not-yet-existing component so one deep
        // tree is metered per new dir, not once. (Metered only under a plugin context; core/host is unmetered.
        // Runs only after isPathSafe() passed above, so mkdir's normal path-safety checks stay intact.)
        if (methodName === 'mkdir' || methodName === 'mkdirSync') {
            const cslug = getEffectivePlugin();
            if (cslug) {
                try {
                    const opts = (args[1] && typeof args[1] === 'object') ? args[1] : null;
                    enforceGrowQuota(cslug, 4096 * mkdirCreateCount(args[0], !!(opts && opts.recursive)));
                } catch (error: any) {
                    if (isSync) throw error;
                    const cb = args[args.length - 1];
                    if (typeof cb === 'function') { cb(error); return; }
                    throw error;
                }
            }
        }

        // Per-plugin write quota (metered only under a plugin context; core/host is unmetered).
        const quotaSlug = QUOTA_METHODS.has(methodName) ? getEffectivePlugin() : null;
        if (quotaSlug) {
            if (methodName === 'createWriteStream') {
                return wrapQuotaStream(quotaSlug, original.apply(this, args));
            }
            try {
                // (#14) writeFile* now accumulate against the rolling grow-quota exactly like append*,
                // instead of only taking the per-call single-write cap. The old exemption assumed a
                // whole-file writeFile "overwrites, so payload == final file size, so the single cap
                // suffices" — FALSE for a loop of DISTINCT filenames:
                //   for (let i = 0; ; i++) fs.writeFileSync('<owndir>/f' + i, buf64MB);
                // each write is ≤64MB and needs no grant, yet the loop wrote tens of GB → ENOSPC on
                // data/wordjs.db → full-site outage. It is also false for a single-file append via
                // writeFile('<owndir>/log', chunk, { flag: 'a' }) (string 'a'/'ax'/'a+' OR numeric
                // O_APPEND=1024), which the old single-cap branch never inspected. Metering EVERY write
                // (overwrite or append) against the window closes both: enforceGrowQuota calls
                // enforceSingleWrite internally, so the >64MB single-payload reject is preserved, AND it
                // adds the payload to the rolling window — one accounting path per call, never doubled.
                // (#14) A writeFile CREATES/overwrites a file, and a loop of DISTINCT filenames with a 0-byte
                // (or tiny) payload floods inodes/dir entries while charging ~0 bytes. Floor each writeFile at
                // one filesystem block so an empty-file flood still accrues quota (≈128K files per 60s window
                // before the 512MB cap trips — far above any legitimate write rate). Append/stream unaffected.
                const _floor = (methodName === 'writeFile' || methodName === 'writeFileSync') ? 4096 : 0;
                enforceGrowQuota(quotaSlug, Math.max(byteLenOf(args[1]), _floor));
            } catch (error: any) {
                if (isSync) throw error;
                const cb = args[args.length - 1];
                if (typeof cb === 'function') { cb(error); return; }
                throw error;
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
patch('copyFile'); patch('copyFileSync', true);
patch('cp'); patch('cpSync', true);
patch('link'); patch('linkSync', true);

// Read Ops
patch('readFile'); patch('readFileSync', true);
patch('readdir'); patch('readdirSync', true);
patch('createReadStream');
// Path-taking read ops the readFile/readdir patches don't funnel through. open is flag-aware (write flags →
// write-confined). None are used by io-guard internally, so no original-capture is needed. NOTE: stat/lstat/
// access/realpath are intentionally left UNPATCHED for now — they are used during require() resolution and by
// io-guard's own metering, so guarding them risks breaking plugin loading; deferred to a separate change.
patch('open'); patch('openSync', true);
patch('opendir'); patch('opendirSync', true);
patch('readlink'); patch('readlinkSync', true);

module.exports = {
    isPathSafe,
    // Exported so the fs.promises proxy (secure-require) meters against the SAME per-plugin budget as the
    // callback/sync fs methods — otherwise a plugin's fs.promises writes bypass the disk quota entirely.
    enforceSingleWrite,
    enforceGrowQuota,
    byteLenOf
};
