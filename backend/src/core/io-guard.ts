/**
 * WordJS - IO Guard
 *
 * Monkey-patches 'fs' so plugin code (run in the isolated child) is confined to its own dir + a small
 * set of safe zones, and can never:
 *   - read/exfiltrate secret files or the raw DB (BLOCKED_FILES / db-file / secret-pattern checks),
 *   - rewrite its own manifest.json (permission-escalation primitive), or
 *   - CREATE or rename/copy a file into an executable code extension (.js/.cjs/.mjs/.node/.wasm/…) —
 *     which would let a plugin plant runtime code the static AST scanner never vetted, or overwrite its
 *     own scanned source. See EXECUTABLE_CODE_EXT below and secure-require.ts (require() is likewise
 *     confined to the plugin's own tree + node_modules so a planted file can't be loaded).
 *
 * This is a defence-in-depth backstop; the OS process isolation is the real boundary.
 */

const fs = require('fs');
const path = require('path');
const { sandboxPaths } = require('./sandbox-paths');
// Use the EFFECTIVE plugin (context OR call stack), not ALS-only, so this global-fs backstop
// also applies to detached plugin code that reaches the real fs.
const { getEffectivePlugin } = require('./plugin-context');

// Coalesce repeated block warnings. A plugin in a tight fs-probe loop (e.g. a logger retrying a denied
// write) otherwise floods the host log with thousands of identical lines, drowning everything else.
// Per message key: emit the first, then at most one "(xN more suppressed)" every SUPPRESS_WINDOW_MS.
const SUPPRESS_WINDOW_MS = 10000;
const _warnState = new Map<string, { last: number; suppressed: number }>();
function throttledWarn(key: string, message: string): void {
    const now = Date.now();
    const st = _warnState.get(key);
    if (!st) { _warnState.set(key, { last: now, suppressed: 0 }); console.warn(message); return; }
    if (now - st.last >= SUPPRESS_WINDOW_MS) {
        console.warn(st.suppressed > 0 ? `${message} (${st.suppressed} similar suppressed in the last ${Math.round((now - st.last) / 1000)}s)` : message);
        st.last = now; st.suppressed = 0;
    } else {
        st.suppressed++;
    }
}

const ORIGINALS = {
    // Write Ops
    writeFile: fs.writeFile,
    writeFileSync: fs.writeFileSync,
    unlink: fs.unlink,
    unlinkSync: fs.unlinkSync,
    rm: fs.rm,
    rmSync: fs.rmSync,
    rename: fs.rename,
    renameSync: fs.renameSync,
    mkdir: fs.mkdir,
    mkdirSync: fs.mkdirSync,
    symlink: fs.symlink,
    symlinkSync: fs.symlinkSync,
    appendFile: fs.appendFile,
    appendFileSync: fs.appendFileSync,
    truncate: fs.truncate,
    truncateSync: fs.truncateSync,
    chmod: fs.chmod,
    chmodSync: fs.chmodSync,
    // rmdir/chown were named in the isWrite list below but never captured here, so patch() bailed out
    // on them and they stayed UNGUARDED — the same "declared but not closed" shape this audit is
    // about. rmdir deletes a directory anywhere the plugin can name; chown re-owns a file.
    rmdir: fs.rmdir,
    rmdirSync: fs.rmdirSync,
    chown: fs.chown,
    chownSync: fs.chownSync,
    // Copy/link ops read a SOURCE and create a DEST — both ends must be confined (a copy of the raw DB
    // or a hard link to a secret would otherwise be a read-confinement bypass / exfiltration primitive).
    copyFile: fs.copyFile,
    copyFileSync: fs.copyFileSync,
    cp: fs.cp,
    cpSync: fs.cpSync,
    link: fs.link,
    linkSync: fs.linkSync,

    // Read Ops
    readFile: fs.readFile,
    readFileSync: fs.readFileSync,
    readdir: fs.readdir,
    readdirSync: fs.readdirSync,
    createReadStream: fs.createReadStream,
    createWriteStream: fs.createWriteStream,
    // open/opendir/readlink take a PATH that readFile/readdir do NOT funnel through: a plugin doing
    // fs.openSync(p, 'r') + fs.readSync(fd) reads arbitrary file CONTENT completely unguarded (the biggest
    // read hole), opendir enumerates any dir, readlink discloses any symlink target. Confine them too.
    open: fs.open,
    openSync: fs.openSync,
    opendir: fs.opendir,
    opendirSync: fs.opendirSync,
    readlink: fs.readlink,
    readlinkSync: fs.readlinkSync
};

const ROOT_DIR = path.resolve(__dirname, '../../');

// Resolve the operator-configured DB file path(s) so an attacker can't dodge the extension block
// above by pointing the DB at a custom-named file. Lazily read + cached (this is a per-fs-op hot
// path) and fully defensive — config may not be loaded yet, and the extension check is the primary.
let _cfgDbPaths: string[] | null = null;
function getConfiguredDbPaths(): string[] {
    if (_cfgDbPaths) return _cfgDbPaths;
    const out = new Set<string>();
    let sawLoaded = false;
    for (const mod of ['../config/app', '../config/database', '../config']) {
        let resolved: string;
        try { resolved = require.resolve(mod); } catch { continue; }
        // Read straight from the module cache, and ONLY once the module has finished loading. Calling
        // require() here during boot — while config/* is still mid-load (this runs from an fs op that
        // can fire inside config's own load) — would read properties off a half-initialized circular
        // export, which makes Node print a "non-existent property … inside circular dependency" warning
        // on every plugin start. The .db/.sqlite extension block above is the primary defense meanwhile.
        const cached = require.cache[resolved];
        if (!cached || cached.loaded !== true) continue;
        sawLoaded = true;
        const c: any = cached.exports;
        for (const v of [c && c.dbPath, c && c.config && c.config.dbPath, c && c.DB_PATH]) {
            if (typeof v === 'string' && v) out.add(path.resolve(v));
        }
    }
    // Only freeze the cache once a config module was actually loaded; before that keep retrying, so an
    // early boot-time call can't permanently cache an empty set (which would silently disable this
    // custom-DB-path defense for the whole process lifetime).
    if (sawLoaded) _cfgDbPaths = Array.from(out);
    return sawLoaded ? (_cfgDbPaths as string[]) : Array.from(out);
}

// Executable/loadable code extensions. A plugin must never CREATE, overwrite, rename-into, or copy-into
// one of these ANYWHERE it can write. The AST scanner (plugins.ts) statically vets a plugin's committed
// code before activation; letting a plugin drop a fresh .js at runtime — directly, or by writing a .txt
// then renaming/copying it to .js — would be a scanner-evasion + self-code-modification primitive.
// Data files (.json/.txt/images/etc.) stay writable in the plugin's safe zones. Covers native addons
// (.node) and WebAssembly (.wasm) which are also loadable code, and TS variants defensively.
//
// (#3) HTML BELONGS HERE TOO. The old pattern listed only things Node can `require()`, which read
// "executable" as "executable BY THE SERVER". But the host also PUBLISHES files over HTTP, and a
// .html file is executable BY THE BROWSER as a DOCUMENT IN THIS ORIGIN — where the global CSP allows
// 'unsafe-inline' (index.ts) and the frontend shares the origin in both shipped modes (monolith and
// gateway). A plugin that wrote pwn.html therefore had a stored-XSS primitive with zero permissions.
// The serving side is now allowlisted (see isPluginServedRelPath below), and this closes the writing
// side so the two defenses do not depend on each other.
const EXECUTABLE_CODE_EXT = /\.(?:c|m)?jsx?$|\.(?:c|m)?tsx?$|\.node$|\.wasm$|\.(?:x|s)?html?$|\.xht$/i;

// === THE PUBLICLY-SERVED ROOTS (the CLASS; every published surface below is derived from this) ===
//
// (#3, verification) The first remediation locked /plugins and left its TWINS open: `uploads/` and
// `themes/` were blanket write zones for EVERY plugin (no grant at all) *and* both are mounted raw by
// index.ts, so the very same exfiltration channel answered at /uploads/leak.txt and
// /themes/<x>/leak.txt. Naming one mount in the guard could only ever close one mount.
//
// So the rule is stated over the SET of roots the host publishes, not over a path: a plugin may not
// write ANYWHERE under a served root, except the non-published part of its own directory. Adding a
// future static mount means adding it HERE, and the write denial follows automatically — the write
// zones below are themselves FILTERED through this predicate, so a served root can never also be a
// blanket write zone even if someone re-adds one to the list.
// AND "the host" IS NOT ONLY THIS PROCESS (verification of #3, second round). The set below described
// the BACKEND's mounts only, so a carve-out under frontend/.next handed every plugin — zero permissions —
// a file that the OTHER process of the monolith deployment publishes: Next serves frontend/.next/static at
// /_next/static (in dev it stats the file per request, so no restart is needed) and frontend/public at the
// site root. Same origin, same anonymous reader, same channel. The property is "no plugin write zone lies
// under ANY root published by ANY dispatcher of the deployment", so those roots belong in this list too.
const SERVED_ROOTS: string[] = [
    path.join(ROOT_DIR, 'uploads'),   // index.ts: app.use('/uploads', express.static(...))
    path.join(ROOT_DIR, 'themes'),    // index.ts: the /themes allowlist handler
    path.join(ROOT_DIR, 'plugins'),   // index.ts: the /plugins allowlist handler (+ routes/plugin-bundles)
    path.join(ROOT_DIR, 'public'),    // index.ts: app.use('/public', express.static(...))
    path.resolve(ROOT_DIR, '../frontend/.next/static'), // Next (monolith + gateway): /_next/static/*
    path.resolve(ROOT_DIR, '../frontend/public'),       // Next: served at the site root
];

