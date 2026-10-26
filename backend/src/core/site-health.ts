/**
 * WordJS — Site Health: the installation's diagnostics, in plain words, with where to fix each one in the
 * panel (Admin → Site Health, GET /health/site). Zero config: an administrator should never need a
 * terminal to learn why mail does not go out, why every visitor looks like 127.0.0.1, or that the disk
 * is filling up.
 *
 * Each check answers { id, group, status: ok | warn | fail | info, title, message, fix? } and never
 * throws: a check that cannot run says so (status info) instead of hiding the others. Nothing here
 * writes. The deeper probes (sandbox kernel, mTLS files, content outbox, purge) are core/system-health's,
 * read and translated, so the screen and GET /health/details can never disagree.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'info';
export type HealthCheck = {
    id: string;
    group: 'versions' | 'storage' | 'database' | 'mail' | 'security' | 'background';
    status: HealthStatus;
    title: string;
    message: string;
    fix?: { href: string; label: string; labelKey?: string };
    /**
     * Catalogue keys for the panel's own languages: `titleKey` names the title, `messageKey` the exact
     * message variant, `vars` its dynamic parts ({name} placeholders). `title`/`message`/`fix.label` stay the
     * English text for every other consumer of GET /health/site.
     */
    titleKey?: string;
    messageKey?: string;
    vars?: Record<string, string>;
};

const MIN_NODE_MAJOR = 22;
const DISK_WARN_BYTES = 2 * 1024 ** 3;
const DISK_FAIL_BYTES = 512 * 1024 ** 2;

/** Where a check points to be fixed: English label for API consumers, catalogue key for the panel. */
const FIX = {
    updates: { href: '/admin/update', label: 'Updates', labelKey: 'siteHealth.fixLabel.updates' },
    backups: { href: '/admin/settings/backups', label: 'Backups', labelKey: 'siteHealth.fixLabel.backups' },
    mediaStorage: { href: '/admin/settings/media-storage', label: 'Media storage', labelKey: 'siteHealth.fixLabel.mediaStorage' },
    migrateEngine: { href: '/admin/settings/network', label: 'Move to sqlite-native', labelKey: 'siteHealth.fixLabel.migrateEngine' },
    accountEmail: { href: '/admin/settings/email', label: 'Account email', labelKey: 'siteHealth.fixLabel.accountEmail' },
    certificates: { href: '/admin/security', label: 'Certificates', labelKey: 'siteHealth.fixLabel.certificates' },
    securityServer: { href: '/admin/security', label: 'Security → Server', labelKey: 'siteHealth.fixLabel.securityServer' },
    webhooks: { href: '/admin/webhooks', label: 'Webhooks', labelKey: 'siteHealth.fixLabel.webhooks' },
    duplicates: { href: '/admin/database-integrity', label: 'Duplicate records', labelKey: 'siteHealth.fixLabel.duplicates' },
    audit: { href: '/admin/audit', label: 'Audit', labelKey: 'siteHealth.fixLabel.audit' },
} as const;

/**
 * One check, with its catalogue keys: the title is `siteHealth.check.<id>.title`, the message
 * `siteHealth.check.<id>.<variant>`, and `vars` fill its {placeholders}.
 */
function check(id: string, group: HealthCheck['group'], status: HealthStatus, variant: string, title: string, message: string, vars?: Record<string, unknown>, fix?: { href: string; label: string; labelKey?: string }): HealthCheck {
    const out: HealthCheck = { id, group, status, title, message, titleKey: `siteHealth.check.${id}.title`, messageKey: `siteHealth.check.${id}.${variant}` };
    if (vars) out.vars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)]));
    if (fix) out.fix = { ...fix };
    return out;
}

function config(): any { return require('../config/app'); }

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    let t: any;
    try {
        return await Promise.race([p, new Promise<T>((resolve) => { t = setTimeout(() => resolve(fallback), ms); })]);
    } finally { clearTimeout(t); }
}

