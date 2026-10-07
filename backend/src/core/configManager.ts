const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.resolve('wordjs-config.json');

// The install/migration guard consults this file on EVERY non-static request; without a cache that
// is 2–3 blocking syscalls + a JSON.parse serialized on the event loop per request. Cache the RAW
// read outcome and revalidate cheaply: saveConfig() (the only in-process writer) invalidates
// immediately, and a 1-syscall mtime check every CONFIG_TTL_MS catches external writers (the setup
// wizard on another process, scripts/node-join.js). Semantics of getConfig/isInstalled — including
// the fail-closed corrupt→installed behavior — are built on top and unchanged.
const CONFIG_TTL_MS = 2000;
let _cfgCache: { exists: boolean; parsed: any; parseError: boolean; mtimeMs: number; checkedAt: number } | null = null;

function invalidateConfigCache() { _cfgCache = null; }

function readConfigFile() {
    const now = Date.now();
    if (_cfgCache && now - _cfgCache.checkedAt < CONFIG_TTL_MS) return _cfgCache;
    let st = null;
    try { st = fs.statSync(CONFIG_FILE); } catch { /* missing */ }
    if (!st) {
        _cfgCache = { exists: false, parsed: null, parseError: false, mtimeMs: 0, checkedAt: now };
        return _cfgCache;
    }
    if (_cfgCache && _cfgCache.exists && _cfgCache.mtimeMs === st.mtimeMs) {
        _cfgCache.checkedAt = now;
        return _cfgCache;
    }
    let parsed = null, parseError = false;
    try {
        parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        parseError = true;
    }
    _cfgCache = { exists: true, parsed, parseError, mtimeMs: st.mtimeMs, checkedAt: now };
    return _cfgCache;
}

/**
 * Get the stored configuration
 * @returns {Object|null} The configuration object or null if not found
 */
function getConfig() {
    const f = readConfigFile();
    if (!f.exists) return null;
    if (f.parseError) {
        console.error('Failed to read config file: unreadable or malformed JSON');
        return null;
    }
    return f.parsed;
}

// ─── Writing ────────────────────────────────────────────────────────────────────────────────────────
//
// THREE WAYS THE OLD WRITER LOST DATA, and what replaced each:
//
//   1. `fs.writeFileSync(CONFIG_FILE, …)` truncates the file and then writes it. A crash, a full disk or
//      a reader that opens it in between (the gateway, the frontend's instrumentation, OneDrive's sync
//      engine) sees an EMPTY or half-written file — and a half-written wordjs-config.json is an install
//      with no database, no mTLS paths and no secrets. Now: write a temporary file next to it, fsync,
//      and rename over the original, so a reader sees the old bytes or the new ones, never a mix.
//   2. It merged into `getConfig() || {}`. While the file is momentarily unparseable (a CLI write in
//      progress, a sync client holding it), getConfig() is null, and the "merge" wrote a file holding
//      ONLY the keys being saved — wiping the install (REDTEAM R10). Now: an unreadable file aborts the
//      write; only a file that does not exist yet starts from {}.
//   3. It merged into the 2-second CACHE. A second writer (the `npm run site` CLI, the setup wizard in
//      another process) that wrote within that window was silently undone. Now: every write reads the
//      file afresh, and `updateConfig` can compare-and-swap on `siteAddress.rev` — and always re-checks
//      the bytes on disk immediately before the rename.

/** What is on disk right now, bypassing the cache: every WRITER must decide on the current bytes. */
function readConfigFresh(): { exists: boolean; text: string | null; parsed: any; parseError: boolean } {
    let text: string;
    try {
        text = fs.readFileSync(CONFIG_FILE, 'utf8');
    } catch (e: any) {
        if (e && e.code === 'ENOENT') return { exists: false, text: null, parsed: null, parseError: false };
        // Present but unreadable (locked, permissions): treat exactly like unparseable — never as absent,
        // which would let the writer start from {} and replace the install.
        return { exists: true, text: null, parsed: null, parseError: true };
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { exists: true, text, parsed: null, parseError: true };
        return { exists: true, text, parsed, parseError: false };
    } catch {
        return { exists: true, text, parsed: null, parseError: true };
    }
}

/** The site-address revision a config carries (0 when it has never been through site-address). */
function siteAddressRev(cfg: any): number {
    const rev = cfg && cfg.siteAddress ? cfg.siteAddress.rev : undefined;
    return Number.isInteger(rev) && rev >= 0 ? rev : 0;
}

