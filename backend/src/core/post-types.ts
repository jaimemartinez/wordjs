/**
 * WordJS - Custom Post Types
 * Equivalent to wp-includes/post.php (register_post_type)
 */

const { getOption, updateOption } = require('./options');
const { doAction } = require('./hooks');

// Registered post types
const postTypes = new Map();

// Registered taxonomies (mirrors `postTypes` — an in-memory registry of taxonomy objects).
const taxonomies = new Map();

// Built-in taxonomies. WordPress ships 'category' (hierarchical) and 'post_tag' (flat), both
// attached to the 'post' type. Their terms already live in the terms/term_taxonomy tables.
const defaultTaxonomies = {
    category: {
        name: 'category',
        label: 'Categories',
        labels: {
            singular: 'Category',
            plural: 'Categories',
            addNew: 'Add New Category',
            edit: 'Edit Category'
        },
        hierarchical: true,
        public: true,
        showInMenu: true,
        showInRest: true,
        postTypes: ['post'],
        rewrite: { slug: 'category' }
    },
    post_tag: {
        name: 'post_tag',
        label: 'Tags',
        labels: {
            singular: 'Tag',
            plural: 'Tags',
            addNew: 'Add New Tag',
            edit: 'Edit Tag'
        },
        hierarchical: false,
        public: true,
        showInMenu: true,
        showInRest: true,
        postTypes: ['post'],
        rewrite: { slug: 'tag' }
    }
};

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
        // Pages use the page capability family (edit_pages/publish_pages/…) — NOT the post family. Without
        // this, pages defaulted to capability_type 'post', so an author (edit_posts, no page caps) could
        // create/publish pages (audit HIGH). The roles already define the page caps for admin/editor.
        capability_type: 'page',
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
        // The canonical Media entry is the Media Library menu (→ /admin/media) registered in
        // initCoreMenus. Keeping showInMenu here too produced a SECOND "Media" item pointing at
        // /admin/posts?type=attachment — a confusing duplicate. Attachments are managed in the library.
        showInMenu: false,
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
function registerPostType(name: string, args: Record<string, any> = {}) {
    const postType: Record<string, any> = {
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
function unregisterPostType(name: string) {
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
function getPostType(name: string) {
    return postTypes.get(name) || null;
}

/**
 * Get all post types
 * Equivalent to get_post_types()
 */
function getPostTypes(args: Record<string, any> = {}) {
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
function postTypeExists(name: string) {
    return postTypes.has(name);
}

/**
 * Check if post type supports a feature
 * Equivalent to post_type_supports()
 */
function postTypeSupports(name: string, feature: string) {
    const type = getPostType(name);
    if (!type) return false;
    return type.supports.includes(feature);
}

/**
 * Add support for a feature to a post type
 */
function addPostTypeSupport(name: string, features: string | string[]) {
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
function removePostTypeSupport(name: string, feature: string) {
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
function getPostTypesBy(feature: string) {
    return getPostTypes().filter(type => type.supports.includes(feature));
}

// ============================================================================
// TAXONOMIES — mirrors the post-type registry above (register_taxonomy et al).
// ============================================================================

/**
 * Register a taxonomy
 * Equivalent to register_taxonomy()
 *
 * Closed, validated shape: only the known keys below are normalized. Unknown keys are
 * carried through via the trailing spread exactly like registerPostType does, but the
 * normalized `name`/`hierarchical`/`postTypes` are re-applied AFTER the spread so a caller
 * cannot smuggle a non-boolean `hierarchical` or a non-array `postTypes` past normalization.
 */
function registerTaxonomy(name: string, args: Record<string, any> = {}) {
    if (!name || typeof name !== 'string') {
        throw new Error('registerTaxonomy: taxonomy name must be a non-empty string');
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('registerTaxonomy: options must be a plain object');
    }

    // Normalize postTypes: accept a single string or an array, reject anything else to [].
    let postTypesList: string[];
    if (Array.isArray(args.postTypes)) {
        postTypesList = args.postTypes;
    } else if (typeof args.postTypes === 'string' && args.postTypes) {
        postTypesList = [args.postTypes];
    } else {
        postTypesList = [];
    }

    const taxonomy: Record<string, any> = {
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
        rewrite: args.rewrite || { slug: name },
        ...args,
        // Re-applied after the spread so normalization always wins (a caller cannot smuggle a
        // non-boolean hierarchical or a non-array postTypes through the trailing ...args spread).
        hierarchical: args.hierarchical === true,
        postTypes: postTypesList
    };

    taxonomies.set(name, taxonomy);

    doAction('registered_taxonomy', name, taxonomy);

    return taxonomy;
}

/**
 * Unregister a taxonomy
 * Equivalent to unregister_taxonomy(). Built-ins cannot be removed.
 */
function unregisterTaxonomy(name: string) {
    if (['category', 'post_tag'].includes(name)) {
        return false;
    }
    return taxonomies.delete(name);
}

/**
 * Get a taxonomy object
 * Equivalent to get_taxonomy()
 */
function getTaxonomy(name: string) {
    return taxonomies.get(name) || null;
}

/**
 * Get all taxonomies
 * Equivalent to get_taxonomies()
 */
function getTaxonomies(args: Record<string, any> = {}) {
    const list = Array.from(taxonomies.values());

    return list.filter(tax => {
        if (args.public !== undefined && tax.public !== args.public) return false;
        if (args.showInMenu !== undefined && tax.showInMenu !== args.showInMenu) return false;
        if (args.showInRest !== undefined && tax.showInRest !== args.showInRest) return false;
        // Filter by the post type a taxonomy applies to (WP: get_object_taxonomies).
        if (args.postType !== undefined && !tax.postTypes.includes(args.postType)) return false;
        return true;
    });
}

/**
 * Check if a taxonomy exists
 * Equivalent to taxonomy_exists()
 */
function taxonomyExists(name: string) {
    return taxonomies.has(name);
}

/**
 * Initialize built-in and custom taxonomies.
 * Mirrors initPostTypes(): built-ins are registered synchronously, then any persisted
 * custom taxonomies are loaded from options.
 */
async function initTaxonomies() {
    Object.values(defaultTaxonomies).forEach(tax => {
        registerTaxonomy(tax.name, tax);
    });

    const customTaxonomies = await getOption('custom_taxonomies', {});
    if (customTaxonomies && typeof customTaxonomies === 'object') {
        Object.values(customTaxonomies).forEach((tax: any) => {
            // Per-entry guard: registerTaxonomy THROWS on a malformed shape (unlike registerPostType),
            // so one poisoned persisted entry must not brick boot — skip it loudly and keep going.
            try {
                registerTaxonomy(tax && tax.name, tax);
            } catch (e: any) {
                console.warn(`Skipping invalid custom taxonomy: ${e && e.message ? e.message : e}`);
            }
        });
    }
}

/**
 * Save a custom taxonomy so it persists across restarts.
 * Mirrors saveCustomPostType(), with one deliberate strengthening: what gets persisted is the
 * NORMALIZED object returned by registerTaxonomy() — which THROWS on a malformed shape — so
 * nothing is written unless the taxonomy actually registered, and the stored entry re-registers
 * cleanly on the next boot instead of leaning on the initTaxonomies() per-entry guard.
 */
async function saveCustomTaxonomy(name: string, args: Record<string, any> = {}) {
    // Register (and validate) FIRST: on a bad shape this throws and nothing is persisted.
    const taxonomy = registerTaxonomy(name, args);

    const stored = await getOption('custom_taxonomies', {});
    // Same defensive spirit as the boot-time guard: a hand-edited/corrupt option (array, string,
    // null) must not crash the writer — rebuild as a map. The null prototype makes every name a
    // plain data key, so an entry can never be silently lost to object plumbing on assignment.
    const customTaxonomies: Record<string, any> = Object.assign(
        Object.create(null),
        stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
    );
    customTaxonomies[name] = taxonomy;
    await updateOption('custom_taxonomies', customTaxonomies);

    return taxonomy;
}

/**
 * Delete a custom taxonomy.
 * Mirrors deleteCustomPostType(), except success means "the persisted entry is gone" rather than
 * unregisterTaxonomy()'s return value: unlike post types, a persisted taxonomy can legitimately
 * be absent from the live registry (initTaxonomies() SKIPS entries that fail validation), and
 * deleting exactly such a poisoned entry is the cleanup path — it must not report failure.
 * Built-ins stay protected: they are never sourced from the option, and unregisterTaxonomy()
 * refuses them anyway.
 */
async function deleteCustomTaxonomy(name: string) {
    const stored = await getOption('custom_taxonomies', {});
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)
        || !Object.prototype.hasOwnProperty.call(stored, name)) {
        return false;
    }
    delete stored[name];
    await updateOption('custom_taxonomies', stored);
    unregisterTaxonomy(name);
    return true;
}

/**
 * Initialize default and custom post types
 */
async function initPostTypes() {
    // Register defaults (sync)
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

    // Load custom post types from options (Async)
    const customTypes = await getOption('custom_post_types', {});
    if (customTypes && typeof customTypes === 'object') {
        Object.values(customTypes).forEach((type: any) => {
            registerPostType(type.name, type);
        });
    }
}

/**
 * Save custom post type to persist across restarts
 */
async function saveCustomPostType(name: string, args: Record<string, any>) {
    const customTypes = await getOption('custom_post_types', {});
    customTypes[name] = { name, ...args };
    await updateOption('custom_post_types', customTypes);
    return registerPostType(name, args);
}

/**
 * Delete a custom post type
 */
async function deleteCustomPostType(name: string) {
    const customTypes = await getOption('custom_post_types', {});
    if (customTypes[name]) {
        delete customTypes[name];
        await updateOption('custom_post_types', customTypes);
        return unregisterPostType(name);
    }
    return false;
}

// NOTE: We do NOT call initPostTypes() here anymore.
// It must be called explicitly by the app initializer after DB connection.

module.exports = {
    initPostTypes,
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
    deleteCustomPostType,
    // Taxonomies (mirror of the post-type registry)
    initTaxonomies,
    registerTaxonomy,
    unregisterTaxonomy,
    getTaxonomy,
    getTaxonomies,
    taxonomyExists,
    saveCustomTaxonomy,
    deleteCustomTaxonomy
};
