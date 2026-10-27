/**
 * WordJS — updating WordJS from the admin panel (Admin → Updates), zero config.
 *
 * The update itself is the official one, `create-wordjs upgrade` (packages/create-wordjs): it downloads
 * the release bundle from the project's GitHub releases, verifies its SHA-256 against the release's
 * .sha256 asset BEFORE extracting anything, overlays the code while preserving the database, uploads,
 * backups and config, and re-syncs the runtime dependencies (`release:install`). The panel runs the copy
 * of that CLI the INSTALLED release shipped (packages/create-wordjs/index.js, already on this disk) with
 * this Node binary and no shell — never a package resolved from the registry at update time. This module
 * does not reimplement any of that; it decides WHETHER the panel may run it here, and runs it around a
 * safety net:
 *
 *   1. a backup (core/backup), before anything changes;
 *   2. `node <install root>/packages/create-wordjs/index.js upgrade <install root> --yes --version <tag>`;
 *   3. on success: the state is recorded as `applied` and WordJS restarts itself (core/restart);
 *      on failure: the previous version is re-applied the same way (`--version v<current> --force`);
 *   4. at boot, a process that comes up after an `applied` update marks it `done`. One that crashes
 *      instead is caught by the monolith's supervisor (backend/scripts/update-rollback.js, used by
 *      monolith.js), which re-applies the previous version and starts it again.
 *
 * WHERE THE PANEL REFUSES, and says what to do instead:
 *   - a Docker image (the code is the image): pull the new tag;
 *   - a git checkout (a developer's tree): git pull;
 *   - split or separate mode: the gateway and frontend processes would keep the old code; each machine is
 *     updated with the CLI;
 *   - an install whose files this process cannot write (the code belongs to root, say): run
 *     `sudo npx create-wordjs@latest upgrade` on the server — it gives the files back to the site's owner;
 *   - no supervisor that would bring the new version up and roll a broken one back (core/restart mode is
 *     not `supervisor`): the screen asks for the command line instead.
 * The panel never installs a tag the official releases list does not contain, never one that publishes
 * no checksum for its bundle, and never a downgrade.
 */

const fs = require('fs');
const path = require('path');
const log = require('./module-logger').moduleLogger('core/updater');

export const REPO = 'jaimemartinez/wordjs';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const CACHE_MS = 6 * 60 * 60 * 1000;
const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOG_LINES = 200;

export type Release = { tag: string; version: string; name: string; publishedAt: string; notes: string; prerelease: boolean; url: string; hasBundle: boolean; hasChecksum: boolean };
export type UpdateState = {
    state: 'idle' | 'running' | 'applied' | 'done' | 'failed' | 'rolled_back';
    step?: 'backup' | 'download' | 'install' | 'restarting' | 'rollback';
    from?: string; fromTag?: string; to?: string; toTag?: string;
    at?: string; appliedAt?: string; finishedAt?: string;
    error?: string; backup?: string | null; actor?: number | null;
};

/** The installation's root: backend/ runs with its own directory as cwd (backend/server.js, monolith.js). */
function installRoot(): string {
    return path.resolve(process.cwd(), '..');
}
function stateFile(): string { return path.resolve('./data/update-state.json'); }

/** The upgrade CLI the installed release shipped. */
export function cliPath(root: string): string {
    return path.join(root, 'packages', 'create-wordjs', 'index.js');
}

function currentVersion(): string {
    try { return require('../config/product-version').resolveProductVersion(); } catch { return '0.0.0'; }
}

/** Semver compare of x.y.z[-pre] (a pre-release sorts below its release). */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) => {
        const [core, pre] = String(v).replace(/^v/, '').split('-', 2);
        return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre || '' };
    };
    const x = parse(a); const y = parse(b);
    for (let i = 0; i < 3; i++) if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) - (y.nums[i] || 0);
    if (x.pre === y.pre) return 0;
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return x.pre < y.pre ? -1 : 1;
}

// ── Where the panel may update ───────────────────────────────────────────────────────────────────────

export type Environment = { canUpdate: boolean; reason: null | 'docker' | 'source_checkout' | 'split_mode' | 'not_writable' | 'no_supervisor' | 'not_a_release'; how: string; root: string };

/** Injectable for tests. */
let probe = {
    exists: (p: string) => fs.existsSync(p),
    writable: (p: string) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } },
    restartMode: () => require('./restart').restartMode(),
    embedded: () => process.env.WORDJS_EMBEDDED === '1',
};

