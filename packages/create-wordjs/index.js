#!/usr/bin/env node
'use strict';

/**
 * create-wordjs — bootstrap a WordJS site with ONE command:
 *
 *     npx create-wordjs@latest my-site
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
create-wordjs — bootstrap or upgrade a WordJS site with one command

Usage:
  npx create-wordjs@latest <dir> [options]            Create a new site (monolith — one machine)
  npx create-wordjs@latest upgrade [dir] [options]    Upgrade an existing site (dir defaults to .)
  npx create-wordjs@latest gateway [dir] [options]    Set up a SEPARATE-MODE gateway (cluster CA + join tokens)
  npx create-wordjs@latest join <role> [dir] [opts]   Join this machine to a gateway as backend|frontend

Options:
  --zip <path-or-url>   Use a local release ZIP (or a direct ZIP URL) instead of asking GitHub.
  --version <tag>       Install/upgrade to a specific release tag (e.g. v1.0.0) instead of the latest.
  --http                Serve plain HTTP instead of self-signed HTTPS (sets WORDJS_HTTP=1). (create)
  --no-start            Scaffold + install dependencies only; don't start the server.
  --yes, -y             Skip the confirmation prompt (required when upgrading non-interactively).
  --force               Re-apply even if already on the target version. (upgrade)
  --no-install          Swap the code only; skip 'npm run release:install'. (upgrade)
  --host <ip/dns>       (gateway) The address other machines dial to reach this gateway.
  --gateway <ip/dns>    (join) The gateway's address.
  --token <join-token>  (join) A single-use token minted on the gateway (cluster token <role>).
  --ca-hash <sha256>    (join) Pin the cluster CA fingerprint the gateway prints (MITM guard).
  --advertise <ip/dns>  (join) This node's routable address the gateway will proxy to.
  --enroll-port <port>  (join) Gateway token-enrollment port (default 3101).
  -h, --help            Show this help.

Examples:
  npx create-wordjs@latest my-site
  npx create-wordjs@latest my-site --version v1.0.0
  npx create-wordjs@latest upgrade                     # from inside your site directory
  npx create-wordjs@latest upgrade ./my-site --yes

Separate mode (three machines) — run one command per machine:
  # on the gateway machine (prints ready-to-paste join commands with fresh tokens):
  npx create-wordjs@latest gateway --host 10.0.0.1
  # on the backend machine:
  npx create-wordjs@latest join backend  --gateway 10.0.0.1 --token <t> --ca-hash <fp> --advertise 10.0.0.2
  # on the frontend machine:
  npx create-wordjs@latest join frontend --gateway 10.0.0.1 --token <t> --ca-hash <fp> --advertise 10.0.0.3
  (join needs 'openssl' on PATH. See documentation/separate-mode.md.)

Upgrading preserves your database (backend/data), uploads (backend/uploads), config
(wordjs-config.json + gateway secrets) and any user-installed plugins; it replaces the app code and
runs the dependency install. Database schema migrations apply automatically the next time the server
starts — then restart WordJS (e.g. 'systemctl restart wordjs', or stop it and 'npm run start:mono').
`;

function fail(message, hint) {
    console.error(`\n✖ ${message}`);
    if (hint) console.error(`  ${hint}`);
    console.error('');
    process.exit(1);
}

function parseArgs(argv) {
    const opts = {
        mode: 'create', dir: null, zip: null, version: null, http: false, start: true, yes: false, force: false, install: true,
        role: null, gateway: null, token: null, caHash: null, advertise: null, enrollPort: null, host: null,
    };
    // A leading subcommand selects the mode (default is the monolith create flow).
    if (['upgrade', 'gateway', 'join'].includes(argv[0])) { opts.mode = argv[0]; argv = argv.slice(1); }
    const positionals = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
        else if (a === '--zip') { opts.zip = argv[++i] || fail('--zip needs a value (path or URL to a wordjs-*.zip).'); }
        else if (a === '--version') { opts.version = argv[++i] || fail('--version needs a value (a release tag, e.g. v1.0.0).'); }
        else if (a === '--http') opts.http = true;
        else if (a === '--no-start') opts.start = false;
        else if (a === '--yes' || a === '-y') opts.yes = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--no-install') opts.install = false;
        else if (a === '--role') opts.role = argv[++i] || fail('--role needs a value (backend or frontend).');
        else if (a === '--gateway') opts.gateway = argv[++i] || fail('--gateway needs the gateway host/ip.');
        else if (a === '--token') opts.token = argv[++i] || fail('--token needs the join token.');
        else if (a === '--ca-hash') opts.caHash = argv[++i] || fail('--ca-hash needs the CA fingerprint.');
        else if (a === '--advertise') opts.advertise = argv[++i] || fail('--advertise needs this node\'s ip/dns.');
        else if (a === '--enroll-port') opts.enrollPort = argv[++i] || fail('--enroll-port needs a port.');
        else if (a === '--host') opts.host = argv[++i] || fail('--host needs the gateway ip/dns.');
        else if (a.startsWith('-')) fail(`Unknown option: ${a}`, 'Run with --help to see the available options.');
        else positionals.push(a);
    }
    // Positionals: `join <role> [dir]` takes the role first; every other mode takes just [dir].
    if (opts.mode === 'join' && !opts.role) opts.role = positionals.shift() || null;
    opts.dir = positionals.shift() || null;
    if (positionals.length) fail(`Unexpected extra argument: ${positionals[0]}`);

    if (!opts.dir) {
        if (opts.mode === 'upgrade') opts.dir = '.';                                   // upgrade defaults to cwd
        else if (opts.mode === 'gateway') opts.dir = 'wordjs-gateway';
        else if (opts.mode === 'join') opts.dir = opts.role ? `wordjs-${opts.role}` : 'wordjs-node';
        else fail('Please specify a directory for your new site.', 'Example: npx create-wordjs@latest my-site');
    }
    if (opts.version && /^\d/.test(opts.version)) opts.version = 'v' + opts.version;   // accept "1.0.0" for "v1.0.0"
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

// NAME THE ASSET WE WANT; DO NOT TAKE THE FIRST ONE THAT LOOKS RIGHT.
//
// The core bundle is not alone on the release: the same release carries all 31 marketplace plugin
// zips, and `wordjs-*.zip` is a shape, not an identity. A plugin slug beginning with `wordjs-` would
// sort ahead of the bundle in the assets array and this installer would download a plugin and try to
// boot it as a site. Nothing today collides, which is exactly when it is cheap to fix.
//
// release.yml names the bundle after the tag (`wordjs-v2.0.0.zip`), so ask for that by name. The
// loose match survives only as a fallback — for older releases, and so a rename in the workflow
// degrades gracefully instead of failing hard.
//
// BUT THE FALLBACK IS THE OLD RULE, so it cannot be allowed to guess. Taking the first loose match
// would reinstate exactly the bug the exact match was added to fix, on every path where the
// tag-named asset is absent (a workflow_dispatch build, a rename, any earlier release). The loose
// shape is therefore used ONLY when it is unambiguous: exactly one candidate. Two or more means we
// would be choosing which file is the site, and choosing wrong installs a plugin as a site — so we
// refuse and say so, and `--zip` is right there. Fail closed, never guess.
//
// Exported (below) so it can be exercised directly: it is the one piece of release resolution that is
// pure, and testing it through the network call would mean testing a copy of it instead.
function pickBundleAsset(assets, tagName) {
    const list = Array.isArray(assets) ? assets : [];
    const wanted = `wordjs-${tagName}.zip`.toLowerCase();
    const exact = list.find((a) => String(a && a.name || '').toLowerCase() === wanted);
    if (exact) return exact;
    const loose = looseBundleCandidates(list);
    return loose.length === 1 ? loose[0] : null;
}

/** Every asset matching the loose `wordjs-*.zip` shape — used to explain an ambiguous refusal. */
function looseBundleCandidates(assets) {
    const list = Array.isArray(assets) ? assets : [];
    return list.filter((a) => /^wordjs-.*\.zip$/i.test(a && a.name || ''));
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
    const asset = pickBundleAsset(release.assets, release.tag_name);
    if (!asset) {
        // Say WHICH of the two refusals this is: "there is no bundle" and "there are several and I
        // will not guess" need different answers from whoever is reading.
        const candidates = looseBundleCandidates(release.assets).map((a) => a.name);
        if (candidates.length > 1) {
            fail(`Release ${release.tag_name} has no asset named wordjs-${release.tag_name}.zip, and ${candidates.length} others match wordjs-*.zip: ${candidates.join(', ')}.`,
                'Refusing to guess which one is the site bundle — pass --zip <path-or-url> with the one you want.');
        }
        fail(`Release ${release.tag_name} has no wordjs-*.zip asset.`, 'Pass --zip <path-or-url> instead.');
    }
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

// First non-internal IPv4 — a sensible default advertise/host when the user doesn't pass one.
function firstLanIp() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) if (!i.internal && (i.family === 'IPv4' || i.family === 4)) return i.address;
    }
    return '127.0.0.1';
}

