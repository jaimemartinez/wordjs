/**
 * QA M3-17 — names made from non-ASCII text.
 *   · An upload's stored file name: `ñandú 漢字 😀 שלום.png` was stored as `--and------------------------<uuid>.png`.
 *   · A menu's slug: `[M3]r1 Menú 🚀 שלום` became `-m3-r1-men-`, and a second menu of the same name got the
 *     SAME slug (term slugs are unique in the database now, so it would not even insert).
 */
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-m3-17-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const { uploadStem } = require('../core/upload-names');

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

test('upload names: accents fold, other scripts collapse to one dash, nothing is left dangling', () => {
    assert.strictEqual(uploadStem('ñandú 漢字 😀 שלום'), 'nandu');
    assert.strictEqual(uploadStem('Café  au   lait!!'), 'cafe-au-lait');
    assert.strictEqual(uploadStem('--Résumé--'), 'resume');
    assert.strictEqual(uploadStem('photo_2026'), 'photo_2026');
    assert.strictEqual(uploadStem('漢字 😀 שלום'), 'file', 'nothing ASCII left: a stem that is not a row of dashes');
    assert.strictEqual(uploadStem(''), 'file');
    const long = uploadStem('a'.repeat(79) + ' tail');
    assert.ok(long.length <= 80 && !long.endsWith('-'), long);
    // ASCII only: the stored name is also the S3 object key (core/media-storage isOffloadablePath).
    assert.match(uploadStem('Ünïcødé — ñ 😀'), /^[a-z0-9_-]+$/);
});

test('menu slugs follow the term rules: no stray dashes, accents folded, a second same-name menu gets -2', async () => {
    const { Menu } = require('../models/Menu');
    const a = await Menu.create({ name: '[M3]r1 Menú 🚀 שלום' });
    assert.ok(!a.slug.startsWith('-') && !a.slug.endsWith('-'), a.slug);
    assert.match(a.slug, /menu/);
    const b = await Menu.create({ name: '[M3]r1 Menú 🚀 שלום' });
    assert.notStrictEqual(b.slug, a.slug, 'two menus never share a slug');
    assert.strictEqual(b.slug, `${a.slug}-2`);
    const only = await Menu.create({ name: '🚀 שלום' });
    assert.ok(only.slug && /^[a-z0-9-]+$/.test(only.slug), only.slug);
    // A slug set later is cleaned and kept unique as well.
    await Menu.update(only.id ?? only.termId, { slug: a.slug });
    const renamed = await Menu.findById(only.id ?? only.termId);
    assert.notStrictEqual(renamed.slug, a.slug);
    await Menu.update(only.id ?? only.termId, { slug: '  Main Menú ' });
    assert.strictEqual((await Menu.findById(only.id ?? only.termId)).slug, 'main-menu');
});
