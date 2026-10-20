/**
 * WordJS - Widget System
 * Equivalent to wp-includes/widgets.php
 */

const crypto = require('crypto');
const { getOption, updateOption } = require('./options');
const { applyFilters } = require('./hooks');
const { escHtml, escAttr } = require('./formatting');
const log = require('./module-logger').moduleLogger('core/widgets');

// Registered widgets. CORE widgets (registered with no plugin in context) are global; a PLUGIN's widgets
// (an isolated plugin's, through the wordjs.widgets bridge — core/plugin-isolate) belong to the site whose
// worker registered them and to that plugin: another plugin cannot replace or remove them, and none can
// replace a core widget. Same ownership model as core/shortcodes.
const registeredWidgets = new Map();
const siteContext = require('./site-context');
const siteWidgets = new Map<number, Map<string, any>>();

function pluginWidgetTable(create: boolean): Map<string, any> | undefined {
    const siteId = siteContext.currentSiteIdOrNull() ?? siteContext.PRIMARY_SITE_ID;
    let t = siteWidgets.get(siteId);
    if (!t && create) { t = new Map(); siteWidgets.set(siteId, t); }
    return t;
}

// The effective plugin (null = core) of the current call, resolved lazily (plugin-context loads later).
function currentOwner(): string | null {
    try { return require('./plugin-context').getEffectivePlugin() || null; }
    catch { return null; }
}

// Registered sidebars
const registeredSidebars = new Map();

/**
 * Widget class
 */
class Widget {
    id: any;
    name: any;
    description: any;
    classname: any;
    render: any;
    form: any;
    update: any;
    fields: WidgetField[] | null;
    /** The plugin that registered it (null for a core widget). */
    owner: string | null = null;

    constructor(id: string, name: string, options: Record<string, any> = {}) {
        this.id = id;
        this.name = name;
        this.description = options.description || '';
        this.classname = options.classname || '';
        this.render = options.render || (() => '');
        this.form = options.form || (() => '');
        this.update = options.update || ((instance: any) => instance);
        this.fields = Array.isArray(options.fields) ? normalizeFields(options.fields) : null;
    }
}

// ── WIDGET SETTINGS: a declarative form ──────────────────────────────────────────────────────────────
//
// A widget declares the settings an instance has as `fields` (registerWidget(id, name, { fields })). The
// admin's Widgets screen draws the form from them, and PUT /widgets/:widgetId/instances/:instanceId stores
// only those fields, coerced to their type and bounded — the stored value is what the renderer reads, so it
// must never be whatever the request carried. A widget registered without `fields` (older plugin widgets)
// keeps storing a plain JSON object, bounded in size, as before.

export type WidgetFieldType = 'text' | 'textarea' | 'html' | 'number' | 'checkbox';
export interface WidgetField {
    name: string;
    label: string;
    type: WidgetFieldType;
    /** number: the allowed range; text/textarea/html: the maximum length. */
    min?: number;
    max?: number;
    default?: string | number | boolean;
}

const FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'textarea', 'html', 'number', 'checkbox']);
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const FORBIDDEN_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const DEFAULT_MAX_LENGTH: Record<string, number> = { text: 500, textarea: 20000, html: 100000 };
/** A settings object a widget without `fields` may store (its JSON). */
const MAX_FREEFORM_SETTINGS_BYTES = 100 * 1024;

function normalizeFields(fields: any[]): WidgetField[] {
    const out: WidgetField[] = [];
    const seen = new Set<string>();
    for (const f of fields) {
        if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !FIELD_NAME.test(f.name) || FORBIDDEN_FIELD_NAMES.has(f.name)) continue;
        if (seen.has(f.name) || !FIELD_TYPES.has(f.type)) continue;
        seen.add(f.name);
        const field: WidgetField = { name: f.name, label: typeof f.label === 'string' && f.label ? f.label : f.name, type: f.type };
        if (Number.isFinite(f.min)) field.min = Number(f.min);
        if (Number.isFinite(f.max)) field.max = Number(f.max);
        if (['string', 'number', 'boolean'].includes(typeof f.default)) field.default = f.default;
        out.push(field);
    }
    return out;
}

/**
 * The settings a widget instance may store, from what a request sent: `{ ok: true, settings }`, or
 * `{ ok: false, error }` for a value that is not a settings object.
 */
