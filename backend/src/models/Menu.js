/**
 * WordJS - Navigation Menu Model
 * Equivalent to wp-includes/nav-menu.php
 */

const { db } = require('../config/database');
const { getOption, updateOption } = require('../core/options');

/**
 * Navigation menu item structure
 */
class MenuItem {
    constructor(data) {
        this.id = data.id;
        this.menuId = data.menu_id;
        this.title = data.title;
        this.url = data.url;
        this.target = data.target || '_self';
        this.type = data.type; // 'custom', 'post', 'page', 'category', 'tag'
        this.objectId = data.object_id; // ID of linked object
        this.parent = data.parent || 0;
        this.order = data.menu_order || 0;
        this.classes = data.classes || '';
    }

    toJSON() {
        return {
            id: this.id,
            menuId: this.menuId,
            title: this.title,
            url: this.url,
            target: this.target,
            type: this.type,
            objectId: this.objectId,
            parent: this.parent,
            order: this.order,
            classes: this.classes
        };
    }
}

/**
 * Navigation Menu class
 */
class Menu {
    constructor(data) {
        this.id = data.term_id || data.id;
        this.name = data.name;
        this.slug = data.slug;
        this.description = data.description || '';
    }

    /**
     * Get menu items
     */
    getItems() {
        return MenuItem.findByMenu(this.id);
    }

    /**
     * Get menu items as tree
     */
    getItemsTree() {
        const items = this.getItems();
        return buildTree(items);
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            slug: this.slug,
            description: this.description,
            items: this.getItemsTree()
        };
    }

    // Static methods

    /**
     * Create a new menu
     */
    static create(data) {
        const { name, slug, description = '' } = data;

        if (!name) {
            throw new Error('Menu name is required');
        }

        const menuSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        // Create term for the menu
        const termResult = db.prepare('INSERT INTO terms (name, slug, term_group) VALUES (?, ?, 0)').run(name, menuSlug);
        const termId = termResult.lastInsertRowid;

        // Create term_taxonomy for nav_menu
        db.prepare(`
      INSERT INTO term_taxonomy (term_id, taxonomy, description, parent, count)
      VALUES (?, 'nav_menu', ?, 0, 0)
    `).run(termId, description);

        return Menu.findById(termId);
    }

    /**
     * Find menu by ID
     */
    static findById(id) {
        const row = db.prepare(`
      SELECT t.term_id, t.name, t.slug, tt.description
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      WHERE t.term_id = ? AND tt.taxonomy = 'nav_menu'
    `).get(id);

        return row ? new Menu(row) : null;
    }

    /**
     * Find menu by slug
     */
    static findBySlug(slug) {
        const row = db.prepare(`
      SELECT t.term_id, t.name, t.slug, tt.description
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      WHERE t.slug = ? AND tt.taxonomy = 'nav_menu'
    `).get(slug);

        return row ? new Menu(row) : null;
    }

    /**
     * Find menu by location
     */
    static findByLocation(location) {
        const locations = getOption('nav_menu_locations', {});
        const menuId = locations[location];

        if (!menuId) return null;
        return Menu.findById(menuId);
    }

    /**
     * Get all menus
     */
    static findAll() {
        const rows = db.prepare(`
      SELECT t.term_id, t.name, t.slug, tt.description
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      WHERE tt.taxonomy = 'nav_menu'
      ORDER BY t.name
    `).all();

        return rows.map(row => new Menu(row));
    }

    /**
     * Update menu
     */
    static update(id, data) {
        const menu = Menu.findById(id);
        if (!menu) throw new Error('Menu not found');

        if (data.name) {
            db.prepare('UPDATE terms SET name = ? WHERE term_id = ?').run(data.name, id);
        }
        if (data.slug) {
            db.prepare('UPDATE terms SET slug = ? WHERE term_id = ?').run(data.slug, id);
        }
        if (data.description !== undefined) {
            db.prepare(`
        UPDATE term_taxonomy SET description = ?
        WHERE term_id = ? AND taxonomy = 'nav_menu'
      `).run(data.description, id);
        }

        return Menu.findById(id);
    }

    /**
     * Delete menu
     */
    static delete(id) {
        // Delete all menu items first
        MenuItem.deleteByMenu(id);

        // Delete term_taxonomy
        db.prepare("DELETE FROM term_taxonomy WHERE term_id = ? AND taxonomy = 'nav_menu'").run(id);

        // Delete term
        db.prepare('DELETE FROM terms WHERE term_id = ?').run(id);

        return true;
    }

    /**
     * Set menu location
     */
    static setLocation(location, menuId) {
        const locations = getOption('nav_menu_locations', {});
        locations[location] = menuId;
        updateOption('nav_menu_locations', locations);
    }

    /**
     * Get all menu locations
     */
    static getLocations() {
        return getOption('nav_menu_locations', {});
    }
}

