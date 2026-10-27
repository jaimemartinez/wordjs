/**
 * The code and manifest of an isolated plugin, fingerprinted, and checked before every launch.
 *
 * The code directory is read-only to the plugin at every sandbox layer; this is the check that the files
 * a launch is about to run are still the ones the host installed. The fingerprint is a SHA-256 over every
 * file of the code directory (path, size and content) except its `data` link (core/plugin-own-data). It is
 * recorded the first time the plugin launches after the host installed or updated it — the host forgets
 * the old record when it replaces the code (refreshPluginDirGrants, uninstallPluginData) — and kept in
 * host-only state under data/, which no plugin can read or write.
 *
 * A mismatch refuses the launch in production. In a development or test run (the same opt-ins as the
 * source-worker exemption, plus NODE_ENV=development/test) editing a plugin is the job, so the new files
 * are recorded with a warning instead. An administrator who changed the files on purpose accepts them
 * from Site Health (acceptPluginIntegrity).
 */
const fsi = require('fs');
const pathi = require('path');
const cryptoi = require('crypto');
const { storageKey, ownPluginDir } = require('./sandbox-paths');

const MAX_FILES = 50000;

function recordFile(appRoot: string, slug: string): string {
    return pathi.join(pathi.resolve(appRoot), 'data', 'sandbox', 'plugin-integrity', `${storageKey(slug)}.json`);
}

/**
 * SHA-256 of the regular file `a` that `st` (its lstat) described, read through ONE descriptor. Null when
 * what was opened is not that file any more: another type, or another inode or size than the lstat saw.
 */
function hashRegularFile(a: string, st: any): string | null {
    const noFollow = (fsi.constants && fsi.constants.O_NOFOLLOW) || 0;
    let fd: number;
    try { fd = fsi.openSync(a, fsi.constants.O_RDONLY | noFollow); } catch { return null; }
    try {
        const now = fsi.fstatSync(fd);
        if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev || now.size !== st.size) return null;
        return cryptoi.createHash('sha256').update(fsi.readFileSync(fd)).digest('hex');
    } catch { return null; } finally {
        try { fsi.closeSync(fd); } catch { /* */ }
    }
}

/** SHA-256 over the code directory: every regular file (and link target) except the top-level `data`. */
function digestCodeDir(dir: string): { digest: string; files: number } {
    const entries: string[] = [];
    const walk = (abs: string, rel: string, depth: number) => {
        if (depth > 64 || entries.length > MAX_FILES) return;
        let names: string[];
        try { names = fsi.readdirSync(abs).sort(); } catch { return; }
        for (const name of names) {
            if (depth === 0 && name === 'data') continue;
            const a = pathi.join(abs, name);
            const r = rel ? `${rel}/${name}` : name;
            let st: any;
            try { st = fsi.lstatSync(a); } catch { continue; }
            if (st.isSymbolicLink()) {
                let t = '';
                try { t = fsi.readlinkSync(a); } catch { /* unreadable link: its name still counts */ }
                entries.push(`L\0${r}\0${t}`);
            } else if (st.isDirectory()) {
                entries.push(`D\0${r}`);
                walk(a, r, depth + 1);
            } else if (st.isFile()) {
                const h = hashRegularFile(a, st);
                // A file swapped between the lstat and the open never matches a recorded digest.
                entries.push(h === null ? `X\0${r}` : `F\0${r}\0${st.size}\0${h}`);
            }
        }
    };
    walk(dir, '', 0);
    return { digest: cryptoi.createHash('sha256').update(entries.join('\n'), 'utf8').digest('hex'), files: entries.length };
}

function readRecord(appRoot: string, slug: string): { digest: string; files: number; at: string } | null {
    try {
        const r = JSON.parse(fsi.readFileSync(recordFile(appRoot, slug), 'utf8'));
        return r && typeof r.digest === 'string' ? r : null;
    } catch { return null; }
}

function writeRecord(appRoot: string, slug: string, digest: { digest: string; files: number }): void {
    const file = recordFile(appRoot, slug);
    fsi.mkdirSync(pathi.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${cryptoi.randomBytes(6).toString('hex')}.tmp`;
    fsi.writeFileSync(tmp, JSON.stringify({ ...digest, at: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
    fsi.renameSync(tmp, file);
}

/** Plugins whose last launch was refused for changed files (for Site Health), by slug. */
const mismatches = new Map<string, { at: string; files: number }>();

function devRun(env: Record<string, string | undefined> = process.env): boolean {
    if (env.NODE_ENV === 'production') return false;
    return env.NODE_ENV === 'development' || env.NODE_ENV === 'test' || env.WORDJS_DEV_SANDBOX_EXEMPT === '1'
        || (typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT.length > 0);
}

/**
 * Check the plugin's code against its record. `recorded` is true when there was none and one was written
 * now (the first launch after an install or update). Throws nothing; the caller refuses on `ok: false`.
 */
function verifyPluginIntegrity(appRoot: string, slug: string, env: Record<string, string | undefined> = process.env): { ok: boolean; recorded: boolean; reason?: string } {
    const dir = ownPluginDir(appRoot, slug);
    const now = digestCodeDir(dir);
    const rec = readRecord(appRoot, slug);
    if (!rec) { writeRecord(appRoot, slug, now); mismatches.delete(slug); return { ok: true, recorded: true }; }
    if (rec.digest === now.digest) { mismatches.delete(slug); return { ok: true, recorded: false }; }
    if (devRun(env)) { writeRecord(appRoot, slug, now); mismatches.delete(slug); return { ok: true, recorded: true, reason: 'development run: the changed files were recorded' }; }
    mismatches.set(slug, { at: new Date().toISOString(), files: now.files });
    return { ok: false, recorded: false, reason: 'the files of this plugin changed since WordJS installed it' };
}

/** Record the plugin's current files as its own (an administrator accepted them). */
function acceptPluginIntegrity(appRoot: string, slug: string): void {
    writeRecord(appRoot, slug, digestCodeDir(ownPluginDir(appRoot, slug)));
    mismatches.delete(slug);
}

/** The host replaced or removed the code: the next launch records the new files. */
function forgetPluginIntegrity(appRoot: string, slug: string): void {
    try { fsi.rmSync(recordFile(appRoot, slug), { force: true }); } catch { /* nothing recorded */ }
    mismatches.delete(slug);
}

function listIntegrityMismatches(): string[] {
    return Array.from(mismatches.keys());
}

module.exports = { digestCodeDir, verifyPluginIntegrity, acceptPluginIntegrity, forgetPluginIntegrity, listIntegrityMismatches, __devRun: devRun, __hashRegularFile: hashRegularFile };
