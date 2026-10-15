/**
 * WordJS — creating, preparing and walking the sites of a network (multisite).
 *
 *   prepareSite(id)    open a site's database and load its per-site runtime (roles, content types,
 *                      taxonomies, core admin menu) once per process; the HTTP layer awaits it before a
 *                      request enters the site, and forEachSite before background work does
 *   createSite(...)    provision a new site: registry record, data directory, database, default
 *                      options, first administrator — all or nothing
 *   setSiteStatus(...) suspend / resume
 *   forEachSite(fn)    run background work (cron, outbox) once per active site, each in its own context
 *
 * Site 1 is always prepared by the normal boot (index.ts); nothing here changes it.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config/app');
const siteContext = require('./site-context');
const network = require('./network');

const prepared = new Map<number, Promise<void>>();

/** Load what a site needs in memory. Runs inside that site's context. */
async function initSiteRuntime(): Promise<void> {
    const postTypes = require('./post-types');
    await postTypes.initPostTypes();
    await postTypes.initTaxonomies();
    await require('./roles').loadRoles();
    require('./adminMenu').initCoreMenus();
}

/**
 * Make site `id` ready in this process (idempotent, concurrent callers share one preparation). Must be
 * called inside that site's context: the preparation's own reads and writes are the site's.
 */
function prepareSite(id: number): Promise<void> {
    if (id === siteContext.PRIMARY_SITE_ID) return Promise.resolve();
    if (siteContext.currentSiteId() !== id) {
        return Promise.reject(new Error(`prepareSite(${id}) called outside that site's context`));
    }
    let p = prepared.get(id);
    if (!p) {
        p = (async () => {
            const site = network.getSite(id);
            if (!site) throw new Error(`No such site: ${id}`);
            await require('../config/database').openSiteDatabase(id, site.dbPath || network.siteDbPath(id));
            await initSiteRuntime();
        })();
        prepared.set(id, p);
        p.catch(() => prepared.delete(id));
    }
    return p;
}

/** Forget every preparation (tests; the databases are closed by config/database closeSiteDatabases). */
function resetPreparedSites(): void {
    prepared.clear();
}

function codedError(code: string, message: string, status = 400): Error & { code: string; status: number } {
    const e = new Error(message) as Error & { code: string; status: number };
    e.code = code;
    e.status = status;
    return e;
}

/**
 * Is `hostname` free for a new site? It must be a DNS name (an IP literal or `localhost` names the
 * machine, not a site), and no address the main site answers (its main address, aliases, the
 * environment's hosts) — the registry's own uniqueness covers the other sites.
 */
function assertHostAvailable(url: string): { url: string; hostname: string } {
    const hostPolicy = require('./host-policy');
    const parsed = hostPolicy.parseSiteUrl(url);
    if (!parsed) throw codedError('network_invalid_url', 'The site address must be http(s)://host[:port], with no path.');
    if (parsed.kind !== 'dns' || parsed.hostname === 'localhost') {
        throw codedError('network_invalid_url', 'A site address must be a domain name, not an IP address or localhost.');
    }
    const policy = require('../middleware/auth').siteHostPolicy.get();
    const verdict = hostPolicy.classify(hostPolicy.parseHost(parsed.hostname), policy);
    if (verdict.cls === 'canonical' || verdict.cls === 'alias' || verdict.cls === 'env') {
        throw codedError('network_host_taken', 'This address already belongs to a site of the network.', 409);
    }
    return { url: parsed.origin, hostname: parsed.hostname };
}

type CreateSiteInput = {
    slug: string;
    url: string;
    title: string;
    adminUsername: string;
    adminEmail: string;
    adminPassword: string;
    actorUserId?: number | null;
};

/**
 * Provision a new site. All or nothing: if any step fails, the record, the database and the data
 * directory are removed again and the error is rethrown. Returns the site record.
 */
