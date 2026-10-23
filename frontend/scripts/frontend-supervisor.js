/**
 * What scripts/start-frontend.js does when the Next server (server.js) stops (QA S2-03).
 *
 * It used to `process.exit(code)` whenever server.js closed. A server killed by a signal (an out-of-memory
 * kill, `kill -9`) closes with code null, so the script exited 0, and in split mode `concurrently -k` then
 * stopped the gateway and the backend with it: about a minute of total outage (API, admin, inbound mail)
 * for a frontend crash, while a backend crash costs seconds because backend/server.js restarts it. This is
 * the same policy as that supervisor: a crash is restarted after a delay that doubles with each crash in a
 * row (1 s, 2 s, 4 s … capped at MAX_BACKOFF_MS) and goes back to 1 s once the server has stayed up for
 * STABLE_AFTER_MS; exit code 75 asks for an immediate restart; only a clean exit (0, no signal) — or the
 * supervisor itself being told to stop — ends it.
 */
const MAX_BACKOFF_MS = 30000;
const STABLE_AFTER_MS = 60000;
// server.js exits with this code to be started again with freshly prepared wiring (same as core/restart).
const RESTART_EXIT_CODE = 75;

/** Delay before the next start after `crashes` crashes in a row. */
function backoffMs(crashes) {
    return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, crashes - 1));
}

/**
 * What to do now that server.js closed with `code`/`signal`: 'restart' at once (it asked to), 'crash' (start
 * it again after the back-off), or 'exit' with the given code (it stopped cleanly, or we are stopping).
 */
function nextAction(code, signal, stopping) {
    if (stopping) return { action: 'exit', code: typeof code === 'number' ? code : 0 };
    if (code === RESTART_EXIT_CODE) return { action: 'restart' };
    if (code === 0 && !signal) return { action: 'exit', code: 0 };
    return { action: 'crash' };
}

module.exports = { MAX_BACKOFF_MS, STABLE_AFTER_MS, RESTART_EXIT_CODE, backoffMs, nextAction };
