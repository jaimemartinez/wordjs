/**
 * WordJS — WHOSE FILES THE HOST HANDS OUT TO ANYONE WHO ASKS.
 *
 * Two sinks serve a plugin's files over HTTP without asking who is calling:
 *   · the static /plugins mount in index.ts — plugins/<folder>/public/** and dist/component.bundle.css;
 *   · the bundle routes in routes/plugin-bundles.ts — dist/{admin,component,hooks}.bundle.{js,css} and
 *     dist/manifest.build.json.
 * core/io-guard decides which PATHS of a plugin may be published. This module decides which PLUGINS:
 * a path on the allowlist is still a 404 unless the plugin it belongs to is ACTIVE, and build output
 * (dist/) additionally needs the administrator's browser:script grant. Both sinks call these two
 * predicates instead of each stating the rule, so they cannot disagree.
 *
 * WHY ACTIVE. Serving the files of every INSTALLED plugin made the install itself public: probing
 * /plugins/<slug>/... told an anonymous caller which plugins sit on disk, deactivated ones included, and
 * a plugin that was deactivated because it is vulnerable kept advertising itself. Which plugins are
 * ACTIVE is public by design (GET /api/v1/plugins/active and /registry exist so the public site can
 * load Verso blocks), so gating on it closes the oracle without withholding anything a visitor's
 * browser legitimately needs. A refusal must therefore look exactly like a missing file — callers
 * answer the same bare 404 for both.
 *
 * Every read goes through the module objects at call time (not destructured at load): the live grant
 * store and the live active list decide, so a deactivation or a revoke takes effect on the very next
 * request — and a test can state either fact in memory.
 */

/**
 * May the files of plugin `folder` be served at all? Only while it is active. (A plugin's slug IS its
 * folder name: the active list stores folders, and every sink addresses plugins by folder.)
 */
async function pluginFilesServable(folder: string): Promise<boolean> {
    const { isPluginActive } = require('./plugins');
    return !!(await isPluginActive(folder));
}

/**
 * MAY THIS PLUGIN'S BROWSER BUILD OUTPUT BE SERVED? Only while the plugin is ACTIVE and the administrator
 * has GRANTED it `browser:script`.
 *
 * What the bundle routes serve is executed, not displayed: the admin SPA import()s these bundles into its
 * own origin — every active plugin's hooks bundle on EVERY admin page load — so they run with the
 * viewer's session, an administrator's on the admin screens. They are build output the plugin author
 * controls and the AST scanner never reads. These routes used to hand them out for ANY installed plugin,
 * active or not, to anyone, which made "install a plugin" equivalent to "let it act as every
 * administrator who opens the admin", whatever permissions it had been granted. The capability is now
 * explicit and default-deny (core/plugins.ts BROWSER_SCRIPT_TOKEN): a plugin's code reaches a browser
 * only if the administrator approved exactly that, and revoking the switch stops it at the next page
 * load.
 *
 * The same answer gates everything else in dist/ — the bundle stylesheets (also the static
 * /plugins/<folder>/dist/component.bundle.css) and the build manifest: they belong to the same bundle,
 * and serving them for a plugin whose code is withheld would only tell an anonymous caller what is
 * installed.
 *
 * BOTH facts are always evaluated, grant first or not: answering "not granted" without reading the
 * active list would make an installed-and-granted-but-inactive plugin measurably slower to refuse than a
 * slug that was never installed (grants outlive deactivation). The read is one cached option — cheap
 * enough to spend on every refusal.
 *
 * Granted code runs in the admin's origin with the viewer's session: that is what the administrator
 * approves when granting browser:script, and what the permissions dialog says.
 */
async function browserCodeServable(folder: string): Promise<boolean> {
    const { isGranted } = require('./plugin-permissions');
    const granted = !!isGranted(folder, 'browser', 'script');
    const active = await pluginFilesServable(folder);
    return granted && active;
}

module.exports = { pluginFilesServable, browserCodeServable };
