/**
 * WordJS - FormSubmission model (form_submissions table, migration 0007).
 *
 * One row per public form POST (Webflow "Forms + submissions" parity). The route layer owns ALL input
 * validation/sanitization (bounds, honeypot, tag-stripping) — by the time a payload reaches create()
 * it is already a clean, bounded map. `fields` is stored as a JSON string and parsed back on read;
 * a row whose JSON somehow fails to parse is surfaced with an empty map rather than throwing, so one
 * corrupt row can never take down the admin listing.
 */

const { dbAsync } = require('../config/database');

function toDisplay(row: any) {
    let fields: Record<string, string> = {};
    try { fields = JSON.parse(row.fields || '{}'); } catch { /* corrupt row → empty map */ }
    return {
        id: row.id,
        formName: row.form_name,
        pageId: row.page_id != null ? Number(row.page_id) : null,
        fields,
        ip: row.ip || '',
        userAgent: row.user_agent || '',
        createdAt: row.created_at
    };
}

class FormSubmission {
    static async create(opts: { formName: string; pageId?: number | null; fields: Record<string, string>; ip?: string; userAgent?: string }) {
        const result = await dbAsync.run(
            `INSERT INTO form_submissions (form_name, page_id, fields, ip, user_agent)
             VALUES (?, ?, ?, ?, ?) RETURNING id`,
            [
                String(opts.formName),
                opts.pageId != null ? opts.pageId : null,
                JSON.stringify(opts.fields || {}),
                String(opts.ip || ''),
                // MySQL maps user_agent to VARCHAR(255) — bound it here so an oversized UA can never fail the INSERT.
                String(opts.userAgent || '').slice(0, 255)
            ]
        );
        const row = await dbAsync.get('SELECT * FROM form_submissions WHERE id = ?', [result.lastID]);
        return row ? toDisplay(row) : null;
    }

    static async findById(id: number) {
        const row = await dbAsync.get('SELECT * FROM form_submissions WHERE id = ?', [id]);
        return row ? toDisplay(row) : null;
    }

    /** Newest-first page of submissions, optionally filtered to one form. */
    static async findAll(opts: { formName?: string; limit?: number; offset?: number } = {}) {
        const where: string[] = [];
        const params: any[] = [];
        if (opts.formName !== undefined) { where.push('form_name = ?'); params.push(String(opts.formName)); }
        const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        const limit = Number.isInteger(opts.limit) ? opts.limit : 20;
        const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
        const rows = await dbAsync.all(
            `SELECT * FROM form_submissions${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        return (rows || []).map(toDisplay);
    }

    static async count(opts: { formName?: string } = {}): Promise<number> {
        const where: string[] = [];
        const params: any[] = [];
        if (opts.formName !== undefined) { where.push('form_name = ?'); params.push(String(opts.formName)); }
        const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        const row = await dbAsync.get(`SELECT COUNT(*) AS c FROM form_submissions${whereSql}`, params);
        return row ? Number(row.c) : 0;
    }

    static async delete(id: number): Promise<boolean> {
        const result = await dbAsync.run('DELETE FROM form_submissions WHERE id = ?', [id]);
        return !!(result && (result.changes > 0 || result.rowCount > 0));
    }

    /** DISTINCT form names with submission counts (the admin viewer's form picker). */
    static async names(): Promise<Array<{ formName: string; count: number }>> {
        const rows = await dbAsync.all(
            'SELECT form_name, COUNT(*) AS c FROM form_submissions GROUP BY form_name ORDER BY c DESC, form_name ASC'
        );
        return (rows || []).map((r: any) => ({ formName: r.form_name, count: Number(r.c) }));
    }
}

module.exports = FormSubmission;