// Run a BUNDLED node script (scripts/cluster.js, scripts/node-join.js) with an ARGS ARRAY and no shell,
// so user-supplied values (IPs, tokens) can never be interpreted by a shell. Inherits stdio.
function runNode(scriptRel, args, cwd, extraEnv) {
    const r = spawnSync(process.execPath, [scriptRel, ...args], {
        cwd, stdio: 'inherit', env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    if (r.error) fail(`Could not run ${scriptRel}: ${r.error.message}`, `Is node on your PATH?`);
    if (r.status !== 0) fail(`${scriptRel} exited with code ${r.status}.`, `Fix the error above, then re-run it inside ${cwd}.`);
}

// Same, but capture stdout (to read a minted token / CA fingerprint back).
function runNodeCapture(scriptRel, args, cwd) {
    const r = spawnSync(process.execPath, [scriptRel, ...args], { cwd, encoding: 'utf8' });
    if (r.error) fail(`Could not run ${scriptRel}: ${r.error.message}`);
    if (r.status !== 0) { process.stderr.write((r.stdout || '') + (r.stderr || '')); fail(`${scriptRel} exited with code ${r.status}.`); }
    return r.stdout || '';
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

// --- upgrade -----------------------------------------------------------------------------------

function confirm(question) {
    return new Promise((resolve) => {
        const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(String(ans).trim())); });
    });
}

