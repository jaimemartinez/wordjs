/**
 * The uniqueness rules on every engine (core/unique-integrity + migrations 0001/0020/0023/0024): a
 * database whose rows already repeat a login, an email, a slug or a term slug cannot get its unique
 * index, and the migrations that build them must then WAIT — not be recorded as applied, so the next boot
 * tries again — while the boot goes on. Once the duplicates are gone, the next run builds the indexes and
 * records the migrations, and the database refuses a new duplicate by itself.
 *
 * The defect: 0001 (and 0020/0023) logged a warning and were recorded anyway, so an install with
 * duplicates never got the indexes (QA X3: MariaDB installs without unique indexes).
 *
 * SQLite always runs; Postgres and MySQL/MariaDB run against real servers with WORDJS_CI_DB=1 (CI's
 * service containers; PGHOST / MYSQL_HOST point elsewhere), and skip without one.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

require('../config/app');
const { initializeSchema } = require('../config/database');
const { runSchemaMigrations, MIGRATIONS } = require('../core/schema-migrations');
const integrity = require('../core/unique-integrity');
const { isUniqueViolation } = require('../core/db-errors');

const REAL = process.env.WORDJS_CI_DB === '1';
const SUFFIX = `${process.pid}_${Date.now() % 1e6}`;
const RULE_MIGRATIONS = ['0001_unique_constraints_users_posts', '0020_mysql_unique_email_slug', '0023_terms_unique_slug', '0024_unique_rules_recheck'];

type Engine = 'sqlite' | 'postgres' | 'mysql';
type Ctx = { q: any; driverName: string; engine: Engine; isAsync: boolean; db: any; close: () => Promise<void> };

async function sqliteCtx(t: any): Promise<Ctx | null> {
    let Database: any;
    try { Database = require('better-sqlite3'); } catch { t.skip('better-sqlite3 unavailable'); return null; }
    const file = path.join(os.tmpdir(), `wjs-uniq-${SUFFIX}.db`);
    const raw = new Database(file);
    const { NativeWrapper } = require('../drivers/sqlite-native');
    const w = new NativeWrapper(raw);
    const q = {
        exec: async (s: string) => w.exec(s), run: async (s: string, p: any[] = []) => w.run(s, p),
        get: async (s: string, p: any[] = []) => w.get(s, p), all: async (s: string, p: any[] = []) => w.all(s, p),
    };
    return {
        q, db: w, isAsync: false, driverName: 'sqlite-native', engine: 'sqlite',
        close: async () => { try { raw.close(); } catch { /* */ } for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true }); },
    };
}

