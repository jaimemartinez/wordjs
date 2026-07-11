#!/usr/bin/env node
'use strict';

/**
 * create-wordjs — bootstrap a WordJS site with ONE command:
 *
 *     npx create-wordjs my-site
 *
 * What it does:
 *   1. Downloads the latest pre-compiled WordJS release ZIP from GitHub (no build step needed).
 *   2. Extracts it into <dir> and installs the runtime dependencies (npm run release:install).
 *   3. Generates a one-time install token and starts the server (npm run start:mono) with it,
 *      printing a clickable https://localhost:3000/install?token=… URL — the browser install
 *      wizard takes it from there (pick SQLite/PostgreSQL, create your admin, done).
 *
 * Plain Node, no TypeScript. Only runtime dependency: adm-zip (ZIP extraction).
 */

const REPO = 'jaimemartinez/wordjs';

// ---------------------------------------------------------------------------------------------
// Node preflight — same floor as WordJS itself (Next 16 + native modules need >= 20.9). Failing
// here with a clear message beats the cryptic EBADENGINE/native-binding crash mid-install.
// ---------------------------------------------------------------------------------------------
{
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj < 20 || (maj === 20 && min < 9)) {
        console.error(`\n✖ WordJS requires Node.js >= 20.9 — you are running ${process.versions.node}.`);
        console.error('  Install Node 20 LTS or 22 LTS from https://nodejs.org and try again.\n');
        process.exit(1);
    }
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HELP = `
create-wordjs — bootstrap a WordJS site with one command

Usage:
  npx create-wordjs <dir> [options]

Options:
  --zip <path-or-url>   Use a local release ZIP (or a direct ZIP URL) instead of asking GitHub.
  --version <tag>       Install a specific release tag (e.g. v1.0.0) instead of the latest.
  --http                Serve plain HTTP instead of self-signed HTTPS (sets WORDJS_HTTP=1).
  --no-start            Scaffold + install dependencies only; don't start the server.
  -h, --help            Show this help.

Examples:
  npx create-wordjs my-site
  npx create-wordjs my-site --version v1.0.0
  npx create-wordjs my-site --zip ./wordjs-v1.0.0.zip --no-start
`;

function fail(message, hint) {
    console.error(`\n✖ ${message}`);
    if (hint) console.error(`  ${hint}`);
    console.error('');
    process.exit(1);
}

function parseArgs(argv) {
    const opts = { dir: null, zip: null, version: null, http: false, start: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
        else if (a === '--zip') { opts.zip = argv[++i] || fail('--zip needs a value (path or URL to a wordjs-*.zip).'); }
        else if (a === '--version') { opts.version = argv[++i] || fail('--version needs a value (a release tag, e.g. v1.0.0).'); }
        else if (a === '--http') opts.http = true;
        else if (a === '--no-start') opts.start = false;
        else if (a.startsWith('-')) fail(`Unknown option: ${a}`, 'Run with --help to see the available options.');
        else if (!opts.dir) opts.dir = a;
        else fail(`Unexpected extra argument: ${a}`);
    }
    if (!opts.dir) fail('Please specify a directory for your new site.', 'Example: npx create-wordjs my-site');
    if (opts.version && /^\d/.test(opts.version)) opts.version = 'v' + opts.version; // accept "1.0.0" for "v1.0.0"
    return opts;
}

// --- tiny https helpers (plain node:https, no token, redirects followed) -----------------------

function request(url, headers, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'user-agent': 'create-wordjs', ...headers } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                res.resume(); // GitHub release assets redirect to objects.githubusercontent.com
                resolve(request(new URL(res.headers.location, url).toString(), headers, redirectsLeft - 1));
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
    });
}

function readBody(res) {
    return new Promise((resolve, reject) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
    });
}

async function githubJson(url) {
    let res;
    try {
        res = await request(url, { accept: 'application/vnd.github+json' });
    } catch (e) {
        fail(`Could not reach GitHub (${e.message}).`,
            `Check your network — or download the ZIP yourself from https://github.com/${REPO}/releases and re-run with --zip <path-to-zip>.`);
    }
    const body = await readBody(res);
    if (res.statusCode === 403 && res.headers['x-ratelimit-remaining'] === '0') {
        fail('GitHub API rate limit reached (unauthenticated requests are limited per hour).',
            `Wait a bit — or download the ZIP from https://github.com/${REPO}/releases and re-run with --zip <path-to-zip>.`);
    }
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) {
        fail(`GitHub API returned HTTP ${res.statusCode} for ${url}.`,
            `You can bypass the API entirely: download the ZIP from https://github.com/${REPO}/releases and re-run with --zip <path-to-zip>.`);
    }
    try { return JSON.parse(body); } catch { fail('GitHub returned an unparsable response.', 'Try again, or use --zip <path-to-zip>.'); }
}

