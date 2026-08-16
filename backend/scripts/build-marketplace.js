/**
 * WordJS marketplace builder.
 *
 * Packs every plugin under marketplace/plugins/<slug>/ into marketplace/dist/<slug>-<version>.zip
 * and emits marketplace/dist/marketplace-index.json — the catalog consumed by
 * backend/src/routes/marketplace.ts (locally in dev, or as GitHub Release assets in production).
 *
 * Run from the repo root:  npm run build:marketplace
 * (Lives in backend/scripts so require('adm-zip') resolves against backend/node_modules.)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { spawnSync } = require('child_process');
// The catalog advertises "this plugin ships an editor block". Read that through the SHARED resolver,
// never by naming one manifest key here: a local copy of this logic already drifted once (it looked
// for `frontend.component.entry`, a key that never existed) and shipped bundle-less zips.
const { readDeclaredBlockEntry } = require('./plugin-block-contract');

// Repo root. WORDJS_MARKETPLACE_ROOT lets the catalog tests drive THIS script (the real producer)
// over a small fixture tree instead of re-implementing the packing rules in the test — a test whose
// fixture is packed by anything other than the shipping builder proves nothing about the shipping builder.
const ROOT = process.env.WORDJS_MARKETPLACE_ROOT
    ? path.resolve(process.env.WORDJS_MARKETPLACE_ROOT)
    : path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'marketplace', 'plugins');
const DIST = path.join(ROOT, 'marketplace', 'dist');

// Slug → catalog category (single source of truth; new plugins default to 'General').
const CATEGORIES = {
    'contact-forms': 'Formularios', 'newsletter': 'Marketing', 'events-calendar': 'Eventos',
    'cookie-consent': 'Legal', 'social-share': 'Social', 'testimonials': 'Social',
    'faq': 'Contenido', 'popup-builder': 'Marketing', 'analytics-tag': 'Marketing',
    'table-of-contents': 'Contenido', 'related-posts': 'Contenido', 'breadcrumbs': 'SEO',
    'image-lightbox': 'Medios', 'polls': 'Contenido', 'notification-bar': 'Marketing',
    'online-store': 'Comercio', 'vendor-marketplace': 'Comercio', 'bookings': 'Comercio',
    'donations': 'Comercio', 'digital-downloads': 'Comercio', 'invoices': 'Comercio',
    'job-board': 'Comercio', 'restaurant-menu': 'Comercio', 'event-tickets': 'Comercio',
    'auctions': 'Comercio', 'youtube-videos': 'Medios', 'conference-manager': 'Eventos',
    'mail-server': 'Email',
};

// Junk that must never ship inside a plugin zip.
const SKIP_RE = /(^|[\\/])(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|\.git|node_modules)([\\/]|$)/i;

function walk(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (SKIP_RE.test(p)) continue;
        if (e.isDirectory()) out.push(...walk(p));
        else out.push(p);
    }
    return out;
}

function toPascalCase(slug) {
    return String(slug).split(/[-_]/).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join('');
}

/**
 * Compile a plugin's frontend entries (adminPage/component/hooks) into <plugin>/dist/*.bundle.js by
 * running build-plugin.js against the MARKETPLACE source tree. No-op for backend-only plugins. Failing
 * to build is fatal: shipping a zip whose admin page can never load is worse than failing loudly.
 *
 * WHICH entries exist is decided by build-plugin.js alone — do NOT re-derive it here. A local copy of
 * that logic drifted from the real manifest shape and silently shipped bundle-less zips: it looked for
 * `frontend.component.entry` (the block entry is resolved by plugin-block-contract.js —
 * `versoComponents` / the deprecated `puckComponents` / `components[0]` / the folder convention) and
 * `frontend.hooks.entry` (`hooks` is a plain STRING), so any plugin without an adminPage — the
 * block-only ones, breadcrumbs / related-posts / table-of-contents — built nothing at all, and their
 * editor blocks could never load at runtime.
 */
function buildFrontendBundles(slug, manifest) {
    if (!manifest.frontend) return;
    const script = path.join(__dirname, 'build-plugin.js');
    const r = spawnSync(process.execPath, [script, slug], {
        env: { ...process.env, WORDJS_PLUGINS_DIR: SRC },
        encoding: 'utf8',
    });
    if (r.status !== 0) {
        throw new Error(`${slug}: frontend bundle build failed\n${r.stdout || ''}${r.stderr || ''}`);
    }
}

