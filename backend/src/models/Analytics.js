const { dbAsync } = require('../config/database'); // Use generic DB wrapper
const { v4: uuidv4 } = require('uuid');

class Analytics {
    constructor() {
        this.tableName = 'wordjs_analytics';
        // Auto-init removed to prevent race condition
    }

    async init() {

        // Use dbAsync directly
        // Simple schema: One row per event or aggregated? 
        // For Scale: Aggregated by hour/day is better. 
        // For MVP: Log events (id, type, target, ip, timestamp)

        await dbAsync.run(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                id VARCHAR(36) PRIMARY KEY,
                type VARCHAR(50) NOT NULL, -- 'page_view', 'api_call', 'engagement'
                resource VARCHAR(255), -- '/hello-world' or 'post_123'
                visitor_ip VARCHAR(64), -- Anonymized hash likely
                user_id VARCHAR(36), -- NULL if guest
                metadata TEXT, -- JSON extra data
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Index for faster range queries
        await dbAsync.run(`CREATE INDEX IF NOT EXISTS idx_analytics_date ON ${this.tableName}(created_at)`);
    }

    /**
     * Track an event
     */
    async track({ type, resource, user_id = null, ip = null, metadata = {} }) {
        const id = uuidv4();

        await dbAsync.run(
            `INSERT INTO ${this.tableName} (id, type, resource, visitor_ip, user_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [id, type, resource, ip, user_id, JSON.stringify(metadata)]
        );

        return id;
    }

    /**
     * Get aggregated stats for a period
     * @param {string} period 'weekly' | 'monthly'
     */
    async getStats(period = 'weekly') {
        const days = period === 'weekly' ? 7 : 30;

        // SQLite/Postgres syntax difference handling might be needed in core/database, 
        // but assuming standard SQL for now or DB wrapper handles it.
        // Let's use JS processing for safety across drivers for now if specific date functions differ too much.

        const result = await dbAsync.all(`
            SELECT 
                created_at, 
                type 
            FROM ${this.tableName} 
            WHERE created_at > datetime('now', '-${days} days')
        `);

        // Process in JS to ensure format matches Recharts expectation
        // Group by Day
        const grouped = {};

        result.forEach(row => {
            const date = new Date(row.created_at).toLocaleDateString(undefined, { weekday: 'short' }); // "Mon", "Tue"
            // For Monthly: maybe use date number?

            if (!grouped[date]) grouped[date] = { traffic: 0, engagement: 0 };

            if (row.type === 'page_view') grouped[date].traffic++;
            else grouped[date].engagement++; // 'comment', 'login', etc
        });

        return Object.keys(grouped).map(key => ({
            name: key,
            ...grouped[key]
        }));
    }
}

module.exports = new Analytics();