function sanitizeWidgetSettings(widget: any, input: unknown): { ok: true; settings: Record<string, any> } | { ok: false; error: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '`settings` must be an object.' };
    const src = input as Record<string, unknown>;
    if (!widget || !Array.isArray(widget.fields)) {
        let json = '';
        try { json = JSON.stringify(src); } catch { return { ok: false, error: '`settings` must be plain JSON.' }; }
        if (Buffer.byteLength(json) > MAX_FREEFORM_SETTINGS_BYTES) return { ok: false, error: '`settings` is too large.' };
        return { ok: true, settings: JSON.parse(json) };
    }
    const settings: Record<string, any> = {};
    for (const f of widget.fields as WidgetField[]) {
        const has = Object.prototype.hasOwnProperty.call(src, f.name);
        const v = has ? src[f.name] : f.default;
        if (v === undefined || v === null) continue;
        if (f.type === 'number') {
            let n = Math.trunc(Number(v));
            if (!Number.isFinite(n)) continue;
            if (f.min !== undefined) n = Math.max(f.min, n);
            if (f.max !== undefined) n = Math.min(f.max, n);
            settings[f.name] = n;
        } else if (f.type === 'checkbox') {
            settings[f.name] = v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
        } else {
            settings[f.name] = String(v).slice(0, f.max ?? DEFAULT_MAX_LENGTH[f.type]);
        }
    }
    return { ok: true, settings };
}

/**
 * Register a widget
 * Equivalent to register_widget()
 */
function registerWidget(id: string, name: string, options: Record<string, any> = {}) {
    const widget = new Widget(id, name, options);
    const owner = currentOwner();
    if (owner === null) {
        registeredWidgets.set(id, widget);
        return widget;
    }
    const existing = getWidget(id);
    if (existing && existing.owner !== owner) {
        log.warn(`[Security Block] Plugin '${owner}' tried to override widget '${id}' owned by '${existing.owner ?? 'core'}' — refused.`);
        return null;
    }
    widget.owner = owner;
    pluginWidgetTable(true)!.set(id, widget);
    return widget;
}

/** A registered widget by id: a core one, else one of the current site's plugin widgets. */
function getWidget(id: string) {
    const key = String(id);
    return registeredWidgets.get(key) || pluginWidgetTable(false)?.get(key) || null;
}

/**
 * Unregister a widget
 * Equivalent to unregister_widget()
 */
function unregisterWidget(id: string) {
    const owner = currentOwner();
    if (owner === null) return registeredWidgets.delete(id);
    const table = pluginWidgetTable(false);
    const existing = table?.get(id);
    if (!existing || existing.owner !== owner) return false; // never another owner's widget, never core's
    return table!.delete(id);
}

/**
 * Get all registered widgets: the core ones and the current site's plugin widgets.
 */
function getWidgets() {
    const out = Array.from(registeredWidgets.values());
    const site = pluginWidgetTable(false);
    if (site) for (const [id, w] of site) if (!registeredWidgets.has(id)) out.push(w);
    return out;
}

/**
 * Register a sidebar
 * Equivalent to register_sidebar()
 */
function registerSidebar(id: string, options: Record<string, any> = {}) {
    const sidebar = {
        id,
        name: options.name || id,
        description: options.description || '',
        beforeWidget: options.beforeWidget || '<div class="widget">',
        afterWidget: options.afterWidget || '</div>',
        beforeTitle: options.beforeTitle || '<h3 class="widget-title">',
        afterTitle: options.afterTitle || '</h3>'
    };

    registeredSidebars.set(id, sidebar);
    return sidebar;
}

/**
 * Unregister a sidebar
 */
function unregisterSidebar(id: string) {
    return registeredSidebars.delete(id);
}

/**
 * Get all registered sidebars
 */
function getSidebars() {
    return Array.from(registeredSidebars.values());
}

/**
 * A stored widget option ({ key: value, ... }) with `key` set to `value`, as a new object.
 *
 * The key arrives from a request (a sidebar id, a widget instance id), so it is never written with
 * `stored[key] = value`: on a plain object that write turns '__proto__' into the prototype setter, so
 * the entry vanished from the stored JSON and the object took the request's value as its prototype.
 * The entries go through a Map and Object.fromEntries, which defines every key as an own property:
 * the stored JSON keeps the same shape and order as before, with '__proto__' or 'constructor' as
 * ordinary keys. A stored value that is not an object (unreadable JSON) starts over empty.
 */
