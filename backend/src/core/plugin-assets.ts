/**
 * WordJS — structured frontend-asset enqueue for plugins.
 *
 * The raw-HTML head/footer hooks (wordjs_head/footer) are HARD-DENIED to every plugin (a stored-XSS
 * primitive), which left a plugin no safe way to load client JS/CSS on the live site — killing an
 * entire class (analytics tag, cookie banner, custom web-component block, lightbox). This gives a
 * STRUCTURED path instead: a plugin declares a { handle, src } where src is a path INSIDE its own
 * dir; the host validates it exists + can't escape, stores only validated fields, and the public
 * Next layout emits sanitized <script src>/<link rel=stylesheet> — the plugin never controls markup.
 * Assets are served from the existing /plugins/<slug>/ static mount.
 */

const path = require('path');
const fs = require('fs');
const { getOption, updateOption } = require('./options');
const { runWithContext } = require('./plugin-context');

const OPT = 'plugin_assets';

// The enqueue bridge runs host-side but INSIDE the calling plugin's ALS context (the 'call' handler
// wraps callApi in runWithContext(slug)). getOption/updateOption are permission-gated on that context
// (settings:read/write), so storing the plugin's OWN asset registry would wrongly demand a settings
// grant. This registry is host-owned bookkeeping, not the plugin's settings — run the option access
// as the HOST (runWithContext(null) clears the plugin context; this core file adds no plugin stack frame).
const asHost = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(null, fn);

// Turn a plugin-relative asset path into its public /plugins/<slug>/ URL, rejecting anything that is
// not a plain relative path inside the plugin dir (no scheme/URL, no protocol-relative, no '..').
//
// (#3) The path must ALSO land on the surface the host actually publishes — plugins/<slug>/public/
// with a servable extension (core/io-guard.isPluginServedRelPath, the one declaration index.ts's
// /plugins handler serves from). Before this, `src` could name ANY file in the plugin dir; since a
// plugin may write its own dir with no grant, enqueuing e.g. 'cache/out.css' and then overwriting
// that file at runtime was a write→HTTP-read exfiltration channel that the network permission, the
// egress allowlist and bwrap's --unshare-net all fail to see. public/ is denied to the plugin's own
// writes by io-guard, so confining the registry to it is what makes the enqueue bridge safe. Every
// shipped plugin already enqueues from public/ (marketplace: cookie-consent, image-lightbox,
// notification-bar, popup-builder, analytics-tag), so this is the shape the real producer emits.
function pluginPublicUrl(slug: string, relPath: any): string {
    const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//') || clean.split('/').includes('..')) {
        throw new Error(`Invalid asset src "${relPath}" — must be a relative path inside your plugin (no URLs, no '..').`);
    }
    const { isPluginServedRelPath, PLUGIN_PUBLIC_DIR, PLUGIN_PUBLIC_EXT } = require('./io-guard');
    if (!isPluginServedRelPath(clean) || clean.split('/')[0] !== PLUGIN_PUBLIC_DIR) {
        throw new Error(
            `Invalid asset src "${relPath}" — enqueued assets must live in your plugin's "${PLUGIN_PUBLIC_DIR}/" `
            + `directory and use one of: ${Array.from(PLUGIN_PUBLIC_EXT).join(', ')}. `
            + `Nothing outside that directory is served over HTTP.`
        );
    }
    const { PLUGINS_DIR } = require('./plugins');
    const base = path.resolve(PLUGINS_DIR, slug);
    const abs = path.resolve(base, clean);
    if (!(abs === base || abs.startsWith(base + path.sep))) throw new Error('Asset path escapes the plugin directory.');
    if (!fs.existsSync(abs)) throw new Error(`Asset not found in plugin: ${clean}`);
    return `/plugins/${slug}/${clean}`;
}

/** Register (or replace, by handle) a script/style for a plugin. */
async function enqueue(slug: string, kind: 'script' | 'style', spec: any): Promise<{ success: true; src: string }> {
    spec = spec || {};
    const handle = String(spec.handle || '').trim();
    if (!handle) throw new Error('enqueue requires a { handle } string.');
    const url = pluginPublicUrl(slug, spec.src);
    const entry = kind === 'style'
        ? { kind: 'style', handle, src: url, media: typeof spec.media === 'string' ? spec.media.slice(0, 64) : 'all' }
        : { kind: 'script', handle, src: url, inFooter: !!spec.inFooter, strategy: (spec.strategy === 'async' || spec.strategy === 'defer') ? spec.strategy : '' };
    await asHost(async () => {
        const store = (await getOption(OPT, {})) || {};
        const list = Array.isArray(store[slug]) ? store[slug] : [];
        // Upsert by (kind, handle) so a reload's re-enqueue never duplicates.
        const next = list.filter((e: any) => !(e.kind === entry.kind && e.handle === handle));
        next.push(entry);
        store[slug] = next;
        await updateOption(OPT, store);
    });
    return { success: true, src: url };
}

/** Drop all of a plugin's enqueued assets (on uninstall). */
async function clearAssets(slug: string): Promise<void> {
    await asHost(async () => {
        const store = (await getOption(OPT, {})) || {};
        if (Object.prototype.hasOwnProperty.call(store, slug)) { delete store[slug]; await updateOption(OPT, store); }
    });
}

/** Flat asset lists for ACTIVE plugins only (a deactivated plugin's stale entries never render). */
async function getActiveAssets(): Promise<{ scripts: any[]; styles: any[] }> {
    const store = (await asHost(() => getOption(OPT, {}))) || {};
    const { getActivePlugins } = require('./plugins');
    const active = new Set(await getActivePlugins());
    const { isPluginServedRelPath } = require('./io-guard');
    const scripts: any[] = [], styles: any[] = [];
    for (const [slug, list] of Object.entries(store)) {
        if (!active.has(slug) || !Array.isArray(list)) continue;
        for (const e of list as any[]) {
            // (#3) Re-check the STORED url against the published surface on the way out, not only on
            // the way in: entries registered before the public/ rule existed (or by any other writer
            // of this option) would otherwise still be emitted as <script src>/<link href> pointing at
            // a path the /plugins handler now 404s — a broken page instead of an honest omission.
            const prefix = `/plugins/${slug}/`;
            if (typeof e.src !== 'string' || !e.src.startsWith(prefix)) continue;
            if (!isPluginServedRelPath(e.src.slice(prefix.length))) continue;
            if (e.kind === 'style') styles.push({ handle: `${slug}:${e.handle}`, src: e.src, media: e.media || 'all' });
            else scripts.push({ handle: `${slug}:${e.handle}`, src: e.src, inFooter: !!e.inFooter, strategy: e.strategy || '' });
        }
    }
    return { scripts, styles };
}

module.exports = { enqueue, clearAssets, getActiveAssets };
