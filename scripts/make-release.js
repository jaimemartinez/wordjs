/**
 * WordJS Release Packager
 * 
 * Orchestrates full-system builds and packages everything into a production-ready ZIP.
 * 
 * Includes:
 * - Gateway
 * - Backend (Source + Plugin Bundles)
 * - Frontend (Source + .next Build)
 * - Documentation
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
    'build-production.ps1'
];

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
        console.log('\n⚛️ Building Frontend (admin-next)...');
        console.log('   (This may take a few minutes)');
        execSync('npm run build', {
            cwd: path.join(ROOT_DIR, 'admin-next'),
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

    // Check if path contains any ignored pattern (e.g. .next/cache, node_modules)
    for (const pattern of IGNORE_PATTERNS) {
        if (relativePath.includes(pattern)) return true;
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

run();