async function safe(id: string, group: HealthCheck['group'], title: string, fn: () => Promise<HealthCheck | HealthCheck[]> | HealthCheck | HealthCheck[]): Promise<HealthCheck[]> {
    try {
        const r = await fn();
        return Array.isArray(r) ? r : [r];
    } catch (e: any) {
        const error = String((e && e.message) || e);
        const c = check(id, group, 'info', 'error', title, `This check could not run here (${error}).`, { error });
        c.messageKey = 'siteHealth.check.error';
        return [c];
    }
}

function fmtBytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    return `${Math.round(n / 1024 ** 2)} MB`;
}

function checkNode(): HealthCheck {
    const major = Number(process.versions.node.split('.')[0]);
    const version = (() => { try { return require('../config/product-version').resolveProductVersion(); } catch { return 'unknown'; } })();
    return major >= MIN_NODE_MAJOR
        ? check('versions.node', 'versions', 'ok', 'ok', 'WordJS and Node.js', `WordJS ${version} on Node.js ${process.versions.node}.`, { version, node: process.versions.node })
        : check('versions.node', 'versions', 'fail', 'old', 'WordJS and Node.js', `Node.js ${process.versions.node} is older than ${MIN_NODE_MAJOR}, which WordJS needs. Ask your host to install Node.js ${MIN_NODE_MAJOR} or 24 LTS.`, { node: process.versions.node, min: MIN_NODE_MAJOR });
}

async function checkUpdate(): Promise<HealthCheck> {
    const o = await withTimeout(require('./updater').overview(), 6000, null as any);
    if (!o || o.error) return check('versions.update', 'versions', 'info', 'offline', 'Updates', 'Could not check for a newer WordJS from here (no connection to GitHub).');
    if (!o.latest) return check('versions.update', 'versions', 'ok', 'latest', 'Updates', `WordJS ${o.current} is the latest release.`, { current: o.current });
    return check('versions.update', 'versions', 'warn', 'available', 'Updates', `WordJS ${o.latest.version} is available (this site runs ${o.current}).`, { latest: o.latest.version, current: o.current }, FIX.updates);
}

async function checkFolders(): Promise<HealthCheck[]> {
    const fsStatus = await require('./system-health').checkFilesystem();
    const notWritable = Object.entries(fsStatus).filter(([, v]) => v !== 'WRITABLE').map(([k]) => k);
    const configFile = require('./configManager').CONFIG_FILE;
    let configWritable = true;
    try { fs.accessSync(configFile, fs.constants.W_OK); } catch { configWritable = !fs.existsSync(configFile); }
    const out: HealthCheck[] = [];
    out.push(notWritable.length
        ? check('storage.folders', 'storage', 'fail', 'notWritable', 'Folders WordJS writes to', `WordJS cannot write to: ${notWritable.join(', ')}. Uploads, plugins or themes fail until the folder belongs to the account WordJS runs as.`, { folders: notWritable.join(', ') })
        : check('storage.folders', 'storage', 'ok', 'ok', 'Folders WordJS writes to', 'Uploads, data, plugins and themes are writable.'));
    out.push(configWritable
        ? check('storage.config', 'storage', 'ok', 'ok', 'Configuration file', 'WordJS can save the settings that live in wordjs-config.json.')
        : check('storage.config', 'storage', 'fail', 'readOnly', 'Configuration file', 'wordjs-config.json is read-only for WordJS, so changes made in the panel (site address, network, server settings) cannot be saved.'));
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        out.push(check('storage.root', 'storage', 'warn', 'root', 'Account WordJS runs as', 'WordJS is running as root. Files it creates belong to root; run it as its own service account (create-wordjs --systemd does).'));
    }
    return out;
}

