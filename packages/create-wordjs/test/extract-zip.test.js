'use strict';

// The installer's ZIP extraction, exercised for real.
//
// `extractZip` is the one place create-wordjs touches adm-zip: it unpacks the release bundle a new
// user just downloaded into the directory that becomes their site. These build small bundles the way
// scripts/make-release.js builds the real one (adm-zip addLocalFolder + writeZip, files at the ZIP
// root), extract them through the REAL function, and compare every byte — so an adm-zip bump that
// changes extraction shows up here rather than on a user's first `npx create-wordjs`.

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const { extractZip } = require('../index.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'create-wordjs-extract-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
const freshDir = (label) => {
    const dir = path.join(scratch, `${label}-${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

// A miniature bundle: the files the installer reads, nested folders, a name with a space, an empty
// file, and a large compressible file plus random bytes so both deflate and stored entries occur.
const BUNDLE = {
    'package.json': JSON.stringify({ name: 'wordjs', version: '0.0.0-test', scripts: { 'release:install': 'node -e 0' } }, null, 2),
    'backend/dist/index.js': 'module.exports = 42;\n',
    'backend/package.json': '{ "name": "wordjs-backend" }\n',
    'frontend/.next/static/chunks/app page.js': 'console.log("chunk");\n',
    'gateway/src/empty.txt': '',
    'docs/big.txt': 'WordJS release bundle line\n'.repeat(20000),
    'assets/random.bin': crypto.randomBytes(4096),
};

function writeTree(root, files) {
    for (const [rel, content] of Object.entries(files)) {
        const p = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
}

// make-release.js: `new AdmZip(); zip.addLocalFolder(sourceDir); zip.writeZip(outPath)`.
function bundleZip(files, { wrapper } = {}) {
    const src = freshDir('src');
    writeTree(wrapper ? path.join(src, wrapper) : src, files);
    const zipPath = path.join(freshDir('zip'), 'wordjs-v0.0.0.zip');
    const zip = new AdmZip();
    zip.addLocalFolder(src);
    zip.writeZip(zipPath);
    return zipPath;
}

function assertTree(root, files) {
    for (const [rel, content] of Object.entries(files)) {
        const p = path.join(root, ...rel.split('/'));
        assert.ok(fs.existsSync(p), `${rel} was not extracted`);
        assert.ok(fs.readFileSync(p).equals(Buffer.from(content)), `${rel} came out different`);
    }
}

test('a bundle shaped like make-release.js output extracts byte-for-byte', () => {
    const target = freshDir('site');
    extractZip(bundleZip(BUNDLE), target);
    assertTree(target, BUNDLE);
    assert.deepStrictEqual(fs.readdirSync(target).sort(), ['assets', 'backend', 'docs', 'frontend', 'gateway', 'package.json']);
});

test('a bundle wrapped in a single top-level folder is flattened into the target', () => {
    const target = freshDir('site');
    extractZip(bundleZip(BUNDLE, { wrapper: 'wordjs-v0.0.0' }), target);
    assertTree(target, BUNDLE);
    assert.ok(!fs.existsSync(path.join(target, 'wordjs-v0.0.0')), 'the wrapper folder was left behind');
});

test('an entry that climbs out of the target is not written outside it', () => {
    const zip = new AdmZip();
    zip.addFile('package.json', Buffer.from('{}'));
    zip.addFile('../escaped.txt', Buffer.from('outside'));
    const zipPath = path.join(freshDir('zip'), 'slip.zip');
    zip.writeZip(zipPath);
    const target = freshDir('site');
    try { extractZip(zipPath, target); } catch { /* refusing is as good as containing */ }
    assert.ok(!fs.existsSync(path.join(path.dirname(target), 'escaped.txt')), 'a ../ entry was written outside the target');
});

test('an archive that names the same entry twice is refused (adm-zip >= 0.6.1)', () => {
    // Two different files under one name: adm-zip 0.6.0 indexed the last but extracted both in list
    // order, so the content that landed on disk was not the content a getEntry() check would read.
    // Built with two same-length names, then the second renamed in place in BOTH its local and its
    // central header — every other byte, CRCs included, stays valid.
    const zip = new AdmZip();
    zip.addFile('package.json', Buffer.from('{"name":"first"}'));
    zip.addFile('package.jsoX', Buffer.from('{"name":"second"}'));
    const buf = zip.toBuffer();
    let renamed = 0;
    for (let i = buf.indexOf('package.jsoX'); i !== -1; i = buf.indexOf('package.jsoX', i + 1)) {
        buf.write('package.json', i, 'latin1');
        renamed++;
    }
    assert.strictEqual(renamed, 2, 'expected the name once in the local header and once in the central directory');
    const zipPath = path.join(freshDir('zip'), 'dup.zip');
    fs.writeFileSync(zipPath, buf);
    assert.throws(() => extractZip(zipPath, freshDir('site')), /duplicate|DUPLICATE/i);
});
