/**
 * WordJS — THE SITE'S ADDRESSES OUTSIDE THE ADMIN SCREEN: boot, the gateway, the CLI, the file itself.
 *
 * core/site-address.ts reconciles wordjs-config.json (the master) with the siteurl / home / site_address_rev
 * mirrors at boot, decides what to do when the gateway reports another address, and applies changes the
 * `npm run site` CLI wrote while the server ran or was stopped. core/configManager.ts writes the file
 * atomically. None of these paths has a request, so they are exercised here directly, against a staged
 * config in a temp directory (chdir'd into before any module loads) and a throwaway database.
 *
 * By amendment (REDTEAM.md):
 *   R1   the same host moving http → https is applied automatically (audited); nothing else is
 *   R5   the salvage of `https,http://host` never downgrades: https if any element is https, else a conflict
 *   R10  the writer never replaces an unreadable file, compare-and-swaps on the revision, keeps no temp
 *        files, and a CLI change is never rolled back
 * and SPEC §7: a legacy install is upgraded without changing what it links to, and a disagreement between
 * the file and the database is shown, never auto-resolved. From the 3-mode lab: every revision the CLI
 * wrote gets its own audit row, however quickly they came (M-16), `--force` included — also when a commit
 * overtakes it, committed with the revision (review PL-1/PL-2), with one notice per batch; either
 * address resolves an upgrade conflict, the config's own too; a fresh install records itself (M-03).
 *
 * MUTATION PROOF (each applied to the source, watched to fail, restored): audit only the last revision;
 * keep no change log; leave the gap unaudited; stop the CLI recording --force; make the config's own
 * address a no-op again; end a conflict only when the link base moved; record the install as the upgrade;
 * count bookkeeping records as changes; let a commit ignore a pending CLI revision; mark the pre-commit
 * revision applied on a rollback; audit after the pushes, or outside the mirrors' transaction; drop the
 * lastChange fallback; merge gaps into one span; notify per revision; wait on the mail server.
 */

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-site-reconcile-${process.pid}-`));
const CONFIG_FILE = path.join(TMP_INSTALL, 'wordjs-config.json');
const BASE = {
    installedAt: '2026-01-01T00:00:00.000Z',
    dbDriver: 'sqlite-native',
    siteUrl: 'https://example.com',
    revalidateSecret: 'reconcile-test-secret',
};
fs.writeFileSync(CONFIG_FILE, JSON.stringify(BASE, null, 2));
process.chdir(TMP_INSTALL);
const SAVED_MODE = process.env.WORDJS_MODE;
delete process.env.WORDJS_MODE;

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-site-reconcile-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.nodeEnv = 'production';

const configManager = require('../core/configManager');
const hostPolicy = require('../core/host-policy');
const siteAddress = require('../core/site-address');
const options = require('../core/options');
const database = require('../config/database');
const { siteHostPolicy } = require('../middleware/auth');

const purges: unknown[] = [];
require('../core/frontend-purge').purgeFrontend = (...args: unknown[]) => { purges.push(args); };

let db: any;
let adminId = 0;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await require('../core/roles').loadRoles();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('root', ?, 'root@example.com', 'root')`, [bcrypt.hashSync('x-password-123', 4)]);
    adminId = r.lastID;
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
});

