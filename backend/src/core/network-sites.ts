/**
 * WordJS — creating, preparing and walking the sites of a network (multisite).
 *
 *   prepareSite(id)    open a site's database and load its per-site runtime (roles, content types,
 *                      taxonomies, core admin menu) once per process; the HTTP layer awaits it before a
 *                      request enters the site, and forEachSite before background work does
 *   createSite(...)    provision a new site: registry record, data directory, database, default
 *                      options, first administrator — all or nothing
 *   setSiteStatus(...) suspend / resume
 *   deleteSite(...)    remove a suspended site and everything it holds, on every node
 *   forEachSite(fn)    run background work (cron, outbox) once per active site, each in its own context
 *
 * Site 1 is always prepared by the normal boot (index.ts); nothing here changes it.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config/app');
const siteContext = require('./site-context');
const network = require('./network');
const log = require('./module-logger').moduleLogger('core/network-sites');

const prepared = new Map<number, Promise<void>>();

/** Load what a site needs in memory. Runs inside that site's context. */
async function initSiteRuntime(): Promise<void> {
    const postTypes = require('./post-types');
    await postTypes.initPostTypes();
    await postTypes.initTaxonomies();
    await require('./roles').loadRoles();
    require('./adminMenu').initCoreMenus();
    // Its own recurring core events (collaboration sweep, analytics retention, its backups).
    await require('./cron').initSiteCronEvents();
    // Phase 2: the site's own plugin workers and theme worker (core/plugins, core/theme-engine). Neither
    // throws: a site whose plugins or theme code fail to start still serves its content.
    await require('./plugins').loadSitePlugins();
    try { await require('./theme-engine').init(); }
    catch (e: any) { log.warn(`[multisite] site ${siteContext.currentSiteIdOrNull()}: theme engine not started: ${e && e.message}`); }
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
            await require('../config/database').openSiteDatabase(id, network.isSqlStore() ? null : (site.dbPath || network.siteDbPath(id)));
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
    const storageProblem = require('./site-storage').storageProblem(database.getDbType().driver);
    if (storageProblem) throw codedError('network_driver_unsupported', storageProblem, 409);
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

    const record = await network.insertSite({ slug, url: address.url, hostname: address.hostname });
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
        // Nothing of the half-made site stays: its database or schema, its files, its record.
        try { await database.dropSiteDatabase(record.id); } catch { /* best-effort */ }
        await network.deleteSiteRecord(record.id);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
        if (e && typeof e.message === 'string' && /already exists/i.test(e.message)) {
            throw codedError('network_invalid_admin', e.message);
        }
        throw e;
    }
    await network.audit('site.created', { actor: input.actorUserId ?? null, siteId: record.id, detail: { slug, url: address.url } });
    afterRegistryChange();
    // Its own certificate, when the install issues them (ACME http-01): in the background — the address
    // may not point here yet, in which case the renewal pass tries again later.
    try {
        const siteCerts = require('./site-certs');
        if (siteCerts.autoIssueEnabled()) {
            siteCerts.issueSiteCertificate(record.id).catch((e: any) => log.warn(`[multisite] site ${record.id}: certificate not issued yet (${e && e.message})`));
        }
    } catch { /* certificates are optional */ }
    return network.getSite(record.id);
}

/** Stop every plugin and theme worker THIS process runs for site `id`. */
function stopSiteWorkers(id: number): void {
    try {
        const iso = require('./plugin-isolate');
        for (const key of iso.listIsolateKeys()) {
            if (iso.splitIsolateKey(key).siteId === id) { try { iso.unloadIsolateKey(key); } catch { /* already gone */ } }
        }
    } catch { /* isolate layer unavailable */ }
}

/** Start the workers of a site this process had prepared, after a resume (in the background). */
function restartSiteWorkers(id: number): void {
    if (!prepared.has(id)) return;
    siteContext.runWithSite(id, async () => {
        await require('./plugins').loadSitePlugins();
        try { await require('./theme-engine').init(); } catch { /* logged by the engine */ }
    }).catch(() => { /* loadSitePlugins never throws */ });
}

/**
 * Forget a site this process had prepared (it was deleted, here or on another node): its workers stop,
 * its database connection closes, and its in-memory runtime is dropped with the preparation.
 */
async function forgetSite(id: number): Promise<void> {
    stopSiteWorkers(id);
    prepared.delete(id);
    try { await require('../config/database').closeSiteDatabase(id); } catch { /* already closed */ }
}

async function setSiteStatus(id: number, status: 'active' | 'suspended', actorUserId: number | null = null) {
    const site = await network.setSiteStatus(id, status);
    // A suspended site answers nothing, so its plugin and theme workers have nothing to do: stop them.
    // Resumed after this process had prepared it: start them again (a site prepared later starts them in
    // initSiteRuntime). The other nodes do the same when the registry change reaches them.
    if (status === 'suspended') stopSiteWorkers(id);
    else restartSiteWorkers(id);
    await network.audit(status === 'suspended' ? 'site.suspended' : 'site.resumed', { actor: actorUserId, siteId: id });
    afterRegistryChange();
    return site;
}

/**
 * Delete site `id` and everything it holds: its media objects in the bucket, its database (file,
 * Postgres schema or MySQL database), its directory of uploads and private files, the database principals
 * of its plugins, its cached entries, its certificates and its record and addresses. The site must be
 * suspended first (nothing is serving it while it goes) and `confirmSlug` must repeat its slug. The
 * main site is never deleted. Its id is never reused (core/network keeps a high-water mark), so nothing
 * a failed step leaves behind can ever surface in a later site.
 */
