/**
 * Plugin block API — the ONE place that knows how a plugin declares its editor block.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Four tools have to agree on where a plugin's block lives: build-plugin.js (compiles it),
 * build-marketplace.js (advertises it in the catalog), verify-marketplace.js (proves the compiled
 * bundle actually shipped) and frontend/scripts/generate-verso-plugin-registry.js (imports it at
 * build time). A LOCAL COPY of this resolution already drifted once — build-marketplace.js looked for
 * `frontend.component.entry`, a key that has never existed — and the result was catalog zips shipping
 * with no block bundle at all for every block-only plugin, green build and all. So the resolution
 * lives here, and every tool requires it instead of re-deriving it.
 *
 * TWO SPELLINGS, INDEFINITELY
 * ---------------------------
 * The visual editor was renamed from the retired Puck fork to VERSO. A plugin, however, is a
 * PUBLISHED artifact authored by a third party: there are installs out there whose manifests and
 * folders use the historical names, and nothing in this repo can rewrite them. Both spellings are
 * therefore accepted forever, NEW FIRST:
 *
 *   manifest key   frontend.versoComponents          (current)  ← wins when both are present
 *                  frontend.puckComponents           (legacy — deprecation warning, still loads)
 *   folder         client/verso/<Pascal>Verso.tsx    (current)  ← tried first
 *                  client/puck/<Pascal>Puck.tsx      (legacy — deprecation warning, still loads)
 *   export shape   versoComponents / versoComponentDef        (current)
 *                  puckComponents  / puckComponentDef         (legacy)
 *
 * Legacy is DEPRECATED, never REJECTED. Finding an old name emits one warning per plugin per process
 * and then behaves exactly as before — a plugin that a user installed months ago keeps working with
 * nobody touching it.
 *
 * NOTE ON `_puck_data`: the post-meta key that stores a page's document is NOT part of this contract
 * and is deliberately NOT renamed anywhere. See `CONTENT_META_KEY` in frontend/src/lib/verso/types.ts
 * (and its save-side mirror `EDITOR_DATA_META_KEY` in frontend/src/lib/editorGuards.ts).
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Manifest keys that may carry the block entry, in PRECEDENCE order. `legacy: true` marks the
 * spelling that earns a deprecation warning.
 */
const BLOCK_ENTRY_KEYS = [
    { key: 'versoComponents', legacy: false },
    { key: 'puckComponents', legacy: true },
];

/** Module-level export names, in precedence order, for each shape. */
const MULTI_EXPORT_NAMES = ['versoComponents', 'puckComponents'];
const SINGLE_EXPORT_NAMES = ['versoComponentDef', 'puckComponentDef'];

