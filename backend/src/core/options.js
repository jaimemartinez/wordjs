/**
 * WordJS - Option Model
 * Equivalent to wp-includes/option.php
 */

const { db } = require('../config/database');

/**
 * Get an option value
 * Equivalent to get_option()
 */
function getOption(name, defaultValue = null) {
    try {
        const stmt = db.prepare('SELECT option_value FROM options WHERE option_name = ?');
        const row = stmt.get(name);

        if (!row) return defaultValue;

        // Try to parse JSON
        try {
            return JSON.parse(row.option_value);
        } catch {
            return row.option_value;
        }
    } catch (e) {
        return defaultValue;
    }
}

/**
 * Update an option value
 * Equivalent to update_option()
 */
function updateOption(name, value, autoload = 'yes') {
    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);

    const existing = db.prepare('SELECT option_id FROM options WHERE option_name = ?').get(name);

    if (existing) {
        db.prepare('UPDATE options SET option_value = ?, autoload = ? WHERE option_name = ?').run(serialized, autoload, name);
    } else {
        db.prepare('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)').run(name, serialized, autoload);
    }

    return true;
}

/**
 * Add an option (only if it doesn't exist)
 * Equivalent to add_option()
 */
function addOption(name, value, autoload = 'yes') {
    const existing = db.prepare('SELECT option_id FROM options WHERE option_name = ?').get(name);
    if (existing) return false;

    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
    db.prepare('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)').run(name, serialized, autoload);
    return true;
}

/**
 * Delete an option
 * Equivalent to delete_option()
 */
function deleteOption(name) {
    const result = db.prepare('DELETE FROM options WHERE option_name = ?').run(name);
    return result.changes > 0;
}

/**
 * Get all autoloaded options
 */
function getAutoloadedOptions() {
    const rows = db.prepare('SELECT option_name, option_value FROM options WHERE autoload = ?').all('yes');

    const options = {};
    for (const row of rows) {
        try {
            options[row.option_name] = JSON.parse(row.option_value);
        } catch {
            options[row.option_name] = row.option_value;
        }
    }
    return options;
}

/**
 * Initialize default options
 */
function initDefaultOptions(siteConfig) {
    const defaults = {
        siteurl: siteConfig.url,
        home: siteConfig.url,
        blogname: siteConfig.name || 'WordJS',
        blogdescription: siteConfig.description || 'Just another WordJS site',
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
        large_size_h: 1024
    };

    for (const [name, value] of Object.entries(defaults)) {
        addOption(name, value);
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
