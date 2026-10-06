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
 * the file and the database is shown, never auto-resolved.
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
