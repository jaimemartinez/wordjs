/**
 * WordJS - Option Model
 * Equivalent to wp-includes/option.php
 */

const { dbAsync } = require('../config/database');
const { verifyPermission, runWithContext } = require('./plugin-context');
const { doAction } = require('./hooks');

/**
 * Get an option value
 * Equivalent to get_option()
 */
async function getOption(name, defaultValue = null) {
    // Only verify if we are in a plugin context
    verifyPermission('settings', 'read');

    return runWithContext(null, async () => {
        try {
            const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);

            if (!row) return defaultValue;

            // Try to parse JSON
            try {
                return JSON.parse(row.option_value);
            } catch {
                return row.option_value;
            }
        } catch (e) {
            console.error(`Error getting option ${name}:`, e.message);
            return defaultValue;
        }
    });
}

/**
 * Update an option value
 * Equivalent to update_option()
 */
async function updateOption(name, value, autoload = 'yes') {
    verifyPermission('settings', 'write');

    return runWithContext(null, async () => {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);

        // Check strict existence first
        const existing = await dbAsync.get('SELECT option_id FROM options WHERE option_name = ?', [name]);

        if (existing) {
            await dbAsync.run('UPDATE options SET option_value = ?, autoload = ? WHERE option_name = ?', [serialized, autoload, name]);
        } else {
            await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [name, serialized, autoload]);
        }

        // Trigger reactive hooks
        // We pass parsed value if possible or just the raw arg? 
        // options.js logic serializes it. Let's pass the raw 'value' arg as that's arguably more useful.
        await doAction('updated_option', name, value);

        return true;
    });
}

/**
 * Add an option (only if it doesn't exist)
 * Equivalent to add_option()
 */
async function addOption(name, value, autoload = 'yes') {
    verifyPermission('settings', 'write');

    return runWithContext(null, async () => {
        const existing = await dbAsync.get('SELECT option_id FROM options WHERE option_name = ?', [name]);
        if (existing) return false;

        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [name, serialized, autoload]);
        return true;
    });
}

/**
 * Delete an option
 * Equivalent to delete_option()
 */
async function deleteOption(name) {
    verifyPermission('settings', 'write');

    return runWithContext(null, async () => {
        const result = await dbAsync.run('DELETE FROM options WHERE option_name = ?', [name]);
        return result.changes > 0;
    });
}

/**
 * Get all autoloaded options
 */
async function getAutoloadedOptions() {
    return runWithContext(null, async () => {
        const rows = await dbAsync.all('SELECT option_name, option_value FROM options WHERE autoload = ?', ['yes']);

        const options = {};
        for (const row of rows) {
            try {
                options[row.option_name] = JSON.parse(row.option_value);
            } catch {
                options[row.option_name] = row.option_value;
            }
        }
        return options;
    });
}

/**
 * Initialize default options
 * WARNING: This is called during init, ensure DB is ready.
 */
async function initDefaultOptions(fullConfig) {
    const defaults = {
        siteurl: fullConfig.site.url,
        home: fullConfig.site.url,
        blogname: fullConfig.site.name || 'WordJS',
        blogdescription: fullConfig.site.description || 'Just another WordJS site',
        users_can_register: 0,
        admin_email: 'admin@example.com',
        start_of_week: 1,
        date_format: 'Y-m-d',
        time_format: 'H:i',
        timezone_string: 'UTC',
        posts_per_page: 10,
        default_category: 1,
        default_post_format: '',
        show_on_front: 'posts',
        page_on_front: 0,
        page_for_posts: 0,
        blog_public: 1,
        default_pingback_flag: 0,
        default_ping_status: 'open',
        default_comment_status: 'open',
        comments_notify: 1,
        moderation_notify: 1,
        comment_moderation: 0,
        comment_registration: 0,
        require_name_email: 1,
        comment_previously_approved: 1,
        comment_max_links: 2,
        permalink_structure: '/%postname%/',
        active_plugins: [],
        template: 'default',
        stylesheet: 'default',
        thumbnail_size_w: 150,
        thumbnail_size_h: 150,
        medium_size_w: 300,
        medium_size_h: 300,
        large_size_w: 1024,
        large_size_h: 1024,
        default_role: 'subscriber',
        wordjs_user_roles: fullConfig.roles || {}
    };

    for (const [name, value] of Object.entries(defaults)) {
        await addOption(name, value);
    }
}

module.exports = {
    getOption,
    updateOption,
    addOption,
    deleteOption,
    getAutoloadedOptions,
    initDefaultOptions
};