async function checkDisk(): Promise<HealthCheck> {
    const dir = path.resolve('./data');
    if (typeof (fs as any).statfsSync !== 'function') {
        return check('storage.disk', 'storage', 'info', 'unsupported', 'Free disk space', 'This Node.js cannot report free disk space.');
    }
    const st = (fs as any).statfsSync(fs.existsSync(dir) ? dir : process.cwd());
    const free = Number(st.bavail) * Number(st.bsize);
    const total = Number(st.blocks) * Number(st.bsize);
    const msg = `${fmtBytes(free)} free of ${fmtBytes(total)}.`;
    const vars = { free: fmtBytes(free), total: fmtBytes(total) };
    if (free < DISK_FAIL_BYTES) return check('storage.disk', 'storage', 'fail', 'critical', 'Free disk space', `${msg} Uploads, backups and the database can fail. Delete old backups or move media to a bucket.`, vars, FIX.backups);
    if (free < DISK_WARN_BYTES) return check('storage.disk', 'storage', 'warn', 'low', 'Free disk space', `${msg} Running low.`, vars, FIX.mediaStorage);
    return check('storage.disk', 'storage', 'ok', 'ok', 'Free disk space', msg, vars);
}

async function checkDatabase(): Promise<HealthCheck[]> {
    const r = await require('./system-health').checkDatabase({ timeoutMs: 3000 });
    const driver = String(config().dbDriver || 'sqlite-native');
    const out: HealthCheck[] = [];
    out.push(r.status === 'OK'
        ? check('database.reachable', 'database', 'ok', 'ok', 'Database', `The database answers (${driver}).`, { driver })
        : check('database.reachable', 'database', 'fail', 'down', 'Database', `The database does not answer: ${r.message}.`, { error: r.message }));
    if (driver === 'sqlite-legacy') {
        out.push(check('database.driver', 'database', 'warn', 'legacy', 'Database engine', 'This site runs on the older, slower SQLite engine (sqlite-legacy), which keeps the whole database in memory and cannot hold a network of sites. Move it to the current engine: it takes a minute and restarts WordJS by itself.', undefined, FIX.migrateEngine));
    }
    if (r.status !== 'OK') return out;
    const db = require('../config/database').getDbAsync();
    if (driver === 'postgres') {
        const enc = await db.get('SHOW server_encoding').catch(() => null);
        const encoding = String((enc && enc.server_encoding) || '').toUpperCase();
        if (encoding && encoding !== 'UTF8') {
            out.push({ id: 'database.encoding', group: 'database', status: 'warn', title: 'Database encoding', message: `The PostgreSQL database uses ${encoding}, not UTF8: accented and non-Latin words cannot be found by search and case rules work byte by byte. Create a database with ENCODING 'UTF8' TEMPLATE template0 and move the site to it with Database migration.`, fix: { href: '/admin/db-migration', label: 'Database migration' } });
        }
    }
    if (driver === 'sqlite-native') {
        const fts = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'posts_fts'").catch(() => null);
        if (!fts) out.push({ id: 'database.search', group: 'database', status: 'warn', title: 'Search index', message: 'The full-text search index is missing, so search is slower and does not ignore accents. Restart WordJS to build it.' });
    }
    if (driver === 'postgres' || driver === 'mysql') {
        const tool = driver === 'postgres' ? 'pg_dump' : 'mysqldump';
        const available = await require('./db-dump').isToolAvailable(tool);
        out.push(available
            ? { id: 'database.backup', group: 'database', status: 'ok', title: 'Database backups', message: `Backups include a ${tool} dump of the database.` }
            : { id: 'database.backup', group: 'database', status: 'info', title: 'Database backups', message: `Backups include WordJS's own dump of every table, because ${tool} is not installed on this host. It restores the whole database; ${tool} would also keep views and custom indexes.`
            });
    }
    return out;
}