async function deleteSite(id: number, opts: { confirmSlug?: unknown; actorUserId?: number | null } = {}): Promise<void> {
    if (id === siteContext.PRIMARY_SITE_ID) throw codedError('network_primary_site', 'The main site cannot be deleted.');
    const site = network.getSite(id);
    if (!site) throw codedError('network_site_not_found', 'No such site.', 404);
    if (site.status !== 'suspended') throw codedError('network_site_active', 'Suspend the site before deleting it.', 409);
    if (opts.confirmSlug !== site.slug) throw codedError('network_confirm_mismatch', 'Type the slug of the site to confirm its deletion.');
    const database = require('../config/database');
    stopSiteWorkers(id);
    const warnings: string[] = [];
    await siteContext.runWithSite(id, async () => {
        // Its database only: preparing the whole site would start the workers it is losing.
        try { await database.openSiteDatabase(id, network.isSqlStore() ? null : (site.dbPath || network.siteDbPath(id))); }
        catch (e: any) { warnings.push(`open: ${e && e.message}`); }
        // The site's objects in the media bucket: listed from its own database, so before it goes.
        try {
            const storage = require('./media-storage');
            const store = storage.resolveMediaStorage();
            if (store.driver === 's3' && database.isSiteDatabaseOpen(id)) {
                const items = await require('./media-storage-migrate').offloadedItems();
                const rels = ([] as string[]).concat(...items.map((i: any) => i.rels));
                if (rels.length) await storage.removeFiles(storage.getMediaStorage(store), rels);
            }
        } catch (e: any) { warnings.push(`media bucket: ${e && e.message}`); }
        // Its plugins' database principals (Postgres roles / MySQL users named for this site).
        try {
            const slugs = require('./plugins').scanPlugins().map((p: any) => p.slug);
            await require('./plugin-db-isolation').dropSitePrincipals(slugs);
        } catch (e: any) { warnings.push(`plugin principals: ${e && e.message}`); }
        // Its entries in the shared cache (core/cache namespaces them s<id>:).
        try { await require('./cache').flush(); } catch (e: any) { warnings.push(`cache: ${e && e.message}`); }
    });
    prepared.delete(id);
    try { await database.dropSiteDatabase(id); } catch (e: any) { warnings.push(`database: ${e && e.message}`); }
    try { fs.rmSync(network.siteDataDir(id), { recursive: true, force: true }); } catch (e: any) { warnings.push(`files: ${e && e.message}`); }
    try { await require('./site-certs').forgetSiteCertificates(id, site.mainHost); } catch (e: any) { warnings.push(`certificates: ${e && e.message}`); }
    await network.deleteSiteRecord(id);
    await network.audit('site.deleted', { actor: opts.actorUserId ?? null, siteId: id, detail: { slug: site.slug, url: site.mainUrl, warnings } });
    if (warnings.length) log.warn(`[multisite] site ${id} deleted with leftovers to check: ${warnings.join('; ')}`);
    afterRegistryChange();
}

/**
 * Another node changed the registry (core/network reloads its mirror from the shared store): make THIS
 * node match it. A site suspended there stops its workers here; one resumed starts them again here if
 * this node had prepared it; one deleted is forgotten. New sites need nothing: they are prepared on their
 * first request. The gateway is told the new addresses as after a local change.
 */
function followRegistryChanges(): void {
    network.onRegistryChange(({ before, after }: { before: any[]; after: any[] }) => {
        const now = new Map(after.map((s: any) => [s.id, s]));
        for (const old of before) {
            if (old.id === siteContext.PRIMARY_SITE_ID) continue;
            const cur = now.get(old.id);
            if (!cur) { forgetSite(old.id).catch(() => { /* best-effort */ }); continue; }
            if (cur.status !== old.status) {
                if (cur.status === 'suspended') stopSiteWorkers(old.id);
                else restartSiteWorkers(old.id);
            }
        }
        afterRegistryChange();
    });
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
        log.warn(`[multisite] ${label}: the network store could not be read (${e && e.message}).`);
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
            log.warn(`[multisite] ${label} failed for site ${site.id}: ${e && e.message}`);
        }
    }
}

/**
 * Run `fn` once per site other than site 1 that THIS process has prepared (and that is active), each in
 * its own context, without preparing any other: periodic upkeep of what a node already runs.
 */
async function forEachOpenSecondarySite(label: string, fn: (siteId: number) => Promise<void> | void): Promise<void> {
    if (!siteContext.multisiteEnabled()) return;
    for (const [id, p] of Array.from(prepared.entries())) {
        const site = (() => { try { return network.getSite(id); } catch { return null; } })();
        if (!site || site.status !== 'active') continue;
        try {
            await p;
            await siteContext.runWithSite(id, async () => { await fn(id); });
        } catch (e: any) {
            log.warn(`[multisite] ${label} failed for site ${id}: ${e && e.message}`);
        }
    }
}

module.exports = {
    forEachOpenSecondarySite,
    prepareSite,
    resetPreparedSites,
    createSite,
    setSiteStatus,
    deleteSite,
    forgetSite,
    followRegistryChanges,
    isPrepared: (id: number) => prepared.has(id),
    whenPrepared: (id: number) => prepared.get(id) || null,
    forEachSecondarySite,
    assertHostAvailable,
};
