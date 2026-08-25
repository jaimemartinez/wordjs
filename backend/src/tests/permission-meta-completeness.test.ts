/**
 * The grant screen must have platform-authored copy for every permission a plugin can request.
 *
 * `frontend/src/lib/permissionMeta.ts` says, above its table, "Every KNOWN_PERMISSIONS token" — and
 * nothing checked. It was missing `assets:write`. `permMeta()` falls back to
 * `{ label: token, risk: 'med' }`, so the omission did not crash anything: it rendered the raw string
 * "assets:write", with no explanation, behind a MEDIUM badge. `assets:write` lets a plugin enqueue a
 * script onto public pages — code that runs in every visitor's browser. An admin weighing that request
 * was shown the understated end of the scale and no words at all.
 *
 * That is the failure mode worth gating: a missing entry does not look like a bug, it looks like a
 * low-stakes permission.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..');
const PLUGINS_TS = path.join(REPO, 'backend', 'src', 'core', 'plugins.ts');
const META_TS = path.join(REPO, 'frontend', 'src', 'lib', 'permissionMeta.ts');

/** The canonical tokens, read from the KNOWN_PERMISSIONS literal itself. */
function canonicalTokens(): string[] {
    const src = fs.readFileSync(PLUGINS_TS, 'utf8');
    const m = src.match(/const KNOWN_PERMISSIONS:\s*Record<string,\s*string\[\]>\s*=\s*\{([\s\S]*?)\n\};/);
    assert.ok(m, 'could not locate the KNOWN_PERMISSIONS literal in core/plugins.ts');

    const tokens: string[] = [];
    for (const line of m![1].split('\n')) {
        const entry = line.match(/^\s*([A-Za-z_][\w]*)\s*:\s*\[([^\]]*)\]/);
        if (!entry) continue;
        const scope = entry[1];
        const accesses = entry[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        // A scope with no accesses is scope-only and is requested by its bare name (network).
        if (accesses.length === 0) tokens.push(scope);
        else for (const a of accesses) tokens.push(`${scope}:${a}`);
    }
    assert.ok(tokens.length >= 10, `parsed only ${tokens.length} tokens — the literal's shape changed`);
    return tokens;
}

/** The tokens the grant screen has copy for, read from the PERMISSION_META literal itself. */
function documentedTokens(): string[] {
    const src = fs.readFileSync(META_TS, 'utf8');
    const m = src.match(/export const PERMISSION_META:\s*Record<string,\s*PermissionMeta>\s*=\s*\{([\s\S]*?)\n\};/);
    assert.ok(m, 'could not locate the PERMISSION_META literal in frontend/src/lib/permissionMeta.ts');
    // Top-level keys only: nested `label:` / `risk:` lines are indented further.
    return [...m![1].matchAll(/^ {4}'([^']+)':\s*\{/gm)].map((x) => x[1]);
}

test('every requestable permission has platform-authored copy', () => {
    const canonical = canonicalTokens();
    const documented = new Set(documentedTokens());
    const missing = canonical.filter((t) => !documented.has(t));
    assert.deepStrictEqual(missing, [],
        `permissionMeta.ts is missing copy for: ${missing.join(', ')}. `
        + 'Without it the grant screen shows the raw token behind a default MEDIUM badge.');
});

test('the grant screen documents nothing a plugin cannot request', () => {
    // The other direction: a token removed from KNOWN_PERMISSIONS but left here advertises a
    // capability that no longer exists, and a typo'd key here is silently inert.
    const canonical = new Set(canonicalTokens());
    const stale = documentedTokens().filter((t) => !canonical.has(t));
    assert.deepStrictEqual(stale, [],
        `permissionMeta.ts documents tokens that are not in KNOWN_PERMISSIONS: ${stale.join(', ')}.`);
});

test('every write-ish permission is rated high', () => {
    // The file's own guidance: "any write / network / filesystem write / email:provider /
    // database:write is HIGH". A high-risk grant carrying a low badge is worse than no badge.
    const src = fs.readFileSync(META_TS, 'utf8');
    const body = src.match(/export const PERMISSION_META[\s\S]*?\n\};/)![0];
    const entries = [...body.matchAll(/^ {4}'([^']+)':\s*\{([\s\S]*?)^ {4}\},/gm)];
    assert.ok(entries.length >= 10, `parsed only ${entries.length} entries`);

    const understated = entries
        .filter(([, token]) => /:write$/.test(token) || token === 'network' || token === 'email:provider')
        .filter(([, , block]) => !/risk:\s*'high'/.test(block))
        .map(([, token]) => token);

    assert.deepStrictEqual(understated, [],
        `these grants let a plugin change things but are not rated high: ${understated.join(', ')}`);
});
