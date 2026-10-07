'use strict';

// The installer's integrity rules, exercised directly and through the real CLI.
//
// What the bundle is checked against before it is extracted (SHA-256 from the release's .sha256
// asset or a --sha256 pin), which --zip sources are accepted at all (https:// or a local file — never
// plain http://), and the join subcommand's refusal to enroll without a CA pin. The CLI cases run
// offline: every one of them must stop (or finish) before anything touches the network.

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const { normalizeSha256, parseChecksumFile, classifyZipSource, sha256File, pickBundleAsset, pickChecksumAsset } = require('../index.js');

const CLI = path.join(__dirname, '..', 'index.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'create-wordjs-integrity-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const HEX = 'ab'.repeat(32);

function run(args, cwd = scratch) {
    // No proxy, no network: these cases must all be decided locally.
    return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HTTPS_PROXY: '', https_proxy: '' } });
}

function bundle() {
    const zip = new AdmZip();
    zip.addFile('package.json', Buffer.from(JSON.stringify({
        name: 'wordjs', version: '0.0.0-test',
        scripts: { 'release:install': 'node -e 0', 'start:mono': 'node -e 0' },
    })));
    zip.addFile('backend/dist/index.js', Buffer.from('module.exports = 1;\n'));
    const zipPath = path.join(fs.mkdtempSync(path.join(scratch, 'zip-')), 'wordjs-v0.0.0.zip');
    zip.writeZip(zipPath);
    return zipPath;
}

test('normalizeSha256 accepts 64 hex chars (any case, colon form) and nothing else', () => {
    assert.strictEqual(normalizeSha256(HEX.toUpperCase()), HEX);
    assert.strictEqual(normalizeSha256(HEX.match(/../g).join(':')), HEX);
    assert.strictEqual(normalizeSha256(HEX.slice(1)), null);
    assert.strictEqual(normalizeSha256(HEX + '0'), null);
    assert.strictEqual(normalizeSha256('z'.repeat(64)), null);
    assert.strictEqual(normalizeSha256(''), null);
    assert.strictEqual(normalizeSha256(true), null);
});

test('the checksum asset is the one named after the picked bundle, and the bundle pick ignores it', () => {
    const assets = [
        { name: 'wordjs-seo-tools-1.0.0.zip' },
        { name: 'wordjs-seo-tools-1.0.0.zip.sha256' },
        { name: 'wordjs-v2.4.0.zip.sha256' },
        { name: 'wordjs-v2.4.0.zip' },
    ];
    const bundle = pickBundleAsset(assets, 'v2.4.0');
    assert.strictEqual(bundle.name, 'wordjs-v2.4.0.zip');
    assert.strictEqual(pickChecksumAsset(assets, bundle.name).name, 'wordjs-v2.4.0.zip.sha256');
    // A release from before the checksum asset existed: no match, and the caller warns instead.
    assert.strictEqual(pickChecksumAsset([{ name: 'wordjs-v2.3.0.zip' }], 'wordjs-v2.3.0.zip'), null);
    assert.strictEqual(pickChecksumAsset(undefined, 'wordjs-v2.3.0.zip'), null);
    // The loose fallback (a single wordjs-*.zip) is not confused by a .sha256 next to it.
    assert.strictEqual(pickBundleAsset([{ name: 'wordjs-x.zip' }, { name: 'wordjs-x.zip.sha256' }], 'v9').name, 'wordjs-x.zip');
});

test('parseChecksumFile reads sha256sum output for the named asset only', () => {
    assert.strictEqual(parseChecksumFile(`${HEX}  wordjs-v2.4.0.zip\n`, 'wordjs-v2.4.0.zip'), HEX);
    assert.strictEqual(parseChecksumFile(`${HEX} *wordjs-v2.4.0.zip\r\n`, 'wordjs-v2.4.0.zip'), HEX, 'binary-mode marker');
    assert.strictEqual(parseChecksumFile(`${HEX.toUpperCase()}\n`, 'wordjs-v2.4.0.zip'), HEX, 'a bare digest');
    // A checksum for ANOTHER file must not vouch for this one: fail closed (null), never fall through.
    assert.strictEqual(parseChecksumFile(`${HEX}  wordjs-seo-tools-1.0.0.zip\n`, 'wordjs-v2.4.0.zip'), null);
    assert.strictEqual(parseChecksumFile('not a checksum\n', 'wordjs-v2.4.0.zip'), null);
    assert.strictEqual(parseChecksumFile('', 'wordjs-v2.4.0.zip'), null);
});

