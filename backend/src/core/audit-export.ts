/**
 * WordJS — A copy of the audit log OUTSIDE the site: every sealed row (core/audit-chain), with its place
 * in the chain and its hash, sent as it is written to a syslog server (UDP, TCP or TLS, RFC 5424 with
 * RFC 6587 octet counting on streams) or to an HTTPS webhook (signed with HMAC-SHA256 when a secret is set).
 * Configured in Admin → Audit (routes/audit.ts); off until an administrator turns it on.
 *
 * Delivery is at-least-once and in chain order. The position reached is kept in the database
 * (audit_export_cursor, the last chain_seq delivered), so a receiver that is down gets the backlog when it
 * comes back, a restart resumes where it stopped, and the receiver can de-duplicate by `seq`. A copy that
 * already reached the receiver cannot be taken back by anyone who later gains access to the site.
 *
 * Destinations: a webhook must resolve to a PUBLIC address (the same SSRF rule as outgoing webhooks), and so
 * must a syslog host, unless the administrator ticked "the receiver is on a private network" — a SIEM
 * usually is. Either way the change re-authenticates (routes/audit.ts).
 */

const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const http = require('http');
const https = require('https');
const os = require('os');
const log = require('./module-logger').moduleLogger('core/audit-export');

const CONFIG_OPTION = 'audit_export';
const SECRET_OPTION = 'audit_export_secret';
const CURSOR_OPTION = 'audit_export_cursor';
const BATCH = 100;
const TIMEOUT_MS = 10_000;

export type ExportConfig = {
    mode: 'off' | 'syslog' | 'webhook';
    host: string;
    port: number;
    transport: 'udp' | 'tcp' | 'tls';
    url: string;
    allowPrivate: boolean;
};

const DEFAULT_CONFIG: ExportConfig = { mode: 'off', host: '', port: 514, transport: 'tcp', url: '', allowPrivate: false };

function parseConfig(raw: any): ExportConfig {
    let v = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    if (!v || typeof v !== 'object') return { ...DEFAULT_CONFIG };
    const mode = v.mode === 'syslog' || v.mode === 'webhook' ? v.mode : 'off';
    const transport = v.transport === 'udp' || v.transport === 'tls' ? v.transport : 'tcp';
    const port = Number.isInteger(Number(v.port)) && Number(v.port) > 0 && Number(v.port) < 65536 ? Number(v.port) : (transport === 'tls' ? 6514 : 514);
    return { mode, host: typeof v.host === 'string' ? v.host.trim() : '', port, transport, url: typeof v.url === 'string' ? v.url.trim() : '', allowPrivate: v.allowPrivate === true };
}

/** The problem with a config an administrator wants to save, in plain words, or null. */
function configProblem(c: ExportConfig): string | null {
    if (c.mode === 'syslog') {
        if (!c.host || c.host.length > 253 || !/^[A-Za-z0-9.:\-[\]]+$/.test(c.host)) return 'Enter the syslog server name or address.';
    }
    if (c.mode === 'webhook') {
        let u: URL;
        try { u = new URL(c.url); } catch { return 'Enter the webhook address (https://…).'; }
        // Plain http only to a receiver on the private network the administrator named; never across the internet.
        if (u.protocol !== 'https:' && !(c.allowPrivate && u.protocol === 'http:')) return 'The webhook address must start with https://.';
        if (u.username || u.password) return 'Put the secret in the secret field, not in the address.';
    }
    return null;
}

async function getConfig(): Promise<ExportConfig> {
    return parseConfig(await require('./options').getOptionFresh(CONFIG_OPTION, null));
}

async function getSecret(): Promise<string> {
    const s = await require('./options').getOptionFresh(SECRET_OPTION, '');
    return typeof s === 'string' ? s : '';
}