// Paths (relative to the install root) that hold USER STATE and must survive an upgrade untouched.
// `node_modules` at any depth is skipped separately (deps are re-synced by release:install).
const PRESERVE_ON_UPGRADE = new Set([
    'backend/data',                 // the database (+ WAL/SHM, ssl/, imports/)
    'backend/uploads',              // user uploads / media / fonts
    'backend/wordjs-config.json',   // site config + secrets
    'backend/.env',
    '.env',
    'gateway/gateway-config.json',  // gateway TLS/secrets
    'wordjs-config.json',
]);
// Pure build outputs (no user data): removed before the copy so the new build fully REPLACES the old
// one — a merge would leave orphaned chunks from the previous version behind.
const CLEAN_REPLACE_ON_UPGRADE = ['frontend/.next', 'backend/dist', 'gateway/dist'];

// Recursively copy `src` over `dest`, creating dirs as needed. Never deletes files that aren't in
// `src` (so user-installed plugins and other extra files survive). Skips node_modules and the
// preserve-list so user state is never overwritten.
function copyMerge(src, dest, rel = '') {
    for (const name of fs.readdirSync(src)) {
        const relPath = rel ? `${rel}/${name}` : name;
        if (name === 'node_modules') continue;
        if (PRESERVE_ON_UPGRADE.has(relPath)) continue;
        const s = path.join(src, name);
        const d = path.join(dest, name);
        const st = fs.lstatSync(s);
        if (st.isDirectory()) {
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            copyMerge(s, d, relPath);
        } else {
            fs.copyFileSync(s, d);
        }
    }
}

// Download (or use a local/URL) release ZIP and extract it into a fresh temp dir. Returns the
// extracted app root + a cleanup fn. Reuses the same resolution the create flow uses.
async function obtainReleaseToTemp(opts) {
    let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-upgrade-'));
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } };
    try {
        let zipPath;
        let tag = opts.version || null;
        if (opts.zip && !/^https?:\/\//i.test(opts.zip)) {
            zipPath = path.resolve(process.cwd(), opts.zip);
            if (!fs.existsSync(zipPath)) fail(`ZIP not found: ${zipPath}`);
        } else {
            let url = opts.zip;
            let name = 'wordjs.zip';
            if (!url) {
                console.log(opts.version ? `  Looking up release ${opts.version} of ${REPO}…` : `  Looking up the latest release of ${REPO}…`);
                const asset = await resolveReleaseAsset(opts.version);
                url = asset.url; name = asset.name; tag = asset.tag;
                console.log(`  Found ${asset.tag} → ${asset.name}`);
            }
            zipPath = path.join(tmpDir, name);
            await download(url, zipPath, name);
        }
        const extractDir = path.join(tmpDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        extractZip(zipPath, extractDir);
        return { extractDir, tag, cleanup };
    } catch (e) {
        cleanup();
        throw e;
    }
}