/**
 * Is this process in a container, and which kind? A container's code is its image: the panel must not
 * rewrite it in place (the next restart brings the old image back), so it says how to change the image.
 * Docker writes /.dockerenv and podman /run/.containerenv, but containerd and CRI-O (every Kubernetes
 * node today) write neither, so Kubernetes is read from the variable it gives every pod, and the image
 * and the Helm chart also set WORDJS_DOCKER=1.
 */
export function containerKind(env: NodeJS.ProcessEnv = process.env): 'kubernetes' | 'container' | null {
    if (env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
    if (env.WORDJS_DOCKER === '1' || probe.exists('/.dockerenv') || probe.exists('/run/.containerenv')) return 'container';
    return null;
}

function environment(): Environment {
    const root = installRoot();
    const sudoCmd = `sudo npx create-wordjs@latest upgrade ${root}`;
    const container = containerKind();
    if (container === 'kubernetes') {
        return { canUpdate: false, reason: 'docker', how: 'This site runs on Kubernetes: update the image tag of its release and let it roll out (helm upgrade <release> <chart> --reuse-values --set image.tag=<version>). Your data is in the persistent volume.', root };
    }
    if (container) {
        return { canUpdate: false, reason: 'docker', how: 'This site runs in a container: pull the new image tag and recreate the container (docker compose pull && docker compose up -d). Your data is in the volume.', root };
    }
    if (probe.exists(path.join(root, '.git'))) {
        return { canUpdate: false, reason: 'source_checkout', how: 'This is a source checkout: update it with git pull and rebuild.', root };
    }
    // Split and separate mode: the gateway and the frontend are other processes (or machines) that would
    // keep serving the old code. Each machine is updated with the CLI, which knows the layout.
    if (!probe.embedded()) {
        return { canUpdate: false, reason: 'split_mode', how: `This install runs the gateway, backend and frontend as separate processes. Update each machine from a terminal: ${sudoCmd}, then restart its services.`, root };
    }
    if (!probe.exists(path.join(root, 'package.json')) || !probe.exists(path.join(root, 'backend', 'package.json')) || !probe.exists(cliPath(root))) {
        return { canUpdate: false, reason: 'not_a_release', how: `The install root (${root}) does not look like a WordJS release. Update it from a terminal: ${sudoCmd}`, root };
    }
    const mustWrite = [root, path.join(root, 'package.json'), path.join(root, 'backend'), path.join(root, 'frontend')].filter((p) => probe.exists(p));
    if (!mustWrite.every((p) => probe.writable(p))) {
        return { canUpdate: false, reason: 'not_writable', how: `WordJS cannot write its own code here (the files belong to another account). Update it from a terminal on the server: ${sudoCmd}. It gives the files back to the site's owner.`, root };
    }
    if (probe.restartMode() !== 'supervisor') {
        return { canUpdate: false, reason: 'no_supervisor', how: `WordJS is not running under its own supervisor (npm start or the monolith), which starts the new version and rolls a broken one back. Update it from a terminal: ${sudoCmd}, then restart it.`, root };
    }
    return { canUpdate: true, reason: null, how: '', root };
}

// ── The releases ─────────────────────────────────────────────────────────────────────────────────────

let fetchJson = async (url: string): Promise<any> => {
    const https = require('https');
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'wordjs-updater', Accept: 'application/vnd.github+json' }, timeout: 8000 }, (res: any) => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`GitHub answered ${res.statusCode}`)); return; }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => { body += c; if (body.length > 4_000_000) req.destroy(new Error('response too large')); });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        // `timeout` is an idle timer; the whole read ends at 10 seconds whatever pace GitHub keeps, and
        // the socket goes with it (the caller's own 10-second race only stops waiting).
        const overall = setTimeout(() => req.destroy(new Error('GitHub did not answer within 10 seconds')), 10000);
        overall.unref?.();
        req.on('error', () => clearTimeout(overall));
    });
};

let cache: { at: number; releases: Release[] } | null = null;