async function getCursor(): Promise<number> {
    const n = Number(await require('./options').getOptionFresh(CURSOR_OPTION, 0));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function setCursor(seq: number): Promise<void> {
    await require('./options').updateOption(CURSOR_OPTION, String(seq), 'no');
}

/**
 * Save the configuration. Turning the copy on (or pointing it somewhere else) starts at the chain's
 * current head: the receiver gets what happens from now on, not years of history in one burst.
 */
async function saveConfig(next: ExportConfig, secret?: string | null): Promise<void> {
    const options = require('./options');
    const prev = await getConfig();
    const target = (c: ExportConfig) => (c.mode === 'off' ? '' : c.mode === 'webhook' ? `w|${c.url}` : `s|${c.transport}|${c.host}|${c.port}`);
    await options.updateOption(CONFIG_OPTION, JSON.stringify(next), 'no');
    if (secret !== undefined && secret !== null) await options.updateOption(SECRET_OPTION, String(secret), 'no');
    if (next.mode !== 'off' && target(next) !== target(prev)) {
        const { dbAsync } = require('../config/database');
        const head = await dbAsync.get('SELECT MAX(chain_seq) AS s FROM audit_log');
        await setCursor(head && head.s ? Number(head.s) : 0);
        state.lastError = null;
    }
}

type State = { lastAttemptAt: number | null; lastSuccessAt: number | null; lastError: string | null; delivered: number };
const state: State = { lastAttemptAt: null, lastSuccessAt: null, lastError: null, delivered: 0 };

/** The site's own address (the per-site `siteurl` option), so a receiver shared by several sites can tell them apart. */
async function siteLabel(): Promise<string> {
    try { return String((await require('./options').getOption('siteurl', '')) || os.hostname()); } catch { return os.hostname(); }
}

function toEvent(row: any) {
    let detail: any;
    try { detail = row.detail ? JSON.parse(String(row.detail)) : {}; } catch { detail = {}; }
    // recordAudit already strips secret-looking keys; a row written into the table some other way gets the
    // same treatment here, so nothing secret leaves the site. For recordAudit's rows this is a no-op.
    detail = require('./audit').sanitizeDetail(detail);
    return {
        seq: Number(row.chain_seq), id: Number(row.id), createdAt: require('./audit-chain').canonicalTs(row.created_at),
        actorId: row.actor_id === null || row.actor_id === undefined ? null : Number(row.actor_id),
        action: String(row.action || ''), targetType: String(row.target_type || ''), targetId: String(row.target_id || ''),
        detail, prevHash: String(row.prev_hash || ''), rowHash: String(row.row_hash || ''),
    };
}

/** Resolve a host for a connect: under the SSRF rule unless the administrator allowed a private receiver. */
function lookupFor(c: ExportConfig): any {
    return c.allowPrivate ? undefined : require('./egress-guard').validatingLookup;
}

function resolveHost(c: ExportConfig): Promise<string> {
    const lookup = lookupFor(c) || require('dns').lookup;
    return new Promise((resolve, reject) => {
        lookup(c.host.replace(/^\[|\]$/g, ''), {}, (err: any, address: string) => (err ? reject(err) : resolve(address)));
    });
}

/** RFC 5424: facility 13 (log audit), severity 5 (notice) → PRI 109. */
function syslogLine(site: string, ev: any): string {
    const ts = ev.createdAt ? `${ev.createdAt.replace(' ', 'T')}Z` : '-';
    const host = (os.hostname() || '-').replace(/\s/g, '').slice(0, 255) || '-';
    return `<109>1 ${ts} ${host} wordjs - audit - ${JSON.stringify({ site, ...ev })}`;
}

async function sendSyslog(c: ExportConfig, events: any[]): Promise<void> {
    if (!c.allowPrivate && net.isIP(c.host.replace(/^\[|\]$/g, ''))) {
        if (require('./egress-guard').isBlockedIp(c.host.replace(/^\[|\]$/g, ''))) throw new Error(`${c.host} is a private address; tick "the receiver is on a private network" to allow it`);
    }
    const site = await siteLabel();
    const lines = events.map((ev) => syslogLine(site, ev));
    if (c.transport === 'udp') {
        const address = await resolveHost(c);
        const sock = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4');
        try {
            for (const line of lines) {
                await new Promise<void>((resolve, reject) => sock.send(Buffer.from(line, 'utf8'), c.port, address, (err: any) => (err ? reject(err) : resolve())));
            }
        } finally { sock.close(); }
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const opts: any = { host: c.host.replace(/^\[|\]$/g, ''), port: c.port, lookup: lookupFor(c) };
        let settled = false;
        const done = (err?: any) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); if (err) reject(err); else resolve(); };
        const payload = lines.map((l) => { const b = Buffer.from(l, 'utf8'); return `${b.length} ${l}`; }).join('');
        const onConnect = () => sock.end(payload, 'utf8', () => done());
        const sock = c.transport === 'tls'
            ? tls.connect({ ...opts, servername: net.isIP(opts.host) ? undefined : opts.host, rejectUnauthorized: true }, onConnect)
            : net.connect(opts, onConnect);
        sock.on('error', (e: any) => done(e));
        const timer = setTimeout(() => done(new Error('syslog server did not answer in time')), TIMEOUT_MS);
        if (timer.unref) timer.unref();
    });
}