async function checkMail(): Promise<HealthCheck[]> {
    const out: HealthCheck[] = [];
    // The same answer password recovery gets (core/account-mail): is there a transport that may carry it.
    let canSend = false;
    try { canSend = (await require('./account-mail').accountMailReady()) === true; } catch { /* not ready */ }
    out.push(canSend
        ? check('mail.transport', 'mail', 'ok', 'ok', 'Sending email', 'The site can send password resets and notifications.')
        : check('mail.transport', 'mail', 'fail', 'none', 'Sending email', 'The site cannot send email yet, so "Forgot password?" does not work and nobody is notified. Set up account email.', undefined, FIX.accountEmail));

    // The domain mail is sent from: SPF and DMARC records, without which mail lands in spam.
    let adminEmail = '';
    try { adminEmail = String(await require('./options').getOption('admin_email', '') || ''); } catch { /* */ }
    const domain = adminEmail.includes('@') ? adminEmail.split('@').pop()!.toLowerCase() : '';
    if (!domain || domain.endsWith('.localhost') || domain === 'localhost' || domain.endsWith('.example') || domain.endsWith('.test')) {
        out.push(domain
            ? check('mail.dns', 'mail', 'info', 'local', 'Mail domain (SPF, DMARC)', `${domain} is a local or reserved name; there are no DNS records to check.`, { domain })
            : check('mail.dns', 'mail', 'info', 'noEmail', 'Mail domain (SPF, DMARC)', 'Set the site email in Settings → General to check its domain.'));
        return out;
    }
    const dns = require('dns').promises;
    const txt = async (name: string): Promise<string[]> => withTimeout(dns.resolveTxt(name).then((r: string[][]) => r.map((x) => x.join(''))).catch(() => []), 3000, [] as string[]);
    const [spf, dmarc] = await Promise.all([txt(domain), txt(`_dmarc.${domain}`)]);
    const hasSpf = spf.some((r) => /^v=spf1\b/i.test(r));
    const hasDmarc = dmarc.some((r) => /^v=DMARC1\b/i.test(r));
    out.push(hasSpf && hasDmarc
        ? check('mail.dns', 'mail', 'ok', 'ok', 'Mail domain (SPF, DMARC)', `${domain} publishes SPF and DMARC.`, { domain })
        : check('mail.dns', 'mail', 'warn', !hasSpf && !hasDmarc ? 'missingBoth' : !hasSpf ? 'missingSpf' : 'missingDmarc', 'Mail domain (SPF, DMARC)', `${domain} is missing ${[!hasSpf && 'an SPF record', !hasDmarc && 'a DMARC record'].filter(Boolean).join(' and ')}: mail from the site is likely to land in spam. Add them where the domain's DNS is managed; your mail provider gives the exact values.`, { domain }, FIX.accountEmail));
    return out;
}

async function checkTls(): Promise<HealthCheck> {
    const siteUrl = String((require('./configManager').getConfig() || {}).siteUrl || config().siteUrl || '');
    const local = /^https?:\/\/(localhost|127\.|\[::1\]|[^/]+\.localhost)(:|\/|$)/i.test(siteUrl);
    if (!siteUrl.startsWith('https://')) {
        return local
            ? check('security.tls', 'security', 'info', 'local', 'HTTPS', 'A local install: plain HTTP is fine on this computer.')
            : siteUrl
                ? check('security.tls', 'security', 'warn', 'http', 'HTTPS', `The main address (${siteUrl}) is not HTTPS: passwords travel unencrypted. Get a certificate, then switch the address to https.`, { url: siteUrl }, FIX.certificates)
                : check('security.tls', 'security', 'warn', 'noAddress', 'HTTPS', 'The main address (not set) is not HTTPS: passwords travel unencrypted. Get a certificate, then switch the address to https.', undefined, FIX.certificates);
    }
    const cm = require('./cert-manager');
    const info = await withTimeout(cm.getConfig().catch(() => null), 4000, null as any);
    const validTo = info && info.certInfo && info.certInfo.validTo;
    if (!validTo) return check('security.tls', 'security', 'info', 'unreadable', 'HTTPS', 'HTTPS is configured; the certificate in use could not be read from here (a proxy may hold it).');
    const days = Math.floor((new Date(validTo).getTime() - Date.now()) / 86400000);
    const type = info.certInfo.type;
    if (days < 0) return check('security.tls', 'security', 'fail', 'expired', 'HTTPS', `The certificate expired ${-days} day(s) ago: browsers refuse the site.`, { days: -days }, FIX.certificates);
    if (type === 'self-signed' && !local) return check('security.tls', 'security', 'warn', 'selfSigned', 'HTTPS', 'The certificate is self-signed: visitors see a security warning. Get a free Let’s Encrypt certificate.', undefined, FIX.certificates);
    if (days < 14) return check('security.tls', 'security', 'warn', 'expiring', 'HTTPS', `The certificate expires in ${days} day(s). Turn on automatic renewal or renew it now.`, { days }, FIX.certificates);
    return check('security.tls', 'security', 'ok', 'ok', 'HTTPS', `The certificate is valid for ${days} more day(s).`, { days });
}

