/**
 * WordJS Plugin: Notification Bar
 *
 * A slim site-wide announcement bar (top or bottom) injected on public pages through the
 * assets bridge (public/bar.js + public/bar.css). The bar shows a message plus an optional
 * CTA link, can be dismissed (persisted in localStorage keyed by a config "version" so the
 * admin can re-show it to everyone who closed it by bumping the version), and supports an
 * optional schedule window (starts_at / ends_at).
 *
 * All state lives in ONE option ('notification_bar_config') — no database tables.
 */

exports.metadata = {
    name: 'Notification Bar',
    version: '1.0.0',
    description: 'Site-wide announcement bar with CTA link, dismissal and scheduling',
    author: 'WordJS',
};

const OPT_CONFIG = 'notification_bar_config';

const MESSAGE_MAX = 300;
const LABEL_MAX = 60;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const POSITIONS = ['top', 'bottom'];

const DEFAULT_CONFIG = {
    enabled: false,
    message: '',
    linkLabel: '',
    linkUrl: '',
    bgColor: '#111827',
    textColor: '#ffffff',
    position: 'top',
    dismissible: true,
    starts_at: '',
    ends_at: '',
    version: 1,
};

/** Merge whatever is stored with the defaults so every consumer sees a complete, typed shape. */
const normalizeConfig = (raw) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const cfg = { ...DEFAULT_CONFIG };
    if (typeof src.enabled === 'boolean') cfg.enabled = src.enabled;
    if (typeof src.message === 'string') cfg.message = src.message;
    if (typeof src.linkLabel === 'string') cfg.linkLabel = src.linkLabel;
    // Re-validate on READ too: options are a global namespace, so another settings:write plugin
    // could plant a javascript: URL here without going through our POST /config validation.
    if (typeof src.linkUrl === 'string' && isValidUrl(src.linkUrl.trim())) cfg.linkUrl = src.linkUrl.trim();
    if (typeof src.bgColor === 'string' && HEX_COLOR_RE.test(src.bgColor)) cfg.bgColor = src.bgColor;
    if (typeof src.textColor === 'string' && HEX_COLOR_RE.test(src.textColor)) cfg.textColor = src.textColor;
    if (POSITIONS.indexOf(src.position) !== -1) cfg.position = src.position;
    if (typeof src.dismissible === 'boolean') cfg.dismissible = src.dismissible;
    if (typeof src.starts_at === 'string') cfg.starts_at = src.starts_at;
    if (typeof src.ends_at === 'string') cfg.ends_at = src.ends_at;
    const v = parseInt(src.version, 10);
    if (Number.isFinite(v) && v >= 1) cfg.version = v;
    return cfg;
};

/**
 * Empty, http(s), or origin-relative ('/path'). Rejects protocol-relative '//host' AND its
 * backslash twin '/\host' (WHATWG URL parsing treats backslashes as slashes for special schemes,
 * so '/\evil.com' would navigate off-origin).
 */
