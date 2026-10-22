/**
 * WordJS — turning a network of sites on and off from the admin panel (multisite, zero config).
 *
 * `npm run network -- enable|disable` (backend/scripts/network.js) still works, as a second path. This
 * module is the panel's: Settings → Network checks what a network needs (requirements), lets a main-site
 * administrator choose the network administrators, and turns multisite on or off — then restarts the
 * backend itself (core/restart), on every node, because `multisite.enabled` is read at boot.
 *
 * What it writes is exactly what the CLI writes: site 1's record and the network administrators in the
 * network store (core/network), `multisite.enabled` in wordjs-config.json (configManager's atomic writer),
 * and an entry in the network's audit log. It also records the switch in the network store
 * (ENABLED_MARKER), so a backend node that was down when it happened applies it when it starts.
 */

const log = require('./module-logger').moduleLogger('core/network-setup');

/** The network store's record of the switch: '1' on, '0' off (read at boot by nodes that missed the bus). */
const ENABLED_MARKER = 'network_enabled';

export type RequirementId = 'installed' | 'driver' | 'db_create' | 'site_address' | 'restart';
export type Requirement = {
    id: RequirementId;
    ok: boolean;
    /** Blocks turning the network on (a failed `restart` check only means "restart it yourself"). */
    blocking: boolean;
    /** What it is, in plain words. */
    message: string;
    /** How to fix it from the panel, when it is not met. */
    fix?: { action: 'migrate_sqlite_native' | 'site_address' | 'db_grant' | 'restart_by_hand'; detail?: string };
};

function codedError(code: string, message: string, status = 400): Error & { code: string; status: number } {
    const e = new Error(message) as Error & { code: string; status: number };
    e.code = code;
    e.status = status;
    return e;
}

function config(): any { return require('../config/app'); }
function driverName(): string { return String(config().dbDriver || 'sqlite-native'); }

/**
 * Can the database user create what a network needs (Postgres: schemas in its database; MySQL: databases
 * named after it)? Or do they already exist? Answers null when the question does not apply (SQLite), else
 * { ok, detail }. Read-only: it never creates anything.
 */
