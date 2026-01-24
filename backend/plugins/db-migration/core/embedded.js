const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const config = require('../../../src/config/app');

let embeddedProcess = null;
let isInstalling = false;

// Config for Embedded Instance (Fixed Levels: ../../../ = backend/)
const BASE_DIR = path.resolve(__dirname, '../../../data/postgres-embed');
const DATA_DIR = path.join(BASE_DIR, 'data');
const PORT = 5433; // Avoid default 5432
const VERSION = '14.5.0';

/**
 * Robust directory deletion with retries (for Windows EPERM/EBUSY)
 */
async function nukeDirectoryWithRetry(dir, retries = 5, delay = 1000) {
    if (!fs.existsSync(dir)) return;

    for (let i = 0; i < retries; i++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (e) {
            if (i === retries - 1) throw e;
            console.log(`   ⏳ Directory locked [${e.code}], retrying in ${delay}ms... (${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

exports.getStatus = (req, res) => {
    res.json({
        installed: fs.existsSync(path.join(DATA_DIR, 'postgresql.conf')),
        running: !!embeddedProcess,
        port: PORT,
        isInstalling
    });
};

exports.install = async (req, res) => {
    if (isInstalling) return res.status(409).json({ error: 'Installation in progress' });

    isInstalling = true;
    try {
        console.log('📦 Embedded Postgres: Starting installation...');

        try { require.resolve('embedded-postgres'); } catch (e) {
            console.log('📦 Installing embedded-postgres package...');
            execSync('npm install embedded-postgres --save', { cwd: path.resolve(__dirname, '../../../'), stdio: 'inherit' });
        }

        const EmbeddedPostgres = require('embedded-postgres').default;

        if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });

        // Factory Reset on explicit install
        if (fs.existsSync(DATA_DIR)) {
            console.log('🧹 Cleaning old data directory...');
            await nukeDirectoryWithRetry(DATA_DIR);
        }

        const pg = new EmbeddedPostgres({
            databaseDir: DATA_DIR,
            port: PORT,
            version: VERSION,
            user: 'postgres',
            password: config.db.password,
            authMethod: 'trust'
        });

        console.log('📦 Embedded Postgres: Initializing Cluster (UTF8/C Locale)...');
        // Force UTF8 and C locale
        await pg.initialise(['--locale=C', '--encoding=UTF8']);

        console.log('✅ Embedded Postgres: Installed and Initialized successfully.');
        isInstalling = false;
        res.json({ success: true, message: 'Installation complete' });

    } catch (e) {
        console.error('❌ Install Failed:', e);
        isInstalling = false;
        res.status(500).json({ error: e.message });
    }
};

// Internal Start Logic
async function startServer() {
    if (embeddedProcess) return { success: true, message: 'Already running' };

    try {
        const EmbeddedPostgres = require('embedded-postgres').default;
        const { Client } = require('pg');

        // Helper to spin up the instance
        const boot = async () => {
            const pg = new EmbeddedPostgres({
                databaseDir: DATA_DIR,
                port: PORT,
                user: 'postgres',
                password: config.db.password,
                authMethod: 'trust'
            });
            await pg.start();
            return pg;
        };

        console.log('🚀 Embedded Postgres: Starting internal...');
        let pg = await boot();
        embeddedProcess = pg;

        // Auto-Setup & Self-Heal Logic
        try {
            let client = new Client({ host: 'localhost', port: PORT, user: 'postgres', password: config.db.password, database: 'postgres' });
            try {
                await client.connect();
            } catch (err) {
                // Fallback to old password for sync if necessary
                client = new Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'password', database: 'postgres' });
                await client.connect();
            }

            // Sync internal password
            await client.query(`ALTER USER postgres WITH PASSWORD '${config.db.password}'`);

            const resEnc = await client.query("SHOW SERVER_ENCODING");
            const encoding = resEnc.rows[0].server_encoding;
            console.log('   Server Encoding:', encoding);
            await client.end();

            // SELF-HEAL: If WIN1252, Nuke and Re-Init
            if (encoding !== 'UTF8') {
                console.log('   ⚠️ Incompatible Encoding detected (WIN1252). Performing Auto-Fix to UTF8...');

                await pg.stop();
                embeddedProcess = null;

                // Wait for Windows to release file handles
                console.log('   ⏳ Waiting for OS to release file handles...');
                await new Promise(resolve => setTimeout(resolve, 1500));

                // Nuke
                await nukeDirectoryWithRetry(DATA_DIR);

                // Re-Init
                const pgInit = new EmbeddedPostgres({
                    databaseDir: DATA_DIR,
                    port: PORT,
                    version: VERSION,
                    user: 'postgres',
                    password: 'password',
                    authMethod: 'trust'
                });
                await pgInit.initialise(['--locale=C', '--encoding=UTF8']);
                console.log('   ✅ Re-initialized with UTF8.');

                // Restart
                pg = await boot();
                embeddedProcess = pg;
            }

            // Create DB (Guaranteed to be UTF8 compliant now)
            client = new Client({ host: 'localhost', port: PORT, user: 'postgres', password: config.db.password, database: 'postgres' });
            await client.connect();
            const resDb = await client.query("SELECT 1 FROM pg_database WHERE datname='wordjs'");
            if (resDb.rowCount === 0) {
                await client.query("CREATE DATABASE wordjs"); // Encoding inherits from template1 (now UTF8)
                console.log('   Created database: wordjs');
            }
            await client.end();

        } catch (dbErr) {
            console.error('   ❌ DB Auto-Setup Error:', dbErr.message);
        }

        return { success: true };
    } catch (e) {
        console.error('❌ Start Failed:', e);
        throw e;
    }
}

exports.startServer = startServer;

exports.start = async (req, res) => {
    try {
        await startServer();
        res.json({ success: true, message: 'Server started' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.stop = async (req, res) => {
    if (!embeddedProcess) return res.json({ success: true, message: 'Not running' });

    try {
        await embeddedProcess.stop();
        embeddedProcess = null;
        res.json({ success: true, message: 'Server stopped' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
