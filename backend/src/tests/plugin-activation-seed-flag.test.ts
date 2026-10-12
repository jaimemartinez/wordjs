/**
 * GET /plugins TELLS THE ACTIVATION DIALOG WHAT CONFIRMING GRANTS — `activationSeedsGrants`.
 *
 * POST /plugins/:slug/activate stores the permissions a plugin's manifest declares only when no
 * administrator has decided its grants: no grant record at all, or an empty one nobody decided (what an
 * in-place update leaves for a plugin it finds without a record) — core/plugin-permissions
 * shouldSeedDeclaredGrants. An administrator who switches EVERY permission off in the Permissions dialog
 * leaves an empty record too, but a decided one, and the next activation grants nothing.
 *
 * The admin's activation dialog (frontend app/admin/plugins/grantState.ts) can only tell those empty
 * records apart through this flag: without it, it read an empty grant list as "activating grants all of
 * this" and listed every permission as granted for a plugin about to start with none — the team of a
 * plugin whose `roles:declare` had been revoked was told it would get its screens back.
 *
 * Every assertion pairs the flag with what the REAL route then does: the flag is only worth something if
 * it is the same answer the activation acts on.
 *
 * MUTATION PROOF: answer `activationSeedsGrants` from the grant list alone (`getGrants(slug).length === 0`)
 * and the "every grant revoked" case reads true while the activation grants nothing; drop the
 * administrator decision from shouldSeedDeclaredGrants and that activation re-seeds the revoked grants.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-activation-seed-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const SLUG = `wjs-actseed-${process.pid}`;
const BENIGN_INDEX = "'use strict';\nmodule.exports = { init() {} };\n";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(B, require('../routes'));

let adminId = 0;
let core: any, perms: any;
const session = () => `Bearer ${jwt.sign({ userId: adminId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`;
const pluginDir = () => path.join(core.PLUGINS_DIR, SLUG);

/** The flag as the plugins screen receives it. */
async function seedsFlag(): Promise<unknown> {
    const res = await request(app).get(`${B}/plugins`).set('Authorization', session());
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const row = res.body.find((p: any) => p.slug === SLUG);
    assert.ok(row, 'the plugin is listed');
    return row.activationSeedsGrants;
}

/** Activate through the real route, return what it left granted (stored), then deactivate again. */
async function activateAndRead(): Promise<string[] | undefined> {
    const res = await request(app).post(`${B}/plugins/${SLUG}/activate`).set('Authorization', session()).send({});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    try {
        const stored = (await require('../core/options').getOption('plugin_grants', {})) || {};
        return Object.hasOwn(stored, SLUG) ? stored[SLUG] : undefined;
    } finally {
        await core.deactivatePlugin(SLUG, { prune: false });
    }
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    core = require('../core/plugins');
    perms = require('../core/plugin-permissions');
    await perms.loadGrants();
    await perms.loadEgressHosts();
    const User = require('../models/User');
    adminId = (await User.create({ username: 'admin', email: 'admin@example.com', password: 'Activation-Seed-1!', role: 'administrator' })).id;
    fs.mkdirSync(pluginDir(), { recursive: true });
    fs.writeFileSync(path.join(pluginDir(), 'manifest.json'), JSON.stringify({
        name: SLUG, version: '1.0.0', isolated: true,
        permissions: [{ scope: 'settings', access: 'read', reason: 'reads the site name' }],
    }));
    fs.writeFileSync(path.join(pluginDir(), 'index.js'), BENIGN_INDEX);
});

after(async () => {
    try { await core.deactivatePlugin(SLUG, { prune: false }); } catch { /* */ }
    try { fs.rmSync(pluginDir(), { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('GET /plugins activationSeedsGrants is the answer POST /activate acts on', () => {
    it('no grant record: true — and the activation grants what the manifest declares', async () => {
        assert.strictEqual(await seedsFlag(), true);
        assert.deepStrictEqual(await activateAndRead(), ['settings:read']);
        await perms.removeGrants(SLUG);
    });

    it('an empty record nobody decided (an update\'s leftover): true — still seeded', async () => {
        await perms.ensureGrantRecord(SLUG);
        assert.strictEqual(await perms.hasAdminGrantDecision(SLUG), false, 'precondition: undecided');
        assert.strictEqual(await seedsFlag(), true);
        assert.deepStrictEqual(await activateAndRead(), ['settings:read']);
        await perms.removeGrants(SLUG);
    });

    it('every grant switched off in the Permissions dialog: false — the activation grants nothing', async () => {
        const saved = await request(app).post(`${B}/plugins/${SLUG}/permissions`).set('Authorization', session()).send({ granted: [] });
        assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
        assert.deepStrictEqual(perms.getGrants(SLUG), [], 'the grant list looks like a never-activated plugin\'s');
        assert.strictEqual(await seedsFlag(), false);
        assert.deepStrictEqual(await activateAndRead(), [], 'the revoke of every grant survived the activation');
    });

    it('some grants decided: false — the activation keeps exactly them', async () => {
        const saved = await request(app).post(`${B}/plugins/${SLUG}/permissions`).set('Authorization', session()).send({ granted: ['settings:read'] });
        assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
        assert.strictEqual(await seedsFlag(), false);
        assert.deepStrictEqual(await activateAndRead(), ['settings:read']);
    });
});
