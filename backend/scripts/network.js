#!/usr/bin/env node
'use strict';
/**
 * `npm run network -- <command>` — turn an install into a network of sites, and manage who runs it.
 *
 *   status                         is multisite on; the sites; the network administrators
 *   enable --admin <login>[,...]   turn multisite on: record this install as site 1 (nothing of it moves)
 *                                  and make the named administrators of site 1 network administrators
 *   disable                        turn it off again (only while site 1 is the only site)
 *   admins add <login>             make an administrator of site 1 a network administrator
 *   admins remove <login>          take that away again
 *
 *   --dir <path>                   the installation's backend directory (default: this one)
 *
 * Sites are created from the network screen (Admin → Network) by a network administrator.
 *
 * WHAT IT WRITES: `multisite.enabled` in wordjs-config.json (through core/configManager's atomic writer)
 * and the network store (data/network.db). It never touches site 1's database: it only READS it, to
 * find the user ids of the logins it is given. The backend reads `multisite.enabled` at start, so
 * restart it after enable / disable.
 *
 * Multisite needs the sqlite-native database driver in this version.
 */
const path = require('path');
const fs = require('fs');

const BACKEND = path.resolve(__dirname, '..');

const USAGE = [
    'Usage: npm run network -- <command> [options]',
    '',
    '  status',
    '  enable --admin <login>[,<login>...]',
    '  disable',
    '  admins add <login>',
    '  admins remove <login>',
    '',
    '  --dir <path>   the installation\'s backend directory (default: the one this script belongs to)',
].join('\n');

class UsageError extends Error {}

function parseArgs(argv) {
    const positionals = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') { flags.help = true; continue; }
        if (arg.startsWith('--')) {
            const name = arg.slice(2);
            if (name !== 'dir' && name !== 'admin') throw new UsageError(`unknown option --${name}`);
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
            flags[name] = value;
            i++;
            continue;
        }
        positionals.push(arg);
    }
    return { command: positionals.shift(), positionals, flags };
}

/** The backend modules this needs: compiled when present (a release), ts-node on src/ otherwise. */
function loadModules() {
    const dist = path.join(BACKEND, 'dist');
    if (fs.existsSync(path.join(dist, 'core', 'network.js'))) {
        return {
            configManager: require(path.join(dist, 'core', 'configManager.js')),
            network: require(path.join(dist, 'core', 'network.js')),
            config: require(path.join(dist, 'config', 'app.js')),
        };
    }
    require(require.resolve('ts-node', { paths: [BACKEND] })).register({ project: path.join(BACKEND, 'tsconfig.json'), transpileOnly: true });
    return {
        configManager: require(path.join(BACKEND, 'src', 'core', 'configManager')),
        network: require(path.join(BACKEND, 'src', 'core', 'network')),
        config: require(path.join(BACKEND, 'src', 'config', 'app')),
    };
}

/** Site 1's users by login, read-only, with their role. */
function lookupMainSiteUsers(config, logins) {
    const Database = require(require.resolve('better-sqlite3', { paths: [BACKEND] }));
    const file = path.resolve(config.dbPath);
    if (!fs.existsSync(file)) throw new Error(`the main site's database (${file}) does not exist`);
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        return logins.map((login) => {
            const row = db.prepare('SELECT id, user_login FROM users WHERE user_login = ?').get(login);
            if (!row) throw new UsageError(`no user '${login}' on the main site`);
            const role = db.prepare("SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = 'role'").get(row.id);
            if (!role || role.meta_value !== 'administrator') throw new UsageError(`'${login}' is not an administrator of the main site`);
            return { id: Number(row.id), login: row.user_login };
        });
    } finally {
        db.close();
    }
}

function setEnabled(configManager, enabled) {
    const r = configManager.updateConfig((current) => {
        const next = Object.assign({}, current);
        next.multisite = Object.assign({}, current.multisite || {}, { enabled });
        return next;
    }, { reload: false });
    if (!r.ok) throw new Error(`wordjs-config.json could not be written (${r.reason})`);
}

