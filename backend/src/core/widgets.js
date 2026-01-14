/**
 * WordJS - Widget System
 * Equivalent to wp-includes/widgets.php
 */

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
    constructor(id, name, options = {}) {
        this.id = id;
        this.name = name;
        this.description = options.description || '';
        this.classname = options.classname || '';
        this.render = options.render || (() => '');
        this.form = options.form || (() => '');
        this.update = options.update || ((instance) => instance);
    }
}

/**
 * Register a widget
 * Equivalent to register_widget()
 */
function registerWidget(id, name, options = {}) {
    const widget = new Widget(id, name, options);
    registeredWidgets.set(id, widget);
    return widget;
}

/**
 * Unregister a widget
 * Equivalent to unregister_widget()
 */
function unregisterWidget(id) {
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
function registerSidebar(id, options = {}) {
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
function unregisterSidebar(id) {
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
function getSidebarWidgets(sidebarId) {
    const sidebarsWidgets = getOption('sidebars_widgets', {});
    return sidebarsWidgets[sidebarId] || [];
}

/**
 * Set widgets for a sidebar
 */
function setSidebarWidgets(sidebarId, widgetIds) {
    const sidebarsWidgets = getOption('sidebars_widgets', {});
    sidebarsWidgets[sidebarId] = widgetIds;
    updateOption('sidebars_widgets', sidebarsWidgets);
}

/**
 * Get widget instance settings
 */
function getWidgetSettings(widgetId, instanceId) {
    const allSettings = getOption(`widget_${widgetId}`, {});
    return allSettings[instanceId] || {};
}

/**
 * Set widget instance settings
 */
function setWidgetSettings(widgetId, instanceId, settings) {
    const allSettings = getOption(`widget_${widgetId}`, {});
    allSettings[instanceId] = settings;
    updateOption(`widget_${widgetId}`, allSettings);
}

/**
 * Render a sidebar
 * Equivalent to dynamic_sidebar()
 */
function renderSidebar(sidebarId) {
    const sidebar = registeredSidebars.get(sidebarId);
    if (!sidebar) return '';

    const widgetInstances = getSidebarWidgets(sidebarId);
    let output = '';

    for (const instanceKey of widgetInstances) {
        const [widgetId, instanceId] = instanceKey.split('-');
        const widget = registeredWidgets.get(widgetId);

        if (!widget) continue;

        const settings = getWidgetSettings(widgetId, instanceId);
        const title = settings.title || '';

        output += sidebar.beforeWidget;

        if (title) {
            output += sidebar.beforeTitle + title + sidebar.afterTitle;
        }

        output += widget.render(settings);
        output += sidebar.afterWidget;
    }

    return applyFilters('dynamic_sidebar', output, sidebarId);
}

/**
 * Add widget to sidebar
 */
function addWidgetToSidebar(sidebarId, widgetId, settings = {}) {
    const widgets = getSidebarWidgets(sidebarId);
    const instanceId = Date.now().toString(36);
    const instanceKey = `${widgetId}-${instanceId}`;

    widgets.push(instanceKey);
    setSidebarWidgets(sidebarId, widgets);
    setWidgetSettings(widgetId, instanceId, settings);

    return instanceKey;
}

/**
 * Remove widget from sidebar
 */
function removeWidgetFromSidebar(sidebarId, instanceKey) {
    const widgets = getSidebarWidgets(sidebarId);
    const index = widgets.indexOf(instanceKey);

    if (index > -1) {
        widgets.splice(index, 1);
        setSidebarWidgets(sidebarId, widgets);
        return true;
    }

    return false;
}

// Register default widgets

registerWidget('text', 'Text', {
    description: 'Arbitrary text or HTML',
    render: (settings) => `<div class="textwidget">${settings.content || ''}</div>`,
    form: (settings) => `<textarea name="content">${settings.content || ''}</textarea>`
});

registerWidget('recent_posts', 'Recent Posts', {
    description: 'Your most recent posts',
    render: (settings) => {
        const Post = require('../models/Post');
        const limit = parseInt(settings.number) || 5;
        const posts = Post.findAll({ type: 'post', status: 'publish', limit });

        let html = '<ul class="recent-posts">';
        posts.forEach(p => {
            html += `<li><a href="/${p.postName}">${p.postTitle}</a></li>`;
        });
        html += '</ul>';
        return html;
    }
});

registerWidget('categories', 'Categories', {
    description: 'A list of categories',
    render: (settings) => {
        const Term = require('../models/Term');
        const categories = Term.getCategories({ hideEmpty: settings.hideEmpty });

        let html = '<ul class="categories">';
        categories.forEach(c => {
            html += `<li><a href="/category/${c.slug}">${c.name}</a> (${c.count})</li>`;
        });
        html += '</ul>';
        return html;
    }
});

registerWidget('search', 'Search', {
    description: 'A search form',
    render: () => `
    <form class="search-form" action="/search" method="get">
      <input type="text" name="q" placeholder="Search...">
      <button type="submit">Search</button>
    </form>
  `
});

registerWidget('custom_html', 'Custom HTML', {
    description: 'Add custom HTML code',
    render: (settings) => settings.html || ''
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
