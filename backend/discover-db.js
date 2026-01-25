const { startServer, stopServer } = require('./src/core/embedded-db');
const { Client } = require('pg');
const config = require('./src/config/app');

async function discover() {
    console.log('Starting server...');
    const started = await startServer();
    if (!started) {
        console.error('Failed to start server');
        return;
    }

    try {
        const client = new Client({
            host: 'localhost',
            port: 5433,
            user: 'postgres',
            password: config.db.password,
            database: 'postgres'
        });
        await client.connect();
        const res = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false');
        console.log('Found databases:', res.rows.map(r => r.datname));
        await client.end();
    } catch (e) {
        console.error('Query error:', e.message);
    } finally {
        // We don't stop immediately to allow inspection if needed, but for the task we can.
        // await stopServer();
    }
}

discover().catch(console.error);