function printStatus(m) {
    const enabled = !!(m.config.multisite && m.config.multisite.enabled === true);
    console.log(`Multisite: ${enabled ? 'on' : 'off'}`);
    if (!fs.existsSync(m.network.networkDbPath())) {
        console.log('Network store: none yet');
        return;
    }
    console.log(`Network store: ${m.network.networkDbPath()}`);
    for (const s of m.network.listSites()) {
        console.log(`  site ${s.id}  ${s.status.padEnd(9)} ${s.mainUrl}${s.id === 1 ? '  (main site)' : ''}`);
    }
    const admins = m.network.listNetworkAdmins();
    console.log(`Network administrators (site 1 user ids): ${admins.length ? admins.join(', ') : 'none'}`);
}

function run(argv) {
    const { command, positionals, flags } = parseArgs(argv);
    if (flags.help || !command) {
        console.log(USAGE);
        return 0;
    }
    process.chdir(flags.dir ? path.resolve(flags.dir) : BACKEND);
    // Every command opens the network store, and SQLite creates files beside a database it opens: as root
    // in an install another account owns, they would lock that account out (scripts/install-owner.js).
    const rootProblem = require('./install-owner').rootWriteProblem(process.cwd(), require('./install-owner').scriptHint(__filename, argv));
    if (rootProblem) throw new Error(rootProblem);
    const m = loadModules();

    if (command === 'status') {
        printStatus(m);
        return 0;
    }
    if (!m.configManager.isInstalled()) throw new Error('this install is not set up yet; finish the install wizard first');

    if (command === 'enable') {
        const driver = m.config.dbDriver || 'sqlite-native';
        if (driver !== 'sqlite-native') throw new Error(`multisite needs the sqlite-native database driver (this install uses '${driver}')`);
        const logins = String(flags.admin || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!logins.length) throw new UsageError('enable needs --admin <login>: at least one administrator of the main site runs the network');
        const users = lookupMainSiteUsers(m.config, logins);
        const siteUrl = m.configManager.getConfig().siteUrl;
        if (!m.network.normalizeSiteUrl(siteUrl)) throw new Error('the main site has no valid main address (npm run site -- canonical <url>)');
        m.network.registerPrimarySite(m.network.normalizeSiteUrl(siteUrl).url);
        for (const u of users) m.network.addNetworkAdmin(u.id, u.login);
        m.network.audit('network.enabled', { detail: { admins: users.map((u) => u.login), via: 'cli' } });
        setEnabled(m.configManager, true);
        console.log(`Multisite is on. Site 1 is ${siteUrl}; network administrators: ${users.map((u) => u.login).join(', ')}.`);
        console.log('Restart the backend, then create sites from Admin → Network.');
        return 0;
    }
    if (command === 'disable') {
        if (fs.existsSync(m.network.networkDbPath()) && m.network.listSites().some((s) => s.id !== 1)) {
            throw new Error('the network has other sites; multisite stays on while they exist');
        }
        setEnabled(m.configManager, false);
        console.log('Multisite is off. Restart the backend.');
        return 0;
    }
    if (command === 'admins') {
        const action = positionals[0];
        const login = positionals[1];
        if ((action !== 'add' && action !== 'remove') || !login) throw new UsageError('admins add|remove <login>');
        const [user] = lookupMainSiteUsers(m.config, [login]);
        if (action === 'add') m.network.addNetworkAdmin(user.id, user.login);
        else m.network.removeNetworkAdmin(user.id);
        m.network.audit(action === 'add' ? 'network.admin.added' : 'network.admin.removed', { detail: { login: user.login, via: 'cli' } });
        console.log(`${user.login} is ${action === 'add' ? 'now' : 'no longer'} a network administrator.`);
        return 0;
    }
    throw new UsageError(`unknown command '${command}'`);
}

if (require.main === module) {
    try {
        process.exitCode = run(process.argv.slice(2));
    } catch (e) {
        if (e instanceof UsageError) {
            console.error(`Error: ${e.message}\n\n${USAGE}`);
            process.exitCode = 2;
        } else {
            console.error(`Error: ${e && e.message ? e.message : e}`);
            process.exitCode = 1;
        }
    }
}

module.exports = { run, parseArgs };
