/**
 * A PLUGIN THAT NEEDS A NEWER WORDJS IS NEVER INSTALLED ON AN OLDER ONE (FALLOS 150).
 *
 * A site on WordJS 2.9.0 updated conference-manager from the Marketplace and its admin went blank: the new
 * version imports a host module (components/ui/DatePicker) that 2.9.0 does not provide. The catalog at
 * releases/latest is built from the newest core, and nothing said which core a plugin needs.
 *
 * Plugins now declare it (manifest `requires.wordjs`), the catalog build copies it into each entry, and
 * this install (version pinned here to 2.9.0 / 2.10.0 by stubbing the product version):
 *   - marks each catalog entry `compatible` with the required range, its minimum and this version;
 *   - refuses install / update / adopt of an incompatible entry with 409 core_version_too_old BEFORE
 *     anything is downloaded, and the installer refuses a package whose own manifest says so (upload, and
 *     a catalog that omits the field) — nothing is extracted or replaced;
 *   - refuses a malformed range at install (400);
 *   - tells an admin session the minimum in /plugins/registry, for the in-admin notice.
 * And the build refuses a plugin that imports a host module newer than the WordJS it declares.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-core-req-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const { updateOption } = require('../core/options');
const { csrfProtection } = require('../middleware/auth');
const productVersion = require('../config/product-version');
const coreRequirement = require('../core/core-requirement');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const SECRET = config.jwt.secret;
const NEEDS_NEW = `wjs-corereq-new-${process.pid}`;   // requires >=2.10.0
const ANY = `wjs-corereq-any-${process.pid}`;         // declares nothing
const BENIGN_INDEX = "'use strict';\nmodule.exports = { init() {} };\n";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(B, csrfProtection);
app.use(B, require('../routes'));

let dbAsync: any, core: any;
let adminId = 0;
let catalogDir = '';
const session = () => `Bearer ${jwt.sign({ userId: adminId, username: 'owner' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const realResolve = productVersion.resolveProductVersion;
const runAs = (v: string) => { productVersion.resolveProductVersion = () => v; };

function zipFor(slug: string, version: string, requires?: any): Buffer {
    const zip = new AdmZip();
    const manifest: any = { name: slug, version, isolated: true, permissions: [] };
    if (requires !== undefined) manifest.requires = requires;
    zip.addFile(`${slug}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
    zip.addFile(`${slug}/index.js`, Buffer.from(BENIGN_INDEX));
    return zip.toBuffer();
}
function listEntry(slug: string, version: string, buf: Buffer, requires?: any) {
    const file = `${slug}-${version}.zip`;
    fs.writeFileSync(path.join(catalogDir, file), buf);
    return { id: slug, name: slug, version, description: '', author: '', category: 'General', file, size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'), permissions: [], ...(requires ? { requires } : {}) };
}
const isInstalled = (slug: string) => fs.existsSync(path.join(core.PLUGINS_DIR, slug, 'manifest.json'));
const upload = (buf: Buffer, name: string) => request(app).post(`${B}/plugins/upload`).set('Authorization', session()).attach('plugin', buf, name);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    core = require('../core/plugins');
    const r = await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        ['owner', bcrypt.hashSync('Correct-Horse-9!', 10), 'owner@example.com', 'owner']);
    adminId = r.lastID;
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [adminId]);

    catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-core-req-cat-'));
    const entries = [
        listEntry(NEEDS_NEW, '2.0.0', zipFor(NEEDS_NEW, '2.0.0', { wordjs: '>=2.10.0' }), { wordjs: '>=2.10.0' }),
        listEntry(ANY, '1.0.0', zipFor(ANY, '1.0.0')),
    ];
    fs.writeFileSync(path.join(catalogDir, 'marketplace-index.json'), JSON.stringify({ plugins: entries }));
    await updateOption('marketplace_sources', [catalogDir]);
});

after(async () => {
    productVersion.resolveProductVersion = realResolve;
    for (const slug of [NEEDS_NEW, ANY, `${NEEDS_NEW}-up`, `${NEEDS_NEW}-bad`]) { try { fs.rmSync(path.join(core.PLUGINS_DIR, slug), { recursive: true, force: true }); } catch { /* */ } }
    try { fs.rmSync(catalogDir, { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

describe('core requirement (unit)', () => {
    it('compatibility, minimum, no requirement, unknown version, malformed range', () => {
        const c = coreRequirement.coreCompatibility;
        assert.deepStrictEqual(c({ requires: { wordjs: '>=2.10.0' } }, '2.9.0'), { compatible: false, requires: '>=2.10.0', minimum: '2.10.0', current: '2.9.0' });
        assert.strictEqual(c({ requires: { wordjs: '>=2.10.0' } }, '2.10.0').compatible, true);
        assert.strictEqual(c({ requires: { wordjs: '>=2.10.0' } }, '2.11.0-beta.1').compatible, true, 'a pre-release of a newer core counts');
        assert.strictEqual(c({ requires: { wordjs: '^2.10.0' } }, '3.0.0').compatible, false);
        assert.strictEqual(c({}, '1.0.0').compatible, true, 'no requirement, no constraint');
        assert.strictEqual(c({ requires: { wordjs: '>=2.10.0' } }, '0.0.0').compatible, true, 'an install that cannot read its version locks nothing out');
        assert.deepStrictEqual(coreRequirement.validateManifestRequires({ wordjs: 'soon' }).length, 1);
        assert.deepStrictEqual(coreRequirement.validateManifestRequires({ php: '>=8' }).length, 1);
        assert.deepStrictEqual(coreRequirement.validateManifestRequires({ wordjs: '>=2.10.0' }), []);
        assert.deepStrictEqual(coreRequirement.validateManifestRequires(undefined), []);
    });
});

describe('on WordJS 2.9.0', () => {
    before(() => runAs('2.9.0'));

    it('the catalog marks the entry incompatible, with the range, the minimum and this version', async () => {
        const res = await request(app).get(`${B}/marketplace/catalog?refresh=1`).set('Authorization', session());
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const e = res.body.plugins.find((p: any) => p.id === NEEDS_NEW);
        assert.strictEqual(e.compatible, false);
        assert.strictEqual(e.requiresWordjs, '>=2.10.0');
        assert.strictEqual(e.minWordjs, '2.10.0');
        assert.strictEqual(e.currentWordjs, '2.9.0');
        assert.strictEqual(res.body.plugins.find((p: any) => p.id === ANY).compatible, true, 'an entry that declares nothing stays installable');
    });

    it('install / update / adopt of it: 409 core_version_too_old, nothing installed', async () => {
        for (const route of ['install', 'update']) {
            const r = await request(app).post(`${B}/marketplace/${route}`).set('Authorization', session()).send({ id: NEEDS_NEW });
            assert.strictEqual(r.status, 409, `${route}: ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.code, 'core_version_too_old');
            assert.strictEqual(r.body.minimum, '2.10.0');
            assert.strictEqual(r.body.current, '2.9.0');
            assert.match(r.body.error, /Update WordJS first/);
        }
        const a = await request(app).post(`${B}/marketplace/adopt`).set('Authorization', session())
            .send({ id: NEEDS_NEW, mode: 'reinstall', grants: [], keepData: true, confirmSourceChange: true });
        assert.strictEqual(a.status, 409, JSON.stringify(a.body));
        assert.strictEqual(a.body.code, 'core_version_too_old');
        assert.strictEqual(isInstalled(NEEDS_NEW), false);
    });

    it('an uploaded zip whose manifest needs a newer WordJS: 409, nothing extracted; a malformed range: 400', async () => {
        const up = await upload(zipFor(`${NEEDS_NEW}-up`, '1.0.0', { wordjs: '>=2.10.0' }), 'up.zip');
        assert.strictEqual(up.status, 409, JSON.stringify(up.body));
        assert.strictEqual(up.body.code, 'core_version_too_old');
        assert.strictEqual(isInstalled(`${NEEDS_NEW}-up`), false);
        assert.strictEqual(fs.existsSync(path.join(core.PLUGINS_DIR, `${NEEDS_NEW}-up`)), false, 'the extracted files were removed');

        const bad = await upload(zipFor(`${NEEDS_NEW}-bad`, '1.0.0', { wordjs: 'whenever' }), 'bad.zip');
        assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
        assert.match(bad.body.error, /requires\.wordjs/);
    });

    it('a catalog that omits the field is still caught by the package\'s own manifest', async () => {
        // The entry says nothing, the zip inside says >=2.10.0 (an index built before the field existed).
        const slug = `${NEEDS_NEW}-up`;
        const entries = JSON.parse(fs.readFileSync(path.join(catalogDir, 'marketplace-index.json'), 'utf8')).plugins;
        entries.push(listEntry(slug, '1.0.0', zipFor(slug, '1.0.0', { wordjs: '>=2.10.0' })));
        fs.writeFileSync(path.join(catalogDir, 'marketplace-index.json'), JSON.stringify({ plugins: entries }));
        const r = await request(app).post(`${B}/marketplace/install`).set('Authorization', session()).send({ id: slug });
        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.strictEqual(r.body.code, 'core_version_too_old');
        assert.strictEqual(isInstalled(slug), false);
    });
});

describe('on WordJS 2.10.0', () => {
    before(() => runAs('2.10.0'));

    it('the same entry is compatible and installs; the admin registry names its minimum', async () => {
        const cat = await request(app).get(`${B}/marketplace/catalog?refresh=1`).set('Authorization', session());
        assert.strictEqual(cat.body.plugins.find((p: any) => p.id === NEEDS_NEW).compatible, true);
        const r = await request(app).post(`${B}/marketplace/install`).set('Authorization', session()).send({ id: NEEDS_NEW });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(isInstalled(NEEDS_NEW), true);

        await core.activatePlugin(NEEDS_NEW); // the registry lists ACTIVE plugins
        const reg = await request(app).get(`${B}/plugins/registry`).set('Authorization', session());
        const entry = (reg.body.plugins || []).find((p: any) => p.id === NEEDS_NEW);
        assert.ok(entry, 'the active plugin is in the registry');
        assert.strictEqual(entry.minWordjs, '2.10.0');
        const anon = await request(app).get(`${B}/plugins/registry`);
        const anonEntry = (anon.body.plugins || []).find((p: any) => p.id === NEEDS_NEW);
        assert.ok(anonEntry);
        assert.strictEqual(anonEntry.minWordjs, undefined, 'an anonymous caller is not told');
        try { await core.deactivatePlugin(NEEDS_NEW, { prune: false }); } catch { /* */ }
    });
});

describe('the plugin build', () => {
    const { hostModuleRequirementProblem } = require('../../scripts/build-plugin.js');
    const SINCE = { 'components/ui/DatePicker': '2.10.0' };

    it('refuses a plugin that imports a newer host module than the WordJS it declares', () => {
        assert.match(String(hostModuleRequirementProblem('x', {}, ['components/ui/DatePicker', 'lib/api'], SINCE)), /declares no requires\.wordjs/);
        assert.match(String(hostModuleRequirementProblem('x', { requires: { wordjs: '>=2.9.0' } }, ['components/ui/DatePicker'], SINCE)), /">=2\.9\.0"/);
        assert.strictEqual(hostModuleRequirementProblem('x', { requires: { wordjs: '>=2.10.0' } }, ['components/ui/DatePicker'], SINCE), null);
        assert.strictEqual(hostModuleRequirementProblem('x', {}, ['lib/api', 'contexts/ModalContext'], SINCE), null, 'modules that predate the field need nothing');
    });

    it('conference-manager declares the WordJS its DatePicker import needs, and the catalog build carries it', () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../marketplace/plugins/conference-manager/manifest.json'), 'utf8'));
        assert.strictEqual(hostModuleRequirementProblem('conference-manager', manifest, ['components/ui/DatePicker'], SINCE), null);
        const builder = fs.readFileSync(path.resolve(__dirname, '../../scripts/build-marketplace.js'), 'utf8');
        assert.match(builder, /requires: \{ wordjs: manifest\.requires\.wordjs \}/);
    });
});
