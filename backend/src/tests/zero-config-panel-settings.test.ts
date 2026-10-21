/**
 * WordJS — ZERO CONFIG: settings that used to need a terminal, a config-file edit or a manual restart,
 * from the panel, on the REAL app.
 *
 *   1. A backup restore restarts the backend itself (it used to say "restart the service now").
 *   2. How many backups to keep (`backup_retention`) is a setting of Settings → Backups, validated.
 *   3. The ACME HTTP-01 listener port is set from Security → Auto-renewal, validated, kept when the form is
 *      saved, and re-bound at once (the monolith's hook) instead of after a restart.
 *   4. Themes → New theme guarantees WCAG AA when the panel asks (enforceContrast): a theme whose text
 *      does not read on its background is refused with the doctor's LOW_CONTRAST findings and nothing is
 *      installed; a readable one is installed, and Check theme (the doctor) reports on it.
 *   5. Security → Server: the reverse-proxy trust and the log level — password-confirmed, refused to an
 *      API token, only address-based trust values, written to wordjs-config.json, audited, followed by a
 *      restart.
 *
 * MUTATION PROOF (verified once each): drop scheduleRestart from POST /backups/:f/restore → test 1
 * fails; drop the backup_retention validator → test 2 stores "abc"; drop the http01Port range check →
 * test 3 stores 70000; drop requireSudoPassword from PUT /system/server → the wrong-password case is a
 * 200; let checkedTrustProxy accept "true" → the trust-everything case is stored.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-zeroconf-${process.pid}-`));
const DATA_DIR = path.join(TMP_INSTALL, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const MAIN_URL = 'http://localhost:3000';
const MAIN = 'localhost:3000';
const CONFIG_FILE = path.join(TMP_INSTALL, 'wordjs-config.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ installedAt: '2026-01-01T00:00:00.000Z', dbDriver: 'sqlite-native', siteUrl: MAIN_URL }, null, 2));
// The theme compiler and doctor read public/ from the working directory at load (theme-write-api.test.ts).
fs.mkdirSync(path.join(TMP_INSTALL, 'public', 'css'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', '..', 'public', 'theme-tokens.json'), path.join(TMP_INSTALL, 'public', 'theme-tokens.json'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'wordjs-ui.css'), path.join(TMP_INSTALL, 'public', 'css', 'wordjs-ui.css'));
process.chdir(TMP_INSTALL);
const ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY', 'WORDJS_SUPERVISED', 'LOG_LEVEL'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }
process.env.WORDJS_SUPERVISED = '1';

const config = require('../config/app');
config.dbPath = path.join(DATA_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = MAIN_URL;
config.site.url = MAIN_URL;
config.frontendUrl = MAIN_URL;
config.uploads.dir = path.join(TMP_INSTALL, 'uploads');
config.uploads.privateDir = path.join(DATA_DIR, 'private-uploads');
config.nodeEnv = 'production';

// The restore itself is core/backup's (tested in backup-private-media.test.ts); here the ROUTE's job is
// what happens around it, so the swap is replaced before the route module captures it.
const backup = require('../core/backup');
const restoredNames: string[] = [];
backup.restoreBackup = async (name: string) => { restoredNames.push(name); return { database: 'restored' }; };

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
const restart = require('../core/restart');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
let server: any;
const U: Record<string, number> = {};
const tokens: Record<string, string> = {};
const exits: number[] = [];

const direct = (method: string, url: string) =>
    (request(server) as any)[method](url).set('Host', MAIN).set('Origin', `http://${MAIN}`);
const as = (who: string, method: string, url: string) => direct(method, url).set('Authorization', `Bearer ${tokens[who]}`);
const fileConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const onMain = <T>(fn: () => T): T => siteContext.runWithSite(1, fn);

async function seed(login: string, role: string) {
    const db = database.getDbAsync();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, bcrypt.hashSync(PASSWORD, 10), `${login}@example.com`, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}
async function signIn(username: string): Promise<string> {
    const res = await direct('post', `${API}/auth/login`).send({ username, password: PASSWORD });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
}
async function restartCode(): Promise<number | undefined> {
    for (let i = 0; i < 60 && !exits.length; i++) await new Promise((r) => setTimeout(r, 50));
    const code = exits.shift();
    restart.resetForTests();
    return code;
}

before(async () => {
    restart.setExitHandlerForTests((code: number) => { exits.push(code); });
    await onMain(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        await require('../core/post-types').initPostTypes();
        await require('../core/post-types').initTaxonomies();
        await seed('owner', 'administrator');
        await seed('writer', 'author');
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    tokens.owner = await signIn('owner');
    tokens.writer = await signIn('writer');
    const tok = await as('owner', 'post', `${API}/auth/tokens`).send({ name: 'automation', scopes: '*' });
    assert.strictEqual(tok.status, 201, JSON.stringify(tok.body));
    tokens.apiToken = tok.body.token;
});

after(async () => {
    restart.setExitHandlerForTests(null);
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const key of ENV_KEYS) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
    delete (global as any).__WORDJS_SET_ACME_HTTP01_PORT__;
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

describe('a backup restore restarts the backend by itself', () => {
    test('the restore answers how it restarts, the supervisor is asked for 75, and it is audited', async () => {
        const res = await as('owner', 'post', `${API}/backups/backup-2026-01-01.zip/restore`).send({});
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.restart, 'supervisor');
        assert.deepStrictEqual(restoredNames, ['backup-2026-01-01.zip']);
        assert.strictEqual(await restartCode(), restart.RESTART_EXIT_CODE);
        assert.ok(await onMain(() => database.getDbAsync().get("SELECT 1 AS x FROM audit_log WHERE action = 'backup.restore'")));
        const author = await as('writer', 'post', `${API}/backups/backup-2026-01-01.zip/restore`).send({});
        assert.strictEqual(author.status, 403);
        assert.strictEqual(await restartCode(), undefined, 'a refused restore restarts nothing');
    });
});

describe('Settings → Backups: how many backups to keep', () => {
    test('a whole number from 0 to 365 is stored (normalized); anything else is refused', async () => {
        for (const bad of ['abc', '-1', '1000', '3.5', '']) {
            const r = await as('owner', 'put', `${API}/settings`).send({ backup_retention: bad });
            assert.strictEqual(r.status, 400, `${JSON.stringify(bad)}: ${r.status} ${JSON.stringify(r.body)}`);
            assert.deepStrictEqual(r.body.data.params, ['backup_retention']);
        }
        const ok = await as('owner', 'put', `${API}/settings`).send({ backup_retention: ' 012 ' });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual(ok.body.backup_retention, '12');
        const all = await as('owner', 'get', `${API}/settings/all`);
        assert.strictEqual(String(all.body.backup_retention), '12');
        const zero = await as('owner', 'put', `${API}/settings`).send({ backup_retention: 0 });
        assert.strictEqual(zero.status, 200);
        assert.strictEqual(zero.body.backup_retention, '0');
    });
});

describe('Security → Auto-renewal: the port 80 listener', () => {
    test('validated, kept, and re-bound without a restart', async () => {
        const bound: number[] = [];
        (global as any).__WORDJS_SET_ACME_HTTP01_PORT__ = (p: number) => bound.push(p);
        const base = { enabled: false, email: '', domains: [], staging: false, renewBeforeDays: 30, challengeType: 'http-01' };
        const bad = await as('owner', 'post', `${API}/system/certs/acme-config`).send({ ...base, http01Port: 70000 });
        assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
        const ok = await as('owner', 'post', `${API}/system/certs/acme-config`).send({ ...base, http01Port: 8080 });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual(fileConfig().acme.http01Port, 8080);
        const read = await as('owner', 'get', `${API}/system/certs/acme-config`);
        assert.strictEqual(read.body.http01Port, 8080);
        const off = await as('owner', 'post', `${API}/system/certs/acme-config`).send({ ...base, http01Port: null });
        assert.strictEqual(off.status, 200);
        assert.strictEqual(fileConfig().acme.http01Port, undefined);
        assert.deepStrictEqual(bound, [8080, 0], 'the listener followed each save at once');
        assert.strictEqual(await restartCode(), undefined, 'no restart was needed');
    });
});

describe('Security → Server: reverse-proxy trust and log level', () => {
    test('GET says what is in force; administrators only', async () => {
        const res = await as('owner', 'get', `${API}/system/server`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.trustProxy.value, null);
        assert.strictEqual(res.body.logLevel.fromEnvironment, false);
        assert.strictEqual(res.body.restart.mode, 'supervisor');
        assert.strictEqual((await as('writer', 'get', `${API}/system/server`)).status, 403);
    });

    test('refused without the password, to an API token, and for values that are not address-based', async () => {
        const noPw = await as('owner', 'put', `${API}/system/server`).send({ trustProxy: 'loopback', currentPassword: 'nope' });
        assert.strictEqual(noPw.status, 403);
        assert.strictEqual(noPw.body.code, 'rest_bad_current_password');
        const token = await direct('put', `${API}/system/server`).set('Authorization', `Bearer ${tokens.apiToken}`).send({ trustProxy: 'loopback', currentPassword: PASSWORD });
        assert.strictEqual(token.status, 403, JSON.stringify(token.body));
        for (const bad of ['true', '*', '2', 'evil.example', '10.0.0.0/99', 'loopback; rm']) {
            const r = await as('owner', 'put', `${API}/system/server`).send({ trustProxy: bad, currentPassword: PASSWORD });
            assert.strictEqual(r.status, 400, `${bad}: ${r.status}`);
            assert.deepStrictEqual(r.body.data.params, ['trustProxy']);
        }
        const level = await as('owner', 'put', `${API}/system/server`).send({ logLevel: 'trace', currentPassword: PASSWORD });
        assert.strictEqual(level.status, 400);
        assert.strictEqual(fileConfig().trustProxy, undefined, 'nothing was written');
        assert.strictEqual(await restartCode(), undefined);
    });

    test('a valid change is written, audited and followed by a restart; empty goes back to automatic', async () => {
        const res = await as('owner', 'put', `${API}/system/server`).send({ trustProxy: 'loopback,10.0.0.0/8', logLevel: 'debug', currentPassword: PASSWORD });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.restart, 'supervisor');
        assert.strictEqual(await restartCode(), restart.RESTART_EXIT_CODE);
        const file = fileConfig();
        assert.strictEqual(file.trustProxy, 'loopback, 10.0.0.0/8');
        assert.strictEqual(file.logging.level, 'debug');
        const row = await onMain(() => database.getDbAsync().get("SELECT detail FROM audit_log WHERE action = 'system.server.update'"));
        assert.ok(row, 'audited');
        assert.match(String(row.detail), /trustProxy/);

        const back = await as('owner', 'put', `${API}/system/server`).send({ trustProxy: '', logLevel: null, currentPassword: PASSWORD });
        assert.strictEqual(back.status, 200);
        assert.strictEqual(await restartCode(), restart.RESTART_EXIT_CODE);
        assert.strictEqual(fileConfig().trustProxy, undefined);
        assert.strictEqual(fileConfig().logging.level, undefined);
    });
});

describe('Themes → New theme and Check theme', () => {
    const seeds = { primary: '#1d4ed8', secondary: '#7e22ce', bg: '#ffffff', text: '#111827' };
    test('enforceContrast refuses an unreadable theme with the doctor findings and installs nothing', async () => {
        const res = await as('owner', 'post', `${API}/themes`).send({ slug: 'pale-ink', metadata: { name: 'Pale Ink' }, seeds: { ...seeds, text: '#d1d5db' }, enforceContrast: true });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'theme_low_contrast');
        assert.ok(res.body.details.findings.some((f: any) => f.code === 'LOW_CONTRAST' && /body text/.test(f.message)), JSON.stringify(res.body.details));
        assert.strictEqual(fs.existsSync(path.join(TMP_INSTALL, 'themes', 'pale-ink')), false, 'nothing was installed');
        // Without the flag the API stays what it was (the CLI and existing clients are unchanged).
        const loose = await as('owner', 'post', `${API}/themes`).send({ slug: 'pale-ink', metadata: { name: 'Pale Ink' }, seeds: { ...seeds, text: '#d1d5db' } });
        assert.strictEqual(loose.status, 201, JSON.stringify(loose.body));
    });

    test('a readable theme with chosen fonts is installed, and Check theme reports on it', async () => {
        const res = await as('owner', 'post', `${API}/themes`).send({
            slug: 'forest-cafe', metadata: { name: 'Forest Cafe' }, seeds, enforceContrast: true,
            tokens: { '--wjs-font-family-heading': 'Charter, "Bitstream Charter", Georgia, serif' },
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        const css = fs.readFileSync(path.join(TMP_INSTALL, 'themes', 'forest-cafe', 'style.css'), 'utf8');
        assert.match(css, /--wjs-font-family-heading:\s*Charter/);
        const doctor = await as('owner', 'get', `${API}/themes/forest-cafe/doctor`);
        assert.strictEqual(doctor.status, 200);
        assert.strictEqual(doctor.body.slug, 'forest-cafe');
        assert.ok(!doctor.body.warnings.some((w: any) => w.code === 'LOW_CONTRAST'), JSON.stringify(doctor.body.warnings));
        const pale = await as('owner', 'get', `${API}/themes/pale-ink/doctor`);
        assert.ok(pale.body.warnings.some((w: any) => w.code === 'LOW_CONTRAST'), 'Check theme flags the unreadable one');
    });
});
