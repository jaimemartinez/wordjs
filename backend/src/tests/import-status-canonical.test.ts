/**
 * AN IMPORTED STATUS IS ONE OF THE STATUSES THE SITE'S CHECKS COMPARE AGAINST — ON EVERY ENGINE.
 *
 * POST/PUT /posts accept only the exact statuses of WRITABLE_POST_STATUSES, but the two importers stored
 * theirs verbatim: the WordPress importer `<wp:status>`, the site import (and with it the logical backup
 * restore) the bundle's `status`. Every read decision is an exact JavaScript comparison (`=== 'publish'`,
 * the published family), while `posts.post_status` is compared by MySQL/MariaDB without regard to case,
 * accents, zero-weight characters or trailing spaces. So an imported `Publish` was unpublished to
 * `GET /posts/:id` (and to everything that asks canReadPostRecord) while `WHERE post_status = 'publish'`
 * listed it — with its comments — on MySQL; `inherit` or a plugin's own status (`wc-completed`) was a
 * state no check of this site knows; and `Trash` walked past the importer's trash skip.
 *
 * The importers now fold the value (core/post-capabilities canonicalImportedPostStatus): case and
 * surrounding space ignored, a writable status is that status, `trash` is trash (skipped by the WXR
 * importer as before), anything else is `draft`. Driven through the REAL importers against a REAL
 * database, and the outcome is read back twice: the row as stored, and what an anonymous reader gets from
 * the real GET /posts/:id.
 *
 * MUTATION PROOF: store `<wp:status>` / the bundle's `status` verbatim again and `Publish` is stored as
 * `Publish` (the anonymous read of an entry the WordPress site had published answers 404), `inherit` and
 * `wc-completed` are stored as such, and the `Trash` item is imported.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-import-status-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const request = require('supertest');

const B = config.api.prefix;
const app = express();
app.use(express.json());
app.use(B, require('../routes'));

let dbAsync: any;
let adminId = 0;

async function rowBySlug(slug: string, type = 'post'): Promise<{ id: number; post_status: string } | undefined> {
    return dbAsync.get('SELECT id, post_status FROM posts WHERE post_name = ? AND post_type = ?', [slug, type]);
}

/** What an anonymous visitor gets for this entry from the real read route. */
async function anonymousRead(id: number): Promise<number> {
    return (await request(app).get(`${B}/posts/${id}`)).status;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    const r = await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        ['admin', 'x', 'admin@example.com', 'Administrator']);
    adminId = Number(r.lastID);
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [adminId]);
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('the WordPress importer folds <wp:status> onto the writable set', () => {
    // slug -> [the <wp:status> the export carries, the status the row must hold (null: not imported)]
    const CASES: Record<string, [string, string | null]> = {
        'wxr-st-plain': ['publish', 'publish'],              // control: what WordPress itself writes
        'wxr-st-case': ['Publish', 'publish'],
        'wxr-st-upper-private': ['PRIVATE', 'private'],
        'wxr-st-pending': ['Pending', 'pending'],
        'wxr-st-inherit': ['inherit', 'draft'],              // a lifecycle-internal status
        'wxr-st-plugin': ['wc-completed', 'draft'],          // a status of a plugin this site does not have
        'wxr-st-zero-width': ['publish​', 'draft'],     // MySQL ignores the U+200B; JavaScript does not
        'wxr-st-trash': ['Trash', null],                     // trashed: skipped, under any case
    };

    before(async () => {
        const items = Object.entries(CASES).map(([slug, [status]], i) => `
    <item>
      <title>${slug}</title>
      <dc:creator><![CDATA[admin]]></dc:creator>
      <content:encoded><![CDATA[<p>${slug} body</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>${900 + i}</wp:post_id>
      <wp:post_name>${slug}</wp:post_name>
      <wp:post_type>post</wp:post_type>
      <wp:status>${status}</wp:status>
      <wp:post_parent>0</wp:post_parent>
    </item>`).join('');
        const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Statuses</title>
    <wp:wxr_version>1.2</wp:wxr_version>${items}
  </channel>
</rss>`;
        const { importWxr } = require('../core/wxr-import');
        await importWxr(xml, { defaultAuthorId: adminId, media: 'link' });
    });

    for (const [slug, [status, expected]] of Object.entries(CASES)) {
        it(`<wp:status>${JSON.stringify(status)}</wp:status> is stored as ${expected === null ? 'nothing (skipped)' : JSON.stringify(expected)}`, async () => {
            const row = await rowBySlug(slug);
            if (expected === null) {
                assert.strictEqual(row, undefined, `${slug}: a trashed item was imported as ${row && JSON.stringify(row.post_status)}`);
                return;
            }
            if (!row) return assert.fail(`${slug}: not imported`);
            assert.strictEqual(row.post_status, expected, `${slug}: stored ${JSON.stringify(row.post_status)}`);
        });
    }

    it('what the WordPress site published is public here, and nothing else is', async () => {
        for (const slug of ['wxr-st-plain', 'wxr-st-case']) {
            const row = await rowBySlug(slug);
            assert.strictEqual(await anonymousRead((row as any).id), 200, `${slug}: a published entry is unreadable`);
        }
        for (const slug of ['wxr-st-upper-private', 'wxr-st-pending', 'wxr-st-inherit', 'wxr-st-plugin', 'wxr-st-zero-width']) {
            const row = await rowBySlug(slug);
            assert.notStrictEqual(await anonymousRead((row as any).id), 200, `${slug}: an unpublished entry was served to an anonymous reader`);
        }
    });
});

describe('the site import (and the logical restore) folds `status` the same way', () => {
    let importSite: any;

    before(async () => {
        ({ importSite } = require('../core/import-export'));
        const results = await importSite({
            content: {
                posts: [
                    { id: 1, slug: 'site-st-case', title: 'Case', content: 'x', excerpt: '', status: 'Publish' },
                    { id: 2, slug: 'site-st-inherit', title: 'Inherit', content: 'x', excerpt: '', status: 'inherit' },
                    { id: 3, slug: 'site-st-absent', title: 'Absent', content: 'x', excerpt: '' },
                    { id: 4, slug: 'site-st-plain', title: 'Plain', content: 'x', excerpt: '', status: 'publish' },
                ],
                pages: [
                    { id: 5, slug: 'site-pg-private', title: 'Private page', content: 'x', status: 'PRIVATE' },
                    { id: 6, slug: 'site-pg-trailing', title: 'Trailing', content: 'x', status: 'publish ' },
                ],
            },
        });
        assert.deepStrictEqual(results.errors, []);
    });

    it('a created post or page holds the canonical status', async () => {
        assert.strictEqual((await rowBySlug('site-st-case'))?.post_status, 'publish');
        assert.strictEqual((await rowBySlug('site-st-inherit'))?.post_status, 'draft');
        assert.strictEqual((await rowBySlug('site-st-absent'))?.post_status, 'draft');
        assert.strictEqual((await rowBySlug('site-st-plain'))?.post_status, 'publish', 'control');
        assert.strictEqual((await rowBySlug('site-pg-private', 'page'))?.post_status, 'private');
        assert.strictEqual((await rowBySlug('site-pg-trailing', 'page'))?.post_status, 'publish');
        assert.strictEqual(await anonymousRead((await rowBySlug('site-st-case') as any).id), 200);
        assert.notStrictEqual(await anonymousRead((await rowBySlug('site-st-inherit') as any).id), 200);
    });

    it('updateExisting folds it too, and a bundle without a status leaves the column alone', async () => {
        await importSite({ content: {
            posts: [{ id: 1, slug: 'site-st-plain', title: 'Plain', content: 'y', excerpt: '', status: 'DRAFT' }],
            pages: [{ id: 5, slug: 'site-pg-private', title: 'Private page', content: 'y', status: 'Pending' }],
        } }, { updateExisting: true });
        assert.strictEqual((await rowBySlug('site-st-plain'))?.post_status, 'draft');
        assert.strictEqual((await rowBySlug('site-pg-private', 'page'))?.post_status, 'pending');

        await importSite({ content: {
            posts: [{ id: 1, slug: 'site-st-case', title: 'Case', content: 'z', excerpt: '' }],
        } }, { updateExisting: true });
        assert.strictEqual((await rowBySlug('site-st-case'))?.post_status, 'publish', 'no status in the bundle: unchanged');
    });
});
