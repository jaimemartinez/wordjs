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
    fix?: { href: string; label: string };
};

const MIN_NODE_MAJOR = 22;
const DISK_WARN_BYTES = 2 * 1024 ** 3;
const DISK_FAIL_BYTES = 512 * 1024 ** 2;

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
        return [{ id, group, status: 'info', title, message: `This check could not run here (${(e && e.message) || e}).` }];
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
        ? { id: 'versions.node', group: 'versions', status: 'ok', title: 'WordJS and Node.js', message: `WordJS ${version} on Node.js ${process.versions.node}.` }
        : { id: 'versions.node', group: 'versions', status: 'fail', title: 'WordJS and Node.js', message: `Node.js ${process.versions.node} is older than ${MIN_NODE_MAJOR}, which WordJS needs. Ask your host to install Node.js ${MIN_NODE_MAJOR} or 24 LTS.` };
}

async function checkUpdate(): Promise<HealthCheck> {
    const o = await withTimeout(require('./updater').overview(), 6000, null as any);
    if (!o || o.error) return { id: 'versions.update', group: 'versions', status: 'info', title: 'Updates', message: 'Could not check for a newer WordJS from here (no connection to GitHub).' };
    if (!o.latest) return { id: 'versions.update', group: 'versions', status: 'ok', title: 'Updates', message: `WordJS ${o.current} is the latest release.` };
    return { id: 'versions.update', group: 'versions', status: 'warn', title: 'Updates', message: `WordJS ${o.latest.version} is available (this site runs ${o.current}).`, fix: { href: '/admin/update', label: 'Updates' } };
}

async function checkFolders(): Promise<HealthCheck[]> {
    const fsStatus = await require('./system-health').checkFilesystem();
    const notWritable = Object.entries(fsStatus).filter(([, v]) => v !== 'WRITABLE').map(([k]) => k);
    const configFile = require('./configManager').CONFIG_FILE;
    let configWritable = true;
    try { fs.accessSync(configFile, fs.constants.W_OK); } catch { configWritable = !fs.existsSync(configFile); }
    const out: HealthCheck[] = [];
    out.push(notWritable.length
        ? { id: 'storage.folders', group: 'storage', status: 'fail', title: 'Folders WordJS writes to', message: `WordJS cannot write to: ${notWritable.join(', ')}. Uploads, plugins or themes fail until the folder belongs to the account WordJS runs as.` }
        : { id: 'storage.folders', group: 'storage', status: 'ok', title: 'Folders WordJS writes to', message: 'Uploads, data, plugins and themes are writable.' });
    out.push(configWritable
        ? { id: 'storage.config', group: 'storage', status: 'ok', title: 'Configuration file', message: 'WordJS can save the settings that live in wordjs-config.json.' }
        : { id: 'storage.config', group: 'storage', status: 'fail', title: 'Configuration file', message: 'wordjs-config.json is read-only for WordJS, so changes made in the panel (site address, network, server settings) cannot be saved.' });
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        out.push({ id: 'storage.root', group: 'storage', status: 'warn', title: 'Account WordJS runs as', message: 'WordJS is running as root. Files it creates belong to root; run it as its own service account (create-wordjs --systemd does).' });
    }
    return out;
}

async function checkDisk(): Promise<HealthCheck> {
    const dir = path.resolve('./data');
    if (typeof (fs as any).statfsSync !== 'function') {
        return { id: 'storage.disk', group: 'storage', status: 'info', title: 'Free disk space', message: 'This Node.js cannot report free disk space.' };
    }
    const st = (fs as any).statfsSync(fs.existsSync(dir) ? dir : process.cwd());
    const free = Number(st.bavail) * Number(st.bsize);
    const total = Number(st.blocks) * Number(st.bsize);
    const msg = `${fmtBytes(free)} free of ${fmtBytes(total)}.`;
    if (free < DISK_FAIL_BYTES) return { id: 'storage.disk', group: 'storage', status: 'fail', title: 'Free disk space', message: `${msg} Uploads, backups and the database can fail. Delete old backups or move media to a bucket.`, fix: { href: '/admin/settings/backups', label: 'Backups' } };
    if (free < DISK_WARN_BYTES) return { id: 'storage.disk', group: 'storage', status: 'warn', title: 'Free disk space', message: `${msg} Running low.`, fix: { href: '/admin/settings/media-storage', label: 'Media storage' } };
    return { id: 'storage.disk', group: 'storage', status: 'ok', title: 'Free disk space', message: msg };
}

