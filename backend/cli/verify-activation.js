const path = require('path');
const fs = require('fs');

// Path fix: Ensure PLUGINS_DIR resolve() works correctly inside the core
process.chdir(path.resolve(__dirname, 'backend'));

const { loadActivePlugins, isPluginActive } = require('../src/core/plugins');
const { init: initDb, initializeDatabase } = require('../src/config/database');
const { setApp } = require('../src/core/appRegistry');
const express = require('express');

async function verifyActivation() {
    console.log('--- Full Boot Loader Verifier ---');
    console.log('CWD:', process.cwd());

    // 1. Setup minimal environment
    console.log('Initializing database...');
    await initDb();
    await initializeDatabase();

    const app = express();
    setApp(app);

    // 2. Load all active plugins
    console.log('Loading active plugins...');
    try {
        await loadActivePlugins();

        const active = await isPluginActive('mail-server');
        console.log(`Is 'mail-server' active in DB? ${active}`);

        console.log('\n--- SUCCESS: All active plugins loaded without security blocks! ---');
    } catch (e) {
        console.error('\n--- FAILED: Boot sequence blocked! ---');
        console.error(e.message);
        process.exit(1);
    }
}

verifyActivation();