// MenuItem static methods
MenuItem.create = function (data) {
    const { menuId, title, url, target = '_self', type = 'custom', objectId = 0, parent = 0, order = 0, classes = '' } = data;

    if (!menuId || !title) {
        throw new Error('Menu ID and title are required');
    }

    // Create a post of type 'nav_menu_item'
    const result = db.prepare(`
    INSERT INTO posts (author_id, post_title, post_status, post_type, post_parent, menu_order, post_content, guid)
    VALUES (0, ?, 'publish', 'nav_menu_item', ?, ?, '', ?)
  `).run(title, parent, order, url);

    const itemId = result.lastInsertRowid;

    // Store menu item metadata
    const meta = {
        _menu_item_type: type,
        _menu_item_menu_item_parent: parent,
        _menu_item_object_id: objectId,
        _menu_item_object: type,
        _menu_item_target: target,
        _menu_item_classes: classes,
        _menu_item_url: url
    };

    for (const [key, value] of Object.entries(meta)) {
        db.prepare('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)').run(itemId, key, String(value));
    }

    // Create term relationship
    const ttRow = db.prepare(`
    SELECT term_taxonomy_id FROM term_taxonomy WHERE term_id = ? AND taxonomy = 'nav_menu'
  `).get(menuId);

    if (ttRow) {
        db.prepare('INSERT OR REPLACE INTO term_relationships (object_id, term_taxonomy_id, term_order) VALUES (?, ?, ?)').run(itemId, ttRow.term_taxonomy_id, order);

        // Update count
        db.prepare('UPDATE term_taxonomy SET count = count + 1 WHERE term_taxonomy_id = ?').run(ttRow.term_taxonomy_id);
    }

    return MenuItem.findById(itemId);
};

MenuItem.findById = function (id) {
    const row = db.prepare(`
    SELECT p.id, p.post_title as title, p.post_parent as parent, p.menu_order,
           p.guid as url
    FROM posts p
    WHERE p.id = ? AND p.post_type = 'nav_menu_item'
  `).get(id);

    if (!row) return null;

    // Get meta
    const metas = db.prepare('SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?').all(id);
    const metaMap = {};
    metas.forEach(m => { metaMap[m.meta_key] = m.meta_value; });

    // Get menu ID
    const rel = db.prepare(`
    SELECT tt.term_id as menu_id
    FROM term_relationships tr
    JOIN term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
    WHERE tr.object_id = ? AND tt.taxonomy = 'nav_menu'
  `).get(id);

    return new MenuItem({
        id: row.id,
        menu_id: rel?.menu_id,
        title: row.title,
        url: metaMap._menu_item_url || row.url,
        target: metaMap._menu_item_target || '_self',
        type: metaMap._menu_item_type || 'custom',
        object_id: parseInt(metaMap._menu_item_object_id) || 0,
        parent: parseInt(metaMap._menu_item_menu_item_parent) || row.parent,
        menu_order: row.menu_order,
        classes: metaMap._menu_item_classes || ''
    });
};

MenuItem.findByMenu = function (menuId) {
    const rows = db.prepare(`
    SELECT p.id
    FROM posts p
    JOIN term_relationships tr ON p.id = tr.object_id
    JOIN term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
    WHERE tt.term_id = ? AND tt.taxonomy = 'nav_menu' AND p.post_type = 'nav_menu_item'
    ORDER BY p.menu_order
  `).all(menuId);

    return rows.map(row => MenuItem.findById(row.id)).filter(Boolean);
};

MenuItem.update = function (id, data) {
    const item = MenuItem.findById(id);
    if (!item) throw new Error('Menu item not found');

    if (data.title) {
        db.prepare('UPDATE posts SET post_title = ? WHERE id = ?').run(data.title, id);
    }
    if (data.order !== undefined) {
        db.prepare('UPDATE posts SET menu_order = ? WHERE id = ?').run(data.order, id);
    }
    if (data.parent !== undefined) {
        db.prepare('UPDATE posts SET post_parent = ? WHERE id = ?').run(data.parent, id);
        db.prepare('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?').run(String(data.parent), id, '_menu_item_menu_item_parent');
    }
    if (data.url !== undefined) {
        db.prepare('UPDATE posts SET guid = ? WHERE id = ?').run(data.url, id);
        db.prepare('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?').run(data.url, id, '_menu_item_url');
    }
    if (data.target !== undefined) {
        db.prepare('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?').run(data.target, id, '_menu_item_target');
    }
    if (data.classes !== undefined) {
        db.prepare('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?').run(data.classes, id, '_menu_item_classes');
    }

    return MenuItem.findById(id);
};

MenuItem.delete = function (id) {
    // Delete meta
    db.prepare('DELETE FROM post_meta WHERE post_id = ?').run(id);

    // Delete relationships
    db.prepare('DELETE FROM term_relationships WHERE object_id = ?').run(id);

    // Delete post
    db.prepare("DELETE FROM posts WHERE id = ? AND post_type = 'nav_menu_item'").run(id);

    return true;
};

MenuItem.deleteByMenu = function (menuId) {
    const items = MenuItem.findByMenu(menuId);
    items.forEach(item => MenuItem.delete(item.id));
};

/**
 * Build tree structure from flat menu items
 */
function buildTree(items, parentId = 0) {
    return items
        .filter(item => item.parent === parentId)
        .map(item => ({
            ...item.toJSON(),
            children: buildTree(items, item.id)
        }))
        .sort((a, b) => a.order - b.order);
}

module.exports = { Menu, MenuItem };