function toRelease(r: any): Release | null {
    const tag = String(r && r.tag_name || '');
    if (!TAG_RE.test(tag) || r.draft) return null;
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const bundle = assets.find((a: any) => a && a.name === `wordjs-${tag}.zip`) || assets.find((a: any) => a && /^wordjs-.*\.zip$/.test(String(a.name)));
    return {
        tag, version: tag.slice(1), name: String(r.name || tag).slice(0, 200),
        publishedAt: String(r.published_at || ''), notes: String(r.body || '').slice(0, 20000),
        prerelease: r.prerelease === true, url: String(r.html_url || `https://github.com/${REPO}/releases/tag/${tag}`),
        hasBundle: !!bundle, hasChecksum: !!(bundle && assets.some((a: any) => a && a.name === `${bundle.name}.sha256`)),
    };
}

async function releases(opts: { force?: boolean } = {}): Promise<Release[]> {
    if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache.releases;
    // One deadline for the whole request: a host that never answers the TCP handshake (offline, a
    // firewall dropping packets) would otherwise hold the screen for the operating system's own timeout.
    let timer: any;
    const raw = await Promise.race([
        fetchJson(RELEASES_URL),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GitHub did not answer within 10 seconds')), 10000); }),
    ]).finally(() => clearTimeout(timer));
    const list = (Array.isArray(raw) ? raw : []).map(toRelease).filter(Boolean) as Release[];
    list.sort((a, b) => compareVersions(b.version, a.version));
    cache = { at: Date.now(), releases: list };
    return list;
}

/** What Admin → Updates shows: the version, the newer releases with their notes, and whether it may update. */
async function overview(opts: { force?: boolean } = {}) {
    const current = currentVersion();
    let list: Release[] = [];
    let error: string | null = null;
    try { list = await releases(opts); } catch (e: any) { error = `The releases could not be read (${(e && e.message) || e}).`; }
    const newer = list.filter((r) => !r.prerelease && r.hasBundle && compareVersions(r.version, current) > 0);
    return { current, latest: newer[0] || null, newer, environment: environment(), state: readState(), error, checkedAt: cache ? new Date(cache.at).toISOString() : null };
}

// ── The state on disk (read by the supervisor across restarts) ───────────────────────────────────────

