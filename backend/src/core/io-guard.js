/**
 * WordJS - IO Guard
 * Monkey-patches 'fs' to prevent plugins from modifying their own code or system files.
 */

const fs = require('fs');
const path = require('path');
const { getCurrentPlugin } = require('./plugin-context');

const ORIGINALS = {
    // Write Ops
    writeFile: fs.writeFile,
    writeFileSync: fs.writeFileSync,
    unlink: fs.unlink,
    unlinkSync: fs.unlinkSync,
    rm: fs.rm,
    rmSync: fs.rmSync,
    rename: fs.rename,
    renameSync: fs.renameSync,
    mkdir: fs.mkdir,
    mkdirSync: fs.mkdirSync,
    symlink: fs.symlink,
    symlinkSync: fs.symlinkSync,
    appendFile: fs.appendFile,
    appendFileSync: fs.appendFileSync,
    truncate: fs.truncate,
    truncateSync: fs.truncateSync,
    chmod: fs.chmod,
    chmodSync: fs.chmodSync,

    // Read Ops
    readFile: fs.readFile,
    readFileSync: fs.readFileSync,
    readdir: fs.readdir,
    readdirSync: fs.readdirSync,
    createReadStream: fs.createReadStream,
    createWriteStream: fs.createWriteStream
};

const ROOT_DIR = path.resolve(__dirname, '../../');

/**
 * Check if a path is safe to access
 */
function isPathSafe(targetPath, isWrite = false) {
    const pluginSlug = getCurrentPlugin();
    if (!pluginSlug) return true; // Core code is trusted

    const resolved = path.resolve(targetPath);

    // Common Safe Zones for Reading
    const SAFE_READ_DIRS = [
        path.join(ROOT_DIR, 'uploads'),
        path.join(ROOT_DIR, 'data'),
        path.join(ROOT_DIR, 'themes'),
        path.join(ROOT_DIR, 'logs'),
        path.join(ROOT_DIR, 'os-tmp'),
        path.join(ROOT_DIR, 'plugins')
    ];

    // Safe Zones for Writing (Stricter)
    const SAFE_WRITE_DIRS = [
        path.join(ROOT_DIR, 'uploads'),
        path.join(ROOT_DIR, 'data'),
        path.join(ROOT_DIR, 'logs'),
        path.join(ROOT_DIR, 'os-tmp'),
        path.join(ROOT_DIR, 'themes')
    ];

    const dirsToCheck = isWrite ? SAFE_WRITE_DIRS : SAFE_READ_DIRS;
    const isAllowed = dirsToCheck.some(dir => resolved.startsWith(dir));

    if (!isAllowed) {
        console.warn(`[Security Block] Plugin '${pluginSlug}' tried to ${isWrite ? 'WRITE' : 'READ'} outside safe zones: ${resolved}`);
        return false;
    }

    return true;
}

// === PATCHES ===

function patch(methodName, isSync = false) {
    const original = ORIGINALS[methodName];
    if (!original) return;

    const isWrite = [
        'writeFile', 'writeFileSync',
        'unlink', 'unlinkSync',
        'rm', 'rmSync',
        'rename', 'renameSync',
        'mkdir', 'mkdirSync',
        'symlink', 'symlinkSync',
        'appendFile', 'appendFileSync',
        'createWriteStream', 'truncate', 'truncateSync',
        'chmod', 'chmodSync', 'lchmod', 'chown', 'chownSync'
    ].includes(methodName);

    fs[methodName] = function (...args) {
        // Different methods have path at different positions
        let pathsToCheck = [args[0]];

        if (methodName.startsWith('rename') || methodName.startsWith('symlink') || methodName.startsWith('link')) {
            // Check BOTH (Source/Dest or Target/Path)
            pathsToCheck = [args[0], args[1]];
        }

        for (const p of pathsToCheck) {
            if (!p) continue;
            // Validate
            if (!isPathSafe(p, isWrite)) {
                const error = new Error(`EACCES: Permission denied, plugin cannot access: ${p}`);
                error.code = 'EACCES';
                if (isSync) throw error;
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(error);
                return;
            }
        }

        return original.apply(this, args);
    };
}

// Write Ops
patch('writeFile'); patch('writeFileSync', true);
patch('unlink'); patch('unlinkSync', true);
patch('rm'); patch('rmSync', true);
patch('rename'); patch('renameSync', true);
patch('mkdir'); patch('mkdirSync', true);
patch('symlink'); patch('symlinkSync', true);
patch('appendFile'); patch('appendFileSync', true);
patch('createWriteStream');
patch('truncate'); patch('truncateSync', true);
patch('chmod'); patch('chmodSync', true);

// Read Ops
patch('readFile'); patch('readFileSync', true);
patch('readdir'); patch('readdirSync', true);
patch('createReadStream');

module.exports = {
    isPathSafe
};
