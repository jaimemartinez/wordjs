/**
 * WordJS Release Packager
 * 
 * Orchestrates full-system builds and packages everything into a production-ready ZIP.
 * 
 * Includes:
 * - Gateway
 * - Backend (Source + Plugin Bundles)
 * - Frontend (Source + .next Build)
 * Includes:
 * - Gateway
 * - Backend (Source + Plugin Bundles)
 * - Frontend (Source + .next Build)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
// archiver removed as we use adm-zip from backend node_modules

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const TEMP_DIST = path.join(RELEASE_DIR, 'wordjs-package');

// Files and folders to exclude from the release
const IGNORE_PATTERNS = [
    'node_modules',
    '.git',
    '.github',
    '.gitignore',
    '.next/cache',
    '.next/dev',     // Exclude development cache
    'release',
    'os-tmp',
    'logs',
    '*.log',
    '.DS_Store',
    'desktop.ini',
    'database.sqlite', // Local DB
    'wordjs-config.json', // Local config
    'gateway-config.json', // SECURITY: gateway-config.json holds the live gatewaySecret — never ship it
    'gateway-registry.json', // Gateway state
    '.env',
    // SECURITY + SIZE: agent/assistant working directories. They are LOCAL developer state, they
    // are gitignored (so a CI release built from a clean checkout never sees them), but a release
    // packaged from a real working tree does. `.claude` was missing from this list and cost 46 MB of
    // a 97 MB artifact — 6744 of its 12169 entries — including full git WORKTREES under
    // `.claude/worktrees/`, plus `mcp.json` and `settings.local.json`, which can hold credentials
    // for connected servers. The whole family is listed here rather than just the one that bit us.
    'brain',
    '.agent',
    '.gemini',
    '.claude',
    '.cursor',
    '.aider.chat.history.md',
    '.aider.input.history',
    'ssl-auto.crt',    // Exclude local certs
    'ssl-auto.key',
    'backend/cli',     // Exclude test/debug scripts (see CLI_SHIPPED for the product CLI carve-out)
    'backend/uploads', // Exclude local uploads
    'backend/check_plugins.js', // Legacy debug
    'check_plugins.js',
    'debug-inbox.js',
    'dump-routes.js',
    'build-production.ps1',
    'marketplace', // Marketplace plugins are DISTRIBUTED separately (release assets), never bundled in the core package
    // SECURITY: private CLIENT plugins. They are gitignored (CI releases built from git never see
    // them) but they DO exist in local working trees — without these entries a locally-run
    // `npm run bundle-release` would ship client code+secrets inside the public ZIP.
    'backend/plugins/toscano',
    'backend/plugins/toscano-platform',
];

// SECURITY: never ship local databases, private keys or TLS material in a release. The sensitive
// DIRECTORIES are ANCHORED to their KNOWN top-level locations (not a bare segment match anywhere in
// the path) so we never silently drop legitimate runtime source that merely lives under a nested dir
// literally named data/ certs/ ssl/ (e.g. a future plugins/<x>/data/seed.js or a frontend/src/lib/data
// build input). The real runtime DB/cert/TLS dirs are: data/, backend/data/, certs/, backend/certs/,
// gateway/certs/, gateway/ssl/. Extension entries match the file SUFFIX and run independently, so any
// *.db / *.sqlite / *.sqlite3 / *.key / *.pem is dropped wherever it sits. Secrets are generated
// locally during install, never bundled. (DEPLOY-02)
// Top-level runtime DB/cert/TLS dirs + EACH plugin's own data/ dir (plugins store runtime secrets at
// rest there, e.g. mail-server's AES root key data/.mailenc — DEPLOY-MAILENC-02). The plugins/<x>/data/
// match is specific (not a bare nested data/ anywhere), so it never drops legit source like
// frontend/src/lib/data/. A plugin's theme/ (its COMPANION THEME, installable via
// POST /plugins/<slug>/install-theme) is SOURCE, not runtime state — it must keep shipping, so never
// widen this regex (or IGNORE_PATTERNS) to match theme/ or themes/.
// CARVE-OUT of the `backend/cli` exclusion above. That directory is mostly one-off debug scripts that
// dump users, roles and tokens — they must never ship. But it ALSO holds `wordjs.js`, the product CLI
// the docs point operators at (`create theme --primary …`, `build theme`, `doctor theme`, plugin
// scaffolding) plus the templates it writes from. Excluding the whole directory made every documented
// CLI command absent from the artifact operators actually deploy. Only these paths escape the
// exclusion; the secret/extension checks below still run on them.
const CLI_SHIPPED = new Set(['backend/cli', 'backend/cli/wordjs.js', 'backend/cli/templates']);
const isShippedCli = (rel) => CLI_SHIPPED.has(rel) || rel.startsWith('backend/cli/templates/');

const SECRET_DIR_RE = /^(?:backend\/|gateway\/)?(?:data|certs)\/|^gateway\/ssl\/|(?:^|\/)plugins\/[^/]+\/data\//;
const SECRET_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.key', '.pem', '.mailenc'];

const INSTALL_MD = `# WordJS — Install & Run (compiled release)

This package is **pre-compiled** — you do NOT need to build anything. Install the runtime
dependencies, then start. The database is created fresh during the install wizard; no data ships
with this package.

## Requirements
- Node.js >= 20.9 (Node 20 or 22 LTS recommended)

## 1. Install runtime dependencies (no build step)
\`\`\`
npm run release:install
\`\`\`
This installs production dependencies for the gateway, backend and frontend (prebuilt native
binaries are downloaded — nothing is compiled from TypeScript).

## 2. Start (pick one)
\`\`\`
npm run start:mono     # single process, one port (simplest)
# or
npm start              # three services: gateway + backend + frontend
\`\`\`

## 3. Finish setup in your browser
Open the URL printed in the console (default https://localhost:3000). The first run shows the
**install wizard**: pick your database — **SQLite** (zero-config, the default), **PostgreSQL** or
**MySQL / MariaDB** (both with a built-in connection test), or the pure-JS *SQLite (legacy / WASM)*
fallback for hosts where the native binary cannot load — then create your admin account, and you're in.

## Notes
- Secrets (JWT, gateway, DB password) are generated locally during install and stored in
  \`backend/wordjs-config.json\` — never shipped, never committed.
- For a public deployment, terminate TLS at a reverse proxy (Nginx/Caddy/Cloudflare) or use the
  built-in HTTPS. See \`documentation/deployment.md\`.
`;

async function run() {
    console.log('🚀 WordJS Release Packager');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
        // 1. Cleanup
        console.log('\n🧹 Cleaning up previous releases...');
        if (fs.existsSync(RELEASE_DIR)) {
            fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(TEMP_DIST, { recursive: true });

        // 2. Build Frontend
        console.log('\n⚛️ Building Frontend (frontend)...');
        console.log('   (This may take a few minutes)');
        execSync('npm run build', {
            cwd: path.join(ROOT_DIR, 'frontend'),
            stdio: 'inherit'
        });

        // 2b. Compile Backend (TypeScript -> dist) so the release runs WITHOUT compiling on the
        //     user's machine. backend/server.js prefers dist/index.js when present.
        console.log('\n🛠️ Compiling Backend (tsc -> dist)...');
        execSync('npm run build', {
            cwd: path.join(ROOT_DIR, 'backend'),
            stdio: 'inherit'
        });

        // 2c. VERIFY THE COMPILE INSTEAD OF ASSUMING IT.
        //
        // `npm run build` exiting 0 says the compiler ran, not that dist/ is now a faithful copy of
        // src/. A partial build, an interrupted one, or a `tsc -p tsconfig.build.json` run by hand
        // (which does NOT clear dist/) all leave a tree that loads — and production loads dist/, so
        // every difference is a behaviour the artefact has and the source does not. Two audit findings
        // stayed exploitable exactly this way after being fixed in src/.
        //
        // The same walk backs the suite's release gate (backend/src/tests/dist-mysql-driver-
        // freshness.test.ts). That gate SKIPS on a checkout that never built, which is most CI runs —
        // so the artefact needs checking at the moment it is produced, which is here.
        console.log('\n🔎 Verifying the compiled backend matches its source...');
        const { assertCompiledTreeIsFresh } = require(path.join(ROOT_DIR, 'backend', 'scripts', 'stale-compiled-files.js'));
        const freshness = assertCompiledTreeIsFresh();   // throws, aborting the release, on any drift
        console.log(`   ✅ ${freshness.checked} compiled files present, current and accounted for.`);

        // 3. Build Plugins
        console.log('\n🔌 Building Plugin Bundles...');
        execSync('node scripts/build-plugin.js --all', {
            cwd: path.join(ROOT_DIR, 'backend'),
            stdio: 'inherit'
        });

        // 4. Copying Files
        console.log('\n📂 Copying files to package...');
        copyFiles(ROOT_DIR, TEMP_DIST);

        // 4b. Write a self-contained INSTALL guide into the bundle.
        console.log('\n📝 Writing INSTALL.md...');
        fs.writeFileSync(path.join(TEMP_DIST, 'INSTALL.md'), INSTALL_MD);

        // 5. Creating ZIP
        console.log('\n📦 Creating final ZIP archive...');
        await createZip(TEMP_DIST, path.join(RELEASE_DIR, 'wordjs-compiled-release.zip'));

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ RELEASE COMPLETE!');
        console.log(`📍 File: ${path.join(RELEASE_DIR, 'wordjs-compiled-release.zip')}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    } catch (error) {
        console.error('\n❌ Release failed:', error.message);
        process.exit(1);
    }
}

/**
 * Recursive file copy with filter
 */
