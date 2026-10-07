/**
 * WordJS - Which files of an installed plugin folder belong in a PACKAGE of it.
 *
 * Two places turn a plugin folder into a ZIP: the packer (scripts/pack-plugin.js, which stages a copy
 * before zipping) and the admin "Download" route (GET /api/v1/plugins/:slug/download). They used to
 * answer the question differently. The packer always skipped runtime state; the download route called
 * `zip.addLocalFolder(pluginPath)`, i.e. EVERYTHING — including the plugin's top-level data/ folder.
 * That folder is the plugin's private runtime state, and for mail-server it holds data/.mailenc, the
 * key that decrypts every stored mailbox secret, plus every attachment ever received. A download meant
 * to hand someone the plugin's CODE handed them its secrets, along with node_modules/ (megabytes of
 * someone else's code the archive then claims as the plugin's) and any .git directory (history,
 * remotes, possibly credentials in its config).
 *
 * So the rule lives here, once, and both callers use it:
 *   · never the TOP-LEVEL data/ directory (runtime state: keys, attachments, caches);
 *   · never node_modules/ or .git, at any depth (dependencies are installed, not shipped — a bundled
 *     plugin's packer re-installs its production deps into the staged copy itself);
 *   · never OS junk (.DS_Store, Thumbs.db, desktop.ini, __MACOSX);
 *   · never a symbolic link, file or directory — following one could read outside the plugin folder;
 *   · only regular files and directories otherwise.
 *
 * Plain CommonJS-compatible TypeScript with no host imports, so the packer can load it the same way it
 * loads core/plugins (compiled from dist/, or through ts-node from src/).
 */

const fs = require('fs');
const path = require('path');

/** Names skipped at ANY depth. */
const PACKAGE_SKIP_NAME_RE = /^(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|\.git|node_modules)$/i;
/** Top-level entries skipped (runtime state that must never leave the server inside a package). */
const PACKAGE_SKIP_TOP_LEVEL = new Set(['data']);

/**
 * Every file of the plugin folder `root` that belongs in a package of it, as '/'-separated paths
 * relative to `root`, in directory-walk order. Directories are not listed (they are implied by files).
 */
function listPluginPackageFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
        for (const e of fs.readdirSync(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (PACKAGE_SKIP_NAME_RE.test(e.name)) continue;
            if (!rel && PACKAGE_SKIP_TOP_LEVEL.has(e.name)) continue;
            if (e.isSymbolicLink()) continue; // never follow a link out of the plugin folder
            if (e.isDirectory()) walk(r);
            else if (e.isFile()) out.push(r);
        }
    };
    walk('');
    return out;
}

module.exports = { listPluginPackageFiles, PACKAGE_SKIP_NAME_RE, PACKAGE_SKIP_TOP_LEVEL };
