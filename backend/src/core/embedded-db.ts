const path = require('path');
const fs = require('fs');

let pgServer = null;

const DATA_DIR = path.resolve('./data/postgres-embed/data');
const PID_FILE = path.join(DATA_DIR, 'postmaster.pid');
const HBA_FILE = path.join(DATA_DIR, 'pg_hba.conf');

async function startServer() {
    try {
        const EmbeddedPostgres = require('embedded-postgres').default;

        console.log('🐘 Embedded PG: Initializing...');

        // 🛡️ GESTIÓN DE BLOQUEOS: Detect and remove stale PID file
        if (fs.existsSync(PID_FILE)) {
            console.log('🛡️  Embedded PG: Stale postmaster.pid found. Cleaning up...');
            try {
                fs.unlinkSync(PID_FILE);
            } catch (err) {
                console.error('❌ Could not remove stale PID file:', err.message);
            }
        }

        const config = require('../config/app');
        const { Client } = require('pg');

        pgServer = new EmbeddedPostgres({
            databaseDir: DATA_DIR,
            port: 5433,
            user: 'postgres',
            password: config.db.password,
            dbName: 'postgres', // Start with system DB for admin tasks
            persistent: true
        });

        // Ensure init
        if (!fs.existsSync(DATA_DIR)) {
            console.log('🐘 Embedded PG: First run detected. Creating cluster (UTF8/C)...');
            await pgServer.initialise(['--locale=C', '--encoding=UTF8']);
        }

        await pgServer.start();
        console.log('✅ Embedded PG: Started on port 5433');

        // 🔐 SINCRONIZACIÓN AUTOMÁTICA
        await synchronizePassword(config.db.password);

        // Handle graceful shutdown
        process.on('SIGTERM', stopServer);
        process.on('SIGINT', stopServer);

        return true;
    } catch (e) {
        console.error('❌ Embedded PG Error:', e.message);
        return false;
    }
}

/**
 * Robustly ensure the DB password matches wordjs-config.json
 */
async function synchronizePassword(targetPassword) {
    const { Client } = require('pg');
    const syncOptions = {
        host: 'localhost',
        port: 5433,
        user: 'postgres',
        database: 'postgres'
    };

    const trySync = async (password) => {
        const client = new Client({ ...syncOptions, password });
        await client.connect();
        await client.query(`ALTER USER postgres WITH PASSWORD '${targetPassword}'`);
        await client.end();
    };

    try {
        // 1. Try with current config password
        await trySync(targetPassword);
        console.log('🔐 Embedded PG: Password is already synchronized.');
    } catch (err) {
        try {
            // 2. Try with default fallback
            await trySync('password');
            console.log('🔐 Embedded PG: Password synchronized from default.');
        } catch (err2) {
            console.warn('⚠️  Embedded PG: Authentication failed. Attempting self-healing recovery...');

            // 3. INTERNAL RECOVERY: Trust-Update-Revert
            try {
                await pgServer.stop();

                // Switch to trust
                if (fs.existsSync(HBA_FILE)) {
                    let hba = fs.readFileSync(HBA_FILE, 'utf8');
                    const originalHba = hba;
                    hba = hba.replace(/password/g, 'trust').replace(/md5/g, 'trust');
                    fs.writeFileSync(HBA_FILE, hba);

                    await pgServer.start();
                    await trySync(undefined); // Connect without password
                    await pgServer.stop();

                    // Restore original HBA
                    fs.writeFileSync(HBA_FILE, originalHba);
                    await pgServer.start();
                    console.log('✨ Embedded PG: Self-healing complete. Password synchronized securely.');
                }
            } catch (recoveryErr) {
                console.error('❌ Embedded PG: Self-healing failed:', recoveryErr.message);
            }
        }
    }
}

async function stopServer() {
    if (pgServer) {
        console.log('🐘 Embedded PG: Stopping...');
        try {
            await pgServer.stop();
        } catch (e) {
            console.error('⚠️ Could not stop embedded PG:', e.message);
        }
    }
}

async function isInstalled() {
    try {
        require.resolve('embedded-postgres');
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    startServer,
    stopServer,
    isInstalled
};