const isValidUrl = (url) => {
    if (url === '') return true;
    if (/^https?:\/\//i.test(url)) return true;
    if (url.charAt(0) === '/' && url.charAt(1) !== '/' && url.charAt(1) !== '\\') return true;
    return false;
};

const isValidDate = (value) => value === '' || !Number.isNaN(Date.parse(value));

/**
 * Validate an admin save. Returns { errors, config } — Spanish user-facing messages; config
 * is only meaningful when errors is empty. `current` supplies the version to (maybe) bump:
 * body.reprompt === true increments it so previous dismissals stop matching.
 */
const validateSave = (body, current) => {
    const b = body && typeof body === 'object' ? body : {};
    const errors = [];

    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (message.length > MESSAGE_MAX) {
        errors.push('El mensaje no puede superar los ' + MESSAGE_MAX + ' caracteres.');
    }

    const linkLabel = typeof b.linkLabel === 'string' ? b.linkLabel.trim() : '';
    if (linkLabel.length > LABEL_MAX) {
        errors.push('La etiqueta del enlace no puede superar los ' + LABEL_MAX + ' caracteres.');
    }

    const linkUrl = typeof b.linkUrl === 'string' ? b.linkUrl.trim() : '';
    if (!isValidUrl(linkUrl)) {
        errors.push('La URL del enlace debe empezar por http(s):// o ser una ruta relativa (/pagina), o quedar vacía.');
    }

    const bgColor = typeof b.bgColor === 'string' ? b.bgColor.trim() : '';
    if (!HEX_COLOR_RE.test(bgColor)) {
        errors.push('El color de fondo debe tener formato hexadecimal #RRGGBB.');
    }

    const textColor = typeof b.textColor === 'string' ? b.textColor.trim() : '';
    if (!HEX_COLOR_RE.test(textColor)) {
        errors.push('El color del texto debe tener formato hexadecimal #RRGGBB.');
    }

    const position = b.position;
    if (POSITIONS.indexOf(position) === -1) {
        errors.push('La posición debe ser "top" (superior) o "bottom" (inferior).');
    }

    const starts_at = typeof b.starts_at === 'string' ? b.starts_at.trim() : '';
    if (!isValidDate(starts_at)) {
        errors.push('La fecha de inicio no es válida.');
    }

    const ends_at = typeof b.ends_at === 'string' ? b.ends_at.trim() : '';
    if (!isValidDate(ends_at)) {
        errors.push('La fecha de fin no es válida.');
    }

    if (starts_at && ends_at && isValidDate(starts_at) && isValidDate(ends_at)
        && Date.parse(starts_at) > Date.parse(ends_at)) {
        errors.push('La fecha de inicio no puede ser posterior a la fecha de fin.');
    }

    const config = {
        enabled: b.enabled === true,
        message,
        linkLabel,
        linkUrl,
        bgColor,
        textColor,
        position: POSITIONS.indexOf(position) !== -1 ? position : DEFAULT_CONFIG.position,
        dismissible: b.dismissible === true,
        starts_at,
        ends_at,
        version: current.version + (b.reprompt === true ? 1 : 0),
    };
    return { errors, config };
};

exports.init = async function (wordjs) {
    const { options, http, adminMenu, assets } = wordjs;

    const readConfig = async () => normalizeConfig(await options.get(OPT_CONFIG, null));

    // ---- routes ---------------------------------------------------------------------------------
    // PUBLIC config — consumed by public/bar.js on every public page (and harmless to expose:
    // it contains exactly what the bar renders). All checks (enabled, schedule window,
    // dismissal version) run client-side so this stays a plain cached-options read.
    http.route('get', '/public/config', async (req, res) => {
        res.json(await readConfig());
    });

    // Admin: current config for the settings form.
    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        res.json(await readConfig());
    });

    // Admin: validate + save. body.reprompt === true bumps the version so visitors who
    // dismissed an earlier version see the bar again.
    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        const current = await readConfig();
        const result = validateSave(req.body, current);
        if (result.errors.length) {
            return res.status(400).json({
                error: result.errors.join(' '),
                message: result.errors.join(' '),
                errors: result.errors,
            });
        }
        await options.set(OPT_CONFIG, result.config);
        res.json(result.config);
    });

    // ---- public assets --------------------------------------------------------------------------
    // Idempotent (upsert by handle); the plugin must still boot when the grant is missing.
    try {
        await assets.enqueueStyle({ handle: 'notification-bar', src: 'public/bar.css' });
        await assets.enqueueScript({ handle: 'notification-bar', src: 'public/bar.js', strategy: 'defer' });
    } catch (e) {
        console.warn('[notification-bar] could not enqueue public assets (missing assets grant?):', e && e.message ? e.message : e);
    }

    // ---- admin menu -----------------------------------------------------------------------------
    try {
        await adminMenu.add({
            href: '/admin/plugin/announcement',
            label: 'Barra de Anuncios',
            icon: 'fa-bullhorn',
            order: 68,
            cap: 'manage_options',
        });
    } catch (e) {
        console.warn('[notification-bar] could not register the admin menu entry:', e && e.message ? e.message : e);
    }

    console.log('[notification-bar] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers or servers; enqueued assets stop rendering while inactive.
};