function withEntry(stored: any, key: string, value: any): Record<string, any> {
    const entries = new Map<string, any>(
        stored && typeof stored === 'object' && !Array.isArray(stored) ? Object.entries(stored) : []
    );
    entries.set(String(key), value);
    return Object.fromEntries(entries);
}

/** The stored option's OWN entry for `key`, never a member inherited from Object.prototype. */
function ownEntry(stored: any, key: string): any {
    return stored && typeof stored === 'object' && Object.prototype.hasOwnProperty.call(stored, key)
        ? stored[key]
        : undefined;
}

/**
 * Get widgets assigned to a sidebar
 */
async function getSidebarWidgets(sidebarId: string) {
    const sidebarsWidgets = await getOption('sidebars_widgets', {});
    return ownEntry(sidebarsWidgets, sidebarId) || [];
}

/**
 * Set widgets for a sidebar
 */
async function setSidebarWidgets(sidebarId: string, widgetIds: any) {
    const sidebarsWidgets = await getOption('sidebars_widgets', {});
    await updateOption('sidebars_widgets', withEntry(sidebarsWidgets, sidebarId, widgetIds));
}

/**
 * Get widget instance settings
 */
async function getWidgetSettings(widgetId: string, instanceId: string) {
    const allSettings = await getOption(`widget_${widgetId}`, {});
    return ownEntry(allSettings, instanceId) || {};
}

/**
 * Set widget instance settings
 */
async function setWidgetSettings(widgetId: string, instanceId: string, settings: any) {
    const allSettings = await getOption(`widget_${widgetId}`, {});
    await updateOption(`widget_${widgetId}`, withEntry(allSettings, instanceId, settings));
}

/**
 * Resolve a sidebar instance key ("<widgetId>-<instanceId>") to its widget and instance ids.
 *
 * Neither half is delimiter-free: widget ids may contain '-' (plugin widgets, 'recent-posts'), and
 * instance ids are now crypto.randomUUID() values, which contain four. Splitting on the LAST '-' (the
 * previous rule) turned "categories-1b9d…-…-…" into widget "categories-1b9d…-…-…" minus its tail, an
 * unregistered id, so every widget added since the switch to UUIDs was silently skipped. Splitting on
 * the FIRST '-' breaks hyphenated widget ids instead. So the key is matched against the REGISTERED
 * widget ids as a prefix — longest first, so 'recent-posts' wins over a 'recent' widget — which covers
 * both shapes: legacy base-36 keys ("categories-lx3k9a") and UUID keys. Returns null when no registered
 * widget owns the key (the widget's plugin was removed): the caller skips it, as before.
 */
function parseInstanceKey(instanceKey: string): { widgetId: string; instanceId: string } | null {
    if (typeof instanceKey !== 'string' || !instanceKey) return null;
    let best: string | null = null;
    for (const id of getWidgets().map((w: any) => w.id)) {
        if (instanceKey === id || instanceKey.startsWith(`${id}-`)) {
            if (best === null || id.length > best.length) best = id;
        }
    }
    if (best === null) return null;
    return { widgetId: best, instanceId: instanceKey.length > best.length ? instanceKey.slice(best.length + 1) : '' };
}

/**
 * Render a sidebar
 * Equivalent to dynamic_sidebar()
 *
 * The result is served ANONYMOUSLY as text/html (GET /widgets/sidebars/:id/render) and painted into
 * every public page, so every value a built-in widget interpolates is escaped here — term names, post
 * titles and widget titles are written by editors, not by the administrator. Only the widgets whose
 * PURPOSE is markup ('text', 'custom_html', both admin-only to configure) emit their setting as HTML.
 */
async function renderSidebar(sidebarId: string) {
    const sidebar = registeredSidebars.get(sidebarId);
    if (!sidebar) return '';

    const widgetInstances = await getSidebarWidgets(sidebarId);
    let output = '';

    for (const instanceKey of widgetInstances) {
        const parsed = parseInstanceKey(instanceKey);
        if (!parsed) continue;
        const { widgetId, instanceId } = parsed;
        const widget = getWidget(widgetId);

        if (!widget) continue;

        const settings = await getWidgetSettings(widgetId, instanceId);
        const title = settings.title || '';

        output += sidebar.beforeWidget;

        if (title) {
            output += sidebar.beforeTitle + escHtml(title) + sidebar.afterTitle;
        }

        output += await widget.render(settings);
        output += sidebar.afterWidget;
    }

    return await applyFilters('dynamic_sidebar', output, sidebarId);
}

