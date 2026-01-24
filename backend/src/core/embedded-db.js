/**
 * WordJS - Embedded Database Manager
 * Wraps 'embedded-postgres' to provide a zero-config PG experience.
 */

const path = require('path');
const fs = require('fs');

let pgServer = null;

const DATA_DIR = path.resolve('./data/postgres-embed/data');

async function startServer() {
    try {
        const EmbeddedPostgres = require('embedded-postgres').default;

        console.log('🐘 Embedded PG: Initializing...');

        const config = require('../config/app');
        const { Client } = require('pg');

        pgServer = new EmbeddedPostgres({
            databaseDir: DATA_DIR,
            port: 5433,
            user: 'postgres',
            password: config.db.password,
            dbName: 'wordjs',
            persistent: true
        });

        // Ensure init
        if (!fs.existsSync(DATA_DIR)) {
            console.log('🐘 Embedded PG: First run detected. Creating cluster (UTF8/C)...');
            // Force UTF8 and C locale on first run to avoid WIN1252 issues
            await pgServer.initialise(['--locale=C', '--encoding=UTF8']);
        }

        await pgServer.start();
        console.log('✅ Embedded PG: Started on port 5433');

        // SYNC: Ensure the internal DB password matches the config
        try {
            const client = new Client({
                host: 'localhost',
                port: 5433,
                user: 'postgres',
                password: config.db.password,
                database: 'postgres'
            });
            await client.connect();
            await client.query(`ALTER USER postgres WITH PASSWORD '${config.db.password}'`);
            await client.end();
            console.log('🔐 Embedded PG: Password synchronized.');
        } catch (syncErr) {
            // If the above fails, it might be using the old "password"
            try {
                const clientFallback = new Client({
                    host: 'localhost',
                    port: 5433,
                    user: 'postgres',
                    password: 'password',
                    database: 'postgres'
                });
                await clientFallback.connect();
                await clientFallback.query(`ALTER USER postgres WITH PASSWORD '${config.db.password}'`);
                await clientFallback.end();
                console.log('🔐 Embedded PG: Password synchronized (from fallback).');
            } catch (innerErr) {
                console.warn('⚠️  Embedded PG: Could not sync password:', innerErr.message);
            }
        }

        // Handle graceful shutdown
        process.on('SIGTERM', stopServer);
        process.on('SIGINT', stopServer);

        return true;
    } catch (e) {
        console.error('❌ Embedded PG Error:', e.message);
        return false;
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
