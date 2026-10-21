/**
 * A SQLite database file holds password hashes, sessions and plugin secrets. SQLite creates it — and its
 * -wal / -shm companions — with the process umask, usually 0644: readable by every local account, while
 * the config file and the backups next to it are 0600. After each open the files are made owner-only.
 * POSIX only (Windows has no mode bits); best-effort, never fatal.
 */
const fs = require('fs');

const COMPANIONS = ['', '-wal', '-shm', '-journal'];

function restrictDbFiles(file: string): void {
    if (process.platform === 'win32' || !file || file === ':memory:') return;
    for (const suffix of COMPANIONS) {
        try {
            const p = file + suffix;
            const st = fs.statSync(p);
            if ((st.mode & 0o077) !== 0) fs.chmodSync(p, st.mode & 0o700);
        } catch { /* absent, or not ours to change */ }
    }
}

module.exports = { restrictDbFiles };