function checkProxy(req: any): HealthCheck {
    const clientIp = require('./client-ip');
    const xff = req && req.headers && req.headers['x-forwarded-for'];
    const first = String(Array.isArray(xff) ? xff.join(',') : xff || '').split(',')[0].trim();
    const seenThroughProxy = !!first && !clientIp.isLoopbackAddress(first) && clientIp.isLoopbackAddress(clientIp.clientIp(req));
    const embedded = process.env.WORDJS_EMBEDDED === '1';
    if (seenThroughProxy) {
        return check('security.proxy', 'security', 'fail', 'untrusted', 'Reverse proxy', 'This request came through a proxy on this computer that WordJS does not trust: every visitor is seen as 127.0.0.1, so login lockout and rate limits treat the whole site as one person.', undefined, embedded ? FIX.securityServer : undefined);
    }
    const tp = clientIp.resolveTrustProxy();
    if (tp === false || tp === 0) return check('security.proxy', 'security', 'ok', 'none', 'Reverse proxy', 'No proxy is trusted, and none was seen: visitors are counted by their own address.');
    const trusted = Array.isArray(tp) ? tp.join(', ') : String(tp);
    return check('security.proxy', 'security', 'ok', 'trusted', 'Reverse proxy', `Trusted proxy: ${trusted}.`, { proxy: trusted });
}

async function checkBackground(): Promise<HealthCheck[]> {
    const SystemHealth = require('./system-health');
    const out: HealthCheck[] = [];
    let cronRunning = false;
    try { cronRunning = require('./cron').isCronRunning() === true; } catch { /* */ }
    out.push(cronRunning
        ? check('background.cron', 'background', 'ok', 'ok', 'Scheduled tasks', 'Scheduled publishing, backups and renewals run.')
        : check('background.cron', 'background', 'warn', 'stopped', 'Scheduled tasks', 'The scheduler is not running in this process: scheduled posts, backups and certificate renewals wait. Restart WordJS; if it persists, check the log.'));
    const sandbox = SystemHealth.checkSandbox();
    const degraded = sandbox && (sandbox.kernelDegraded === true || String(sandbox.status || '').toUpperCase() === 'DEGRADED');
    out.push(degraded
        ? check('background.plugins', 'background', 'warn', 'degraded', 'Plugin isolation', 'Plugins run, but without the operating system’s extra confinement on this host. Your host may need a newer kernel or the platform’s sandbox enabled.')
        : check('background.plugins', 'background', 'ok', 'ok', 'Plugin isolation', 'Plugins run isolated from the site and from each other.'));
    const outbox = await SystemHealth.checkContentOutbox();
    const dead = Number(outbox && outbox.dead) || 0;
    out.push(dead > 0
        ? check('background.outbox', 'background', 'warn', 'dead', 'Content events', `${dead} content event(s) could not be delivered (webhooks, search, cache).`, { count: dead }, FIX.webhooks)
        : check('background.outbox', 'background', 'ok', 'ok', 'Content events', 'Webhooks and cache updates are delivered.'));
    const purge = SystemHealth.checkPurge();
    if (purge && Array.isArray(purge.broken) && purge.broken.length) {
        out.push(check('background.purge', 'background', 'warn', 'broken', 'Page cache', 'Published changes reach visitors only when the page cache expires: on-demand cache updates failed in this process.'));
    }
    const restart = require('./restart').restartMode();
    out.push(restart === 'manual'
        ? check('background.restart', 'background', 'warn', 'manual', 'Restarting by itself', 'Nothing here restarts WordJS: after a database move, a restore or a network switch you will have to restart it by hand. Start it with npm start, the monolith, Docker or systemd.')
        : check('background.restart', 'background', 'ok', 'ok', 'Restarting by itself', `WordJS restarts itself when a change needs it (${restart}).`, { mode: restart }));
    return out;
}

