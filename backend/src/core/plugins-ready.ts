/**
 * WordJS - Plugin-route readiness
 *
 * Whether THIS process hands /api/v1/plugin/* requests on to the routes plugins registered. Until it
 * does, index.ts answers them 503 `plugins_starting` (+ Retry-After) — an honest "not yet" instead of a
 * 404 that reads as "this endpoint does not exist".
 *
 * Two moments release it, both one-way and per process:
 *   · the boot of an INSTALLED site — index.ts initialize(), once loadActivePlugins() has forked every
 *     active isolate and fixMiddlewareOrder() has put their routes ahead of the 404 handler;
 *   · a fresh install — POST /setup/install, in a process that booted UNINSTALLED (setup mode). That
 *     boot loads no plugins (there is no site yet), so nothing is starting. When only the boot released
 *     it, the guard stayed shut until a restart, and every plugin activated after the wizard answered
 *     503 plugins_starting forever.
 *
 * A module of its own, not a variable in index.ts, because routes/setup.ts has to reach it and index.ts
 * is what requires the routers.
 */

let ready = false;

/** Whether plugin routes are served (true) or answered 503 plugins_starting (false). */
function arePluginsReady(): boolean {
    return ready;
}

/** Plugin routes are served from now on. Idempotent; never reset in the life of the process. */
function markPluginsReady(): void {
    ready = true;
}

module.exports = { arePluginsReady, markPluginsReady };