/**
 * Add widget to sidebar
 */
async function addWidgetToSidebar(sidebarId: string, widgetId: string, settings: Record<string, any> = {}) {
    const widgets = await getSidebarWidgets(sidebarId);
    // Use a UUID, not Date.now().toString(36), which collides for two adds within the same millisecond.
    const instanceId = crypto.randomUUID();
    const instanceKey = `${widgetId}-${instanceId}`;

    widgets.push(instanceKey);
    await setSidebarWidgets(sidebarId, widgets);
    await setWidgetSettings(widgetId, instanceId, settings);

    return instanceKey;
}

/**
 * Remove widget from sidebar
 */
async function removeWidgetFromSidebar(sidebarId: string, instanceKey: any) {
    const widgets = await getSidebarWidgets(sidebarId);
    const index = widgets.indexOf(instanceKey);

    if (index > -1) {
        widgets.splice(index, 1);
        await setSidebarWidgets(sidebarId, widgets);
        return true;
    }

    return false;
}

// Register default widgets

const TITLE_FIELD = { name: 'title', label: 'Title', type: 'text', max: 200 };

registerWidget('text', 'Text', {
    description: 'Arbitrary text or HTML',
    fields: [TITLE_FIELD, { name: 'content', label: 'Content', type: 'textarea' }],
    render: async (settings: any) => `<div class="textwidget">${settings.content || ''}</div>`,
    form: (settings: any) => `<textarea name="content">${escHtml(settings.content || '')}</textarea>`
});

registerWidget('recent_posts', 'Recent Posts', {
    description: 'Your most recent posts',
    fields: [TITLE_FIELD, { name: 'number', label: 'Number of posts', type: 'number', min: 1, max: 20, default: 5 }],
    render: async (settings: any) => {
        const Post = require('../models/Post');
        const limit = parseInt(settings.number) || 5;
        const posts = await Post.findAll({ type: 'post', status: 'publish', limit });

        let html = '<ul class="recent-posts">';
        posts.forEach((p: any) => {
            // Path segment encoded, then attribute-escaped; the title is text, never markup.
            html += `<li><a href="/${escAttr(encodeURIComponent(String(p.postName ?? '')))}">${escHtml(p.postTitle)}</a></li>`;
        });
        html += '</ul>';
        return html;
    }
});

registerWidget('categories', 'Categories', {
    description: 'A list of categories',
    fields: [TITLE_FIELD, { name: 'hideEmpty', label: 'Hide empty categories', type: 'checkbox', default: false }],
    render: async (settings: any) => {
        const Term = require('../models/Term');
        const categories = await Term.getCategories({ hideEmpty: settings.hideEmpty });

        let html = '<ul class="categories">';
        categories.forEach((c: any) => {
            // Term names are stored as typed by anyone with manage_categories: escape them as text.
            html += `<li><a href="/category/${escAttr(encodeURIComponent(String(c.slug ?? '')))}">${escHtml(c.name)}</a> (${Number(c.count) || 0})</li>`;
        });
        html += '</ul>';
        return html;
    }
});

registerWidget('search', 'Search', {
    description: 'A search form',
    fields: [TITLE_FIELD],
    render: async () => `
    <form class="search-form" action="/search" method="get">
      <input type="text" name="q" placeholder="Search...">
      <button type="submit">Search</button>
    </form>
  `
});

registerWidget('custom_html', 'Custom HTML', {
    description: 'Add custom HTML code',
    fields: [TITLE_FIELD, { name: 'html', label: 'HTML', type: 'html' }],
    render: async (settings: any) => settings.html || ''
});

// Register default sidebars
registerSidebar('sidebar-1', {
    name: 'Primary Sidebar',
    description: 'Main sidebar that appears on the right'
});

registerSidebar('footer-1', {
    name: 'Footer Widget Area',
    description: 'Widgets in the footer'
});

module.exports = {
    Widget,
    getWidget,
    sanitizeWidgetSettings,
    registerWidget,
    unregisterWidget,
    getWidgets,
    registerSidebar,
    unregisterSidebar,
    getSidebars,
    getSidebarWidgets,
    setSidebarWidgets,
    getWidgetSettings,
    setWidgetSettings,
    renderSidebar,
    parseInstanceKey,
    addWidgetToSidebar,
    removeWidgetFromSidebar
};
