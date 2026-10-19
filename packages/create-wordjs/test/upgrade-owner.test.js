'use strict';

// `sudo npx create-wordjs upgrade` used to leave every file it created owned by root — the new
// frontend/.next among them — while the service runs as the site's own account, so Next failed with
// EACCES creating frontend/.next/cache on every render. upgrade() now reads the site's owner before it
// writes anything and gives the files back to it (installDirOwner + restoreInstallOwner).
//
// And npm's "new major version of npm available" notice no longer lands in the middle of the output:
// every npm this process starts inherits npm_config_update_notifier=false.
//
// MUTATION PROOF: make installDirOwner return null for a non-root directory and the first test fails;
// drop the npm_config_update_notifier line and the last one does.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INDEX = path.join(__dirname, '..', 'index.js');
const cli = require(INDEX);

function asRoot(fn) {
    const saved = process.getuid;
    process.getuid = () => 0;
    try { return fn(); } finally { process.getuid = saved; }
}

test('as root, the owner of a site another account owns is recorded and restored', { skip: process.platform === 'win32' && 'POSIX ownership' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-owner-'));
    try {
        const st = fs.statSync(dir);
        const owner = asRoot(() => cli.installDirOwner(dir));
        if (st.uid === 0) {
            assert.strictEqual(owner, null, 'a site root owns is left alone');
            return;
        }
        assert.deepStrictEqual(owner, { uid: st.uid, gid: st.gid });
        fs.mkdirSync(path.join(dir, 'frontend', '.next'), { recursive: true });
        // chown to the owner the files already have is allowed without privileges: the call itself runs.
        cli.restoreInstallOwner(dir, owner);
        assert.strictEqual(fs.statSync(path.join(dir, 'frontend', '.next')).uid, st.uid);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('not root: nothing to restore', () => {
    const saved = process.getuid;
    process.getuid = () => 1000;
    try {
        assert.strictEqual(cli.installDirOwner(os.tmpdir()), null);
    } finally {
        process.getuid = saved;
    }
    cli.restoreInstallOwner(os.tmpdir(), null); // no owner: a no-op, no chown spawned
});

test('npm children never print the update notice', () => {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(INDEX)}); console.log(process.env.npm_config_update_notifier)`], { encoding: 'utf8' });
    assert.strictEqual(r.stdout.trim(), 'false');
});
