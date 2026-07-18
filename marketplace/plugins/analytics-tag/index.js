/**
 * WordJS Plugin: Analytics Tag
 *
 * WordPress parity: Site Kit by Google / MonsterInsights.
 *
 * Injects a third-party analytics tag site-wide via the assets bridge. Supported providers:
 *  - GA4 (gtag.js)        — needs a G-XXXXXXXXXX measurement id
 *  - Plausible            — needs the site's bare domain
 *  - Matomo               — needs the Matomo instance https URL + numeric site id
 *
 * Cookie-consent integration: when "respectConsent" is on, the public loader waits for the
 * cookie-consent plugin's verdict (window.wjsCookieConsent / the 'wjs-consent' event) before
 * injecting the tag, and degrades to immediate injection when no consent manager is installed.
 *
 * The whole configuration is non-secret (a measurement id / domain is public by nature — it is
 * visible in the page source of any site using these tools), so it lives in a single option and
 * is served verbatim from a public endpoint the loader reads.
 */

exports.metadata = {
    name: 'Analytics Tag',
    version: '1.0.0',
    description: 'Site-wide analytics tag (GA4, Plausible or Matomo) with cookie-consent gating',
    author: 'WordJS',
};

const OPT_CONFIG = 'analytics_tag_config';
const PROVIDERS = ['ga4', 'plausible', 'matomo'];
const GA4_ID_RE = /^G-[A-Z0-9]+$/;
// Bare hostname: at least two dot-separated labels, letters/digits/hyphens, no scheme/path/port.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DIGITS_RE = /^[0-9]+$/;

const DEFAULTS = {
    enabled: false,
    provider: 'ga4',
    ga4Id: '',
    plausibleDomain: '',
    matomoUrl: '',
    matomoSiteId: '',
    respectConsent: true,
};

exports.init = async function (wordjs) {
    const { options, http, adminMenu, assets } = wordjs;

    /** Stored config merged over defaults so new fields always have a value. */
    const readConfig = async () => {
        const stored = (await options.get(OPT_CONFIG, null)) || {};
        return { ...DEFAULTS, ...stored };
    };

    /** Coerce common truthy/falsy shapes (checkbox posts, JSON booleans) to a real boolean. */
    const toBool = (value, fallback) => {
        if (value === true || value === 'true' || value === 1 || value === '1') return true;
        if (value === false || value === 'false' || value === 0 || value === '0') return false;
        return fallback;
    };

    /**
     * Validate + normalize an incoming config body against the current config.
     * Fields absent from the body keep their current value (partial updates are fine).
     * Returns { config } on success or { error } (Spanish, user-facing) on the first violation.
     */
    const validateConfig = (body, current) => {
        const provider = String(body.provider == null ? current.provider : body.provider).trim().toLowerCase();
        if (!PROVIDERS.includes(provider)) {
            return { error: 'Proveedor no válido: usa "ga4", "plausible" o "matomo".' };
        }

        const ga4Id = String(body.ga4Id == null ? current.ga4Id : body.ga4Id).trim().toUpperCase();
        if (ga4Id && !GA4_ID_RE.test(ga4Id)) {
            return { error: 'El ID de medición de GA4 debe tener el formato G-XXXXXXXXXX.' };
        }

        const plausibleDomain = String(body.plausibleDomain == null ? current.plausibleDomain : body.plausibleDomain).trim().toLowerCase();
        if (plausibleDomain && !HOSTNAME_RE.test(plausibleDomain)) {
            return { error: 'El dominio de Plausible debe ser un nombre de host simple, p. ej. midominio.com (sin https:// ni rutas).' };
        }

        let matomoUrl = String(body.matomoUrl == null ? current.matomoUrl : body.matomoUrl).trim();
        if (matomoUrl) {
            let parsed = null;
            try { parsed = new URL(matomoUrl); } catch (e) { parsed = null; }
            if (!parsed || parsed.protocol !== 'https:') {
                return { error: 'La URL de Matomo debe ser una URL https:// válida, p. ej. https://analitica.midominio.com.' };
            }
            matomoUrl = matomoUrl.replace(/\/+$/, ''); // the loader appends /matomo.js itself
        }

        const matomoSiteId = String(body.matomoSiteId == null ? current.matomoSiteId : body.matomoSiteId).trim();
        if (matomoSiteId && !DIGITS_RE.test(matomoSiteId)) {
            return { error: 'El ID de sitio de Matomo debe contener solo dígitos.' };
        }

        return {
            config: {
                enabled: toBool(body.enabled, current.enabled),
                provider,
                ga4Id,
                plausibleDomain,
                matomoUrl,
                matomoSiteId,
                respectConsent: toBool(body.respectConsent, current.respectConsent),
            },
        };
    };

    // ---- routes ---------------------------------------------------------------------------------
    // PUBLIC — read by public/loader.js on every public page view. Contains nothing secret.
    http.route('get', '/public/config', async (req, res) => {
        res.json(await readConfig());
    });

    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        res.json(await readConfig());
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        const current = await readConfig();
        const result = validateConfig(req.body || {}, current);
        if (result.error) {
            res.status(400).json({ error: result.error });
            return;
        }
        await options.set(OPT_CONFIG, result.config);
        res.json(result.config);
    });

    // ---- public loader asset ----------------------------------------------------------------------
    // Idempotent upsert by handle — safe to call on every init. Wrapped so the plugin still boots
    // (admin page + routes) when the assets grant has not been given yet.
    try {
        await assets.enqueueScript({ handle: 'analytics-tag-loader', src: 'public/loader.js', strategy: 'defer' });
    } catch (e) {
        console.warn('[analytics-tag] could not enqueue the loader script (missing assets grant?): ' + (e && e.message ? e.message : e));
    }

    adminMenu.add({
        href: '/admin/plugin/tracking',
        label: 'Analytics',
        icon: 'fa-chart-simple',
        order: 65,
        cap: 'manage_options',
    });

    console.log('[analytics-tag] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers or servers; the host stops serving the enqueued
    // asset when the plugin is deactivated.
};