// Windows (and OneDrive in particular) refuses to replace a file another process has open, with EPERM,
// EACCES or EBUSY that clears within milliseconds. Retry briefly before giving up on the atomic path.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

function sleepSync(ms: number) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readTextOrNull(file: string): string | null {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * The file a write to `target` must replace: `target` itself, or — when `target` is a symbolic link —
 * the file the link points to, even if that does not exist yet.
 *
 * WHY: the container entrypoint (docker/entrypoint.sh, used by Docker, compose and Helm) makes
 * backend/wordjs-config.json a symlink into the data volume, so the install state survives a re-created
 * container. rename(2) over a symlink replaces the LINK with a regular file in the container layer: the
 * install, every later address change and the CLI's writes then lived where the next image upgrade or
 * pod restart throws them away, and the site came back in setup mode over a populated database. The
 * replacement is therefore written next to the link's target and renamed over IT; the link stays.
 *
 * realpath resolves every link in the chain (and in the directories); a dangling link — the first boot,
 * before anything was written — has no realpath, so its target is read and resolved against the link's
 * directory, as the kernel would. Anything else (no file yet, no link) is written where it was asked.
 */
function resolveWriteTarget(target: string): string {
    try { return fs.realpathSync(target); } catch { /* missing, or a dangling link: see below */ }
    try { return path.resolve(path.dirname(target), fs.readlinkSync(target)); } catch { return target; }
}

/**
 * Replace `target` with `text` atomically: temp file in the same directory → fsync → rename. When
 * `target` is a symlink, the file it points to is replaced and the link is kept (resolveWriteTarget).
 *
 * `expectText` is the compare half of compare-and-swap: when given, the target is re-read right before
 * the rename and the write is abandoned ('changed') if its bytes are no longer the ones the caller
 * decided on (null = "the file must not exist"). The temporary file inherits the existing file's
 * permission bits, so a config other services read (the frontend, the gateway) stays readable to them.
 *
 * If the rename keeps failing with a sharing violation, the last resort is an in-place write: not
 * atomic, but the only write a locked file on Windows accepts, and still better than failing the save.
 */
function writeFileAtomic(target: string, text: string, expectText?: string | null): 'written' | 'changed' {
    const real = resolveWriteTarget(target);
    const dir = path.dirname(real);
    const tmp = path.join(dir, `.${path.basename(real)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`);
    let mode: number | undefined;
    try { mode = fs.statSync(real).mode & 0o777; } catch { /* new file: default permissions */ }

    const fd = fs.openSync(tmp, 'wx', mode === undefined ? 0o666 : mode);
    try {
        fs.writeSync(fd, text);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        // The umask may have narrowed the creation mode; the replacement keeps the original's bits.
        if (mode !== undefined) { try { fs.chmodSync(tmp, mode); } catch { /* Windows: no POSIX bits */ } }
        if (expectText !== undefined && readTextOrNull(real) !== expectText) {
            fs.rmSync(tmp, { force: true });
            return 'changed';
        }
        for (let attempt = 0; ; attempt++) {
            try {
                fs.renameSync(tmp, real);
                break;
            } catch (e: any) {
                if (!RENAME_RETRY_CODES.has(e && e.code)) throw e;
                if (attempt < RENAME_RETRY_DELAYS_MS.length) {
                    sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
                    continue;
                }
                fs.writeFileSync(real, text);
                fs.rmSync(tmp, { force: true });
                break;
            }
        }
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ }
        throw e;
    }
    // Make the rename itself durable where the platform allows syncing a directory (not Windows).
    try {
        const dfd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* best-effort */ }
    return 'written';
}

// ─── One writer at a time, across processes ─────────────────────────────────────────────────────────

/** A lock this old is abandoned whoever holds it: a write takes milliseconds (a few hundred at worst). */
const LOCK_STALE_MS = 5000;
/** How long a writer waits for the lock — past LOCK_STALE_MS, so a dead holder's lock is broken first. */
const LOCK_WAIT_MS = 6000;
const LOCK_BUSY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return !!e && e.code === 'EPERM';
    }
}