async function resolveReleaseAsset(tag) {
    const url = tag
        ? `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`
        : `https://api.github.com/repos/${REPO}/releases/latest`;
    const release = await githubJson(url);
    if (!release) {
        fail(tag ? `No release found for tag "${tag}".` : `No releases found for ${REPO}.`,
            `See https://github.com/${REPO}/releases for available versions, or pass --zip <path-or-url>.`);
    }
    const asset = (release.assets || []).find((a) => /^wordjs-.*\.zip$/i.test(a.name || ''));
    if (!asset) fail(`Release ${release.tag_name} has no wordjs-*.zip asset.`, 'Pass --zip <path-or-url> instead.');
    return { name: asset.name, url: asset.browser_download_url, tag: release.tag_name };
}

async function download(url, dest, label) {
    const res = await request(url, { accept: 'application/octet-stream' });
    if (res.statusCode !== 200) {
        fail(`Download failed (HTTP ${res.statusCode}) for ${url}.`,
            `Download the ZIP manually from https://github.com/${REPO}/releases and re-run with --zip <path-to-zip>.`);
    }
    const total = Number(res.headers['content-length']) || 0;
    const mb = (n) => (n / 1048576).toFixed(1);
    let done = 0;
    let lastShown = -1;
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
            done += chunk.length;
            if (total) {
                const pct = Math.floor((done / total) * 100);
                if (pct !== lastShown) {
                    lastShown = pct;
                    process.stdout.write(`\r  ↓ ${label}: ${mb(done)} / ${mb(total)} MB (${pct}%)   `);
                }
            } else if (done - lastShown >= 2 * 1048576 || lastShown === -1) {
                lastShown = done;
                process.stdout.write(`\r  ↓ ${label}: ${mb(done)} MB   `);
            }
        });
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => { process.stdout.write('\n'); resolve(); });
        res.pipe(out);
    });
}

// --- extraction + scaffolding ------------------------------------------------------------------

function extractZip(zipPath, targetDir) {
    const AdmZip = require('adm-zip'); // lazy so --help works even before deps are installed
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetDir, true);
    // Official bundles put files at the ZIP root; tolerate a single wrapper folder too.
    if (!fs.existsSync(path.join(targetDir, 'package.json'))) {
        const entries = fs.readdirSync(targetDir);
        if (entries.length === 1) {
            const inner = path.join(targetDir, entries[0]);
            if (fs.statSync(inner).isDirectory() && fs.existsSync(path.join(inner, 'package.json'))) {
                for (const child of fs.readdirSync(inner)) {
                    fs.renameSync(path.join(inner, child), path.join(targetDir, child));
                }
                fs.rmdirSync(inner);
            }
        }
    }
}

function runNpmScript(script, cwd, extraEnv) {
    // A single command string with shell:true resolves npm/npm.cmd on every platform (and avoids
    // Node's DEP0190 warning about args-array + shell). The string is fixed — no user input in it.
    const r = spawnSync(`npm run ${script}`, {
        cwd,
        stdio: 'inherit',
        shell: true,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    if (r.error) fail(`Could not run "npm run ${script}": ${r.error.message}`, 'Is npm on your PATH?');
    if (r.status !== 0) fail(`"npm run ${script}" exited with code ${r.status}.`, `Fix the error above, then re-run it manually inside ${cwd}.`);
}

/**
 * A fresh release bundle ships WITHOUT gateway/gateway-config.json (secrets are never bundled), and
 * without it the monolith would fall back to plain HTTP. Seed a minimal { "ssl": true } so the
 * server self-signs HTTPS on :3000 — matching the https:// install URL we (and the backend) print.
 * Never overwrites an existing config.
 */
function ensureHttpsConfig(targetDir) {
    const p = path.join(targetDir, 'gateway', 'gateway-config.json');
    if (fs.existsSync(p)) return;
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ ssl: true }, null, 4) + '\n');
    } catch (e) {
        console.warn(`  (could not write ${p}: ${e.message} — the server may fall back to HTTP; use the URL it prints)`);
    }
}