/**
 * The gateway and the servers behind it (split and separate modes; nothing to report in a monolith).
 * QA X1-03/X1-04: the panel never said that the gateway served another protocol than its switch, and a
 * frontend node that stopped answering left the panel all green while visitors got an error page.
 */
async function checkEdge(): Promise<HealthCheck[]> {
    if (process.env.WORDJS_MODE === 'mono' || process.env.WORDJS_EMBEDDED === '1') return [];
    const certManager = require('./cert-manager');
    const out: HealthCheck[] = [];
    const info = await withTimeout<any>(Promise.resolve(certManager.getConfig()).catch(() => null), 3000, null);
    if (info && !info.error && (info.serving === 'http' || info.serving === 'https')) {
        const servesHttps = info.serving === 'https';
        out.push(info.sslEnabled === servesHttps
            ? { id: 'security.edge', group: 'security', status: 'ok', title: 'Gateway protocol', message: `The gateway serves ${servesHttps ? 'HTTPS' : 'plain HTTP'}, as configured.` }
            : { id: 'security.edge', group: 'security', status: 'warn', title: 'Gateway protocol', message: info.sslEnabled ? 'HTTPS is switched on, but the gateway serves plain HTTP: it has no certificate to serve.' : 'HTTPS is switched off, but the gateway still serves HTTPS.', fix: { href: '/admin/security', label: 'Security' } });
    }
    let nodes: any[] | null = null;
    try {
        const r = await withTimeout<any>(certManager.gatewayControlRequest('GET', '/cluster', null, 2500).catch(() => null), 3000, null);
        if (r && r.status === 200) nodes = (JSON.parse(r.text) || {}).nodes || null;
    } catch { nodes = null; }
    if (Array.isArray(nodes) && nodes.length) {
        const down = nodes.filter((n) => n && n.status === 'down');
        const label = (n: any) => `${n.role === 'frontend' ? 'frontend' : n.role === 'backend' ? 'backend' : 'server'} ${String(n.url || '').replace(/^https?:\/\//, '')}`;
        out.push(down.length
            ? { id: 'background.cluster', group: 'background', status: 'fail', title: 'Servers', message: `${down.length} of ${nodes.length} server(s) do not answer the gateway: ${down.map(label).join(', ')}. Visitors whose requests need ${down.length === 1 ? 'it' : 'them'} get a "back in a moment" page until ${down.length === 1 ? 'it is' : 'they are'} running again.`, fix: { href: '/admin/cluster', label: 'Servers' } }
            : { id: 'background.cluster', group: 'background', status: 'ok', title: 'Servers', message: `All ${nodes.length} server(s) behind the gateway answer.` });
    }
    return out;
}

/**
 * The uniqueness rules the database enforces (core/unique-integrity). A rule whose unique index could not
 * be built — stored rows repeat a login, an email or a slug — is a warning that leads to the screen where
 * an administrator chooses which row keeps the value.
 */
async function checkUniqueRules(): Promise<HealthCheck> {
    const rules = await require('./unique-integrity').uniqueIntegrityStatus();
    const open = rules.filter((r: any) => !r.enforced);
    if (!open.length) return check('database.unique', 'database', 'ok', 'ok', 'Unique logins, emails and slugs', 'The database itself enforces that logins, email addresses and slugs are unique.');
    const names = open.map((r: any) => r.id).join(', ');
    const groups = open.reduce((n: number, r: any) => n + (Number(r.duplicateGroups) || 0), 0);
    return groups > 0
        ? check('database.unique', 'database', 'warn', 'duplicates', 'Unique logins, emails and slugs', `${groups} value(s) are stored more than once (${names}), so the database cannot enforce that rule yet. Choose which record keeps each value; the others get a new one and nothing is deleted.`, { count: groups, rules: names }, FIX.duplicates)
        : check('database.unique', 'database', 'warn', 'missing', 'Unique logins, emails and slugs', `The unique index for ${names} is missing although nothing repeats. Build it from Duplicate records.`, { rules: names }, FIX.duplicates);
}

