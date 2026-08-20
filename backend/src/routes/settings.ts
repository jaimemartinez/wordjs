/**
 * WordJS - Settings Routes
 * /api/v1/settings/*
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { getOption, updateOption } = require('../core/options');
const { getActiveThemeVersion, isActiveThemeMissing } = require('../core/themes');
// Plugin-sandbox hardening state, surfaced to admins (see DERIVED_ADMIN_SETTINGS below). Required lazily
// inside the compute functions so a load error there can never break the settings route at import time.
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { recordAudit } = require('../core/audit');

/**
 * @swagger
 * tags:
 *   name: Settings
 *   description: Site configuration
 */

// Public settings that can be viewed without authentication
const PUBLIC_SETTINGS = [
    'blogname',
    'blogdescription',
    'siteurl',
    'home',
    'timezone_string',
    'date_format',
    'time_format',
    'start_of_week',
    'posts_per_page',
    'site_logo',
    'homepage_id',
    'footer_text',
    'footer_copyright',
    'footer_socials',
    'comments_enabled',
    'site_icon',
    'template',             // active theme SLUG (getActiveTheme) — lets the SSR public layout render
                            // the theme stylesheet <link> on first paint (no FOUC). Already public:
                            // the slug is visible in the /themes/<slug>/style.css URL anyway.
    'active_theme_layout',  // active theme's structure config (JSON) for the SSR public layout
    'active_theme_mods',    // active theme's live token overrides (JSON) from the customizer
    'site_chrome_header',   // site-level composable chrome (JSON, contract v1) — the SSR public
    'site_chrome_footer',   //   layout renders these; written ONLY via PUT /api/v1/chrome/:part
    'site_chrome_announcement', // optional top/announcement bar, full-bleed above the header
    'wjs_ix_presets',       // preajustes de interacción del sitio (JSON, motor F9). PÚBLICO porque
                            // el renderer del sitio los necesita para compilar el CSS de la página
                            // en el servidor. No son secreto: describen movimiento, y su efecto ya
                            // es visible en la hoja emitida. Un bloque guarda solo el ID del
                            // preajuste, así que editarlos NO toca un byte de `_puck_data`.
    'wjs_view_transitions',  // transiciones entre páginas (C1): 'off' | 'fade' | 'slide'. PÚBLICO
    'wjs_motion',            // política de movimiento del sitio (C5): 'full' | 'calm' | 'off'. PÚBLICO
                             // porque el layout público emite su CSS en el servidor, y la variante
                             // entre documentos exige la regla en AMBOS documentos. No es secreto:
                             // describe movimiento y su efecto ya se ve en la hoja emitida.
    'users_can_register',
    // 'admin_email' - SECURITY: Removed from public to prevent email harvesting
    'default_role',
    'comment_registration',
    'WPLANG',               // site locale — drives <html lang> (and the RSS <language>, see routes/seo)
    'site_text_direction'   // explicit <html dir> override: '' (derive from WPLANG) | ltr | rtl | auto
];

// All settings that can be modified
const ALL_SETTINGS = [
    ...PUBLIC_SETTINGS,
    'admin_email', // SECURITY: Admin-only access
    'default_category',
    'default_post_format',
    'show_on_front',
    'page_on_front',
    'page_for_posts',
    'blog_public',
    'default_pingback_flag',
    'default_ping_status',
    'default_comment_status',
    'comments_notify',
    'moderation_notify',
    'comment_moderation',
    'require_name_email',
    'comment_previously_approved',
    'comment_max_links',
    'permalink_structure',
    'thumbnail_size_w',
    'thumbnail_size_h',
    'medium_size_w',
    'medium_size_h',
    'large_size_w',
    'large_size_h',
    'backup_schedule', // Backup Scheduler Frequency
    'backup_time',     // Backup Time of Day (HH:mm)
    'backup_day',      // Backup Day (0-6)
    // Opt-in email verification on self-registration (FRENTE C-3). '1' requires a newly self-registered
    // user to confirm their email via a tokenized link before they can log in; the auth layer fails this
    // CLOSED (treats it as OFF) when no mail provider can deliver. Admin-only (not in PUBLIC_SETTINGS).
    'require_email_verification',
    // Interruptor maestro de la caché de objetos en Redis. Estaba SEEDEADO (core/options seedDefaults),
    // se APLICA solo al escribirlo (updateOption → cache.setEnabled), se relee en cada arranque
    // (initCacheSetting) y en cada nodo del clúster (core/coherence), y la pantalla de ajustes pinta un
    // interruptor de verdad para él… pero no estaba en esta lista, así que GET /settings/all no lo
    // devolvía y PUT lo descartaba en silencio: el interruptor no hacía nada en NINGUNA de las dos
    // direcciones, y encima se pintaba siempre apagado aunque la caché estuviera encendida.
    //
    // ADMIN-ONLY a propósito (fuera de PUBLIC_SETTINGS): si hay una caché compartida delante del sitio
    // es postura de infraestructura, del mismo tipo que sandbox_hardening_* — no lo necesita ningún
    // render público, y contárselo a un visitante anónimo solo ayuda a quien mide la caché desde fuera.
    // Tampoco es DERIVED: es un valor ALMACENADO, y el estado en memoria se deriva de él, no al revés.
    'redis_cache_enabled'
];

