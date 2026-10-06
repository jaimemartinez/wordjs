/**
 * WordJS — core/configManager writes THROUGH a symlinked wordjs-config.json, never over the link.
 *
 * docker/entrypoint.sh (Docker, compose, Helm) makes backend/wordjs-config.json a symlink into the data
 * volume — dangling on the first boot — so the install state survives a re-created container. The atomic
 * writer (temp file + rename) used to rename over the LINK: the install, every site-address change and
 * the CLI's writes landed in the container layer, the volume copy stayed absent or stale, and the next
 * image upgrade or pod restart came back in setup mode over a populated database.
 *
 * Two halves:
 *   · REAL symlinks (an existing target, absolute; a dangling one, relative — the entrypoint's first
 *     boot). Skipped only where the platform will not create a symlink (Windows without the privilege);
 *     CI runs them on Linux.
 *   · The same two shapes SIMULATED by answering realpath/readlink for the config path, so the
 *     write-through is proven on every platform — including the one that cannot create the link.
 *
 * MUTATION PROOF: make writeFileAtomic rename over `target` again instead of the resolved target — every
 * test below fails (the link is replaced by a regular file; the volume copy keeps the old bytes).
 */

const { describe, test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-config-symlink-${process.pid}-`));
process.chdir(TMP);
const configManager = require('../core/configManager');
const CONFIG_FILE: string = configManager.CONFIG_FILE;
const DATA_DIR = path.join(TMP, 'data');
const PERSISTED = path.join(DATA_DIR, 'wordjs-config.json');

after(() => {
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

function reset() {
    fs.rmSync(CONFIG_FILE, { force: true });
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR);
    configManager.invalidateConfigCache();
}

const leftovers = () => [...fs.readdirSync(TMP), ...fs.readdirSync(DATA_DIR)].filter((n: string) => n.endsWith('.tmp'));
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
/** saveConfig's merge, without refreshing config/app (which would load the real install's config). */
const save = (keys: Record<string, unknown>) => configManager.updateConfig((c: any) => ({ ...c, ...keys }), { reload: false }).ok;

/** Can this process create a symlink here? (Windows needs a privilege or developer mode.) */
function symlinksWork(): boolean {
    const probe = path.join(TMP, 'probe-link');
    try {
        fs.symlinkSync(path.join(TMP, 'probe-target'), probe, 'file');
        fs.rmSync(probe, { force: true });
        return true;
    } catch {
        return false;
    }
}

describe('a REAL symlinked config (the container entrypoint\'s layout)', () => {
    const can = symlinksWork();
    beforeEach(reset);

    test('an existing target: the link stays a link, the target in the volume receives the write', { skip: !can && 'this platform cannot create symlinks here' }, () => {
        fs.writeFileSync(PERSISTED, JSON.stringify({ jwtSecret: 'keep-me' }));
        fs.symlinkSync(PERSISTED, CONFIG_FILE, 'file');
        assert.strictEqual(save({ installedAt: '2026-10-06T00:00:00.000Z', dbDriver: 'sqlite-native' }), true);
        assert.ok(fs.lstatSync(CONFIG_FILE).isSymbolicLink(), 'the symlink was replaced by a regular file');
        const stored = read(PERSISTED);
        assert.strictEqual(stored.jwtSecret, 'keep-me');
        assert.strictEqual(stored.dbDriver, 'sqlite-native');
        assert.deepStrictEqual(configManager.getConfig(), stored, 'reading through the link sees the write');
        assert.strictEqual(configManager.isInstalled(), true);
        assert.deepStrictEqual(leftovers(), []);
    });

    test('a dangling link (first boot): the write creates the target and keeps the link', { skip: !can && 'this platform cannot create symlinks here' }, () => {
        fs.symlinkSync(path.join('data', 'wordjs-config.json'), CONFIG_FILE, 'file');
        assert.strictEqual(configManager.isInstalled(), false, 'a dangling link reads as "no config"');
        assert.strictEqual(save({ installedAt: '2026-10-06T00:00:00.000Z' }), true);
        assert.ok(fs.lstatSync(CONFIG_FILE).isSymbolicLink());
        assert.strictEqual(read(PERSISTED).installedAt, '2026-10-06T00:00:00.000Z');
        assert.strictEqual(configManager.isInstalled(), true);
        assert.deepStrictEqual(leftovers(), []);
    });

    test('compare-and-swap and rollback act on the target too', { skip: !can && 'this platform cannot create symlinks here' }, () => {
        fs.writeFileSync(PERSISTED, JSON.stringify({ siteAddress: { rev: 2 } }));
        fs.symlinkSync(PERSISTED, CONFIG_FILE, 'file');
        const written = configManager.updateConfig((c: any) => ({ ...c, siteUrl: 'https://example.com', siteAddress: { rev: 3 } }), { expectRev: 2, reload: false });
        assert.ok(written.ok);
        assert.strictEqual(configManager.updateConfig((c: any) => c, { expectRev: 2, reload: false }).reason, 'stale');
        assert.strictEqual(configManager.restoreConfigText(written.previousText, { expectRev: 3, reload: false }), true);
        assert.ok(fs.lstatSync(CONFIG_FILE).isSymbolicLink());
        assert.deepStrictEqual(read(PERSISTED), { siteAddress: { rev: 2 } });
    });
});

describe('the same layouts, simulated (proves the write-through where symlinks cannot be created)', () => {
    beforeEach(reset);

    /** Answer realpath / readlink for the config path as the kernel would for a link to PERSISTED. */
    function asLink(kind: 'existing' | 'dangling', fn: () => void) {
        const realpath = fs.realpathSync;
        const readlink = fs.readlinkSync;
        const isConfig = (p: unknown) => typeof p === 'string' && path.resolve(p) === CONFIG_FILE;
        const fakeRealpath: any = (p: any, ...rest: any[]) => {
            if (isConfig(p)) {
                if (kind === 'existing') return PERSISTED;
                throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), { code: 'ENOENT' });
            }
            return realpath(p, ...rest);
        };
        fakeRealpath.native = realpath.native;
        fs.realpathSync = fakeRealpath;
        fs.readlinkSync = (p: any, ...rest: any[]) => (isConfig(p) ? path.join('data', 'wordjs-config.json') : readlink(p, ...rest));
        try {
            fn();
        } finally {
            fs.realpathSync = realpath;
            fs.readlinkSync = readlink;
        }
    }

    test('an existing target receives the write; the path standing in for the link is not replaced', () => {
        const before = JSON.stringify({ jwtSecret: 'keep-me' });
        fs.writeFileSync(PERSISTED, before);
        fs.writeFileSync(CONFIG_FILE, before); // what reading through the link shows
        asLink('existing', () => {
            assert.strictEqual(save({ dbDriver: 'sqlite-native' }), true);
        });
        assert.strictEqual(read(PERSISTED).dbDriver, 'sqlite-native', 'the volume copy received the write');
        assert.strictEqual(read(PERSISTED).jwtSecret, 'keep-me');
        assert.strictEqual(fs.readFileSync(CONFIG_FILE, 'utf8'), before, 'nothing was renamed over the link');
        assert.deepStrictEqual(leftovers(), []);
    });

    test('a dangling link: the target is created next to where the link points; no regular file appears at the link', () => {
        asLink('dangling', () => {
            assert.strictEqual(save({ installedAt: '2026-10-06T00:00:00.000Z' }), true);
        });
        assert.strictEqual(read(PERSISTED).installedAt, '2026-10-06T00:00:00.000Z');
        assert.strictEqual(fs.existsSync(CONFIG_FILE), false, 'the link path was not turned into a regular file');
        assert.deepStrictEqual(leftovers(), []);
    });

    test('no link at all: the file is written where it was asked, atomically', () => {
        assert.strictEqual(save({ installedAt: '2026-10-06T00:00:00.000Z' }), true);
        assert.strictEqual(read(CONFIG_FILE).installedAt, '2026-10-06T00:00:00.000Z');
        assert.strictEqual(fs.existsSync(PERSISTED), false);
        assert.deepStrictEqual(leftovers(), []);
    });
});