/** A lock left by a process that is gone (it died between taking and releasing it), or simply too old. */
function lockIsAbandoned(lock: string): { abandoned: boolean; text: string | null } {
    let text: string | null = null;
    try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        text = readTextOrNull(lock);
        if (age > LOCK_STALE_MS) return { abandoned: true, text };
        const owner = text ? JSON.parse(text) : null;
        return { abandoned: !!owner && Number.isInteger(owner.pid) && owner.pid !== process.pid && !processAlive(owner.pid), text };
    } catch {
        return { abandoned: false, text };
    }
}

/**
 * Run `fn` holding `<config>.lock`, so the compare half of the compare-and-swap and the swap itself are
 * one step for every process that writes the file through this module: the backend, `npm run site`, a
 * second CLI run. They used to be separate system calls (re-read, compare, rename — with a Windows
 * sharing-violation retry of up to a few hundred milliseconds in between), so two writers could compare
 * against the same bytes, both rename, and both report the same revision as saved: one change silently
 * gone, and never audited.
 *
 * The lock is a file created exclusively beside the config (beside the link's target when the config is
 * a symlink, where the replacement is written too), naming its owner's pid. One left by a process that
 * died holding it, or older than LOCK_STALE_MS, is broken — after reading it again, so a lock another
 * writer has just taken is not. Returns `{ ok: false }` when the lock could not be had within LOCK_WAIT_MS.
 */