after(async () => {
    siteAddress.stopWatching();
    try { await database.closeDatabase(); } catch { /* closed */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    if (SAVED_MODE === undefined) delete process.env.WORDJS_MODE; else process.env.WORDJS_MODE = SAVED_MODE;
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────

async function setOption(name: string, value: string | null) {
    if (value === null) {
        await db.run('DELETE FROM options WHERE option_name = ?', [name]);
        await require('../core/cache').del(`option:${name}`);
    } else {
        await options.updateOption(name, value);
    }
}

async function option(name: string) {
    const row = await db.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
    return row ? row.option_value : null;
}

/** Stage a file and the three mirrors exactly; null removes a mirror. */
async function world(file: Record<string, unknown> | string, mirrors: { siteurl?: string | null; home?: string | null; rev?: string | null } = {}) {
    fs.writeFileSync(CONFIG_FILE, typeof file === 'string' ? file : JSON.stringify(file, null, 2));
    configManager.invalidateConfigCache();
    await setOption('siteurl', mirrors.siteurl === undefined ? null : mirrors.siteurl);
    await setOption('home', mirrors.home === undefined ? null : mirrors.home);
    await setOption('site_address_rev', mirrors.rev === undefined ? null : mirrors.rev);
    await db.run("DELETE FROM audit_log WHERE action LIKE 'site.address.%'");
    await db.run('DELETE FROM notifications');
    purges.length = 0;
}

const fileText = () => fs.readFileSync(CONFIG_FILE, 'utf8');
const fileConfig = () => JSON.parse(fileText());
async function audits() {
    const rows = await db.all("SELECT action, actor_id, detail FROM audit_log WHERE action LIKE 'site.address.%' ORDER BY id");
    return rows.map((r: any) => ({ action: r.action, actor: r.actor_id, detail: JSON.parse(r.detail) }));
}

// ─── SPEC §7: the legacy upgrade ───────────────────────────────────────────────────────────────────

describe('reconcileAtBoot — a legacy install (no siteAddress key)', () => {
    test('the database names the same address → revision 1, and NOTHING the site links to changes', async () => {
        // An older split install stores the frontend's own origin in `home`; the upgrade must not touch it.
        await world(BASE, { siteurl: 'https://example.com/', home: 'http://localhost:3001' });
        const { state } = await siteAddress.reconcileAtBoot();
        assert.strictEqual(state, 'upgraded');
        assert.strictEqual(fileConfig().siteAddress.rev, 1);
        assert.strictEqual(fileConfig().siteUrl, 'https://example.com');
        assert.strictEqual(await option('site_address_rev'), '1');
        assert.strictEqual(await option('siteurl'), 'https://example.com/', 'the mirror is left exactly as it was');
        assert.strictEqual(await option('home'), 'http://localhost:3001');
        assert.deepStrictEqual(await audits(), [], 'an upgrade that changes no address is not an address change');
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok', 'idempotent');
    });

    test('the database has no siteurl → the mirrors are written, revision 1', async () => {
        await world(BASE);
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'mirrored');
        assert.strictEqual(await option('siteurl'), 'https://example.com');
        assert.strictEqual(await option('home'), 'https://example.com');
        assert.strictEqual(await option('site_address_rev'), '1');
    });

    test('the file and the database DISAGREE → a conflict: zero writes, gate on the file, links on the database', async () => {
        await world(BASE, { siteurl: 'https://old.example', home: 'https://old.example' });
        const before = fileText();
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'conflict');
        assert.strictEqual(fileText(), before, 'the file is not touched');
        assert.strictEqual(await option('siteurl'), 'https://old.example', 'nor the database');
        assert.strictEqual(await option('site_address_rev'), null);
        // Exactly today's behaviour while it lasts: the gate answers the config's host, links use the DB.
        assert.strictEqual(siteHostPolicy.get().canonical.hostname, 'example.com');
        assert.strictEqual(hostPolicy.classify(hostPolicy.parseHost('old.example'), siteHostPolicy.get()).cls, 'unknown',
            'the conflicting database value is NOT promoted to an accepted address (no silent widening)');
        assert.strictEqual(await siteAddress.linkBase(), 'https://old.example');
        const state = await siteAddress.describeState(null);
        assert.deepStrictEqual(state.conflict, { config: 'https://example.com', db: 'https://old.example' });

        // An administrator resolves it by choosing; the resolution is on the record.
        const result = await siteAddress.commit((cfg: any) => siteAddress.planCanonical(cfg, { url: 'https://example.com:8443', via: 'ui', actorId: adminId, now: Date.now() }),
            { expectRev: 0, via: 'ui', actorId: adminId });
        assert.strictEqual(result.rev, 1);
        assert.strictEqual(await option('siteurl'), 'https://example.com:8443');
        assert.strictEqual((await siteAddress.describeState(null)).conflict, null);
        assert.deepStrictEqual((await audits()).map((a: any) => a.action), ['site.address.canonical', 'site.address.conflict_resolved']);
    });

    test('any other invalid siteUrl is reported and left alone', async () => {
        await world({ ...BASE, siteUrl: 'not a url' }, { siteurl: 'https://example.com' });
        const before = fileText();
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'invalid');
        assert.strictEqual(fileText(), before);
    });
});

// ─── R5: the /migrate salvage never downgrades ─────────────────────────────────────────────────────

describe('R5 — the salvage of `<scheme list>://host`', () => {
    test('`https,http://example.com` (TLS proxy in front of http-proxy) → https, audited as a repair', async () => {
        await world({ ...BASE, siteUrl: 'https,http://example.com' }, { siteurl: 'https,http://example.com', home: 'https,http://example.com' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'repaired');
        assert.strictEqual(fileConfig().siteUrl, 'https://example.com', 'the FIRST element is the real edge; never the gateway\'s http');
        assert.strictEqual(await option('siteurl'), 'https://example.com');
        const [row] = await audits();
        assert.deepStrictEqual({ action: row.action, actor: row.actor, to: row.detail.to, reason: row.detail.reason },
            { action: 'site.address.repair', actor: null, to: 'https://example.com', reason: 'scheme-list' });
    });

    test('`http,https://example.com` → https as well (any https wins)', async () => {
        await world({ ...BASE, siteUrl: 'http,https://example.com' }, { siteurl: 'http,https://example.com' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'repaired');
        assert.strictEqual(fileConfig().siteUrl, 'https://example.com');
    });

    test('`http,http://example.com` → no guess: a conflict, nothing written', async () => {
        await world({ ...BASE, siteUrl: 'http,http://example.com' }, { siteurl: 'http,http://example.com' });
        const before = fileText();
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'conflict');
        assert.strictEqual(fileText(), before);
        assert.strictEqual(await option('siteurl'), 'http,http://example.com');
    });

    test('the database naming ANOTHER valid address → a conflict, not a repair', async () => {
        await world({ ...BASE, siteUrl: 'https,http://example.com' }, { siteurl: 'https://elsewhere.example' });
        const before = fileText();
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'conflict');
        assert.strictEqual(fileText(), before);
    });

    test('salvageSiteUrl itself', () => {
        assert.strictEqual(siteAddress.salvageSiteUrl('https, http://Example.com:8443').origin, 'https://example.com:8443');
        assert.strictEqual(siteAddress.salvageSiteUrl('http,http://example.com'), null);
        assert.strictEqual(siteAddress.salvageSiteUrl('https://example.com'), null, 'not a scheme list');
        assert.strictEqual(siteAddress.salvageSiteUrl('https,http://a@b.example'), null, 'the rest must still be a site address');
    });
});

// ─── R1: what the gateway reports ──────────────────────────────────────────────────────────────────