// Publicly readable, but NOT writable through the generic settings writers: these have a
// dedicated API that validates before storing (chrome-validate is the write authority for
// site_chrome_* — see routes/chrome.ts). Writing them here would bypass that validation.
// 'template'/'stylesheet' name the ACTIVE THEME, and switching one is far more than an option write:
// switchTheme also republishes the new theme's `layout`, clears the previous theme's customizer mods,
// re-initializes the theme engine (which retires the outgoing theme's isolated functions.js child) and
// fires the switch_theme hook that purges the frontend. Written through here the option moved alone —
// the site then served the new theme's CSS with the old theme's structure and token overrides, and the
// replaced theme's code kept running. Their dedicated API is POST /themes/:slug/activate.
// 'active_theme_layout' is DERIVED: switchTheme publishes the active theme.json's `layout` block, and
// nothing reconciles a value written by hand — the site would render a structure the theme never
// declared, until the next activation silently replaced it. ('active_theme_mods' is deliberately NOT
// here: the customizer saves through this very API, and the overlay sanitizes it at render time.)
const DEDICATED_WRITE_API = new Set([
    'site_chrome_header', 'site_chrome_footer', 'site_chrome_announcement',
    'template', 'stylesheet', 'active_theme_layout',
]);

// Public settings that are DERIVED, not stored. Computed per request from the memoized theme scan
// (core/themes), so they add no SQL and no fs to the read path — and deliberately absent from
// ALL_SETTINGS, because an option row for one of these could only ever drift from the theme on disk.
//
// A MAP, not an object literal (SECURITY / CodeQL #611, js/unvalidated-dynamic-method-call). The key
// arrives from the URL (`GET /settings/:key`) and selects a FUNCTION TO CALL — it chooses STRUCTURE,
// not a value. An object indexed by an outside string is one prototype hop away from dispatching
// `constructor` / `toString` / `valueOf`, and `__proto__` is a live accessor on every object literal;
// a hasOwnProperty guard closes today's hole but leaves the dangerous SHAPE (an external string
// indexing an object) in place for the next edit to reopen. A Map has no prototype chain to walk and
// no property access at all: `.get()` can only ever return something `.set()` put there.
const DERIVED_PUBLIC_SETTINGS: Map<string, () => Promise<any>> = new Map(Object.entries({
    // theme.json `version` of the ACTIVE theme. The frontend appends it to the theme stylesheet URL
    // so an in-place theme edit (PUT /api/v1/themes/:slug bumps the patch) busts the browser/CDN
    // copy — the build-time asset version cannot see that edit. That route purges the 'settings' tag.
    active_theme_version: getActiveThemeVersion,
    // TRUE when the `template` option names a theme that is not on disk. The site keeps rendering —
    // the framework's own :root tokens in public/css/wordjs-ui.css are the floor, and that fallback is
    // correct — but nothing used to SAY so, so a deleted or renamed theme looked like a styling bug.
    // Consumed by the admin themes screen (frontend/src/app/admin/themes/page.tsx), which renders a
    // banner naming the missing slug, and mirrored by a boot-time warning in index.ts.
    // Boolean, not a string: `Boolean("false")` is true, and a health flag that reads backwards when
    // stringified is worse than no flag. Derived, so it can never drift from the directory on disk.
    active_theme_missing: isActiveThemeMissing
}));