// …AND THE SAME ROOT MUST NOT BE TWO DIFFERENT DIRECTORIES. This module anchors every path on the
// INSTALLATION (`__dirname`), while index.ts mounts its static handlers on CWD-relative paths
// (`path.resolve('./themes')`, `./public`, `PLUGINS_ROOT`). They coincide only because the npm scripts
// start the process from `backend/` — nothing enforces it, and under any other cwd the two lists name
// DIFFERENT directories: fail-closed for serving (404), fail-OPEN for writing (index.ts publishes a tree
// this guard would not recognise as served, so it stays a plugin write zone — hole #3, reopened by a
// working directory). Until index.ts is anchored the same way (it should be: mount from SERVED_ROOTS),
// the guard treats BOTH anchors as published, which can only ever deny more, never less.
let _cwdRoots: string[] | null = null;
let _cwdRootsFor: string | null = null;
function cwdServedRoots(): string[] {
    const cwd = path.resolve(process.cwd());
    // Keyed on the cwd itself, never cached blindly: process.chdir() at runtime would otherwise leave the
    // guard describing a directory tree the process no longer serves from.
    if (_cwdRoots && _cwdRootsFor === cwd) return _cwdRoots;
    const out: string[] = [];
    if (cwd !== ROOT_DIR) {
        const pluginsRoot = path.join(ROOT_DIR, 'plugins');
        for (const name of ['uploads', 'themes', 'plugins', 'public']) {
            const candidate = path.join(cwd, name);
            // Never let a pathological cwd (e.g. inside plugins/<slug>) turn a plugin's OWN private
            // storage into a "served root" — that would deny writes the plugin is entitled to.
            if (under(candidate, pluginsRoot)) continue;
            out.push(candidate);
        }
    }
    _cwdRoots = out;
    _cwdRootsFor = cwd;
    return out;
}

// Per-segment folding for path COMPARISONS. Off Linux the filesystem folds case, so 'PUBLIC/x.css'
// IS the file the host serves at '/public/x.css'. On Win32 the kernel additionally STRIPS trailing
// dots and spaces from every component ('public.' IS 'public') while path.resolve does not — the
// exact evasion the verification demonstrated on this machine.
const _isWin = process.platform === 'win32';
const _foldSeg = (s: string): string => {
    const t = _isWin ? s.replace(/[. ]+$/, '') : s;
    return process.platform === 'linux' ? t : t.toLowerCase();
};
const foldPath = (p: string): string => p.split(path.sep).map(_foldSeg).join(path.sep);
const under = (candidate: string, dir: string): boolean => {
    const c = foldPath(candidate), d = foldPath(dir);
    return c === d || c.startsWith(d + path.sep);
};

/**
 * CANONICALIZE for the published-surface comparison: the check must run on the value the SYSCALL
 * will use, not on the string the plugin typed. `path.resolve` is purely lexical, so it walks around
 * three real evasions, all of which realpath answers at once:
 *   · a symlink/junction inside the plugin's own dir ('plugins/x/self' → 'plugins/x') makes
 *     'plugins/x/self/public/leak.css' resolve lexically OUTSIDE public/ and land inside it;
 *   · Win32 trailing dot/space ('public./leak.css' → 'public\leak.css');
 *   · 8.3 short names ('PUBLIC~1'), which realpath returns as the long canonical name.
 * The target may not exist yet, so realpath the nearest EXISTING ancestor and re-append the tail.
 * Uses fs.realpathSync, which io-guard deliberately leaves unpatched (existence only, no content).
 */
function canonicalize(target: string): string {
    let cur = path.resolve(target);
    const tail: string[] = [];
    for (let i = 0; i < 4096; i++) {           // hard cap; real path depth is far below this
        try {
            const rp = (fs.realpathSync && fs.realpathSync.native) ? fs.realpathSync.native : fs.realpathSync;
            const real = rp(cur);
            return tail.length ? path.join(real, ...tail) : real;
        } catch { /* does not exist yet — step up to the parent */ }
        const parent = path.dirname(cur);
        if (parent === cur) break;             // filesystem root
        tail.unshift(path.basename(cur));
        cur = parent;
    }
    return path.resolve(target);
}

// The uploads directory is OPERATOR-CONFIGURABLE (config.uploads.dir), and index.ts mounts /uploads on
// THAT value — so a deployment that moves it would have a served root this list does not name. Read it
// from the module cache only (never a fresh require(): this runs from inside fs ops that can fire while
// config is still loading), cached once available. The ROOT_DIR default above covers the normal layout
// meanwhile.
let _cfgUploadsRoot: string | null = null;
function configuredUploadsRoot(): string | null {
    if (_cfgUploadsRoot) return _cfgUploadsRoot;
    try {
        const resolved = require.resolve('../config/app');
        const cached = require.cache[resolved];
        if (!cached || cached.loaded !== true) return null;
        const c: any = cached.exports;
        const dir = c && c.uploads && c.uploads.dir;
        if (typeof dir === 'string' && dir) _cfgUploadsRoot = path.resolve(dir);
    } catch { /* config not resolvable — the declared roots still apply */ }
    return _cfgUploadsRoot;
}

/** Which publicly-served root (if any) contains `resolved`? The CLASS predicate. */
function servedRootOf(resolved: string): string | null {
    for (const root of SERVED_ROOTS) if (under(resolved, root)) return root;
    for (const root of cwdServedRoots()) if (under(resolved, root)) return root;  // the cwd-anchored twins
    const cfg = configuredUploadsRoot();
    if (cfg && under(resolved, cfg)) return cfg;
    return null;
}

// === THE PUBLICLY-SERVED PLUGIN SURFACE (single source of truth; index.ts reads it) ===
//
// (#3) `app.use('/plugins', express.static(plugins/))` published the ENTIRE plugin tree, while a
// plugin may write into its own dir with NO permission grant at all (`ownDir` below is unconditional,
// and secure-require only demands filesystem:write for paths OUTSIDE it). Together those two facts
// annulled the whole network-containment model — the `network` permission, the egress allowlist's
// loopback/RFC1918/metadata blocks and the kernel socket filter: the plugin wrote a file and the attacker
// fetched it, unauthenticated, from the site itself. Nobody was validating the READ channel the
// server itself opened. It also leaked with no malicious plugin at all: mail-server's data/ dir
// (attachments, bayes.json) was reachable on a clean install.
//
// So the surface is now an ALLOWLIST, and it is declared HERE rather than in index.ts because the
// same list has to answer two questions that must never disagree:
//   · index.ts: "may this path be served over HTTP?"  → isPluginServedRelPath()
//   · isPathSafe() below: "may the plugin WRITE this path?" → NO, for everything on this surface.
// Serving an allowlist while leaving it writable would just reopen the channel through the door next
// to it, so the two rules are derived from one declaration.
const PLUGIN_PUBLIC_DIR = 'public';
// Fixed, host-known files the admin shell requests by construction (frontend/src/app/admin/plugin/
// [slug]/page.tsx fetches manifest.json + client/admin/admin.css; pluginBundleLoader links
// dist/component.bundle.css). EXACT paths, never directories — no prefix, no traversal.
const PLUGIN_PUBLIC_FILES = ['manifest.json', 'client/admin/admin.css', 'dist/component.bundle.css'];
// (#3, verification) THE OTHER SINK THAT SERVES A PLUGIN'S FILES: routes/plugin-bundles.ts answers
// GET /api/v1/plugins/:slug/bundle{,/css,/manifest} — UNAUTHENTICATED — out of plugins/<slug>/dist/.
// Listing only `dist/component.bundle.css` as unwritable closed one file of that directory and left
// its siblings (admin/hooks .js/.css, manifest.build.json) writable-and-published: the identical
// write→HTTP-read channel through the door next to it. The rule is therefore stated over the
// DIRECTORY: dist/ is build output, published in full, and READ-ONLY to the plugin — exactly like
// public/. The named files below stay as the list the bundle routes resolve against, so "what the
// route may serve" and "what the plugin may not write" remain one declaration.
const PLUGIN_BUNDLE_DIR = 'dist';
const PLUGIN_BUNDLE_TYPES = ['admin', 'component', 'hooks'];
const PLUGIN_BUNDLE_FILES = new Set<string>([
    ...PLUGIN_BUNDLE_TYPES.map(t => `${PLUGIN_BUNDLE_DIR}/${t}.bundle.js`),
    ...PLUGIN_BUNDLE_TYPES.map(t => `${PLUGIN_BUNDLE_DIR}/${t}.bundle.css`),
    `${PLUGIN_BUNDLE_DIR}/manifest.build.json`,
]);
// Every subtree of a plugin dir the host publishes. Write-denied in full (wider than what is servable
// today on purpose: a narrower rule lets a plugin stage bytes and wait for the allowlist to grow).
const PLUGIN_PUBLISHED_SUBDIRS = [PLUGIN_PUBLIC_DIR, PLUGIN_BUNDLE_DIR];
// Extensions servable out of plugins/<slug>/public/. Deliberately EXCLUDES everything that runs as a
// document in this origin (.html/.htm/.svg/.xml — the XSS variant above) and everything that leaks
// source or data (.map/.json/.txt/.db). .js/.css ARE here: they are the two kinds the structured
// enqueue bridge (core/plugin-assets.ts) exists to emit, and public/ is read-only to the plugin, so
// what is served is what the admin installed and the AST scanner saw.
const PLUGIN_PUBLIC_EXT = new Set([
    '.css', '.js', '.mjs',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
    '.woff', '.woff2', '.ttf', '.otf',
    '.mp4', '.webm', '.mp3', '.ogg', '.wav', '.pdf',
]);