function copyFiles(src, dest) {
    const stats = fs.statSync(src);
    const isDirectory = stats.isDirectory();
    const basename = path.basename(src);

    // Check ignore patterns
    if (shouldIgnore(src)) {
        return;
    }

    if (isDirectory) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        fs.readdirSync(src).forEach(child => {
            copyFiles(path.join(src, child), path.join(dest, child));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

/**
 * WHAT GIT KNOWS ABOUT — the structural half of the exclusion rules.
 *
 * The blocklist below is a list of NAMES, and a list of names is always one tool behind: it already
 * missed `.claude/` (46 MB of a 97 MB artifact, including `mcp.json` and full git worktrees) and,
 * right after that was fixed, `.mcp.json` plus a handful of the developer's scratch files. This
 * project has learned the same lesson three times over in its security work: never infer safety
 * from the ABSENCE of a name in a list.
 *
 * So the question is inverted. A release is built from a REAL WORKING TREE, and the authority on
 * what belongs to the project is git: everything git does not track is developer-local unless it is
 * a BUILD ARTIFACT we deliberately ship. Those are enumerated (they are gitignored by design), and
 * everything else untracked is dropped.
 *
 * If git is unavailable the packager falls back to the name list and SAYS SO — a quieter artifact
 * is better than a failed build, but a silent downgrade would put us back where we started.
 */
const SHIPPED_BUILD_ARTIFACTS = [
    'backend/dist',                              // compiled backend — the whole point of a compiled release
    'frontend/.next',                            // Next build output
    'frontend/src/lib/pluginRegistry.ts',        // generated at prebuild from the installed plugins
    'frontend/src/lib/versoPluginRegistry.ts',
    'frontend/src/lib/adminPluginRegistry.ts',
];

let trackedFiles = null;      // Set<string> of repo-relative paths, or null when git is unavailable
let trackedWarned = false;

function loadTrackedFiles() {
    if (trackedFiles !== null) return trackedFiles;
    try {
        const out = require('child_process').execSync('git ls-files -z', {
            cwd: ROOT_DIR, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const list = out.toString('utf8').split('\0').filter(Boolean);
        if (!list.length) throw new Error('git ls-files returned nothing');
        trackedFiles = new Set(list);
        console.log(`   🔒 git knows ${trackedFiles.size} files — anything else is local and will NOT ship`);
    } catch (e) {
        trackedFiles = false;
        console.log(`   ⚠️  git unavailable (${e.message}) — falling back to the name-based exclusion list ONLY.`);
        console.log('      Review the archive before publishing: untracked local files may be included.');
    }
    return trackedFiles;
}

/** Is this path a build artifact we deliberately ship even though git ignores it? */
function isShippedArtifact(relativePath) {
    return SHIPPED_BUILD_ARTIFACTS.some(
        (a) => relativePath === a || relativePath.startsWith(a + '/'),
    );
}

function shouldIgnore(filePath) {
    const basename = path.basename(filePath);

    // Exact match
    if (IGNORE_PATTERNS.includes(basename)) return true;

    // Glob-like match for extensions
    if (basename.endsWith('.log')) return true;

    // Specific path matches
    const relativePath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');

    // Don't include the release folder itself
    if (relativePath.startsWith('release')) return true;

    // Match ignore patterns at PATH-SEGMENT boundaries, NOT as raw substrings. A bare directory name
    // like `marketplace` or `logs` used with a naive `.includes()` also strips legitimate source whose
    // path merely CONTAINS it — e.g. `backend/dist/routes/marketplace.js` (the compiled marketplace
    // ROUTE), which silently vanished from the v1.6.0 bundle and crashed the backend on boot
    // (`Cannot find module './marketplace'`). Segment matching keeps the top-level `marketplace/`
    // catalog excluded while preserving `routes/marketplace.js`.
    const segments = relativePath.split('/');
    const shippedCli = isShippedCli(relativePath);
    for (const pattern of IGNORE_PATTERNS) {
        if (pattern.startsWith('*')) continue;                 // extension globs are handled above
        if (pattern === 'backend/cli' && shippedCli) continue;  // product CLI carve-out (see CLI_SHIPPED)
        if (pattern.includes('/')) {                           // path fragment (e.g. backend/cli, .next/cache)
            if (relativePath === pattern || relativePath.startsWith(pattern + '/') ||
                relativePath.includes('/' + pattern + '/') || relativePath.endsWith('/' + pattern)) return true;
        } else if (segments.includes(pattern)) {               // bare dir/file NAME → full-segment match
            return true;
        }
    }

    // SECURITY: drop databases / private keys / TLS material — the secret DIRS are anchored to their
    // known top-level locations (SECRET_DIR_RE) so we never strip legitimate source (e.g.
    // routes/certs.js, or a nested dir incidentally named data/) while still dropping the real
    // DB/cert/TLS trees. (DEPLOY-02)
    if (SECRET_DIR_RE.test(relativePath)) return true;
    const lowerBase = basename.toLowerCase();
    if (SECRET_EXTENSIONS.some(ext => lowerBase.endsWith(ext))) return true;

    // SECURITY: drop any *-config.json (e.g. gateway-config.json, wordjs-config.json) that may hold
    // secrets such as the gatewaySecret. Anchored to a leading separator so legitimate build configs
    // (tsconfig.json, next.config.json, jest.config.json, package.json) are NOT matched. ALSO drop any
    // basename containing `wordjs-config` / `gateway-config` — that catches BACKUPS/variants like
    // wordjs-config.backup.json (created by index.ts on config rewrite) which carry the same
    // jwtSecret/gatewaySecret/dbPassword and would otherwise slip past the `*-config.json$` anchor. (DEPLOY-01)
    if (/(^|-)config\.json$/.test(lowerBase) || lowerBase.includes('wordjs-config') || lowerBase.includes('gateway-config')) return true;

    // THE STRUCTURAL RULE, last so the explicit ones above still short-circuit: if git does not track
    // it and it is not one of the build artifacts we deliberately ship, it is developer-local and does
    // not belong in a published archive. Directories are kept only when they could still CONTAIN
    // something shippable — pruning a whole tree here would drop `backend/dist` and `frontend/.next`.
    const tracked = loadTrackedFiles();
    // The ROOT itself has an empty relative path: no tracked file "starts with" it, so without this
    // guard the rule below prunes the entire tree and produces an 865-byte archive. (Caught by
    // rebuilding and looking at the artifact — which is why that check is part of the routine.)
    if (tracked && relativePath && !isShippedArtifact(relativePath)) {
        let isDir = false;
        try { isDir = fs.statSync(filePath).isDirectory(); } catch { /* vanished mid-copy: treat as file */ }
        if (isDir) {
            const prefix = relativePath + '/';
            const keeps = SHIPPED_BUILD_ARTIFACTS.some((a) => a === relativePath || a.startsWith(prefix));
            if (!keeps) {
                let hasTracked = false;
                for (const f of tracked) { if (f.startsWith(prefix)) { hasTracked = true; break; } }
                if (!hasTracked) {
                    if (!trackedWarned) { trackedWarned = true; }
                    return true;
                }
            }
        } else if (!tracked.has(relativePath)) {
            return true;
        }
    }

    return false;
}

/**
 * Create a ZIP archive using backend's adm-zip if available, or fall back to archiver
 */
async function createZip(sourceDir, outPath) {
    // Try to use AdmZip from backend as it's already a dependency
    try {
        const AdmZip = require(path.join(ROOT_DIR, 'backend', 'node_modules', 'adm-zip'));
        const zip = new AdmZip();
        zip.addLocalFolder(sourceDir);
        zip.writeZip(outPath);
        return;
    } catch (e) {
        console.log('   (Backend adm-zip not found, falling back to manual check...)');
        throw new Error('Please ensure backend dependencies are installed: cd backend && npm install');
    }
}

// Packaging when INVOKED (npm run bundle-release); importable when REQUIRED, so the exclusion rules
// can be tested without building a 97 MB artifact. `require.main === module` is the standard guard.
if (require.main === module) {
    run();
} else {
    module.exports = { shouldIgnore, IGNORE_PATTERNS, ROOT_DIR };
}