// Admin-ONLY derived settings: computed per request, never stored, and returned only from GET
// /settings/all (behind authenticate + isAdmin). Same shape as DERIVED_PUBLIC_SETTINGS, but deliberately
// NOT public — the plugin-sandbox hardening posture is a security-internal signal (telling an anonymous
// visitor "this host's OS backstop is off" only helps an attacker), so it rides the admin payload the
// audit's item 6 asks for, mirroring the active_theme_missing derived-boolean pattern.
//
// State is read from core/plugin-isolate (populated by the boot-time probe, or lazily on first isolate
// load). 'unknown' until the probe resolves; 'degraded' is the dangerous "looks secure but isn't" state.
// Same Map discipline as DERIVED_PUBLIC_SETTINGS above (this one is only ever enumerated, never
// indexed by an outside key — keeping the two the same shape is what stops a future single-key admin
// route from reintroducing the object-indexing pattern).
const DERIVED_ADMIN_SETTINGS: Map<string, () => Promise<any>> = new Map(Object.entries({
    // Raw hardening state enum: 'unknown' | 'unsupported' | 'disabled' | 'active' | 'degraded'.
    sandbox_hardening_state: async () => {
        try { return require('../core/plugin-isolate').getSandboxHardeningState(); } catch { return 'unknown'; }
    },
    // Derived BOOLEAN (not a string — `Boolean("false")` is true): TRUE only when hardening is 'degraded',
    // i.e. the native sandbox probe failed and plugins run without that OS backstop.
    sandbox_hardening_degraded: async () => {
        try { return require('../core/plugin-isolate').isSandboxHardeningDegraded() === true; } catch { return false; }
    },
    // Derived BOOLEAN: TRUE only while a mail-PROVIDER plugin has registered a host-wide send function
    // (email:provider capability → global.wordjs_send_mail). The core cannot send email itself, so when
    // this is FALSE password recovery fails closed and silently — a fresh install with no mail plugin has
    // NO self-service password reset. Surfacing it here lets the admin UI say so instead of leaving a
    // dead "Forgot password?" flow. Live/fail-closed: the host deletes the global when the provider
    // unloads. Mirrors the active_theme_missing / sandbox_hardening_degraded derived-boolean pattern.
    email_provider_available: async () => {
        try { return require('../core/mail-provider').isEmailProviderAvailable() === true; } catch { return false; }
    }
}));

/**
 * Resolve a URL-supplied key to a derived-setting COMPUTE FUNCTION, or null.
 *
 * The allowlist IS the Map: `.get()` on a Map never consults a prototype, so `constructor`,
 * `__proto__`, `toString`, `valueOf` and every other inherited member resolve to undefined instead of
 * to a callable. `?? null` normalizes the miss, and the `typeof === 'function'` assertion is the last
 * word: only something this module put in the Map is ever invoked.
 */
const derivedSetting = (key: string): (() => Promise<any>) | null => {
    const compute = DERIVED_PUBLIC_SETTINGS.get(key);
    return typeof compute === 'function' ? compute : null;
};

// ---------------------------------------------------------------------------
// Per-key write validation
// ---------------------------------------------------------------------------
// Most options are free text that only ever renders as TEXT. These two do not: they are written
// verbatim into the `lang` and `dir` ATTRIBUTES of <html>, i.e. they choose document structure
// rather than content. So they are validated here, at the write, against a closed shape — the same
// posture as chrome-validate and template-validate, and a second independent gate in front of the
// frontend's own fail-closed resolver (frontend/src/lib/documentLanguage.ts). A key with no entry
// here keeps its existing unvalidated behaviour; adding one is opt-in and fail-closed.
//
// `site_text_direction` admits '' as the DERIVE sentinel: no override, take the direction from the
// locale. The three real values are exactly HTML's `dir` enum.
const TEXT_DIRECTIONS = ['', 'ltr', 'rtl', 'auto'];
// Transiciones entre páginas: el espejo EXACTO de IX_VT_STYLES en el frontend, más '' (= apagado).
// Si un día crece la lista, crece en los dos sitios — el frontend manda, este gate solo cierra.
/** Política de movimiento del sitio (C5). '' = sin ajuste = 'full'. */
const MOTION_POLICIES = ['', 'full', 'calm', 'off'];

const VIEW_TRANSITION_STYLES = ['', 'off', 'fade', 'slide'];
// language [ - script ] [ - region ]. Underscore form ('es_ES') is what the WPLANG option has
// always used (locale files are named by it), so it is accepted and normalized to a
// BCP 47 tag on READ by whoever renders it — core/language-tag for the RSS <language>, the frontend
// resolver for <html lang>. Both hyphenate; neither rewrites the stored value. Deliberately
// narrower than full BCP 47: extensions/variants/private-use have no consumer here and every
// character admitted ends up in an attribute.
const LOCALE_RE = /^[A-Za-z]{2,3}([-_][A-Za-z]{4})?([-_]([A-Za-z]{2}|[0-9]{3}))?$/;