/**
 * Is `rel` — a '/'-separated path RELATIVE to plugins/<folder>/ — part of the surface the host
 * publishes over HTTP? Everything else (data/, source, tests, .map, node_modules, anything a plugin
 * dropped at runtime) is a 404. FAIL CLOSED: a shape this cannot describe is not served.
 */
function isPluginServedRelPath(rel: unknown): boolean {
    if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return false;
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) return false;
    const segs = clean.split('/');
    // Reject empty ('a//b'), relative ('.', '..') and dotfile segments before anything else — the
    // form gate, not a search for forbidden substrings.
    if (segs.some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) return false;
    if (PLUGIN_PUBLIC_FILES.indexOf(clean) !== -1) return true;
    if (segs.length < 2 || segs[0] !== PLUGIN_PUBLIC_DIR) return false;
    return PLUGIN_PUBLIC_EXT.has(path.extname(clean).toLowerCase());
}

/**
 * Is `rel` one of the compiled bundles routes/plugin-bundles.ts is allowed to serve out of
 * plugins/<folder>/dist/? EXACT names only — the route interpolates a caller-supplied `type`, so the
 * answer must never be computed from a prefix + a suffix. Same fail-closed form gate as above.
 */
function isPluginBundleRelPath(rel: unknown): boolean {
    if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return false;
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    return PLUGIN_BUNDLE_FILES.has(clean);
}

// === THE PUBLICLY-SERVED THEME SURFACE (the /themes twin of the declaration above) ===
//
// (#3, verification) /themes was left as `express.static(themes/)` over the WHOLE tree while every
// plugin could write into it — so `GET /themes/default/functions.js` handed out the theme's SERVER
// code and `themes/<x>/leak.txt` was the same unauthenticated exfiltration channel /plugins had.
// A theme is a TOKEN CONTRACT: what a browser legitimately fetches from it is stylesheets, the JSON
// compositions (theme.json, chrome/*.json, templates/*.json), fonts and images. Nothing else — no
// .js (a theme ships no browser JS by contract), no .html partial, no .md, no .map, no source.
// Stated as an extension allowlist over the tree because a theme's assets are referenced from its
// own style.css (theme-compile only proves the url() starts with /themes/<slug>/), so pinning a
// subtree would break themes that place images at the root; the extension list is what actually
// separates "an asset" from "code and sources".
const THEME_PUBLIC_EXT = new Set([
    '.css', '.json',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.svg',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.mp4', '.webm', '.mp3', '.ogg', '.wav', '.pdf',
]);

/** Is `rel` — '/'-separated, RELATIVE to themes/<slug>/ — part of what the host publishes? */
function isThemeServedRelPath(rel: unknown): boolean {
    if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return false;
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) return false;
    const segs = clean.split('/');
    if (segs.some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) return false;
    return THEME_PUBLIC_EXT.has(path.extname(clean).toLowerCase());
}

/**
 * Is `resolved` inside the part of a THEME's own dir the host publishes? Mirror of
 * isPluginPublishedPath: whatever /themes can serve, the theme itself may not write.
 */
function isThemePublishedPath(ownDir: string, resolved: string): boolean {
    if (!under(resolved, ownDir)) return false;
    return THEME_PUBLIC_EXT.has(path.extname(foldPath(resolved)).toLowerCase());
}

/**
 * Is `resolved` (absolute) inside the part of `ownDir` the host publishes over HTTP? Used ONLY to
 * DENY writes, so it is deliberately WIDER than isPluginServedRelPath: the whole public/ subtree is
 * off limits, not just the extensions that happen to be servable today. A narrower rule would let a
 * plugin stage bytes at public/x.unknown and wait for the extension list to grow.
 */
function isPluginPublishedPath(ownDir: string, resolved: string): boolean {
    // Comparison runs through foldPath(), which is CASE-INSENSITIVE off Linux (Windows/macOS fold
    // case, so 'PUBLIC/x.css' IS the file served at '/public/x.css') and additionally strips Win32's
    // trailing dots/spaces per segment ('public./x.css' IS 'public\x.css' to the kernel). An
    // exact-string check denied the write that matters and allowed its twin.
    for (const sub of PLUGIN_PUBLISHED_SUBDIRS) {
        if (under(resolved, path.join(ownDir, sub))) return true;
    }
    const r = foldPath(resolved);
    return PLUGIN_PUBLIC_FILES.some(f => r === foldPath(path.join(ownDir, ...f.split('/'))));
}

// ── EFFECTIVE FILESYSTEM CAPABILITY, READ AT THE CALL ───────────────────────────────────────────────
//
// A plugin's manifest DECLARES what it asks for; the operator GRANTS. `plugin-context.hasPermission`
// already folds both into one boolean, but it collapses the two NOs into one: "never asked" and
// "asked and was refused" both come back false. Those must be told apart, because only the second is a
// REVOCATION — the first is a plugin that simply never wanted the capability, and denying its own
// private directory on that basis would break every zero-permission plugin while protecting nothing.
//
// The manifest is cached per slug for the life of the process, which is sound here rather than merely
// convenient: isPathSafe() itself refuses every write whose basename is `manifest.json` (see above), so
// a plugin cannot rewrite its own declaration at runtime. The GRANT is deliberately NOT cached — it is
// read live from plugin-permissions on every call, which is what makes flipping the switch in
// /admin/plugins take effect immediately instead of at the next activation.
const _manifestPermCache = new Map<string, any[]>();

/** The `permissions` array declared by a plugin/theme slug's manifest, or [] if there is none. */
function declaredPermissionsOf(pluginSlug: string): any[] {
    const cached = _manifestPermCache.get(pluginSlug);
    if (cached) return cached;
    const manifestPath = pluginSlug.startsWith('theme:')
        ? path.join(ROOT_DIR, 'themes', pluginSlug.slice('theme:'.length), 'manifest.json')
        : path.join(ROOT_DIR, 'plugins', pluginSlug, 'manifest.json');
    let perms: any[] = [];
    try {
        // ORIGINALS.readFileSync, never the patched fs: this runs INSIDE isPathSafe, and going through
        // the patched surface would re-enter the guard for every guarded call.
        const raw = ORIGINALS.readFileSync(manifestPath, 'utf8');
        const parsed = JSON.parse(String(raw));
        if (parsed && Array.isArray(parsed.permissions)) perms = parsed.permissions;
    } catch { /* no manifest / unparseable ⇒ nothing declared */ }
    _manifestPermCache.set(pluginSlug, perms);
    return perms;
}

// ── WHERE THE GRANT IS READ, AND WHO WRITES IT: HOST vs ISOLATED CHILD ──────────────────────────────
//
// `plugin-permissions` keeps the granted-token set in a process-local Map. That Map has exactly one
// population path — loadGrants()/setGrants()/backfillActive()/_setGrantsInMemory() — and ALL of them run
// on the HOST, because they read or write the `plugin_grants` option and the child has no database.
//
// The child NEVER writes that Map, so every reader inside the child was reading an empty one. That is
// how "the grant is read LIVE at every call" became "the grant is unreadable, therefore refused": for a
// plugin that DECLARES filesystem — the only kind this gate bites — isGranted() answered false in the
// child, so its OWN data directory was denied even when the operator had granted the capability. Since
// in-process plugins were retired (core/plugins.ts requires `isolated: true`), the child is where every
// real plugin runs, so the gate was a permanent denial in production and a permanent allow in the tests,
// which all run on the host.
//
// The fix follows the channel that already exists for the NETWORK grant: the host RESOLVES the answer at
// spawn and PUSHES it into the child's cfg (core/plugin-isolate.ts builds `childCfg`), and the child
// reads that pushed value instead of a Map nobody there can fill.
//
//   WRITER (host)  core/plugin-isolate.ts  → childCfg.fsRead / childCfg.fsWrite, resolved with the very
//                                            same plugin-permissions.isGranted() this file calls, so the
//                                            two processes cannot disagree on what a token MEANS (the
//                                            `filesystem:admin` implication is interpreted once, there).
//   READER (child) ISOLATE_FS_GRANT below   → consulted by fsCapabilityRevoked()/fsCapabilityAllowed(),
//                                            which are in turn the ONLY filesystem-capability questions
//                                            asked inside the child (io-guard.isPathSafe and
//                                            secure-require.guardFsCall — no other capability is
//                                            enforced child-side; every other one is checked on the host
//                                            when the bridge call lands there).
//
// STALENESS, stated rather than assumed: the pushed value is a SPAWN-TIME snapshot, so it is only as
// live as the isolate. Every writer of the grant store either precedes the spawn or forces a respawn —
// loadGrants()/backfillActive() run at boot before isolates start; grant-on-activate seeds the mirror
// and then activation spawns; and POST /plugins/:slug/permissions calls reloadIsolatedPlugin() after
// setGrants() precisely so a revocation takes effect now. That is the same guarantee the network grant
// has had, and it is the reason a revoke is not left inert.
const ISOLATE_FS_GRANT: { slug: string; read: boolean; write: boolean } | null = (() => {
    const g: any = (typeof globalThis !== 'undefined') ? globalThis : {};
    // HOST: the in-memory grant map is authoritative and live. Read the marker off `globalThis` (per
    // spec unreassignable) for the same reason plugin-context does: `global = {}` must not flip this.
    if (!g.__WORDJS_ISOLATED__) return null;
    // A LATER load of this module must NOT get to answer the question again. "Taken at bootstrap, before
    // plugin code runs" is only true of the FIRST load: plugin code can evict this module from
    // require.cache, rewrite process.argv[2], and re-require it — and the fresh instance would read the
    // rewritten argv. That is a self-grant primitive, and it was demonstrated (a re-required io-guard
    // answered fsCapabilityGranted(write) = true for a plugin the operator had refused). Today an
    // unrelated trap in secure-require happens to abort that re-require, but a defense that only works
    // because a neighbouring module throws first is not a defense.
    //
    // So the first load LOCKS the answer on globalThis — non-writable, non-configurable, exactly as
    // plugin-worker.js locks __WORDJS_PLUGIN_NETWORK__ — and every later load reads the LOCK instead of
    // the argv. The descriptor is checked, not just the value: only a property that is already
    // non-writable AND non-configurable is trusted, so a value planted by other means is ignored (and
    // nothing can plant one first — the sandbox bootstrap loads this module before any plugin code).
    const d = Object.getOwnPropertyDescriptor(g, '__WORDJS_PLUGIN_FS_GRANT__');
    if (d && d.value && typeof d.value === 'object' && d.writable === false && d.configurable === false) {
        return d.value;
    }
    // CHILD, first load: the cfg blob the host handed us. child_process fork → argv[2]; the legacy
    // worker_threads transport → workerData.
    let cfg: any;
    try {
        const wt = require('worker_threads');
        cfg = (wt && wt.parentPort) ? (wt.workerData || {}) : JSON.parse(process.argv[2] || '{}');
    } catch { cfg = {}; } // unparseable cfg ⇒ no grant ⇒ fail closed
    const snapshot = Object.freeze({
        slug: typeof cfg.slug === 'string' ? cfg.slug : '',
        read: cfg.fsRead === true,
        write: cfg.fsWrite === true,
    });
    try {
        Object.defineProperty(g, '__WORDJS_PLUGIN_FS_GRANT__',
            { value: snapshot, writable: false, configurable: false, enumerable: false });
    } catch { /* already defined by something we do not trust ⇒ keep OUR bootstrap answer */ }
    return snapshot;
})();