function withConfigLock<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
    const lock = `${resolveWriteTarget(CONFIG_FILE)}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | null = null;
    for (let attempt = 0; fd === null; attempt++) {
        try {
            fd = fs.openSync(lock, 'wx', 0o600);
        } catch (e: any) {
            // EPERM/EACCES/EBUSY too: on Windows a lock file that is being deleted cannot be created yet.
            if (!LOCK_BUSY_CODES.has(e && e.code)) throw e;
            const seen = lockIsAbandoned(lock);
            if (seen.abandoned && readTextOrNull(lock) === seen.text) {
                try { fs.rmSync(lock, { force: true }); } catch { /* someone else broke it */ }
                continue;
            }
            if (Date.now() >= deadline) return { ok: false };
            sleepSync(Math.min(5 * (attempt + 1), 50));
        }
    }
    try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } finally {
        fs.closeSync(fd);
    }
    try {
        return { ok: true, value: fn() };
    } finally {
        try { fs.rmSync(lock, { force: true }); } catch { /* broken as abandoned meanwhile */ }
    }
}

/**
 * Refresh the in-memory runtime config (siteUrl → CSRF/CORS allowed-origins, the site's aliases and
 * host policy, …) from the object just written, so a persisted change takes effect WITHOUT a process
 * restart. Handing it the object (rather than letting it re-read a path of its own) keeps the runtime
 * view identical to the bytes this module wrote.
 */
function reloadRuntimeConfig(fresh: any) {
    try { require('../config/app').reloadFromFile?.(fresh); } catch { /* config not yet loaded (pre-boot) */ }
}

type ConfigUpdate =
    | { ok: true; config: any; previousText: string | null }
    | { ok: false; reason: 'unreadable' | 'stale' | 'write-failed'; currentRev?: number; error?: unknown };

/**
 * Read-modify-write the config file. `mutate` receives the CURRENT parsed config (a fresh read, `{}`
 * when the file does not exist yet) and returns the complete object to store.
 *
 * Refuses with `unreadable` when the file exists but cannot be parsed (REDTEAM R10), and with `stale`
 * when `expectRev` is given and `siteAddress.rev` on disk is another value — or when the bytes change
 * between this read and the rename. `previousText` is the exact prior content, for a caller that must
 * roll back. `reload: false` skips refreshing config/app (the CLI has no running server to refresh).
 * The read, the check and the rename happen under the cross-process lock (withConfigLock); a lock that
 * cannot be had is `write-failed`, and nothing is written.
 */
function updateConfig(
    mutate: (current: Record<string, any>) => Record<string, any>,
    opts: { expectRev?: number; reload?: boolean } = {}
): ConfigUpdate {
    let locked: { ok: true; value: ConfigUpdate } | { ok: false };
    try {
        locked = withConfigLock(() => updateConfigLocked(mutate, opts));
    } catch (e) {
        console.error('Failed to lock the config file:', e);
        return { ok: false, reason: 'write-failed', error: e };
    }
    if (!locked.ok) {
        console.error(`Refusing to write ${CONFIG_FILE}: another process kept it locked for ${LOCK_WAIT_MS / 1000} s.`);
        return { ok: false, reason: 'write-failed', error: new Error('the config file is locked') };
    }
    return locked.value;
}

function updateConfigLocked(
    mutate: (current: Record<string, any>) => Record<string, any>,
    opts: { expectRev?: number; reload?: boolean }
): ConfigUpdate {
    const before = readConfigFresh();
    if (before.exists && before.parseError) {
        console.error(`Refusing to write ${CONFIG_FILE}: the file exists but cannot be read as JSON, and rewriting it from scratch would erase the install.`);
        return { ok: false, reason: 'unreadable' };
    }
    const current = before.exists ? before.parsed : {};
    if (opts.expectRev !== undefined && siteAddressRev(current) !== opts.expectRev) {
        return { ok: false, reason: 'stale', currentRev: siteAddressRev(current) };
    }
    const next = mutate(current);
    try {
        if (writeFileAtomic(CONFIG_FILE, JSON.stringify(next, null, 2), before.text) === 'changed') {
            invalidateConfigCache();
            const now = readConfigFresh();
            return { ok: false, reason: 'stale', currentRev: now.parseError ? undefined : siteAddressRev(now.parsed) };
        }
    } catch (e) {
        console.error('Failed to write config file:', e);
        return { ok: false, reason: 'write-failed', error: e };
    }
    invalidateConfigCache();
    if (opts.reload !== false) reloadRuntimeConfig(next);
    return { ok: true, config: next, previousText: before.text };
}

/**
 * Put back exact prior bytes (a rollback), but only if the file is still at `expectRev` — the revision
 * the failed change wrote. If anyone wrote after it (the CLI), their change wins and nothing is undone.
 */
function restoreConfigText(text: string, opts: { expectRev: number; reload?: boolean }): boolean {
    try {
        const locked = withConfigLock(() => restoreConfigTextLocked(text, opts));
        return locked.ok && locked.value;
    } catch (e) {
        console.error('Failed to lock the config file:', e);
        return false;
    }
}

function restoreConfigTextLocked(text: string, opts: { expectRev: number; reload?: boolean }): boolean {
    const now = readConfigFresh();
    if (!now.exists || now.parseError || siteAddressRev(now.parsed) !== opts.expectRev) return false;
    let restored: any;
    try { restored = JSON.parse(text); } catch { return false; }
    try {
        if (writeFileAtomic(CONFIG_FILE, text, now.text) === 'changed') return false;
    } catch (e) {
        console.error('Failed to restore config file:', e);
        return false;
    }
    invalidateConfigCache();
    if (opts.reload !== false) reloadRuntimeConfig(restored);
    return true;
}

/**
 * Save configuration to disk: merge `config` into what is on disk NOW and stamp `updatedAt`.
 * @param {Object} config The keys to set
 * @returns {boolean} True on success; false when the write was refused (unreadable file) or failed
 */
function saveConfig(config: any) {
    return updateConfig((current) => ({ ...current, ...config, updatedAt: new Date().toISOString() })).ok;
}

/**
 * Check if the application is installed
 * @returns {boolean}
 */
/**
 * Does this config describe a site that has been through the installer?
 *
 * The config file's mere EXISTENCE is not proof: cluster enrollment (scripts/node-join.js) writes this
 * same file to carry the gateway wiring + mTLS paths onto a brand-new backend node that has never been
 * set up. Treating that as installed skipped the wizard, and the CMS bootstrap then seeded a default
 * administrator on a node already published through the gateway.
 *
 * So key off something only the installer writes: `installedAt`, or `dbDriver` for sites installed
 * before that marker existed (enrollment carries no database choice).
 *
 * Exported for tests — the predicate is pure, `isInstalled()` just supplies the file.
 */
function isInstalledConfig(cfg: any) {
    if (!cfg || typeof cfg !== 'object') return false;
    return !!(cfg.installedAt || cfg.dbDriver);
}

function isInstalled() {
    const f = readConfigFile();
    if (!f.exists) return false;
    // Unreadable/corrupt config → report INSTALLED. Fail closed: a parse error must never reopen the
    // installer on a live site.
    if (f.parseError) return true;
    return isInstalledConfig(f.parsed);
}

module.exports = {
    getConfig,
    saveConfig,
    updateConfig,
    restoreConfigText,
    readConfigFresh,
    siteAddressRev,
    writeFileAtomic,
    isInstalled,
    isInstalledConfig,
    invalidateConfigCache,
    CONFIG_FILE
};