async function databaseCreateRight(): Promise<{ ok: boolean; detail: string } | null> {
    const siteStorage = require('./site-storage');
    const engine = siteStorage.storageEngine(driverName());
    if (engine === 'sqlite') return null;
    const db = require('../config/database').getDbAsync();
    try {
        if (engine === 'postgres') {
            const row = await db.get("SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS ok");
            if (row && (row.ok === true || row.ok === 't' || row.ok === 1)) return { ok: true, detail: '' };
            const pre = await db.get('SELECT 1 AS x FROM information_schema.schemata WHERE schema_name = ?', [siteStorage.NETWORK_PG_SCHEMA]);
            if (pre) return { ok: true, detail: 'pre-created' };
            return { ok: false, detail: `GRANT CREATE ON DATABASE ${String(config().db && config().db.name)} TO <the WordJS user>;` };
        }
        // MySQL / MariaDB: a global CREATE, or a database-level grant whose pattern covers <db>_network.
        const target = siteStorage.networkMysqlDatabase();
        const global = await db.get("SELECT 1 AS x FROM information_schema.USER_PRIVILEGES WHERE PRIVILEGE_TYPE = 'CREATE' AND GRANTEE = CONCAT(\"'\", SUBSTRING_INDEX(CURRENT_USER(), '@', 1), \"'@'\", SUBSTRING_INDEX(CURRENT_USER(), '@', -1), \"'\")");
        if (global) return { ok: true, detail: '' };
        const scoped = await db.get("SELECT 1 AS x FROM information_schema.SCHEMA_PRIVILEGES WHERE PRIVILEGE_TYPE = 'CREATE' AND ? LIKE TABLE_SCHEMA AND GRANTEE = CONCAT(\"'\", SUBSTRING_INDEX(CURRENT_USER(), '@', 1), \"'@'\", SUBSTRING_INDEX(CURRENT_USER(), '@', -1), \"'\")", [target]);
        if (scoped) return { ok: true, detail: '' };
        const pre = await db.get('SELECT 1 AS x FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [target]);
        if (pre) return { ok: true, detail: 'pre-created' };
        const base = String(config().db && config().db.name);
        return { ok: false, detail: `GRANT CREATE ON \`${base}\\_%\`.* TO <the WordJS user>;` };
    } catch (e: any) {
        // An engine that does not answer the question: the switch itself reports what it could not create.
        return { ok: true, detail: `not checked (${e && e.message})` };
    }
}

/** Everything a network needs, checked now, in plain words, with how to fix each from the panel. */
async function requirements(): Promise<Requirement[]> {
    const configManager = require('./configManager');
    const siteStorage = require('./site-storage');
    const restart = require('./restart');
    const out: Requirement[] = [];

    const installed = configManager.isInstalled();
    out.push({ id: 'installed', ok: installed, blocking: true, message: installed ? 'The site is installed.' : 'Finish the install wizard first.' });

    const driver = driverName();
    const problem = siteStorage.storageProblem(driver);
    out.push(problem
        ? {
            id: 'driver', ok: false, blocking: true,
            message: driver === 'sqlite-legacy'
                ? 'This site runs on the older SQLite engine (sqlite-legacy), which cannot hold a network. Move it to the current SQLite engine first: it takes a minute, keeps a copy of the old database, and restarts WordJS by itself.'
                : `The database cannot hold a network: ${problem}.`,
            fix: driver === 'sqlite-legacy' ? { action: 'migrate_sqlite_native' } : undefined,
        }
        : { id: 'driver', ok: true, blocking: true, message: `The database engine (${driver}) can hold a network.` });

    const right = problem ? null : await databaseCreateRight();
    if (right) {
        out.push(right.ok
            ? { id: 'db_create', ok: true, blocking: true, message: right.detail === 'pre-created' ? 'The network\'s database space already exists.' : 'The database user may create each site\'s own space.' }
            : {
                id: 'db_create', ok: false, blocking: true,
                message: driver === 'postgres'
                    ? 'The database user may not create schemas in its database, and each site needs one. Ask whoever manages the database server to run the command below (or to create the schemas wordjs_network and wordjs_site_<id> for it).'
                    : 'The database user may not create databases, and each site needs one. Ask whoever manages the database server to run the command below (or to create the databases for it).',
                fix: { action: 'db_grant', detail: right.detail },
            });
    }

    const siteUrl = (configManager.getConfig() || {}).siteUrl;
    const main = require('./network').normalizeSiteUrl(siteUrl);
    out.push(main
        ? { id: 'site_address', ok: true, blocking: true, message: `The main site's address is ${main.url}.` }
        : { id: 'site_address', ok: false, blocking: true, message: 'The main site has no valid main address yet. Set it in Settings → Site address.', fix: { action: 'site_address' } });

    const mode = restart.restartMode();
    out.push(mode === 'manual'
        ? { id: 'restart', ok: false, blocking: false, message: 'WordJS cannot restart itself the way it was started here. The change is saved, but you will need to restart WordJS once to apply it.', fix: { action: 'restart_by_hand' } }
        : { id: 'restart', ok: true, blocking: false, message: 'WordJS restarts itself to apply the change (a few seconds).' });
    return out;
}

/** The main site's administrators, the candidates for network administrator. */
async function mainSiteAdministrators(): Promise<Array<{ id: number; login: string; displayName: string; networkAdmin: boolean }>> {
    const siteContext = require('./site-context');
    return siteContext.runWithSite(siteContext.PRIMARY_SITE_ID, async () => {
        const User = require('../models/User');
        const users = await User.findAll({ role: 'administrator', limit: 200, orderBy: 'user_login' });
        let isAdmin = (_id: number, _login: string) => false;
        if (siteContext.multisiteEnabled()) {
            try { const network = require('./network'); isAdmin = (id, login) => network.isNetworkAdmin(id, login); } catch { /* store not open */ }
        }
        return users.map((u: any) => ({ id: Number(u.id), login: String(u.userLogin), displayName: String(u.displayName || u.userLogin), networkAdmin: isAdmin(Number(u.id), String(u.userLogin)) }));
    });
}

/** The chosen ids, each an administrator of the main site; throws a coded error otherwise. */
async function checkedAdministrators(ids: unknown): Promise<Array<{ id: number; login: string }>> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50) {
        throw codedError('network_admins_required', 'Choose at least one administrator of the main site to run the network.');
    }
    const all = await mainSiteAdministrators();
    const byId = new Map(all.map((a) => [a.id, a]));
    const out: Array<{ id: number; login: string }> = [];
    for (const raw of ids) {
        const id = Number(raw);
        const a = Number.isSafeInteger(id) ? byId.get(id) : undefined;
        if (!a) throw codedError('network_admin_not_administrator', 'Only administrators of the main site can become network administrators.');
        if (!out.some((o) => o.id === a.id)) out.push({ id: a.id, login: a.login });
    }
    return out;
}

function setEnabledInConfig(enabled: boolean): void {
    const r = require('./configManager').updateConfig((current: any) => ({ ...current, multisite: { ...(current.multisite || {}), enabled } }), { reload: false });
    if (!r.ok) throw codedError('network_config_unwritable', `wordjs-config.json could not be written (${r.reason}).`, 500);
}

async function writeMarker(enabled: boolean): Promise<void> {
    const network = require('./network');
    await network.storeUpsert('network_meta', { meta_key: ENABLED_MARKER }, { meta_value: enabled ? '1' : '0' });
}

/**
 * Turn the network on. The caller (routes/network-setup.ts) has checked who asks, the password and the
 * second factor. Returns how the backend restarts.
 */
