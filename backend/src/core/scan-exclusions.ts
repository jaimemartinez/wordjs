/**
 * WHAT THE INSTALL-TIME SCANNER DOES NOT READ — stated once, enforced twice.
 *
 * `plugins.ts` walks a package and AST-scans its JavaScript before it may be installed. It deliberately
 * skips some directories: dependencies it did not write (`node_modules`), browser bundles that never run
 * server-side (`dist`, `client`, `frontend`), and, for plugins, hidden directories.
 *
 * A skipped directory is not a hole while nothing loads code from it. It becomes one the moment a
 * plugin's entry point can `require('./<skipped>/payload.js')`: the payload then runs in the worker
 * having never been read by the scanner, so the install-time review — the admin's, and the marketplace's
 * — saw a clean package whose real behaviour was somewhere it did not look.
 *
 * `secure-require.ts` therefore refuses such a require at runtime, and its comment said it did so
 * "mirroring the scanner's skip so the two cannot diverge". THEY HAD DIVERGED, in two ways, both
 * measured by booting a real plugin:
 *
 *   · The runtime named `dist`/`client`/`frontend` and not HIDDEN directories. The scanner skips those
 *     too, so `require('./.assets/payload.js')` loaded and ran unscanned code. (What it could then DO was
 *     still fully contained — every dangerous sink is guarded by identity at runtime, not by the scan —
 *     so this was a review-transparency failure rather than a privilege escalation. It is still the
 *     difference between a reviewer seeing a plugin's code and not seeing it.)
 *   · The runtime checked only the FIRST directory under the plugin slug, while the scanner skips a
 *     matching directory at ANY depth. `lib/dist/payload.js` was unscanned and requirable.
 *
 * Two lists cannot be kept in step by intention. There is one list here, and both sides read it.
 *
 * `node_modules` is the one exclusion NOT enforced at runtime, and that is deliberate: a plugin's
 * dependencies are skipped by the scanner because they are third-party code the author did not write,
 * but a plugin must obviously be able to require them. That asymmetry is a real gap in what the scanner
 * covers — the dependency tree is vetted by the install-time integrity checks and the runtime guards,
 * not by the AST scan — and it is named here rather than left implicit.
 */

/** Directory names the scanner skips for every package, plugin or theme. */
const SKIPPED_FOR_ALL = ['node_modules'];

/** Additionally skipped for PLUGINS: browser bundles that never run server-side. */
const SKIPPED_BUNDLE_DIRS = ['dist', 'client', 'frontend'];

/**
 * Is this directory name one the scanner walks past?
 *
 * `isTheme` matters: a theme's functions.js may require from any of its own subdirectories, so the
 * scanner reads all of them and only skips dependencies.
 */
function isScannerSkippedDir(name: string, isTheme: boolean): boolean {
    const n = String(name);
    if (SKIPPED_FOR_ALL.some((d) => n.includes(d))) return true;
    if (isTheme) return false;
    return n.startsWith('.') || SKIPPED_BUNDLE_DIRS.includes(n.toLowerCase());
}

/**
 * Should loading code from this path be refused at runtime because the scanner never read it?
 *
 * `segments` are the path parts BELOW the package root (so `['dist', 'payload.js']`, not the slug).
 * Every directory segment is tested, because the scanner skips a matching directory at any depth.
 *
 * `node_modules` is excluded here on purpose — see the note at the top of this file.
 */
function isUnscannedCodePath(segments: string[], isTheme: boolean): boolean {
    if (isTheme) return false;                     // themes are scanned in full
    // The last segment is the file itself; only directories are considered.
    for (const seg of segments.slice(0, -1)) {
        if (String(seg).includes('node_modules')) return false;   // dependencies: requirable by design
        if (isScannerSkippedDir(seg, isTheme)) return true;
    }
    return false;
}

module.exports = {
    SKIPPED_FOR_ALL,
    SKIPPED_BUNDLE_DIRS,
    isScannerSkippedDir,
    isUnscannedCodePath,
};
