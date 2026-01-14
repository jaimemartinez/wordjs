/**
 * WordJS - Email Database Configuration
 * Separate SQLite database for storing received emails.
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./app');

let dbInstance = null;
let SQL = null;

const EMAIL_DB_PATH = path.resolve('./data/emails.sqlite');

/**
 * Initialize SQL.js and load/create email database
 */
async function initEmailDb() {
    if (dbInstance) return dbInstance;

    SQL = await initSqlJs();

    // Ensure data directory exists
    const dbDir = path.dirname(EMAIL_DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    // Load existing database or create new one
    if (fs.existsSync(EMAIL_DB_PATH)) {
        const buffer = fs.readFileSync(EMAIL_DB_PATH);
        dbInstance = new SQL.Database(buffer);
    } else {
        dbInstance = new SQL.Database();
    }

    // Enable foreign keys
    dbInstance.run('PRAGMA foreign_keys = ON;');

    // Initialize Schema
    initializeEmailSchema(dbInstance);

    return dbInstance;
}

/**
 * Save email database to file
 */
function saveEmailDatabase() {
    if (!dbInstance) return;
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(EMAIL_DB_PATH, buffer);
}

/**
 * Initialize email schema
 */
function initializeEmailSchema(db) {
    db.run(`
        CREATE TABLE IF NOT EXISTS received_emails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT,
            from_address TEXT,
            from_name TEXT,
            to_address TEXT,
            subject TEXT,
            body_text TEXT,
            body_html TEXT,
            date_received TEXT DEFAULT CURRENT_TIMESTAMP,
            is_read INTEGER DEFAULT 0,
            is_sent INTEGER DEFAULT 0,
            raw_content TEXT,
            parent_id INTEGER DEFAULT 0,
            thread_id INTEGER DEFAULT 0
        )
    `);

    // Migration: Add columns if they don't exist
    try {
        const tableInfo = db.exec("PRAGMA table_info(received_emails)");
        const columns = tableInfo[0].values.map(v => v[1]);

        if (!columns.includes('is_sent')) {
            db.run("ALTER TABLE received_emails ADD COLUMN is_sent INTEGER DEFAULT 0");
            console.log('   ✓ Migration: added is_sent column');
        }
        if (!columns.includes('parent_id')) {
            db.run("ALTER TABLE received_emails ADD COLUMN parent_id INTEGER DEFAULT 0");
            console.log('   ✓ Migration: added parent_id column');
        }
        if (!columns.includes('thread_id')) {
            db.run("ALTER TABLE received_emails ADD COLUMN thread_id INTEGER DEFAULT 0");
            console.log('   ✓ Migration: added thread_id column');
        }
    } catch (e) {
        console.error('Migration check failed:', e.message);
    }

    saveEmailDatabase();
}

/**
 * Get database instance
 */
function getEmailDb() {
    if (!dbInstance) {
        throw new Error('Email database not initialized. Call initEmailDb() first.');
    }
    return new EmailDatabaseWrapper(dbInstance);
}

class EmailDatabaseWrapper {
    constructor(sqlDb) {
        this.sqlDb = sqlDb;
    }

    prepare(sql) {
        return new EmailStatementWrapper(this.sqlDb, sql);
    }

    exec(sql) {
        this.sqlDb.run(sql);
        saveEmailDatabase();
    }
}

class EmailStatementWrapper {
    constructor(sqlDb, sql) {
        this.sqlDb = sqlDb;
        this.sql = sql;
    }

    run(...params) {
        this.sqlDb.run(this.sql, params);
        const lastId = this.sqlDb.exec('SELECT last_insert_rowid() as id')[0];
        saveEmailDatabase();
        return { lastInsertRowid: lastId?.values?.[0]?.[0] || 0 };
    }

    get(...params) {
        const stmt = this.sqlDb.prepare(this.sql);
        stmt.bind(params);
        if (stmt.step()) {
            const columns = stmt.getColumnNames();
            const values = stmt.get();
            stmt.free();
            const row = {};
            columns.forEach((col, i) => row[col] = values[i]);
            return row;
        }
        stmt.free();
        return undefined;
    }

    all(...params) {
        const results = [];
        const stmt = this.sqlDb.prepare(this.sql);
        stmt.bind(params);
        const columns = stmt.getColumnNames();
        while (stmt.step()) {
            const values = stmt.get();
            const row = {};
            columns.forEach((col, i) => row[col] = values[i]);
            results.push(row);
        }
        stmt.free();
        return results;
    }
}

const emailDbProxy = new Proxy({}, {
    get(target, prop) {
        const db = getEmailDb();
        return db[prop].bind(db);
    }
});

module.exports = {
    initEmailDb,
    getEmailDb,
    emailDb: emailDbProxy
};