/**
 * Did the operator GRANT `filesystem:<access>` to this slug? One question, two authorities, chosen by
 * which process is asking: the live grant map on the host, the host-pushed snapshot inside an isolate.
 * Fails CLOSED everywhere — an unreadable grant store, an unparseable cfg, or a slug that is not the one
 * this isolate was spawned for all answer "not granted".
 */
function fsCapabilityGranted(pluginSlug: string, access: 'read' | 'write'): boolean {
    if (ISOLATE_FS_GRANT) {
        // The child runs exactly ONE plugin, so a question about any other slug cannot be answered from
        // this snapshot (a theme rendered inside a plugin's isolate, say) — refuse rather than lend it
        // the host plugin's grant.
        if (!pluginSlug || pluginSlug !== ISOLATE_FS_GRANT.slug) return false;
        return access === 'write' ? ISOLATE_FS_GRANT.write : ISOLATE_FS_GRANT.read;
    }
    try { return require('./plugin-permissions').isGranted(pluginSlug, 'filesystem', access); } catch { return false; }
}

/** Did this plugin DECLARE `filesystem:<access>` (directly or via `filesystem:admin`)? */
function fsCapabilityDeclared(pluginSlug: string, access: 'read' | 'write'): boolean {
    return declaredPermissionsOf(pluginSlug).some(
        (p: any) => p && p.scope === 'filesystem' && (p.access === access || p.access === 'admin'));
}

/**
 * The OUTSIDE-the-own-dir gate: declared AND granted, the full Android-model answer. secure-require's
 * proxies used plugin-context.hasPermission() here, which asks plugin-permissions directly and therefore
 * inherited the same empty-Map blindness in the child (a granted plugin could not write data/ or logs/
 * from an isolate). Routing both halves of the filesystem decision through this file keeps ONE answer to
 * "did the admin say yes", in both processes.
 */
function fsCapabilityAllowed(pluginSlug: string, access: 'read' | 'write'): boolean {
    if (!pluginSlug) return true; // core code, no plugin context
    return fsCapabilityDeclared(pluginSlug, access) && fsCapabilityGranted(pluginSlug, access);
}

/**
 * Did this plugin DECLARE `filesystem:<access>` (or `filesystem:admin`) and NOT receive it from the
 * administrator? True means the operator answered "no" to a capability the plugin explicitly asked for.
 *
 * Fails CLOSED on an unreadable grant store: if we cannot prove the capability was granted, a declared
 * capability counts as refused.
 */
function fsCapabilityRevoked(pluginSlug: string, access: 'read' | 'write'): boolean {
    if (!pluginSlug) return false;
    // THEMES ARE OUT OF SCOPE HERE, AND THIS IS A LIMITATION, NOT A DESIGN CHOICE TO BE PROUD OF:
    // plugin-permissions.setGrants only accepts a slug matching PLUGIN_SLUG, which a `theme:<slug>`
    // identifier cannot match, so there is no way for an operator to GRANT a theme anything. Applying
    // "declared and not granted ⇒ denied" to themes would therefore turn any theme that declares
    // filesystem into a permanent, unliftable denial rather than an operator decision. For themes the
    // AST scan (which does read their whole tree, hidden dirs included) remains the only gate — say so
    // rather than let the exported name imply a coverage that is not there.
    if (pluginSlug.startsWith('theme:')) return false;
    if (!fsCapabilityDeclared(pluginSlug, access)) return false; // never asked ⇒ nothing to revoke
    return !fsCapabilityGranted(pluginSlug, access);
}

/**
 * Is this read the MODULE LOADER's, rather than the plugin's? Node's CJS/ESM resolver reads the entry
 * file, `package.json` and anything under `node_modules/` through this same patched fs BEFORE a single
 * line of plugin code has run. Applying the revocation to those does not deny the plugin a capability:
 * it makes the module UNLOADABLE (a raw EACCES out of defaultLoadImpl / readPackageScope), so revoking
 * `filesystem:read` stopped the isolate BOOTING instead of stopping it reading. Demonstrated, not
 * theorised — it is how the isolate test failed before this existed.
 *
 * What it exempts is exactly the plugin's own vetted CODE and its resolution metadata: files it shipped
 * and cannot fabricate at runtime (io-guard refuses every write whose extension is executable, and
 * manifest/package writes are refused or revocable), and which it could equally have inlined into its
 * source. Data files in the own dir — the bytes a read revocation is actually about — are untouched by
 * this and stay refused.
 *
 * READS ONLY, and it lives in a function because BOTH copies of the capability gate (isPathSafe here and
 * secure-require.guardFsCall) must apply the SAME one, or a require() resolves on one fs surface and
 * EACCESes on the other.
 */
function isModuleLoaderRead(targetPath: unknown, isWrite: boolean): boolean {
    if (isWrite) return false;
    let resolved: string;
    try { resolved = path.resolve(String(targetPath)); } catch { return false; }
    const base = path.basename(resolved);
    if (base === 'package.json') return true;
    if (resolved.split(path.sep).includes('node_modules')) return true;
    return EXECUTABLE_CODE_EXT.test(base);
}

/** Test/host hook: drop the cached manifest declaration for a slug (install/update rewrites it). */
function forgetDeclaredPermissions(pluginSlug?: string): void {
    if (pluginSlug) _manifestPermCache.delete(pluginSlug); else _manifestPermCache.clear();
}

/**
 * Check if a path is safe to access
 */