// Preajustes de interacción del sitio (`wjs_ix_presets`, motor F9). Se guardan como JSON y los
// consume el compilador del frontend, que YA los trata como dato hostil: los pasa uno a uno por
// `normalizeIxPreset` y descarta lo que no encaje (frontend/src/lib/verso/interactions/sitePresets).
//
// Esto es la SEGUNDA vuelta de la llave, en la escritura, y deliberadamente ESTRUCTURAL en vez de
// semántica: el backend no compila animaciones y no va a mantener una copia de las 8 propiedades
// permitidas —dos validadores de la misma gramática acaban discrepando, y el que manda es el que
// compila—. Lo que sí impone aquí es lo que el lector no puede arreglar después: que sea JSON, que
// sea una lista, que no ocupe megabytes y que no venga con 10.000 entradas. Un JSON de 40 MB
// bloquea el hilo del render antes de que ningún normalizador llegue a opinar.
const IX_PRESETS_MAX_BYTES = 256 * 1024;
const IX_PRESETS_MAX_ENTRIES = 50;
const IX_PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Opciones BOOLEANAS cuyo valor almacenado lo vuelve a leer OTRO consumidor más tarde.
//
// `cache.setEnabled` (core/cache) reconoce EXACTAMENTE `1`, `'1'` y `true`; todo lo demás es APAGADO,
// y en silencio. Y updateOption le pasa el valor CRUDO que llegó por HTTP, así que un ajuste guardado
// como `'on'`, `'yes'` o `'TRUE'` —formas que cualquiera escribiría queriendo decir SÍ— se acepta con
// un 200, se almacena tal cual, y deja la caché apagada mientras el interruptor de la pantalla se
// pinta encendido a partir de ese mismo valor. Un interruptor que dice lo contrario de lo que hace es
// peor que uno roto, porque nadie vuelve a mirarlo.
//
// Por eso aquí el vocabulario se CIERRA (400 a lo que no sea booleano) y el valor se NORMALIZA a
// '1'/'0' antes de escribir: es la única forma que entienden igual los tres lectores —el setEnabled
// en caliente de updateOption, el initCacheSetting del arranque y el core/coherence de cada nodo—,
// que además leen a través de getOption, y getOption hace JSON.parse ('1' → 1, y `1` sí está en la
// lista de setEnabled).
const BOOLEANISH_TRUE = new Set(['1', 'true', 'on', 'yes']);
const BOOLEANISH_FALSE = new Set(['', '0', 'false', 'off', 'no']);
/** '1' | '0' cuando el valor es un booleano reconocible; null cuando no lo es (→ 400). */
const booleanishSetting = (v: any): '1' | '0' | null => {
    if (v === true || v === 1) return '1';
    if (v === false || v === 0 || v === null || v === undefined) return '0';
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    if (BOOLEANISH_TRUE.has(s)) return '1';
    if (BOOLEANISH_FALSE.has(s)) return '0';
    return null;
};

