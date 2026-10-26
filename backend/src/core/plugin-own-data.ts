/**
 * A plugin's own `data/` folder lives OUTSIDE its code directory.
 *
 * The code directory of an isolated plugin is read-only at every sandbox layer (Node permissions,
 * Landlock, Seatbelt, AppContainer ACLs and io-guard), so a plugin can never rewrite its own code or its
 * manifest. Plugins have always kept their state in `<code dir>/data` (mail-server keeps its encryption
 * key, Bayes model and attachments there), so that folder is MOVED to the plugin's private data directory
 * (sandbox-paths ownDataDir) and `<code dir>/data` becomes a link to it: a junction on Windows (no
 * privilege needed), a directory symlink elsewhere. Paths the plugin builds with `__dirname` keep working,
 * and every layer checks the link's TARGET, which is the plugin's writable zone.
 *
 * The move is a rename on the same volume (both live under the install root), so nothing is copied and
 * nothing is lost; a failure part-way puts the folder back and refuses the launch rather than starting the
 * plugin without its data (mail-server would otherwise mint a new key and lose access to every stored
 * secret).
 */
const fs = require('fs');
const path = require('path');
const { sandboxPaths } = require('./sandbox-paths');

/** What prepareOwnDataLink found and did, for the log and the tests. */
export type OwnDataOutcome = 'linked' | 'created' | 'migrated' | 'merged' | 'relinked' | 'absent';

/** A junction on Windows (no privilege needed); Node ignores the type elsewhere and makes a symlink. */
function linkType(): 'junction' {
    return 'junction';
}

function sameDir(a: string, b: string): boolean {
    const norm = (p: string) => {
        let r = path.resolve(p);
        try { r = fs.realpathSync.native(r); } catch { /* compare as given */ }
        return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
    };
    return norm(a) === norm(b);
}

/** Remove a link itself, never what it points to (a Windows junction is removed as a directory entry). */
function removeLink(link: string): void {
    try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
}

/** Move every entry of `from` into `to`; an entry that already exists there goes to a dated folder. */
function mergeInto(from: string, to: string): void {
    const conflicts = path.join(to, `.migrated-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    for (const entry of fs.readdirSync(from)) {
        const src = path.join(from, entry);
        let dest = path.join(to, entry);
        if (fs.existsSync(dest)) {
            fs.mkdirSync(conflicts, { recursive: true });
            dest = path.join(conflicts, entry);
        }
        fs.renameSync(src, dest);
    }
}

/**
 * Make `<code dir>/data` a link to the plugin's own data directory, migrating a real folder first.
 * Site 1 only (the code directory is shared; another site's worker keeps its data in its own storage).
 * Throws when the link cannot be put in place - the launch must not go ahead without the plugin's data.
 */
function prepareOwnDataLink(appRoot: string, slug: string): OwnDataOutcome {
    const p = sandboxPaths(appRoot, slug, __dirname, 1);
    const target: string = p.ownData;
    const link: string = p.ownDataLink;
    // No code directory, nothing to run and nothing to link: the launch fails on its own, for that reason.
    if (!fs.existsSync(p.own)) return 'absent';
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    let st: any;
    try { st = fs.lstatSync(link); } catch { st = null; }

    if (st && st.isSymbolicLink()) {
        let points: string;
        try { points = fs.readlinkSync(link); } catch { points = ''; }
        if (points && sameDir(path.resolve(path.dirname(link), points), target)) {
            fs.mkdirSync(target, { recursive: true, mode: 0o700 });
            return 'linked';
        }
        // A link that points anywhere else is not one this module made: replace it (the code directory is
        // read-only to the plugin, so only something outside the sandbox could have changed it).
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        removeLink(link);
        fs.symlinkSync(target, link, linkType());
        return 'relinked';
    }
    if (st && !st.isDirectory()) {
        throw new Error(`the plugin's data path ${link} is a file, not a folder: move it away so WordJS can link its data folder`);
    }
    if (!st) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        fs.symlinkSync(target, link, linkType());
        return 'created';
    }

    // A real folder: move its contents into the private data directory, then link.
    let outcome: OwnDataOutcome;
    const targetExists = fs.existsSync(target);
    const targetEmpty = targetExists && fs.readdirSync(target).length === 0;
    if (!targetExists || targetEmpty) {
        if (targetEmpty) fs.rmdirSync(target);
        fs.renameSync(link, target);
        outcome = 'migrated';
    } else {
        mergeInto(link, target);
        fs.rmdirSync(link);
        outcome = 'merged';
    }
    try {
        fs.symlinkSync(target, link, linkType());
    } catch (e: any) {
        // Put the folder back where the plugin expects it, so nothing is lost and a later launch retries.
        try {
            if (!fs.existsSync(link)) {
                if (outcome === 'migrated') fs.renameSync(target, link);
                else { fs.mkdirSync(link); mergeInto(target, link); }
            }
        } catch { /* the data stays complete in `target`; the error below names it */ }
        throw new Error(`could not link ${link} to the plugin's data folder ${target}: ${e && e.message}`, { cause: e });
    }
    return outcome;
}

/**
 * `<code dir>/data` holds nothing: remove the link and its (empty) target and return true, so a plugin that
 * never wrote anything leaves no residue when it is deleted. False (nothing touched) when there is data.
 */
function discardIfEmpty(dataPath: string): boolean {
    let st: any;
    try { st = fs.lstatSync(dataPath); } catch { return true; }
    let target = dataPath;
    if (st.isSymbolicLink()) { try { target = fs.realpathSync(dataPath); } catch { removeLink(dataPath); return true; } }
    let entries: string[];
    try { entries = fs.readdirSync(target); } catch { return false; }
    if (entries.length > 0) return false;
    if (st.isSymbolicLink()) { removeLink(dataPath); try { fs.rmdirSync(target); } catch { /* already gone */ } }
    else fs.rmdirSync(dataPath);
    return true;
}

module.exports = { prepareOwnDataLink, discardIfEmpty };