// `knownSlug` lets a CALLER that has already resolved the effective plugin pass it in. That resolution is
// NOT cheap when the ALS context is empty — the 100% case for host code — because getEffectivePlugin()
// then falls back to a stack walk (Error.stackTraceLimit = 200 + a realpath per candidate frame, ~20-40 µs).
// The fs patches below therefore resolve it ONCE per call and hand it down; nobody should call
// getEffectivePlugin() twice on one filesystem operation. Pass `null` to mean "no plugin, do not resolve".
function isPathSafe(targetPath: string, isWrite = false, knownSlug?: string | null) {
    const pluginSlug = knownSlug !== undefined ? knownSlug : getEffectivePlugin();
    if (!pluginSlug) return true; // Core code is trusted

    // No plugin is exempt: EVERY plugin is uniformly confined by io-guard (no trust tier). Plugins
    // reach scoped DB rows / their own data via the bridge; the raw DB file + secret files stay blocked.

    // Normalize Windows extended-length / UNC prefixes (\\?\C:\... or \\?\UNC\...) that
    // require.resolve / realpath can produce, otherwise the safe-zone startsWith() checks
    // fail to match ROOT_DIR and legitimate in-dir reads get wrongly blocked.
    let resolved = path.resolve(targetPath);
    resolved = resolved.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
    const filename = path.basename(resolved).toLowerCase();

    // SECURITY: Explicitly blocked files (contain secrets)
    const BLOCKED_FILES = [
        '.env',
        '.env.local',
        '.env.production',
        '.env.development',
        'wordjs-config.json',
        'wordjs-config.backup.json',
        'wjp-prefix-registry.json', // per-plugin table-prefix ownership registry (#12) — plugin-untouchable
        'package-lock.json', // Can reveal dependency tree for attacks
        'id_rsa',
        'id_ed25519',
        '.htpasswd',
        'shadow',
        'passwd'
    ];

    // Block files by name — CASE-INSENSITIVE: Windows/macOS filesystems are case-insensitive, so an exact
    // match would let a plugin reach wordjs-config.json / the prefix registry / .env via a case variant
    // like WORDJS-CONFIG.JSON or WJP-Prefix-Registry.json (#12).
    if (BLOCKED_FILES.some(f => f.toLowerCase() === String(filename).toLowerCase())) {
        throttledWarn(`${pluginSlug}:sensitive-file`, `[Security Block] Plugin '${pluginSlug}' tried to access sensitive file: ${resolved}`);
        return false;
    }

    // SECURITY: the live database files hold EVERY credential, session token, and secret-named option,
    // so plugin code must never open + parse the raw DB file. Enforce this ONLY in the isolated CHILD,
    // where plugin code actually runs. On the HOST the only fs access under a plugin's context is the
    // BRIDGE's own DB driver doing legitimate scoped work — callApi runs inside runWithContext(slug), so
    // getEffectivePlugin() returns the slug while the host driver opens data/wordjs.db. That file lives
    // in the data/ safe zone (allowed below); a plugin still can't reach it raw (its bridge fs.read is
    // confined to its own dir). Blocking it on the host would wrongly break every plugin's DB access.
    // Read the isolation marker off `globalThis` (unreassignable per spec), NOT the writable `global`
    // identifier: a plugin doing `global = {}` would otherwise make __WORDJS_ISOLATED__ read undefined and
    // SKIP this DB-file block, and since data/ is an allowed write-zone below, the raw core DB (every
    // credential + secret-named option) would then be readable. globalThis defeats that reassignment.
    const g: any = (typeof globalThis !== 'undefined') ? globalThis : {};
    if (g.__WORDJS_ISOLATED__) {
        if (/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(filename)) {
            throttledWarn(`${pluginSlug}:db-file`, `[Security Block] Plugin '${pluginSlug}' tried to access a database file: ${resolved}`);
            return false;
        }
        const cfgDbPaths = getConfiguredDbPaths();
        if (cfgDbPaths.some(db => resolved === db || resolved.startsWith(db + '-'))) {
            throttledWarn(`${pluginSlug}:db-configured`, `[Security Block] Plugin '${pluginSlug}' tried to access the configured database file: ${resolved}`);
            return false;
        }
    }

    // SECURITY: a plugin must NOT rewrite any manifest.json at runtime — permissions are read
    // live from it, so a self-rewrite would be a permission-escalation primitive. Block all writes.
    if (isWrite && filename === 'manifest.json') {
        throttledWarn(`${pluginSlug}:manifest`, `[Security Block] Plugin '${pluginSlug}' tried to write a manifest.json: ${resolved}`);
        return false;
    }

    // SECURITY (self-code-modification / scanner-evasion): never let a plugin CREATE or rename/copy a
    // file into an executable code extension anywhere it can write — not even its own dir. Its committed
    // code is what the AST scanner vetted; a fresh runtime .js (directly, or written as .txt then renamed
    // to .js) would run un-scanned. Applies to every write path (write/append/rename-dest/copy-dest).
    if (isWrite && EXECUTABLE_CODE_EXT.test(filename)) {
        throttledWarn(`${pluginSlug}:exec-write`, `[Security Block] Plugin '${pluginSlug}' tried to write executable code: ${resolved}`);
        return false;
    }

    // Block any file with secret-like patterns in name
    const sensitivePatterns = ['secret', 'credential', 'private', 'key.pem', 'cert.pem'];
    if (sensitivePatterns.some(pattern => filename.includes(pattern))) {
        throttledWarn(`${pluginSlug}:sensitive-pattern`, `[Security Block] Plugin '${pluginSlug}' tried to access sensitive pattern file: ${resolved}`);
        return false;
    }

    // One filesystem declaration feeds this JS gate and every native sandbox. In particular there is no
    // broad data/, logs/, themes/ or src/ read: those trees contain the database, sibling state and host
    // implementation details. Shared mutable storage is namespaced by slug under private directories.
    const nativePaths = sandboxPaths(ROOT_DIR, pluginSlug, __dirname);
    const SAFE_READ_DIRS = [...nativePaths.readOnly, ...nativePaths.storage];
    const SAFE_WRITE_DIRS = [...nativePaths.storage];

    // A plugin may always read+write within its OWN dir (plugins/<slug> or themes/<slug>) — that's its
    // private storage (data files, caches, attachments). It's still subject to the file-name blocks
    // above (manifest.json / DB-in-child / secret-named) and to the per-plugin disk quota at the bridge.
    const ownDir = nativePaths.own;

    // ── THE REVOCATION IS ENFORCED HERE, AT THE CALL, NOT BY A STATIC SCANNER ────────────────────────
    //
    // The own dir used to be the ONE region of the filesystem with no capability gate at all: the grant
    // check in secure-require reads `!isPathWithinPluginDir(...) && !hasPermission(...)`, so a write
    // inside the plugin's own directory was authorized by geography alone. That made the AST scanner in
    // core/plugins.ts the ONLY thing standing between a revoked `filesystem:write` and a real write —
    // and an AST scanner answers "does this code reach fs?" by enumerating SPELLINGS, so every audit
    // round found new ones (class fields, default parameters, `this.x = require('fs')`, a getter, a
    // returned module…). Enumeration cannot win that race.
    //
    // So the decision moved to the only place that cannot be out-spelled: the moment of the call. By the
    // time control reaches here the module value has already been obtained, however it was spelled — the
    // syntax that carried it is gone and irrelevant.
    //
    // THE RULE, stated so it can be checked rather than inferred:
    //   · A capability the plugin NEVER DECLARED is not revoked — it was never asked for. Its own
    //     directory stays private storage with no grant (the Android private-storage model, and what
    //     every zero-permission plugin has always had). Widening this would break every such plugin
    //     without closing anything: private storage publishes no bytes (the published subtree is
    //     read-only above, executable extensions are refused, and the quota still meters it).
    //   · A capability the plugin DECLARED and the administrator DID NOT GRANT is DENIED — everywhere,
    //     including the own directory. That is what the switch in /admin/plugins now means. On the host
    //     it takes effect on the next call (the in-memory grant store is read live); inside an isolate
    //     the answer is the value the host pushed at spawn, and POST /plugins/:slug/permissions respawns
    //     the isolate after every grant change so the switch is never left inert. See ISOLATE_FS_GRANT.
    //   · ONE carve-out, and it is about WHO IS ASKING, not about relaxing the rule: the reads the MODULE
    //     LOADER performs to bring the plugin's own vetted code into memory (entry file, package.json,
    //     node_modules) are exempt — see isModuleLoaderRead. Refusing those never stopped a plugin
    //     reading anything; it stopped the isolate BOOTING, with an EACCES thrown out of Node's loader
    //     before any plugin code existed. Data files in the own dir stay refused, which is what a read
    //     revocation is actually about.
    // Outside the own dir the grant was, and remains, required outright (secure-require guardFsCall).
    if (!isModuleLoaderRead(resolved, isWrite) && under(resolved, ownDir) && fsCapabilityRevoked(pluginSlug, isWrite ? 'write' : 'read')) {
        throttledWarn(`${pluginSlug}:fs-revoked`,
            `[Security Block] Plugin '${pluginSlug}' declared filesystem:${isWrite ? 'write' : 'read'} but the administrator has not granted it — refusing: ${resolved}`);
        return false;
    }

    // SECURITY (#3): the plugin's own dir is writable with NO grant, and part of it is PUBLISHED over
    // HTTP by index.ts. Writable ∩ published = an unauthenticated exfiltration channel that no network
    // control can see (the plugin never opens a socket; the SERVER hands the bytes out). Serving an
    // allowlist alone would not have closed it — a plugin would simply overwrite an allowlisted file,
    // e.g. its own public/banner.css, with the stolen bytes. So the published surface is READ-ONLY to
    // the plugin, and both rules are derived from the one declaration above.
    //
    // STATED AS A CLASS (verification of #3): the first version named /plugins and left /uploads and
    // /themes — same writability, same server, same anonymous reader — wide open. The rule below is
    // therefore "inside ANY publicly-served root, the only writes allowed are the ones inside this
    // plugin's own dir that the host does NOT publish", so every mount in SERVED_ROOTS is covered by
    // construction and a new mount is covered by adding it to that list.
    //
    // AND IT COMPARES THE VALUE THE SYSCALL USES. canonicalize() realpaths the nearest existing
    // ancestor, which is what defeats (a) a symlink/junction the plugin created inside its own dir
    // ('<own>/self' → '<own>', so '<own>/self/public/leak.css' lands in public/ while resolving
    // lexically outside it), (b) Win32's trailing-dot/space stripping ('public./leak.css'), and
    // (c) 8.3 short names. Both the lexical and the canonical form are checked, so neither a
    // realpath failure nor a link can produce an ALLOW the other form would have denied.
    const isThemeCtx = pluginSlug.startsWith('theme:');
    // Canonicalize only for writes somewhere under the install root — every served root lives there,
    // so this cannot skip a published path, and it keeps the extra realpath off writes to os-tmp and
    // the like. The membership test itself is asked of BOTH forms: a link whose lexical path is
    // outside every served root but whose real path is inside one must not slip through the gate.
    const canon = (isWrite && under(resolved, ROOT_DIR)) ? canonicalize(resolved) : resolved;
    if (isWrite && (servedRootOf(resolved) !== null || servedRootOf(canon) !== null)) {
        const ownReal = canonicalize(ownDir);
        const withinOwn = under(resolved, ownDir) && under(canon, ownReal);
        const publishedInOwn = isThemeCtx
            ? (isThemePublishedPath(ownDir, resolved) || isThemePublishedPath(ownReal, canon))
            : (isPluginPublishedPath(ownDir, resolved) || isPluginPublishedPath(ownReal, canon));
        if (!withinOwn || publishedInOwn) {
            throttledWarn(`${pluginSlug}:published-write`, `[Security Block] Plugin '${pluginSlug}' tried to write into a PUBLICLY SERVED path: ${resolved}`);
            return false;
        }
    }

    const dirsToCheck = (isWrite ? SAFE_WRITE_DIRS : SAFE_READ_DIRS).concat([ownDir]);
    // Exact-match or trailing-separator prefix so safe dir 'foo' does not also whitelist
    // a sibling 'foo-bar' that merely shares a string prefix.
    let isAllowed = dirsToCheck.some(dir => resolved === dir || resolved.startsWith(dir + path.sep));

    // The host DB driver legitimately runs under runWithContext(slug) while serving a scoped bridge
    // query. It may open ONLY the configured database file and its sidecars — never the former broad
    // data/ tree. Inside an isolate the earlier DB block always wins.
    //
    // READS AND WRITES ALIKE. This used to exempt reads only, which is invisible under sqlite-native
    // (better-sqlite3 writes from C++, nothing here ever sees it) and fatal under sqlite-legacy: sql.js
    // keeps the database in memory and persists it with fs.writeFileSync(activeDbPath) after every
    // committed write (drivers/sqlite-legacy.ts save()). Serving a bridged INSERT from a plugin thus
    // ended in a host-side WRITE of data/wordjs.db under that plugin's context, this guard called it
    // "outside safe zones", and every plugin holding database:write failed to load on the pure-JS
    // driver — the one a fresh install falls back to when the native module is missing. In the host
    // process the only code that runs under a plugin slug is the bridge, so the write is core's own;
    // an isolated child never reaches this branch (the __WORDJS_ISOLATED__ block above returns first).
    if (!g.__WORDJS_ISOLATED__) {
        const cfgDbPaths = getConfiguredDbPaths();
        if (cfgDbPaths.some(db => resolved === db || resolved.startsWith(db + '-'))) isAllowed = true;
    }

    // The hashed data/log/tmp roots are capability storage, not free private storage. secure-require
    // already asks this question, but the global fs backstop must enforce it independently too.
    if (nativePaths.storage.some((dir: string) => under(resolved, dir))
        && !fsCapabilityAllowed(pluginSlug, isWrite ? 'write' : 'read')) {
        throttledWarn(`${pluginSlug}:storage-grant`, `[Security Block] Plugin '${pluginSlug}' lacks filesystem:${isWrite ? 'write' : 'read'} for private capability storage: ${resolved}`);
        return false;
    }

    // Module-resolution metadata is NOT a secret, and Node reads it from ancestors of the plugin entry
    // (incl. the shared plugins/ parent) + dependency trees. Since plugins/ is intentionally NOT a broad
    // read safe-zone (that would expose another plugin's private files like an encryption key), allow
    // READS of any package.json and anything under a node_modules/ dir so require()/import resolution
    // keeps working — without re-opening cross-plugin reads of source/data/secrets.
    if (!isAllowed && !isWrite) {
        const base = path.basename(resolved);
        if (base === 'package.json' || resolved.split(path.sep).includes('node_modules')) {
            // ...but NEVER inside a SIBLING plugin's dir. Module resolution only reads the plugin's OWN
            // tree + shared ancestors (plugins/package.json, backend/, root node_modules) — never a sibling
            // plugin's package.json/node_modules — so deny those to keep cross-plugin reads closed. (IO-1)
            const pluginsRoot = path.join(ROOT_DIR, 'plugins');
            let underSibling = false;
            if (resolved.startsWith(pluginsRoot + path.sep)) {
                const after = resolved.slice(pluginsRoot.length + 1);
                const firstSeg = after.split(path.sep)[0];
                if (after.includes(path.sep) && firstSeg && firstSeg !== pluginSlug) underSibling = true;
            }
            if (!underSibling) isAllowed = true;
        }
    }

    // MONOLITH-mode carve-out: Next.js runs in-process and flushes its own dev log
    // (frontend/.next/dev/logs/*.log) from a timer that can inherit a plugin's ALS context —
    // secure-require wraps timers with creation-time context, so a console.log intercepted by
    // Next's log capture inside a plugin scope schedules the flusher "as" that plugin. The write
    // is Next's own, not the plugin's; denying it only breaks Next's logging and floods the
    // console with EACCES.
    //
    // SCOPED TO THE DIRECTORY THE JUSTIFICATION NAMES, not to a file EXTENSION under the whole build
    // tree. The first version allowed any '*.log' anywhere under .next — and .next/static is PUBLISHED
    // by Next at /_next/static, so a plugin with zero permissions could write
    // frontend/.next/static/leak.log and have the server hand it to an anonymous GET. An extension is
    // never a containment boundary: state the carve-out as the subtree that needs it (and it is checked
    // against servedRootOf too, so declaring a new Next mount above closes this automatically).
    if (!isAllowed && isWrite) {
        const nextDevLogs = path.resolve(ROOT_DIR, '../frontend/.next/dev/logs');
        if (under(resolved, nextDevLogs) && /\.log$/i.test(resolved) && servedRootOf(resolved) === null) {
            isAllowed = true;
        }
    }

    if (!isAllowed) {
        throttledWarn(`${pluginSlug}:outside-${isWrite ? 'write' : 'read'}`, `[Security Block] Plugin '${pluginSlug}' tried to ${isWrite ? 'WRITE' : 'READ'} outside safe zones: ${resolved}`);
        return false;
    }

    return true;
}

