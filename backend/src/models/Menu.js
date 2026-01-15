/**
 * WordJS - Navigation Menu Model
 * Equivalent to wp-includes/nav-menu.php
 */

const { db, dbAsync } = require('../config/database');
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
    async getItems() {
        return await MenuItem.findByMenu(this.id);
    }

    /**
     * Get menu items as tree
     */
    async getItemsTree() {
        const items = await this.getItems();
        return buildTree(items);
    }

    toJSON() {
        // Warning: toJSON behaves synchronously in JSON.stringify. 
        // This method can't wait for async tree building if called automatically.
        // It's better for callers to await .getItemsTree() explicitly or provide a separate DTO method.
        // For partial compatibility, we return what we have, but traversing mostly needs async.
        // Or we assume hydrated?

        // Strategy: Return basic structure. Async serialization is separate step.
        return {
            id: this.id,
            name: this.name,
            slug: this.slug,
            description: this.description,
            // items: ... cannot fetch async here easily without hydration pattern
        };
    }

    // Static methods

    /**
     * Create a new menu
     */
    static async create(data) {
        const { name, slug, description = '' } = data;

        if (!name) {
            throw new Error('Menu name is required');
        }

        const menuSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        // Create term for the menu
        const termResult = await dbAsync.run('INSERT INTO terms (name, slug, term_group) VALUES (?, ?, 0) RETURNING term_id', [name, menuSlug]);
        const termId = termResult.lastID;

        // Create term_taxonomy for nav_menu
        await dbAsync.run(`
      INSERT INTO term_taxonomy (term_id, taxonomy, description, parent, count)
      VALUES (?, 'nav_menu', ?, 0, 0)
    `, [termId, description]);

        return await Menu.findById(termId);
    }

    /**
     * Find menu by ID
     */
    static async findById(id) {
        const row = await dbAsync.get(`
      SELECT t.term_id, t.name, t.slug, tt.description
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      WHERE t.term_id = ? AND tt.taxonomy = 'nav_menu'
    `, [id]);

        return row ? new Menu(row) : null;
    }

    /**
     * Find menu by slug
     */
    static async findBySlug(slug) {
        const row = await dbAsync.get(`
      SELECT t.term_id, t.name, t.slug, tt.description
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      WHERE t.slug = ? AND tt.taxonomy = 'nav_menu'
    `, [slug]);

        return row ? new Menu(row) : null;
    }

    /**
     * Find menu by location
     */
    static async findByLocation(location) {
        const locations = await getOption('nav_menu_locations', {});
        const menuId = locations[location];

        if (!menuId) return null;
        return await Menu.findById(menuId);
    }

    /**
     * Get all menus
     */
    static async findAll() {
        const rows = await dbAsync.all(`
      SELECT t.term_id, t.name, t.slug, tt.description
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      WHERE tt.taxonomy = 'nav_menu'
      ORDER BY t.name
    `);

        return rows.map(row => new Menu(row));
    }

    /**
     * Update menu
     */
    static async update(id, data) {
        const menu = await Menu.findById(id);
        if (!menu) throw new Error('Menu not found');

        if (data.name) {
            await dbAsync.run('UPDATE terms SET name = ? WHERE term_id = ?', [data.name, id]);
        }
        if (data.slug) {
            await dbAsync.run('UPDATE terms SET slug = ? WHERE term_id = ?', [data.slug, id]);
        }
        if (data.description !== undefined) {
            await dbAsync.run(`
        UPDATE term_taxonomy SET description = ?
        WHERE term_id = ? AND taxonomy = 'nav_menu'
      `, [data.description, id]);
        }

        return await Menu.findById(id);
    }

    /**
     * Delete menu
     */
    static async delete(id) {
        // Delete all menu items first
        await MenuItem.deleteByMenu(id);

        // Delete term_taxonomy
        await dbAsync.run("DELETE FROM term_taxonomy WHERE term_id = ? AND taxonomy = 'nav_menu'", [id]);

        // Delete term
        await dbAsync.run('DELETE FROM terms WHERE term_id = ?', [id]);

        return true;
    }

    /**
     * Set menu location
     */
    static async setLocation(location, menuId) {
        const locations = await getOption('nav_menu_locations', {});
        locations[location] = menuId;
        await updateOption('nav_menu_locations', locations);
    }

    /**
     * Get all menu locations
     */
    static async getLocations() {
        return await getOption('nav_menu_locations', {});
    }
}

