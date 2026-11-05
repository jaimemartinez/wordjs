/**
 * The boundaries tightened after the second review pass: what a plugin route may answer with, what the plugin
 * SQL guard counts as a table, a plugin's reach into options and other plugins' tables, the cron bridge, and the
 * small anonymous surfaces (form size, menu location, hidden taxonomies, the proxy trust list).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-second-pass-${process.pid}-`));
config.dbPath = path.join(TMP_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const { assertSqlAllowed } = require('../core/plugin-api');
const { isPluginWritableOption } = require('../core/plugin-owned-options');
const { isReservedPluginSlug } = require('../core/plugin-slug-policy');
const { scheduleSingleEvent } = require('../core/cron');
const Term = require('../models/Term');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const B = config.api.prefix;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(B, require('../routes'));

const READ = ['select', 'with'];
const allowed = (sql: string) => assertSqlAllowed(sql, READ, 'wjp_x_', 'x');

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* */ }
});

describe('the plugin SQL guard', () => {
    it('counts the table of `x IN tbl`, which names one without FROM', () => {
        assert.throws(() => allowed('SELECT a FROM wjp_x_t WHERE a IN wjp_other_s'), /not owned/);
        assert.throws(() => allowed('SELECT a FROM wjp_x_t WHERE a NOT IN main.users'), /not owned/);
    });

    it('leaves the ordinary forms of IN alone', () => {
        allowed('SELECT a FROM wjp_x_t WHERE a IN (1, 2, 3)');
        allowed('SELECT a FROM wjp_x_t WHERE a IN (SELECT b FROM wjp_x_u)');
        allowed('SELECT a FROM wjp_x_t WHERE a IN (?, ?)');
        allowed("SELECT POSITION('a' IN b) FROM wjp_x_t");
        allowed("SELECT a FROM wjp_x_t WHERE MATCH(b) AGAINST('w' IN BOOLEAN MODE)");
    });

    it('takes no characters it cannot read as part of a name', () => {
        assert.throws(() => allowed('SELECT a FROM é wjp_x_t'), /non-ASCII/);
        allowed("SELECT a FROM wjp_x_t WHERE a = 'é'");
        allowed('SELECT "é" FROM wjp_x_t');
    });

    it('refuses the functions that reach past the statement', () => {
        for (const fn of ['load_file', 'set_config', 'ts_stat', 'lo_get', 'pg_sleep', 'sleep', 'benchmark']) {
            assert.throws(() => allowed(`SELECT ${fn}('x') FROM wjp_x_t`), /not permitted/, fn);
        }
    });
});

describe('what a plugin may reach', () => {
    it('never a core setting, whatever its slug spells', () => {
        assert.strictEqual(isPluginWritableOption('require', 'require_email_verification'), false);
        assert.strictEqual(isPluginWritableOption('upload', 'upload_max_size_mb'), false);
        assert.strictEqual(isPluginWritableOption('comment', 'comment_registration'), false);
        assert.strictEqual(isPluginWritableOption('media', 'media_storage_bucket'), false);
        assert.strictEqual(isPluginWritableOption('photo-carousel', 'photo_carousel_speed'), true);
    });

    it('those slugs are reserved at the door', () => {
        for (const slug of ['require', 'upload', 'comment', 'media', 'mail', 'graphql']) assert.strictEqual(isReservedPluginSlug(slug), true, slug);
        for (const slug of ['mail-server', 'media-gallery', 'conference-manager']) assert.strictEqual(isReservedPluginSlug(slug), false, slug);
    });

    it('a cron entry is a time and a plain hook name', async () => {
        await assert.rejects(() => scheduleSingleEvent('__proto__', 'demo', []), /timestamp/);
        await assert.rejects(() => scheduleSingleEvent('constructor', 'demo', []), /timestamp/);
        await assert.rejects(() => scheduleSingleEvent(1, 'a b', []), /hook/);
        assert.strictEqual(({} as any).demo_1, undefined);
    });
});

describe('plugin route responses', () => {
    const { _pluginHeaderAllowed: ok } = require('../core/plugin-isolate');

    it('only metadata and the plugin\'s own x- headers', () => {
        for (const h of ['Cache-Control', 'ETag', 'Content-Disposition', 'X-Plugin-Page']) assert.strictEqual(ok(h), true, h);
        for (const h of ['__proto__', 'Set-Cookie', 'Content-Type', 'Content-Security-Policy', 'Location', 'Clear-Site-Data', 'Service-Worker-Allowed', 'Link', 'X-Frame-Options', 'X-Content-Type-Options', 'X-Forwarded-For', 'X-WordJS-Site-Host', 'Access-Control-Allow-Origin']) {
            assert.strictEqual(ok(h), false, h);
        }
    });
});

describe('small anonymous surfaces', () => {
    it('a term name costs the same however many tags it nests', () => {
        const k = 200000;
        const started = Date.now();
        Term.sanitizeName('<a'.repeat(k) + '>'.repeat(k));
        assert.ok(Date.now() - started < 1000);
        assert.strictEqual(Term.sanitizeName('<b>Nombre</b>'), 'Nombre');
    });

    it('a form is measured as stored, not as sent', async () => {
        const fields: Record<string, string> = {};
        for (let i = 0; i < 13; i++) fields[`f${i}`] = '&'.repeat(5000);
        const res = await request(app).post(`${B}/forms/submit`).send({ formName: 'x', fields });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    });

    it('a menu location is looked up among its own keys', async () => {
        assert.strictEqual((await request(app).get(`${B}/menus/location/constructor`)).status, 404);
    });

    it('a hidden taxonomy is not listed to a visitor', async () => {
        const { registerTaxonomy } = require('../core/post-types');
        registerTaxonomy('internal_flag', { public: false, showInRest: false, postTypes: ['post'] });
        const list = await request(app).get(`${B}/taxonomies?rest=false`);
        assert.ok(!list.body.some((t: any) => t.name === 'internal_flag'));
        assert.strictEqual((await request(app).get(`${B}/taxonomies/internal_flag`)).status, 404);
    });
});

describe('the proxy trust list', () => {
    const { checkedTrustProxy: check } = require('../routes/server-settings');

    it('refuses the ranges that stop the server or trust everyone', () => {
        assert.strictEqual(check('10.0.0.0/0').ok, false);
        assert.strictEqual(check('0.0.0.0/1, 128.0.0.0/1').ok, false);
        assert.strictEqual(check('::/1').ok, false);
    });

    it('takes real ones', () => {
        assert.strictEqual(check('10.0.0.0/8').ok, true);
        assert.strictEqual(check('192.168.1.10').ok, true);
        assert.strictEqual(check('2001:db8::/32').ok, true);
    });
});
