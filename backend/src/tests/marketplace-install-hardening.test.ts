/**
 * MARKETPLACE INSTALL HARDENING — three properties of POST /marketplace/install|update|adopt and of the
 * catalog read, each with a negative control that goes red without its fix:
 *
 *   1. A FRESH install is pinned to the catalog entry's slug, exactly as an update already was: the
 *      archive's own root folder does not get to choose which plugin directory it lands in.
 *   2. Replacing an installed plugin with an OLDER version is refused unless the request says
 *      `allowDowngrade: true` (semver precedence, not string order).
 *   3. Catalog signatures: a detached Ed25519 `<index>.sig` is verified against the key that applies to
 *      the source (embedded official key, or a key the admin pinned for a source). Valid → `verified`;
 *      invalid, or missing where required → the source is refused; no key → `unsigned`, still usable.
 *
 * Catalogs here are LOCAL sources (a directory with marketplace-index.json + zips), set through the
 * option directly, like marketplace-adopt-route.test.ts does.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-mkt-harden-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const { updateOption, deleteOption } = require('../core/options');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const marketplace = require('../routes/marketplace');
const catalogSig = require('../core/marketplace-signature');

const B = config.api.prefix;
const SECRET = config.jwt.secret;
const PIN_SLUG = `wjs-pin-${process.pid}`;
const PIN_OTHER = `wjs-pin-other-${process.pid}`;
const DOWN_SLUG = `wjs-down-${process.pid}`;
const SIG_SLUG = `wjs-sig-${process.pid}`;
const BENIGN_INDEX = "'use strict';\nmodule.exports = { init() {} };\n";
const SCRIPTS = path.resolve(__dirname, '../../scripts');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(B, csrfProtection);
app.use(B, require('../routes'));

let dbAsync: any, core: any, origins: any;
let adminId = 0;
let catalogDir = '';
let sigDir = '';
const session = () => `Bearer ${jwt.sign({ userId: adminId, username: 'owner' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const pluginDir = (slug: string) => path.join(core.PLUGINS_DIR, slug);
const manifestVersion = (slug: string) => JSON.parse(fs.readFileSync(path.join(pluginDir(slug), 'manifest.json'), 'utf8')).version;

/** A plugin zip whose single root folder is `root` and whose manifest declares `version`. */
function pluginZip(root: string, version: string): Buffer {
    const zip = new AdmZip();
    zip.addFile(`${root}/manifest.json`, Buffer.from(JSON.stringify({ name: root, version, isolated: true })));
    zip.addFile(`${root}/index.js`, Buffer.from(BENIGN_INDEX));
    return zip.toBuffer();
}

/** One catalog entry (+ its zip written into `dir`). */
function entryFor(dir: string, id: string, version: string, zipRoot: string = id): any {
    const buf = pluginZip(zipRoot, version);
    const file = `${id}-${version}.zip`;
    fs.writeFileSync(path.join(dir, file), buf);
    return { id, name: id, version, description: '', author: '', category: 'General', file, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

function writeIndex(dir: string, plugins: any[]): Buffer {
    const bytes = Buffer.from(JSON.stringify({ plugins }));
    fs.writeFileSync(path.join(dir, 'marketplace-index.json'), bytes);
    return bytes;
}

function installManually(slug: string, version: string) {
    fs.rmSync(pluginDir(slug), { recursive: true, force: true });
    fs.mkdirSync(pluginDir(slug), { recursive: true });
    fs.writeFileSync(path.join(pluginDir(slug), 'manifest.json'), JSON.stringify({ name: slug, version, isolated: true }));
    fs.writeFileSync(path.join(pluginDir(slug), 'index.js'), BENIGN_INDEX);
}

const ed = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
};
const signB64 = (bytes: Buffer, privateKey: any) => crypto.sign(null, bytes, privateKey).toString('base64');

const getCatalog = () => request(app).get(`${B}/marketplace/catalog?refresh=1`).set('Authorization', session());
const sourceStatus = (body: any, url: string) => (body.sources || []).find((s: any) => s.url === url);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    core = require('../core/plugins');
    const perms = require('../core/plugin-permissions');
    origins = require('../core/plugin-origins');
    await perms.loadGrants();
    await perms.loadEgressHosts();

    const r = await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        ['owner', bcrypt.hashSync('Correct-Horse-9!', 10), 'owner@example.com', 'owner']);
    adminId = r.lastID;
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [adminId]);

    catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-mkt-harden-cat-'));
    sigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-mkt-harden-sig-'));
    writeIndex(catalogDir, [
        // Listed as PIN_SLUG, but the archive's root folder names another plugin.
        entryFor(catalogDir, PIN_SLUG, '1.0.0', PIN_OTHER),
        // An OLDER build than the one installed below.
        entryFor(catalogDir, DOWN_SLUG, '1.9.0'),
    ]);
    writeIndex(sigDir, [entryFor(sigDir, SIG_SLUG, '1.0.0')]);
    await updateOption('marketplace_sources', [catalogDir, sigDir]);

    installManually(DOWN_SLUG, '1.10.0');
    await origins.setPluginOrigin(DOWN_SLUG, { source: catalogDir, catalogId: DOWN_SLUG, version: '1.10.0' });
});

