/**
 * WordJS - Widget System
 * Equivalent to wp-includes/widgets.php
 */

const crypto = require('crypto');
const { getOption, updateOption } = require('./options');
const { doAction, applyFilters } = require('./hooks');

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
 * Render a sidebar
 * Equivalent to dynamic_sidebar()
 */
async function renderSidebar(sidebarId: string) {
    const sidebar = registeredSidebars.get(sidebarId);
    if (!sidebar) return '';

    const widgetInstances = await getSidebarWidgets(sidebarId);
    let output = '';

    for (const instanceKey of widgetInstances) {
        // Split on the LAST '-' so widget ids that themselves contain hyphens
        // (e.g. 'recent-posts', 'custom-html', plugin widgets) resolve correctly.
        const sep = instanceKey.lastIndexOf('-');
        const widgetId = sep === -1 ? instanceKey : instanceKey.slice(0, sep);
        const instanceId = sep === -1 ? '' : instanceKey.slice(sep + 1);
        const widget = registeredWidgets.get(widgetId);

        if (!widget) continue;

        const settings = await getWidgetSettings(widgetId, instanceId);
        const title = settings.title || '';

        output += sidebar.beforeWidget;

        if (title) {
            output += sidebar.beforeTitle + title + sidebar.afterTitle;
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
    form: (settings: any) => `<textarea name="content">${settings.content || ''}</textarea>`
});

registerWidget('recent_posts', 'Recent Posts', {
    description: 'Your most recent posts',
    render: async (settings: any) => {
        const Post = require('../models/Post');
        const limit = parseInt(settings.number) || 5;
        const posts = await Post.findAll({ type: 'post', status: 'publish', limit });

        let html = '<ul class="recent-posts">';
        posts.forEach((p: any) => {
            html += `<li><a href="/${p.postName}">${p.postTitle}</a></li>`;
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
            html += `<li><a href="/category/${c.slug}">${c.name}</a> (${c.count})</li>`;
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
    addWidgetToSidebar,
    removeWidgetFromSidebar
};
