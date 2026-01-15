/**
 * WordJS - Process Supervisor
 * "The Immortalizer"
 * 
 * This script wraps the main application to provide automatic restart capabilities.
 * It ensures that if the server crashes (e.g. by a bad plugin), it instantly restarts.
 * Combined with CrashGuard, this creates a fully self-healing system.
 */

const { spawn } = require('child_process');
const path = require('path');

const APP_ENTRY = path.join(__dirname, 'src/index.js');
const MAX_RESTARTS_FAST = 5;
const FAST_RESET_TIME = 10000; // 10 seconds

let restartCount = 0;
let lastRestart = Date.now();

function startApp() {
    console.log('🚀 Supervisor: Launching WordJS Core...');

    // Spawn the actual server
    const child = spawn('node', [APP_ENTRY], {
        stdio: 'inherit', // Pipe logs directly to console
        env: process.env, // Pass environment variables
        cwd: __dirname
    });

    child.on('exit', (code) => {
        if (code === 0) {
            console.log('🛑 Supervisor: App stopped gracefully. Exiting.');
            process.exit(0);
        } else {
            const now = Date.now();
            if (now - lastRestart > FAST_RESET_TIME) {
                // Reset counter if it's been a while
                restartCount = 0;
            }

            lastRestart = now;
            restartCount++;

            console.error(`💥 Supervisor: App crashed with exit code ${code}.`);

            if (restartCount > MAX_RESTARTS_FAST) {
                console.error('🔥 Supervisor: Too many crashes in short time. Giving up.');
                process.exit(1);
            }

            console.log('🔄 Supervisor: Restarting in 1 second...');
            setTimeout(startApp, 1000);
        }
    });

    child.on('error', (err) => {
        console.error('❌ Supervisor: Failed to spawn child process:', err);
    });
}

// Start the loop
startApp();
