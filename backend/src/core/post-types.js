/**
 * WordJS - Custom Post Types
 * Equivalent to wp-includes/post.php (register_post_type)
 */

const { getOption, updateOption } = require('./options');
const { doAction } = require('./hooks');

// Registered post types
const postTypes = new Map();

// Default post types
const defaultPostTypes = {
    post: {
        name: 'post',
        label: 'Posts',
        labels: {
            singular: 'Post',
            plural: 'Posts',
            addNew: 'Add New Post',
            edit: 'Edit Post'
        },
        public: true,
        showInMenu: true,
        showInRest: true,
        hasArchive: true,
        supports: ['title', 'editor', 'author', 'thumbnail', 'excerpt', 'comments', 'revisions'],
        taxonomies: ['category', 'post_tag'],
        menuIcon: 'fa-pen-to-square',
        menuPosition: 5
    },
    page: {
        name: 'page',
        label: 'Pages',
        labels: {
            singular: 'Page',
            plural: 'Pages',
            addNew: 'Add New Page',
            edit: 'Edit Page'
        },
        public: true,
        showInMenu: true,
        showInRest: true,
        hasArchive: false,
        hierarchical: true,
        supports: ['title', 'editor', 'author', 'thumbnail', 'excerpt', 'page-attributes', 'revisions'],
        taxonomies: [],
        menuIcon: 'fa-file-lines',
        menuPosition: 10
    },
    attachment: {
        name: 'attachment',
        label: 'Media',
        labels: {
            singular: 'Media',
            plural: 'Media',
            addNew: 'Add New Media',
            edit: 'Edit Media'
        },
        public: true,
        showInMenu: true,
        showInRest: true,
        hasArchive: false,
        supports: ['title', 'author', 'comments'],
        taxonomies: [],
        menuIcon: 'fa-images',
        menuPosition: 15
    }
};

/**
 * Register a custom post type
 * Equivalent to register_post_type()
 */
function registerPostType(name, args = {}) {
    const postType = {
        name,
        label: args.label || name,
        labels: {
            singular: args.labels?.singular || args.label || name,
            plural: args.labels?.plural || args.label || name,
            addNew: args.labels?.addNew || `Add New ${args.label || name}`,
            edit: args.labels?.edit || `Edit ${args.label || name}`,
            ...args.labels
        },
        description: args.description || '',
        public: args.public !== false,
        showInMenu: args.showInMenu !== false,
        showInRest: args.showInRest !== false,
        hasArchive: args.hasArchive || false,
        hierarchical: args.hierarchical || false,
        supports: args.supports || ['title', 'editor'],
        taxonomies: args.taxonomies || [],
        menuIcon: args.menuIcon || 'fa-file',
        menuPosition: args.menuPosition || 25,
        rewrite: args.rewrite || { slug: name },
        capability_type: args.capability_type || 'post',
        ...args
    };

    postTypes.set(name, postType);

    doAction('registered_post_type', name, postType);

    return postType;
}

/**
 * Unregister a post type
 */
function unregisterPostType(name) {
    // Can't unregister built-in types
    if (['post', 'page', 'attachment', 'revision', 'nav_menu_item'].includes(name)) {
        return false;
    }

    return postTypes.delete(name);
}

/**
 * Get a post type object
 * Equivalent to get_post_type_object()
 */
function getPostType(name) {
    return postTypes.get(name) || null;
}

/**
 * Get all post types
 * Equivalent to get_post_types()
 */
function getPostTypes(args = {}) {
    const types = Array.from(postTypes.values());

    // Filter by arguments
    return types.filter(type => {
        if (args.public !== undefined && type.public !== args.public) return false;
        if (args.showInMenu !== undefined && type.showInMenu !== args.showInMenu) return false;
        if (args.showInRest !== undefined && type.showInRest !== args.showInRest) return false;
        return true;
    });
}

/**
 * Check if post type exists
 * Equivalent to post_type_exists()
 */
function postTypeExists(name) {
    return postTypes.has(name);
}

/**
 * Check if post type supports a feature
 * Equivalent to post_type_supports()
 */
function postTypeSupports(name, feature) {
    const type = getPostType(name);
    if (!type) return false;
    return type.supports.includes(feature);
}

/**
 * Add support for a feature to a post type
 */
function addPostTypeSupport(name, features) {
    const type = getPostType(name);
    if (!type) return false;

    const featureArray = Array.isArray(features) ? features : [features];
    featureArray.forEach(f => {
        if (!type.supports.includes(f)) {
            type.supports.push(f);
        }
    });

    return true;
}

/**
 * Remove support for a feature from a post type
 */
function removePostTypeSupport(name, feature) {
    const type = getPostType(name);
    if (!type) return false;

    const index = type.supports.indexOf(feature);
    if (index > -1) {
        type.supports.splice(index, 1);
        return true;
    }

    return false;
}

/**
 * Get post types that support a feature
 */
function getPostTypesBy(feature) {
    return getPostTypes().filter(type => type.supports.includes(feature));
}

/**
 * Initialize default post types
 */
function initPostTypes() {
    Object.values(defaultPostTypes).forEach(type => {
        registerPostType(type.name, type);
    });

    // Register nav_menu_item (internal)
    registerPostType('nav_menu_item', {
        label: 'Navigation Menu Items',
        public: false,
        showInMenu: false,
        showInRest: false
    });

    // Register revision (internal)
    registerPostType('revision', {
        label: 'Revisions',
        public: false,
        showInMenu: false,
        showInRest: false
    });

    // Load custom post types from options
    const customTypes = getOption('custom_post_types', {});
    Object.values(customTypes).forEach(type => {
        registerPostType(type.name, type);
    });
}

/**
 * Save custom post type to persist across restarts
 */
function saveCustomPostType(name, args) {
    const customTypes = getOption('custom_post_types', {});
    customTypes[name] = { name, ...args };
    updateOption('custom_post_types', customTypes);
    return registerPostType(name, args);
}

/**
 * Delete a custom post type
 */
function deleteCustomPostType(name) {
    const customTypes = getOption('custom_post_types', {});
    if (customTypes[name]) {
        delete customTypes[name];
        updateOption('custom_post_types', customTypes);
        return unregisterPostType(name);
    }
    return false;
}

// Initialize on load
initPostTypes();

module.exports = {
    registerPostType,
    unregisterPostType,
    getPostType,
    getPostTypes,
    postTypeExists,
    postTypeSupports,
    addPostTypeSupport,
    removePostTypeSupport,
    getPostTypesBy,
    saveCustomPostType,
    deleteCustomPostType
};
