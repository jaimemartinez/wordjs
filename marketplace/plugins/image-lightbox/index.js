/**
 * WordJS Plugin: Image Lightbox
 *
 * Site-wide click-to-zoom lightbox for content images, delivered through the assets bridge:
 * public/lightbox.js + public/lightbox.css are enqueued on every public page while the plugin
 * is active. Zero-config by default — the script fetches its config from the public endpoint
 * and does nothing when disabled.
 *
 * Config lives in ONE option ('image_lightbox_config'):
 *   { enabled: boolean, captions: boolean, scope: string }
 * 'scope' is the CSS selector for content areas (default '.wjs-content' — the theme framework
 * wraps public content in it; the browser script falls back to 'main' when the selector matches
 * nothing on the page). Nothing here is a secret, so options are the right home — no database.
 */

exports.metadata = {
    name: 'Image Lightbox',
    version: '1.0.0',
    description: 'Click-to-zoom lightbox for content images (dark overlay, captions, prev/next, keyboard)',
    author: 'WordJS',
};

const OPT_CONFIG = 'image_lightbox_config';
const DEFAULT_CONFIG = { enabled: true, captions: true, scope: '.wjs-content' };
const MAX_SCOPE_LEN = 100;

/** Normalize whatever is stored into a well-formed config object (self-healing reads). */
function normalizeConfig(raw) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const scope = typeof cfg.scope === 'string' ? cfg.scope.trim() : '';
    const scopeOk = scope.length > 0 && scope.length <= MAX_SCOPE_LEN && scope.indexOf('<') === -1;
    return {
        enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : DEFAULT_CONFIG.enabled,
        captions: typeof cfg.captions === 'boolean' ? cfg.captions : DEFAULT_CONFIG.captions,
        scope: scopeOk ? scope : DEFAULT_CONFIG.scope,
    };
}

exports.init = async function (wordjs) {
    const { options, http, adminMenu, assets } = wordjs;

    const readConfig = async () => normalizeConfig(await options.get(OPT_CONFIG, null));

    // ---- routes -----------------------------------------------------------------------------------
    // PUBLIC config — public/lightbox.js fetches this on every public page load.
    http.route('get', '/public/config', async (req, res) => {
        res.json(await readConfig());
    });

    // Admin: read the current config.
    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        res.json(await readConfig());
    });

    // Admin: save the config (strict validation — booleans + a bounded, tag-free selector).
    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        if (typeof body.enabled !== 'boolean' || typeof body.captions !== 'boolean') {
            return res.status(400).json({ error: 'Los campos "enabled" y "captions" deben ser booleanos.' });
        }
        const scope = typeof body.scope === 'string' ? body.scope.trim() : '';
        if (!scope) {
            return res.status(400).json({ error: 'El selector de ámbito no puede estar vacío.' });
        }
        if (scope.length > MAX_SCOPE_LEN) {
            return res.status(400).json({ error: 'El selector de ámbito no puede superar los ' + MAX_SCOPE_LEN + ' caracteres.' });
        }
        if (scope.indexOf('<') !== -1) {
            return res.status(400).json({ error: 'El selector de ámbito no puede contener el carácter "<".' });
        }
        const config = { enabled: body.enabled, captions: body.captions, scope };
        await options.set(OPT_CONFIG, config);
        res.json(config);
    });

    // ---- admin sidebar ----------------------------------------------------------------------------
    adminMenu.add({
        href: '/admin/plugin/lightbox',
        label: 'Lightbox de imágenes',
        icon: 'fa-expand',
        order: 66,
        cap: 'manage_options',
    });

    // ---- public assets ----------------------------------------------------------------------------
    // Idempotent (upsert by handle) — enqueued on every init. The plugin must still boot when the
    // assets grant is missing, so a failure only warns.
    try {
        await assets.enqueueScript({ handle: 'image-lightbox', src: 'public/lightbox.js', strategy: 'defer' });
        await assets.enqueueStyle({ handle: 'image-lightbox-style', src: 'public/lightbox.css' });
    } catch (e) {
        console.warn('[image-lightbox] could not enqueue public assets (missing assets grant?): ' + (e && e.message ? e.message : e));
    }

    console.log('[image-lightbox] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers, no servers; assets stop rendering when the plugin deactivates.
};
