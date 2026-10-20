'use strict';

// The dependency install when the prebuilt better-sqlite3 download times out.
//
// On a server without a compiler, `npm run release:install` ended in a raw `gyp ERR!` whenever
// prebuild-install's download timed out, and the operator was left with a half-made directory the
// installer then refused to touch ("already exists and is not empty"). These drive the real CLI against
// a local bundle whose `release:install` fails exactly that way a given number of times, and pin: the
// install is retried with backoff; when it keeps failing the message says what happened and what to do;
// the config (and with --systemd the unit) is still written; the same command run again resumes.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const INDEX = path.join(__dirname, '..', 'index.js');
const cli = require(INDEX);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'create-wordjs-retry-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// A release:install that fails the way the real one does on a timed-out prebuilt download, until it
// has run FAKE_INSTALL_FAILS times. It counts its runs in a file OUTSIDE the site.
const FAKE_INSTALL = `
const fs = require('fs');
const counter = process.env.FAKE_INSTALL_COUNTER;
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(n));
if (n <= Number(process.env.FAKE_INSTALL_FAILS)) {
    console.error('[backend] prebuild-install warn install Request timed out');
    console.error('[backend] gyp ERR! stack Error: not found: make');
    process.exit(1);
}
fs.mkdirSync('node_modules', { recursive: true });
console.log('installed');
`;

function bundleZip() {
    const zip = new AdmZip();
    zip.addFile('package.json', Buffer.from(JSON.stringify({
        name: 'wordjs', version: '9.9.9',
        scripts: { 'release:install': 'node fake-install.js', 'start:mono': 'node -e 0' },
    })));
    zip.addFile('fake-install.js', Buffer.from(FAKE_INSTALL));
    zip.addFile('backend/wordjs-config.json', Buffer.from('{}'));
    zip.addFile('gateway/README.md', Buffer.from('gateway'));
    const p = path.join(scratch, 'wordjs-v9.9.9.zip');
    zip.writeZip(p);
    return p;
}
const ZIP = bundleZip();

let seq = 0;
function create(args, fails, counter) {
    const r = spawnSync(process.execPath, [INDEX, ...args, '--zip', ZIP, '--no-start'], {
        cwd: scratch,
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, CREATE_WORDJS_RETRY_BASE_MS: '1', FAKE_INSTALL_FAILS: String(fails), FAKE_INSTALL_COUNTER: counter },
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const runs = (counter) => Number(fs.readFileSync(counter, 'utf8'));

test('a timed-out prebuilt download is retried with backoff until the install works', async () => {
    const counter = path.join(scratch, `count-${++seq}`);
    const site = `site-${seq}`;
    const r = create([site], 2, counter);
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(runs(counter), 3, 'two failed attempts and the one that worked');
    assert.match(r.out, /attempt 1 of 3 failed: the prebuilt binary download timed out/);
    assert.match(r.out, /Retrying the dependency install .*attempt 3 of 3/);
    assert.match(r.out, /WordJS scaffolded into/);
    assert.ok(fs.existsSync(path.join(scratch, site, 'node_modules')));
    assert.strictEqual(fs.existsSync(path.join(scratch, site, cli.INCOMPLETE_MARKER)), false, 'a finished install leaves no marker');
});

test('when every attempt fails: a plain explanation, the config is written, and the same command resumes', async () => {
    const counter = path.join(scratch, `count-${++seq}`);
    const site = `site-${seq}`;
    const first = create([site], 3, counter);
    assert.strictEqual(first.status, 1, first.out);
    assert.strictEqual(runs(counter), 3);
    assert.match(first.out, /The runtime dependencies could not be installed \(3 attempts\)/);
    assert.match(first.out, /prebuilt native module \(better-sqlite3\) timed out/);
    assert.match(first.out, /npm run release:install/);
    assert.match(first.out, /build-essential python3/);
    // Everything but node_modules is in place for the next attempt.
    assert.ok(fs.existsSync(path.join(scratch, site, cli.INCOMPLETE_MARKER)));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(scratch, site, 'gateway', 'gateway-config.json'), 'utf8')), { ssl: true });
    assert.strictEqual(fs.existsSync(path.join(scratch, site, 'node_modules')), false);

    // The same command again: no "already exists and is not empty", no second extract — just the install.
    fs.writeFileSync(path.join(scratch, site, 'backend', 'wordjs-config.json'), '{"kept":true}');
    const again = create([site], 3, counter);
    assert.strictEqual(again.status, 0, again.out);
    assert.match(again.out, /Resuming the unfinished install/);
    assert.doesNotMatch(again.out, /Extracting into/);
    assert.strictEqual(runs(counter), 4);
    assert.strictEqual(fs.readFileSync(path.join(scratch, site, 'backend', 'wordjs-config.json'), 'utf8'), '{"kept":true}');
    assert.strictEqual(fs.existsSync(path.join(scratch, site, cli.INCOMPLETE_MARKER)), false);
});

test('a non-empty directory without the marker is still refused', () => {
    const site = path.join(scratch, `site-${++seq}`);
    fs.mkdirSync(site);
    fs.writeFileSync(path.join(site, 'mine.txt'), 'not a WordJS site');
    const r = create([path.basename(site)], 0, path.join(scratch, `count-${seq}`));
    assert.strictEqual(r.status, 1);
    assert.match(r.out, /already exists and is not empty/);
});

test('--systemd: the unit is staged even when the install keeps failing', { skip: process.platform !== 'linux' && 'systemd units are Linux-only' }, () => {
    const counter = path.join(scratch, `count-${++seq}`);
    const site = path.join(scratch, `site-${seq}`);
    const r = create([site, '--systemd', '--port', '8080'], 3, counter);
    assert.strictEqual(r.status, 1, r.out);
    const m = r.out.match(/systemd unit staged: (\S+)/);
    assert.ok(m, r.out);
    assert.match(fs.readFileSync(m[1], 'utf8'), /Environment=PORT=8080/);
    assert.match(r.out, /could not be installed \(3 attempts\)/);
});

test('classification: timeouts, compiler failures and other errors are told apart', () => {
    assert.deepStrictEqual(cli.classifyInstallFailure('prebuild-install warn install Request timed out\ngyp ERR! stack'), { prebuiltTimeout: true, nativeBuild: true, network: true });
    assert.deepStrictEqual(cli.classifyInstallFailure('gyp ERR! find Python'), { prebuiltTimeout: false, nativeBuild: true, network: false });
    assert.deepStrictEqual(cli.classifyInstallFailure('npm ERR! code ETIMEDOUT'), { prebuiltTimeout: false, nativeBuild: false, network: true });
    assert.deepStrictEqual(cli.classifyInstallFailure('npm ERR! code ENOSPC'), { prebuiltTimeout: false, nativeBuild: false, network: false });
    assert.doesNotMatch(cli.installFailureAdvice('my-site', { prebuiltTimeout: false, nativeBuild: false, network: false }, 3), /better-sqlite3/);
});

test('the waits grow between attempts', async () => {
    const waits = [];
    const dir = path.join(scratch, `fake-${++seq}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'release:install': 'node -e "process.exit(1)"' } }));
    const r = await cli.installDependencies(dir, { attempts: 3, baseDelayMs: 100, sleep: async (ms) => { waits.push(ms); } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.attempts, 3);
    assert.deepStrictEqual(waits, [100, 300]);
});