// === PER-PLUGIN DISK WRITE QUOTA ===
// io-guard governs raw fs; the bridge's byte quota (wordjs.fs.write) is BYPASSED when a plugin writes
// via require('fs') directly. Path checks confine WHERE a plugin writes but not HOW MUCH — an unbounded
// createWriteStream/appendFile loop to its own dir (no grant needed) fills the shared volume → ENOSPC on
// the DB → full-site outage. Meter it here. (#14) ALL byte-producing writers — writeFile*, append*, and
// createWriteStream — accumulate toward the rolling cap. The earlier exemption for whole-file writeFile
// ("it overwrites, so payload == final file size, so the single-write cap suffices") was FALSE: a loop of
// DISTINCT filenames (each ≤64MB, own dir, no grant) and a writeFile({flag:'a'}) append both grow the
// volume without bound under the single-cap-only branch. The single-write cap still bounds any individual
// payload; the rolling window bounds cumulative growth regardless of overwrite-vs-append or filename churn.
const SINGLE_WRITE_MAX = 64 * 1024 * 1024;        // 64MB — largest single write/chunk a plugin may make
const PLUGIN_GROW_QUOTA = 512 * 1024 * 1024;      // 512MB of append/stream growth per ROLLING WINDOW per plugin
const GROW_WINDOW_MS = 60 * 1000;                 // rolling window: a flood trips fast; slow legit appends never do
const QUOTA_METHODS = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']);
// Per-plugin rolling-window accounting for GROWING writes. A lifetime counter would eventually block a
// legitimate long-running plugin that appends a rotated log; a window (reset when stale) stops a burst
// disk-fill while never permanently throttling normal slow growth. Shared with the fs.promises path via
// the exported enforceGrowQuota so both APIs count against the same budget.
const _grownWindow = new Map<string, { start: number; bytes: number }>();

function quotaErr(slug: string, msg: string): any {
    const e: any = new Error(`EDQUOT: plugin '${slug}' disk write blocked — ${msg}`);
    e.code = 'EDQUOT';
    return e;
}
function byteLenOf(data: any): number {
    if (data == null) return 0;
    if (typeof data === 'string') return Buffer.byteLength(data);
    if (Buffer.isBuffer(data)) return data.length;
    if (data && typeof data.byteLength === 'number') return data.byteLength; // TypedArray/ArrayBuffer/DataView
    try { return Buffer.byteLength(String(data)); } catch { return 0; }
}
function enforceSingleWrite(slug: string, n: number): void {
    if (n > SINGLE_WRITE_MAX) throw quotaErr(slug, `single write of ${n} bytes exceeds the ${SINGLE_WRITE_MAX}-byte limit`);
}
function enforceGrowQuota(slug: string, n: number): void {
    enforceSingleWrite(slug, n);
    const now = Date.now();
    let w = _grownWindow.get(slug);
    if (!w || now - w.start > GROW_WINDOW_MS) { w = { start: now, bytes: 0 }; _grownWindow.set(slug, w); }
    if (w.bytes + n > PLUGIN_GROW_QUOTA) throw quotaErr(slug, `append/stream growth quota of ${PLUGIN_GROW_QUOTA} bytes per ${GROW_WINDOW_MS / 1000}s exceeded`);
    w.bytes += n;
}
// (#7) Count the directory entries a mkdir will actually create so each can be charged the block floor:
// 1 for a non-recursive mkdir, and for recursive:true the number of not-yet-existing ancestors up to the
// first existing dir (so a single deep `mkdir -p` is metered per NEW component, not once). Best-effort —
// stat errors fall back to 1, and a hard depth cap guarantees this can never loop unbounded. Uses the
// unpatched fs.existsSync (existence only, no content) exactly as the copyFile metering below uses statSync.
function mkdirCreateCount(target: any, recursive: boolean): number {
    if (!recursive) return 1;
    let count = 0;
    let cur = path.resolve(String(target));
    for (let i = 0; i < 4096; i++) {           // hard cap; real filesystem path depth is far below this
        let exists: boolean;
        try { exists = fs.existsSync(cur); } catch { exists = false; }
        if (exists) break;
        count++;
        const parent = path.dirname(cur);
        if (parent === cur) break;             // reached the filesystem root
        cur = parent;
    }
    return Math.max(1, count);
}
// Patch fs.WriteStream.PROTOTYPE._write/_writev ONCE (context-gated) — the instance-level stream.write
// shadow in wrapQuotaStream is trivially bypassed via Object.getPrototypeOf(stream).write.call(stream)
// (#14, same class of hole as FileHandle). _write/_writev are the single funnel EVERY buffered write
// passes through no matter how .write was reached, so metering there is authoritative; host streams
// (getEffectivePlugin()===null) are unaffected.
let _wsProtoPatched = false;
function patchWriteStreamProto(): void {
    if (_wsProtoPatched) return;
    try {
        const WS: any = (fs as any).WriteStream;
        if (!WS || !WS.prototype) return;
        const orig = WS.prototype._write;
        if (typeof orig === 'function') {
            WS.prototype._write = function (this: any, chunk: any, enc: any, cb: any) {
                const slug = getEffectivePlugin();
                if (slug && chunk != null) { try { enforceGrowQuota(slug, byteLenOf(chunk)); } catch (e) { return cb(e); } }
                return orig.call(this, chunk, enc, cb);
            };
        }
        const origV = WS.prototype._writev;
        if (typeof origV === 'function') {
            WS.prototype._writev = function (this: any, chunks: any[], cb: any) {
                const slug = getEffectivePlugin();
                if (slug && Array.isArray(chunks)) { try { let n = 0; for (const c of chunks) n += byteLenOf(c && c.chunk); enforceGrowQuota(slug, n); } catch (e) { return cb(e); } }
                return origV.call(this, chunks, cb);
            };
        }
        _wsProtoPatched = true;
    } catch { /* best-effort; the instance shadow below remains as defense */ }
}
// Wrap a createWriteStream result so each chunk is metered; on overflow the stream is destroyed with the
// quota error (surfaced as a normal stream 'error') instead of silently filling the disk.
function wrapQuotaStream(slug: string, stream: any): any {
    patchWriteStreamProto(); // authoritative prototype-level metering (covers getPrototypeOf(stream).write)
    if (!stream || typeof stream.write !== 'function') return stream;
    const origWrite = stream.write.bind(stream);
    const origEnd = stream.end.bind(stream);
    stream.write = function (chunk: any, enc?: any, cb?: any) {
        if (chunk != null && typeof chunk !== 'function') {
            try { enforceGrowQuota(slug, byteLenOf(chunk)); }
            catch (e) { stream.destroy(e as Error); return false; }
        }
        return origWrite(chunk, enc, cb);
    };
    stream.end = function (chunk?: any, enc?: any, cb?: any) {
        if (chunk != null && typeof chunk !== 'function') {
            try { enforceGrowQuota(slug, byteLenOf(chunk)); }
            catch (e) { stream.destroy(e as Error); return stream; }
        }
        return origEnd(chunk, enc, cb);
    };
    return stream;
}

