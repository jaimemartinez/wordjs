/**
 * WordJS - Term Model
 * Equivalent to wp-includes/class-wp-term.php and wp-includes/taxonomy.php
 */

const { db } = require('../config/database');
const { sanitizeTitle } = require('../core/formatting');

class Term {
    constructor(data) {
        this.termId = data.term_id;
        this.name = data.name;
        this.slug = data.slug;
        this.termGroup = data.term_group;
        this.taxonomy = data.taxonomy;
        this.description = data.description;
        this.parent = data.parent;
        this.count = data.count;
        this.termTaxonomyId = data.term_taxonomy_id;
    }

    /**
     * Convert to JSON
     */
    toJSON() {
        return {
            id: this.termId,
            name: this.name,
            slug: this.slug,
            taxonomy: this.taxonomy,
            description: this.description,
            parent: this.parent,
            count: this.count
        };
    }

    // Static methods

    /**
     * Create a new term
     * Equivalent to wp_insert_term()
     */
    static create(data) {
        const { name, taxonomy, slug, description = '', parent = 0 } = data;

        if (!name || !taxonomy) {
            throw new Error('Name and taxonomy are required');
        }

        // Generate slug
        let termSlug = slug || sanitizeTitle(name);
        termSlug = Term.generateUniqueSlug(termSlug);

        // Check if term exists
        const existing = db.prepare(`
      SELECT t.term_id FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      WHERE t.name = ? AND tt.taxonomy = ?
    `).get(name, taxonomy);

        if (existing) {
            throw new Error('Term already exists');
        }

        // Insert term
        const termResult = db.prepare('INSERT INTO terms (name, slug, term_group) VALUES (?, ?, 0)').run(name, termSlug);
        const termId = termResult.lastInsertRowid;

        // Insert term taxonomy
        const ttResult = db.prepare(`
      INSERT INTO term_taxonomy (term_id, taxonomy, description, parent, count)
      VALUES (?, ?, ?, ?, 0)
    `).run(termId, taxonomy, description, parent);

        return Term.findById(termId, taxonomy);
    }

    /**
     * Generate unique slug
     */
    static generateUniqueSlug(slug) {
        let uniqueSlug = slug;
        let counter = 1;

        while (db.prepare('SELECT term_id FROM terms WHERE slug = ?').get(uniqueSlug)) {
            counter++;
            uniqueSlug = `${slug}-${counter}`;
        }

        return uniqueSlug;
    }

    /**
     * Find term by ID
     * Equivalent to get_term()
     */
    static findById(termId, taxonomy = null) {
        let sql = `
      SELECT t.*, tt.taxonomy, tt.description, tt.parent, tt.count, tt.term_taxonomy_id
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      WHERE t.term_id = ?
    `;
        const params = [termId];

        if (taxonomy) {
            sql += ' AND tt.taxonomy = ?';
            params.push(taxonomy);
        }

        const row = db.prepare(sql).get(...params);
        return row ? new Term(row) : null;
    }

    /**
     * Find term by slug
     * Equivalent to get_term_by('slug', ...)
     */
    static findBySlug(slug, taxonomy) {
        const row = db.prepare(`
      SELECT t.*, tt.taxonomy, tt.description, tt.parent, tt.count, tt.term_taxonomy_id
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      WHERE t.slug = ? AND tt.taxonomy = ?
    `).get(slug, taxonomy);
        return row ? new Term(row) : null;
    }