async function createSite(input: CreateSiteInput) {
    if (!siteContext.multisiteEnabled()) throw codedError('network_disabled', 'Multisite is not enabled on this install.', 409);
    const database = require('../config/database');
    if (database.getDbType().driver !== 'sqlite-native') {
        throw codedError('network_driver_unsupported', 'Multisite needs the sqlite-native database driver in this version.', 409);
    }
    const slug = String(input.slug || '').trim().toLowerCase();
    const title = String(input.title || '').trim();
    const adminUsername = String(input.adminUsername || '').trim();
    const adminEmail = String(input.adminEmail || '').trim();
    const adminPassword = typeof input.adminPassword === 'string' ? input.adminPassword : '';
    if (!title || title.length > 200) throw codedError('network_invalid_title', 'The site title is required (at most 200 characters).');
    if (!adminUsername || adminUsername.length > 60) throw codedError('network_invalid_admin', 'The administrator username is required (at most 60 characters).');
    if (!adminEmail || adminEmail.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(adminEmail)) throw codedError('network_invalid_admin', 'A valid administrator email is required.');
    if (adminPassword.length < 8) throw codedError('network_weak_password', 'The administrator password must be at least 8 characters.');
    const address = assertHostAvailable(input.url);

    const record = network.insertSite({ slug, url: address.url, hostname: address.hostname });
    const dir = network.siteDataDir(record.id);
    try {
        fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'private-uploads'), { recursive: true });
        await siteContext.runWithSite(record.id, async () => {
            await prepareSite(record.id);
            const options = require('./options');
            await options.initDefaultOptions({ site: { url: address.url, name: title, description: '' }, roles: config.roles });
            await options.updateOption('siteurl', address.url);
            await options.updateOption('home', address.url);
            await options.updateOption('blogname', title);
            await options.updateOption('admin_email', adminEmail);
            const Term = require('../models/Term');
            await Term.create({ name: 'Uncategorized', taxonomy: 'category', slug: 'uncategorized', description: 'Default category' });
            const User = require('../models/User');
            await User.create({ username: adminUsername, email: adminEmail, password: adminPassword, role: 'administrator' });
        });
    } catch (e: any) {
        prepared.delete(record.id);
        try { await database.closeSiteDatabase(record.id); } catch { /* best-effort */ }
        network.deleteSiteRecord(record.id);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
        if (e && typeof e.message === 'string' && /already exists/i.test(e.message)) {
            throw codedError('network_invalid_admin', e.message);
        }
        throw e;
    }
    network.audit('site.created', { actor: input.actorUserId ?? null, siteId: record.id, detail: { slug, url: address.url } });
    afterRegistryChange();
    return network.getSite(record.id);
}

function setSiteStatus(id: number, status: 'active' | 'suspended', actorUserId: number | null = null) {
    const site = network.setSiteStatus(id, status);
    network.audit(status === 'suspended' ? 'site.suspended' : 'site.resumed', { actor: actorUserId, siteId: id });
    afterRegistryChange();
    return site;
}

/** The addresses answered changed: tell the gateway now instead of at its next periodic push. */
function afterRegistryChange(): void {
    try {
        Promise.resolve(require('./site-address').armGateway()).catch(() => { /* the periodic push retries */ });
    } catch { /* no gateway in this mode */ }
}

/**
 * Run `fn` once per ACTIVE site other than site 1, each inside its own site context and after its
 * preparation, one site at a time. A site that fails is logged and skipped; the others still run.
 * Site 1's own background work keeps running where it always did.
 */
async function forEachSecondarySite(label: string, fn: (siteId: number) => Promise<void> | void): Promise<void> {
    if (!siteContext.multisiteEnabled()) return;
    let sites: any[];
    try { sites = network.listSites(); } catch (e: any) {
        console.warn(`[multisite] ${label}: the network store could not be read (${e && e.message}).`);
        return;
    }
    for (const site of sites) {
        if (site.id === siteContext.PRIMARY_SITE_ID || site.status !== 'active') continue;
        try {
            await siteContext.runWithSite(site.id, async () => {
                await prepareSite(site.id);
                await fn(site.id);
            });
        } catch (e: any) {
            console.warn(`[multisite] ${label} failed for site ${site.id}: ${e && e.message}`);
        }
    }
}

module.exports = {
    prepareSite,
    resetPreparedSites,
    createSite,
    setSiteStatus,
    forEachSecondarySite,
    assertHostAvailable,
};
