/**
 * The site locale, where it is RENDERED: RSS `<language>` (and, by the same corpus, `<html lang>`).
 *
 * THE BUG THIS PINS. `WPLANG` stores a WordPress-style LOCALE — `en_US`, underscore — because
 * core/i18n keys the translation files by exactly that string. Install seeding started writing
 * `WPLANG: 'en_US'` (core/options) and routes/seo handed the option straight to the feed generator,
 * so a fresh install emitted `<language>en_US</language>`. A language tag is BCP 47: subtags are
 * separated by a HYPHEN, and no feed validator accepts the underscore form. Before the seed existed
 * the option was absent and the route's own `'en'` default was valid by accident — so seeding a
 * correct locale made the output invalid, which is the kind of regression a fixture never shows.
 *
 * Three properties are asserted here:
 *   1. a SEEDED install (the real initDefaultOptions, not a hand-written option) emits a valid tag;
 *   2. the stored option is NOT rewritten — the underscore spelling is what the translation loader
 *      needs, so the conversion has to live at the render boundary, not in the data;
 *   3. the conversion is fail-closed: a locale that the write validator would have refused (an older
 *      install, a direct DB write, a plugin) becomes `en` instead of reaching the markup.
 *
 * PARITY. The locale→tag table below is the same corpus as
 * frontend/src/lib/__tests__/documentLanguage.test.ts, which asserts it for `<html lang>`. The two
 * resolvers are separate implementations (separate packages, no shared build), so the shared table is
 * what keeps `<language>` and `<html lang>` from drifting apart. Change one, change the other.
 *
 * Same CWD-sandbox ordering as document-language.test.ts: chdir into a temp root BEFORE requiring
 * anything that resolves paths from the CWD at module load.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-feedlang-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const { toLanguageTag, DEFAULT_LANGUAGE_TAG } = require('../core/language-tag');

/** [ stored WPLANG, rendered language tag ] — shared with the frontend `<html lang>` suite. */
const CORPUS: Array<[string, string]> = [
    ['en_US', 'en-US'],          // what a fresh install seeds
    ['es_ES', 'es-ES'],
    ['pt_BR', 'pt-BR'],
    ['ja', 'ja'],
    ['zh_CN', 'zh-CN'],
    ['ar', 'ar'],
    ['ar_SA', 'ar-SA'],
    ['he_IL', 'he-IL'],
    ['pa_Arab_PK', 'pa-Arab-PK'],
    ['pa_Guru_IN', 'pa-Guru-IN'],
    ['AR-sa', 'ar-SA'],          // hyphen form and casing are canonicalised, not refused
    ['es-419', 'es-419'],
];

/** RFC 5646 as far as WordJS admits it: language [ - script ] [ - region ]. No underscore, ever. */
const VALID_TAG = /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|\d{3}))?$/;

describe('the stored locale becomes a valid language tag', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let updateOption: any;

    const feed = async (): Promise<string> => {
        const res = await request(app).get('/api/v1/seo/feed.xml');
        assert.strictEqual(res.status, 200, res.text);
        return res.text;
    };
    const feedLanguage = async (): Promise<string> => {
        const xml = await feed();
        const m = /<language>([\s\S]*?)<\/language>/.exec(xml);
        if (!m) throw new Error(`the feed must carry a <language> element:\n${xml}`);
        return m[1];
    };
    const optionRow = async (name: string) => {
        const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
        return row ? row.option_value : undefined;
    };

    before(async () => {
        request = require('supertest');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        // The REAL seeding path, not a hand-written option: the defect was introduced by what install
        // seeds, so a test that writes its own WPLANG could not have caught it.
        const options = require('../core/options');
        updateOption = options.updateOption;
        await options.initDefaultOptions(config);

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '1mb' }));
        app.use('/api/v1/seo', require('../routes/seo'));
        app.use('/api/v1/settings', require('../routes/settings'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------ 1. a seeded install

    it('a seeded install emits a VALID <language> in the feed', async () => {
        assert.strictEqual(await optionRow('WPLANG'), 'en_US', 'precondition: install seeds the locale form');

        const language = await feedLanguage();
        assert.strictEqual(language, 'en-US');
        assert.match(language, VALID_TAG);
        assert.ok(!language.includes('_'), 'an underscore is not a BCP 47 subtag separator');
    });

    it('and the SSR layout gets the same tag for <html lang> from the same option', async () => {
        // The `<html lang>` half is rendered by the frontend from this exact payload
        // (frontend/src/lib/documentLanguage.ts, asserted over the corpus below in its own suite).
        // What the backend owes it is the raw locale — which must therefore still be readable here.
        const res = await request(app).get('/api/v1/settings');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.WPLANG, 'en_US');
        assert.strictEqual(toLanguageTag(res.body.WPLANG), 'en-US', 'feed and <html lang> must agree');
    });

    // ------------------------------------------------------------------ 2. the data is not rewritten

    it('does not rewrite the stored option — core/i18n keys the translation files by it', async () => {
        await updateOption('WPLANG', 'es_ES');
        assert.strictEqual(await feedLanguage(), 'es-ES');
        assert.strictEqual(
            await optionRow('WPLANG'), 'es_ES',
            'rendering a tag must not migrate the stored locale: languages/default-es_ES.json is keyed by it',
        );
    });

    it('renders every locale shape the settings API accepts', async () => {
        for (const [stored, tag] of CORPUS) {
            await updateOption('WPLANG', stored);
            const language = await feedLanguage();
            assert.strictEqual(language, tag, `${stored} must render as ${tag}`);
            assert.match(language, VALID_TAG);
        }
    });

    // ------------------------------------------------------------------ 3. fail-closed

    it('falls back to a valid tag for a locale that never went through the validator', async () => {
        // routes/settings refuses all of these, but an option row can predate the validator, arrive
        // from a plugin, or be written straight into the DB. None of it may reach the XML.
        for (const hostile of ['en" onload="x', 'en><lang>', 'en_USA', 'en US', 'e', '../../etc/passwd', '']) {
            await updateOption('WPLANG', hostile);
            const language = await feedLanguage();
            assert.strictEqual(language, DEFAULT_LANGUAGE_TAG, `${JSON.stringify(hostile)} must fall back to en`);
            assert.match(language, VALID_TAG);
        }
    });

    it('is the SAME conversion whether the caller converts or not', () => {
        // routes/seo converts, and generateRssFeed converts again on its way into the markup — the
        // second one is what protects a future caller that forgets. Both must be idempotent.
        const { generateRssFeed } = require('../core/seo-helper');
        for (const [stored, tag] of CORPUS) {
            assert.strictEqual(toLanguageTag(toLanguageTag(stored)), tag, `${stored}: conversion is not idempotent`);
            assert.match(generateRssFeed([], { language: stored }), new RegExp(`<language>${tag}</language>`));
        }
        // A raw option handed to the generator by a future caller is still shaped on the way out.
        assert.match(generateRssFeed([], { language: 'en" onload="x' }), /<language>en<\/language>/);
        assert.match(generateRssFeed([], {}), /<language>en<\/language>/);
    });
});