function toPascalCase(slug) {
    return String(slug).split(/[-_]/).filter(Boolean)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

/**
 * Conventional block paths for a plugin id, in PRECEDENCE order. Used ONLY as discovery: a
 * conventional path is never "declared", so a missing file there is silence, not an error.
 */
function conventionCandidates(pluginId) {
    const pascal = toPascalCase(pluginId);
    return [
        { rel: `client/verso/${pascal}Verso.tsx`, legacy: false },
        { rel: `client/puck/${pascal}Puck.tsx`, legacy: true },
    ];
}

// One warning per (plugin, subject) per process: these resolvers run once per plugin in
// build-plugin.js but repeatedly inside build-marketplace/verify-marketplace, and a wall of repeated
// deprecation lines trains people to ignore the one that matters.
const warned = new Set();
function warnOnce(id, subject, format, ...args) {
    const fingerprint = `${id}::${subject}`;
    if (warned.has(fingerprint)) return;
    warned.add(fingerprint);
    // The plugin id comes from a manifest on disk, i.e. it is DATA: it never becomes arg 0, which
    // util.format reads as a format string (a `%s` in an id would eat the next argument).
    console.warn(format, ...args);
}

/** Test seam: forget which deprecations were already announced. */
function resetDeprecationWarnings() {
    warned.clear();
}

function warnLegacyManifestKey(pluginId) {
    warnOnce(pluginId, 'manifest-key',
        '   ⚠️  [%s] DEPRECATED manifest key "frontend.puckComponents" — rename it to "frontend.versoComponents". The old key keeps working.',
        String(pluginId));
}

function warnLegacyConvention(pluginId, rel) {
    warnOnce(pluginId, 'convention',
        '   ⚠️  [%s] DEPRECATED block path "%s" — the convention is now client/verso/<Pascal>Verso.tsx. The old path keeps working.',
        String(pluginId), String(rel));
}

/**
 * The block entry a manifest DECLARES, in both spellings (new first).
 * Returns `{ entry, key, legacy }` or null when no key declares one. A key present with a `null`
 * value (the way video-gallery says "I ship no block") is not a declaration and warns about nothing.
 */
function readDeclaredBlockEntry(manifest) {
    const fe = (manifest && manifest.frontend) || {};
    for (const { key, legacy } of BLOCK_ENTRY_KEYS) {
        const entry = fe[key] && fe[key].entry;
        if (entry) return { entry: String(entry), key, legacy };
    }
    return null;
}

/**
 * Full resolution of a plugin's block entry: manifest declaration first (new key wins over legacy),
 * then — only for callers that opt in — the pre-Puck `frontend.components[]` channel, then the folder
 * convention (new folder before old).
 *
 * Returns:
 *   { entry, declared, key, legacy, viaConvention }   or   null when the plugin ships no block.
 *
 *   entry          path relative to the plugin dir
 *   declared       a manifest key named it. A declared entry whose FILE IS MISSING is a hard error
 *                  for the caller — silently skipping it is how plugins shipped with an admin page
 *                  or a block that could never load. Convention hits are never `declared`.
 *   legacy         the spelling that won is the historical one (a warning was emitted)
 *   viaConvention  no manifest key named it; it was discovered on disk
 *
 * `componentsChannel` (default false) exists because the BUNDLERS and the REGISTRY GENERATOR read
 * different sets of keys, and collapsing them would be a silent behaviour change. build-plugin.js has
 * always compiled `frontend.components[0].entry` into the component bundle (video-gallery's carousel
 * reaches the site that way); the registry generator has NEVER imported it, and must not start — that
 * file exports neither block shape, so emitting it would be a hard Turbopack build error.
 *
 * `dir` is only touched for the convention probe, so callers that merely want the declaration can
 * pass a directory that does not exist.
 */
function resolveBlockEntry(dir, manifest, options) {
    const opts = options || {};
    const warn = opts.warn !== false;
    const pluginId = String((manifest && manifest.id) || path.basename(String(dir)));

    const declaredNew = readDeclaredBlockEntry(manifest);
    if (declaredNew) {
        if (declaredNew.legacy && warn) warnLegacyManifestKey(pluginId);
        return { ...declaredNew, declared: true, viaConvention: false };
    }

    const legacyComponents = opts.componentsChannel === true && manifest && manifest.frontend
        && Array.isArray(manifest.frontend.components) && manifest.frontend.components[0]
        && manifest.frontend.components[0].entry;
    if (legacyComponents) {
        return { entry: String(legacyComponents), key: 'components', legacy: true, declared: true, viaConvention: false };
    }

    for (const { rel, legacy } of conventionCandidates(pluginId)) {
        if (fs.existsSync(path.join(String(dir), rel))) {
            if (legacy && warn) warnLegacyConvention(pluginId, rel);
            return { entry: rel, key: null, legacy, declared: false, viaConvention: true };
        }
    }
    return null;
}

/**
 * Which export shape a block entry uses, read from its SOURCE, plus the exact member name to emit.
 * The registry generator does `import * as X` and statically references ONE member, and Turbopack
 * hard-errors on a member that is not a real export — so the name is READ, never assumed.
 *
 *   multi:  `export const versoComponents` / `export const puckComponents`  → spread as-is
 *   single: `versoComponentDef` / `puckComponentDef` + default export       → composed with render
 *
 * Falls back to the historical single shape when the file cannot be read, which is what this
 * resolution did before the rename.
 */
function resolveBlockExports(fullPath) {
    let src = '';
    try { src = fs.readFileSync(fullPath, 'utf8'); } catch { /* unreadable → defaults below */ }
    for (const member of MULTI_EXPORT_NAMES) {
        if (new RegExp(`export\\s+const\\s+${member}\\b`).test(src)) return { multi: true, member };
    }
    for (const member of SINGLE_EXPORT_NAMES) {
        if (new RegExp(`\\b${member}\\b`).test(src)) return { multi: false, member };
    }
    return { multi: false, member: 'puckComponentDef' };
}

module.exports = {
    BLOCK_ENTRY_KEYS,
    MULTI_EXPORT_NAMES,
    SINGLE_EXPORT_NAMES,
    toPascalCase,
    conventionCandidates,
    readDeclaredBlockEntry,
    resolveBlockEntry,
    resolveBlockExports,
    warnLegacyManifestKey,
    warnLegacyConvention,
    resetDeprecationWarnings,
};