async function enableNetwork(input: { adminIds: unknown; actorUserId: number; mfa: string; ip?: string }) {
    const siteContext = require('./site-context');
    if (siteContext.multisiteEnabled()) throw codedError('network_already_enabled', 'The network is already on.', 409);
    const blocking = (await requirements()).filter((r) => r.blocking && !r.ok);
    if (blocking.length) throw codedError('network_requirements_unmet', blocking.map((r) => r.message).join(' '), 409);
    const admins = await checkedAdministrators(input.adminIds);

    const network = require('./network');
    const main = network.normalizeSiteUrl((require('./configManager').getConfig() || {}).siteUrl);
    try {
        await network.ready();
        await network.registerPrimarySite(main.url);
        for (const a of admins) await network.addNetworkAdmin(a.id, a.login);
        await writeMarker(true);
        await network.audit('network.enabled', { actor: input.actorUserId, detail: { admins: admins.map((a) => a.login), via: 'panel', mfa: input.mfa } });
    } catch (e: any) {
        if (e && typeof e.code === 'string' && e.code.startsWith('network_')) throw e;
        log.error({ err: e }, 'the network store could not be prepared');
        throw codedError('network_store_failed', `The network's database space could not be created: ${e && e.message}`, 500);
    }
    setEnabledInConfig(true);
    await siteContext.runWithSite(siteContext.PRIMARY_SITE_ID, () => require('./audit').recordAudit(input.actorUserId, 'network.enable', 'network', 1, { admins: admins.map((a) => a.login), mfa: input.mfa }));

    const restart = require('./restart');
    await restart.announceClusterRestart({ multisiteEnabled: true }, 'the network was turned on');
    const mode = restart.scheduleRestart('the network was turned on');
    return { admins, restart: mode };
}

/** Turn the network off: only while the main site is the only site. */
async function disableNetwork(input: { actorUserId: number; mfa: string }) {
    const siteContext = require('./site-context');
    if (!siteContext.multisiteEnabled()) throw codedError('network_not_enabled', 'The network is already off.', 409);
    const network = require('./network');
    const others = network.listSites().filter((s: any) => s.id !== siteContext.PRIMARY_SITE_ID);
    if (others.length) {
        throw codedError('network_has_sites', `The network still has ${others.length} other site${others.length === 1 ? '' : 's'}. Delete ${others.length === 1 ? 'it' : 'them'} in Admin → Network first; the network stays on while they exist.`, 409);
    }
    await writeMarker(false);
    await network.audit('network.disabled', { actor: input.actorUserId, detail: { via: 'panel', mfa: input.mfa } });
    setEnabledInConfig(false);
    await siteContext.runWithSite(siteContext.PRIMARY_SITE_ID, () => require('./audit').recordAudit(input.actorUserId, 'network.disable', 'network', 1, { mfa: input.mfa }));

    const restart = require('./restart');
    await restart.announceClusterRestart({ multisiteEnabled: false }, 'the network was turned off');
    return { restart: restart.scheduleRestart('the network was turned off') };
}

/**
 * At boot, on a database server (several nodes may share it): did the network get switched while this
 * node was down? Reads the store's marker without creating anything; returns the switch it records, or
 * null when there is none (no store, no marker, SQLite).
 */
async function storedSwitch(): Promise<boolean | null> {
    const siteStorage = require('./site-storage');
    const engine = siteStorage.storageEngine(driverName());
    if (engine === 'sqlite') return null;
    try {
        const db = require('../config/database').getDbAsync();
        // Ask whether the store exists before reading it. A site that never had a network has no store,
        // and the read's "relation does not exist" was logged by the driver at error level on every boot
        // (the catch below only hid it from this function). The probe itself never errors on absence, so
        // a real failure of the read below is still logged.
        const exists = engine === 'postgres'
            ? await db.get('SELECT to_regclass(?) AS t', [`${siteStorage.NETWORK_PG_SCHEMA}.network_meta`])
            : await db.get("SELECT 1 AS t FROM information_schema.tables WHERE table_schema = ? AND table_name = 'network_meta' LIMIT 1", [siteStorage.networkMysqlDatabase()]);
        if (!exists || exists.t == null) return null;
        const table = engine === 'postgres'
            ? `${siteStorage.NETWORK_PG_SCHEMA}.network_meta`
            : `\`${siteStorage.networkMysqlDatabase()}\`.network_meta`;
        const row = await db.get(`SELECT meta_value FROM ${table} WHERE meta_key = ?`, [ENABLED_MARKER]);
        if (!row) return null;
        return String(row.meta_value) === '1';
    } catch {
        return null;
    }
}

/**
 * Boot: follow a switch made while this node was down (several nodes on Postgres/MySQL). Writes this
 * node's config and restarts it; returns true when it did.
 */
async function followStoredSwitch(): Promise<boolean> {
    const stored = await storedSwitch();
    if (stored === null) return false;
    const enabled = require('./site-context').multisiteEnabled();
    if (stored === enabled) return false;
    log.warn(`[multisite] the network was turned ${stored ? 'on' : 'off'} on another node while this one was down; applying it here.`);
    setEnabledInConfig(stored);
    const mode = require('./restart').scheduleRestart(`the network was turned ${stored ? 'on' : 'off'} on another node`);
    return mode !== 'manual';
}

module.exports = {
    ENABLED_MARKER,
    requirements,
    mainSiteAdministrators,
    checkedAdministrators,
    enableNetwork,
    disableNetwork,
    storedSwitch,
    followStoredSwitch,
};
