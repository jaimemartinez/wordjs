const { Client } = require('pg');

async function discover() {
    console.log('Connecting to running server...');
    const pass = '13bd4885b906dba4698605081d2cab02'; // From config root

    try {
        const adminClient = new Client({
            host: 'localhost',
            port: 5433,
            user: 'postgres',
            password: pass,
            database: 'postgres'
        });
        await adminClient.connect();
        const dbRes = await adminClient.query('SELECT datname FROM pg_database WHERE datistemplate = false');
        const databases = dbRes.rows.map(r => r.datname);
        console.log('Found databases:', databases);

        for (const dbName of databases) {
            console.log(`--- Checking DB: ${dbName} ---`);
            const client = new Client({
                host: 'localhost',
                port: 5433,
                user: 'postgres',
                password: pass,
                database: dbName
            });
            try {
                await client.connect();
                const tableRes = await client.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname != \'pg_catalog\' AND schemaname != \'information_schema\'');
                console.log(`Tables in ${dbName}:`, tableRes.rows.map(r => r.tablename).join(', '));
                await client.end();
            } catch (err) {
                console.error(`Error checking ${dbName}:`, err.message);
            }
        }
        await adminClient.end();
    } catch (e) {
        console.error('Core error:', e.message);
    }
}

discover().catch(console.error);