    /**
     * Get all terms
     * Equivalent to get_terms()
     */
    static findAll(options = {}) {
        const {
            taxonomy,
            parent,
            hideEmpty = false,
            search,
            limit = 100,
            offset = 0,
            orderBy = 'name',
            order = 'ASC'
        } = options;

        let sql = `
      SELECT t.*, tt.taxonomy, tt.description, tt.parent, tt.count, tt.term_taxonomy_id
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
    `;
        const conditions = [];
        const params = [];

        if (taxonomy) {
            if (Array.isArray(taxonomy)) {
                conditions.push(`tt.taxonomy IN (${taxonomy.map(() => '?').join(',')})`);
                params.push(...taxonomy);
            } else {
                conditions.push('tt.taxonomy = ?');
                params.push(taxonomy);
            }
        }

        if (parent !== undefined) {
            conditions.push('tt.parent = ?');
            params.push(parent);
        }

        if (hideEmpty) {
            conditions.push('tt.count > 0');
        }

        if (search) {
            conditions.push('t.name LIKE ?');
            params.push(`%${search}%`);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        const allowedOrderBy = ['name', 'term_id', 'slug', 'count'];
        const safeOrderBy = allowedOrderBy.includes(orderBy) ? orderBy : 'name';
        const safeOrder = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        sql += ` ORDER BY t.${safeOrderBy} ${safeOrder}`;

        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows = db.prepare(sql).all(...params);
        return rows.map(row => new Term(row));
    }

    /**
     * Get categories
     */
    static getCategories(options = {}) {
        return Term.findAll({ ...options, taxonomy: 'category' });
    }

    /**
     * Get tags
     */
    static getTags(options = {}) {
        return Term.findAll({ ...options, taxonomy: 'post_tag' });
    }

    /**
     * Update a term
     * Equivalent to wp_update_term()
     */
    static update(termId, taxonomy, data) {
        const term = Term.findById(termId, taxonomy);
        if (!term) throw new Error('Term not found');

        // Update terms table
        if (data.name || data.slug) {
            const updates = [];
            const values = [];

            if (data.name) {
                updates.push('name = ?');
                values.push(data.name);
            }
            if (data.slug) {
                const newSlug = Term.generateUniqueSlug(sanitizeTitle(data.slug));
                updates.push('slug = ?');
                values.push(newSlug);
            }

            values.push(termId);
            db.prepare(`UPDATE terms SET ${updates.join(', ')} WHERE term_id = ?`).run(...values);
        }

        // Update term_taxonomy table
        if (data.description !== undefined || data.parent !== undefined) {
            const updates = [];
            const values = [];

            if (data.description !== undefined) {
                updates.push('description = ?');
                values.push(data.description);
            }
            if (data.parent !== undefined) {
                updates.push('parent = ?');
                values.push(data.parent);
            }

            values.push(term.termTaxonomyId);
            db.prepare(`UPDATE term_taxonomy SET ${updates.join(', ')} WHERE term_taxonomy_id = ?`).run(...values);
        }

        return Term.findById(termId, taxonomy);
    }

    /**
     * Delete a term
     * Equivalent to wp_delete_term()
     */
    static delete(termId, taxonomy) {
        const term = Term.findById(termId, taxonomy);
        if (!term) return false;

        // Delete term relationships
        db.prepare('DELETE FROM term_relationships WHERE term_taxonomy_id = ?').run(term.termTaxonomyId);

        // Delete term taxonomy
        db.prepare('DELETE FROM term_taxonomy WHERE term_taxonomy_id = ?').run(term.termTaxonomyId);

        // Check if term is used in other taxonomies
        const otherTaxonomies = db.prepare('SELECT COUNT(*) as count FROM term_taxonomy WHERE term_id = ?').get(termId);
        if (otherTaxonomies.count === 0) {
            // Delete term if not used elsewhere
            db.prepare('DELETE FROM terms WHERE term_id = ?').run(termId);
        }

        return true;
    }

    /**
     * Count terms
     */
    static count(options = {}) {
        const { taxonomy, hideEmpty = false } = options;

        let sql = 'SELECT COUNT(*) as count FROM term_taxonomy';
        const conditions = [];
        const params = [];

        if (taxonomy) {
            conditions.push('taxonomy = ?');
            params.push(taxonomy);
        }

        if (hideEmpty) {
            conditions.push('count > 0');
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        const row = db.prepare(sql).get(...params);
        return row.count;
    }

    /**
     * Get term hierarchy (for categories)
     */
    static getHierarchy(taxonomy, parentId = 0) {
        const terms = Term.findAll({ taxonomy, parent: parentId });

        return terms.map(term => ({
            ...term.toJSON(),
            children: Term.getHierarchy(taxonomy, term.termId)
        }));
    }
}

module.exports = Term;