/** The audit log's hash chain (core/audit-chain) and its copy outside the site (core/audit-export). */
async function checkAuditLog(): Promise<HealthCheck[]> {
    const chain = require('./audit-chain');
    await chain.sealPending();
    const r = await chain.verifyAuditChain({ maxMs: 5000 });
    const out: HealthCheck[] = [];
    if (!r.ok && r.firstBreak) {
        const why: Record<string, string> = {
            altered: 'its content was changed', gap: 'the entry before it is missing',
            link: 'it does not link to the entry before it', start: 'the oldest entries do not match what retention removed',
        };
        const reason = r.firstBreak.reason;
        out.push(check('security.auditChain', 'security', 'fail', `broken.${reason}`, 'Audit log integrity', `The audit log's hash chain breaks at entry ${r.firstBreak.seq}: ${why[reason]}. Entries were changed or removed outside WordJS; compare with the external copy.`, { seq: r.firstBreak.seq ?? '' }, FIX.audit));
    } else if (!r.complete) {
        out.push(check('security.auditChain', 'security', 'info', 'partial', 'Audit log integrity', `The first ${r.checked} entries of the audit log match their hash chain; the rest were not checked in time. Admin → Audit checks all of them.`, { count: r.checked }, FIX.audit));
    } else {
        out.push(check('security.auditChain', 'security', 'ok', 'ok', 'Audit log integrity', `Every entry of the audit log (${r.checked}) matches its hash chain.`, { count: r.checked }));
    }
    const ex = await require('./audit-export').exportStatus();
    const target = ex.config.mode === 'webhook' ? ex.config.url : `${ex.config.host}:${ex.config.port}`;
    if (ex.config.mode === 'off') {
        out.push(check('security.auditExport', 'security', 'info', 'off', 'Copy of the audit log', 'The audit log is kept only in this database. Send a copy to a syslog server or a webhook, so what it records cannot be erased from here.', undefined, FIX.audit));
    } else if (ex.lastError) {
        out.push(check('security.auditExport', 'security', 'warn', 'failing', 'Copy of the audit log', `The copy to ${target} is failing (${ex.lastError}); ${ex.behind} entr(ies) are waiting and are sent when it answers again.`, { target, error: ex.lastError, count: ex.behind }, FIX.audit));
    } else {
        out.push(check('security.auditExport', 'security', 'ok', 'ok', 'Copy of the audit log', `Every entry is copied to ${target}.`, { target }));
    }
    return out;
}

/** Every check, in screen order. `req` lets the proxy check judge the request that asked. */
async function runSiteHealth(req: any): Promise<{ checks: HealthCheck[]; summary: Record<HealthStatus, number>; at: string; host: string }> {
    const groups = await Promise.all([
        safe('versions.node', 'versions', 'WordJS and Node.js', checkNode),
        safe('versions.update', 'versions', 'Updates', checkUpdate),
        safe('storage.folders', 'storage', 'Folders WordJS writes to', checkFolders),
        safe('storage.disk', 'storage', 'Free disk space', checkDisk),
        safe('database.reachable', 'database', 'Database', checkDatabase),
        safe('database.unique', 'database', 'Unique logins, emails and slugs', checkUniqueRules),
        safe('mail.transport', 'mail', 'Sending email', checkMail),
        safe('security.tls', 'security', 'HTTPS', checkTls),
        safe('security.proxy', 'security', 'Reverse proxy', () => checkProxy(req)),
        safe('security.auditChain', 'security', 'Audit log integrity', checkAuditLog),
        safe('background.cron', 'background', 'Scheduled tasks', checkBackground),
        safe('background.cluster', 'background', 'Servers', checkEdge),
    ]);
    const checks = groups.flat();
    const summary: Record<HealthStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
    for (const c of checks) summary[c.status]++;
    return { checks, summary, at: new Date().toISOString(), host: os.hostname() };
}

module.exports = { runSiteHealth, checkProxy, checkDisk, checkEdge, checkUniqueRules, checkAuditLog };