// --- main ---------------------------------------------------------------------------------------

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const targetDir = path.resolve(process.cwd(), opts.dir);

    // Refuse to scribble over anything that already exists (an existing EMPTY dir is fine).
    if (fs.existsSync(targetDir)) {
        if (!fs.statSync(targetDir).isDirectory()) fail(`"${opts.dir}" already exists and is not a directory.`);
        if (fs.readdirSync(targetDir).length > 0) {
            fail(`Directory "${opts.dir}" already exists and is not empty.`, 'Pick a new directory name, or empty it first.');
        }
    } else {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    console.log('\n🚀 create-wordjs\n');

    // 1) Obtain the release ZIP (local path, direct URL, or GitHub latest/tagged release).
    let tmpDir = null;
    let zipPath = null;
    if (opts.zip && !/^https?:\/\//i.test(opts.zip)) {
        zipPath = path.resolve(process.cwd(), opts.zip);
        if (!fs.existsSync(zipPath)) fail(`ZIP not found: ${zipPath}`);
        console.log(`  Using local bundle: ${zipPath}`);
    } else {
        let url = opts.zip;
        let name = 'wordjs.zip';
        if (!url) {
            console.log(opts.version ? `  Looking up release ${opts.version} of ${REPO}…` : `  Looking up the latest release of ${REPO}…`);
            const asset = await resolveReleaseAsset(opts.version);
            url = asset.url;
            name = asset.name;
            console.log(`  Found ${asset.tag} → ${asset.name}`);
        }
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-wordjs-'));
        zipPath = path.join(tmpDir, name);
        await download(url, zipPath, name);
    }

    // 2) Extract + sanity-check that this really is a WordJS release bundle.
    console.log(`  Extracting into ${targetDir}…`);
    try {
        extractZip(zipPath, targetDir);
    } finally {
        if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
    }
    const pkgPath = path.join(targetDir, 'package.json');
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* handled below */ }
    if (!pkg.scripts || !pkg.scripts['release:install'] || !pkg.scripts['start:mono']) {
        fail('The extracted ZIP does not look like a WordJS release bundle (missing release:install / start:mono scripts).',
            `Expected a wordjs-*.zip from https://github.com/${REPO}/releases.`);
    }

    // 3) Install runtime dependencies (pre-compiled bundle — no build step).
    console.log('\n📦 Installing runtime dependencies (this downloads prebuilt binaries — a few minutes)…\n');
    runNpmScript('release:install', targetDir);

    // 4) Default to self-signed HTTPS unless the user explicitly asked for HTTP.
    if (!opts.http) ensureHttpsConfig(targetDir);

    const proto = opts.http ? 'http' : 'https';
    const line = '━'.repeat(64);

    if (!opts.start) {
        console.log(`\n${line}`);
        console.log(`✅ WordJS scaffolded into ${opts.dir} (dependencies installed).`);
        console.log('');
        console.log('   Start it whenever you are ready:');
        console.log(`      cd ${opts.dir}`);
        console.log(`      npm run start:mono${opts.http ? '        (with WORDJS_HTTP=1 in the environment for plain HTTP)' : ''}`);
        console.log('');
        console.log(`   The console will print your one-time install URL (${proto}://localhost:3000/install?token=…).`);
        console.log(line + '\n');
        return;
    }

    // 5) Start the server with a one-time install token (the backend honors WORDJS_INSTALL_TOKEN
    //    when it is >= 16 chars; 24 random bytes = 48 hex chars, same entropy the backend generates).
    const token = crypto.randomBytes(24).toString('hex');
    const env = { WORDJS_INSTALL_TOKEN: token };
    if (opts.http) env.WORDJS_HTTP = '1';

    console.log(`\n${line}`);
    console.log('✅ WordJS is ready — finish setup in your browser:');
    console.log('');
    console.log(`   → ${proto}://localhost:3000/install?token=${token}`);
    console.log('');
    console.log('   • The server is starting below — give it ~15–30 seconds, then open the URL.');
    if (!opts.http) {
        console.log('   • HTTPS uses a locally generated self-signed certificate, so your browser will');
        console.log('     warn once ("Your connection is not private") — click Advanced → Proceed.');
        console.log('     That is expected for localhost. (Prefer plain HTTP? Re-run with --http.)');
    }
    console.log('   • Stop the server:  press Ctrl+C in this window.');
    console.log(`   • Start it later:   cd ${opts.dir} && npm run start:mono`);
    console.log('     (a fresh install URL is printed on every start until setup is finished)');
    if (process.platform === 'linux') {
        console.log('');
        console.log('   • RECEIVING email from the internet? WordJS listens on port 25 (the MX port).');
        console.log('     Binding a port below 1024 as a non-root user needs a one-time grant — run once:');
        console.log('        sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(command -v node)")"');
        console.log('     Without it, inbound falls back to port 2525 (sending + local mail still work);');
        console.log('     the admin Email → Server Admin screen shows the live listener status either way.');
    }
    console.log(line + '\n');

    const child = spawn('npm run start:mono', {
        cwd: targetDir,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, ...env },
    });
    child.on('error', (e) => fail(`Could not start the server: ${e.message}`, `Run it manually: cd ${opts.dir} && npm run start:mono`));
    child.on('exit', (code) => process.exit(code == null ? 0 : code));
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
