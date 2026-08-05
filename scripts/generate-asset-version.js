#!/usr/bin/env node
/* =============================================================================
 * generate-asset-version.js — wordjs-ui.css → frontend/src/lib/assetVersion.generated.ts
 * -----------------------------------------------------------------------------
 * The cache-busting token appended to the long-cached, otherwise-unversioned CSS
 * URLs (/public/css/wordjs-ui.css, /themes/<slug>/style.css) is the SHA-256 of
 * the framework stylesheet's own content, not a hand-maintained string: the
 * manual constant it replaces silently drifted from the release once already,
 * and a stale token means every browser that cached ui.css keeps the old copy
 * for a day after the fix ships.
 *
 * DETERMINISM IS A CONTRACT (CI drift gate): same input ⇒ byte-identical output,
 * no timestamps, no randomness. CRLF is normalized to LF BEFORE hashing — git
 * stores ui.css with LF but checks it out with CRLF wherever core.autocrlf is on
 * (every Windows dev box here), so hashing the raw bytes would make the Windows
 * hash differ from CI's and the drift gate could never be green on both.
 *
 * Usage: node scripts/generate-asset-version.js
 * ========================================================================== */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.resolve(__dirname, '../backend/public/css/wordjs-ui.css');
const OUT_PATH = path.resolve(__dirname, '../frontend/src/lib/assetVersion.generated.ts');
const SOURCE_REL = 'backend/public/css/wordjs-ui.css';
// Short enough to keep URLs readable, long enough that a collision is not a
// realistic failure mode for a single file's revisions.
const HASH_LEN = 12;

function main() {
    const raw = fs.readFileSync(CSS_PATH, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    const hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, HASH_LEN);

    // LF-terminated on purpose (see the determinism note above): git's autocrlf
    // clean filter normalizes the worktree copy back to LF before diffing, so an
    // LF file stays diff-clean on Windows and on CI alike.
    const out = [
        '// GENERATED FILE — DO NOT EDIT.',
        `// Source: ${SOURCE_REL}`,
        '// Regenerate with: node scripts/generate-asset-version.js (runs in the frontend prebuild).',
        `export const UI_CSS_HASH = "${hash}";`,
        '',
    ].join('\n');
    fs.writeFileSync(OUT_PATH, out);

    console.log(`assetVersion.generated.ts written: ${path.relative(process.cwd(), OUT_PATH)}`);
    console.log(`source: ${SOURCE_REL} (${normalized.length} chars, LF-normalized) → sha256 ${hash}`);
}

main();
