'use strict';
/**
 * The supervisor's half of an update made from the admin panel (backend core/updater): if the new
 * version does not come up, put the previous one back.
 *
 * core/updater records `{ state: 'applied', fromTag, appliedAt, ... }` in backend/data/update-state.json
 * after `create-wordjs upgrade` succeeded and before it restarts the app. The first boot of the new
 * version marks it `done`. When the app instead exits (anything but the restart code) while the state is
 * still `applied` and recent, the supervisor (monolith.js) calls rollBack(): the same official CLI with
 * `--version <fromTag> --force`, and the state becomes `rolled_back` (or `failed` if that did not work
 * either). It runs once per update: a rolled-back state never triggers it again.
 *
 * Plain Node, no dependencies: it runs in the supervisor, outside the app.
 */
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 15 * 60 * 1000;

function readState(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeState(file, s) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

/** Should the app's exit be answered with a rollback? Only right after a panel update that never came up. */
function shouldRollBack(file, now = Date.now()) {
    const s = readState(file);
    if (!s || s.state !== 'applied' || typeof s.fromTag !== 'string' || !/^v\d+\.\d+\.\d+/.test(s.fromTag)) return null;
    const at = Date.parse(s.appliedAt || s.at || '');
    if (!Number.isFinite(at) || now - at > WINDOW_MS) return null;
    return s;
}

/**
 * Re-apply the previous version. `spawnSync` is injectable for tests. Returns true when it worked.
 */
function rollBack({ file, root, log = console.log, spawnSync = require('child_process').spawnSync }) {
    const s = shouldRollBack(file);
    if (!s) return false;
    log(`↩️  [update] WordJS ${s.to} did not start; putting ${s.fromTag} back...`);
    writeState(file, { ...s, state: 'failed', step: 'rollback', error: `WordJS ${s.to} did not start.` });
    // The upgrade CLI the installed release shipped, run by this Node binary with no shell (the same
    // command core/updater runs) — never a package resolved from the registry at rollback time.
    const cli = path.join(root, 'packages', 'create-wordjs', 'index.js');
    const r = spawnSync(process.execPath, [cli, 'upgrade', root, '--yes', '--version', s.fromTag, '--force'], {
        cwd: root, stdio: 'inherit', shell: false, windowsHide: true,
        env: { ...process.env, NODE_PATH: path.join(root, 'backend', 'node_modules'), npm_config_update_notifier: 'false' },
    });
    const ok = r && r.status === 0;
    writeState(file, {
        ...s, state: ok ? 'rolled_back' : 'failed', step: undefined, finishedAt: new Date().toISOString(),
        error: ok ? `WordJS ${s.to} did not start, so ${s.fromTag} was put back.` : `WordJS ${s.to} did not start, and ${s.fromTag} could not be put back (exit code ${r && r.status}). Restore the backup ${s.backup || ''} or run the update from a terminal.`,
    });
    log(ok ? `↩️  [update] ${s.fromTag} is back.` : `✖ [update] the rollback to ${s.fromTag} failed.`);
    return ok;
}

module.exports = { shouldRollBack, rollBack, WINDOW_MS, defaultStateFile: (backendDir) => path.join(backendDir, 'data', 'update-state.json') };
