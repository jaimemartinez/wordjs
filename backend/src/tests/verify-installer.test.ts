const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const TEST_DIR = path.resolve(__dirname, '../../tmp-installer-test');
const SRC_CONFIG_DIR = path.join(TEST_DIR, 'src/config');
const APP_JS_PATH = path.join(SRC_CONFIG_DIR, 'app.ts');
const TARGET_CONFIG_JSON = path.join(TEST_DIR, 'wordjs-config.json');
const REAL_SRC = path.resolve(__dirname, '..');

/**
 * Copy `app.ts` AND every source file it transitively pulls in by a relative specifier.
 *
 * Why a copy at all: `config/app.ts` derives the site root from its OWN location
 * (`path.resolve(__dirname, '../../')`). Relocating the file under an empty directory is what makes
 * the config lookup land somewhere that has no `wordjs-config.json`, which is the whole premise of
 * this test. So the relocation is the mechanism and cannot be dropped.
 *
 * Why the CLOSURE and not just `app.ts`: copying one file silently assumed `config/app.ts` had no
 * relative imports. It held for years and then stopped — F6 made it `require('../core/content-rollout')`
 * — and the failure was `MODULE_NOT_FOUND` from a path inside a scratch directory, which reads like
 * broken test plumbing rather than "this test copies a hand-picked subset of the program". A
 * hand-maintained list would have the same expiry date; this walks what the code actually imports, so
 * the next import is carried automatically.
 *
 * Unresolvable specifiers THROW instead of being skipped. A dependency this cannot find is one the
 * isolated copy will not have either, and discovering that as a silent omission here would only move
 * the same confusing `MODULE_NOT_FOUND` a few lines further down.
 */
const RELATIVE_SPECIFIER = /(?:require\(\s*['"](\.[^'"]+)['"]\s*\)|from\s+['"](\.[^'"]+)['"])/g;

const resolveSource = (fromFile: string, specifier: string): string | null => {
    const base = path.resolve(path.dirname(fromFile), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
};

const copyClosureFrom = (entry: string): string[] => {
    const copied: string[] = [];
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length) {
        const file = queue.shift() as string;
        if (seen.has(file)) continue;
        seen.add(file);

        const source = fs.readFileSync(file, 'utf8');
        const relativeToSrc = path.relative(REAL_SRC, file);
        const destination = path.join(TEST_DIR, 'src', relativeToSrc);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, source);
        copied.push(relativeToSrc.split(path.sep).join('/'));

        RELATIVE_SPECIFIER.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = RELATIVE_SPECIFIER.exec(source)) !== null) {
            const specifier = match[1] || match[2];
            const resolved = resolveSource(file, specifier);
            // A type-only import erases at runtime, but resolving it costs nothing and copying it is
            // harmless; refusing to resolve it is what would be wrong.
            if (!resolved) {
                throw new Error(`verify-installer: cannot resolve '${specifier}' from ${path.relative(REAL_SRC, file)} — `
                    + 'the isolated copy would be incomplete and fail with MODULE_NOT_FOUND at require time');
            }
            if (!seen.has(resolved)) queue.push(resolved);
        }
    }
    return copied;
};

// Helper to cleanup
const cleanup = () => {
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
};

test('Installer: Should ENTRY in SETUP MODE (No Auto-Config)', async (t: any) => {
    // 1. Setup isolated environment
    cleanup();
    fs.mkdirSync(SRC_CONFIG_DIR, { recursive: true });

    // The cleanup used to be a bare call at the end of the body, so ANY failure — a failed assertion,
    // an unresolvable import — left `backend/tmp-installer-test/` behind, untracked and NOT ignored,
    // one `git add -A` away from being committed. A scratch directory inside the repository has to be
    // removed on the failing path too, which is the only path that ever leaked it.
    try {
        // 2. Copy the real config module — and everything it imports — into the isolated environment.
        const copied = copyClosureFrom(path.resolve(__dirname, '../config/app.ts'));
        assert.ok(copied.includes('config/app.ts'), 'the entry module was not copied');
        console.log(`   Isolated closure (${copied.length} files): ${copied.join(', ')}`);

        // 3. Trigger Logic by requiring the isolated file
        console.log('--- Triggering App Config Logic in Isolated Env ---');
        console.log(`   Simulated Root: ${TEST_DIR}`);

        // We expect it NOT to write anything
        const config = require(APP_JS_PATH);

        // 4. Assertions
        const exists = fs.existsSync(TARGET_CONFIG_JSON);

        // It should NOT exist
        assert.strictEqual(exists, false, '✅ Correct behavior: Config file was NOT created automatically.');
        console.log('✅ Verified: System stays in Setup Mode when config is missing.');
    } finally {
        cleanup();
    }
});
