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
    'brain',
    '.agent',
    '.gemini',
    'ssl-auto.crt',    // Exclude local certs
    'ssl-auto.key',
    'backend/cli',     // Exclude test/debug scripts
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
**install wizard**: choose your database (SQLite — zero-config — or PostgreSQL with a connection
test), create your admin account, and you're in.

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
    for (const pattern of IGNORE_PATTERNS) {
        if (pattern.startsWith('*')) continue;                 // extension globs are handled above
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

run();
