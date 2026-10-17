'use strict';

// The upgrade overlay (`copyMerge`) against the paths that hold a site's own state.
//
// `create-wordjs upgrade` copies a release bundle over an existing site. Whatever the bundle carries
// under a preserved path must not reach the site: not by replacing a file the site has, and not by
// ADDING one next to them. A bundle once carried a stray file in backend/backups/, and the overlay put
// it into every upgraded site's backup list, where restoring it would overwrite that site's database.
// These build a small bundle and a small site on disk, run the real overlay and read what is there.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { copyMerge, PRESERVE_ON_UPGRADE } = require('../index.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'create-wordjs-upgrade-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
function tree(label, files) {
    const root = path.join(scratch, `${label}-${++seq}`);
    for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
    }
    fs.mkdirSync(root, { recursive: true });
    return root;
}

const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));

test('backend/backups is on the preserve-list', () => {
    assert.ok(PRESERVE_ON_UPGRADE.has('backend/backups'));
});

test('a backup inside the bundle is neither added to the site nor written over the site\'s own', () => {
    const bundle = tree('bundle', {
        'backend/dist/index.js': 'module.exports = "new";\n',
        'backend/backups/backup-from-the-bundle.zip': 'not this site',
        'backend/backups/backup-site-own.zip': 'not this site either',
    });
    const site = tree('site', {
        'backend/dist/index.js': 'module.exports = "old";\n',
        'backend/backups/backup-site-own.zip': 'the site\'s own backup',
    });

    copyMerge(bundle, site);

    // THE CONTROL: the overlay ran, so code outside the preserve-list was replaced.
    assert.strictEqual(read(site, 'backend/dist/index.js'), 'module.exports = "new";\n');
    assert.strictEqual(exists(site, 'backend/backups/backup-from-the-bundle.zip'), false,
        'a backup from the bundle was added to the site');
    assert.strictEqual(read(site, 'backend/backups/backup-site-own.zip'), 'the site\'s own backup',
        'the site\'s own backup was overwritten');
    assert.deepStrictEqual(fs.readdirSync(path.join(site, 'backend', 'backups')), ['backup-site-own.zip']);
});

test('a site without a backups folder does not get one from the bundle', () => {
    const bundle = tree('bundle', {
        'backend/dist/index.js': 'module.exports = "new";\n',
        'backend/backups/backup-from-the-bundle.zip': 'not this site',
    });
    const site = tree('site', { 'backend/dist/index.js': 'module.exports = "old";\n' });

    copyMerge(bundle, site);

    assert.strictEqual(read(site, 'backend/dist/index.js'), 'module.exports = "new";\n');
    assert.strictEqual(exists(site, 'backend/backups'), false);
});
