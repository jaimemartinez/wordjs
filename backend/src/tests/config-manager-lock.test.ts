/**
 * WordJS — core/configManager: ONE WRITER AT A TIME, across processes (review PL-4).
 *
 * updateConfig's compare-and-swap re-read the file, compared it with what the caller decided on, and
 * renamed the replacement over it: three system calls, and on Windows a sharing-violation retry of up to
 * a few hundred milliseconds between the compare and the swap. Two processes writing the file (the
 * backend and `npm run site`, or two CLI runs) could both compare against the same bytes and both
 * rename — both reported the same revision as saved, and one change was simply gone (never applied,
 * never audited). Measured before the fix: 4 processes × 60 writes reported 84 successes for 49 new
 * revisions.
 *
 * The read, the check and the rename now run under a lock file beside the config. These tests drive the
 * REAL module from several real processes, and pin how an abandoned lock is broken and a live one is not.
 *
 * MUTATION PROOF: make withConfigLock call `fn` without taking the lock — the first test fails
 * (successes outnumber revisions, and a revision is reported twice).
 */

const { describe, test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ORIGINAL_CWD = process.cwd();
const BACKEND = path.resolve(__dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-config-lock-${process.pid}-`));
process.chdir(TMP);
const configManager = require('../core/configManager');
const CONFIG_FILE: string = configManager.CONFIG_FILE;
const LOCK = `${CONFIG_FILE}.lock`;

after(() => {
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

function reset() {
    fs.rmSync(LOCK, { force: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ installedAt: '2026-10-06T00:00:00.000Z', siteAddress: { rev: 1 }, writes: [] }, null, 2));
    configManager.invalidateConfigCache();
}

const read = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

/** One compare-and-swap, as site-address commits and the CLI make them: the next revision, expected to be the current one + 1. */
function bump(tag: string) {
    const rev = configManager.siteAddressRev(configManager.readConfigFresh().parsed);
    return configManager.updateConfig((c: any) => ({ ...c, siteAddress: { ...c.siteAddress, rev: rev + 1 }, writes: [...c.writes, tag] }), { expectRev: rev, reload: false });
}

/** A process that exits at once: a pid that certainly belonged to nobody alive any more. */
function deadPid(): number {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    return Number(r.stdout);
}

describe('several processes writing the config at once', () => {
    beforeEach(reset);

    test('every write reported as saved is in the file, under a revision nobody else reported', async () => {
        const WRITERS = 4;
        const WRITES = 40;
        const child = path.join(TMP, 'writer.js');
        fs.writeFileSync(child, `
            process.chdir(${JSON.stringify(TMP)});
            require(${JSON.stringify(require.resolve('ts-node', { paths: [BACKEND] }))}).register({ transpileOnly: true, project: ${JSON.stringify(path.join(BACKEND, 'tsconfig.json'))} });
            const cm = require(${JSON.stringify(path.join(BACKEND, 'src', 'core', 'configManager'))});
            const id = process.argv[2];
            const saved = [];
            for (let i = 0; i < ${WRITES}; i++) {
                const rev = cm.siteAddressRev(cm.readConfigFresh().parsed);
                const w = cm.updateConfig((c) => ({ ...c, siteAddress: { ...c.siteAddress, rev: rev + 1 }, writes: [...c.writes, id + ':' + i] }), { expectRev: rev, reload: false });
                if (w.ok) saved.push({ rev: rev + 1, tag: id + ':' + i });
            }
            process.stdout.write(JSON.stringify(saved));
        `);
        const runs = await Promise.all(Array.from({ length: WRITERS }, (_, i) => new Promise<Array<{ rev: number; tag: string }>>((resolve, reject) => {
            const p = spawn(process.execPath, [child, `w${i}`], { cwd: TMP });
            let out = '';
            let err = '';
            p.stdout.on('data', (d: Buffer) => { out += d; });
            p.stderr.on('data', (d: Buffer) => { err += d; });
            p.on('exit', (code: number) => {
                try { resolve(JSON.parse(out)); } catch { reject(new Error(`writer ${i} exited ${code}: ${err || out}`)); }
            });
        })));
        const saved = runs.flat();
        const stored = read();
        const revs = saved.map((s) => s.rev);
        assert.ok(saved.length > 0, 'the writers saved something');
        assert.strictEqual(new Set(revs).size, revs.length, `a revision was reported as saved twice: ${revs.filter((r, i) => revs.indexOf(r) !== i).join(', ')}`);
        assert.strictEqual(stored.siteAddress.rev - 1, saved.length, 'one new revision per reported save');
        assert.deepStrictEqual([...stored.writes].sort(), saved.map((s) => s.tag).sort(), 'every reported save is in the file, and nothing else');
        assert.ok(!fs.existsSync(LOCK), 'the lock is released');
    });
});

describe('the lock itself', () => {
    beforeEach(reset);

    test('is released after a write, and a write under no contention never waits', () => {
        const started = Date.now();
        assert.strictEqual(bump('a').ok, true);
        assert.ok(Date.now() - started < 1000);
        assert.ok(!fs.existsSync(LOCK));
        assert.deepStrictEqual(read().writes, ['a']);
    });

    test('a lock left by a process that died holding it is broken', () => {
        fs.writeFileSync(LOCK, JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }));
        assert.strictEqual(bump('after-crash').ok, true);
        assert.deepStrictEqual(read().writes, ['after-crash']);
        assert.ok(!fs.existsSync(LOCK));
    });

    test('a lock older than any write takes is broken, whoever holds it', () => {
        fs.writeFileSync(LOCK, JSON.stringify({ pid: process.ppid, at: '2026-01-01T00:00:00.000Z' }));
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(LOCK, old, old);
        assert.strictEqual(bump('after-stale').ok, true);
        assert.deepStrictEqual(read().writes, ['after-stale']);
    });

    test('a live writer\'s lock is waited for: it is broken only once it is older than any write takes', () => {
        const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
        try {
            fs.writeFileSync(LOCK, JSON.stringify({ pid: holder.pid, at: new Date().toISOString() }));
            const started = Date.now();
            assert.strictEqual(bump('waited').ok, true);
            assert.ok(Date.now() - started >= 4500, `the write waited for the live lock (${Date.now() - started} ms)`);
            assert.deepStrictEqual(read().writes, ['waited']);
            // A rollback takes the same lock.
            fs.writeFileSync(LOCK, JSON.stringify({ pid: holder.pid, at: new Date().toISOString() }));
            const restoreStarted = Date.now();
            configManager.restoreConfigText(JSON.stringify({ installedAt: '2026-10-06T00:00:00.000Z', siteAddress: { rev: 1 }, writes: [] }), { expectRev: 2, reload: false });
            assert.ok(Date.now() - restoreStarted >= 4500, 'the rollback waited too');
            assert.deepStrictEqual(read().writes, []);
        } finally {
            holder.kill();
            fs.rmSync(LOCK, { force: true });
        }
    });
});