async function upgrade(opts) {
    const installDir = path.resolve(process.cwd(), opts.dir);
    const pkgPath = path.join(installDir, 'package.json');
    const cfgPath = path.join(installDir, 'backend', 'wordjs-config.json');

    // Verify this is a real, configured WordJS install (not an empty dir or the wrong folder).
    if (!fs.existsSync(pkgPath) || !fs.existsSync(cfgPath)) {
        fail(`"${opts.dir}" does not look like a WordJS install.`,
            'Run this from your site directory (it must contain backend/wordjs-config.json), or pass the path: npx create-wordjs@latest upgrade <dir>.');
    }
    let curPkg = {};
    try { curPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* handled below */ }
    if (!curPkg.scripts || !curPkg.scripts['release:install'] || !curPkg.scripts['start:mono']) {
        fail(`"${opts.dir}" has a package.json but not the WordJS release scripts.`, 'Are you pointing at the right site directory?');
    }
    const curVersion = curPkg.version || 'unknown';

    console.log('\n🚀 create-wordjs upgrade\n');
    console.log(`  Site: ${installDir}`);
    console.log(`  Current version: v${curVersion}`);

    // Fetch the target release into a temp dir and read its version.
    const { extractDir, tag, cleanup } = await obtainReleaseToTemp(opts);
    try {
        const newPkgPath = path.join(extractDir, 'package.json');
        let newPkg = {};
        try { newPkg = JSON.parse(fs.readFileSync(newPkgPath, 'utf8')); } catch { /* handled below */ }
        if (!newPkg.scripts || !newPkg.scripts['release:install'] || !newPkg.scripts['start:mono']) {
            fail('The downloaded ZIP does not look like a WordJS release bundle.', `Expected a wordjs-*.zip from https://github.com/${REPO}/releases.`);
        }
        const newVersion = newPkg.version || (tag ? String(tag).replace(/^v/, '') : 'unknown');
        console.log(`  Target version:  v${newVersion}${tag ? ` (${tag})` : ''}`);

        if (curVersion === newVersion && !opts.force) {
            console.log(`\n✅ Already on v${curVersion}. Nothing to upgrade.  (use --force to re-apply the same version)\n`);
            return;
        }

        // Confirm before mutating an existing install.
        if (!opts.yes) {
            if (process.stdin.isTTY) {
                const ok = await confirm(`\n  Upgrade this site v${curVersion} → v${newVersion}? Your database, uploads and config are preserved. [y/N] `);
                if (!ok) { console.log('  Aborted — nothing changed.\n'); return; }
            } else {
                fail('Refusing to upgrade non-interactively without confirmation.',
                    'Re-run with --yes to proceed (your database, uploads and config are preserved).');
            }
        }

        // Snapshot the small critical config files (belt-and-suspenders; the DB/uploads are never
        // touched by the overlay because they are in the preserve-list).
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(installDir, `.upgrade-backup-${stamp}`);
        try {
            fs.mkdirSync(backupDir, { recursive: true });
            for (const rel of ['backend/wordjs-config.json', 'gateway/gateway-config.json', 'package.json']) {
                const from = path.join(installDir, rel);
                if (fs.existsSync(from)) {
                    const to = path.join(backupDir, rel.replace(/[/\\]/g, '__'));
                    fs.copyFileSync(from, to);
                }
            }
            console.log(`\n  Backed up config to ${path.relative(installDir, backupDir) || backupDir}`);
        } catch (e) {
            console.warn(`  (could not write config backup: ${e.message} — continuing; your DB/uploads/config are still preserved in place)`);
        }

        // Clean-replace the build outputs so no stale chunks linger, then overlay the rest.
        for (const rel of CLEAN_REPLACE_ON_UPGRADE) {
            const target = path.join(installDir, rel);
            const fromRelease = path.join(extractDir, rel);
            if (fs.existsSync(fromRelease) && fs.existsSync(target)) {
                fs.rmSync(target, { recursive: true, force: true });
            }
        }
        console.log('  Applying new code (preserving data, uploads, config and custom plugins)…');
        copyMerge(extractDir, installDir);

        if (!opts.http) ensureHttpsConfig(installDir);

        // Re-sync dependencies (a new version may add/upgrade packages). Skippable for a code-only swap.
        if (opts.install) {
            console.log('\n📦 Syncing runtime dependencies (npm run release:install)…\n');
            runNpmScript('release:install', installDir);
        } else {
            console.log('\n  --no-install: skipped dependency sync. Run "npm run release:install" yourself if deps changed.');
        }

        const line = '━'.repeat(64);
        console.log(`\n${line}`);
        console.log(`✅ Upgraded WordJS: v${curVersion} → v${newVersion}.`);
        console.log('');
        console.log('   Your database, uploads and config were preserved. Restart the server to apply it —');
        console.log('   database schema migrations run automatically on the next start:');
        console.log('      • systemd:   sudo systemctl restart wordjs');
        console.log(`      • otherwise: stop it, then  cd ${opts.dir === '.' ? installDir : opts.dir} && npm run start:mono`);
        console.log('');
        console.log('   Rollback: re-run with --version <old-tag> (your data stays intact).');
        console.log(line + '\n');
    } finally {
        cleanup();
    }
}