const SETTING_VALIDATORS: Record<string, (v: any) => string | null> = {
    // Interruptor de la caché de objetos: booleano cerrado (ver booleanishSetting arriba).
    redis_cache_enabled: (v: any) => booleanishSetting(v) === null
        ? 'redis_cache_enabled must be a boolean ("1" or "0").'
        : null,
    wjs_ix_presets: (v: any) => {
        if (v === '' || v === null || v === undefined) return null; // sin preajustes de sitio
        if (typeof v !== 'string') return 'wjs_ix_presets must be a JSON string.';
        if (v.length > IX_PRESETS_MAX_BYTES) {
            return `wjs_ix_presets must be at most ${IX_PRESETS_MAX_BYTES} characters.`;
        }
        let parsed: any;
        try {
            parsed = JSON.parse(v);
        } catch {
            return 'wjs_ix_presets must be valid JSON.';
        }
        if (!Array.isArray(parsed)) return 'wjs_ix_presets must be a JSON array of presets.';
        if (parsed.length > IX_PRESETS_MAX_ENTRIES) {
            return `wjs_ix_presets must contain at most ${IX_PRESETS_MAX_ENTRIES} presets.`;
        }
        for (const entry of parsed) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return 'Each wjs_ix_presets entry must be an object.';
            }
            // El id `sys:` está RESERVADO al catálogo del código: si un ajuste pudiera declararlo,
            // redefiniría en silencio el movimiento que traen los bloques nuevos por defecto.
            if (typeof entry.id !== 'string' || !IX_PRESET_ID_RE.test(entry.id)) {
                return 'Each wjs_ix_presets entry needs an `id` slug (a-z, 0-9, - and _; the `sys:` namespace is reserved).';
            }
            if (!Array.isArray(entry.tracks)) {
                return 'Each wjs_ix_presets entry needs a `tracks` array.';
            }
        }
        return null;
    },
    // Política de movimiento del sitio (C5). Mismo trato que las transiciones: vocabulario cerrado
    // y '' con el sentido del defecto ('full'), porque borrar un ajuste manda cadena vacía.
    wjs_motion: (v: any) => {
        const s = v === null || v === undefined ? '' : v;
        if (typeof s !== 'string' || !MOTION_POLICIES.includes(s)) {
            return 'wjs_motion must be one of "full", "calm", "off".';
        }
        return null;
    },
    // Transiciones entre páginas (C1). Vocabulario CERRADO y diminuto: el frontend elige entre
    // variantes ya escritas en código, así que aquí basta con rechazar lo que no sea uno de los
    // tres nombres. '' es el mismo sentido que 'off' (sin transición), como en site_text_direction.
    wjs_view_transitions: (v: any) => {
        const s = v === null || v === undefined ? '' : v;
        if (typeof s !== 'string' || !VIEW_TRANSITION_STYLES.includes(s)) {
            return 'wjs_view_transitions must be one of "off", "fade", "slide".';
        }
        return null;
    },
    WPLANG: (v: any) => {
        if (v === '' || v === null || v === undefined) return null; // unset → the resolver's "en"
        if (typeof v !== 'string' || !LOCALE_RE.test(v)) {
            return 'WPLANG must be a language tag like "en", "es_ES" or "ar-SA".';
        }
        return null;
    },
    site_text_direction: (v: any) => {
        const s = v === null || v === undefined ? '' : v;
        if (typeof s !== 'string' || !TEXT_DIRECTIONS.includes(s)) {
            return 'site_text_direction must be one of "", "ltr", "rtl", "auto".';
        }
        return null;
    },
};

/** null when the value is acceptable (or the key carries no validator), else the reason. */
const settingWriteProblem = (key: string, value: any): string | null =>
    Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key) ? SETTING_VALIDATORS[key](value) : null;

// Canonicalización POR CLAVE, aplicada DESPUÉS de validar y justo antes de escribir. Una clave sin
// entrada aquí se guarda tal cual, como siempre: esto es opt-in y no toca a nadie más.
const SETTING_NORMALIZERS: Record<string, (v: any) => any> = {
    // El validador ya garantizó que es reconocible; el `?? '0'` es solo un fail-closed defensivo por si
    // algún día se escribe por un camino que no valide (apagado es el lado seguro).
    redis_cache_enabled: (v: any) => booleanishSetting(v) ?? '0',
};

/** El valor EXACTO que se persiste para esta clave (idéntico al recibido si no hay normalizador). */
const normalizedSettingValue = (key: string, value: any): any =>
    Object.prototype.hasOwnProperty.call(SETTING_NORMALIZERS, key) ? SETTING_NORMALIZERS[key](value) : value;

/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Get public site settings
 *     tags: [Settings]
 *     responses:
 *       200:
 *         description: Key-value map of public settings
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const settings: Record<string, any> = {};

    await Promise.all([
        ...PUBLIC_SETTINGS.map(async (key) => {
            settings[key] = await getOption(key);
        }),
        ...[...DERIVED_PUBLIC_SETTINGS].map(async ([key, compute]) => {
            settings[key] = await compute();
        })
    ]);

    res.json(settings);
}));

/**
 * @swagger
 * /settings/all:
 *   get:
 *     summary: Get all settings (Admin)
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Key-value map of all settings
 *       403:
 *         description: Forbidden
 */
router.get('/all', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const settings: Record<string, any> = {};

    await Promise.all([
        ...ALL_SETTINGS.map(async (key) => {
            settings[key] = await getOption(key);
        }),
        // Admin-only derived flags (sandbox hardening posture) — computed, never stored.
        ...[...DERIVED_ADMIN_SETTINGS].map(async ([key, compute]) => {
            settings[key] = await compute();
        })
    ]);

    res.json(settings);
}));