describe('R1 — noteGatewaySiteUrl', () => {
    test('same host, http → https (with a port change) is applied and audited; the gateway is not echoed', async () => {
        await world({ ...BASE, siteUrl: 'http://example.com:3000', gatewayUrl: 'http://example.com:3000', siteAddress: { rev: 2 } }, { siteurl: 'http://example.com:3000', rev: '2' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        const out = await siteAddress.noteGatewaySiteUrl('https://example.com:3443');
        assert.strictEqual(out.outcome, 'upgraded');
        const cfg = fileConfig();
        assert.strictEqual(cfg.siteUrl, 'https://example.com:3443');
        assert.strictEqual(cfg.gatewayUrl, 'https://example.com:3443', 'R3 applies to the automatic move too');
        assert.strictEqual(cfg.siteAddress.rev, 3);
        assert.strictEqual(await option('siteurl'), 'https://example.com:3443');
        const [row] = await audits();
        assert.deepStrictEqual({ action: row.action, via: row.detail.via, reason: row.detail.reason }, { action: 'site.address.repair', via: 'gateway', reason: 'gateway-https' });
        assert.strictEqual(await siteAddress.linkBase(), 'https://example.com:3443', 'reset links are https from now on');
    });

    test('a downgrade, or another host, is DRIFT: reported, nothing written', async () => {
        for (const reported of ['http://example.com', 'https://other.example', 'http://other.example']) {
            await world({ ...BASE, siteAddress: { rev: 1 } }, { siteurl: 'https://example.com', rev: '1' });
            assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
            const before = fileText();
            const out = await siteAddress.noteGatewaySiteUrl(reported);
            assert.strictEqual(out.outcome, 'drift', reported);
            assert.strictEqual(fileText(), before, `${reported}: the file is untouched`);
            assert.strictEqual(await option('siteurl'), 'https://example.com');
            assert.deepStrictEqual((await siteAddress.describeState(null)).gatewayDrift, { gateway: hostPolicy.parseSiteUrl(reported).origin, config: 'https://example.com' });
        }
        assert.strictEqual((await siteAddress.noteGatewaySiteUrl('https://example.com')).outcome, 'in-sync');
        assert.strictEqual((await siteAddress.describeState(null)).gatewayDrift, null, 'agreement clears the drift');
        assert.strictEqual((await siteAddress.noteGatewaySiteUrl('garbage')).outcome, 'ignored');
    });

    test('during an unresolved conflict even an upgrade is only reported', async () => {
        await world({ ...BASE, siteUrl: 'http://example.com' }, { siteurl: 'http://old.example' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'conflict');
        const before = fileText();
        assert.strictEqual((await siteAddress.noteGatewaySiteUrl('https://example.com')).outcome, 'drift');
        assert.strictEqual(fileText(), before);
    });

    test('isAutomaticUpgrade is exactly "same host, http → https"', () => {
        const p = (u: string) => hostPolicy.parseSiteUrl(u);
        assert.strictEqual(siteAddress.isAutomaticUpgrade(p('http://a.example'), p('https://a.example:8443')), true);
        assert.strictEqual(siteAddress.isAutomaticUpgrade(p('https://a.example'), p('http://a.example')), false);
        assert.strictEqual(siteAddress.isAutomaticUpgrade(p('http://a.example'), p('https://b.example')), false);
        assert.strictEqual(siteAddress.isAutomaticUpgrade(p('http://a.example'), p('http://a.example:8080')), false);
    });
});

// ─── changes made outside the server (the CLI) ─────────────────────────────────────────────────────

/** What `npm run site` does: plan, then write the FILE only (revision + 1, via cli). */
function cliWrite(planner: (cfg: any) => any) {
    const fresh = configManager.readConfigFresh().parsed;
    const plan = planner(fresh);
    const result = configManager.updateConfig((current: any) => siteAddress.applyPlan(current, plan, { via: 'cli', actorId: null, now: Date.now() }),
        { expectRev: configManager.siteAddressRev(fresh), reload: false });
    assert.ok(result.ok, JSON.stringify(result));
}

describe('a change written by the CLI is applied by the running server', () => {
    test('at boot: a revision the database has not seen is applied — mirrors, audit (via cli), notification', async () => {
        await world({ ...BASE, siteAddress: { rev: 4 } }, { siteurl: 'https://example.com', home: 'https://example.com', rev: '4' });
        cliWrite((cfg) => siteAddress.planCanonical(cfg, { url: 'https://moved.example', via: 'cli', now: Date.now() }));
        assert.strictEqual(await option('siteurl'), 'https://example.com', 'the CLI never touches the database');
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'applied');
        assert.strictEqual(await option('siteurl'), 'https://moved.example');
        assert.strictEqual(await option('site_address_rev'), '5');
        const [row] = await audits();
        assert.deepStrictEqual({ action: row.action, actor: row.actor, via: row.detail.via, from: row.detail.from, to: row.detail.to },
            { action: 'site.address.canonical', actor: null, via: 'cli', from: 'https://example.com', to: 'https://moved.example' });
        const notes = await db.all('SELECT user_id, message FROM notifications');
        assert.deepStrictEqual(notes.map((n: any) => n.user_id), [adminId]);
        assert.match(notes[0].message, /command line/);
        assert.ok(purges.length > 0, 'the frontend caches are purged');
    });

    test('while running: the watcher tick applies the new revision once', async () => {
        await world({ ...BASE, siteAliases: [{ url: 'https://www.example.com' }], siteAddress: { rev: 7 } }, { siteurl: 'https://example.com', rev: '7' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        assert.strictEqual(await siteAddress.checkExternalChange(), 'unchanged');
        cliWrite((cfg) => siteAddress.planAliases(cfg, { aliases: [], via: 'cli', now: Date.now() }));
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied');
        assert.strictEqual(await option('site_address_rev'), '8');
        assert.deepStrictEqual((await audits()).map((a: any) => [a.action, a.detail.via, a.detail.removed]), [['site.address.aliases', 'cli', ['www.example.com']]]);
        assert.strictEqual(await siteAddress.checkExternalChange(), 'unchanged', 'applied exactly once');
        assert.strictEqual(hostPolicy.classify(hostPolicy.parseHost('www.example.com'), siteHostPolicy.get()).cls, 'unknown', 'the gate follows');
    });

    test('the watcher picks it up on its own', async () => {
        await world({ ...BASE, siteAddress: { rev: 1 } }, { siteurl: 'https://example.com', rev: '1' });
        await siteAddress.reconcileAtBoot();
        siteAddress.startWatching(25);
        try {
            cliWrite((cfg) => siteAddress.planPolicy(cfg, { ipLiterals: 'own' }));
            const deadline = Date.now() + 5000;
            while (await option('site_address_rev') !== '2' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
            assert.strictEqual(await option('site_address_rev'), '2');
        } finally {
            siteAddress.stopWatching();
        }
    });

    test('a file OLDER than the database (a restored backup) is never applied over it', async () => {
        await world({ ...BASE, siteUrl: 'https://stale.example', siteAddress: { rev: 3 } }, { siteurl: 'https://example.com', rev: '6' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'config-behind');
        assert.strictEqual(await option('siteurl'), 'https://example.com');
        assert.deepStrictEqual(await audits(), []);
    });

    test('R10: a CLI change is never rolled back — a database failure leaves the file and retries', async () => {
        await world({ ...BASE, siteAddress: { rev: 1 } }, { siteurl: 'https://example.com', rev: '1' });
        await siteAddress.reconcileAtBoot();
        cliWrite((cfg) => siteAddress.planCanonical(cfg, { url: 'https://cli.example', via: 'cli', now: Date.now() }));
        const written = fileText();
        const real = options.updateOption;
        options.updateOption = async () => { throw new Error('database down (simulated)'); };
        try {
            await assert.rejects(() => siteAddress.checkExternalChange(), /database down/);
        } finally {
            options.updateOption = real;
        }
        assert.strictEqual(fileText(), written, 'the operator\'s change at the server stands');
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied', 'and the next tick applies it');
        assert.strictEqual(await option('siteurl'), 'https://cli.example');
    });
});

// ─── lab finding M-16: every revision the CLI wrote is on the record ──────────────────────────────

describe('every revision the CLI wrote is audited and announced, however quickly they came (lab M-16)', () => {
    const notes = async () => (await db.all('SELECT message FROM notifications ORDER BY id')).map((n: any) => n.message);
    const addAlias = (host: string) => cliWrite((cfg) => siteAddress.planAliases(cfg, {
        aliases: [...(cfg.siteAliases || []), { url: `https://${host}` }], via: 'cli', now: Date.now(),
    }));
    const removeAlias = (host: string) => cliWrite((cfg) => siteAddress.planAliases(cfg, {
        aliases: (cfg.siteAliases || []).filter((a: any) => hostPolicy.parseSiteUrl(a.url).hostname !== host), via: 'cli', now: Date.now(),
    }));

    test('two writes inside one watcher tick: one audit row EACH, in order, and one notice naming both', async () => {
        await world({ ...BASE, siteAddress: { rev: 13 } }, { siteurl: 'https://example.com', rev: '13' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        addAlias('tmp.example.com');
        removeAlias('tmp.example.com');
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied');
        assert.strictEqual(await option('site_address_rev'), '15');
        assert.deepStrictEqual((await audits()).map((a: any) => [a.action, a.detail.rev, a.detail.via, a.detail.added, a.detail.removed]), [
            ['site.address.aliases', 14, 'cli', ['tmp.example.com'], undefined],
            ['site.address.aliases', 15, 'cli', undefined, ['tmp.example.com']],
        ], 'the address the second row removes was added by a row of its own');
        // One notice per apply, not per revision (review PL-6: a scripted series sent one email per write).
        const messages = await notes();
        assert.strictEqual(messages.length, 1, JSON.stringify(messages));
        assert.match(messages[0], /^2 changes to the site address were applied\. .*Added: tmp\.example\.com\..*Removed: tmp\.example\.com\./);
        assert.strictEqual(await siteAddress.checkExternalChange(), 'unchanged', 'and nothing twice');
        assert.strictEqual((await audits()).length, 2);
    });

    test('a series written while the backend was stopped is applied at boot, one row per revision', async () => {
        await world({ ...BASE, siteAddress: { rev: 4 } }, { siteurl: 'https://example.com', rev: '4' });
        cliWrite((cfg) => siteAddress.planPolicy(cfg, { ipLiterals: 'own' }));
        addAlias('a.example.com');
        cliWrite((cfg) => siteAddress.planCanonical(cfg, { url: 'https://moved.example', via: 'cli', now: Date.now() }));
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'applied');
        assert.deepStrictEqual((await audits()).map((a: any) => [a.action, a.detail.rev, a.actor]), [
            ['site.address.policy', 5, null], ['site.address.aliases', 6, null], ['site.address.canonical', 7, null],
        ]);
        const messages = await notes();
        assert.strictEqual(messages.length, 1, 'one notice for the whole series');
        assert.match(messages[0], /^3 changes .*IP address policy changed.*Added: a\.example\.com.*main address changed from example\.com to moved\.example/);
        assert.strictEqual(await option('siteurl'), 'https://moved.example');
    });

    test('more revisions than the log keeps: the ones it no longer holds are ONE gap row, never silently skipped', async () => {
        await world({ ...BASE, siteAddress: { rev: 4 } }, { siteurl: 'https://example.com', rev: '4' });
        for (let i = 0; i < siteAddress.MAX_CHANGE_LOG + 5; i++) cliWrite((cfg) => siteAddress.planPolicy(cfg, { ipLiterals: i % 2 ? 'any' : 'own' }));
        assert.strictEqual(fileConfig().siteAddress.changes.length, siteAddress.MAX_CHANGE_LOG, 'the log is bounded');
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'applied');
        const rows = await audits();
        assert.deepStrictEqual(rows.filter((a: any) => a.action === 'site.address.gap').map((a: any) => a.detail), [{ from: 5, to: 9, revisions: 5, rev: 29 }]);
        assert.deepStrictEqual(rows.filter((a: any) => a.action === 'site.address.policy').map((a: any) => a.detail.rev),
            Array.from({ length: siteAddress.MAX_CHANGE_LOG }, (_, i) => 10 + i));
        assert.ok((await notes()).some((m: string) => /Revisions 5–9 of the site address were written at the server/.test(m)), 'administrators are told too');
    });

    test('a file from a writer without the log (an older CLI): its last revision is audited, the rest is a gap', async () => {
        await world({ ...BASE, siteAliases: [{ url: 'https://www.example.com' }], siteAddress: { rev: 9, lastChange: { kind: 'aliases', via: 'cli', by: 7, at: '2026-10-06T00:00:00.000Z', added: ['www.example.com'] } } },
            { siteurl: 'https://example.com', rev: '6' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'applied');
        assert.deepStrictEqual((await audits()).map((a: any) => [a.action, a.actor, a.detail.rev, a.detail.from, a.detail.to, a.detail.added]), [
            ['site.address.aliases', null, 9, undefined, undefined, ['www.example.com']],
            ['site.address.gap', null, 9, 7, 8, undefined],
        ], 'a name written in the file is never taken as the actor');
    });

    test('changesSince: what the installer and the legacy upgrade numbered is bookkeeping, neither a change nor a gap', () => {
        const install = { ...BASE, siteAddress: siteAddress.installRecord(Date.now()) };
        assert.deepStrictEqual(siteAddress.changesSince(install, 0), { events: [], gaps: [] });
        const upgraded = { ...BASE, siteAddress: { rev: 1, lastChange: { kind: 'repair', via: 'upgrade', by: null, at: 'x', reason: 'upgrade' } } };
        assert.deepStrictEqual(siteAddress.changesSince(upgraded, 0), { events: [], gaps: [] });
        assert.deepStrictEqual(siteAddress.changesSince({ ...BASE, siteAddress: { rev: 3, changes: [{ rev: 3, kind: 'nonsense' }, 'x', null] } }, 1).gaps, [{ from: 2, to: 3, revisions: 2 }],
            'a record that does not read back is a gap, never a row of made-up content');
    });
});

// ─── review of the pipeline fixes: the record survives every order of events ──────────────────────

describe('every revision stays on the record — commits, crashes, older writers (review PL-1/2/5/6/8)', () => {
    const notes = async () => (await db.all('SELECT message FROM notifications ORDER BY id')).map((n: any) => n.message);
    const rows = async () => (await audits()).map((a: any) => [a.action, a.detail.rev, a.actor, a.detail.via]);
    const addAlias = (host: string) => cliWrite((cfg) => siteAddress.planAliases(cfg, {
        aliases: [...(cfg.siteAliases || []), { url: `https://${host}` }], via: 'cli', now: Date.now(),
    }));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    test('PL-1: a CLI revision the watcher has not applied yet is audited by the commit that overtakes it', async () => {
        await world({ ...BASE, siteAddress: { rev: 4 } }, { siteurl: 'https://example.com', rev: '4' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        addAlias('tmp.example.com');
        // An administrator saves before the next watcher tick: the commit writes revision 6 over the CLI's 5.
        await siteAddress.commit((c: any) => siteAddress.planPolicy(c, { ipLiterals: 'own' }), { expectRev: 5, via: 'ui', actorId: adminId });
        assert.strictEqual(await siteAddress.checkExternalChange(), 'unchanged');
        assert.deepStrictEqual(await rows(), [['site.address.aliases', 5, null, 'cli'], ['site.address.policy', 6, adminId, 'ui']]);
        const messages = await notes();
        assert.strictEqual(messages.length, 1);
        assert.match(messages[0], /Added: tmp\.example\.com.*command line.*IP address policy/);
        assert.notStrictEqual(hostPolicy.classify(hostPolicy.parseHost('tmp.example.com'), siteHostPolicy.get()).cls, 'unknown', 'and it is in force');
    });

    test('PL-1: the gateway\'s automatic http → https upgrade overtaking a CLI revision audits it too', async () => {
        await world({ ...BASE, siteUrl: 'http://example.com', siteAddress: { rev: 4 } }, { siteurl: 'http://example.com', rev: '4' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        addAlias('tmp.example.com');
        assert.strictEqual((await siteAddress.noteGatewaySiteUrl('https://example.com')).outcome, 'upgraded');
        assert.strictEqual(await siteAddress.checkExternalChange(), 'unchanged');
        assert.deepStrictEqual((await rows()).map((r: any[]) => r.slice(0, 2)), [['site.address.aliases', 5], ['site.address.repair', 6]]);
    });

    test('PL-1: when a commit is rolled back, a CLI revision pending before it is still applied by the next tick', async () => {
        await world({ ...BASE, siteAddress: { rev: 4 } }, { siteurl: 'https://example.com', rev: '4' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        addAlias('tmp.example.com');
        const real = options.updateOption;
        options.updateOption = async () => { throw new Error('database down (simulated)'); };
        try {
            await assert.rejects(() => siteAddress.commit((c: any) => siteAddress.planPolicy(c, { ipLiterals: 'own' }), { expectRev: 5, via: 'ui', actorId: adminId }),
                (e: any) => e.code === 'rest_site_address_rollback');
        } finally {
            options.updateOption = real;
        }
        assert.strictEqual(configManager.siteAddressRev(fileConfig()), 5, 'the file is back at the CLI\'s revision');
        assert.deepStrictEqual(await rows(), [], 'the refused commit left no row of its own');
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied', 'the CLI revision is not taken for applied');
        assert.deepStrictEqual(await rows(), [['site.address.aliases', 5, null, 'cli']]);
    });

    test('PL-2: a backend killed while it waits on the gateway has already put every revision on the record', async () => {
        await world({ ...BASE, mtls: { cert: 'certs/backend.crt' }, siteAddress: { rev: 4 } }, { siteurl: 'https://example.com', rev: '4' });
        const certManager = require('../core/cert-manager');
        const realPush = certManager.pushHostPolicyToGateway;
        let release: () => void = () => { /* set below */ };
        certManager.pushHostPolicyToGateway = async () => ({ success: true, stored: 'unchanged', refused: [] });
        try {
            const { state, gatewayArmed } = await siteAddress.reconcileAtBoot();
            assert.strictEqual(state, 'ok');
            await gatewayArmed;
            cliWrite((cfg) => siteAddress.planPolicy(cfg, { ipLiterals: 'own' }));
            cliWrite((cfg) => siteAddress.planPolicy(cfg, { ipLiterals: 'none' }));
            // The gateway does not answer: the apply stops inside the push, as a process killed there would.
            certManager.pushHostPolicyToGateway = () => new Promise((resolve) => { release = () => resolve({ success: true, stored: 'written', refused: [] }); });
            const tick = siteAddress.checkExternalChange();
            const deadline = Date.now() + 5000;
            while (await option('site_address_rev') !== '6' && Date.now() < deadline) await sleep(20);
            await sleep(100);
            // "The kill": what is in the database now is all a restarted backend will ever see, since its
            // reconcile finds the file and the database at the same revision.
            assert.strictEqual(await option('site_address_rev'), '6');
            assert.deepStrictEqual((await rows()).map((r: any[]) => r.slice(0, 2)), [['site.address.policy', 5], ['site.address.policy', 6]]);
            assert.strictEqual((await notes()).length, 1, 'and the administrators were told before the push');
            release();
            assert.strictEqual(await tick, 'applied');
        } finally {
            release();
            certManager.pushHostPolicyToGateway = realPush;
        }
    });

    test('PL-2: a revision and its audit rows commit together — a refused mirror write leaves neither, and the retry records once', async () => {
        await world({ ...BASE, siteAddress: { rev: 4 } }, { siteurl: 'https://example.com', rev: '4' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        cliWrite((cfg) => siteAddress.planPolicy(cfg, { ipLiterals: 'own' }));
        const real = options.updateOption;
        options.updateOption = async (name: string, ...rest: unknown[]) => {
            if (name === 'site_address_rev') throw new Error('database down (simulated)');
            return real(name, ...rest);
        };
        try {
            await assert.rejects(() => siteAddress.checkExternalChange(), /database down/);
        } finally {
            options.updateOption = real;
        }
        assert.strictEqual(await option('site_address_rev'), '4');
        assert.deepStrictEqual(await rows(), [], 'the rows were rolled back with the revision');
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied');
        assert.deepStrictEqual((await rows()).map((r: any[]) => r.slice(0, 2)), [['site.address.policy', 5]], 'exactly once');
    });

    test('PL-5: a revision an older writer added (lastChange, no log entry of its own) is audited, not a gap', async () => {
        const at = '2026-10-06T00:00:00.000Z';
        await world({
            ...BASE,
            siteAliases: [{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }],
            siteAddress: {
                rev: 6,
                // What HEAD's applyPlan writes: the log carried over untouched, lastChange without a revision.
                lastChange: { kind: 'aliases', via: 'cli', by: null, at, added: ['b.example.com'] },
                changes: [{ rev: 5, kind: 'aliases', via: 'cli', by: null, at, force: false, added: ['a.example.com'] }],
            },
        }, { siteurl: 'https://example.com', rev: '4' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'applied');
        assert.deepStrictEqual((await audits()).map((a: any) => [a.action, a.detail.rev, a.detail.added]), [
            ['site.address.aliases', 5, ['a.example.com']],
            ['site.address.aliases', 6, ['b.example.com']],
        ]);
    });

    test('PL-8: revisions the log does not cover are one gap per run, never a span that includes audited ones', () => {
        const changes = [...Array.from({ length: 5 }, (_, i) => 10 + i), ...Array.from({ length: 14 }, (_, i) => 16 + i)]
            .map((rev) => ({ rev, kind: 'policy', via: 'cli', by: null, at: 'x', from: 'any', to: 'own' }));
        const { events, gaps } = siteAddress.changesSince({ ...BASE, siteAddress: { rev: 29, changes } }, 4);
        assert.strictEqual(events.length, 19);
        assert.deepStrictEqual(gaps, [{ from: 5, to: 9, revisions: 5 }, { from: 15, to: 15, revisions: 1 }]);
        // A hand-edited revision of any size is walked by what the log covers, not revision by revision.
        const started = Date.now();
        assert.deepStrictEqual(siteAddress.changesSince({ ...BASE, siteAddress: { rev: 1e12 } }, 0).gaps, [{ from: 1, to: 1e12, revisions: 1e12 }]);
        assert.ok(Date.now() - started < 1000);
    });

    test('PL-6: a scripted series is one notice and one email, and the mail server never holds the queue', async () => {
        await world({ ...BASE, siteAddress: { rev: 4 } }, { siteurl: 'https://example.com', rev: '4' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        const realSend = (global as any).wordjs_send_mail;
        const sent: any[] = [];
        // A mail provider that never finishes delivering.
        (global as any).wordjs_send_mail = (m: any) => { sent.push(m); return new Promise(() => { /* never */ }); };
        await options.updateOption('admin_email', 'owner@example.org');
        try {
            for (let i = 0; i < siteAddress.MAX_CHANGE_LOG + 5; i++) cliWrite((cfg) => siteAddress.planPolicy(cfg, { ipLiterals: i % 2 ? 'any' : 'own' }));
            const outcome = await Promise.race([siteAddress.checkExternalChange(), sleep(5000).then(() => 'still waiting on the mail server')]);
            assert.strictEqual(outcome, 'applied');
            assert.strictEqual((await rows()).length, siteAddress.MAX_CHANGE_LOG + 1, 'one row per revision the log holds, plus the gap');
            assert.strictEqual((await notes()).length, 1, 'one notice');
            assert.strictEqual(sent.length, 1, 'one email');
            assert.match(sent[0].text, /^21 changes to the site address were applied\. /);
        } finally {
            (global as any).wordjs_send_mail = realSend;
            await options.updateOption('admin_email', '');
        }
    });
});

// ─── critic: --force is on the record, through the real CLI ───────────────────────────────────────

describe('an override of the interlock made with the CLI is audited as one (critic finding)', () => {
    test('npm run site -- remove … --force → the running backend audits force:true and what it went past', async () => {
        await world({ ...BASE, gatewayUrl: 'https://gw.example.com:3000', siteAliases: [{ url: 'https://gw.example.com' }], siteAddress: { rev: 2 } },
            { siteurl: 'https://example.com', rev: '2' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        const cli = require(path.join(__dirname, '..', '..', 'scripts', 'site-address.js'));
        const out: string[] = [];
        const code = await cli.run(['remove', 'gw.example.com', '--force', '--dir', TMP_INSTALL],
            { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: {}, modules: { siteAddress, configManager, hostPolicy } });
        assert.strictEqual(code, 0, out.join('\n'));
        assert.match(out.join('\n'), /Forced past: gatewayUrl/);
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied');
        const [row] = await audits();
        assert.deepStrictEqual({ action: row.action, via: row.detail.via, force: row.detail.force, forcedPast: row.detail.forcedPast, removed: row.detail.removed }, {
            action: 'site.address.aliases', via: 'cli', force: true, forcedPast: ['gatewayUrl https://gw.example.com:3000'], removed: ['gw.example.com'],
        });
    });
});

// ─── critic: the upgrade conflict can be resolved with the CLI, either way ────────────────────────

describe('an upgrade conflict is resolved with `npm run site -- canonical <url>`, whichever address is chosen (critic finding)', () => {
    const cli = require(path.join(__dirname, '..', '..', 'scripts', 'site-address.js'));
    const run = async (...args: string[]) => {
        const out: string[] = [];
        const code = await cli.run([...args, '--dir', TMP_INSTALL], { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: {}, modules: { siteAddress, configManager, hostPolicy } });
        return { code, out: out.join('\n') };
    };
    const conflictWorld = async () => {
        await world(BASE, { siteurl: 'https://old.example', home: 'https://old.example' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'conflict');
        assert.deepStrictEqual((await siteAddress.describeState(null)).conflict, { config: 'https://example.com', db: 'https://old.example' });
    };

    test('the config\'s own address (A) is a choice, not "nothing to change": mirrors written, conflict over, audited', async () => {
        await conflictWorld();
        const r = await run('canonical', 'https://example.com');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /Saved \(revision 1\)/);
        assert.doesNotMatch(r.out, /Nothing to change/);
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied');
        assert.strictEqual(await option('siteurl'), 'https://example.com', 'links now use the chosen address');
        assert.strictEqual(await option('home'), 'https://example.com');
        assert.strictEqual(await siteAddress.linkBase(), 'https://example.com');
        assert.strictEqual((await siteAddress.describeState(null)).conflict, null);
        assert.deepStrictEqual((await audits()).map((a: any) => [a.action, a.detail.via, a.detail.chosen ?? a.detail.to]), [
            ['site.address.canonical', 'cli', 'https://example.com'],
            ['site.address.conflict_resolved', 'cli', 'https://example.com'],
        ]);
        const resolved = (await audits())[1].detail;
        assert.deepStrictEqual({ config: resolved.config, db: resolved.db }, { config: 'https://example.com', db: 'https://old.example' });
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok', 'and it stays resolved after a restart');
    });

    test('the database\'s address (B) resolves it too', async () => {
        await conflictWorld();
        const r = await run('canonical', 'https://old.example', '--drop-old');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied');
        assert.strictEqual(fileConfig().siteUrl, 'https://old.example');
        assert.strictEqual(await option('siteurl'), 'https://old.example');
        assert.strictEqual((await siteAddress.describeState(null)).conflict, null);
        assert.deepStrictEqual((await audits()).map((a: any) => [a.action, a.detail.chosen ?? a.detail.to]), [
            ['site.address.canonical', 'https://old.example'],
            ['site.address.conflict_resolved', 'https://old.example'],
        ]);
    });

    test('any other change made meanwhile writes the file\'s address into the mirrors like every change: the conflict ends with it, on the record', async () => {
        await conflictWorld();
        await siteAddress.commit((cfg: any) => siteAddress.planAliases(cfg, { aliases: ['https://www.example.com'], via: 'ui', actorId: adminId, now: Date.now() }),
            { expectRev: 0, via: 'ui', actorId: adminId });
        assert.strictEqual(await option('siteurl'), 'https://example.com');
        assert.strictEqual((await siteAddress.describeState(null)).conflict, null, 'the banner no longer claims a disagreement that is gone');
        const [change, resolved] = await audits();
        assert.strictEqual(change.action, 'site.address.aliases');
        assert.deepStrictEqual({ action: resolved.action, actor: resolved.actor, chosen: resolved.detail.chosen, db: resolved.detail.db, change: resolved.detail.change },
            { action: 'site.address.conflict_resolved', actor: adminId, chosen: 'https://example.com', db: 'https://old.example', change: 'aliases' });
    });

    test('a site that has a revision still says "nothing to change" for its own address', async () => {
        await world({ ...BASE, siteAddress: { rev: 3 } }, { siteurl: 'https://example.com', rev: '3' });
        const before = fileText();
        const r = await run('canonical', 'https://example.com');
        assert.match(r.out, /Nothing to change/);
        assert.strictEqual(fileText(), before);
    });
});

// ─── lab finding M-03: a fresh install is recorded as one ──────────────────────────────────────────

describe('a fresh install records itself, not the legacy upgrade (lab M-03)', () => {
    test('what the installer writes is in step with the database: the first reconcile writes nothing and audits nothing', async () => {
        const now = Date.parse('2026-10-06T12:00:00.000Z');
        await world({ ...BASE, siteAddress: siteAddress.installRecord(now) }, { siteurl: 'https://example.com', home: 'https://example.com:3001', rev: '1' });
        const before = fileText();
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'ok');
        assert.strictEqual(fileText(), before);
        assert.deepStrictEqual(fileConfig().siteAddress.lastChange, { kind: 'install', via: 'install', by: null, at: '2026-10-06T12:00:00.000Z', rev: 1 });
        assert.strictEqual(await option('home'), 'https://example.com:3001', 'the frontend origin the installer stored is left alone');
        assert.deepStrictEqual(await audits(), []);
        // The first change after it is revision 2, and the only thing audited.
        cliWrite((cfg) => siteAddress.planPolicy(cfg, { ipLiterals: 'own' }));
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied');
        assert.deepStrictEqual((await audits()).map((a: any) => [a.action, a.detail.rev]), [['site.address.policy', 2]]);
    });
});

// ─── the file writer itself ────────────────────────────────────────────────────────────────────────

describe('configManager — atomic, compare-and-swap writes (R10)', () => {
    beforeEach(() => world({ ...BASE, siteAddress: { rev: 2 }, keep: 'me' }));
    const leftovers = () => fs.readdirSync(TMP_INSTALL).filter((f: string) => f.endsWith('.tmp'));

    test('saveConfig merges into what is ON DISK now (not a cached copy) and leaves no temporary file', () => {
        configManager.getConfig(); // prime the 2 s cache
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...fileConfig(), addedOutside: true }, null, 2)); // another writer
        assert.strictEqual(configManager.saveConfig({ mine: 1 }), true);
        const cfg = fileConfig();
        assert.strictEqual(cfg.addedOutside, true, 'a concurrent writer\'s key is not undone');
        assert.strictEqual(cfg.mine, 1);
        assert.strictEqual(cfg.keep, 'me');
        assert.deepStrictEqual(leftovers(), []);
    });

    test('an unreadable file is refused, never replaced by the keys being saved', () => {
        fs.writeFileSync(CONFIG_FILE, '{"dbDriver": "sqlite-native", "jwtSecret": "x"');
        configManager.invalidateConfigCache();
        const result = configManager.updateConfig(() => ({ only: 'this' }));
        assert.deepStrictEqual(result, { ok: false, reason: 'unreadable' });
        assert.strictEqual(fileText(), '{"dbDriver": "sqlite-native", "jwtSecret": "x"');
        assert.strictEqual(configManager.saveConfig({ x: 1 }), false);
    });

    test('expectRev guards the revision; a write that loses the race to another writer is refused', () => {
        assert.strictEqual(configManager.updateConfig((c: any) => c, { expectRev: 1 }).reason, 'stale');
        // The bytes change between the decision and the rename: the compare half re-reads right before it.
        const target = path.join(TMP_INSTALL, 'cas-probe.json');
        fs.writeFileSync(target, 'theirs');
        assert.strictEqual(configManager.writeFileAtomic(target, 'mine', 'what I read'), 'changed');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs');
        assert.strictEqual(configManager.writeFileAtomic(target, 'mine', 'theirs'), 'written');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'mine');
        assert.deepStrictEqual(leftovers(), []);
        fs.rmSync(target);
    });

    test('restoreConfigText puts bytes back only while the file is still at the failed revision', () => {
        const before = fileText();
        const done = configManager.updateConfig((c: any) => ({ ...c, siteAddress: { rev: 3 } }), { expectRev: 2 });
        assert.ok(done.ok);
        assert.strictEqual(done.previousText, before);
        assert.strictEqual(configManager.restoreConfigText(before, { expectRev: 9 }), false, 'someone wrote after us: theirs stands');
        assert.strictEqual(configManager.restoreConfigText(before, { expectRev: 3 }), true);
        assert.strictEqual(fileText(), before);
    });
});
