'use strict';
/**
 * WHO OWNS THIS INSTALL — and refusing to write into it as somebody else.
 *
 * A Linux install runs as a service account (create-wordjs --systemd: `wordjs`), but its CLI is easy to
 * run as root: `sudo npm run network -- enable`, a root shell on the box. Everything such a command
 * writes then belongs to root — a rewritten wordjs-config.json, a new data/network.db, the -wal/-shm
 * files SQLite creates beside a database it merely opened — and the service can no longer write them:
 * creating a site answered 500 "attempt to write a readonly database", and the next boot only said that
 * the network store could not be opened. Nothing pointed at the command that caused it.
 *
 * So a command that may write refuses, up front, to run as root in an install that belongs to another
 * account, and says exactly what to run instead. (Re-owning every file afterwards would mean finding
 * every file a driver created on the way, and would still leave a window where the service is locked
 * out.) WORDJS_ALLOW_ROOT=1 runs it anyway, for the operator who is going to chown it themselves.
 *
 * Only POSIX root is checked: on Windows, or as any other user, the OS already stops a user writing
 * where they may not, and a file a non-root user creates is theirs, which is the account that ran it.
 */
const fs = require('fs');
const path = require('path');

/** The account name for a uid, from /etc/passwd; the number when there is no entry. */
function accountName(uid, passwdText) {
    let text = passwdText;
    if (text === undefined) {
        try { text = fs.readFileSync('/etc/passwd', 'utf8'); } catch { text = ''; }
    }
    for (const line of String(text).split('\n')) {
        const f = line.split(':');
        if (f.length >= 3 && Number(f[2]) === uid && f[0]) return f[0];
    }
    return String(uid);
}

/**
 * The owner of the install at `dir` (a backend directory): of wordjs-config.json, else data/, else the
 * directory itself — the first that exists. `{ uid, name, path }`, or null when nothing can be read.
 */
function installOwner(dir, opts = {}) {
    const stat = opts.stat || fs.statSync;
    for (const p of [path.join(dir, 'wordjs-config.json'), path.join(dir, 'data'), dir]) {
        try {
            const st = stat(p);
            return { uid: st.uid, gid: st.gid, name: accountName(st.uid, opts.passwd), path: p };
        } catch { /* try the next */ }
    }
    return null;
}

/**
 * The refusal message, or null when the command may run: not root, not POSIX, WORDJS_ALLOW_ROOT=1, or
 * an install root owns too.
 */
function rootWriteProblem(dir, commandHint, opts = {}) {
    const env = opts.env || process.env;
    const getuid = opts.getuid !== undefined ? opts.getuid : process.getuid;
    if (typeof getuid !== 'function') return null;
    if (getuid() !== 0) return null;
    if (String(env.WORDJS_ALLOW_ROOT || '').trim() === '1') return null;
    const owner = installOwner(dir, opts);
    if (!owner || owner.uid === 0) return null;
    const hint = commandHint || 'the same command';
    return [
        `this install belongs to '${owner.name}' (${owner.path}), but the command is running as root.`,
        'Files it writes or creates (wordjs-config.json, databases in data/) would belong to root, and the',
        `service running as '${owner.name}' could no longer write them. Run it as the owner instead:`,
        '',
        `    sudo -u ${owner.name} ${hint}`,
        '',
        `(Or set WORDJS_ALLOW_ROOT=1 to run it as root anyway, then: chown -R ${owner.name}: ${path.resolve(dir, '..')})`,
    ].join('\n');
}

/**
 * The command to run instead: `node <absolute script> <args>`, arguments quoted for a POSIX shell. Not
 * `npm run …`: npm writes its cache and logs under the account's HOME, which a service account usually
 * does not have, and the script finds its install from its own path, from any directory.
 */
function scriptHint(scriptPath, argv) {
    const q = (a) => (/^[\w@%+=:,./-]+$/.test(String(a)) ? String(a) : `'${String(a).replace(/'/g, "'\\''")}'`);
    return ['node', q(path.resolve(scriptPath)), ...(argv || []).map(q)].join(' ');
}

/** Print the refusal and exit 1 when rootWriteProblem() says so; otherwise return. */
function refuseRootInForeignInstall(dir, commandHint) {
    const problem = rootWriteProblem(dir, commandHint);
    if (!problem) return;
    console.error(`Error: ${problem}`);
    process.exit(1);
}

module.exports = { accountName, installOwner, rootWriteProblem, refuseRootInForeignInstall, scriptHint };