after(async () => {
    marketplace.__setOfficialCatalogKeyForTests(null);
    for (const slug of [PIN_SLUG, PIN_OTHER, DOWN_SLUG, SIG_SLUG]) { try { fs.rmSync(pluginDir(slug), { recursive: true, force: true }); } catch { /* */ } }
    for (const d of [catalogDir, sigDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

describe('fresh install is pinned to the catalog slug', () => {
    it('an archive whose root folder names another plugin is refused, and nothing is installed', async () => {
        const res = await request(app).post(`${B}/marketplace/install`).set('Authorization', session()).send({ id: PIN_SLUG });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'catalogSlugMismatch');
        assert.strictEqual(res.body.expectedSlug, PIN_SLUG);
        assert.strictEqual(res.body.intendedSlug, PIN_OTHER);
        assert.strictEqual(fs.existsSync(pluginDir(PIN_OTHER)), false, 'the archive did not choose its own install directory');
        assert.strictEqual(fs.existsSync(pluginDir(PIN_SLUG)), false);
        assert.strictEqual(await origins.getPluginOrigin(PIN_OTHER), null, 'no provenance recorded for either slug');
        assert.strictEqual(await origins.getPluginOrigin(PIN_SLUG), null);
    });
});

describe('downgrades need an explicit request', () => {
    it('semver precedence, not string order', () => {
        const { isLowerVersion } = marketplace;
        assert.strictEqual(isLowerVersion('1.9.0', '1.10.0'), true, 'numeric, not lexical');
        assert.strictEqual(isLowerVersion('1.10.0', '1.9.0'), false);
        assert.strictEqual(isLowerVersion('1.0.0', '1.0.0'), false, 'a reinstall of the same version is not a downgrade');
        assert.strictEqual(isLowerVersion('2.0.0-beta.1', '2.0.0'), true, 'a prerelease precedes its release');
        assert.strictEqual(isLowerVersion('not-a-version', '1.0.0'), true, 'an unparseable version never passes for a newer one');
        assert.strictEqual(isLowerVersion('1.0.0', ''), false, 'nothing installed to compare against');
    });

    it('the catalog does not offer an older build as an update', async () => {
        const res = await getCatalog();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const e = res.body.plugins.find((p: any) => p.id === DOWN_SLUG);
        assert.strictEqual(e.updateAvailable, false);
    });

    it('update to an older version is refused without allowDowngrade, and the installed code is untouched', async () => {
        for (const route of ['update', 'install']) {
            const res = await request(app).post(`${B}/marketplace/${route}`).set('Authorization', session()).send({ id: DOWN_SLUG });
            assert.strictEqual(res.status, 409, `${route}: ${JSON.stringify(res.body)}`);
            assert.strictEqual(res.body.code, 'downgradeRefused');
            assert.strictEqual(res.body.installedVersion, '1.10.0');
            assert.strictEqual(res.body.packageVersion, '1.9.0');
            assert.strictEqual(manifestVersion(DOWN_SLUG), '1.10.0');
        }
        const row = await dbAsync.get(`SELECT action, detail FROM audit_log WHERE target_id = ? ORDER BY id DESC LIMIT 1`, [DOWN_SLUG]);
        assert.ok(row, 'the refusal is audited');
        assert.strictEqual(JSON.parse(row.detail).ok, false);
    });

    it('a malformed allowDowngrade is refused', async () => {
        const res = await request(app).post(`${B}/marketplace/update`).set('Authorization', session()).send({ id: DOWN_SLUG, allowDowngrade: 'yes' });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(manifestVersion(DOWN_SLUG), '1.10.0');
    });

    it('adopt/reinstall follows the same rule', async () => {
        const res = await request(app).post(`${B}/marketplace/adopt`).set('Authorization', session())
            .send({ id: DOWN_SLUG, mode: 'reinstall', grants: [], keepData: true, confirmSourceChange: true });
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'downgradeRefused');
        assert.strictEqual(manifestVersion(DOWN_SLUG), '1.10.0');
    });

    it('with allowDowngrade: true the older version is installed', async () => {
        const res = await request(app).post(`${B}/marketplace/update`).set('Authorization', session()).send({ id: DOWN_SLUG, allowDowngrade: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(manifestVersion(DOWN_SLUG), '1.9.0');
    });
});

describe('catalog signatures', () => {
    it('the verifier: a good signature verifies, a bad or missing one does not', () => {
        const k = ed();
        const bytes = Buffer.from('{"plugins":[]}');
        const good = signB64(bytes, k.privateKey);
        assert.strictEqual(catalogSig.checkCatalogSignature(bytes, good, k.pub, true), 'verified');
        // Raw 32-byte form of the same key is accepted too.
        const raw = Buffer.from(k.pub, 'base64').subarray(12).toString('base64');
        assert.strictEqual(catalogSig.checkCatalogSignature(bytes, good, raw, true), 'verified');
        assert.throws(() => catalogSig.checkCatalogSignature(Buffer.from('{"plugins":[1]}'), good, k.pub, false), /firma del catálogo no es válida/);
        assert.throws(() => catalogSig.checkCatalogSignature(bytes, signB64(bytes, ed().privateKey), k.pub, false), /no es válida/, 'another key');
        assert.throws(() => catalogSig.checkCatalogSignature(bytes, 'not base64 !', k.pub, false), /no es válida/);
        assert.throws(() => catalogSig.checkCatalogSignature(bytes, null, k.pub, true), /no incluye firma/);
        assert.strictEqual(catalogSig.checkCatalogSignature(bytes, null, k.pub, false), 'unsigned');
        assert.strictEqual(catalogSig.checkCatalogSignature(bytes, good, '', true), 'unsigned', 'no key: not verified, flagged unsigned');
        assert.strictEqual(catalogSig.isValidPublicKey(k.pub), true);
        assert.strictEqual(catalogSig.isValidPublicKey(crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')), false, 'not an Ed25519 key');
        assert.strictEqual(catalogSig.isValidPublicKey('nope'), false);
    });

    it('the official catalog: no embedded key = unverified and not refused; with a key, a signature is required', () => {
        const official = 'https://github.com/jaimemartinez/wordjs/releases/latest/download';
        assert.strictEqual(marketplace.OFFICIAL_CATALOG_PUBLIC_KEY, '', 'the shipped placeholder is empty until the owner sets the key');
        assert.deepStrictEqual(marketplace.catalogSignaturePolicy(official, false, {}), { key: '', required: false });
        const k = ed();
        marketplace.__setOfficialCatalogKeyForTests(k.pub);
        try {
            assert.deepStrictEqual(marketplace.catalogSignaturePolicy(official, false, {}), { key: k.pub, required: true });
            // The embedded key is for the official catalog only; a third-party source is not held to it.
            assert.deepStrictEqual(marketplace.catalogSignaturePolicy('https://catalog.example/dl', false, {}), { key: '', required: false });
            // An admin cannot replace the official key with a pinned one.
            assert.strictEqual(marketplace.catalogSignaturePolicy(official, false, { [official.toLowerCase()]: ed().pub }).key, k.pub);
        } finally {
            marketplace.__setOfficialCatalogKeyForTests(null);
        }
    });

    it('an unsigned third-party catalog keeps working and is flagged unsigned', async () => {
        const res = await getCatalog();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const st = sourceStatus(res.body, sigDir);
        assert.strictEqual(st.ok, true);
        assert.strictEqual(st.signature, 'unsigned');
        assert.strictEqual(res.body.plugins.find((p: any) => p.id === SIG_SLUG).catalogSignature, 'unsigned');
    });

    it('pinning a key: invalid keys and keys for unlisted sources are refused', async () => {
        const bad = await request(app).put(`${B}/marketplace/sources`).set('Authorization', session())
            .send({ sources: ['https://catalog.example/dl'], keys: { 'https://catalog.example/dl': 'not-a-key' } });
        assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
        const unlisted = await request(app).put(`${B}/marketplace/sources`).set('Authorization', session())
            .send({ sources: ['https://catalog.example/dl'], keys: { 'https://other.example/dl': ed().pub } });
        assert.strictEqual(unlisted.status, 400, JSON.stringify(unlisted.body));
        // Neither attempt changed the configured list.
        await updateOption('marketplace_sources', [catalogDir, sigDir]);
    });

    it('with a pinned key: a good signature is verified, a bad or missing one refuses the source', async () => {
        const k = ed();
        const bytes = fs.readFileSync(path.join(sigDir, 'marketplace-index.json'));
        // Pinned through the option the PUT route writes (local dirs are not settable from the API).
        await updateOption('marketplace_source_signing_keys', { [origins.normSource(sigDir)]: k.pub });

        // Missing signature: refused, because pinning a key asks for signed catalogs.
        let res = await getCatalog();
        let st = sourceStatus(res.body, sigDir);
        assert.strictEqual(st.ok, false, JSON.stringify(st));
        assert.match(st.error, /no incluye firma/);
        assert.strictEqual(res.body.plugins.some((p: any) => p.id === SIG_SLUG), false);

        // Good signature: verified.
        fs.writeFileSync(path.join(sigDir, 'marketplace-index.json.sig'), signB64(bytes, k.privateKey) + '\n');
        res = await getCatalog();
        st = sourceStatus(res.body, sigDir);
        assert.strictEqual(st.ok, true, JSON.stringify(st));
        assert.strictEqual(st.signature, 'verified');
        assert.strictEqual(res.body.plugins.find((p: any) => p.id === SIG_SLUG).catalogSignature, 'verified');
        // The other (unkeyed) source is unaffected.
        assert.strictEqual(sourceStatus(res.body, catalogDir).signature, 'unsigned');

        // Bad signature (made by another key): refused, and nothing from it can be installed.
        fs.writeFileSync(path.join(sigDir, 'marketplace-index.json.sig'), signB64(bytes, ed().privateKey));
        res = await getCatalog();
        st = sourceStatus(res.body, sigDir);
        assert.strictEqual(st.ok, false);
        assert.match(st.error, /no es válida/);
        const install = await request(app).post(`${B}/marketplace/install`).set('Authorization', session()).send({ id: SIG_SLUG });
        assert.strictEqual(install.status, 404, JSON.stringify(install.body));
        assert.strictEqual(fs.existsSync(pluginDir(SIG_SLUG)), false);

        // A signed index that was altered afterwards: refused.
        fs.writeFileSync(path.join(sigDir, 'marketplace-index.json.sig'), signB64(bytes, k.privateKey));
        const altered = JSON.parse(bytes.toString('utf8'));
        altered.plugins[0].sha256 = '0'.repeat(64);
        fs.writeFileSync(path.join(sigDir, 'marketplace-index.json'), JSON.stringify(altered));
        res = await getCatalog();
        assert.strictEqual(sourceStatus(res.body, sigDir).ok, false);

        fs.writeFileSync(path.join(sigDir, 'marketplace-index.json'), bytes);
        await deleteOption('marketplace_source_signing_keys');
    });

    it('the owner tooling: generate a key pair, sign, and the server verifies it; no key = a no-op', () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-mkt-signtool-'));
        try {
            const keyFile = path.join(work, 'signing.pem');
            const gen = spawnSync(process.execPath, [path.join(SCRIPTS, 'generate-marketplace-signing-key.js'), '--out', keyFile], { encoding: 'utf8' });
            assert.strictEqual(gen.status, 0, gen.stderr);
            const pub = gen.stdout.trim().split(/\r?\n/).pop();
            assert.strictEqual(catalogSig.isValidPublicKey(pub), true, gen.stdout);
            assert.match(fs.readFileSync(keyFile, 'utf8'), /BEGIN PRIVATE KEY/);
            // It never overwrites a key in use.
            const again = spawnSync(process.execPath, [path.join(SCRIPTS, 'generate-marketplace-signing-key.js'), '--out', keyFile], { encoding: 'utf8' });
            assert.strictEqual(again.status, 1);

            const idx = path.join(work, 'marketplace-index.json');
            fs.writeFileSync(idx, JSON.stringify({ plugins: [] }));
            const env = { ...process.env };
            delete env.MARKETPLACE_SIGNING_KEY;
            const none = spawnSync(process.execPath, [path.join(SCRIPTS, 'sign-marketplace-catalog.js'), idx], { encoding: 'utf8', env });
            assert.strictEqual(none.status, 0, none.stderr);
            assert.strictEqual(fs.existsSync(`${idx}.sig`), false, 'no key: nothing signed');

            const signed = spawnSync(process.execPath, [path.join(SCRIPTS, 'sign-marketplace-catalog.js'), idx, '--verify', pub as string],
                { encoding: 'utf8', env: { ...env, MARKETPLACE_SIGNING_KEY: fs.readFileSync(keyFile, 'utf8') } });
            assert.strictEqual(signed.status, 0, signed.stderr + signed.stdout);
            assert.strictEqual(catalogSig.checkCatalogSignature(fs.readFileSync(idx), fs.readFileSync(`${idx}.sig`, 'utf8'), pub, true), 'verified');

            const wrong = spawnSync(process.execPath, [path.join(SCRIPTS, 'sign-marketplace-catalog.js'), idx, '--key', keyFile, '--verify', ed().pub], { encoding: 'utf8', env });
            assert.strictEqual(wrong.status, 1, 'a signature that does not match the expected public key fails the step');
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });
});