// MenuItem static methods
MenuItem.create = async function (data) {
    const { menuId, title, url, target = '_self', type = 'custom', objectId = 0, parent = 0, order = 0, classes = '' } = data;

    if (!menuId || !title) {
        throw new Error('Menu ID and title are required');
    }

    // Create a post of type 'nav_menu_item'
    const result = await dbAsync.run(`
    INSERT INTO posts (author_id, post_title, post_status, post_type, post_parent, menu_order, post_content, guid)
    VALUES (0, ?, 'publish', 'nav_menu_item', ?, ?, '', ?) RETURNING id
  `, [title, parent, order, url]);

    const itemId = result.lastID;

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
        await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [itemId, key, String(value)]);
    }

    // Create term relationship
    const ttRow = await dbAsync.get(`
    SELECT term_taxonomy_id FROM term_taxonomy WHERE term_id = ? AND taxonomy = 'nav_menu'
  `, [menuId]);

    if (ttRow) {
        await dbAsync.run('INSERT INTO term_relationships (object_id, term_taxonomy_id, term_order) VALUES (?, ?, ?)', [itemId, ttRow.term_taxonomy_id, order]);

        // Update count
        await dbAsync.run('UPDATE term_taxonomy SET count = count + 1 WHERE term_taxonomy_id = ?', [ttRow.term_taxonomy_id]);
    }

    return await MenuItem.findById(itemId);
};

MenuItem.findById = async function (id) {
    const row = await dbAsync.get(`
    SELECT p.id, p.post_title as title, p.post_parent as parent, p.menu_order,
           p.guid as url
    FROM posts p
    WHERE p.id = ? AND p.post_type = 'nav_menu_item'
  `, [id]);

    if (!row) return null;

    // Get meta
    const metas = await dbAsync.all('SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?', [id]);
    const metaMap = {};
    metas.forEach(m => { metaMap[m.meta_key] = m.meta_value; });

    // Get menu ID
    const rel = await dbAsync.get(`
    SELECT tt.term_id as menu_id
    FROM term_relationships tr
    JOIN term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
    WHERE tr.object_id = ? AND tt.taxonomy = 'nav_menu'
  `, [id]);

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

MenuItem.findByMenu = async function (menuId) {
    const rows = await dbAsync.all(`
    SELECT p.id
    FROM posts p
    JOIN term_relationships tr ON p.id = tr.object_id
    JOIN term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
    WHERE tt.term_id = ? AND tt.taxonomy = 'nav_menu' AND p.post_type = 'nav_menu_item'
    ORDER BY p.menu_order
  `, [menuId]);

    // Parallel fetch for items
    return (await Promise.all(rows.map(row => MenuItem.findById(row.id)))).filter(Boolean);
};

MenuItem.update = async function (id, data) {
    const item = await MenuItem.findById(id);
    if (!item) throw new Error('Menu item not found');

    if (data.title) {
        await dbAsync.run('UPDATE posts SET post_title = ? WHERE id = ?', [data.title, id]);
    }
    if (data.order !== undefined) {
        await dbAsync.run('UPDATE posts SET menu_order = ? WHERE id = ?', [data.order, id]);
    }
    if (data.parent !== undefined) {
        await dbAsync.run('UPDATE posts SET post_parent = ? WHERE id = ?', [data.parent, id]);
        await dbAsync.run('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?', [String(data.parent), id, '_menu_item_menu_item_parent']);
    }
    if (data.url !== undefined) {
        await dbAsync.run('UPDATE posts SET guid = ? WHERE id = ?', [data.url, id]);
        await dbAsync.run('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?', [data.url, id, '_menu_item_url']);
    }
    if (data.target !== undefined) {
        await dbAsync.run('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?', [data.target, id, '_menu_item_target']);
    }
    if (data.classes !== undefined) {
        await dbAsync.run('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?', [data.classes, id, '_menu_item_classes']);
    }

    return await MenuItem.findById(id);
};

MenuItem.delete = async function (id) {
    // Delete meta
    await dbAsync.run('DELETE FROM post_meta WHERE post_id = ?', [id]);

    // Delete relationships
    await dbAsync.run('DELETE FROM term_relationships WHERE object_id = ?', [id]);

    // Delete post
    await dbAsync.run("DELETE FROM posts WHERE id = ? AND post_type = 'nav_menu_item'", [id]);

    return true;
};

MenuItem.deleteByMenu = async function (menuId) {
    const items = await MenuItem.findByMenu(menuId);
    // Parallel delete
    await Promise.all(items.map(item => MenuItem.delete(item.id)));
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