// fs.open(path, flags?, mode?, cb) decides READ vs WRITE by its flags (default 'r' = read). A plugin that
// opens a file for WRITING outside its write-zones (e.g. into node_modules, a read-only zone) must be
// write-confined, not waved through as a read — else open is a write-confinement bypass. Handles the
// string forms (w/a/r+/w+/a+/wx/ax…, all of which contain w, a, or +; plain 'r'/'rs' do not) and the
// numeric O_* bitmask; a missing/callback flags arg means the default 'r'.
function openFlagsAreWrite(flags: any): boolean {
    if (flags == null || typeof flags === 'function') return false;
    if (typeof flags === 'number') {
        const acc = flags & 0o3; // O_ACCMODE: 0=RDONLY, 1=WRONLY, 2=RDWR
        const wbits = fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC;
        return acc !== 0 || (flags & wbits) !== 0;
    }
    return /[wa+]/.test(String(flags));
}

// === PATCHES ===

function patch(methodName: string, isSync = false) {
    const original = (ORIGINALS as any)[methodName];
    if (!original) return;

    const isWrite = [
        'writeFile', 'writeFileSync',
        'unlink', 'unlinkSync',
        'rm', 'rmSync',
        'rmdir', 'rmdirSync',
        'rename', 'renameSync',
        'mkdir', 'mkdirSync',
        'symlink', 'symlinkSync',
        'appendFile', 'appendFileSync',
        'createWriteStream', 'truncate', 'truncateSync',
        'chmod', 'chmodSync', 'lchmod', 'chown', 'chownSync'
    ].includes(methodName);

    fs[methodName] = function (...args: any[]) {
        // ONE resolution of the effective plugin per filesystem call, taken first: with an empty ALS
        // context getEffectivePlugin() walks the stack (see isPathSafe), and this wrapper used to pay for
        // it once inside isPathSafe and again for the quota. Host code (no plugin) leaves immediately and
        // pays nothing — the guard has no opinion on core code.
        const cslug = getEffectivePlugin();
        if (!cslug) return original.apply(this, args);

        // Different methods have path(s) at different positions, with different read/write semantics.
        // pathsToCheck is a list of [path, isWriteForThisPath] pairs.
        let pathsToCheck: [any, boolean][] = [[args[0], isWrite]];

        if (methodName.startsWith('copy') || methodName.startsWith('cp') || methodName.startsWith('link')) {
            // (source, dest): source is READ, dest is WRITTEN. Checking the source with read semantics
            // still denies a secret/DB source (those blocks ignore the flag) while the dest gets the full
            // write confinement — including the executable-extension block, which stops copy/hard-link to
            // '<own>/x.js'. Read semantics on the source avoids over-blocking a legit copy out of a
            // read-only zone (e.g. node_modules) into a safe write dir.
            pathsToCheck = [[args[0], false], [args[1], true]];
        } else if (methodName.startsWith('rename') || methodName.startsWith('symlink')) {
            // rename modifies BOTH ends; symlink writes the link path. Check both with write semantics
            // (secret/DB source is still denied regardless, and rename-into-x.js is caught on the dest).
            pathsToCheck = [[args[0], true], [args[1], true]];
        } else if (methodName === 'open' || methodName === 'openSync') {
            // open's read/write intent lives in its flags (args[1]); confine with the correct semantics so
            // open-for-write outside the write-zones is denied as a write, not passed through as a read.
            pathsToCheck = [[args[0], openFlagsAreWrite(args[1])]];
        }

        for (const [p, w] of pathsToCheck) {
            if (!p) continue;
            // Validate
            if (!isPathSafe(p, w, cslug)) {
                const error: any = new Error(`EACCES: Permission denied, plugin cannot access: ${p}`);
                error.code = 'EACCES';
                if (isSync) throw error;
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(error);
                return;
            }
        }

        // (#14) truncate(path,len)/truncateSync ALLOCATE `len` bytes — a byte-producing write QUOTA_METHODS
        // omits. Meter by the target length against the same rolling grow quota (metered only under plugin
        // context; core/host is unmetered).
        if (methodName === 'truncate' || methodName === 'truncateSync') {
            {
                try { enforceGrowQuota(cslug, Math.max(0, Number(args[1]) || 0)); }
                catch (error: any) {
                    if (isSync) throw error;
                    const cb = args[args.length - 1];
                    if (typeof cb === 'function') { cb(error); return; }
                    throw error;
                }
            }
        }
        // (#14) copyFile/copyFileSync DUPLICATE a file — a real byte-writer that QUOTA_METHODS omits. Meter
        // the SOURCE file's size against the same rolling grow quota so a distinct-dest copy loop can't fill
        // the disk unmetered. (Metered only under plugin context; core/host is unmetered.)
        if (methodName === 'copyFile' || methodName === 'copyFileSync' || methodName === 'cp' || methodName === 'cpSync') {
            {
                try {
                    let sz = 0; try { sz = fs.statSync(args[0]).size; } catch { sz = 0; }
                    enforceGrowQuota(cslug, sz);
                } catch (error: any) {
                    if (isSync) throw error;
                    const cb = args[args.length - 1];
                    if (typeof cb === 'function') { cb(error); return; }
                    throw error;
                }
            }
        }
        // (#7) mkdir/mkdirSync CREATE directory entries — an inode/dir-entry producer QUOTA_METHODS omits, so
        // an unbounded mkdir loop (each dir in the plugin's OWN dir, no grant needed) exhausts inodes / fills
        // the shared volume → ENOSPC on data/wordjs.db → full-site outage, entirely unmetered. Charge each
        // directory actually created at least one filesystem-block floor (4096 B) against the SAME rolling
        // grow-quota the write ops use; for recursive:true, charge per not-yet-existing component so one deep
        // tree is metered per new dir, not once. (Metered only under a plugin context; core/host is unmetered.
        // Runs only after isPathSafe() passed above, so mkdir's normal path-safety checks stay intact.)
        if (methodName === 'mkdir' || methodName === 'mkdirSync') {
            {
                try {
                    const opts = (args[1] && typeof args[1] === 'object') ? args[1] : null;
                    enforceGrowQuota(cslug, 4096 * mkdirCreateCount(args[0], !!(opts && opts.recursive)));
                } catch (error: any) {
                    if (isSync) throw error;
                    const cb = args[args.length - 1];
                    if (typeof cb === 'function') { cb(error); return; }
                    throw error;
                }
            }
        }

        // Per-plugin write quota (metered only under a plugin context; core/host is unmetered).
        const quotaSlug = QUOTA_METHODS.has(methodName) ? cslug : null;
        if (quotaSlug) {
            if (methodName === 'createWriteStream') {
                return wrapQuotaStream(quotaSlug, original.apply(this, args));
            }
            try {
                // (#14) writeFile* now accumulate against the rolling grow-quota exactly like append*,
                // instead of only taking the per-call single-write cap. The old exemption assumed a
                // whole-file writeFile "overwrites, so payload == final file size, so the single cap
                // suffices" — FALSE for a loop of DISTINCT filenames:
                //   for (let i = 0; ; i++) fs.writeFileSync('<owndir>/f' + i, buf64MB);
                // each write is ≤64MB and needs no grant, yet the loop wrote tens of GB → ENOSPC on
                // data/wordjs.db → full-site outage. It is also false for a single-file append via
                // writeFile('<owndir>/log', chunk, { flag: 'a' }) (string 'a'/'ax'/'a+' OR numeric
                // O_APPEND=1024), which the old single-cap branch never inspected. Metering EVERY write
                // (overwrite or append) against the window closes both: enforceGrowQuota calls
                // enforceSingleWrite internally, so the >64MB single-payload reject is preserved, AND it
                // adds the payload to the rolling window — one accounting path per call, never doubled.
                // (#14) A writeFile CREATES/overwrites a file, and a loop of DISTINCT filenames with a 0-byte
                // (or tiny) payload floods inodes/dir entries while charging ~0 bytes. Floor each writeFile at
                // one filesystem block so an empty-file flood still accrues quota (≈128K files per 60s window
                // before the 512MB cap trips — far above any legitimate write rate). Append/stream unaffected.
                const _floor = (methodName === 'writeFile' || methodName === 'writeFileSync') ? 4096 : 0;
                enforceGrowQuota(quotaSlug, Math.max(byteLenOf(args[1]), _floor));
            } catch (error: any) {
                if (isSync) throw error;
                const cb = args[args.length - 1];
                if (typeof cb === 'function') { cb(error); return; }
                throw error;
            }
        }

        return original.apply(this, args);
    };
}

