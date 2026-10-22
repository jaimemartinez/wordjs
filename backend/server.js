/**
 * WordJS - Process Supervisor
 * "The Immortalizer"
 * 
 * This script wraps the main application to provide automatic restart capabilities.
 * It ensures that if the server crashes (e.g. by a bad plugin), it instantly restarts.
 * Combined with CrashGuard, this creates a fully self-healing system.
 */

// Preflight: WordJS needs Node >= 22 (graphql 17 and the native modules declare it; Node 20 is EOL).
// Failing here with a clear message beats a cryptic EBADENGINE/native-binding crash mid-boot.
(() => {
    const maj = Number(process.versions.node.split('.')[0]);
    if (maj < 22) {
        console.error(`\n✖ WordJS requires Node.js >= 22 — you are running ${process.versions.node}.`);
        console.error('  Install Node 22 LTS or 24 LTS (https://nodejs.org) and try again.\n');
        process.exit(1);
    }
})();

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Prefer the COMPILED build (no ts-node in production). `npm run build` emits dist/index.js;
// if it exists we run that. Otherwise fall back to ts-node (dev / not-yet-built convenience).
const DIST_ENTRY = path.join(__dirname, 'dist', 'index.js');
const TS_ENTRY = path.join(__dirname, 'src', 'index.ts');
const RUN_COMPILED = fs.existsSync(DIST_ENTRY);
const APP_ARGS = RUN_COMPILED ? [DIST_ENTRY] : ['-r', 'ts-node/register', TS_ENTRY];
// A crash is restarted after a delay that doubles with each crash in a row (1 s, 2 s, 4 s … capped at
// MAX_BACKOFF_MS) and goes back to 1 s once the app has stayed up for STABLE_AFTER_MS. The supervisor
// used to give up for good after 5 crashes within 10 s and exit — and under a service unit without
// Restart= (or past systemd's own start limit) the node then stayed down until someone logged in.
// A database that drops connections for a minute must cost a minute, never the site.
const MAX_BACKOFF_MS = 30000;
const STABLE_AFTER_MS = 60000;
// The app asks for a restart (a setting it reads at boot changed from the admin panel) by exiting with
// this code: started again at once, and never counted as a crash. Same value as core/restart.ts.
const RESTART_EXIT_CODE = 75;

let consecutiveCrashes = 0;
let startedAt = Date.now();

/** Delay before the next start after `crashes` crashes in a row. */
function backoffMs(crashes) {
    return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, crashes - 1));
}

function startApp() {
    startedAt = Date.now();
    console.log(`🚀 Supervisor: Launching WordJS Core (${RUN_COMPILED ? 'compiled dist/' : 'ts-node'})...`);

    // Spawn the actual server
    const child = spawn('node', APP_ARGS, {
        stdio: 'inherit', // Pipe logs directly to console
        // Pass environment variables, and tell the app a supervisor restarts it (core/restart.ts).
        env: { ...process.env, WORDJS_SUPERVISED: '1' },
        cwd: __dirname
    });

    child.on('exit', (code) => {
        if (code === RESTART_EXIT_CODE) {
            console.log('🔄 Supervisor: App asked for a restart. Starting it again...');
            setTimeout(startApp, 250);
            return;
        }
        if (code === 0) {
            console.log('🛑 Supervisor: App stopped gracefully. Exiting.');
            process.exit(0);
        } else {
            if (Date.now() - startedAt > STABLE_AFTER_MS) consecutiveCrashes = 0;
            consecutiveCrashes++;
            const delay = backoffMs(consecutiveCrashes);

            console.error(`💥 Supervisor: App crashed with exit code ${code}.`);
            console.log(`🔄 Supervisor: Restarting in ${Math.round(delay / 1000)} second(s)` +
                (consecutiveCrashes > 1 ? ` (crash ${consecutiveCrashes} in a row)...` : '...'));
            setTimeout(startApp, delay);
        }
    });

    child.on('error', (err) => {
        console.error('❌ Supervisor: Failed to spawn child process:', err);
    });
}

module.exports = { backoffMs, MAX_BACKOFF_MS, STABLE_AFTER_MS };

// Start the loop (not when a test requires the file for backoffMs).
if (require.main === module) startApp();