test('classifyZipSource: https URLs and files are accepted; http and other schemes are refused', () => {
    assert.deepStrictEqual(classifyZipSource('https://example.com/wordjs.zip'), { kind: 'url', url: 'https://example.com/wordjs.zip' });
    assert.strictEqual(classifyZipSource('HTTPS://example.com/w.zip').kind, 'url');
    assert.deepStrictEqual(classifyZipSource('http://example.com/wordjs.zip'), { kind: 'refused', scheme: 'http' });
    assert.strictEqual(classifyZipSource('ftp://example.com/w.zip').kind, 'refused');
    assert.strictEqual(classifyZipSource('file:///tmp/w.zip').kind, 'refused');
    assert.strictEqual(classifyZipSource('./wordjs.zip').kind, 'file');
    assert.strictEqual(classifyZipSource('/srv/wordjs.zip').kind, 'file');
    assert.strictEqual(classifyZipSource('C:\\Downloads\\wordjs.zip').kind, 'file');
});

test('sha256File hashes the file content', async () => {
    const p = path.join(scratch, 'h.bin');
    fs.writeFileSync(p, 'hello');
    assert.strictEqual(await sha256File(p), crypto.createHash('sha256').update('hello').digest('hex'));
});

test('the CLI refuses a plain http:// --zip URL before downloading anything', () => {
    const r = run(['site-http', '--zip', 'http://127.0.0.1:9/wordjs.zip', '--no-start']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /Refusing --zip http:\/\/.*only https:\/\/ URLs and local file paths/);
});

test('the CLI rejects a malformed --sha256', () => {
    const r = run(['site-bad', '--zip', 'x.zip', '--sha256', 'deadbeef']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--sha256 must be a 64-character hex SHA-256/);
});

test('a --zip whose SHA-256 differs from --sha256 is refused and NOT extracted', () => {
    const zipPath = bundle();
    const r = run(['site-mismatch', '--zip', zipPath, '--sha256', HEX, '--no-start']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /SHA-256 mismatch for the release ZIP \(checked against --sha256\)/);
    assert.deepStrictEqual(fs.readdirSync(path.join(scratch, 'site-mismatch')), [], 'nothing may be extracted from a mismatching ZIP');
});

test('a --zip whose SHA-256 matches --sha256 is installed', async () => {
    const zipPath = bundle();
    const digest = await sha256File(zipPath);
    const r = run(['site-match', '--zip', zipPath, '--sha256', digest.toUpperCase(), '--no-start']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /SHA-256 verified \(--sha256\)/);
    assert.ok(fs.existsSync(path.join(scratch, 'site-match', 'backend', 'dist', 'index.js')));
});

test('join refuses to run without --ca-hash (before downloading anything)', () => {
    const r = run(['join', 'backend', 'node-a', '--gateway', '127.0.0.1', '--token', 'wjc.backend.x']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--ca-hash <sha256> is required for join/);
    assert.match(r.stderr, /--insecure-skip-ca-verify/);
    assert.ok(!fs.existsSync(path.join(scratch, 'node-a')), 'join must stop before scaffolding');
});

test('join rejects a malformed --ca-hash', () => {
    const r = run(['join', 'backend', 'node-b', '--gateway', '127.0.0.1', '--token', 't', '--ca-hash', 'nope']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--ca-hash must be the 64-character hex CA fingerprint/);
});

test('join --insecure-skip-ca-verify is accepted, with a loud warning', () => {
    // Pointed at a local file that does not exist, so it stops right after the CA decision.
    const r = run(['join', 'backend', 'node-c', '--gateway', '127.0.0.1', '--token', 't',
        '--insecure-skip-ca-verify', '--zip', path.join(scratch, 'missing.zip')]);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--insecure-skip-ca-verify: enrolling WITHOUT verifying the gateway/);
    assert.match(r.stderr, /ZIP not found/);
});