function readState(): UpdateState {
    try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { state: 'idle' }; }
}
function writeState(s: UpdateState): void {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

// ── Running it ───────────────────────────────────────────────────────────────────────────────────────

const output: string[] = [];
function note(line: string) {
    for (const l of String(line).split(/\r?\n/)) {
        if (!l.trim()) continue;
        output.push(l.slice(0, 500));
        if (output.length > LOG_LINES) output.shift();
    }
}

/**
 * The arguments `node` runs for the update; the rollback is the same with the previous tag and --force.
 * An argument vector, never a command string: the install root may contain spaces or shell syntax.
 */
function upgradeArgs(root: string, tag: string, force = false): string[] {
    return [cliPath(root), 'upgrade', root, '--yes', '--version', tag, ...(force ? ['--force'] : [])];
}

let runner = (args: string[], cwd: string, onLine: (l: string) => void): Promise<number> => new Promise((resolve) => {
    const { spawn } = require('child_process');
    // This Node binary, no shell. The shipped CLI's one dependency (adm-zip) is the backend's own.
    const env = { ...process.env, NODE_PATH: path.join(cwd, 'backend', 'node_modules'), npm_config_update_notifier: 'false' };
    const child = spawn(process.execPath, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => onLine(b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => onLine(b.toString('utf8')));
    child.on('error', (e: any) => { onLine(`could not start the upgrade: ${e && e.message}`); resolve(127); });
    child.on('close', (code: number) => resolve(code === null ? 1 : code));
});

/** The real runner, kept for tests after `_setForTests` swaps `runner`. */
const defaultRunner = runner;

let running = false;

/**
 * Start the update to `tag` (validated against the official releases: newer than this version, with a
 * bundle). Returns at once; the work goes on in the background and Admin → Updates follows it.
 */
async function startUpdate(input: { tag: unknown; actorUserId: number | null; reauth?: string }): Promise<{ to: string }> {
    const env = environment();
    if (!env.canUpdate) throw Object.assign(new Error(env.how), { code: `update_${env.reason}`, status: 409 });
    if (running || readState().state === 'running') throw Object.assign(new Error('An update is already running.'), { code: 'update_busy', status: 409 });
    const tag = typeof input.tag === 'string' ? input.tag : '';
    if (!TAG_RE.test(tag)) throw Object.assign(new Error('Not a release tag.'), { code: 'update_invalid_tag', status: 400 });
    const current = currentVersion();
    const release = (await releases()).find((r) => r.tag === tag);
    if (!release || !release.hasBundle) throw Object.assign(new Error('That release is not one the WordJS project published with a bundle.'), { code: 'update_unknown_release', status: 400 });
    if (compareVersions(release.version, current) <= 0) throw Object.assign(new Error(`WordJS is already on ${current}; the panel does not install older versions.`), { code: 'update_not_newer', status: 409 });
    if (!release.hasChecksum) throw Object.assign(new Error(`Release ${tag} publishes no checksum for its bundle, so its download cannot be verified; the panel does not install it.`), { code: 'update_unverified_release', status: 409 });

    running = true;
    output.length = 0;
    const base: UpdateState = { state: 'running', step: 'backup', from: current, fromTag: `v${current}`, to: release.version, toTag: tag, at: new Date().toISOString(), actor: input.actorUserId };
    writeState(base);
    void (async () => {
        let backupName: string | null = null;
        try {
            note(`Backing up before updating ${current} → ${release.version}…`);
            try {
                const b = await require('./backup').createBackup();
                backupName = (b && (b.filename || b.name)) || null;
                note(`Backup ${backupName || 'created'}.`);
            } catch (e: any) {
                throw Object.assign(new Error(`The backup failed, so nothing was changed (${(e && e.message) || e}).`), { noRollback: true });
            }
            writeState({ ...base, step: 'download', backup: backupName });
            const code = await runner(upgradeArgs(env.root, tag), env.root, (l) => {
                note(l);
                if (/Syncing runtime dependencies/i.test(l)) writeState({ ...base, step: 'install', backup: backupName });
            });
            if (code !== 0) throw new Error(`The update stopped (exit code ${code}).`);
            writeState({ ...base, state: 'applied', step: 'restarting', backup: backupName, appliedAt: new Date().toISOString() });
            note(`Updated to ${release.version}. Restarting…`);
            require('./restart').scheduleRestart(`updated WordJS to ${release.version}`, { delayMs: 1500 });
        } catch (e: any) {
            const message = String((e && e.message) || e);
            note(message);
            log.error(`[updater] ${message}`);
            if (e && e.noRollback) {
                writeState({ ...base, state: 'failed', step: undefined, error: message, backup: backupName, finishedAt: new Date().toISOString() });
            } else {
                writeState({ ...base, state: 'failed', step: 'rollback', error: message, backup: backupName });
                note(`Putting ${current} back…`);
                const back = await runner(upgradeArgs(env.root, `v${current}`, true), env.root, note);
                writeState({ ...base, state: back === 0 ? 'rolled_back' : 'failed', step: undefined, error: back === 0 ? message : `${message} The previous version could not be put back either (exit code ${back}); restore it from the backup ${backupName || ''} or run the update from a terminal.`, backup: backupName, finishedAt: new Date().toISOString() });
                if (back === 0) require('./restart').scheduleRestart(`update to ${release.version} failed; ${current} put back`, { delayMs: 1500 });
            }
        } finally {
            running = false;
        }
    })();
    try { await require('./audit').recordAudit(input.actorUserId, 'system.update.start', 'system', tag, { from: current, to: release.version, reauth: input.reauth || null }); } catch { /* recordAudit never throws */ }
    return { to: release.version };
}

/** Boot: an update that was applied and brought this process up is done. */
function markBootCompleted(): void {
    const s = readState();
    if (s.state !== 'applied') return;
    const ok = compareVersions(currentVersion(), s.to || '0.0.0') === 0;
    writeState({ ...s, state: ok ? 'done' : 'failed', step: undefined, finishedAt: new Date().toISOString(), ...(ok ? {} : { error: `Expected ${s.to} after the update, found ${currentVersion()}.` }) });
    log.info(ok ? `[updater] WordJS ${s.to} is up (updated from ${s.from}).` : `[updater] the update to ${s.to} did not take effect.`);
}

function status() {
    return { state: readState(), output: [...output], running };
}

/** Tests: swap the network, the process runner and the environment probes. */
function _setForTests(o: { fetchJson?: typeof fetchJson; runner?: typeof runner; probe?: Partial<typeof probe> }) {
    if (o.fetchJson) fetchJson = o.fetchJson;
    if (o.runner) runner = o.runner;
    if (o.probe) probe = { ...probe, ...o.probe };
    cache = null;
}

module.exports = { REPO, compareVersions, containerKind, environment, releases, overview, startUpdate, markBootCompleted, status, upgradeArgs, cliPath, readState, _setForTests, _defaultRunner: defaultRunner };