async function sendWebhook(c: ExportConfig, events: any[], secret: string): Promise<void> {
    const u = new URL(c.url);
    const egress = require('./egress-guard');
    if (!c.allowPrivate) await egress.assertUrlAllowed(u.href);
    const body = JSON.stringify({ source: 'wordjs', site: await siteLabel(), events });
    const ts = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)),
        'User-Agent': 'WordJS-Audit/1.0', 'X-WordJS-Event': 'audit.batch', 'X-WordJS-Timestamp': String(ts),
    };
    if (secret) headers['X-WordJS-Signature-256'] = 'sha256=' + require('./crypto-utils').hmacSha256Hex(secret, `${ts}.${body}`);
    const lib = u.protocol === 'https:' ? https : http;
    await new Promise<void>((resolve, reject) => {
        const req = lib.request({
            method: 'POST', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (u.protocol === 'https:' ? 443 : 80), path: (u.pathname || '/') + (u.search || ''),
            headers, timeout: TIMEOUT_MS, lookup: lookupFor(c),
        }, (res: any) => {
            res.resume();
            res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`the webhook answered HTTP ${res.statusCode}`))));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('the webhook did not answer in time')));
        req.end(body);
    });
}

async function send(c: ExportConfig, events: any[]): Promise<void> {
    if (c.mode === 'syslog') return sendSyslog(c, events);
    if (c.mode === 'webhook') return sendWebhook(c, events, await getSecret());
}

let flushing: Promise<number> | null = null;

/** Deliver every sealed row past the cursor. Never throws; returns how many rows were delivered. */
async function flushExport(): Promise<number> {
    if (flushing) return flushing;
    flushing = (async () => {
        let delivered = 0;
        try {
            const c = await getConfig();
            if (c.mode === 'off') return 0;
            const { dbAsync } = require('../config/database');
            let cursor = await getCursor();
            for (let i = 0; i < 1000; i++) {
                const rows = (await dbAsync.all(
                    'SELECT id, actor_id, action, target_type, target_id, detail, created_at, chain_seq, prev_hash, row_hash FROM audit_log WHERE chain_seq > ? ORDER BY chain_seq ASC LIMIT ?',
                    [cursor, BATCH]
                )) || [];
                if (!rows.length) break;
                state.lastAttemptAt = Date.now();
                await send(c, rows.map(toEvent));
                cursor = Number(rows[rows.length - 1].chain_seq);
                await setCursor(cursor);
                delivered += rows.length;
                state.lastSuccessAt = Date.now();
                state.lastError = null;
                if (rows.length < BATCH) break;
            }
            state.delivered += delivered;
        } catch (e: any) {
            state.lastError = String((e && e.message) || e);
            log.warn({ err: e }, '[audit-export] the external copy could not be delivered; it is retried');
            scheduleRetry();
        }
        return delivered;
    })().finally(() => { flushing = null; });
    return flushing;
}

let timer: any = null;
let retryDelay = 30_000;

function withSite(fn: () => any) {
    const sc = require('./site-context');
    const id = sc.currentSiteIdOrNull();
    return () => (id === null ? fn() : sc.runWithSite(id, fn));
}

/** Ask for a delivery soon (coalesced). Called after every sealing pass. */
function scheduleFlush(): void {
    if (timer) return;
    const run = withSite(() => { timer = null; return flushExport().then((n) => { if (n) retryDelay = 30_000; }); });
    timer = setTimeout(run, 250);
    if (timer.unref) timer.unref();
}

function scheduleRetry(): void {
    if (timer) return;
    const run = withSite(() => { timer = null; return flushExport(); });
    timer = setTimeout(run, retryDelay);
    if (timer.unref) timer.unref();
    retryDelay = Math.min(retryDelay * 2, 10 * 60_000);
}

/** Send one test event through a saved config, without touching the cursor. */
async function sendTest(c: ExportConfig): Promise<void> {
    const ev = { seq: 0, id: 0, createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '), actorId: null, action: 'audit.export.test', targetType: 'audit_log', targetId: '', detail: {}, prevHash: '', rowHash: '' };
    if (c.mode === 'webhook') return sendWebhook(c, [ev], await getSecret());
    if (c.mode === 'syslog') return sendSyslog(c, [ev]);
    throw new Error('The external copy is off.');
}

/** For the screen and Site Health: configuration (never the secret), how far delivery is, last outcome. */
async function exportStatus() {
    const c = await getConfig();
    const { dbAsync } = require('../config/database');
    const cursor = await getCursor();
    let behind = 0;
    let oldestUndeliveredAt: string | null = null;
    if (c.mode !== 'off') {
        const r = await dbAsync.get('SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM audit_log WHERE chain_seq > ?', [cursor]);
        behind = r ? Number(r.c) || 0 : 0;
        oldestUndeliveredAt = behind && r ? require('./audit-chain').canonicalTs(r.oldest) || null : null;
    }
    return {
        config: c, hasSecret: !!(await getSecret()), cursor, behind, oldestUndeliveredAt,
        lastAttemptAt: state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : null,
        lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
        lastError: state.lastError,
    };
}

module.exports = {
    getConfig, saveConfig, parseConfig, configProblem, flushExport, scheduleFlush, sendTest, exportStatus,
    CONFIG_OPTION, SECRET_OPTION, CURSOR_OPTION,
};