// Write Ops
patch('writeFile'); patch('writeFileSync', true);
patch('unlink'); patch('unlinkSync', true);
patch('rm'); patch('rmSync', true);
// rmdir/chown were in the isWrite list but never patched (no ORIGINALS entry → patch() returned early),
// so both reached the filesystem unguarded. Same class as the fs.promises gap below: a method named in
// the policy but absent from the enforcement.
patch('rmdir'); patch('rmdirSync', true);
patch('chown'); patch('chownSync', true);
patch('rename'); patch('renameSync', true);
patch('mkdir'); patch('mkdirSync', true);
patch('symlink'); patch('symlinkSync', true);
patch('appendFile'); patch('appendFileSync', true);
patch('createWriteStream');
patch('truncate'); patch('truncateSync', true);
patch('chmod'); patch('chmodSync', true);
patch('copyFile'); patch('copyFileSync', true);
patch('cp'); patch('cpSync', true);
patch('link'); patch('linkSync', true);

// Read Ops
patch('readFile'); patch('readFileSync', true);
patch('readdir'); patch('readdirSync', true);
patch('createReadStream');
// Path-taking read ops the readFile/readdir patches don't funnel through. open is flag-aware (write flags →
// write-confined). None are used by io-guard internally, so no original-capture is needed. NOTE: stat/lstat/
// access/realpath are intentionally left UNPATCHED for now — they are used during require() resolution and by
// io-guard's own metering, so guarding them risks breaking plugin loading; deferred to a separate change.
patch('open'); patch('openSync', true);
patch('opendir'); patch('opendirSync', true);
patch('readlink'); patch('readlinkSync', true);

// === fs.promises — THE SAME POLICY, NOT A SECOND ONE ===
//
// (#3, verification) io-guard patched only the callback/sync API. `fs.promises.*` stayed pristine, and
// that was not academic: the host-side bridge `wordjs.fs.write` ends in `fs.promises.writeFile`, so a
// plugin holding filesystem:write wrote STRAIGHT INTO its published surface (public/x.js, then
// assets.enqueueScript → same-origin JavaScript on every public page) while the guard was inspecting an
// API nothing on that path used. Two APIs with two policies is exactly the "the guard validates
// something other than what is used" shape this repo keeps shipping; there is now ONE policy.
//
// `require('fs/promises')` returns THIS SAME object (asserted by the tests), so patching here covers
// both specifiers. Methods and read/write semantics mirror patch() above one for one. NOTE: FileHandle
// methods obtained from open() are not wrapped — the path gate runs on the open() itself (flag-aware),
// and secure-require's proxy meters plugin-side handles.
const PROMISE_ORIGINALS: Record<string, any> = {};
function patchPromise(methodName: string): void {
    const P: any = (fs as any).promises;
    const original = P && P[methodName];
    if (typeof original !== 'function') return;
    PROMISE_ORIGINALS[methodName] = original;

    const isWrite = [
        'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'rename', 'mkdir',
        'symlink', 'truncate', 'chmod', 'lchmod', 'chown', 'lchown',
    ].includes(methodName);

    P[methodName] = function (...args: any[]) {
        // ONE resolution per call, taken FIRST — identical to the sync patch above and for the same
        // reason: with an empty ALS context getEffectivePlugin() walks the stack (~20-40 us), and every
        // fs.promises operation OF THE HOST used to pay for two of them (one inside isPathSafe, one for
        // the quota) merely to conclude "not a plugin". Monolith mode runs Next.js in this process, so
        // that was a per-request tax on the modern fs API. Host code now leaves on the first line.
        const cslug = getEffectivePlugin();
        if (!cslug) return original.apply(this, args);

        let pathsToCheck: [any, boolean][] = [[args[0], isWrite]];
        if (methodName.startsWith('copy') || methodName.startsWith('cp') || methodName.startsWith('link')) {
            pathsToCheck = [[args[0], false], [args[1], true]];
        } else if (methodName.startsWith('rename') || methodName.startsWith('symlink')) {
            pathsToCheck = [[args[0], true], [args[1], true]];
        } else if (methodName === 'open') {
            pathsToCheck = [[args[0], openFlagsAreWrite(args[1])]];
        }
        for (const [p, w] of pathsToCheck) {
            if (!p) continue;
            if (!isPathSafe(p, w, cslug)) {
                const error: any = new Error(`EACCES: Permission denied, plugin cannot access: ${p}`);
                error.code = 'EACCES';
                return Promise.reject(error);
            }
        }
        // Byte/inode accounting against the SAME rolling window the sync/callback API charges, so the
        // two APIs share one budget instead of each having half of it. THIS IS THE ONLY PLACE fs.promises
        // writes are metered: secure-require's plugin-facing proxy calls straight into these patched
        // methods, so metering there as well charged every plugin write TWICE (half the real quota) —
        // see the note in secure-require.createSecureFsPromises.
        {
            try {
                if (methodName === 'writeFile' || methodName === 'appendFile') {
                    const floor = methodName === 'writeFile' ? 4096 : 0;
                    enforceGrowQuota(cslug, Math.max(byteLenOf(args[1]), floor));
                } else if (methodName === 'truncate') {
                    enforceGrowQuota(cslug, Math.max(0, Number(args[1]) || 0));
                } else if (methodName === 'copyFile' || methodName === 'cp') {
                    let sz = 0; try { sz = fs.statSync(args[0]).size; } catch { sz = 0; }
                    enforceGrowQuota(cslug, sz);
                } else if (methodName === 'mkdir') {
                    const opts = (args[1] && typeof args[1] === 'object') ? args[1] : null;
                    enforceGrowQuota(cslug, 4096 * mkdirCreateCount(args[0], !!(opts && opts.recursive)));
                }
            } catch (error: any) {
                return Promise.reject(error);
            }
        }
        return original.apply(this, args);
    };
}

for (const m of [
    // Write ops
    'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'rename', 'mkdir', 'symlink',
    'truncate', 'chmod', 'lchmod', 'chown', 'lchown', 'copyFile', 'cp', 'link',
    // Read ops (stat/lstat/access/realpath stay unpatched, exactly as in the sync half: they are used
    // during require() resolution and by this module's own metering).
    'readFile', 'readdir', 'opendir', 'readlink', 'open',
]) patchPromise(m);

module.exports = {
    isPathSafe,
    // The RUNTIME authority for a revoked filesystem capability, exported so secure-require's fs and
    // fs.promises proxies ask the SAME question this guard asks (one definition of "the admin said no"),
    // and so a test can drive it directly. forgetDeclaredPermissions() exists because the manifest cache
    // outlives an install/update that rewrites the declaration.
    fsCapabilityRevoked,
    // The OUTSIDE-own-dir half of the same decision (declared AND granted), and the raw grant lookup.
    // secure-require consumes fsCapabilityAllowed instead of plugin-context.hasPermission so that BOTH
    // halves of the filesystem gate read the grant through the one function that knows where the answer
    // lives in each process (live map on the host, host-pushed cfg inside an isolate).
    fsCapabilityAllowed,
    fsCapabilityGranted,
    // The loader-vs-plugin carve-out, exported so secure-require's copy of the capability gate applies
    // the IDENTICAL one — otherwise a require() resolves through one fs surface and EACCESes on the other.
    isModuleLoaderRead,
    declaredPermissionsOf,
    forgetDeclaredPermissions,
    // Exported so the fs.promises proxy (secure-require) meters against the SAME per-plugin budget as the
    // callback/sync fs methods — otherwise a plugin's fs.promises writes bypass the disk quota entirely.
    enforceSingleWrite,
    enforceGrowQuota,
    byteLenOf,
    // (#3) The published-surface declaration. index.ts's /plugins handler serves EXACTLY what
    // isPluginServedRelPath() accepts, and isPathSafe() above denies the plugin writing it. Exported
    // from here (not duplicated in index.ts) so "what is public" and "what is read-only" cannot drift.
    isPluginServedRelPath,
    PLUGIN_PUBLIC_DIR,
    PLUGIN_PUBLIC_EXT,
    // The bundle sink's half of the same declaration: routes/plugin-bundles.ts serves EXACTLY these
    // names out of plugins/<folder>/dist/, and isPathSafe() denies the plugin writing any of them.
    isPluginBundleRelPath,
    PLUGIN_BUNDLE_DIR,
    PLUGIN_BUNDLE_TYPES,
    // The /themes twin: index.ts's /themes handler serves EXACTLY what isThemeServedRelPath accepts,
    // and a theme may not write anything that predicate would publish.
    isThemeServedRelPath,
    THEME_PUBLIC_EXT,
    // The publicly-served roots themselves — exported so a test can assert that no write zone is
    // inside one (the property that makes #3 a closed class rather than a fixed mount).
    SERVED_ROOTS,
    servedRootOf,
};
