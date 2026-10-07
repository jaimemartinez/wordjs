/**
 * WordJS - Widget System
 * Equivalent to wp-includes/widgets.php
 */

const crypto = require('crypto');
const { getOption, updateOption } = require('./options');
const { doAction, applyFilters } = require('./hooks');
const { escHtml, escAttr } = require('./formatting');

// Registered widgets
const registeredWidgets = new Map();

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

    constructor(id: string, name: string, options: Record<string, any> = {}) {
        this.id = id;
        this.name = name;
        this.description = options.description || '';
        this.classname = options.classname || '';
        this.render = options.render || (() => '');
        this.form = options.form || (() => '');
        this.update = options.update || ((instance: any) => instance);
    }
}

/**
 * Register a widget
 * Equivalent to register_widget()
 */
function registerWidget(id: string, name: string, options: Record<string, any> = {}) {
    const widget = new Widget(id, name, options);
    registeredWidgets.set(id, widget);
    return widget;
}

/**
 * Unregister a widget
 * Equivalent to unregister_widget()
 */
function unregisterWidget(id: string) {
    return registeredWidgets.delete(id);
}

/**
 * Get all registered widgets
 */
function getWidgets() {
    return Array.from(registeredWidgets.values());
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
 * Get widgets assigned to a sidebar
 */
/**
 * Get widgets assigned to a sidebar
 */
async function getSidebarWidgets(sidebarId: string) {
    const sidebarsWidgets = await getOption('sidebars_widgets', {});
    return sidebarsWidgets[sidebarId] || [];
}

/**
 * Set widgets for a sidebar
 */
async function setSidebarWidgets(sidebarId: string, widgetIds: any) {
    const sidebarsWidgets = await getOption('sidebars_widgets', {});
    sidebarsWidgets[sidebarId] = widgetIds;
    await updateOption('sidebars_widgets', sidebarsWidgets);
}

/**
 * Get widget instance settings
 */
async function getWidgetSettings(widgetId: string, instanceId: string) {
    const allSettings = await getOption(`widget_${widgetId}`, {});
    return allSettings[instanceId] || {};
}

/**
 * Set widget instance settings
 */
async function setWidgetSettings(widgetId: string, instanceId: string, settings: any) {
    const allSettings = await getOption(`widget_${widgetId}`, {});
    allSettings[instanceId] = settings;
    await updateOption(`widget_${widgetId}`, allSettings);
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
    for (const id of registeredWidgets.keys()) {
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
        const widget = registeredWidgets.get(widgetId);

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

registerWidget('text', 'Text', {
    description: 'Arbitrary text or HTML',
    render: async (settings: any) => `<div class="textwidget">${settings.content || ''}</div>`,
    form: (settings: any) => `<textarea name="content">${escHtml(settings.content || '')}</textarea>`
});

registerWidget('recent_posts', 'Recent Posts', {
    description: 'Your most recent posts',
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
    render: async () => `
    <form class="search-form" action="/search" method="get">
      <input type="text" name="q" placeholder="Search...">
      <button type="submit">Search</button>
    </form>
  `
});

registerWidget('custom_html', 'Custom HTML', {
    description: 'Add custom HTML code',
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
