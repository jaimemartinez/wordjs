/**
 * WordJS - Async Database Driver Interface
 * All drivers must implement this contract.
 */

class DatabaseDriverInterface {
    /**
     * Initialize connection to the database
     * @returns {Promise<void>}
     */
    async connect() {
        throw new Error('connect() not implemented');
    }

    /**
     * Execute a query and return a single row
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Promise<Object|undefined>}
     */
    async get(sql, params = []) {
        throw new Error('get() not implemented');
    }

    /**
     * Execute a query and return all rows
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Promise<Array>}
     */
    async all(sql, params = []) {
        throw new Error('all() not implemented');
    }

    /**
     * Execute a query (INSERT, UPDATE, DELETE)
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Promise<Object>} { lastID, changes }
     */
    async run(sql, params = []) {
        throw new Error('run() not implemented');
    }

    /**
     * Execute a raw SQL script (e.g. for migrations)
     * @param {string} sql - SQL script
     * @returns {Promise<void>}
     */
    async exec(sql) {
        throw new Error('exec() not implemented');
    }

    /**
     * Close the database connection
     * @returns {Promise<void>}
     */
    async close() {
        throw new Error('close() not implemented');
    }
}

module.exports = DatabaseDriverInterface;
