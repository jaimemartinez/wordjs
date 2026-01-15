/**
 * WordJS - Embedded Database Manager
 * Wraps 'embedded-postgres' to provide a zero-config PG experience.
 */

const path = require('path');
const fs = require('fs');

let pgServer = null;

const DATA_DIR = path.resolve('./data/pg-embedded');

async function startServer() {
    try {
        const { EmbeddedPostgres } = require('embedded-postgres');

        console.log('🐘 Embedded PG: Initializing...');

        pgServer = new EmbeddedPostgres({
            databaseDir: DATA_DIR,
            port: 5433,
            user: 'postgres',
            password: 'password',
            dbName: 'wordjs',
            persistent: true
        });

        // Ensure init
        if (!fs.existsSync(DATA_DIR)) {
            console.log('🐘 Embedded PG: First run detected. Creating cluster...');
            await pgServer.initialise();
        }

        await pgServer.start();
        console.log('✅ Embedded PG: Started on port 5433');

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