async function pgCtx(t: any): Promise<Ctx | null> {
    if (!REAL) { t.skip('WORDJS_CI_DB!=1 — no real Postgres'); return null; }
    const { Client } = require('pg');
    const s = {
        host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT) || 5432, user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD ?? 'password', name: process.env.PGDATABASE || 'wordjs',
    };
    const admin = new Client({ host: s.host, port: s.port, user: s.user, password: s.password, database: s.name, connectionTimeoutMillis: 5000 });
    admin.on('error', () => {});
    try { await admin.connect(); } catch (e: any) { t.skip(`no reachable Postgres: ${e.message}`); return null; }
    const schema = `wjs_u_${SUFFIX}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const driver = new (require('../drivers/postgres').PostgresDriver)();
    driver.config = { ...s, schema, poolMax: 4 };
    await driver.connect();
    const q = { exec: (x: string) => driver.exec(x), run: (x: string, p: any[] = []) => driver.run(x, p), get: (x: string, p: any[] = []) => driver.get(x, p), all: (x: string, p: any[] = []) => driver.all(x, p) };
    return {
        q, db: driver, isAsync: true, driverName: 'postgres', engine: 'postgres',
        close: async () => {
            try { await driver.close(); } catch { /* */ }
            try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* */ }
            try { await admin.end(); } catch { /* */ }
        },
    };
}

async function mysqlCtx(t: any): Promise<Ctx | null> {
    if (!REAL) { t.skip('WORDJS_CI_DB!=1 — no real MySQL'); return null; }
    const mysql = require('mysql2/promise');
    const s = {
        host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT) || 3306, user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? 'password', name: process.env.MYSQL_DB || 'wordjs',
    };
    let admin: any;
    try { admin = await mysql.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password, connectTimeout: 5000 }); }
    catch (e: any) { t.skip(`no reachable MySQL: ${e.message}`); return null; }
    const name = `wjs_u_${SUFFIX}`;
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const driver = new (require('../drivers/mysql').MysqlDriver)();
    driver.config = { ...s, name, connectionLimit: 4 };
    await driver.connect();
    const q = { exec: (x: string) => driver.exec(x), run: (x: string, p: any[] = []) => driver.run(x, p), get: (x: string, p: any[] = []) => driver.get(x, p), all: (x: string, p: any[] = []) => driver.all(x, p) };
    return {
        q, db: driver, isAsync: true, driverName: 'mysql', engine: 'mysql',
        close: async () => {
            try { await driver.close(); } catch { /* */ }
            try { await admin.query(`DROP DATABASE IF EXISTS ${name}`); } catch { /* */ }
            try { await admin.end(); } catch { /* */ }
        },
    };
}

/** The unique indexes of an install from before they existed (or of one where they could not be built). */
async function dropUniqueIndexes(c: Ctx) {
    const drops = c.engine === 'mysql'
        ? [['users', 'idx_users_login'], ['users', 'uq_users_email'], ['users', 'idx_users_email'], ['posts', 'uq_posts_slug'], ['posts', 'idx_posts_name_type'], ['terms', 'uq_terms_slug']]
        : [['users', 'idx_users_login'], ['users', 'idx_users_email'], ['posts', 'idx_posts_name_type'], ['terms', 'uq_terms_slug']];
    for (const [table, index] of drops) {
        try { await c.q.exec(c.engine === 'mysql' ? `ALTER TABLE ${table} DROP INDEX ${index}` : `DROP INDEX IF EXISTS ${index}`); } catch { /* not there on this engine */ }
    }
    for (const id of RULE_MIGRATIONS) await c.q.run('DELETE FROM schema_migrations WHERE id = ?', [id]);
}

async function recorded(c: Ctx): Promise<string[]> {
    const rows = await c.q.all('SELECT id FROM schema_migrations');
    // 0020 is MySQL's: elsewhere it has nothing to build and is recorded at once.
    return rows.map((r: any) => r.id).filter((id: string) => RULE_MIGRATIONS.includes(id) && (c.engine === 'mysql' || id !== '0020_mysql_unique_email_slug')).sort();
}

const insertUser = (c: Ctx, login: string, email: string) =>
    c.q.run("INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)", [login, email, login]);
const insertPost = (c: Ctx, slug: string, type: string) =>
    c.q.run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, post_date, post_date_gmt, post_modified, post_modified_gmt, guid) VALUES (1, 'T', '', '', 'publish', ?, ?, '2026-10-21 10:00:00', '2026-10-21 10:00:00', '2026-10-21 10:00:00', '2026-10-21 10:00:00', '')", [slug, type]);
const insertTerm = (c: Ctx, slug: string) => c.q.run('INSERT INTO terms (name, slug) VALUES (?, ?)', [slug, slug]);

async function suite(c: Ctx) {
    const rules = MIGRATIONS.filter((m: any) => RULE_MIGRATIONS.includes(m.id));
    // A migration AFTER the deferred ones: the boot must go on past them.
    let later = 0;
    const tail = { id: '9998_after_unique_rules', up: async () => { later++; } };

    // 1. A fresh database: every rule is enforced from the start.
    await initializeSchema(c.db, c.isAsync);
    await runSchemaMigrations(c.db, c.isAsync, c.driverName);
    for (const r of await integrity.uniqueIntegrityStatus(c.q, c.engine)) assert.ok(r.enforced, `${c.engine}: ${r.id} enforced on a fresh install (${r.index})`);

    // 2. An install with duplicates and without the indexes.
    await dropUniqueIndexes(c);
    await insertUser(c, 'twin', 'twin-a@example.com');
    await insertUser(c, 'twin', 'twin-b@example.com');
    await insertUser(c, 'casey', 'Same@Example.com');
    await insertUser(c, 'morgan', 'same@example.com');
    await insertPost(c, 'about', 'page');
    await insertPost(c, 'about', 'page');
    await insertPost(c, 'about', 'post'); // another type: not a duplicate
    await insertTerm(c, 'news');
    await insertTerm(c, 'news');

    await runSchemaMigrations(c.db, c.isAsync, c.driverName, [...rules, tail]);
    assert.deepStrictEqual(await recorded(c), [], `${c.engine}: no unique-rule migration is recorded while duplicates block its index`);
    assert.strictEqual(later, 1, `${c.engine}: the boot goes on past the deferred migrations`);

    const status = await integrity.uniqueIntegrityStatus(c.q, c.engine);
    for (const id of ['users.login', 'users.email', 'posts.slug', 'terms.slug']) {
        const r = status.find((x: any) => x.id === id);
        assert.strictEqual(r.enforced, false, `${c.engine}: ${id} is reported as not enforced`);
        assert.strictEqual(r.duplicateGroups, 1, `${c.engine}: ${id} has exactly one duplicated value`);
    }
    const emails = await integrity.listDuplicates('users.email', {}, c.q, c.engine);
    assert.strictEqual(emails.length, 1);
    assert.deepStrictEqual(emails[0].rows.map((r: any) => r.user_login).sort(), ['casey', 'morgan'], `${c.engine}: the screen shows both accounts`);
    const slugs = await integrity.listDuplicates('posts.slug', {}, c.q, c.engine);
    assert.strictEqual(slugs[0].rows.length, 2, `${c.engine}: the page and the post sharing a slug are not a duplicate`);

    // 3. The next boot tries again — still waiting while the duplicates are there.
    await runSchemaMigrations(c.db, c.isAsync, c.driverName, rules);
    assert.deepStrictEqual(await recorded(c), [], `${c.engine}: still pending on the next boot`);

    // 4. An administrator resolves them; the next run builds every index and records the migrations.
    await c.q.run("UPDATE users SET user_login = 'twin-2' WHERE user_email = 'twin-b@example.com'");
    await c.q.run("UPDATE users SET user_email = 'same+dup@example.com' WHERE user_login = 'morgan'");
    const pages = await c.q.all("SELECT id FROM posts WHERE post_name = 'about' AND post_type = 'page' ORDER BY id");
    await c.q.run("UPDATE posts SET post_name = 'about-2' WHERE id = ?", [pages[1].id]);
    const terms = await c.q.all("SELECT term_id FROM terms WHERE slug = 'news' ORDER BY term_id");
    await c.q.run("UPDATE terms SET slug = 'news-2' WHERE term_id = ?", [terms[1].term_id]);

    await runSchemaMigrations(c.db, c.isAsync, c.driverName, rules);
    assert.deepStrictEqual(await recorded(c), RULE_MIGRATIONS.filter((id) => c.engine === 'mysql' || id !== '0020_mysql_unique_email_slug').sort(), `${c.engine}: every unique-rule migration is recorded once the duplicates are gone`);
    for (const r of await integrity.uniqueIntegrityStatus(c.q, c.engine)) assert.ok(r.enforced, `${c.engine}: ${r.id} enforced after the clean-up`);

    // 5. The database itself now refuses a new duplicate of each rule.
    const refuses = async (label: string, fn: () => Promise<any>) => {
        let err: any = null;
        try { await fn(); } catch (e) { err = e; }
        assert.ok(err && isUniqueViolation(err), `${c.engine}: ${label} is refused by the database (${err && err.message})`);
    };
    await refuses('a second login', () => insertUser(c, 'twin', 'third@example.com'));
    await refuses('an email in another letter case', () => insertUser(c, 'riley', 'TWIN-A@example.com'));
    await refuses('a second page slug', () => insertPost(c, 'about', 'page'));
    await refuses('a second term slug', () => insertTerm(c, 'news'));
}

test('unique rules on SQLite: migrations wait for duplicates, then enforce', async (t: any) => {
    const c = await sqliteCtx(t);
    if (!c) return;
    try { await suite(c); } finally { await c.close(); }
});

test('unique rules on Postgres (real): migrations wait for duplicates, then enforce', async (t: any) => {
    const c = await pgCtx(t);
    if (!c) return;
    try { await suite(c); } finally { await c.close(); }
});

test('unique rules on MySQL/MariaDB (real): migrations wait for duplicates, then enforce', async (t: any) => {
    const c = await mysqlCtx(t);
    if (!c) return;
    try { await suite(c); } finally { await c.close(); }
});