function buildOne(slug) {
    const dir = path.join(SRC, slug);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`${slug}: missing manifest.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.id !== slug) throw new Error(`${slug}: manifest id "${manifest.id}" != folder name`);
    if (manifest.isolated !== true) throw new Error(`${slug}: manifest must declare "isolated": true`);
    const version = String(manifest.version || '1.0.0');

    // Compile this plugin's frontend entries to dist/*.bundle.js BEFORE zipping, so the catalog zip
    // ships them. dist/ is gitignored (`**/dist/`), so on a clean CI checkout it does not exist —
    // without this step every marketplace plugin installs WITHOUT a runtime bundle and its admin page
    // renders "Plugin Not Found" in production (the pre-built .next can only know build-time plugins).
    buildFrontendBundles(slug, manifest);

    const zip = new AdmZip();
    // Sort for a stable entry order; fix entry mtimes so rebuilding unchanged sources yields
    // byte-identical zips (stable sha256 across CI runs).
    const files = walk(dir).sort();
    const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
    for (const abs of files) {
        const rel = path.relative(dir, abs).split(path.sep).join('/');
        // SECURITY: a plugin's top-level data/ is RUNTIME state (e.g. mail-server's AES root key
        // data/.mailenc, user attachments) — it must never ship in a catalog zip. Anchored to the
        // plugin root so a legit nested source dir named data/ (client/data/...) is unaffected.
        if (rel === 'data' || rel.startsWith('data/')) continue;
        // A top-level theme/ is the plugin's COMPANION THEME (plugin-completeness option B) and MUST
        // ship: POST /plugins/<slug>/install-theme copies it to themes/<slug>-theme after install.
        zip.addFile(`${slug}/${rel}`, fs.readFileSync(abs));
    }
    for (const entry of zip.getEntries()) entry.header.time = FIXED_DATE;

    const buf = zip.toBuffer();
    const file = `${slug}-${version}.zip`;
    fs.writeFileSync(path.join(DIST, file), buf);

    const fe = manifest.frontend || {};
    // Both manifest spellings count as "ships a block" — after the Verso rename the catalog would
    // otherwise have reported `false` for every migrated plugin and the marketplace UI would have
    // silently dropped its block badge.
    const declaredBlock = readDeclaredBlockEntry(manifest);
    return {
        id: slug,
        name: manifest.name || slug,
        version,
        description: manifest.description || '',
        author: manifest.author || '',
        category: CATEGORIES[slug] || 'General',
        permissions: manifest.permissions || [],
        hasAdminPage: !!(fe.adminPage && fe.adminPage.entry),
        hasVersoBlock: !!declaredBlock,
        // DEPRECATED MIRROR, deliberately still emitted: the catalog is fetched at RUNTIME from the
        // GitHub Release, so an install running an older frontend reads a newer catalog. Dropping the
        // old field would make the "Bloque X" badge vanish on every such install. Remove it only once
        // no supported version reads it.
        hasPuckBlock: !!declaredBlock,
        blockName: declaredBlock ? toPascalCase(slug) : null,
        adminMenu: manifest.adminMenu ? { label: manifest.adminMenu.label, icon: manifest.adminMenu.icon } : null,
        file,
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
}

// ============================== THEMES ==============================
// Same system as plugins: marketplace/themes/<slug>/ → theme-<slug>-<version>.zip + a themes index,
// deterministic (fixed entry mtimes, sorted entries, no generated-at fields) so rebuilds of
// unchanged sources are byte-identical.
const THEMES_SRC = path.join(ROOT, 'marketplace', 'themes');

function buildOneTheme(slug) {
    const dir = path.join(THEMES_SRC, slug);
    const metaPath = path.join(dir, 'theme.json');
    if (!fs.existsSync(metaPath)) throw new Error(`${slug}: missing theme.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!meta.name) throw new Error(`${slug}: theme.json is missing a "name"`);
    const version = String(meta.version || '1.0.0');

    const zip = new AdmZip();
    const files = walk(dir).sort();
    const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
    for (const abs of files) {
        const rel = path.relative(dir, abs).split(path.sep).join('/');
        zip.addFile(`${slug}/${rel}`, fs.readFileSync(abs));
    }
    for (const entry of zip.getEntries()) entry.header.time = FIXED_DATE;

    const buf = zip.toBuffer();
    const file = `theme-${slug}-${version}.zip`;
    fs.writeFileSync(path.join(DIST, file), buf);

    return {
        id: slug,
        name: meta.name,
        version,
        description: meta.description || '',
        author: meta.author || '',
        file,
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
}

function main() {
    if (!fs.existsSync(SRC)) {
        console.error(`No marketplace sources at ${SRC}`);
        process.exit(1);
    }
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.mkdirSync(DIST, { recursive: true });

    const slugs = fs.readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const entries = [];
    const failures = [];
    for (const slug of slugs) {
        try {
            const entry = buildOne(slug);
            entries.push(entry);
            console.log(`  ✓ ${entry.file}  (${(entry.size / 1024).toFixed(1)} KB, ${entry.category})`);
        } catch (e) {
            failures.push(`${slug}: ${e.message}`);
            console.error(`  ✗ ${slug}: ${e.message}`);
        }
    }

    // DETERMINISTIC index (no timestamps): rebuilding unchanged sources yields a byte-identical
    // dist, so the committed catalog never produces noise diffs and CI can enforce freshness
    // with a plain `git diff --exit-code`.
    const index = {
        count: entries.length,
        plugins: entries,
    };
    fs.writeFileSync(path.join(DIST, 'marketplace-index.json'), JSON.stringify(index, null, 2));
    console.log(`\nmarketplace-index.json: ${entries.length} plugins → ${DIST}`);

    // Themes catalog (optional dir: a checkout without marketplace themes still builds plugins).
    const themeEntries = [];
    if (fs.existsSync(THEMES_SRC)) {
        const themeSlugs = fs.readdirSync(THEMES_SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
        for (const slug of themeSlugs) {
            try {
                const entry = buildOneTheme(slug);
                themeEntries.push(entry);
                console.log(`  ✓ ${entry.file}  (${(entry.size / 1024).toFixed(1)} KB)`);
            } catch (e) {
                failures.push(`theme ${slug}: ${e.message}`);
                console.error(`  ✗ theme ${slug}: ${e.message}`);
            }
        }
    }
    const themesIndex = {
        count: themeEntries.length,
        themes: themeEntries,
    };
    fs.writeFileSync(path.join(DIST, 'marketplace-themes-index.json'), JSON.stringify(themesIndex, null, 2));
    console.log(`marketplace-themes-index.json: ${themeEntries.length} themes → ${DIST}`);

    if (failures.length) {
        console.error(`\n${failures.length} package(s) FAILED to pack.`);
        process.exit(1);
    }
}

main();