async function checkDatabase(): Promise<HealthCheck[]> {
    const r = await require('./system-health').checkDatabase({ timeoutMs: 3000 });
    const driver = String(config().dbDriver || 'sqlite-native');
    const out: HealthCheck[] = [];
    out.push(r.status === 'OK'
        ? { id: 'database.reachable', group: 'database', status: 'ok', title: 'Database', message: `The database answers (${driver}).` }
        : { id: 'database.reachable', group: 'database', status: 'fail', title: 'Database', message: `The database does not answer: ${r.message}.` });
    if (driver === 'sqlite-legacy') {
        out.push({ id: 'database.driver', group: 'database', status: 'warn', title: 'Database engine', message: 'This site runs on the older, slower SQLite engine (sqlite-legacy), which keeps the whole database in memory and cannot hold a network of sites. Move it to the current engine: it takes a minute and restarts WordJS by itself.', fix: { href: '/admin/settings/network', label: 'Move to sqlite-native' } });
    }
    return out;
}

async function checkMail(): Promise<HealthCheck[]> {
    const out: HealthCheck[] = [];
    // The same answer password recovery gets (core/account-mail): is there a transport that may carry it.
    let canSend = false;
    try { canSend = (await require('./account-mail').accountMailReady()) === true; } catch { /* not ready */ }
    out.push(canSend
        ? { id: 'mail.transport', group: 'mail', status: 'ok', title: 'Sending email', message: 'The site can send password resets and notifications.' }
        : { id: 'mail.transport', group: 'mail', status: 'fail', title: 'Sending email', message: 'The site cannot send email yet, so "Forgot password?" does not work and nobody is notified. Set up account email.', fix: { href: '/admin/settings/email', label: 'Account email' } });

    // The domain mail is sent from: SPF and DMARC records, without which mail lands in spam.
    let adminEmail = '';
    try { adminEmail = String(await require('./options').getOption('admin_email', '') || ''); } catch { /* */ }
    const domain = adminEmail.includes('@') ? adminEmail.split('@').pop()!.toLowerCase() : '';
    if (!domain || domain.endsWith('.localhost') || domain === 'localhost' || domain.endsWith('.example') || domain.endsWith('.test')) {
        out.push({ id: 'mail.dns', group: 'mail', status: 'info', title: 'Mail domain (SPF, DMARC)', message: domain ? `${domain} is a local or reserved name; there are no DNS records to check.` : 'Set the site email in Settings → General to check its domain.' });
        return out;
    }
    const dns = require('dns').promises;
    const txt = async (name: string): Promise<string[]> => withTimeout(dns.resolveTxt(name).then((r: string[][]) => r.map((x) => x.join(''))).catch(() => []), 3000, [] as string[]);
    const [spf, dmarc] = await Promise.all([txt(domain), txt(`_dmarc.${domain}`)]);
    const hasSpf = spf.some((r) => /^v=spf1\b/i.test(r));
    const hasDmarc = dmarc.some((r) => /^v=DMARC1\b/i.test(r));
    out.push(hasSpf && hasDmarc
        ? { id: 'mail.dns', group: 'mail', status: 'ok', title: 'Mail domain (SPF, DMARC)', message: `${domain} publishes SPF and DMARC.` }
        : { id: 'mail.dns', group: 'mail', status: 'warn', title: 'Mail domain (SPF, DMARC)', message: `${domain} is missing ${[!hasSpf && 'an SPF record', !hasDmarc && 'a DMARC record'].filter(Boolean).join(' and ')}: mail from the site is likely to land in spam. Add them where the domain's DNS is managed; your mail provider gives the exact values.`, fix: { href: '/admin/settings/email', label: 'Account email' } });
    return out;
}

async function checkTls(): Promise<HealthCheck> {
    const siteUrl = String((require('./configManager').getConfig() || {}).siteUrl || config().siteUrl || '');
    const local = /^https?:\/\/(localhost|127\.|\[::1\]|[^/]+\.localhost)(:|\/|$)/i.test(siteUrl);
    if (!siteUrl.startsWith('https://')) {
        return local
            ? { id: 'security.tls', group: 'security', status: 'info', title: 'HTTPS', message: 'A local install: plain HTTP is fine on this computer.' }
            : { id: 'security.tls', group: 'security', status: 'warn', title: 'HTTPS', message: `The main address (${siteUrl || 'not set'}) is not HTTPS: passwords travel unencrypted. Get a certificate, then switch the address to https.`, fix: { href: '/admin/security', label: 'Certificates' } };
    }
    const cm = require('./cert-manager');
    const info = await withTimeout(cm.getConfig().catch(() => null), 4000, null as any);
    const validTo = info && info.certInfo && info.certInfo.validTo;
    if (!validTo) return { id: 'security.tls', group: 'security', status: 'info', title: 'HTTPS', message: 'HTTPS is configured; the certificate in use could not be read from here (a proxy may hold it).' };
    const days = Math.floor((new Date(validTo).getTime() - Date.now()) / 86400000);
    const type = info.certInfo.type;
    if (days < 0) return { id: 'security.tls', group: 'security', status: 'fail', title: 'HTTPS', message: `The certificate expired ${-days} day(s) ago: browsers refuse the site.`, fix: { href: '/admin/security', label: 'Certificates' } };
    if (type === 'self-signed' && !local) return { id: 'security.tls', group: 'security', status: 'warn', title: 'HTTPS', message: 'The certificate is self-signed: visitors see a security warning. Get a free Let’s Encrypt certificate.', fix: { href: '/admin/security', label: 'Certificates' } };
    if (days < 14) return { id: 'security.tls', group: 'security', status: 'warn', title: 'HTTPS', message: `The certificate expires in ${days} day(s). Turn on automatic renewal or renew it now.`, fix: { href: '/admin/security', label: 'Certificates' } };
    return { id: 'security.tls', group: 'security', status: 'ok', title: 'HTTPS', message: `The certificate is valid for ${days} more day(s).` };
}