// --- separate mode (gateway + join) ------------------------------------------------------------

// Download + extract the release bundle into targetDir and install runtime deps. Shared by the
// gateway and join flows (a superset of the create flow's steps 1–3, minus the mono-specific bits).
async function scaffoldBundle(opts, targetDir) {
    if (fs.existsSync(targetDir)) {
        if (!fs.statSync(targetDir).isDirectory()) fail(`"${opts.dir}" already exists and is not a directory.`);
        if (fs.readdirSync(targetDir).length > 0) fail(`Directory "${opts.dir}" already exists and is not empty.`, 'Pick a new directory name, or empty it first.');
    } else {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    let tmpDir = null, zipPath = null;
    if (opts.zip && !/^https?:\/\//i.test(opts.zip)) {
        zipPath = path.resolve(process.cwd(), opts.zip);
        if (!fs.existsSync(zipPath)) fail(`ZIP not found: ${zipPath}`);
        console.log(`  Using local bundle: ${zipPath}`);
    } else {
        let url = opts.zip, name = 'wordjs.zip';
        if (!url) {
            console.log(opts.version ? `  Looking up release ${opts.version} of ${REPO}…` : `  Looking up the latest release of ${REPO}…`);
            const asset = await resolveReleaseAsset(opts.version);
            url = asset.url; name = asset.name;
            console.log(`  Found ${asset.tag} → ${asset.name}`);
        }
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-wordjs-'));
        zipPath = path.join(tmpDir, name);
        await download(url, zipPath, name);
    }

    console.log(`  Extracting into ${targetDir}…`);
    try { extractZip(zipPath, targetDir); }
    finally { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } } }

    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8')); } catch { /* handled below */ }
    if (!pkg.scripts || !pkg.scripts['release:install']) {
        fail('The extracted ZIP does not look like a WordJS release bundle.', `Expected a wordjs-*.zip from https://github.com/${REPO}/releases.`);
    }
    if (!fs.existsSync(path.join(targetDir, 'scripts', 'cluster.js')) || !fs.existsSync(path.join(targetDir, 'scripts', 'node-join.js'))) {
        fail('This release bundle predates separate mode (missing scripts/cluster.js).', 'Install v1.6.1 or later, e.g. add --version v1.6.1.');
    }

    console.log('\n📦 Installing runtime dependencies (this downloads prebuilt binaries — a few minutes)…\n');
    runNpmScript('release:install', targetDir);
}

