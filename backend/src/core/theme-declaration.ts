/**
 * WHAT A THEME'S functions.js ASKS FOR — the one reader of a theme's permission declaration.
 *
 * A theme declares the capabilities its server code needs in `theme.json`, as a plugin does in its
 * manifest:
 *
 *     "permissions": [
 *         { "scope": "settings", "access": "read", "reason": "Shows the site name in the footer shortcode" }
 *     ]
 *
 * An older theme may carry the same array in a `manifest.json` next to functions.js; it is read when
 * theme.json declares nothing. A declaration is only a REQUEST: an administrator grants each permission
 * (activation dialog / Permissions dialog in Appearance → Themes, core/plugin-permissions THEMES_RECORD_KEY),
 * and the host gates check declared AND granted. Nothing is granted because it is declared.
 *
 * Pure and dependency-free on purpose: io-guard reads declarations from inside the isolated child with
 * its unpatched readFileSync, before anything else is loaded there.
 */

const nodePath = require('path');

type ReadFile = (file: string, encoding: 'utf8') => string | Buffer;

export interface ThemePermissionDeclaration {
    scope: string;
    access?: string;
    reason?: string;
}

/** The `permissions` array a theme directory declares, or null when it declares none (no file, no array). */
function themeDeclaredPermissions(themeDir: string, readFile: ReadFile = require('fs').readFileSync): ThemePermissionDeclaration[] | null {
    for (const name of ['theme.json', 'manifest.json']) {
        let parsed: any;
        try { parsed = JSON.parse(String(readFile(nodePath.join(themeDir, name), 'utf8'))); } catch { continue; }
        if (parsed && Array.isArray(parsed.permissions)) {
            return parsed.permissions.filter((p: any) => p && typeof p === 'object' && typeof p.scope === 'string');
        }
    }
    return null;
}

/** "scope:access" for a declaration entry (the grant-token spelling), or null for a scope-only one. */
function declarationToken(p: ThemePermissionDeclaration): string | null {
    if (!p || typeof p.scope !== 'string' || typeof p.access !== 'string' || !p.access) return null;
    return `${p.scope}:${p.access}`;
}

module.exports = { themeDeclaredPermissions, declarationToken };