function checkProxy(req: any): HealthCheck {
    const clientIp = require('./client-ip');
    const xff = req && req.headers && req.headers['x-forwarded-for'];
    const first = String(Array.isArray(xff) ? xff.join(',') : xff || '').split(',')[0].trim();
    const seenThroughProxy = !!first && !clientIp.isLoopbackAddress(first) && clientIp.isLoopbackAddress(clientIp.clientIp(req));
    const embedded = process.env.WORDJS_EMBEDDED === '1';
    if (seenThroughProxy) {
        return { id: 'security.proxy', group: 'security', status: 'fail', title: 'Reverse proxy', message: 'This request came through a proxy on this computer that WordJS does not trust: every visitor is seen as 127.0.0.1, so login lockout and rate limits treat the whole site as one person.', fix: embedded ? { href: '/admin/security', label: 'Security → Server' } : undefined };
    }
    const tp = clientIp.resolveTrustProxy();
    return { id: 'security.proxy', group: 'security', status: 'ok', title: 'Reverse proxy', message: tp === false || tp === 0 ? 'No proxy is trusted, and none was seen: visitors are counted by their own address.' : `Trusted proxy: ${Array.isArray(tp) ? tp.join(', ') : String(tp)}.` };
}

async function checkBackground(): Promise<HealthCheck[]> {
    const SystemHealth = require('./system-health');
    const out: HealthCheck[] = [];
    let cronRunning = false;
    try { cronRunning = require('./cron').isCronRunning() === true; } catch { /* */ }
    out.push(cronRunning
        ? { id: 'background.cron', group: 'background', status: 'ok', title: 'Scheduled tasks', message: 'Scheduled publishing, backups and renewals run.' }
        : { id: 'background.cron', group: 'background', status: 'warn', title: 'Scheduled tasks', message: 'The scheduler is not running in this process: scheduled posts, backups and certificate renewals wait. Restart WordJS; if it persists, check the log.' });
    const sandbox = SystemHealth.checkSandbox();
    const degraded = sandbox && (sandbox.kernelDegraded === true || String(sandbox.status || '').toUpperCase() === 'DEGRADED');
    out.push(degraded
        ? { id: 'background.plugins', group: 'background', status: 'warn', title: 'Plugin isolation', message: 'Plugins run, but without the operating system’s extra confinement on this host. Your host may need a newer kernel or the platform’s sandbox enabled.' }
        : { id: 'background.plugins', group: 'background', status: 'ok', title: 'Plugin isolation', message: 'Plugins run isolated from the site and from each other.' });
    const outbox = await SystemHealth.checkContentOutbox();
    const dead = Number(outbox && outbox.dead) || 0;
    out.push(dead > 0
        ? { id: 'background.outbox', group: 'background', status: 'warn', title: 'Content events', message: `${dead} content event(s) could not be delivered (webhooks, search, cache).`, fix: { href: '/admin/webhooks', label: 'Webhooks' } }
        : { id: 'background.outbox', group: 'background', status: 'ok', title: 'Content events', message: 'Webhooks and cache updates are delivered.' });
    const purge = SystemHealth.checkPurge();
    if (purge && Array.isArray(purge.broken) && purge.broken.length) {
        out.push({ id: 'background.purge', group: 'background', status: 'warn', title: 'Page cache', message: 'Published changes reach visitors only when the page cache expires: on-demand cache updates failed in this process.' });
    }
    const restart = require('./restart').restartMode();
    out.push(restart === 'manual'
        ? { id: 'background.restart', group: 'background', status: 'warn', title: 'Restarting by itself', message: 'Nothing here restarts WordJS: after a database move, a restore or a network switch you will have to restart it by hand. Start it with npm start, the monolith, Docker or systemd.' }
        : { id: 'background.restart', group: 'background', status: 'ok', title: 'Restarting by itself', message: `WordJS restarts itself when a change needs it (${restart}).` });
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
        safe('mail.transport', 'mail', 'Sending email', checkMail),
        safe('security.tls', 'security', 'HTTPS', checkTls),
        safe('security.proxy', 'security', 'Reverse proxy', () => checkProxy(req)),
        safe('background.cron', 'background', 'Scheduled tasks', checkBackground),
    ]);
    const checks = groups.flat();
    const summary: Record<HealthStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
    for (const c of checks) summary[c.status]++;
    return { checks, summary, at: new Date().toISOString(), host: os.hostname() };
}

module.exports = { runSiteHealth, checkProxy, checkDisk };
