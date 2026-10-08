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
 *      printing a clickable https://localhost:3000/install#token=… URL — the browser install
 *      wizard takes it from there (pick SQLite/PostgreSQL, create your admin, done). That URL is
 *      printed by THIS process, which owns the token, so it is unconditional.
 *      With --no-start there is no token from here: the server mints its own on its first boot and
 *      prints it in its banner only when ITS stdout is a TTY (or WORDJS_PRINT_INSTALL_TOKEN=1);
 *      otherwise it writes it to <dir>/backend/data/install-token (mode 0600) and prints the path.
 *   With --systemd (Linux) it does not start anything: it stages wordjs.service, a unit that runs the
 *   site as a dedicated non-root account with no Linux capabilities (plus a sysctl.d drop-in when the
 *   port is below 1024), in a private directory OUTSIDE the site, and prints how to install it. See
 *   buildSystemdFiles for why no capability, and createSystemdStagingDir for why not in the site.
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
  --zip <path-or-url>   Use a local release ZIP (or a direct https:// ZIP URL) instead of asking GitHub.
  --sha256 <hex>        Require the ZIP to have this SHA-256 (pin a checksum for --zip; also checked
                        on top of the release's own .sha256 asset).
  --version <tag>       Install/upgrade to a specific release tag (e.g. v2.1.0) instead of the latest.
  --http                Serve plain HTTP instead of self-signed HTTPS (sets WORDJS_HTTP=1). (create)
  --no-start            Scaffold + install dependencies only; don't start the server.
  --yes, -y             Skip the confirmation prompt (required when upgrading non-interactively).
  --force               Re-apply even if already on the target version. (upgrade)
  --no-install          Swap the code only; skip 'npm run release:install'. (upgrade)
  --host <ip/dns>       (gateway) The address other machines dial to reach this gateway.
  --gateway <ip/dns>    (join) The gateway's address.
  --token <join-token>  (join) A single-use token minted on the gateway (cluster token <role>).
  --ca-hash <sha256>    (join) REQUIRED. The cluster CA fingerprint the gateway prints; the gateway's
                        TLS certificate must chain to it before the token is sent (MITM guard).
  --advertise <ip/dns>  (join) This node's routable address the gateway will proxy to.
  --enroll-port <port>  (join) Gateway token-enrollment port (default 3101).
  --systemd             (create, upgrade; Linux) Also write a systemd unit, wordjs.service, to a
                        private staging directory (never the site, which the service will own) and
                        print how to install it. The unit runs WordJS as a dedicated non-root
                        account holding NO Linux capabilities. With create it implies --no-start:
                        the first boot must run as that account.
  --port <n>            (with --systemd) Public port, written into the unit as PORT=<n> (default:
                        the site's configured port, else 3000). Below 1024 it also stages
                        60-wordjs-ports.conf (net.ipv4.ip_unprivileged_port_start), never a capability.
  --service-user <name> (with --systemd) The account the service runs as (default: wordjs). Not root.
  -h, --help            Show this help.

Examples:
  npx create-wordjs@latest my-site
  npx create-wordjs@latest my-site --version v2.1.0
  npx create-wordjs@latest upgrade                     # from inside your site directory
  npx create-wordjs@latest upgrade ./my-site --yes
  npx create-wordjs@latest /srv/wordjs --systemd --port 443

Ports below 1024 (80/443) on Linux: put a reverse proxy (nginx, Caddy) in front of WordJS on a high
port, or lower net.ipv4.ip_unprivileged_port_start (--systemd writes that drop-in for you). Do not
give node a capability with setcap or AmbientCapabilities=. See documentation/deployment.md.

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
        systemd: false, port: null, serviceUser: null,
        sha256: null,
    };
    // A leading subcommand selects the mode (default is the monolith create flow).
    if (['upgrade', 'gateway', 'join'].includes(argv[0])) { opts.mode = argv[0]; argv = argv.slice(1); }
    const positionals = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
        else if (a === '--zip') { opts.zip = argv[++i] || fail('--zip needs a value (path or URL to a wordjs-*.zip).'); }
        else if (a === '--sha256') {
            const v = argv[++i];
            if (!v) fail('--sha256 needs a value (the 64-character hex SHA-256 of the ZIP).');
            const hex = normalizeSha256(v);
            if (!hex) fail(`--sha256 must be a 64-character hex SHA-256, got "${v}".`);
            opts.sha256 = hex;
        }
        else if (a === '--version') { opts.version = argv[++i] || fail('--version needs a value (a release tag, e.g. v2.1.0).'); }
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
        else if (a === '--systemd') opts.systemd = true;
        else if (a === '--port') opts.port = argv[++i] || fail('--port needs a value (1-65535).');
        else if (a === '--service-user') opts.serviceUser = argv[++i] || fail('--service-user needs an account name.');
        else if (a.startsWith('-')) fail(`Unknown option: ${a}`, 'Run with --help to see the available options.');
        else positionals.push(a);
    }
    if ((opts.port !== null || opts.serviceUser !== null) && !opts.systemd) {
        fail('--port and --service-user only apply together with --systemd.',
            'Without a unit, the port comes from the PORT environment variable or the site config (default 3000).');
    }
    if (opts.systemd) {
        if (opts.mode !== 'create' && opts.mode !== 'upgrade') {
            fail(`--systemd is not available for "${opts.mode}".`, 'Use it when creating or upgrading a single-machine site.');
        }
        if (opts.port !== null) {
            const n = /^\d{1,5}$/.test(opts.port) ? Number(opts.port) : NaN;
            if (!(n >= 1 && n <= 65535)) fail(`--port must be a whole number from 1 to 65535 (got "${opts.port}").`);
            opts.port = n;
        }
        const problem = serviceUserProblem(opts.serviceUser === null ? DEFAULT_SERVICE_USER : opts.serviceUser);
        if (problem) fail(problem.message, problem.hint);
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
    if (opts.version && /^\d/.test(opts.version)) opts.version = 'v' + opts.version;   // accept "2.1.0" for "v2.1.0"
    return opts;
}

// --- tiny https helpers (plain node:https, no token, redirects followed) -----------------------

function request(url, headers, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'user-agent': 'create-wordjs', ...headers } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                res.resume(); // GitHub release assets redirect to objects.githubusercontent.com
                const next = new URL(res.headers.location, url);
                // Never let a redirect downgrade the transfer to plain HTTP (or any other scheme).
                if (next.protocol !== 'https:') {
                    reject(new Error(`Refusing to follow a redirect from ${url} to a non-https URL (${next.protocol}//${next.host}).`));
                    return;
                }
                resolve(request(next.toString(), headers, redirectsLeft - 1));
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

// --- integrity: SHA-256 of the release ZIP --------------------------------------------------------
//
// The bundle we download becomes the site's code, so it is verified before a single entry is
// extracted. release.yml publishes `wordjs-<tag>.zip.sha256` (sha256sum format: `<hex>  <name>`) next
// to every tag-named bundle; the GitHub flow downloads it and refuses a ZIP whose digest differs.
// Releases published before that asset existed have no checksum to check against — those install
// with a loud warning rather than not at all. `--sha256 <hex>` pins a digest the user obtained out of
// band, for `--zip` sources (and on top of the release checksum when both are present).

/** Lower-case 64-char hex, or null. Accepts the `AA:BB:…` colon form some tools print. */
function normalizeSha256(value) {
    const hex = String(value == null ? '' : value).trim().replace(/:/g, '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * Read the digest for `expectedName` out of a sha256sum-style checksum file. A line naming a
 * DIFFERENT file is ignored (a checksum file for another asset must not vouch for this one); a bare
 * digest with no name is accepted. Returns null when no usable line is found — the caller fails closed.
 */
function parseChecksumFile(text, expectedName) {
    for (const raw of String(text || '').split(/\r?\n/)) {
        // Split instead of one regex with `\s+…(.+)`: linear on any input (CodeQL js/polynomial-redos).
        const line = raw.trim();
        const sep = line.search(/\s/);
        const digest = sep === -1 ? line : line.slice(0, sep);
        if (!/^[0-9a-fA-F]{64}$/.test(digest)) continue;
        const name = sep === -1 ? '' : line.slice(sep).trim().replace(/^\*/, '');
        if (name && expectedName && path.basename(name).toLowerCase() !== String(expectedName).toLowerCase()) continue;
        return digest.toLowerCase();
    }
    return null;
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('error', reject)
            .on('data', (c) => hash.update(c))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * What a `--zip` value points at: an https:// URL, a local file, or something refused. Plain http://
 * (and any other URL scheme) is refused — a bundle fetched over an unauthenticated channel can be
 * swapped in transit, and it becomes the site's code. Windows paths (`C:\…`) are files, not URLs.
 */
function classifyZipSource(zip) {
    const value = String(zip || '');
    if (/^https:\/\//i.test(value)) return { kind: 'url', url: value };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { kind: 'refused', scheme: value.slice(0, value.indexOf(':')).toLowerCase() };
    return { kind: 'file', path: value };
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

/** The `<bundle>.sha256` asset for the bundle we picked — matched by EXACT name, never by shape. */
function pickChecksumAsset(assets, bundleName) {
    const wanted = `${bundleName}.sha256`.toLowerCase();
    return (Array.isArray(assets) ? assets : []).find((a) => String(a && a.name || '').toLowerCase() === wanted) || null;
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
    const sum = pickChecksumAsset(release.assets, asset.name);
    return {
        name: asset.name, url: asset.browser_download_url, tag: release.tag_name,
        checksumName: sum ? sum.name : null, checksumUrl: sum ? sum.browser_download_url : null,
    };
}

/** Download a small text asset (the checksum file). Anything but a 200 is fatal: fail closed. */
async function downloadText(url, maxBytes = 64 * 1024) {
    let res;
    try { res = await request(url, { accept: 'application/octet-stream' }); }
    catch (e) { fail(`Could not download ${url} (${e.message}).`, 'Check your network and try again.'); }
    if (res.statusCode !== 200) {
        res.resume();
        fail(`Download failed (HTTP ${res.statusCode}) for ${url}.`, 'The release lists a checksum file that could not be fetched; refusing to install unverified.');
    }
    const body = await readBody(res);
    if (body.length > maxBytes) fail(`${url} is implausibly large for a checksum file.`);
    return body;
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

// S_IFMT / S_IFLNK out of the high 16 bits of a ZIP entry's external attributes (Unix creators).
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Where `entryName` would land under `root` — or a thrown error when it must not be written at all.
 * adm-zip's own extractAllTo already strips `../` and leading `/` (it rewrites rather than refuses),
 * but a release bundle that contains such an entry is not a release bundle: refuse the whole archive
 * explicitly instead of trusting a silent rewrite in a dependency (same rule as the backend's
 * installPluginFromZip). Refused: absolute paths (POSIX or Windows drive/UNC), any `..` segment, and
 * anything whose resolved path is not inside root.
 */
function containedEntryPath(root, entryName) {
    const rel = String(entryName).replace(/\\/g, '/');
    if (!rel || rel.includes('\0')) throw new Error(`Refusing ZIP entry with an invalid name: ${JSON.stringify(entryName)}`);
    if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) {
        throw new Error(`Refusing ZIP entry with an absolute path: ${entryName}`);
    }
    if (rel.split('/').includes('..')) throw new Error(`Refusing ZIP entry that climbs out of the target (Zip Slip): ${entryName}`);
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
        throw new Error(`Refusing ZIP entry that resolves outside the target (Zip Slip): ${entryName}`);
    }
    return dest;
}

/** A symlink entry (Unix mode stored in the external attributes). The bundle never contains one. */
function isSymlinkEntry(entry) {
    const attr = Number(entry && entry.header && entry.header.attr) >>> 0;
    return ((attr >>> 16) & S_IFMT) === S_IFLNK;
}

/**
 * The mode an installed file gets: 0755 when the archive marked it executable for anyone, else 0644.
 * Never group- or world-writable, whatever the archive says — and an archive built on Windows carries
 * no Unix mode at all, which must not be read as "anything goes".
 */
function installedFileMode(entry) {
    const unix = ((Number(entry && entry.header && entry.header.attr) >>> 0) >>> 16) & 0o777;
    return (unix & 0o111) ? 0o755 : 0o644;
}

function extractZip(zipPath, targetDir) {
    const AdmZip = require('adm-zip'); // lazy so --help works even before deps are installed
    const zip = new AdmZip(zipPath);
    // Vet EVERY entry before writing ANY: a refused archive leaves nothing half-extracted behind.
    const root = path.resolve(targetDir);
    const entries = zip.getEntries();
    const planned = entries.map((entry) => {
        const dest = containedEntryPath(root, entry.entryName);
        if (isSymlinkEntry(entry)) throw new Error(`Refusing ZIP entry that is a symbolic link: ${entry.entryName}`);
        return { entry, dest };
    });
    // Written entry by entry, NOT with adm-zip's extractAllTo: its writeFileTo does chmod(path, attr ||
    // 0o666), and chmod ignores the umask, so every installed file — code that may later run as root —
    // came out world-writable, and an upgrade over an existing 0644 install turned it into 0666 as well.
    for (const { entry, dest } of planned) {
        if (entry.isDirectory) {
            fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
            continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
        const mode = installedFileMode(entry);
        let existing = null;
        try { existing = fs.lstatSync(dest); } catch { /* new file */ }
        if (existing) {
            // An upgrade writes over an existing tree: never through a link someone placed there, and
            // tighten a file left writable by an older installer BEFORE putting new code into it.
            if (existing.isSymbolicLink() || !existing.isFile()) {
                throw new Error(`Refusing to overwrite ${path.relative(root, dest)}: it is not a regular file in the existing install`);
            }
            fs.chmodSync(dest, mode);
        }
        fs.writeFileSync(dest, entry.getData(), { mode });
        // `mode` only applies on creation and is narrowed by the umask; restate it so the result is the
        // same for every caller and every existing file.
        fs.chmodSync(dest, mode);
    }
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

/**
 * Obtain the release ZIP — a local file, an https:// URL, or the GitHub release (latest or --version)
 * — and verify its SHA-256 BEFORE anything is extracted. Shared by create, upgrade, gateway and join so
 * every path that installs code applies the same rule. Returns { zipPath, tag, cleanup }.
 */
async function obtainBundleZip(opts) {
    let tmpDir = null;
    const cleanup = () => { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } } };
    let zipPath;
    let tag = opts.version || null;
    const checks = [];   // [{ expected, source }] — every one must match
    if (opts.sha256) checks.push({ expected: opts.sha256, source: '--sha256' });

    if (opts.zip) {
        const src = classifyZipSource(opts.zip);
        if (src.kind === 'refused') {
            fail(`Refusing --zip ${opts.zip}: only https:// URLs and local file paths are accepted (got ${src.scheme}://).`,
                'A bundle fetched over plain http:// can be replaced in transit. Serve it over https, or download it yourself and pass the local path (with --sha256 <hex>).');
        }
        if (src.kind === 'file') {
            zipPath = path.resolve(process.cwd(), src.path);
            if (!fs.existsSync(zipPath)) fail(`ZIP not found: ${zipPath}`);
            console.log(`  Using local bundle: ${zipPath}`);
        } else {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-wordjs-'));
            zipPath = path.join(tmpDir, 'wordjs.zip');
            await download(src.url, zipPath, 'wordjs.zip');
            if (!opts.sha256) {
                console.warn('  ⚠️  No --sha256 given for this --zip URL — its integrity is NOT verified.');
                console.warn('     Pass --sha256 <hex> (from the release\'s .sha256 asset) to pin it.');
            }
        }
    } else {
        console.log(opts.version ? `  Looking up release ${opts.version} of ${REPO}…` : `  Looking up the latest release of ${REPO}…`);
        const asset = await resolveReleaseAsset(opts.version);
        tag = asset.tag;
        console.log(`  Found ${asset.tag} → ${asset.name}`);
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-wordjs-'));
        zipPath = path.join(tmpDir, asset.name);
        await download(asset.url, zipPath, asset.name);
        if (asset.checksumUrl) {
            const expected = parseChecksumFile(await downloadText(asset.checksumUrl), asset.name);
            if (!expected) {
                cleanup();
                fail(`${asset.checksumName} does not contain a SHA-256 for ${asset.name}.`, 'Refusing to install a bundle that cannot be verified.');
            }
            checks.push({ expected, source: asset.checksumName });
        } else {
            // Releases published before the checksum asset existed. Installing them still works (so
            // `--version <old-tag>` rollbacks keep working), but say plainly that nothing was verified.
            console.warn(`  ⚠️  Release ${asset.tag} publishes no ${asset.name}.sha256 — the download's integrity`);
            console.warn('     could NOT be verified (releases before the checksum asset was introduced).');
            console.warn('     Pin one with --sha256 <hex> if you have it from a trusted source.');
        }
    }

    if (checks.length) {
        const actual = await sha256File(zipPath);
        for (const { expected, source } of checks) {
            if (actual !== expected) {
                cleanup();
                fail(`SHA-256 mismatch for the release ZIP (checked against ${source}).`,
                    `expected ${expected}\n  got      ${actual}\n  Refusing to install — the download is corrupt or has been tampered with.`);
            }
        }
        console.log(`  ✓ SHA-256 verified (${checks.map((c) => c.source).join(' + ')})`);
    }
    return { zipPath, tag, cleanup };
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

// --- systemd service (--systemd) ---------------------------------------------------------------
//
// WHY THE UNIT GRANTS NOTHING, AND WHY THIS INSTALLER STOPPED PRINTING `setcap`.
//
// The familiar way to let a non-root Node service bind 80/443 (or 25) is CAP_NET_BIND_SERVICE: either a
// file capability set on the node binary with `setcap`, which this installer used to recommend, or
// `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the unit. Both collide with the plugin sandbox. On Linux
// every isolated plugin starts through backend/scripts/landlock-seccomp-shim.pl, which must shed every
// capability it inherited before it confines the plugin. An AMBIENT capability is inherited by the shim
// across execve; the shim took it for root, ran a root-only drop (setgroups, securebits, the bounding set
// need CAP_SETGID/CAP_SETPCAP, which a non-root service does not hold), failed with EPERM and every plugin
// was refused: the production failure behind this option. (The shim now sheds a non-root service's
// capabilities on its own, but a service that needs none should hold none, and the core reports one that
// does.) A FILE capability on node fails differently, and it is worth
// being exact about how, because it does NOT reproduce that failure. Measured on Linux 7.0 / node 22
// (a capped copy of node, run as an unprivileged user):
//   . it reaches no further than the binary: perl carries no file capability, so the shim it spawns
//     starts with an empty permitted set, and the plugin's node, exec'd under no_new_privs, gets none;
//   . it reaches EVERY script that binary runs, for every user on the machine: any `node -e` could
//     bind port 81, not only WordJS;
//   . it puts node in secure-execution mode (AT_SECURE=1): glibc strips TMPDIR and the LD_* family from
//     its environment, and the confined plugin child, exec'd from the same binary, inherits AT_SECURE
//     without the capability, so there Node also ignores NODE_OPTIONS and TMPDIR is gone;
//   . it lives in an xattr on the binary's inode, so a node upgrade (a new file renamed over the old
//     one) or any rewrite of the file silently removes it, and the next restart cannot bind its port.
//
// So the unit holds no capability at all, and a port below 1024 is reached the way the kernel offers an
// unprivileged service: net.ipv4.ip_unprivileged_port_start, written as a sysctl.d drop-in beside the
// unit. That has a cost the drop-in spells out (it lowers the floor for every unprivileged process in the
// network namespace, not for WordJS alone), which is why a reverse proxy on 80/443 in front of a high
// port is offered as the alternative everywhere this advice appears.
const DEFAULT_SERVICE_USER = 'wordjs';
const SYSTEMD_UNIT_FILE = 'wordjs.service';
const SYSCTL_DROPIN_FILE = '60-wordjs-ports.conf';
// The kernel default of net.ipv4.ip_unprivileged_port_start: binding a port below it needs privilege.
const PRIVILEGED_PORT_LIMIT = 1024;
// systemd's PATH for system services. WordJS runs `npm` BY NAME to install a plugin's declared
// dependencies at activation, and npm's own shebang finds node through PATH, so when node lives anywhere
// else its directory is prepended in the unit; otherwise activation would fail with ENOENT.
const SYSTEMD_DEFAULT_PATH = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin'];

/** Why `name` cannot be the service account, or null when it can. */
function serviceUserProblem(name) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(name))) {
        return {
            message: `"${name}" is not a usable account name for --service-user.`,
            hint: 'Use lowercase letters, digits, "_" or "-", starting with a letter or "_" (for example: wordjs).',
        };
    }
    if (name === 'root') {
        return {
            message: 'WordJS must not run as root.',
            hint: 'Use a dedicated account (the default is wordjs); the steps printed with the unit create it.',
        };
    }
    return null;
}

// A unit file is not a shell, but it is not inert either: `%` starts a specifier, `$` an environment
// expansion in ExecStart=, whitespace separates ExecStart= arguments and ReadWritePaths= entries, and
// quotes and backslashes are parsed. Rather than escape a path for three different parsers, accept only
// paths that need no escaping in any of them and ask for a plain one otherwise.
function unitSafePath(p) {
    return typeof p === 'string' && /^\/[A-Za-z0-9._@+,/-]*$/.test(p) && !p.split('/').includes('..');
}

function underAny(p, roots) {
    return roots.some((r) => p === r || p.startsWith(r + '/'));
}

/**
 * The sysctl.d drop-in that lets an unprivileged service bind from `start` up, with its trade-off
 * written into the file itself: whoever later finds it in /etc/sysctl.d/ should not have to guess why
 * it is there or what it costs.
 */
function sysctlDropIn(start, { http = false } = {}) {
    const lines = [
        `# WordJS: allow unprivileged processes to bind ports from ${start} up (written by create-wordjs --systemd).`,
        '#',
        '# This is NOT a grant to WordJS alone. It lowers the privileged-port floor for EVERY unprivileged',
        `# process in this network namespace, so any local user or service may bind ports ${start}-1023 too, and`,
        '# could take the port first while WordJS is stopped. Use it on a host you do not share with untrusted',
        '# users; otherwise put a reverse proxy (nginx, Caddy) on 80/443 and keep WordJS on a high port.',
        '# It covers IPv6 as well, despite its name. A container has its own network namespace and value.',
    ];
    if (!http && start > 80) {
        lines.push(`# Let's Encrypt HTTP-01 (acme.http01Port: 80 in wordjs-config.json) needs this lowered to 80.`);
    }
    lines.push(
        '#',
        `# Install: sudo install -o root -g root -m 0644 ${SYSCTL_DROPIN_FILE} /etc/sysctl.d/ && sudo sysctl --system`,
        `# Withdraw: sudo rm /etc/sysctl.d/${SYSCTL_DROPIN_FILE} && sudo sysctl -w net.ipv4.ip_unprivileged_port_start=1024 && sudo sysctl --system`,
        `net.ipv4.ip_unprivileged_port_start = ${start}`,
        '',
    );
    return lines.join('\n');
}

/**
 * Everything --systemd writes, as text: the unit, the sysctl drop-in when a bound port is below 1024, and
 * the warnings worth printing. Pure (POSIX paths in, strings out) so it can be exercised directly.
 *
 *   port            the explicit --port, or null. Only an explicit port is written into the unit: an
 *                   inherited value would silently override a port changed in the config later.
 *   configuredPort  the port the site's config already sets (gatewayPort), or null.
 *   acmeHttp01Port  acme.http01Port from the config, or null: monolith.js binds it beside an HTTPS
 *                   listener, so it counts toward the privileged-port floor.
 */
function buildSystemdFiles({ installDir, nodePath, user = DEFAULT_SERVICE_USER, port = null, configuredPort = null, acmeHttp01Port = null, http = false }) {
    for (const [what, p] of [['site directory', installDir], ['node binary', nodePath]]) {
        if (!unitSafePath(p)) {
            const err = new Error(`The ${what} path "${p}" cannot go into a systemd unit as is: it must be absolute, without spaces, quotes, backslashes, "%" or "$".`);
            err.hint = what === 'site directory'
                ? 'Install the site under a plain path such as /srv/wordjs.'
                : 'Install Node.js under a plain path such as /usr/bin/node or /usr/local/bin/node.';
            throw err;
        }
    }
    const problem = serviceUserProblem(user);
    if (problem) { const err = new Error(problem.message); err.hint = problem.hint; throw err; }

    const publicPort = port || configuredPort || 3000;
    const bound = [publicPort];
    if (!http && acmeHttp01Port) bound.push(acmeHttp01Port);
    const privileged = bound.filter((p) => p < PRIVILEGED_PORT_LIMIT);
    const sysctlStart = privileged.length ? Math.min(...privileged) : null;

    // Two hardening directives depend on WHERE things are, and each is dropped (with a warning) rather
    // than shipped in a shape that cannot start: ProtectHome= hides /home, /root and /run/user, which
    // breaks a site or a node (nvm, fnm, asdf) living there; PrivateTmp= gives the service an empty
    // /tmp and /var/tmp, which would hide a site installed there.
    const homeRoots = ['/home', '/root', '/run/user'];
    const tmpRoots = ['/tmp', '/var/tmp'];
    const warnings = [];
    if (underAny(installDir, homeRoots)) {
        warnings.push(`The site is inside a home directory (${installDir}). A service account usually cannot reach it there, and the unit leaves out ProtectHome=. Prefer /srv/<name> or /opt/<name>.`);
    }
    if (underAny(nodePath, homeRoots)) {
        warnings.push(`node runs from ${nodePath}, inside a home directory (nvm, fnm, asdf…). The service account usually cannot execute it there: install Node.js system-wide and point ExecStart= at it, or re-run this with that node.`);
    }
    if (underAny(installDir, tmpRoots)) {
        warnings.push(`The site is under a temporary directory (${installDir}), which the system may clean. The unit leaves out PrivateTmp= because it would hide the site; move it to /srv or /opt.`);
    }

    const nodeDir = path.posix.dirname(nodePath);
    const env = ['NODE_ENV=production'];
    if (port) env.push(`PORT=${port}`);
    if (http) env.push('WORDJS_HTTP=1');
    // HOME pinned inside the one writable tree: npm keeps its cache and reads its config under $HOME
    // when it installs plugin dependencies, and ProtectHome= would hide a home under /home.
    env.push(`HOME=${installDir}`);
    if (!SYSTEMD_DEFAULT_PATH.includes(nodeDir)) env.push(`PATH=${[nodeDir, ...SYSTEMD_DEFAULT_PATH].join(':')}`);

    const unit = [
        '# WordJS - generated by create-wordjs --systemd.',
        '#',
        `# Runs the site as the unprivileged account "${user}" and grants it NO Linux capabilities. Keep it`,
        '# that way: do not add AmbientCapabilities=, widen CapabilityBoundingSet= or setcap the node binary',
        '# to reach a port below 1024. On Linux every isolated plugin runs under a Landlock/seccomp sandbox',
        '# that has to shed any capability the service holds before it can confine the plugin.',
        sysctlStart
            ? `# Port ${publicPort} is below 1024: install ${SYSCTL_DROPIN_FILE} (next to this file) or use a reverse proxy.`
            : '# Ports below 1024: lower net.ipv4.ip_unprivileged_port_start, or use a reverse proxy.',
        '# See documentation/deployment.md, "Running as a service".',
        '',
        '[Unit]',
        'Description=WordJS (monolith)',
        'Documentation=https://github.com/jaimemartinez/wordjs/blob/main/documentation/deployment.md',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        `User=${user}`,
        `WorkingDirectory=${installDir}`,
        `ExecStart=${nodePath} ${installDir}/monolith.js prod`,
        ...env.map((e) => `Environment=${e}`),
        'Restart=on-failure',
        'RestartSec=5',
        '',
        '# Hardening. Each line takes something away; none grants anything.',
        '#   NoNewPrivileges, empty CapabilityBoundingSet: nothing the service runs can gain privileges',
        '#     (no setuid binary, no file capability). The plugin sandbox sets no_new_privs itself and',
        '#     needs no capability, so it is unaffected.',
        '#   ProtectSystem=strict + ReadWritePaths: the filesystem is read-only except the site directory,',
        '#     where WordJS writes its database, uploads, backups, plugins, themes and build caches.',
        '#   PrivateTmp, ProtectHome: a private /tmp, and no view of /home, /root or /run/user.',
        'NoNewPrivileges=yes',
        'CapabilityBoundingSet=',
        ...(underAny(installDir, tmpRoots) ? [] : ['PrivateTmp=yes']),
        'ProtectSystem=strict',
        `ReadWritePaths=${installDir}`,
        ...((underAny(installDir, homeRoots) || underAny(nodePath, homeRoots)) ? [] : ['ProtectHome=yes']),
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
    ].join('\n');

    return {
        unit,
        sysctl: sysctlStart ? { start: sysctlStart, content: sysctlDropIn(sysctlStart, { http }) } : null,
        publicPort,
        warnings,
    };
}

/**
 * The steps to install what buildSystemdFiles produced, as printable lines (pure, for the same reason).
 * `stageDir` is where writeSystemdFiles put the two files - never the site directory (see there).
 */
function systemdInstallSteps({ installDir, user = DEFAULT_SERVICE_USER, built, http = false, upgrade = false, nodePath = process.execPath, stageDir }) {
    const staged = (f) => path.posix.join(stageDir, f);
    const lines = [];
    let n = 0;
    const step = (title, ...cmds) => { lines.push(`  ${++n}. ${title}`); for (const c of cmds) lines.push(`       ${c}`); };
    lines.push('To run it as a service (as root):');
    step('Create the service account (skip if it exists):',
        `sudo useradd --system --home-dir ${installDir} --shell /usr/sbin/nologin ${user}`);
    step('Give it the site directory:', `sudo chown -R ${user}: ${installDir}`);
    // `install -o root -g root -m 0644` and not `cp`: root takes the staged file's CONTENT into a file it
    // creates itself, root-owned and not writable by anyone else, whatever the staged copy's mode was.
    if (built.sysctl) {
        step(`Let it bind port ${built.publicPort} without a capability (read the trade-off in the file first):`,
            `sudo install -o root -g root -m 0644 ${staged(SYSCTL_DROPIN_FILE)} /etc/sysctl.d/${SYSCTL_DROPIN_FILE} && sudo sysctl --system`);
    } else if (upgrade) {
        // A site that moved to a high port (behind a proxy, say) no longer needs the floor lowered, and an
        // installed drop-in would go on letting every unprivileged process bind below 1024 for no reason.
        // Setting 1024 first and re-applying the rest leaves any OTHER drop-in's value in force.
        step(`Port ${built.publicPort} needs no lowered port floor. If an earlier run installed /etc/sysctl.d/${SYSCTL_DROPIN_FILE}, withdraw it:`,
            `sudo rm -f /etc/sysctl.d/${SYSCTL_DROPIN_FILE} && sudo sysctl -w net.ipv4.ip_unprivileged_port_start=1024 && sudo sysctl --system`);
    }
    step('Install the unit and start it:',
        `sudo install -o root -g root -m 0644 ${staged(SYSTEMD_UNIT_FILE)} /etc/systemd/system/${SYSTEMD_UNIT_FILE}`,
        // enable on upgrade too: a site started with `npm run start:mono`, pm2 or a unit of another name
        // has no enabled wordjs.service, and a restart alone does not bring it back after a reboot.
        upgrade ? 'sudo systemctl daemon-reload && sudo systemctl enable wordjs && sudo systemctl restart wordjs'
            : 'sudo systemctl daemon-reload && sudo systemctl enable --now wordjs');
    if (!upgrade) {
        const proto = http ? 'http' : 'https';
        const defaultPort = http ? 80 : 443;
        const hostPort = built.publicPort === defaultPort ? '<your-host>' : `<your-host>:${built.publicPort}`;
        step('Finish setup in the browser with the one-time install token the first boot writes:',
            `sudo cat ${path.posix.join(installDir, 'backend', 'data', 'install-token')}`,
            `then open ${proto}://${hostPort}/install#token=<that token>`);
    } else {
        lines.push('  Before step ' + n + ', stop and disable whatever served this site until now, or it and wordjs.service',
            '  will fight over the port: a unit with another name (sudo systemctl disable --now <name>), pm2',
            '  (pm2 delete <name> && pm2 save), or a foreground `npm run start:mono`. A unit that was also named',
            '  wordjs.service is replaced by step ' + n + ' - including an AmbientCapabilities= or capability-carrying',
            `  CapabilityBoundingSet= in it. If node carries a file capability (check with getcap ${nodePath}),`,
            `  remove it: sudo setcap -r ${nodePath}`);
    }
    lines.push(`  The staged copies in ${stageDir} are not needed afterwards: rm -r ${stageDir}`);
    lines.push('  Logs: journalctl -u wordjs -f');
    return lines;
}

/**
 * A fresh, private directory to stage the files root will install.
 *
 * NEVER THE SITE DIRECTORY. These two files are read by root and installed into /etc - the unit decides
 * which account the service runs as and what it may do; the drop-in is applied with `sysctl --system`.
 * The site directory is handed to the service account by the very next printed step (`chown -R`), so a
 * compromised WordJS process - or a plugin that got out of its sandbox - could rewrite either file
 * between that step and root's copy (`User=root`, an ExecStartPre=; `kernel.modprobe = …`), or put a
 * symlink in its place so this CLI, run with sudo, wrote through it into any file root can write.
 * Measured: as the service account, a planted symlink made a root run of the old writer overwrite a
 * root-only 0600 file, and a plain `mv` replaced the staged drop-in root was told to apply.
 * mkdtemp creates a new directory, mode 0700, owned by whoever runs this CLI, under a name nobody could
 * predict; the service account cannot enter it.
 */
function createSystemdStagingDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-systemd-'));
}

/**
 * Write the unit (and the sysctl drop-in when one is needed) into `stageDir`, a directory from
 * createSystemdStagingDir(). Each file is created EXCLUSIVELY (`wx` = O_CREAT|O_EXCL): an existing file -
 * or a symlink planted under the name - makes the write fail rather than go through it.
 */
function writeSystemdFiles(stageDir, built) {
    const unitPath = path.join(stageDir, SYSTEMD_UNIT_FILE);
    const sysctlPath = path.join(stageDir, SYSCTL_DROPIN_FILE);
    fs.writeFileSync(unitPath, built.unit, { flag: 'wx', mode: 0o644 });
    if (built.sysctl) fs.writeFileSync(sysctlPath, built.sysctl.content, { flag: 'wx', mode: 0o644 });
    return { unitPath, sysctlPath: built.sysctl ? sysctlPath : null };
}

/**
 * Why --systemd cannot run for this site, with this node and as this account - or null. Checked before
 * anything is downloaded, extracted or installed: a create used to fetch and install the whole release
 * and only THEN refuse the path, leaving the populated directory behind, and an upgrade applied the new
 * version and then exited 1.
 */
function systemdPreflight({ installDir, nodePath = process.execPath, user = DEFAULT_SERVICE_USER, runningAs = null }) {
    for (const [what, p] of [['site directory', installDir], ['node binary', nodePath]]) {
        if (!unitSafePath(p)) {
            return {
                message: `The ${what} path "${p}" cannot go into a systemd unit as is: it must be absolute, without spaces, quotes, backslashes, "%" or "$".`,
                hint: what === 'site directory'
                    ? 'Install the site under a plain path such as /srv/wordjs.'
                    : 'Install Node.js under a plain path such as /usr/bin/node or /usr/local/bin/node.',
            };
        }
    }
    // The files root will install must not be writable by the service. Staged by the service account
    // itself, they would be.
    if (runningAs && runningAs === user) {
        return {
            message: `This is running as "${user}", the account the service will run as.`,
            hint: 'Run create-wordjs --systemd as your own account or with sudo: the unit it stages for root must not be writable by the service.',
        };
    }
    return null;
}

/** --systemd for a site on disk: read its config, stage the files, print the steps. Throws (with .hint) instead of exiting, so a caller's cleanup still runs. */
function emitSystemd(installDir, opts) {
    const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
    // The same precedence monolith.js applies (minus the PORT env var, which is what --port writes).
    const appConfig = readJson(path.join(installDir, 'backend', 'wordjs-config.json'));
    const gwConfig = readJson(path.join(installDir, 'gateway', 'gateway-config.json'));
    const user = opts.serviceUser || DEFAULT_SERVICE_USER;
    const built = buildSystemdFiles({
        installDir,
        nodePath: process.execPath,
        user,
        port: opts.port,
        configuredPort: Number(appConfig.gatewayPort || gwConfig.gatewayPort) || null,
        acmeHttp01Port: Number(appConfig.acme && appConfig.acme.http01Port) || null,
        http: opts.http,
    });
    const stageDir = createSystemdStagingDir();
    const written = writeSystemdFiles(stageDir, built);
    console.log('');
    console.log(`   systemd unit staged: ${written.unitPath}`);
    if (written.sysctlPath) console.log(`   sysctl drop-in for port ${built.publicPort}: ${written.sysctlPath}`);
    console.log('   (staged outside the site on purpose: the service account will own the site, and must not be able to edit what root installs)');
    for (const w of built.warnings) console.log(`   ⚠️  ${w}`);
    console.log('');
    for (const l of systemdInstallSteps({ installDir, user, built, http: opts.http, upgrade: opts.mode === 'upgrade', stageDir })) console.log(`   ${l}`);
}

// Printed on Linux after a plain (non --systemd) create, in place of the `setcap` line this installer
// used to print. Why setcap is not the answer is explained above buildSystemdFiles.
const LOW_PORT_ADVICE = [
    '   • Serving on 80/443 later? A non-root process cannot bind a port below 1024 by default.',
    '     Put a reverse proxy (nginx, Caddy) on 80/443 in front of this port, or lower',
    '     net.ipv4.ip_unprivileged_port_start. Do not give node a capability (setcap): see',
    '     documentation/deployment.md. A service unit that does this right: re-run with --systemd',
    '     (for this site: npx create-wordjs@latest upgrade <dir> --systemd).',
];

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-upgrade-'));
    let zipCleanup = () => {};
    const cleanup = () => { zipCleanup(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } };
    try {
        const obtained = await obtainBundleZip(opts);
        zipCleanup = obtained.cleanup;
        const extractDir = path.join(tmpDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        extractZip(obtained.zipPath, extractDir);
        return { extractDir, tag: obtained.tag, cleanup };
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
            console.log(`\n✅ Already on v${curVersion}. Nothing to upgrade.  (use --force to re-apply the same version)`);
            // --systemd on an up-to-date site is still a request for the unit: it is how an existing
            // install replaces a hand-written unit (one with AmbientCapabilities=, say) with this one.
            if (opts.systemd) emitSystemd(installDir, opts);
            console.log('');
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
        if (opts.systemd) emitSystemd(installDir, opts);
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

    const { zipPath, cleanup } = await obtainBundleZip(opts);

    console.log(`  Extracting into ${targetDir}…`);
    try { extractZip(zipPath, targetDir); }
    finally { cleanup(); }

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
    // The join commands below are only safe with the real fingerprint in them (join requires --ca-hash),
    // so a missing one is fatal here rather than a '<fingerprint>' placeholder pasted onto the nodes.
    const fp = (runNodeCapture('scripts/cluster.js', ['info'], targetDir).match(/CA fingerprint:\s*([0-9a-f]{64})/) || [])[1];
    if (!fp) fail('Could not read the cluster CA fingerprint from "node scripts/cluster.js info".', `Run it yourself in ${opts.dir} and pass the value to join as --ca-hash.`);
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
    // The CA pin is what stops an on-path attacker from receiving the token, the cluster secret and a
    // CA-signed cert during enrollment, so it is required. Checked HERE, before the download + install.
    if (!opts.caHash) {
        fail('--ca-hash <sha256> is required for join.',
            'Use the fingerprint the gateway printed (node scripts/cluster.js info on the gateway). Enrolling without it\n  would be trust-on-first-use, which is not supported.');
    }
    if (!normalizeSha256(opts.caHash)) fail(`--ca-hash must be the 64-character hex CA fingerprint, got "${opts.caHash}".`);

    const targetDir = path.resolve(process.cwd(), opts.dir);
    console.log(`\n🚀 create-wordjs · join ${opts.role} (separate mode)\n`);
    await scaffoldBundle(opts, targetDir);

    const advertise = opts.advertise || firstLanIp();
    const args = ['--role', opts.role, '--gateway', opts.gateway, '--enroll-port', String(opts.enrollPort || 3101),
        '--token', opts.token, '--advertise', advertise];
    args.push('--ca-hash', opts.caHash);
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
    // Checked before anything is downloaded: the unit names this machine's node and site paths, so it
    // can only be generated on the Linux host that will run it.
    if (opts.systemd && process.platform !== 'linux') {
        fail('--systemd writes a Linux systemd unit, and this machine is not running Linux.',
            'Run create-wordjs with --systemd on the Linux host that will run the site.');
    }
    // ...and so is everything else the unit depends on: the site path, the node path and who is running
    // this. Before, a path the unit cannot hold was found only after the whole release had been fetched
    // and installed (create) or applied (upgrade), which then exited 1 with the work done.
    if (opts.systemd) {
        let runningAs = null;
        try { runningAs = os.userInfo().username; } catch { /* unknown: the check below is skipped */ }
        const problem = systemdPreflight({
            installDir: path.resolve(process.cwd(), opts.dir),
            nodePath: process.execPath,
            user: opts.serviceUser || DEFAULT_SERVICE_USER,
            runningAs,
        });
        if (problem) fail(problem.message, problem.hint);
    }
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

    // 1) Obtain the release ZIP (local path, https URL, or GitHub latest/tagged release) and verify
    //    its SHA-256 before anything is extracted.
    const { zipPath, cleanup } = await obtainBundleZip(opts);

    // 2) Extract + sanity-check that this really is a WordJS release bundle.
    console.log(`  Extracting into ${targetDir}…`);
    try {
        extractZip(zipPath, targetDir);
    } finally {
        cleanup();
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

    // --systemd implies --no-start: started from here, the first boot would run as whoever ran npx and
    // leave the database, install token and certificates owned by that account instead of the service's.
    if (opts.systemd) {
        console.log(`\n${line}`);
        console.log(`✅ WordJS scaffolded into ${targetDir} (dependencies installed). Not started: the first`);
        console.log('   boot must run as the service account, so that it owns the files it creates.');
        emitSystemd(targetDir, opts);
        console.log(line + '\n');
        return;
    }

    if (!opts.start) {
        console.log(`\n${line}`);
        console.log(`✅ WordJS scaffolded into ${opts.dir} (dependencies installed).`);
        console.log('');
        console.log('   Start it whenever you are ready:');
        console.log(`      cd ${opts.dir}`);
        console.log(`      npm run start:mono${opts.http ? '        (with WORDJS_HTTP=1 in the environment for plain HTTP)' : ''}`);
        console.log('');
        console.log('   That first boot mints a one-time install token. The server prints it in its');
        console.log(`   banner as a clickable URL (${proto}://localhost:3000/install#token=…) only when its`);
        console.log('   stdout is a terminal — which it is if you run the command above yourself. Off a');
        console.log('   TTY (systemd, Docker, a pipe) the banner shows the URL WITHOUT the token; read it');
        console.log(`   from ${path.join(opts.dir, 'backend', 'data', 'install-token')} (mode 0600) instead,`);
        console.log('   or set WORDJS_PRINT_INSTALL_TOKEN=1 to have it printed either way.');
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
    // The token rides in the URL FRAGMENT, not a `?token=` query string: a fragment is never sent to
    // any server, so this bootstrap secret stays out of access/proxy logs and out of the `Referer` of
    // every sub-resource the install page loads. The wizard reads `#token=` (and still accepts a
    // legacy `?token=`) and scrubs it from the address bar. Keep in sync with the backend's own
    // banner in backend/src/core/install-token.ts.
    console.log(`   → ${proto}://localhost:3000/install#token=${token}`);
    console.log('');
    console.log('   • The server is starting below — give it ~15–30 seconds, then open the URL.');
    if (!opts.http) {
        console.log('   • HTTPS uses a locally generated self-signed certificate, so your browser will');
        console.log('     warn once ("Your connection is not private") — click Advanced → Proceed.');
        console.log('     That is expected for localhost. (Prefer plain HTTP? Re-run with --http.)');
    }
    console.log('   • Stop the server:  press Ctrl+C in this window.');
    console.log(`   • Start it later:   cd ${opts.dir} && npm run start:mono`);
    console.log('     (a fresh token is minted on every start until setup is finished; the server prints');
    console.log('      it in its banner when stdout is a terminal, and always writes it to');
    console.log('      backend/data/install-token, mode 0600)');
    if (process.platform === 'linux') {
        console.log('');
        for (const l of LOW_PORT_ADVICE) console.log(l);
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
    main().catch((e) => fail(e && e.message ? e.message : String(e), e && e.hint));
}

module.exports = {
    pickBundleAsset, pickChecksumAsset, extractZip, normalizeSha256, parseChecksumFile, classifyZipSource, sha256File,
    parseArgs, buildSystemdFiles, systemdInstallSteps, writeSystemdFiles,
    sysctlDropIn, serviceUserProblem, systemdPreflight, createSystemdStagingDir, LOW_PORT_ADVICE, HELP, installedFileMode,
};
