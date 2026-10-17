#!/usr/bin/env node
'use strict';
/**
 * `npm run media -- <command>` — move the media library between local disk and the S3-compatible
 * media store configured in the `mediaStorage` block of wordjs-config.json (core/media-storage).
 *
 *   status                         the effective configuration (credentials masked), the library state
 *                                  and the last migration's progress
 *   test                           write, read and delete a probe object (the public-URL check runs
 *                                  from a browser: Settings → Media storage → Test connection)
 *   offload [--delete-local] [--restart] [--limit N]
 *                                  copy every public attachment's files to the bucket; with
 *                                  --delete-local, remove each local copy once its object verified
 *   restore [--restart] [--limit N]
 *                                  copy them back to local disk (nothing is deleted from the bucket)
 *
 * Both moves are idempotent (an item already where it should be is skipped) and resumable (an
 * interrupted run continues from its last finished item; --restart walks from the start again). Only
 * one runs at a time, across every node and the admin screen.
 *
 * Mirrors scripts/migrate.js: compiled dist/ when present, ts-node on src/ otherwise.
 */
const path = require('path');
const fs = require('fs');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND); // config / data / uploads resolve relative to backend/, like a normal boot
// stdout is this command's output (`status` prints JSON meant for jq): the backend modules it loads
// log to stderr instead (core/logger).
process.env.WORDJS_LOG_TO_STDERR = '1';
// Not as root in an install another account owns: the database files and uploads it writes would lock
// the service out (scripts/install-owner.js).
if (require.main === module) {
    const owner = require('./install-owner');
    const args = process.argv.slice(2);
    if (!args.includes('-h') && !args.includes('--help') && args[0] !== 'help') owner.refuseRootInForeignInstall(BACKEND, owner.scriptHint(__filename, args));
}

const USAGE = [
    'Usage: npm run media -- <command> [options]',
    '',
    '  status                                   configuration, state and progress',
    '  test                                     write, read and delete a probe object in the bucket',
    '  offload [--delete-local] [--restart] [--limit N]',
    '  restore [--restart] [--limit N]',
    '',
    'On a network of sites, every command works on the main site.',
].join('\n');

function parseArgs(argv) {
    const out = { command: null, deleteLocal: false, restart: false, limit: 0 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--delete-local') out.deleteLocal = true;
        else if (a === '--restart') out.restart = true;
        else if (a === '--limit') {
            out.limit = Number(argv[++i]);
            if (!Number.isInteger(out.limit) || out.limit < 1) throw new Error('--limit needs a positive integer');
        } else if (a === '-h' || a === '--help') out.command = 'help';
        else if (!out.command) out.command = a;
        else throw new Error(`unexpected argument: ${a}`);
    }
    return out;
}

const useDist = fs.existsSync(path.join(BACKEND, 'dist', 'core', 'media-storage.js'));
if (!useDist) {
    require(require.resolve('ts-node', { paths: [BACKEND] })).register({ project: path.join(BACKEND, 'tsconfig.json'), transpileOnly: true });
}
const mod = (rel) => useDist ? require(path.join(BACKEND, 'dist', rel + '.js')) : require(path.join(BACKEND, 'src', rel));

// On a network (multisite) every read of site data needs a site context, and a CLI process has none:
// without one, `status` failed with "No site context". The media library this command manages is the
// main site's, so the work runs as site 1 (a no-op on a single-site install).
const runAsMainSite = (fn) => {
    const site = mod('core/site-context');
    return site.runWithSite(site.PRIMARY_SITE_ID, fn);
};

runAsMainSite(async () => {
    let args;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n\n${USAGE}`); process.exit(2); }
    if (!args.command || args.command === 'help') { console.log(USAGE); process.exit(args.command ? 0 : 2); }
    if (!['status', 'test', 'offload', 'restore'].includes(args.command)) { console.error(`Unknown command: ${args.command}\n\n${USAGE}`); process.exit(2); }
    try {
        const { isInstalled } = mod('core/configManager');
        if (!isInstalled()) { console.error('Not installed yet — complete the install wizard first.'); process.exit(1); }
        const storage = mod('core/media-storage');
        if (args.command === 'test') {
            const store = storage.resolveMediaStorage();
            if (store.driver !== 's3') { console.error(`S3 media storage is not configured${store.incomplete ? ` (missing or invalid: ${store.incomplete.join(', ')})` : ''}.`); process.exit(1); }
            const { testConnection } = mod('routes/media-storage');
            const r = await testConnection(store);
            for (const s of r.steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step.padEnd(7)} ${s.detail}`);
            console.log(`Public URL: ${store.publicBase} — check it from a browser (Settings → Media storage → Test connection).`);
            process.exit(r.ok ? 0 : 1);
        }
        const { init } = mod('config/database');
        await init();
        const migration = mod('core/media-storage-migrate');
        if (args.command === 'status') {
            console.log(JSON.stringify({
                ...storage.describeForAdmin(),
                state: await migration.getState(),
                inBucket: await migration.countOffloaded(),
                migration: await migration.getProgress(),
            }, null, 2));
            process.exit(0);
        }
        let last = 0;
        const result = await migration.runMigration(args.command, {
            deleteLocal: args.deleteLocal,
            restart: args.restart,
            limit: args.limit || undefined,
            onProgress: (p) => {
                const now = Date.now();
                if (now - last < 1000 && p.processed !== p.total) return;
                last = now;
                console.log(`${p.direction}: ${p.processed}/${p.total} processed, ${p.moved} moved, ${p.skipped} skipped, ${p.failed} failed`);
            },
        });
        console.log(`${result.direction} ${result.status}: ${result.moved} moved, ${result.skipped} skipped, ${result.failed} failed.`);
        for (const f of result.failures || []) console.log(`  #${f.id}: ${f.error}`);
        if (result.status === 'running') console.log('Stopped at --limit; run the same command again to continue.');
        console.log(`Library state: ${await migration.getState()}`);
        process.exit(result.status === 'done' || result.status === 'running' ? 0 : 1);
    } catch (e) {
        console.error(e && e.message ? e.message : e);
        process.exit(1);
    }
});