/**
 * /notices/* — admin notices, kept reachable at the legacy path.
 *
 * LITERAL PREFIX — mounted before the `/:key` wildcard, the same remedy routes/webhooks.ts applies
 * deliberately ("literal prefix — declared before the /:id routes"). The handlers used to sit 145
 * lines BELOW `router.get('/:key')`, and Express matches in registration order: every GET
 * /settings/notices was answered by the wildcard with key='notices', which is not in PUBLIC_SETTINGS
 * and — because the wildcard never consults the session — replied 403 rest_forbidden even to an
 * administrator. The notices CrashGuard writes when it auto-disables a plugin were therefore
 * unreadable, and since the list could not be fetched the ids for DELETE /notices/:id were
 * unknowable, so the autoloaded `admin_notices` option grew without ever being pruned. (DELETE was
 * never shadowed: there is no DELETE /:key.)
 *
 * Notices are NOT a setting — they now have their own router at /api/v1/notices, which is where the
 * admin screen calls. This mount DELEGATES to that one module rather than keeping a second copy, so
 * the old path keeps working (nothing that already integrated against it breaks) and the two can
 * never drift apart. `router.use` also means the wildcard below can no longer see /notices at all.
 */
router.use('/notices', require('./notices'));

/**
 * @swagger
 * /settings/{key}:
 *   get:
 *     summary: Get a single setting
 *     tags: [Settings]
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Setting value
 *       403:
 *         description: Forbidden (if private)
 */
router.get('/:key', asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params as { key: string };

    const compute = derivedSetting(key);
    if (compute) {
        return res.json({ key, value: await compute() });
    }

    // Check if it's a public setting
    if (!PUBLIC_SETTINGS.includes(key)) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'This setting is not publicly accessible.',
            data: { status: 403 }
        });
    }

    const value = await getOption(key);

    res.json({
        key,
        value
    });
}));

/**
 * @swagger
 * /settings:
 *   put:
 *     summary: Update multiple settings
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             example:
 *               blogname: "My Awesome Site"
 *               posts_per_page: 10
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const updates = req.body;
    const updated: Record<string, any> = {};

    // Validate the WHOLE payload before writing any of it: a bulk save that stored half its keys and
    // then 400'd would leave the site in a state the admin never asked for.
    for (const [key, value] of Object.entries(updates)) {
        if (!ALL_SETTINGS.includes(key) || DEDICATED_WRITE_API.has(key)) continue;
        const problem = settingWriteProblem(key, value);
        if (problem) {
            return res.status(400).json({
                code: 'rest_invalid_param',
                message: problem,
                data: { status: 400, params: [key] }
            });
        }
    }

    for (const [key, value] of Object.entries(updates)) {
        if (ALL_SETTINGS.includes(key) && !DEDICATED_WRITE_API.has(key)) {
            // Se escribe (y se devuelve) el valor NORMALIZADO, no el recibido: la respuesta es lo que
            // el cliente usa para repintar, y decirle otra cosa que lo almacenado es cómo un
            // interruptor acaba mintiendo hasta el siguiente recargado.
            const stored = normalizedSettingValue(key, value);
            await updateOption(key, stored);
            updated[key] = stored;
        }
    }

    // AUDIT: record WHICH settings changed — the key names only, never their values (a value could be
    // admin_email / other sensitive config). One row per bulk save.
    const changedKeys = Object.keys(updated);
    if (changedKeys.length) {
        await recordAudit((req as any).user && (req as any).user.id, 'settings.update', 'settings', '', { keys: changedKeys });
    }

    res.json(updated);
}));

/**
 * @swagger
 * /settings/{key}:
 *   put:
 *     summary: Update a single setting
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               value:
 *                 type: string
 *     responses:
 *       200:
 *         description: Setting updated
 */
router.put('/:key', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params as { key: string };
    const { value } = req.body;

    if (!ALL_SETTINGS.includes(key) || DEDICATED_WRITE_API.has(key)) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: DEDICATED_WRITE_API.has(key)
                ? 'This setting is managed by its dedicated API (PUT /api/v1/chrome/:part).'
                : 'Invalid setting key.',
            data: { status: 400 }
        });
    }

    const problem = settingWriteProblem(key, value);
    if (problem) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: problem,
            data: { status: 400, params: [key] }
        });
    }

    await updateOption(key, normalizedSettingValue(key, value));

    res.json({
        key,
        value: await getOption(key)
    });
}));

module.exports = router;