// `create-wordjs gateway` — set this machine up as the cluster gateway: install, mint the cluster CA +
// config, mint one join token per role, and print the ready-to-paste join commands for the other nodes.
async function gateway(opts) {
    const targetDir = path.resolve(process.cwd(), opts.dir);
    console.log('\n🚀 create-wordjs · gateway (separate mode)\n');
    await scaffoldBundle(opts, targetDir);

    const host = opts.host || firstLanIp();
    const line = '━'.repeat(64);
    console.log(`\n🔐 Initializing cluster gateway on ${host}…`);
    runNode('scripts/cluster.js', ['init', '--host', host], targetDir);

    // Read the CA fingerprint and mint a token per role (capturing the raw token for the join command).
    const fp = (runNodeCapture('scripts/cluster.js', ['info'], targetDir).match(/CA fingerprint:\s*([0-9a-f]{64})/) || [])[1] || '<fingerprint>';
    const mint = (role) => (runNodeCapture('scripts/cluster.js', ['token', role, '--ttl', '120'], targetDir)
        .match(new RegExp(`wjc\\.${role}\\.[A-Za-z0-9_-]+`)) || [])[0] || '<token>';
    const beTok = mint('backend'), feTok = mint('frontend');

    console.log(`\n${line}`);
    console.log('✅ Gateway ready.  Public origin: ' + `https://${host}:3000`);
    console.log('');
    console.log('   Run ONE of these on each other machine (they auto-download + enroll + start):');
    console.log('');
    console.log('   # backend machine:');
    console.log(`   npx create-wordjs@latest join backend --gateway ${host} --token ${beTok} \\`);
    console.log(`        --ca-hash ${fp} --advertise <this-backend-ip>`);
    console.log('');
    console.log('   # frontend machine:');
    console.log(`   npx create-wordjs@latest join frontend --gateway ${host} --token ${feTok} \\`);
    console.log(`        --ca-hash ${fp} --advertise <this-frontend-ip>`);
    console.log('');
    console.log('   Tokens are single-use and expire in 120 min. Mint more anytime:');
    console.log(`     cd ${opts.dir} && node scripts/cluster.js token <backend|frontend>`);
    console.log(line + '\n');

    if (!opts.start) {
        console.log(`   Start the gateway when ready:  cd ${opts.dir} && npm run prod:gateway\n`);
        return;
    }
    console.log('   Starting the gateway below (Ctrl+C to stop) — the join commands above work once it is up.\n');
    const child = spawn('npm run prod:gateway', { cwd: targetDir, stdio: 'inherit', shell: true, env: process.env });
    child.on('error', (e) => fail(`Could not start the gateway: ${e.message}`, `Run it manually: cd ${opts.dir} && npm run prod:gateway`));
    child.on('exit', (code) => process.exit(code || 0));
}

// `create-wordjs join <backend|frontend>` — install the bundle, enroll with the gateway using the
// single-use token (delegates to scripts/node-join.js), then start + register the service.
async function join(opts) {
    if (!['backend', 'frontend'].includes(opts.role)) {
        fail('join needs a role: backend or frontend.', 'Example: npx create-wordjs@latest join backend --gateway <ip> --token <t>');
    }
    if (!opts.gateway) fail('--gateway <gateway-ip/dns> is required for join.');
    if (!opts.token) fail('--token <join-token> is required for join.', `Mint one on the gateway: node scripts/cluster.js token ${opts.role}`);
    if (!opts.caHash) console.warn('  ⚠️  No --ca-hash given — skipping the MITM fingerprint check (fine on a trusted network).');

    const targetDir = path.resolve(process.cwd(), opts.dir);
    console.log(`\n🚀 create-wordjs · join ${opts.role} (separate mode)\n`);
    await scaffoldBundle(opts, targetDir);

    const advertise = opts.advertise || firstLanIp();
    const args = ['--role', opts.role, '--gateway', opts.gateway, '--enroll-port', String(opts.enrollPort || 3101),
        '--token', opts.token, '--advertise', advertise];
    if (opts.caHash) args.push('--ca-hash', opts.caHash);
    if (opts.start) args.push('--start');

    console.log(`\n🎟️  Enrolling ${opts.role} with gateway ${opts.gateway} (advertise ${advertise})…\n`);
    runNode('scripts/node-join.js', args, targetDir);

    const line = '━'.repeat(64);
    console.log(`\n${line}`);
    console.log(`✅ ${opts.role} enrolled${opts.start ? ' and started (registered with the gateway over mTLS)' : ''}.`);
    console.log(opts.start
        ? `   Logs: ${path.join(opts.dir, opts.role, 'cluster-start.log')}`
        : `   Start it:  cd ${opts.dir} && npm start`);
    console.log(line + '\n');
}

// --- main ---------------------------------------------------------------------------------------

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.mode === 'upgrade') return upgrade(opts);
    if (opts.mode === 'gateway') return gateway(opts);
    if (opts.mode === 'join') return join(opts);
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

// Run only when invoked as the CLI, so the pure helpers above can be required and exercised.
if (require.main === module) {
    main().catch((e) => fail(e && e.message ? e.message : String(e)));
}

module.exports = { pickBundleAsset };
