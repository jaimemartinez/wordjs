#!/usr/bin/env node
/**
 * WordJS - the plugin sandbox's host-level settings, from the command line.
 *
 * The admin panel does this (Site Health). This is the second path, for a server whose panel cannot be
 * reached or a checkout that is being removed:
 *
 *   status          what Site Health reports for the sandbox on this host
 *   windows-network apply the Windows "private network ranges for apps" (asks for an administrator)
 *   retire-all      remove every Windows AppContainer profile this install created, and their ACEs.
 *                   Run it BEFORE deleting an install or a git worktree: a profile is a per-user
 *                   registration and its ACEs live on folders the install may share through a junction.
 *
 * Prefers compiled dist/ and falls back to ts-node on src/, like the other one-shot scripts.
 */
const path = require('path');
const fs = require('fs');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND);
process.env.WORDJS_LOG_TO_STDERR = '1';

const useDist = fs.existsSync(path.join(BACKEND, 'dist', 'core', 'sandbox-windows.js'));
if (!useDist) {
    require(require.resolve('ts-node', { paths: [BACKEND] })).register({ project: path.join(BACKEND, 'tsconfig.json'), transpileOnly: true });
}
const mod = (rel) => useDist ? require(path.join(BACKEND, 'dist', rel + '.js')) : require(path.join(BACKEND, 'src', rel));

const USAGE = [
    'Usage: npm run sandbox -- <command>',
    '',
    '  status            the sandbox settings Site Health reports for this host',
    '  windows-network   apply the Windows private network ranges for apps (administrator prompt)',
    '  retire-all        remove every AppContainer profile of this install (before deleting it or a worktree)',
].join('\n');

async function main(argv) {
    const cmd = argv[0];
    const win = mod('core/sandbox-windows');
    if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { console.log(USAGE); return 0; }
    if (cmd === 'status') {
        const net = win.readNetworkIsolationPolicy();
        console.log(JSON.stringify({ platform: process.platform, windowsNetworkRanges: net }, null, 2));
        return 0;
    }
    if (cmd === 'windows-network') {
        if (process.platform !== 'win32') { console.error('Only Windows needs this.'); return 1; }
        const r = await win.applyNetworkIsolationPolicy();
        if (r.ok) { console.log('The private network ranges for apps are set.'); return 0; }
        console.error(`Not applied (${r.reason}). Run this once in an administrator PowerShell:\n${r.command}`);
        return 1;
    }
    if (cmd === 'retire-all') {
        if (process.platform !== 'win32') { console.log('Nothing to do: only Windows keeps sandbox profiles.'); return 0; }
        const { siteStorageSlug } = mod('core/sandbox-paths');
        const keys = new Set(win.listProfileGenerations(BACKEND));
        // Installed plugins and themes too: a profile from a release before generations has no entry.
        for (const dir of ['plugins', 'themes']) {
            let names = [];
            try { names = fs.readdirSync(path.join(BACKEND, dir)); } catch { /* none */ }
            for (const n of names) keys.add(dir === 'themes' ? `theme:${n}` : n);
        }
        let retired = 0, failed = 0;
        for (const key of keys) {
            const m = /^s(\d+):(.+)$/.exec(key);
            const siteId = m ? Number(m[1]) : 1;
            const slug = m ? m[2] : key;
            if (siteStorageSlug(slug, siteId) !== key) continue;
            try {
                if (await win.retireAppContainerPlugin(BACKEND, slug, siteId)) retired++;
            } catch (e) { failed++; console.error(`${key}: ${e && e.message}`); }
        }
        console.log(`Retired ${retired} profile(s)${failed ? `, ${failed} failed` : ''}.`);
        return failed ? 1 : 0;
    }
    console.error(USAGE);
    return 2;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = { main };
