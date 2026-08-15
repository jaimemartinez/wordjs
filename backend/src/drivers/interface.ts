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
    async get(sql: string, params = []) {
        throw new Error('get() not implemented');
    }

    /**
     * Execute a query and return all rows
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Promise<Array>}
     */
    async all(sql: string, params = []) {
        throw new Error('all() not implemented');
    }

    /**
     * Execute a query (INSERT, UPDATE, DELETE)
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Promise<Object>} { lastID, changes }
     */
    async run(sql: string, params = []) {
        throw new Error('run() not implemented');
    }

    /**
     * Execute a raw SQL script (e.g. for migrations)
     * @param {string} sql - SQL script
     * @returns {Promise<void>}
     */
    async exec(sql: string) {
        throw new Error('exec() not implemented');
    }

    /**
     * Run an atomic transaction. The callback receives a `tx` with get/all/run/exec bound to a
     * SINGLE underlying connection; BEGIN/COMMIT wrap the callback and any throw triggers ROLLBACK.
     * @param {(tx: { get: Function, all: Function, run: Function, exec: Function }) => Promise<any>} fn
     * @returns {Promise<any>} the value returned by fn
     */
    async transaction(fn: (tx: { get: (...a: any[]) => any; all: (...a: any[]) => any; run: (...a: any[]) => any; exec: (...a: any[]) => any }) => Promise<any>) {
        throw new Error('transaction() not implemented');
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
