/**
 * WordJS - Mail Server plugin (ISOLATED, NO TRUST — Android-style grants only).
 *
 * Runs in a child_process isolate via the capability bridge. NO plugin bypasses the sandbox; this
 * plugin works purely from the permissions its manifest REQUESTS and an admin GRANTS (default-deny):
 *   - core models/Email          -> ./lib/email-store(wordjs.db)  (own wjp_mail_server_* tables)
 *   - core models/User           -> wordjs.users.{findByEmail,findByLogin,findById,search}
 *                                   (SAFE projection only — never user_pass)
 *   - site URL / domain / admin   -> wordjs.site.{url,domain,adminEmail}  (grant settings:read)
 *   - non-secret options          -> wordjs.options.get/set              (grant settings:read/write)
 *   - SECRETS (DKIM key, relay)   -> Email.getSecret/setSecret in wjp_mail_server_secrets (NOT a
 *                                   protected option, which is unreachable without trust)
 *   - express router             -> wordjs.http.route(...)  → /api/v1/plugin/mail-server/*
 *   - notifications              -> wordjs.notify / wordjs.notify.registerTransport (notifications:*)
 *   - registerAdminMenu          -> wordjs.adminMenu.add
 *   - global.wordjs_send_mail    -> wordjs.provideMail(sendMail)  (grant email:provider)
 *
 * Outbound DNS/NET/TLS (MX resolution, direct/relay delivery, inbound SMTP listen) require the
 * 'network' grant — without it net/tls/dns are blocked inside the isolate and delivery degrades
 * gracefully (errors are caught per-recipient). node builtins (crypto/os/path/fs-to-own-dir) work.
 */
const nodemailer = require('nodemailer');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const net = require('net');
const SPFValidator = require('spf-validator');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Attachment storage lives in the plugin's OWN dir (untrusted plugins can't write shared uploads).
// The single source of truth is Email.UPLOAD_DIR (set in email-store); mirror it here for path joins.
const UPLOAD_DIR = path.join(__dirname, 'data/attachments');

exports.metadata = {
    name: 'Mail Server',
    version: '2.1.0',
    description: 'Full webmail suite (spam folder, labels, undo send, vacation replies) on the WordJS MTA.',
    author: 'WordJS'
};

// DNS goes through the HOST bridge (wordjs.dns), NOT the raw resolver. The sandbox DENIES the c-ares
// resolver surface (dns.resolve*) to plugins because it bypasses egress filtering — only getaddrinfo
// (dns.lookup, A/AAAA only) is left, which can't do MX/TXT. The host resolves MX/TXT/A on our behalf
// (network-gated) and strips private-IP answers. This lazy shim keeps every existing `dns.resolveMx(…)`
// call site unchanged while routing it over the bridge; `wordjs` is set in init() before any lookup runs.
const dns = {
    resolveMx: (domain) => wordjs.dns.resolveMx(domain),
    resolveTxt: (name) => wordjs.dns.resolveTxt(name),
    resolve4: (host) => wordjs.dns.resolve4(host),
    resolve6: (host) => wordjs.dns.resolve6(host),
    resolve: (host) => wordjs.dns.resolve(host),
};

// === Bridge-backed module state (set in init) ===
let wordjs = null;        // the injected capability bridge
let Email = null;         // plugin-local email store backed by wordjs.db
let getOption = null;     // wordjs.options.get
let updateOption = null;  // wordjs.options.set
let classifier = null;    // bayes classifier
let saveBayes = null;     // persists the classifier
let transporter = null;
let smtpServer = null;
// Inbound listener status surfaced to the admin: which port we actually bound and whether we had to
// fall back off the standard MX port 25 (so the UI can tell the operator inbound-from-internet needs
// a port map / privilege grant instead of failing silently). Reset on every initSMTPServer().
let inboundStatus = { requestedPort: null, boundPort: null, degraded: false, reason: null, _triedFallback: false, proxyIps: [] };
let queueInterval = null;  // scheduled/retry queue timer id (cleared on deactivate)
let _lastSpamPurge = 0;    // last 30-day spam-retention sweep (runs at most every 6h)

// === User lookups via the SAFE host bridge (grant: users:read) ===
// wordjs.users.* returns a PROJECTION {id,userLogin,username,userEmail,displayName,role} — never
// user_pass. The field names already match what the rest of this file expects (mapUser-compatible),
// so no normalization is needed here. The host writes the underlying query (core User model).
const User = {
    findByEmail: (email) => wordjs.users.findByEmail(email),
    findByLogin: (login) => wordjs.users.findByLogin(login),
    findById: (id) => wordjs.users.findById(id),
    async findAll({ search, limit } = {}) {
        return await wordjs.users.search(search || '', limit || 50);
    }
};

// Resolve the site URL/domain from the SAFE site bridge (grant: settings:read). Replaces the now-
// blocked protected-option reads of siteurl/home (untrusted plugins can't read protected options).
async function getSiteUrl() {
    try { return await wordjs.site.url(); } catch (e) { return 'http://localhost'; }
}
async function getSiteDomain() {
    try { return await wordjs.site.domain(); } catch (e) { return 'localhost'; }
}

// Batch N option reads into ONE parallel wave. Every getOption is an RPC round-trip to the host (and
// secrets additionally hit the DB + AES decrypt), so the old sequential `await` chains made /settings
// and every send pay 10-20 serialized round-trips of pure latency.
async function getOptionsBatch(pairs) {
    const keys = Object.keys(pairs);
    const values = await Promise.all(keys.map(k => getOption(k, pairs[k])));
    const out = {};
    keys.forEach((k, i) => { out[k] = values[i]; });
    return out;
}

// Split a user-typed recipient field ("a@x.com, b@y.com; c@z.com") into clean address tokens.
// The composer sends To/CC/BCC as raw strings; without this, a comma list was treated as ONE
// malformed address and multi-recipient sends failed outright.
function splitAddresses(value) {
    if (Array.isArray(value)) {
        return value.flatMap(v => splitAddresses(v));
    }
    return String(value || '')
        .split(/[,;]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

// Resolve (and briefly cache) the site admin user — the owner of catch-all inbound mail. Without an
// owner those rows were written but matched NOBODY's mailbox, i.e. catch-all silently swallowed mail.
let _adminUserCache = { user: null, at: 0 };
async function getAdminUser() {
    const now = Date.now();
    if (_adminUserCache.user && now - _adminUserCache.at < 60 * 1000) return _adminUserCache.user;
    let user = null;
    try {
        const adminEmail = await wordjs.site.adminEmail();
        if (adminEmail) user = await User.findByEmail(adminEmail);
    } catch (e) { /* no settings:read or no such user — catch-all rows stay unowned */ }
    _adminUserCache = { user, at: now };
    return user;
}

// === Vacation auto-responder ==============================================================
// Per-user prefs (Email.getPrefs(userId).vacation = {enabled, subject, message, startsAt, endsAt}).
// Replies at most once per sender per 24h, never to bounce/no-reply addresses, never to
// auto-generated mail (Auto-Submitted / Precedence bulk), and tags its own replies with
// Auto-Submitted: auto-replied so two vacationing servers can't ping-pong forever.
const _vacationSent = new Map(); // `${userId}:${senderLower}` -> last reply ts
function _vacationKeySweep() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [k, ts] of _vacationSent) {
        if (ts < cutoff) _vacationSent.delete(k);
    }
    // Hard cap so a sender-address flood can't grow the map unbounded between sweeps.
    if (_vacationSent.size > 5000) _vacationSent.clear();
}

async function maybeVacationAutoReply(user, senderEmail, origSubject) {
    try {
        if (!user || !user.id || !senderEmail) return;
        const sender = String(senderEmail).trim().toLowerCase();
        if (!sender || !sender.includes('@')) return;
        if (sender === String(user.userEmail || '').toLowerCase()) return; // never reply to yourself
        if (/^(mailer-daemon|postmaster|no-?reply|noreply|bounce|do-?not-?reply)/i.test(sender)) return;

        const prefs = await Email.getPrefs(user.id);
        const v = prefs && prefs.vacation;
        if (!v || !v.enabled || !v.message) return;
        const now = Date.now();
        if (v.startsAt && now < Date.parse(v.startsAt)) return;
        if (v.endsAt && now > Date.parse(v.endsAt)) return;

        const key = `${user.id}:${sender}`;
        const last = _vacationSent.get(key) || 0;
        if (now - last < 24 * 60 * 60 * 1000) return;
        _vacationSent.set(key, now);

        const subject = String(v.subject || 'Automatic reply').slice(0, 180)
            + (origSubject ? `: ${String(origSubject).slice(0, 120)}` : '');
        const html = String(v.message).slice(0, 5000);
        await sendMail({
            to: sender,
            subject,
            text: html.replace(/<[^>]*>/g, ''),
            html,
            fromEmail: user.userEmail,
            fromName: user.displayName || user.username || '',
            userId: user.id,
            isAutoReply: true
        });
    } catch (e) {
        console.warn('[MailServer] Vacation auto-reply failed:', e && e.message);
    }
}

// True when a parsed inbound message is auto-generated (bounces, list mail, another auto-responder)
// — such mail must never trigger a vacation reply (RFC 3834).
function isAutoGenerated(parsed) {
    try {
        const h = parsed && parsed.headers;
        if (!h || typeof h.get !== 'function') return false;
        const auto = h.get('auto-submitted');
        if (auto && String(auto).toLowerCase() !== 'no') return true;
        const prec = h.get('precedence');
        if (prec && /bulk|list|junk/i.test(String(prec))) return true;
        if (h.get('x-autoreply') || h.get('x-autorespond')) return true;
        if (h.get('list-id') || h.get('list-unsubscribe')) return true;
    } catch (e) { /* treat as normal mail */ }
    return false;
}

// Gmail-style search operators: from:x to:x subject:x label:x in:folder has:attachment is:unread
// is:starred; everything else is free text. Unknown operators fall through as text.
function parseSearchQuery(raw) {
    const q = {};
    const rest = [];
    for (const tok of String(raw || '').trim().split(/\s+/)) {
        if (!tok) continue;
        const m = tok.match(/^([a-z]+):(.+)$/i);
        if (m) {
            const key = m[1].toLowerCase();
            const val = m[2];
            if (key === 'from') { q.from = val; continue; }
            if (key === 'to') { q.to = val; continue; }
            if (key === 'subject') { q.subject = val; continue; }
            if (key === 'label') { q.labelName = val; continue; }
            if (key === 'in') { q.folder = val.toLowerCase(); continue; }
            if (key === 'has' && val.toLowerCase() === 'attachment') { q.hasAttachment = true; continue; }
            if (key === 'is') {
                const v = val.toLowerCase();
                if (v === 'unread') { q.isUnread = true; continue; }
                if (v === 'starred') { q.isStarred = true; continue; }
            }
        }
        rest.push(tok);
    }
    if (rest.length) q.text = rest.join(' ');
    return q;
}

/**
 * Initialize the fallback transporter (optional)
 */
async function initTransporter() {
    const host = await getOption('mail_server', '');
    const port = parseInt(await getOption('mail_port', '587'), 10);
    const user = await getOption('mail_user', '');
    const pass = await getOption('mail_pass', '');
    const secureRaw = await getOption('mail_secure', '0');
    const secure = secureRaw === '1';

    if (!host || !user || !pass) {
        transporter = null;
        return;
    }

    // The relay/smarthost is OPERATOR-configured (admin-only setting) and may LEGITIMATELY be an INTERNAL
    // host (a LAN smarthost / corporate MTA). Unlike the attacker-controlled direct-MX recipient domain,
    // it is therefore NOT subject to the public-only SSRF pin — that wrongly refused internal smarthosts
    // (MAIL-RELAY-SSRF). Pass the configured hostname straight to nodemailer (which resolves + uses it for
    // SNI/cert match).
    const requireRelayTls = (await getOption('mail_relay_require_tls', '1')) !== '0';
    transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        // STARTTLS downgrade protection: force STARTTLS on the non-implicit-TLS path so an on-path attacker
        // can't strip it and capture the relay creds. An operator with a TLS-less INTERNAL smarthost can
        // opt out via the mail_relay_require_tls='0' setting (REG-2). secure:true (465) is implicit TLS.
        requireTLS: requireRelayTls && !secure,
        auth: { user, pass }
    });

    try {
        await transporter.verify();
        console.log('   ✓ Fallback SMTP Transporter ready');
    } catch (error) {
        console.error('   ✗ Fallback SMTP Connection failed:', error.message);
        transporter = null;
    }
}

/**
 * Resolve MX records for a domain
 */
async function resolveMX(domain) {
    try {
        const records = await dns.resolveMx(domain);
        return records.sort((a, b) => a.priority - b.priority);
    } catch (error) {
        console.error(`MX resolution failed for ${domain}:`, error.message);
        return [];
    }
}

/**
 * Real inbound SPF evaluation.
 *
 * The installed `spf-validator` package (new SPFValidator(domain).hasRecords(cb)) only reports
 * whether a domain *has* an SPF record — it does NOT evaluate a policy against an IP. So we use it
 * to short-circuit the 'none' case, then parse the v=spf1 record ourselves and match the connecting
 * IP against the a / mx / ip4 / ip6 / include mechanisms and the trailing `all` qualifier.
 *
 * Returns one of: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none'.
 * Fails OPEN (throws → caller tags 'none') on any DNS error/timeout.
 */
async function evaluateSPF(domain, ip, depth = 0) {
    if (!ip || depth > 5) return 'none'; // guard against include loops / missing IP

    // 1. Presence check via the spf-validator library.
    const validator = new SPFValidator(domain);
    const hasRecords = await new Promise((resolve, reject) => {
        validator.hasRecords((err, has) => (err ? reject(err) : resolve(has)));
    });
    if (!hasRecords) return 'none';

    // 2. Fetch and locate the v=spf1 record.
    const txt = await dns.resolveTxt(domain);
    const records = txt.map(chunks => chunks.join(''));
    const spf = records.find(r => /^v=spf1\b/i.test(r.trim()));
    if (!spf) return 'none';

    // 3. Evaluate mechanisms left-to-right; first match wins.
    const terms = spf.trim().split(/\s+/).slice(1); // drop "v=spf1"
    let defaultQualifier = '?'; // neutral if no all/match
    for (const term of terms) {
        const qualifier = '+-~?'.includes(term[0]) ? term[0] : '+';
        const mechanism = '+-~?'.includes(term[0]) ? term.slice(1) : term;
        // Split on the first ':' or '=' into mechanism name and its value (a:host, ip4:cidr, include:dom).
        const sepMatch = mechanism.match(/[:=]/);
        const name = sepMatch ? mechanism.slice(0, sepMatch.index) : mechanism;
        const value = sepMatch ? mechanism.slice(sepMatch.index + 1) : null;

        let matched = false;
        try {
            if (name === 'all') {
                defaultQualifier = qualifier;
                matched = true;
            } else if (name === 'ip4' || name === 'ip6') {
                matched = ipInCidr(ip, value);
            } else if (name === 'a') {
                const host = value || domain;
                const addrs = await dns.resolve(host).catch(() => []);
                matched = addrs.includes(ip);
            } else if (name === 'mx') {
                const host = value || domain;
                const mx = await dns.resolveMx(host).catch(() => []);
                for (const rec of mx) {
                    const addrs = await dns.resolve(rec.exchange).catch(() => []);
                    if (addrs.includes(ip)) { matched = true; break; }
                }
            } else if (name === 'include' && value) {
                // Recurse into the included policy; a 'pass' there counts as a match here.
                const sub = await evaluateSPF(value, ip, depth + 1);
                matched = sub === 'pass';
            }
            // Unknown mechanisms (ptr, exists, redirect, etc.) are ignored — conservative.
        } catch (e) {
            // Ignore a single mechanism's lookup failure and keep evaluating.
            matched = false;
        }

        if (matched && name !== 'all') return qualifierToResult(qualifier);
        if (name === 'all') return qualifierToResult(qualifier);
    }
    return qualifierToResult(defaultQualifier);
}

function qualifierToResult(q) {
    if (q === '+') return 'pass';
    if (q === '-') return 'fail';
    if (q === '~') return 'softfail';
    return 'neutral'; // '?'
}

/**
 * Match an IP against a CIDR or bare address (IPv4/IPv6). No external deps.
 */
function ipInCidr(ip, cidr) {
    if (!cidr) return false;
    const [range, bitsRaw] = cidr.split('/');
    const v4 = net.isIPv4(ip) && net.isIPv4(range);
    const v6 = net.isIPv6(ip) && net.isIPv6(range);
    if (!v4 && !v6) return false;

    const toBig = (addr, isV6) => {
        if (!isV6) {
            return addr.split('.').reduce((acc, o) => (acc << 8n) + BigInt(parseInt(o, 10)), 0n);
        }
        // Expand IPv6 to 8 hextets.
        let [head, tail] = addr.split('::');
        const h = head ? head.split(':') : [];
        const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
        let parts;
        if (t === null) { parts = h; }
        else { parts = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]; }
        return parts.reduce((acc, p) => (acc << 16n) + BigInt(parseInt(p || '0', 16)), 0n);
    };

    const isV6 = v6;
    const totalBits = isV6 ? 128 : 32;
    const bits = bitsRaw === undefined ? totalBits : parseInt(bitsRaw, 10);
    if (isNaN(bits) || bits < 0 || bits > totalBits) return false;

    const ipBig = toBig(ip, isV6);
    const rangeBig = toBig(range, isV6);
    const mask = bits === 0 ? 0n : (~0n << BigInt(totalBits - bits)) & ((1n << BigInt(totalBits)) - 1n);
    return (ipBig & mask) === (rangeBig & mask);
}

/**
 * SECURITY (M2-SSRF): is this resolved IP a private/internal/special-use address we must NOT connect
 * to for outbound mail delivery? Blocks loopback, RFC1918, link-local (incl. cloud metadata
 * 169.254.169.254), CGNAT, ULA, ::1, IPv4-mapped IPv6 of any of the above, and the unspecified addr.
 * Used to defend MX delivery against being aimed at the host's own internal network. Fails CLOSED:
 * an unparseable/unknown address is treated as blocked.
 */
function isBlockedIp(ip) {
    if (!ip || typeof ip !== 'string') return true;
    let addr = ip.trim();
    // Normalize IPv4-mapped IPv6 (::ffff:10.0.0.1 / ::ffff:a00:1) down to its IPv4 form so the v4
    // CIDR checks below catch private ranges smuggled through a v6 literal.
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) addr = mapped[1];

    if (net.isIPv4(addr)) {
        const V4_BLOCKED = [
            '0.0.0.0/8',       // "this host" / unspecified
            '10.0.0.0/8',      // RFC1918
            '100.64.0.0/10',   // CGNAT (RFC6598)
            '127.0.0.0/8',     // loopback
            '169.254.0.0/16',  // link-local (incl. 169.254.169.254 cloud metadata)
            '172.16.0.0/12',   // RFC1918
            '192.168.0.0/16',  // RFC1918
        ];
        return V4_BLOCKED.some(cidr => ipInCidr(addr, cidr));
    }
    if (net.isIPv6(addr)) {
        // Exact specials first.
        if (addr === '::1') return true;          // loopback
        if (addr === '::') return true;           // unspecified
        const V6_BLOCKED = [
            '::1/128',         // loopback
            '::/128',          // unspecified
            'fc00::/7',        // ULA (unique local)
            'fe80::/10',       // link-local
        ];
        return V6_BLOCKED.some(cidr => ipInCidr(addr, cidr));
    }
    // Not a parseable IP literal — fail closed.
    return true;
}

/**
 * SECURITY (M2-SSRF): resolve a hostname to its A/AAAA addresses and reject if ANY of them is an
 * internal/private/special address. Returns the list of (public) IPs on success; throws otherwise.
 * Used before opening an SMTP connection to an MX host so MX/fallback delivery can't be aimed at the
 * host's own loopback/LAN/cloud-metadata endpoint. Fails CLOSED on resolution failure.
 */
async function assertPublicHost(host) {
    // A bare IP literal as the MX host is checked directly.
    if (net.isIP(host)) {
        if (isBlockedIp(host)) throw new Error(`Refusing delivery to internal/private address: ${host}`);
        return [host];
    }
    let addrs = [];
    try {
        const v4 = await dns.resolve4(host).catch(() => []);
        const v6 = await dns.resolve6(host).catch(() => []);
        addrs = [...v4, ...v6];
    } catch (e) {
        throw new Error(`DNS resolution failed for ${host}: ${e.message}`);
    }
    if (addrs.length === 0) throw new Error(`Could not resolve ${host} to any address`);
    for (const a of addrs) {
        if (isBlockedIp(a)) throw new Error(`Refusing delivery: ${host} resolves to internal/private address ${a}`);
    }
    return addrs;
}

/**
 * Is this inbound SMTP session a TRUSTED (non-external) sender that bypasses DNSBL/SPF gating?
 * Trusted = loopback connection (our own relay/local injection) or an authenticated session
 * (AUTH is currently disabled, but guard for forward-compatibility). Everything else is "external"
 * and is subject to fail-closed reputation/SPF checks.
 */
function isTrustedSmtpSession(session) {
    if (!session) return false;
    const ip = session.remoteAddress;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    if (session.user) return true; // authenticated (if AUTH is ever enabled)
    return false;
}

// Normalize an IPv4-mapped IPv6 address ('::ffff:1.2.3.4') to bare IPv4. A dual-stack SMTP listener
// reports the connecting IP in this mapped form, which SPF (matches no mechanism → softfail) and DNSBL
// (lookup errors) both choke on — rejecting essentially EVERY real IPv4 sender. Strip the prefix once.
function bareIp(addr) {
    if (typeof addr !== 'string') return addr;
    const m = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    return m ? m[1] : addr;
}

// Parse the admin's trusted-proxy IP allowlist for PROXY protocol (v1). Only connections FROM these
// EXACT IPs get their PROXY header parsed (real client IP rescued); every other sender is treated as
// direct, so enabling this never breaks normal inbound mail. We NEVER pass useProxy:true — trusting a
// client-sent PROXY header from any origin would let an attacker forge their source IP (e.g. claim
// 127.0.0.1 → hit the loopback "trusted" bypass and skip DNSBL/SPF entirely). The listener binds
// dual-stack (::), so an IPv4 proxy peer is reported as ::ffff:<ip> — add that mapped form too, or
// smtp-server's exact-match allowlist (useProxy.includes(socket.remoteAddress)) would miss it.
function parseTrustedProxyIps(raw) {
    const out = new Set();
    for (const tok of String(raw || '').split(/[\s,;]+/)) {
        const ip = tok.trim();
        if (!ip) continue;
        const v = net.isIP(ip); // 4, 6, or 0 (invalid — hostname, wildcard, "true", …)
        if (v === 0) continue;  // drop non-IPs here; the settings route validates + reports them
        out.add(ip);
        if (v === 4) out.add('::ffff:' + ip);
    }
    return [...out];
}

/**
 * Initialize the Inbound SMTP Server
 */
async function initSMTPServer() {
    const siteDomain = await getSiteDomain();
    // Default to 25 — the ONLY port the world delivers mail to (the MX record implies :25). This makes
    // inbound work with zero config wherever the process may bind it (Windows; Linux once node has
    // CAP_NET_BIND_SERVICE via create-wordjs/setcap; any host running privileged). Where it CAN'T bind
    // 25 we fall back to 2525 below and report it — never a silent no-inbound.
    let port = parseInt(await getOption('smtp_listen_port', '25'), 10);
    const catchAllRaw = await getOption('smtp_catch_all', '0');

    if (smtpServer) {
        smtpServer.close();
    }

    // PROXY protocol (v1): when inbound mail reaches us THROUGH a TCP proxy (nginx `stream` with
    // proxy_protocol on;, HAProxy send-proxy), the real client IP is otherwise lost — every connection
    // looks like it came from the proxy. Trust the proxy's PROXY header ONLY from these exact IPs; the
    // parsed client IP then flows into session.remoteAddress, so DNSBL/SPF/logging see the real sender.
    const trustedProxyIps = parseTrustedProxyIps(await getOption('smtp_proxy_ips', ''));

    smtpServer = new SMTPServer({
        // Only ever an explicit IP allowlist, never `true` (see parseTrustedProxyIps for why).
        ...(trustedProxyIps.length ? { useProxy: trustedProxyIps } : {}),
        authOptional: true,
        disabledCommands: ['AUTH'],

        // DoS containment for the unauthenticated inbound MTA: cap per-message size and concurrent
        // connections so a flood of huge/many messages can't exhaust worker memory or tmp disk.
        size: 25 * 1024 * 1024, // 25 MB hard cap per message
        maxClients: 50,
        socketTimeout: 60 * 1000, // drop idle/slow-loris connections after 60s

        // 1. DNSBL Protection (Connection Level) — default ON, FAIL CLOSED for external senders.
        onConnect(session, callback) {
            // Loopback / authenticated senders are trusted (this is our own relay path).
            if (isTrustedSmtpSession(session)) return callback();

            // DNSBL is default-ON but only an explicit operator override ('0') disables it.
            const ip = bareIp(session.remoteAddress);
            getOption('mail_security_dnsbl_enabled', '1').then(enabled => {
                if (enabled === '0') return callback();

                const dnsbl = require('dnsbl');
                dnsbl.lookup(ip, 'zen.spamhaus.org').then(listed => {
                    if (listed) {
                        console.warn(`[Security][DNSBL] IP ${ip} blocked by DNSBL — rejecting`);
                        return callback(new Error('554 Connection rejected: your IP is listed on a DNS blocklist'));
                    }
                    callback();
                }).catch((e) => {
                    // FAIL OPEN: Spamhaus Zen refuses queries from public/cloud resolvers, so a lookup error
                    // is the COMMON case — rejecting on it would blackhole ALL inbound mail. Log and accept;
                    // SPF + the Bayesian filter still apply. Only a POSITIVE listing rejects.
                    console.warn(`[Security][DNSBL] lookup error for ${ip}: ${e.message} — accepting (fail open)`);
                    callback();
                });
            }).catch((e) => {
                // The option lookup itself failed — accept (fail open) rather than blackhole inbound.
                console.warn(`[Security][DNSBL] option lookup error: ${e.message} — accepting (fail open)`);
                callback();
            });
        },

        // 2. SPF Protection — real check against the connecting IP and MAIL FROM domain.
        // Default ON, FAIL CLOSED for external senders: reject on explicit SPF fail/softfail or on a
        // lookup error. 'pass'/'neutral'/'none' (no SPF record) are accepted to avoid false rejects.
        onMailFrom(address, session, callback) {
            // Loopback / authenticated senders are our own relay path — never SPF-gate them.
            if (isTrustedSmtpSession(session)) return callback();

            // Default ON: only an explicit operator override ('0') disables the check.
            getOption('mail_security_spf_enabled', '1').then(async (enabled) => {
                if (enabled === '0') return callback();

                const ip = bareIp(session.remoteAddress); // '::ffff:1.2.3.4' → '1.2.3.4' so SPF matches
                const mailFrom = (address && address.address) || '';
                const domain = mailFrom.split('@')[1] || '';

                // FAIL CLOSED: a DNS/validator error during evaluation must reject, not silently admit.
                let result = 'none';
                let evalError = false;
                try {
                    if (domain) result = await evaluateSPF(domain, ip);
                } catch (e) {
                    console.warn(`[Security][SPF] evaluation error for ${domain} (${ip}): ${e.message} — rejecting (fail closed)`);
                    evalError = true;
                }

                // Set the Received-SPF header for downstream storage (RFC 7208 §9.1 shape).
                session.spfheader = `Received-SPF: ${result} (wordjs: ${domain || 'unknown'} via ${ip})`;
                session.spfResult = result;

                if (evalError) {
                    return callback(new Error('451 Temporary failure: unable to verify SPF for ' + (domain || 'sender') + ', try again later'));
                }

                // Reject explicit SPF failures by default. Operator can downgrade to tag-only with
                // mail_security_spf_reject='0' (override) if they prefer to accept and rely on tagging.
                if (result === 'fail' || result === 'softfail') {
                    const rejectRaw = await getOption('mail_security_spf_reject', '1');
                    if (rejectRaw !== '0') {
                        console.warn(`[Security][SPF] Rejecting ${mailFrom} from ${ip} (SPF ${result})`);
                        return callback(new Error('550 SPF check failed: sending IP not authorized for ' + domain));
                    }
                    console.warn(`[Security][SPF] SPF ${result} for ${mailFrom} from ${ip} — tagged only (reject overridden off)`);
                }
                // 'pass' / 'neutral' / 'none' (domains without an SPF record) are accepted.
                callback();
            }).catch((e) => {
                // The option lookup itself failed — fail closed for the external sender.
                console.warn(`[Security][SPF] option lookup error: ${e.message} — rejecting (fail closed)`);
                callback(new Error('451 Temporary failure, try again later'));
            });
        },

        onData(stream, session, callback) {
            simpleParser(stream, async (err, parsed) => {
                if (err) return callback(err);

                try {
                    const siteDomain = await getSiteDomain();
                    // 3. Bayesian Analysis
                    const text = (parsed.subject || '') + ' ' + (parsed.text || '');
                    const category = await classifier.categorize(text);
                    const isSpam = category === 'spam';

                    if (isSpam) console.log(`[Security] Bayesian Filter marked message as SPAM`);

                    // 4. Processing
                    // parsed.to/from may be missing (Bcc-only / From-less mail). Guard the deref
                    // and fall back to the SMTP envelope so we don't silently drop the message.
                    let toAddresses = [];
                    const parsedTo = parsed.to?.value;
                    if (Array.isArray(parsedTo)) toAddresses = parsedTo;
                    else if (parsedTo) toAddresses = [parsedTo];

                    if (toAddresses.length === 0) {
                        const envelopeRcpt = session?.envelope?.rcptTo || [];
                        toAddresses = envelopeRcpt
                            .map(r => (r && r.address ? { address: r.address } : null))
                            .filter(Boolean);
                    }

                    const fromAddr = parsed.from?.value?.[0]?.address
                        || session?.envelope?.mailFrom?.address
                        || '';
                    const fromName = parsed.from?.value?.[0]?.name || '';

                    // Thread an inbound reply back into its conversation (THREAD-XREF): a reply's
                    // In-Reply-To / References headers echo the Message-ID of a message we already have
                    // (e.g. the Sent copy we delivered with that exact Message-ID). Resolve them and
                    // inherit that message's thread so the reply lands in the same árbol instead of
                    // starting a new one. Falls back to 0 (its own new thread) when nothing matches.
                    let inboundThreadId = 0;
                    try {
                        const refIds = []
                            .concat(parsed.inReplyTo || [])
                            .concat(parsed.references || [])
                            .join(' ')
                            .split(/\s+/)
                            .map(s => s.trim())
                            .filter(Boolean);
                        for (const rid of refIds) {
                            const parent = await Email.findByMessageId(rid);
                            if (parent) { inboundThreadId = parent.thread_id || parent.id; break; }
                        }
                    } catch (e) {
                        console.error('[MailServer] Inbound thread lookup failed:', e.message);
                    }

                    for (const addr of toAddresses) {
                        if (!addr || !addr.address) continue;
                        const [recName, recDomain] = addr.address.split('@');

                        // Only ACCEPT/store inbound mail for OUR domain. A recipient on any external
                        // domain (a user's personal gmail.com, or a foreign address) must never be
                        // captured into a WordJS inbox, and catch-all stays scoped to @siteDomain (never a
                        // blanket accept-anything that would hoard mail meant for other providers). A user
                        // only has an inbox when their own configured email is on our domain (professional
                        // mailbox); a personal-email user has none.
                        const isLocalDomain = !!(recDomain && recDomain === siteDomain);
                        let user = null;
                        if (isLocalDomain) {
                            const candidate = await User.findByEmail(addr.address) || await User.findByLogin(recName);
                            if (candidate && String(candidate.userEmail || '').toLowerCase().split('@')[1] === siteDomain) {
                                user = candidate;
                            }
                        }

                        // Catch-all mail (no matching mailbox) is OWNED BY THE SITE ADMIN — previously it
                        // was stored with no owner and matched nobody's address, i.e. it vanished.
                        let owner = user;
                        if (!owner && isLocalDomain && catchAllRaw === '1') {
                            owner = await getAdminUser();
                        }

                        if (user || (isLocalDomain && catchAllRaw === '1')) {
                            await Email.create({
                                messageId: parsed.messageId,
                                fromAddress: fromAddr,
                                fromName: fromName,
                                toAddress: user ? user.userEmail : addr.address,
                                subject: parsed.subject || '(no subject)',
                                bodyText: parsed.text || '',
                                bodyHtml: parsed.html || '',
                                rawContent: parsed.textAsHtml || parsed.text || '',
                                threadId: inboundThreadId,
                                attachments: parsed.attachments,
                                userId: owner ? owner.id : 0,
                                // Spam goes to the SPAM FOLDER (reviewable, auto-purged after 30 days by
                                // the queue sweep) — not silently into Trash with a mangled subject.
                                isSpam: isSpam ? 1 : 0
                            });

                            // Auto-learn (Naive logic: if we accepted it and user didn't mark it, it's ham.
                            // But here we just classify. Learning should happen on user action.)

                            if (user && !isSpam) {
                                await wordjs.notify({
                                    user_id: user.id,
                                    type: 'email',
                                    title: 'New Inbound Email',
                                    message: `From ${parsed.from?.text || fromAddr}: "${parsed.subject}"`,
                                    action_url: `/admin/plugin/emails`,
                                    transports: ['db', 'sse']
                                });
                            }

                            // Vacation auto-responder — only for real (non-spam, non-auto-generated) mail
                            // to a real mailbox. Fire-and-forget: a reply failure must never 4xx the
                            // inbound DATA transaction.
                            if (user && !isSpam && !isAutoGenerated(parsed)) {
                                maybeVacationAutoReply(user, fromAddr, parsed.subject).catch(() => { });
                            }
                        }
                    }
                    callback();
                } catch (error) {
                    console.error('Failed to store incoming email:', error);
                    callback(error);
                }
            });
        }
    });

    inboundStatus = { requestedPort: port, boundPort: null, degraded: false, reason: null, proxyIps: trustedProxyIps };

    // Probe-then-bind. Rebinding a net.Server after a listen error is unreliable, so instead of trying
    // to recover from a failed bind we TEST whether the standard port 25 is bindable first, with a
    // throwaway socket. If it isn't (EACCES = no CAP_NET_BIND_SERVICE/root on Linux; EADDRINUSE = another
    // MTA already on 25), fall back to the unprivileged 2525 and record WHY — the listener still comes up
    // (local + relay mail keep working) and the admin UI can tell the operator inbound-from-internet
    // needs the port-25 bind granted or 25 mapped to 2525. A non-25 operator override is respected as-is.
    if (port === 25) {
        const probe = await new Promise((resolve) => {
            let net;
            try { net = require('net'); } catch (e) { return resolve({ ok: false, code: 'ENONET' }); }
            const tester = net.createServer();
            tester.once('error', (e) => resolve({ ok: false, code: e.code }));
            tester.once('listening', () => tester.close(() => resolve({ ok: true })));
            try { tester.listen(25, '0.0.0.0'); } catch (e) { resolve({ ok: false, code: e && e.code }); }
        });
        if (!probe.ok) {
            inboundStatus.degraded = true;
            inboundStatus.reason = probe.code === 'EACCES'
                ? 'binding port 25 was denied — on Linux node needs CAP_NET_BIND_SERVICE (run create-wordjs, or: sudo setcap cap_net_bind_service=+ep $(readlink -f $(which node))) or run privileged'
                : (probe.code === 'EADDRINUSE'
                    ? 'port 25 is already in use by another mail server — stop it, or map 25 → 2525'
                    : `could not bind port 25 (${probe.code || 'unknown error'})`);
            port = 2525;
        }
    }

    smtpServer.on('error', err => {
        console.error('   ✗ Inbound SMTP Server error:', err.message);
    });

    smtpServer.listen(port, () => {
        inboundStatus.boundPort = port;
        if (inboundStatus.degraded) {
            console.warn(`   ⚠️  Inbound SMTP: could not bind port 25 (${inboundStatus.reason}). Fell back to ${port}. Internet mail is delivered to port 25, so EXTERNAL inbound will NOT arrive until you grant the port-25 bind or map 25 → ${port}. Local + relay mail are unaffected.`);
        } else {
            const note = port === 25 ? '' : ` — NON-STANDARD: internet mail expects port 25, so map 25 → ${port}`;
            console.log(`   ✓ Inbound SMTP Server listening on port ${port} (Domain: ${siteDomain})${note}`);
        }
    });
}

/**
 * SECURITY: Validate email address to prevent CVE-2025-14874 (DoS) and CVE-2025-13033 (misdirection)
 */
// SECURITY (H8): per-user outbound rate limiting (anti-spam). An authenticated account otherwise had
// no ceiling on outbound mail (only the global 1000/15min API limiter), enough to blast DKIM-signed
// spam from our IP and get the domain blacklisted. Cap messages AND total recipients per rolling hour.
const MAX_RECIPIENTS_PER_MESSAGE = 50;
const OUTBOUND_WINDOW_MS = 60 * 60 * 1000;
const OUTBOUND_MAX_MESSAGES = 100;
const OUTBOUND_MAX_RECIPIENTS = 500;
const _outboundUsage = new Map(); // userId -> { windowStart, messages, recipients }
function outboundRateLimitOk(userId, recipientCount) {
    const now = Date.now();
    let e = _outboundUsage.get(userId);
    if (!e || now - e.windowStart > OUTBOUND_WINDOW_MS) {
        e = { windowStart: now, messages: 0, recipients: 0 };
        _outboundUsage.set(userId, e);
    }
    if (e.messages + 1 > OUTBOUND_MAX_MESSAGES) return false;
    if (e.recipients + recipientCount > OUTBOUND_MAX_RECIPIENTS) return false;
    e.messages += 1;
    e.recipients += recipientCount;
    return true;
}

function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    // Block extremely long addresses (DoS prevention)
    if (email.length > 254) return false;
    // SECURITY (M4): reject any CR/LF outright — a newline in a recipient is a header-injection vector.
    if (/[\r\n]/.test(email)) return false;
    // Block multiple @ symbols (CVE-2025-13033 prevention)
    if ((email.match(/@/g) || []).length !== 1) return false;
    // Block quoted local parts with @ (CVE-2025-13033)
    if (email.includes('"') && email.includes('@')) {
        const localPart = email.split('@')[0];
        if (localPart.includes('@')) return false;
    }

    // SECURITY (M2-SSRF): reject IP-literal and localhost recipient domains. A recipient like
    // user@127.0.0.1, user@[::1], or user@localhost would aim direct delivery at the host's own
    // network. Internal WordJS users are matched by login/email separately, so legitimate mail never
    // needs an IP/localhost domain here.
    const domain = email.split('@')[1] || '';
    // Strip optional [ ] around address literals (RFC 5321 domain-literal form).
    const bareDomain = domain.replace(/^\[/, '').replace(/\]$/, '');
    // Reject any IPv4/IPv6 literal as the domain — PURE JS (not net.isIP): this runs on EVERY send,
    // including purely-LOCAL delivery, but net.isIP requires the `net` module which secure-require blocks
    // for a plugin WITHOUT the network grant → it threw "require('net') not permitted" and broke every
    // send (even local). An IPv4 dotted-quad, or any colon-bearing host (IPv6), is an address literal.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bareDomain) || bareDomain.indexOf(':') !== -1) return false;

    // Single-label domains (localhost, an intranet hostname) are ACCEPTED: they only ever resolve to a
    // LOCAL user (written straight to the DB inbox), and external direct delivery to such a domain is
    // separately refused in deliverDirect (+ the resolved-IP-must-be-public pin) — so there's no SSRF
    // here. Requiring an FQDN dot previously broke internal delivery to the DEFAULT @localhost accounts
    // (admin@localhost et al), so the admin couldn't even send to themselves. (The doc has always said
    // "admin@localhost and similar are accepted for internal testing"; the code now matches it.)
    if (bareDomain && bareDomain.indexOf('.') === -1) {
        return /^[^\s@]+@[^\s@]+$/.test(email);
    }
    // FQDN domain: standard RFC 5322 simplified validation (must contain a dot).
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Send an email directly using MX delivery or Fallback
 */
async function sendMail(data) {
    console.log(`[MailServer] sendMail called. Subject: "${data.subject}"`);

    // Normalize all recipient lists up-front so we can validate EVERY address (M4).
    const toAttendees = Array.isArray(data.to) ? data.to : [data.to];
    const ccAttendees = data.cc ? (Array.isArray(data.cc) ? data.cc : [data.cc]) : [];
    const bccAttendees = data.bcc ? (Array.isArray(data.bcc) ? data.bcc : [data.bcc]) : [];

    // SECURITY (M4 / CVE-2025-14874): validate EVERY recipient (to, cc AND bcc) — not just the primary
    // 'to'. An attacker-supplied cc/bcc with a CRLF or malformed address could otherwise smuggle header
    // injection or be misdirected. Empty cc/bcc slots are tolerated (filtered), but any present-but-
    // invalid address rejects the whole send.
    for (const email of [...toAttendees, ...ccAttendees, ...bccAttendees]) {
        if (email === undefined || email === null || email === '') continue;
        if (!isValidEmail(email)) throw new Error(`Invalid recipient email address format: ${email}`);
    }

    // SECURITY (H7/M4): strip CR/LF from header-bound fields to prevent email-header injection. A newline
    // in subject/fromName/fromEmail could smuggle extra headers (e.g. Bcc:) into the outbound message.
    // Recipients are validated above; this defends the remaining user-controlled header fields at source.
    const stripCRLF = (v) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim() : v);
    if (data.subject !== undefined) data.subject = stripCRLF(data.subject);
    if (data.fromName !== undefined) data.fromName = stripCRLF(data.fromName);
    if (data.fromEmail !== undefined) data.fromEmail = stripCRLF(data.fromEmail);

    // Combine for distinct processing
    const allRecipients = [...toAttendees, ...ccAttendees, ...bccAttendees];
    const distinctRecipients = [...new Set(allRecipients.filter(Boolean))];

    console.log(`[MailServer] Total unique recipients: ${distinctRecipients.length}`);

    const parentId = data.parentId || 0;
    const threadId = data.threadId || 0;
    const draftId = data.draftId || 0;
    // Owner of the Sent copy (the sending user). 0 = system/plugin mail (notification transport etc.).
    const senderUserId = parseInt(data.userId, 10) || 0;

    // Identity + DKIM resolution in ONE parallel wave — every getOption is a host RPC round-trip
    // (secrets also hit the DB + AES decrypt), and the old sequential chain serialized ~8 of them
    // before a single byte was delivered.
    const [defaultEmail, defaultName, optFromEmail, optFromName, dkimKey, dkimDomain, dkimSelector, siteDomain] = await Promise.all([
        getOption('admin_email', 'noreply@wordjs.com'),
        getOption('blogname', 'WordJS'),
        getOption('mail_from_email', ''),
        getOption('mail_from_name', ''),
        getOption('mail_security_dkim_private_key', ''),
        getOption('mail_security_dkim_domain', ''),
        getOption('mail_security_dkim_selector', 'default'),
        getSiteDomain()
    ]);

    // stripCRLF the resolved fromEmail/fromName too (covers the admin-configured option fallbacks).
    const fromEmail = stripCRLF(data.fromEmail || optFromEmail || defaultEmail);
    const fromName = stripCRLF(data.fromName || optFromName || defaultName);

    // One stable Message-ID reused for BOTH the stored Sent record AND the on-the-wire Message-ID
    // header. When the remote party replies, their In-Reply-To/References echo this exact value, so the
    // inbound handler can look it up and thread the reply back into this conversation (THREAD-XREF).
    const outboundMessageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${(fromEmail.split('@')[1] || 'wordjs')}>`;

    let dkimOptions = undefined;
    if (dkimKey && dkimDomain) {
        dkimOptions = {
            domainName: dkimDomain,
            keySelector: dkimSelector,
            privateKey: dkimKey
        };
    }

    // 1. Create Sent Copy (Source of Truth)
    // We do this first to ensure we have a record even if delivery fails partially
    // This is stored in the SENDER'S "Sent" folder (or updated if draft)
    // sentRecordId tracks the row so the retry queue can update (not duplicate) it.
    // On a retry pass (data.isRetry) we already have a Sent record and the recipients passed in are
    // exactly the still-failed external ones: skip creating a new Sent copy and skip local delivery.
    const isRetry = !!data.isRetry;
    let sentRecordId = draftId || data.sentRecordId || 0;
    try {
        if (isRetry) {
            // Reuse the existing Sent record; nothing to (re)create.
        } else if (draftId) {
            console.log(`[MailServer] Updating draft ${draftId} to Sent status.`);
            await Email.update(draftId, {
                messageId: outboundMessageId,
                toAddress: toAttendees.join(', '),
                ccAddress: ccAttendees.join(', '),
                bccAddress: bccAttendees.join(', '),
                subject: data.subject,
                bodyText: data.text,
                bodyHtml: data.html,
                rawContent: data.html || data.text,
                isSent: 1,
                isDraft: 0,
                attachments: data.attachments
            });
        } else {
            console.log(`[MailServer] Creating new Sent email record.`);
            const sentRec = await Email.create({
                messageId: outboundMessageId,
                fromAddress: fromEmail.toLowerCase(),
                fromName: fromName,
                toAddress: toAttendees.join(', '),
                ccAddress: ccAttendees.join(', '),
                bccAddress: bccAttendees.join(', '),
                subject: data.subject,
                bodyText: data.text,
                bodyHtml: data.html,
                isSent: 1,
                rawContent: data.html || data.text,
                parentId,
                threadId,
                userId: senderUserId,
                attachments: data.attachments
            });
            sentRecordId = sentRec ? sentRec.id : 0;
        }
    } catch (e) {
        console.error('[MailServer] Failed to save/update SENT record:', e);
        throw e; // If we can't save the sent record, we probably shouldn't send? Or warn?
    }

    // 2. Deliver to Internal Users (Inbox Copy). siteDomain was prefetched in the parallel wave above.
    console.log(`[MailServer] Processing internal delivery for domain: ${siteDomain}`);

    // Track which recipients are local so we filter them out of SMTP
    const localRecipients = new Set();

    // On a retry pass the local inbox copies were already delivered on the first attempt;
    // the recipients we were handed are the still-failed EXTERNAL ones. Skip local delivery.
    for (const recipient of (isRetry ? [] : distinctRecipients)) {
        try {
            console.log(`[MailServer] Checking recipient: ${recipient}`);
            const [rName, rDomain] = recipient.split('@');
            // A recipient is LOCAL (delivered into a WordJS inbox) ONLY when it is a corporate mailbox on
            // OUR domain. A user's PERSONAL email (e.g. gmail.com) MUST be delivered OUT to that provider,
            // never captured locally — a user without a professional @domain mailbox has no WordJS inbox;
            // their personal address is only for things like password recovery / external notifications.
            // (Previously `User.findByEmail(recipient)` matched regardless of domain, so mail to a user's
            // personal address was stored in WordJS instead of being sent to Gmail/etc.)
            let localUser = null;
            if (rDomain && rDomain === siteDomain) {
                const candidate = await User.findByEmail(recipient) || await User.findByLogin(rName);
                // A user only has a WordJS inbox when their OWN configured email is on our domain (i.e.
                // the professional mailbox is enabled). If their email is a personal address (gmail.com),
                // they have no inbox even when a @domain address maps to their username — deliver out.
                if (candidate && String(candidate.userEmail || '').toLowerCase().split('@')[1] === siteDomain) {
                    localUser = candidate;
                }
            }

            if (localUser) {
                console.log(`[MailServer] Local user found: ${localUser.id} (${localUser.username})`);

                // Check if user_id is valid
                if (!localUser.id) {
                    console.error(`[MailServer] ❌ Critical: Local user found but has no ID!`, localUser);
                    continue;
                }

                localRecipients.add(recipient);

                // Self-delivery: when the sender is also the recipient (e.g. replying to a message you
                // sent yourself), the Sent copy already represents this message for that user. Creating a
                // second "received" copy gives the thread two rows with the same thread_id, so the message
                // shows up TWICE in the conversation view (and redundantly in the sender's own inbox).
                // Skip the inbox copy for self-sends — the Sent record already covers it. (SELF-DUP)
                if (recipient.toLowerCase() === fromEmail.toLowerCase()) {
                    console.log(`[MailServer] Self-delivery to ${recipient} — skipping duplicate inbox copy.`);
                    continue;
                }

                // Local delivery: Create a copy in the recipient's inbox, OWNED by that recipient
                // (user_id is what folder listings key on — the old `user_id:` spelling was silently
                // dropped by the store and ownership fell back to slow address matching).
                const inboxEmail = await Email.create({
                    messageId: `<local-${Date.now()}-${Math.random()}@wordjs.com>`,
                    fromAddress: fromEmail.toLowerCase(),
                    fromName: fromName,
                    toAddress: toAttendees.join(', '), // Preserve context
                    ccAddress: ccAttendees.join(', '),
                    subject: data.subject,
                    bodyText: data.text,
                    bodyHtml: data.html,
                    isSent: 0, // Received
                    userId: localUser.id,
                    rawContent: data.html || data.text,
                    parentId,
                    threadId,
                    attachments: data.attachments
                });

                console.log(`[MailServer] ✅ Delivered to local inbox: ${inboxEmail.id}`);

                // Notify
                if (recipient.toLowerCase() !== fromEmail.toLowerCase()) {
                    await wordjs.notify({
                        user_id: localUser.id,
                        type: 'email',
                        title: 'New Internal Email',
                        message: `You have a new message from ${fromName}: "${data.subject}"`,
                        icon: 'fa-envelope',
                        color: 'indigo',
                        action_url: `/admin/plugin/emails?id=${inboxEmail.id}`,
                        transports: ['db', 'sse']
                    });

                    // Vacation auto-responder for internal mail too (Gmail replies regardless of
                    // where the sender is). Never triggered BY an auto-reply (loop guard).
                    if (!data.isAutoReply) {
                        maybeVacationAutoReply(localUser, fromEmail, data.subject).catch(() => { });
                    }
                }
            } else {
                console.log(`[MailServer] User ${recipient} not found locally.`);
            }
        } catch (err) {
            console.error(`[MailServer] ❌ Error processing recipient ${recipient}:`, err);
        }
    }

    // 3. Deliver to External recipients (NOT local users — avoid double-send to our own mailbox)
    const externalRecipients = distinctRecipients.filter(r => !localRecipients.has(r));
    const delivered = [];
    const failed = [];

    if (externalRecipients.length > 0) {
        const attachments = (data.attachments || []).map(a => ({ filename: a.filename, path: a.path }));
        // RFC 3834: an auto-generated reply announces itself so remote auto-responders don't answer it.
        const extraHeaders = data.isAutoReply ? { 'Auto-Submitted': 'auto-replied' } : undefined;
        const mailObj = { fromEmail, fromName, subject: data.subject, text: data.text, html: data.html, attachments, messageId: outboundMessageId, headers: extraHeaders };

        if (transporter) {
            // Relay/smarthost path (used only if a relay is configured).
            console.log(`[MailServer] Delivering ${externalRecipients.length} recipient(s) via configured relay...`);
            for (const extR of externalRecipients) {
                try {
                    const info = await transporter.sendMail({
                        envelope: { from: fromEmail, to: extR },
                        from: `"${fromName}" <${fromEmail}>`, to: extR,
                        messageId: outboundMessageId,
                        subject: data.subject, text: data.text, html: data.html, attachments, dkim: dkimOptions,
                        headers: extraHeaders
                    });
                    delivered.push({ recipient: extR, via: 'relay', response: info.response });
                } catch (e) {
                    console.error(`[MailServer] ❌ Relay delivery to ${extR} failed: ${e.message}`);
                    failed.push({ recipient: extR, error: e.message, permanent: false });
                }
            }
        } else {
            // Direct-to-MX delivery (real MTA).
            const heloName = await getHeloName();
            console.log(`[MailServer] Direct MX delivery for ${externalRecipients.length} recipient(s) as ${heloName}...`);
            for (const extR of externalRecipients) {
                try {
                    const r = await deliverDirect(extR, mailObj, dkimOptions, heloName);
                    console.log(`[MailServer] ✅ Delivered to ${extR} via ${r.mx}: ${r.response}`);
                    delivered.push({ recipient: extR, via: r.mx, response: r.response });
                } catch (e) {
                    console.error(`[MailServer] ❌ ${e.message}`);
                    failed.push({ recipient: extR, error: e.message, permanent: !!e.permanent });
                }
            }
        }
    }

    // Update the retry queue state on the Sent record (Feature: retry temporary failures).
    // Only meaningful when we actually attempted external delivery and have a record to track.
    await updateRetryState(sentRecordId, data, externalRecipients, failed);

    // Surface delivery outcome so callers (the /send, /test endpoints) report accurately instead of
    // silently "succeeding". The Sent record + local inbox copies are already persisted above.
    return { success: failed.length === 0, delivered, failed };
}

const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Persist outbound retry state on the Sent record based on this attempt's outcome.
 * - all external recipients delivered (or none were external) → 'sent'
 * - any PERMANENT failure (5xx) and no temporary ones → 'failed' immediately + bounce
 * - temporary (4xx/network) failures → 'retry' with exponential backoff, until MAX attempts → 'failed' + bounce
 * The list of recipients to retry is stored as the record's to_address so the next pass targets
 * exactly the still-failed ones.
 */
async function updateRetryState(sentRecordId, data, externalRecipients, failed) {
    if (!sentRecordId) return;
    // No external delivery was attempted (purely local) — leave as a normal sent message.
    if (externalRecipients.length === 0 && (!failed || failed.length === 0)) {
        try { await Email.markSent(sentRecordId); } catch (e) { /* non-fatal */ }
        return;
    }

    if (!failed || failed.length === 0) {
        try { await Email.markSent(sentRecordId); } catch (e) { /* non-fatal */ }
        return;
    }

    const attempts = (parseInt(data.deliveryAttempts, 10) || 0) + 1;
    const temporary = failed.filter(f => !f.permanent);
    const permanent = failed.filter(f => f.permanent);
    const lastError = failed.map(f => `${f.recipient}: ${f.error}`).join('; ');

    // Permanent failures never retry. If everything left is permanent (or we're out of attempts),
    // mark failed and bounce to the sender.
    if (temporary.length === 0 || attempts >= MAX_DELIVERY_ATTEMPTS) {
        try {
            await Email.markFailed(sentRecordId, attempts, lastError);
            // Persist the failed recipients for visibility.
            await Email.update(sentRecordId, { toAddress: failed.map(f => f.recipient).join(', ') });
        } catch (e) { /* non-fatal */ }
        await sendBounce(data, failed);
        return;
    }

    // Schedule a retry for the temporary failures only. Exponential backoff: attempt^2 minutes, cap ~6h.
    const backoffMinutes = Math.min(attempts * attempts, 360);
    const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();
    try {
        await Email.markRetry(sentRecordId, attempts, nextAttemptAt, lastError);
        // Store ONLY the still-failed recipients so the next pass retries exactly those.
        await Email.update(sentRecordId, { toAddress: temporary.map(f => f.recipient).join(', ') });
    } catch (e) { /* non-fatal */ }

    // If there were also permanent failures mixed in, bounce those now (they won't be retried).
    if (permanent.length > 0) await sendBounce(data, permanent);
}

/**
 * Best-effort bounce notification to the sender for permanently failed recipients.
 */
async function sendBounce(data, failedList) {
    try {
        const fromEmail = (data.fromEmail || '').toLowerCase();
        if (!fromEmail) return;
        const user = await User.findByEmail(fromEmail);
        if (!user || !user.id) return;
        const detail = failedList.map(f => `${f.recipient} (${f.error})`).join(', ');
        await wordjs.notify({
            user_id: user.id,
            type: 'alert',
            title: 'Email delivery failed',
            message: `Could not deliver "${data.subject}" to: ${detail}`,
            icon: 'fa-exclamation-triangle',
            color: 'red',
            transports: ['db', 'sse']
        });
    } catch (e) {
        console.error('[MailServer] Failed to send bounce notification:', e.message);
    }
}

/**
 * The hostname this server announces in EHLO and uses for envelope/identity. MUST match the
 * sending IP's reverse DNS (PTR) or remote MX servers (Gmail/Outlook) will reject/spam the mail.
 */
async function getHeloName() {
    const explicit = await getOption('mail_helo_host', '');
    if (explicit) return explicit;
    const dkimDomain = await getOption('mail_security_dkim_domain', '');
    if (dkimDomain) return dkimDomain;
    try { return new URL(await getSiteUrl()).hostname; } catch (e) { return os.hostname(); }
}

/**
 * Build the DNS records the operator must publish for deliverability, given a DKIM public key.
 */
function buildDnsRecords(domain, selector, publicKeyPem) {
    const pubDer = (publicKeyPem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    // A DNS TXT string is capped at 255 chars; the RSA-2048 DKIM value is ~410, so a single string is
    // INVALID at many providers. Offer the quoted-segment form ("seg1" "seg2") operators can paste as-is.
    const chunkTxt = (v) => { const p = []; for (let i = 0; i < v.length; i += 255) p.push('"' + v.slice(i, i + 255) + '"'); return p.join(' '); };
    const dkimValue = `v=DKIM1; k=rsa; p=${pubDer}`;
    const mailHost = `mail.${domain}`;
    return {
        // MX + A are what make INBOUND work — without them the internet has nowhere to deliver mail for
        // this domain. MX points at the mail host; that host needs an A record resolving to the server IP.
        mx: {
            host: domain,
            type: 'MX',
            value: mailHost,
            priority: 10,
            note: `Routes inbound mail for @${domain} to your server. The value (${mailHost}) needs its own A record below. (Prefer the bare domain as your mail host? Point MX at ${domain} and skip the A record.)`
        },
        a: {
            host: mailHost,
            type: 'A',
            value: 'YOUR_SERVER_PUBLIC_IP',
            note: `Point this at your server's PUBLIC IPv4 so ${mailHost} resolves. Replace YOUR_SERVER_PUBLIC_IP with the address the internet reaches your server on (skip if MX points at the bare domain and it already has an A record).`
        },
        dkim: {
            host: `${selector}._domainkey.${domain}`,
            type: 'TXT',
            value: dkimValue,
            valueChunked: dkimValue.length > 255 ? chunkTxt(dkimValue) : dkimValue,
            note: dkimValue.length > 255 ? 'Exceeds the 255-char DNS TXT limit. Most providers auto-split; if yours does not, paste the quoted-segment form.' : undefined
        },
        spf: {
            host: domain,
            type: 'TXT',
            value: 'v=spf1 a mx ~all',
            note: 'Add the sending host/IP if it is not the A/MX record (e.g. ip4:YOUR.IP).'
        },
        dmarc: {
            host: `_dmarc.${domain}`,
            type: 'TXT',
            value: `v=DMARC1; p=none; rua=mailto:postmaster@${domain}`
        },
        ptr: {
            type: 'PTR (reverse DNS)',
            note: `Reverse DNS for your sending IP MUST resolve to ${domain} (or your mail FQDN), and forward-confirm. Without rDNS, Gmail/Outlook reject or spam your mail. Set this with your IP/hosting provider.`
        }
    };
}

/**
 * Deliver ONE message to ONE recipient by connecting directly to its domain's MX servers.
 * Resolves on success ({ ok, mx, response }); rejects with err.permanent set (5xx = permanent,
 * 4xx/network = temporary so the caller may retry).
 */
async function deliverDirect(recipient, mail, dkimOptions, heloName) {
    const domain = recipient.split('@')[1];

    // SECURITY (M2-SSRF): the recipient domain itself must not be an IP literal / localhost. isValidEmail
    // already rejects these at the sendMail boundary, but defend in depth here since deliverDirect is the
    // actual network sink.
    const bareDomain = String(domain || '').replace(/^\[/, '').replace(/\]$/, '');
    if (!bareDomain || bareDomain.toLowerCase() === 'localhost' || net.isIP(bareDomain)) {
        const err = new Error(`Direct delivery to ${recipient} refused: invalid or internal recipient domain`);
        err.permanent = true;
        throw err;
    }

    const mxRecords = await resolveMX(domain);
    if (mxRecords.length === 0) mxRecords.push({ exchange: domain, priority: 0 });

    // Build the actual SMTP connection to ONE host with a given TLS verification mode.
    // SECURITY (M2 DNS-rebinding/TOCTOU): connect the socket to `pinnedIp` — the public IP that
    // assertPublicHost already resolved AND validated for `serverName` — instead of the hostname. This
    // stops nodemailer from doing a SECOND, attacker-controlled resolution at connect time, closing the
    // TTL=0 rebinding window where authoritative DNS hands a public IP to the validator and
    // 127.0.0.1 / 169.254.169.254 to the live connection. `servername` keeps the REAL MX hostname so
    // STARTTLS certificate validation and SNI still target the host, not the bare IP.
    const sendVia = async (pinnedIp, serverName, rejectUnauthorized) => {
        const transport = nodemailer.createTransport({
            host: pinnedIp,               // already-validated public IP — no second resolution
            port: 25,
            secure: false,
            name: heloName,               // EHLO/HELO hostname (must match rDNS)
            connectionTimeout: 20000,
            greetingTimeout: 15000,
            socketTimeout: 30000,
            // M2-TLS: verify the STARTTLS cert by default against the real MX hostname (serverName),
            // not the pinned IP; the caller downgrades+logs only on a verification failure for this host.
            tls: { rejectUnauthorized, servername: serverName }
        });
        try {
            const info = await transport.sendMail({
                // Envelope (MAIL FROM / RCPT TO) drives SPF alignment & bounces; keep it our domain.
                envelope: { from: mail.fromEmail, to: recipient },
                from: `"${mail.fromName}" <${mail.fromEmail}>`,
                to: recipient,
                messageId: mail.messageId,
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
                attachments: mail.attachments,
                dkim: dkimOptions,
                headers: mail.headers
            });
            return info;
        } finally {
            try { transport.close(); } catch (e2) { /* ignore */ }
        }
    };

    // SECURITY (TLS-downgrade): only a genuine certificate-VERIFICATION failure may trigger the
    // unauthenticated retry. Match the exact OpenSSL/Node cert codes ONLY — no message-substring
    // fallbacks (the old msg.includes('tls')/'certificate'/'altname' matched transient/non-cert TLS
    // and even generic errors, letting an active MITM force the downgrade with a non-cert error).
    // The broad `ERR_TLS_` code prefix is likewise dropped (it matched handshake/protocol errors).
    const TLS_CERT_VERIFY_CODES = new Set([
        'ERR_TLS_CERT_ALTNAME_INVALID',       // hostname / SAN mismatch
        'DEPTH_ZERO_SELF_SIGNED_CERT',        // self-signed leaf
        'SELF_SIGNED_CERT_IN_CHAIN',          // self-signed CA in chain
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',    // missing/untrusted issuer
        'CERT_HAS_EXPIRED',                   // expired cert
    ]);
    const isTlsVerifyError = (e) => {
        const code = e && e.code ? String(e.code).toUpperCase() : '';
        return TLS_CERT_VERIFY_CODES.has(code);
    };

    let lastErr = null;
    let permanent = false;
    for (const mx of mxRecords) {
        // SECURITY (M2-SSRF): resolve this MX host and reject if it points at an internal/private IP
        // (loopback/RFC1918/link-local incl. cloud metadata/CGNAT/ULA). Skip to the next MX on a
        // blocked/unresolvable host rather than connecting. PIN the validated address: we connect the
        // socket to this exact IP below (not the hostname) so there is no second, attacker-controlled
        // DNS resolution at connect time (M2 DNS-rebinding/TOCTOU defense).
        let pinnedIp;
        try {
            const publicAddrs = await assertPublicHost(mx.exchange);
            pinnedIp = publicAddrs[0]; // first validated public A/AAAA — all returned addrs were checked
        } catch (e) {
            lastErr = e;
            console.warn(`[MailServer][SSRF] Skipping MX ${mx.exchange} for ${recipient}: ${e.message}`);
            continue;
        }

        try {
            // M2-TLS: try with full certificate verification first. Connect to the pinned IP, verify the
            // cert against the real MX hostname (mx.exchange) via servername.
            const info = await sendVia(pinnedIp, mx.exchange, true);
            return { ok: true, mx: mx.exchange, response: info.response };
        } catch (e) {
            // On a TLS *verification* failure (and only that), retry THIS host once with verification
            // disabled, logging the downgrade explicitly. Other failures fall through to the next MX.
            if (isTlsVerifyError(e)) {
                console.warn(`[MailServer][TLS] STARTTLS verification FAILED for ${mx.exchange} (${e.message}) — retrying with verification DISABLED (downgraded, opportunistic encryption only).`);
                try {
                    const info = await sendVia(pinnedIp, mx.exchange, false);
                    return { ok: true, mx: mx.exchange, response: info.response, tlsDowngraded: true };
                } catch (e2) {
                    lastErr = e2;
                    const code = e2.responseCode || 0;
                    permanent = code >= 500 && code < 600;
                    if (permanent) break;
                    continue;
                }
            }
            lastErr = e;
            const code = e.responseCode || 0;
            permanent = code >= 500 && code < 600;
            if (permanent) break; // a hard 5xx reject won't differ on another MX
        }
    }
    const err = new Error(`Direct delivery to ${recipient} failed: ${lastErr ? lastErr.message : 'no MX reachable'}`);
    err.permanent = permanent;
    throw err;
}

// Option keys that the host treats as PROTECTED (secret/security-critical) and therefore blocks via
// wordjs.options for an untrusted plugin. We persist these in our OWN wjp_mail_server_secrets table
// instead (host-gated by database:read/write). The matcher mirrors the host's PROTECTED_OPTION_RE plus
// admin_email so every call site can keep using getOption/updateOption transparently.
//   - relay creds           → mail_user, mail_pass (kept in the secrets table, not options)
//   - 'dkim' / 'key' / etc. → mail_security_dkim_private_key, mail_security_dkim_domain/selector/enabled
const SECRET_OPTION_RE = /secret|passw(or)?d|pwd|priv(ate)?[_-]?key|privatekey|dkim|\bkey\b|[_-]key\b|key$|api[_-]?key|token|\bsalt\b|jwt|credential|encryption|signing|certificate|\.pem|access[_-]?key/i;
// Relay credentials don't match the secret-word regex but are sensitive — keep them in the secrets table too.
const SECRET_OPTION_NAMES = new Set(['mail_user', 'mail_pass']);
const isSecretOption = (key) => SECRET_OPTION_RE.test(String(key)) || SECRET_OPTION_NAMES.has(String(key).toLowerCase());

exports.init = async function (bridge) {
    wordjs = bridge;
    Email = require('./lib/email-store')(wordjs.db);

    // getOption/updateOption transparently route secret/security-critical keys to the plugin's own
    // secrets table (the host blocks those via the generic options bridge) and everything else to
    // wordjs.options. admin_email is also protected by the host → served from the site bridge.
    getOption = async (key, def) => {
        if (String(key).toLowerCase() === 'admin_email') {
            try { return (await wordjs.site.adminEmail()) || def; } catch (e) { return def; }
        }
        if (isSecretOption(key)) return await Email.getSecret(key, def === undefined ? '' : def);
        return await wordjs.options.get(key, def);
    };
    updateOption = async (key, value) => {
        if (isSecretOption(key)) return await Email.setSecret(key, value);
        return await wordjs.options.set(key, value);
    };

    // Schema first so the secrets table exists before getOption/updateOption touch it.
    await Email.initSchema();

    // Security Data Directory — the plugin's OWN dir (untrusted plugins can't write shared uploads).
    const SEC_DATA_DIR = path.join(__dirname, 'data');
    try { fs.mkdirSync(SEC_DATA_DIR, { recursive: true }); } catch (e) { }

    // Initialize Bayes
    const bayes = require('bayes');
    classifier = bayes();
    const bayesFile = path.join(SEC_DATA_DIR, 'bayes.json');
    try {
        if (fs.existsSync(bayesFile)) {
            classifier = bayes.fromJson(fs.readFileSync(bayesFile, 'utf-8'));
        }
    } catch (e) { console.error('Failed to load bayes db', e); }

    saveBayes = async () => {
        try {
            fs.writeFileSync(bayesFile, classifier.toJson());
        } catch (e) {
            console.error('[MailServer] Failed to save Bayes classifier:', e.message);
        }
    };

    // Network-dependent setup (outbound transport + inbound SMTP server) needs the `network` permission
    // (raw sockets / tls). It's granted on activation, but degrade gracefully rather than fail
    // activation if it's ever missing (e.g. the admin revoked Network, or the port is taken): the
    // plugin still loads, and re-granting Network + reactivating brings these up for real.
    try {
        await initTransporter();
        await initSMTPServer();
    } catch (e) {
        console.warn(`[MailServer] Network features disabled (grant the "network" permission in /admin/plugins and reactivate to enable outbound delivery + the inbound SMTP server): ${e && e.message}`);
    }

    // === BACKGROUND TASKS ===
    // Process Scheduled Emails every minute.
    // Guard against double-start (re-activate) leaking a second timer.
    if (queueInterval) clearInterval(queueInterval);
    queueInterval = setInterval(async () => {
        try {
            const pending = await Email.getPendingScheduled();
            if (pending.length > 0) console.log(`[MailServer] Processing ${pending.length} scheduled emails...`);

            for (const email of pending) {
                try {
                    // Load attachments if any
                    const attachments = await Email.getAttachments(email.id);
                    const formattedAttachments = attachments.map(att => ({
                        filename: att.filename,
                        path: path.join(UPLOAD_DIR, att.storage_path)
                    }));

                    await sendMail({
                        // to/cc/bcc are stored as comma-joined lists — split them back into real
                        // recipient arrays (a joined string would read as ONE malformed address).
                        to: splitAddresses(email.to_address),
                        cc: splitAddresses(email.cc_address),
                        bcc: splitAddresses(email.bcc_address),
                        subject: email.subject,
                        text: email.body_text,
                        html: email.body_html,
                        fromEmail: email.from_address,
                        fromName: email.from_name,
                        parentId: email.parent_id,
                        threadId: email.thread_id,
                        userId: email.user_id || 0,
                        draftId: email.id, // Re-use existing record to mark as sent
                        attachments: formattedAttachments
                    });
                    console.log(`[MailServer] Scheduled email ${email.id} sent.`);
                } catch (err) {
                    console.error(`[MailServer] Failed to send scheduled email ${email.id}:`, err);
                    // Optional: increment retry count or mark as failed
                }
            }
        } catch (e) {
            console.error('[MailServer] Scheduled queue error:', e);
        }

        // Retry queue: re-attempt outbound emails whose temporary failures are now due.
        try {
            const retries = await Email.getPendingRetries();
            if (retries.length > 0) console.log(`[MailServer] Processing ${retries.length} retry emails...`);

            for (const email of retries) {
                try {
                    // to_address holds exactly the still-failed (external) recipients for this row.
                    const recipients = (email.to_address || '').split(',').map(s => s.trim()).filter(Boolean);
                    if (recipients.length === 0) {
                        await Email.markFailed(email.id, email.delivery_attempts || 0, 'No recipients to retry');
                        continue;
                    }

                    const attachments = await Email.getAttachments(email.id);
                    const formattedAttachments = attachments.map(att => ({
                        filename: att.filename,
                        path: path.join(UPLOAD_DIR, att.storage_path)
                    }));

                    await sendMail({
                        to: recipients,
                        subject: email.subject,
                        text: email.body_text,
                        html: email.body_html,
                        fromEmail: email.from_address,
                        fromName: email.from_name,
                        parentId: email.parent_id,
                        threadId: email.thread_id,
                        userId: email.user_id || 0,
                        // Reuse the existing Sent record instead of creating a duplicate copy.
                        isRetry: true,
                        sentRecordId: email.id,
                        deliveryAttempts: email.delivery_attempts || 0,
                        attachments: formattedAttachments
                    });
                } catch (err) {
                    console.error(`[MailServer] Failed to retry email ${email.id}:`, err);
                }
            }
        } catch (e) {
            console.error('[MailServer] Retry queue error:', e);
        }

        // Sweep expired outbound-rate-limit windows so _outboundUsage doesn't grow unbounded.
        try {
            const now = Date.now();
            for (const [uid, usage] of _outboundUsage) {
                if (now - usage.windowStart > OUTBOUND_WINDOW_MS) {
                    _outboundUsage.delete(uid);
                }
            }
            _vacationKeySweep();
        } catch (e) {
            console.error('[MailServer] Outbound usage sweep error:', e);
        }

        // Spam retention (Gmail-style): permanently purge spam older than 30 days, at most every 6h.
        try {
            const now = Date.now();
            if (now - _lastSpamPurge > 6 * 60 * 60 * 1000) {
                _lastSpamPurge = now;
                const purged = await Email.purgeOldSpam(30);
                if (purged > 0) console.log(`[MailServer] Purged ${purged} spam message(s) older than 30 days.`);
            }
        } catch (e) {
            console.error('[MailServer] Spam purge error:', e);
        }
        // 15s tick (was 60s): the queue drives UNDO SEND (a message sits in the outbox for
        // ~10s before dispatch), so a 60s tick would stretch "sending…" to over a minute. All the
        // sweeps above are indexed probes that no-op when there's nothing pending.
    }, 15 * 1000);

    // === API ROUTES — namespaced by the host under /api/v1/plugin/mail-server/* ===
    // No 'absolute' bypass exists anymore: wordjs.http.route prefixes /api/v1/plugin/<slug>, so we pass
    // only the sub-path. The plugin's frontend (client/) calls api('/plugin/mail-server/...').
    const route = (method, sub, opts, handler) => {
        if (typeof opts === 'function') { handler = opts; opts = {}; }
        wordjs.http.route(method, sub, opts, handler);
    };

    // SECURITY: authorize a request against a single email record.
    //
    // The previous checks did `email.to_address !== req.user.userEmail`, but to_address (and
    // cc_address/bcc_address) are COMMA-JOINED recipient lists — so (a) cc/bcc recipients were never
    // matched (they could not read their own mail and, worse, the whole-string compare leaked nothing
    // to them but also never authorized them) and (b) a member of a multi-recipient To list failed the
    // exact-equality compare. Email.canUserAccess parses every recipient field into exact address
    // tokens and checks membership across to + cc + bcc + sender.
    //
    // The `administrator` override is preserved (existing behavior); note that in this sandboxed plugin
    // req.user is the users:read projection {id,userLogin,username,userEmail,displayName,role} and
    // carries no capability map, so the override keys off role. If/when a dedicated capability bridge
    // exists, gate this behind an explicit 'read_others_mail' capability instead of the bare role.
    const canAccessEmail = (email, user) =>
        Email.canUserAccess(email, user.userEmail) || user.role === 'administrator';

    // GET /api/v1/plugin/mail-server/emails/search — operator-aware (from:/to:/subject:/label:/in:/
    // has:attachment/is:unread/is:starred + free text), scoped to the requester's mailbox.
    route('get', '/emails/search', { auth: true }, async (req, res) => {
        const raw = String(req.query.q || '');
        if (raw.length < 2) return res.json({ emails: [] });

        try {
            const q = parseSearchQuery(raw);
            if (req.query.folder && !q.folder) q.folder = String(req.query.folder);
            if (q.labelName) {
                const label = await Email.findLabelByName(req.user.id, q.labelName);
                q.labelId = label ? label.id : -1; // -1 matches nothing (unknown label name)
            }
            const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 100);
            const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
            const emails = await Email.search(req.user.id, req.user.userEmail, q, limit, offset);
            const labels = await Email.getLabelsForEmails(emails.map(e => e.id));
            res.json({ emails, labels });
        } catch (error) {
            console.error("Search error:", error);
            res.status(500).json({ error: "Search failed" });
        }
    });

    // GET /api/v1/plugin/mail-server/emails — folder listing. Also accepts folder=spam and
    // folder=label:<id>. Returns badge counts + the listed messages' labels in the SAME response so
    // the client needs ONE request per poll (it used to issue /emails + /stats).
    route('get', '/emails', { auth: true }, async (req, res) => {
        try {
            const rawFolder = String(req.query.folder || 'inbox');
            const KNOWN = ['inbox', 'sent', 'drafts', 'archive', 'starred', 'trash', 'spam'];
            let folder = 'inbox';
            let labelId = 0;
            if (KNOWN.includes(rawFolder)) {
                folder = rawFolder;
            } else if (/^label:\d+$/.test(rawFolder)) {
                labelId = parseInt(rawFolder.slice(6), 10) || 0;
                const label = await Email.findLabel(labelId, req.user.id);
                if (!label) return res.status(404).json({ error: 'Label not found' });
                folder = 'label';
            }
            const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 100);
            const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

            const [emails, total, counts] = await Promise.all([
                Email.findAllByUser(req.user.id, req.user.userEmail, folder, limit, offset, labelId),
                Email.countByUser(req.user.id, req.user.userEmail, folder, labelId),
                Email.getCounts(req.user.id, req.user.userEmail)
            ]);
            const labels = await Email.getLabelsForEmails(emails.map(e => e.id));
            res.json({ emails, total, counts, labels });
        } catch (error) {
            console.error('Listing failed:', error);
            res.status(500).json({ error: 'Failed to load messages' });
        }
    });

    // GET /api/v1/plugin/mail-server/stats — kept for back-compat; same single-pass counters.
    route('get', '/stats', { auth: true }, async (req, res) => {
        try {
            const counts = await Email.getCounts(req.user.id, req.user.userEmail);
            res.json({ unread: counts.inbox_unread, ...counts });
        } catch (error) {
            res.status(500).json({ error: 'Stats failed' });
        }
    });

    // GET /api/v1/plugin/mail-server/emails/:id — full message + its whole conversation, with
    // attachments and labels for EVERY thread message in two batched queries (attachments used to be
    // dropped entirely whenever the conversation had more than one message).
    route('get', '/emails/:id', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        // Security: Must be a recipient (to/cc/bcc) or the sender (or an administrator).
        if (!canAccessEmail(email, req.user)) {
            return res.status(403).json({ error: 'Access denied to this message' });
        }

        // Only write when it changes something (every open used to issue the UPDATE unconditionally).
        if (!email.is_read) {
            await Email.markAsRead(req.params.id);
            email.is_read = 1;
        }

        const threadIdToSearch = email.thread_id || email.id;
        const thread = await Email.findByThreadId(threadIdToSearch, req.user.userEmail, { includeSpam: !!email.is_spam });

        const ids = [email.id, ...(thread || []).map(t => t.id)];
        const [attMap, labelMap] = await Promise.all([
            Email.getAttachmentsForEmails(ids),
            Email.getLabelsForEmails(ids)
        ]);
        const withExtras = (msg) => ({ ...msg, attachments: attMap[msg.id] || [], labels: labelMap[msg.id] || [] });

        if (thread && thread.length > 1) {
            return res.json({ ...withExtras(email), thread: thread.map(withExtras) });
        }
        res.json(withExtras(email));
    });

    // DELETE /api/v1/plugin/mail-server/emails/:id - Move to Trash (Soft Delete)
    route('delete', '/emails/:id', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        if (!canAccessEmail(email, req.user)) {
            return res.status(403).json({ error: 'Cannot delete this message' });
        }

        // If already in trash, delete permanently
        if (email.is_trash === 1) {
            await Email.deletePermanently(req.params.id);
            return res.json({ success: true, message: 'Deleted permanently' });
        }

        await Email.moveToTrash(req.params.id);
        res.json({ success: true, message: 'Moved to trash' });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/restore - Restore from Trash
    route('put', '/emails/:id/restore', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        if (!canAccessEmail(email, req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await Email.restoreFromTrash(req.params.id);
        res.json({ success: true, message: 'Restored from trash' });
    });

    // DELETE /api/v1/plugin/mail-server/trash/empty - Empty Trash
    route('delete', '/trash/empty', { auth: true }, async (req, res) => {
        await Email.emptyTrash(req.user.id, req.user.userEmail);
        res.json({ success: true, message: 'Trash emptied' });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/star
    route('put', '/emails/:id/star', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (!Email.canUserAccess(email, req.user.userEmail)) return res.status(403).json({ error: 'Forbidden' });

        await Email.setStarred(req.params.id, req.body.starred);
        res.json({ success: true });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/archive
    route('put', '/emails/:id/archive', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (!Email.canUserAccess(email, req.user.userEmail)) return res.status(403).json({ error: 'Forbidden' });

        await Email.setArchived(req.params.id, req.body.archived);
        res.json({ success: true });
    });

    // POST /api/v1/plugin/mail-server/classification/train
    route('post', '/classification/train', { auth: true }, async (req, res) => {
        try {
            const { id, category } = req.body; // category: 'spam' or 'ham'
            if (!['spam', 'ham'].includes(category)) return res.status(400).json({ error: 'Invalid category' });

            const email = await Email.findById(id);
            if (!email) return res.status(404).json({ error: 'Email not found' });

            // Security (IDOR): only the email's owner (sender/recipient, or an administrator) may train
            // on / trash it. Without this gate any authenticated user could submit another user's email
            // id to poison the shared Bayes filter and trash that user's message.
            if (!canAccessEmail(email, req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Learn
            const text = (email.subject || '') + ' ' + (email.body_text || '');
            await classifier.learn(text, category);
            await saveBayes();

            // Auto-move: spam goes to the SPAM folder (not trash), ham comes back out of it.
            // (The old code checked `email.isTrash` — the row property is is_trash — so "ham" never
            // actually restored anything.)
            if (category === 'spam') {
                await Email.setSpam(id, true);
            } else if (category === 'ham') {
                await Email.setSpam(id, false);
                if (email.is_trash) await Email.restoreFromTrash(id);
            }

            res.json({ success: true, message: `Learned as ${category}` });
        } catch (error) {
            console.error('Training failed:', error);
            res.status(500).json({ error: 'Training failed' });
        }
    });

    // POST /api/v1/plugin/mail-server/drafts
    route('post', '/drafts', { auth: true }, async (req, res) => {
        const { id, to, cc, bcc, subject, body, isHtml = true, replyToId, attachments } = req.body;

        try {
            const data = {
                fromAddress: req.user.userEmail,
                fromName: req.user.displayName || req.user.userLogin,
                toAddress: splitAddresses(to).join(', '),
                ccAddress: splitAddresses(cc).join(', '),
                bccAddress: splitAddresses(bcc).join(', '),
                subject: subject || '',
                bodyText: isHtml ? body.replace(/<[^>]*>/g, '') : body,
                bodyHtml: isHtml ? body : null,
                rawContent: body || '',
                isDraft: 1,
                isSent: 0,
                parentId: 0,
                threadId: 0,
                userId: req.user.id,
                attachments: attachments || []
            };

            if (replyToId) {
                const parent = await Email.findById(replyToId);
                if (parent) {
                    data.parentId = parent.id;
                    data.threadId = parent.thread_id || parent.id;
                }
            }

            let email;
            if (id) {
                const existing = await Email.findById(id);
                if (!existing || existing.from_address !== req.user.userEmail) {
                    return res.status(403).json({ error: 'Access denied' });
                }
                email = await Email.update(id, data);
            } else {
                email = await Email.create(data);
            }
            res.json({ success: true, id: email.id });
        } catch (error) {
            console.error("Draft save failed:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /api/v1/plugin/mail-server/send
    route('post', '/send', { auth: true }, async (req, res) => {
        const { to, cc, bcc, subject, body, isHtml = true, replyToId, id, attachments, scheduledAt } = req.body;
        if (!to || !subject || !body) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Normalize the composer's raw "a@x.com, b@y.com" strings into real address lists and
        // validate EVERY recipient up-front — a queued (undo-window / scheduled) send must fail HERE,
        // visibly, not minutes later inside the background queue. (This also fixes multi-recipient
        // sends outright: the comma-joined string used to be treated as ONE malformed address.)
        const toList = splitAddresses(to);
        const ccList = splitAddresses(cc);
        const bccList = splitAddresses(bcc);
        if (toList.length === 0) return res.status(400).json({ error: 'Missing recipient' });
        for (const addr of [...toList, ...ccList, ...bccList]) {
            if (!isValidEmail(addr)) return res.status(400).json({ error: `Invalid recipient email address format: ${addr}` });
        }

        // SECURITY (H8): cap recipients per message and enforce a per-user outbound rate limit.
        const recipientCount = toList.length + ccList.length + bccList.length;
        if (recipientCount > MAX_RECIPIENTS_PER_MESSAGE) {
            return res.status(400).json({ error: `Too many recipients (max ${MAX_RECIPIENTS_PER_MESSAGE} per message).` });
        }
        if (!outboundRateLimitOk(req.user.id, recipientCount)) {
            return res.status(429).json({ error: 'Outbound mail rate limit exceeded. Please try again later.' });
        }

        // SECURITY (IDOR): a supplied draft id must be the CALLER's own row — otherwise any user
        // could overwrite (and effectively send as) another user's draft by guessing its id.
        if (id) {
            const existing = await Email.findById(id);
            const ownsIt = existing && (
                existing.user_id === req.user.id ||
                String(existing.from_address || '').toLowerCase() === String(req.user.userEmail || '').toLowerCase()
            );
            if (!ownsIt) return res.status(403).json({ error: 'Access denied' });
        }

        let parentId = 0;
        let threadId = 0;

        if (replyToId) {
            const parent = await Email.findById(replyToId);
            if (parent) {
                parentId = parent.id;
                threadId = parent.thread_id || parent.id;
            }
        }

        try {
            // UNDO SEND (Gmail-style): unless the user explicitly scheduled the message, hold it in
            // the outbox for a short window (default 10s, option mail_undo_send_seconds, 0 disables)
            // before the 15s queue dispatches it — the client shows an "Undo" toast meanwhile.
            let effectiveSchedule = scheduledAt ? new Date(scheduledAt).toISOString() : null;
            let undoSeconds = 0;
            if (!effectiveSchedule) {
                const undoRaw = parseInt(await getOption('mail_undo_send_seconds', '10'), 10);
                undoSeconds = Number.isFinite(undoRaw) ? Math.min(Math.max(undoRaw, 0), 60) : 10;
                if (undoSeconds > 0) effectiveSchedule = new Date(Date.now() + undoSeconds * 1000).toISOString();
            }

            if (effectiveSchedule) {
                const data = {
                    fromAddress: req.user.userEmail,
                    fromName: req.user.displayName || req.user.userLogin,
                    toAddress: toList.join(', '),
                    ccAddress: ccList.join(', '),
                    bccAddress: bccList.join(', '),
                    subject: subject || '',
                    bodyText: isHtml ? body.replace(/<[^>]*>/g, '') : body,
                    bodyHtml: isHtml ? body : null,
                    rawContent: body || '',
                    isDraft: 0,
                    isSent: 0, // Not sent yet — the queue dispatches it
                    parentId,
                    threadId,
                    userId: req.user.id,
                    attachments: attachments || [],
                    scheduledAt: effectiveSchedule
                };

                // Create or Update (if it was a draft)
                let email;
                if (id) {
                    await Email.update(id, data);
                    // update() doesn't persist attachment rows (create() does) — but the QUEUE delivers
                    // from the stored rows, so a draft promoted to the outbox must save them now.
                    for (const att of (attachments || [])) {
                        try { await Email.saveAttachment(id, att); } catch (e) { /* per-file best effort */ }
                    }
                    email = { id };
                } else {
                    email = await Email.create(data);
                }

                if (scheduledAt) {
                    return res.json({ success: true, message: 'Message scheduled', id: email.id });
                }
                return res.json({ success: true, queued: true, undoSeconds, id: email.id, message: 'Sending…' });
            }

            // Undo window disabled (mail_undo_send_seconds = 0) → immediate synchronous delivery.
            const result = await sendMail({
                to: toList,
                cc: ccList,
                bcc: bccList,
                subject,
                text: isHtml ? body.replace(/<[^>]*>/g, '') : body,
                html: isHtml ? body : null,
                fromEmail: req.user.userEmail,
                fromName: req.user.displayName || req.user.userLogin,
                parentId,
                threadId,
                userId: req.user.id,
                draftId: id,
                attachments: attachments || []
            });
            if (result.failed && result.failed.length > 0) {
                // Partial/total external delivery failure — report it (the Sent copy is still saved).
                return res.status(207).json({
                    success: false,
                    message: 'Saved, but external delivery failed for some recipients',
                    delivered: result.delivered,
                    failed: result.failed
                });
            }
            res.json({ success: true, message: 'Message delivered', delivered: result.delivered });
        } catch (error) {
            res.status(500).json({ error: 'Delivery failed: ' + error.message });
        }
    });

    // POST /api/v1/plugin/mail-server/emails/:id/unsend — cancel a message still in its undo window
    // (or a scheduled send) and turn it back into a draft. Guarded on is_sent = 0 in the UPDATE
    // itself, so racing the queue can never "unsend" something already handed to delivery.
    route('post', '/emails/:id/unsend', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        const isOwner = email.user_id === req.user.id ||
            String(email.from_address || '').toLowerCase() === String(req.user.userEmail || '').toLowerCase();
        if (!isOwner) return res.status(403).json({ error: 'Forbidden' });
        if (email.is_sent === 1 || !email.scheduled_at) {
            return res.status(409).json({ error: 'Too late — the message was already handed off for delivery.' });
        }
        const after = await Email.cancelScheduled(email.id);
        if (!after || after.is_sent === 1 || after.is_draft !== 1) {
            return res.status(409).json({ error: 'Too late — the message was already handed off for delivery.' });
        }
        res.json({ success: true, id: after.id, message: 'Send canceled — moved back to drafts' });
    });

    // POST /api/v1/plugin/mail-server/emails/:id/retry — re-attempt a message whose delivery FAILED
    // (or is mid-retry), NOW, instead of waiting for the backoff. On a failed/retry row, to_address
    // holds exactly the still-failed recipients (updateRetryState rewrites it), so we re-send those
    // through sendMail with isRetry:true — reusing the same Sent record (no duplicate copy). Manual
    // retry resets the attempt counter so the user gets a fresh delivery cycle.
    route('post', '/emails/:id/retry', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        const isOwner = email.user_id === req.user.id ||
            String(email.from_address || '').toLowerCase() === String(req.user.userEmail || '').toLowerCase();
        if (!isOwner && req.user.role !== 'administrator') return res.status(403).json({ error: 'Forbidden' });
        if (email.delivery_status !== 'failed' && email.delivery_status !== 'retry') {
            return res.status(409).json({ error: 'This message is not in a failed state — nothing to retry.' });
        }

        const recipients = splitAddresses(email.to_address);
        if (recipients.length === 0) return res.status(400).json({ error: 'No recipients to retry.' });

        // Per-user outbound rate limit still applies to a manual retry.
        if (!outboundRateLimitOk(req.user.id, recipients.length)) {
            return res.status(429).json({ error: 'Outbound mail rate limit exceeded. Please try again later.' });
        }

        try {
            const attachments = (await Email.getAttachments(email.id)).map(att => ({
                filename: att.filename,
                path: path.join(UPLOAD_DIR, att.storage_path)
            }));
            const result = await sendMail({
                to: recipients,
                subject: email.subject,
                text: email.body_text,
                html: email.body_html,
                fromEmail: email.from_address,
                fromName: email.from_name,
                parentId: email.parent_id,
                threadId: email.thread_id,
                userId: email.user_id || 0,
                isRetry: true,
                sentRecordId: email.id,
                deliveryAttempts: 0, // manual retry → fresh cycle, not stuck at max attempts
                attachments
            });
            const after = await Email.findById(email.id);
            if (result.success) {
                return res.json({ success: true, id: email.id, status: after ? after.delivery_status : 'sent', message: 'Delivered.' });
            }
            // Still failing — report the fresh reason (sendMail already persisted last_error + status).
            return res.status(207).json({
                success: false,
                id: email.id,
                status: after ? after.delivery_status : 'failed',
                lastError: after ? after.last_error : null,
                failed: result.failed,
                message: after && after.delivery_status === 'retry'
                    ? 'Still undeliverable — re-queued for automatic retry.'
                    : 'Still undeliverable.'
            });
        } catch (error) {
            res.status(500).json({ error: 'Retry failed: ' + error.message });
        }
    });

    // GET /api/v1/plugin/mail-server/users/search
    route('get', '/users/search', { auth: true }, async (req, res) => {
        const query = req.query.q || '';
        if (query.length < 2) return res.json([]);

        const siteDomain = await getSiteDomain();

        const users = await User.findAll({ search: query, limit: 5 });
        res.json(users.map(u => ({
            email: `${u.userLogin.toLowerCase()}@${siteDomain}`,
            realEmail: u.userEmail,
            name: u.displayName || u.userLogin
        })));
    });

    // GET /api/v1/plugin/mail-server/settings — one PARALLEL wave of option reads. The old handler
    // awaited ~20 of them sequentially (each an RPC round-trip, secrets also DB+decrypt), which made
    // opening the settings page pay the whole chain in latency.
    route('get', '/settings', { auth: true, admin: true }, async (req, res) => {
        const o = await getOptionsBatch({
            mail_from_email: '', mail_from_name: '',
            smtp_listen_port: '25', smtp_proxy_ips: '', smtp_catch_all: '0',
            mail_helo_host: '',
            mail_server: '', mail_port: '587', mail_secure: '0', mail_user: '', mail_pass: '',
            mail_relay_require_tls: '1',
            mail_security_dkim_domain: '', mail_security_dkim_selector: 'default',
            mail_security_dkim_private_key: '',
            // Defaults reflect the SAFE posture (H12): DNSBL + SPF default ON, SPF reject default ON.
            mail_security_dnsbl_enabled: '1', mail_security_spf_enabled: '1', mail_security_spf_reject: '1',
            mail_undo_send_seconds: '10'
        });
        res.json({
            mail_from_email: o.mail_from_email,
            mail_from_name: o.mail_from_name,
            smtp_listen_port: o.smtp_listen_port,
            // PROXY protocol trusted-proxy IPs (comma-separated) + whether it's actually active now.
            smtp_proxy_ips: o.smtp_proxy_ips,
            smtp_proxy_active: (inboundStatus.proxyIps && inboundStatus.proxyIps.length) ? true : false,
            // Live inbound listener status so the UI can surface a real state instead of a silent
            // no-inbound: the port we ACTUALLY bound, whether we had to fall back off the standard 25,
            // and why. inbound_ok = bound on the standard MX port (external inbound can work).
            inbound_bound_port: inboundStatus.boundPort,
            inbound_degraded: inboundStatus.degraded,
            inbound_reason: inboundStatus.reason,
            inbound_ok: inboundStatus.boundPort === 25,
            smtp_catch_all: o.smtp_catch_all,
            mail_helo_host: o.mail_helo_host,
            // Relay / smarthost (optional). Without these exposed the relay path was unreachable and
            // delivery was stuck on direct-MX port 25 (blocked by most cloud/residential hosts). The relay
            // PASSWORD is a secret and is never returned — only whether one is stored (mail_pass_set).
            mail_server: o.mail_server,
            mail_port: o.mail_port,
            mail_secure: o.mail_secure,
            mail_user: o.mail_user,
            mail_pass_set: o.mail_pass ? true : false,
            mail_relay_require_tls: o.mail_relay_require_tls,
            mail_security_dkim_domain: o.mail_security_dkim_domain,
            mail_security_dkim_selector: o.mail_security_dkim_selector,
            mail_security_dkim_enabled: o.mail_security_dkim_private_key ? '1' : '0',
            mail_security_dnsbl_enabled: o.mail_security_dnsbl_enabled,
            mail_security_spf_enabled: o.mail_security_spf_enabled,
            mail_security_spf_reject: o.mail_security_spf_reject,
            // Undo-send window in seconds (0 disables and restores synchronous delivery).
            mail_undo_send_seconds: o.mail_undo_send_seconds
            // NOTE: the DKIM private key is never returned (secret).
        });
    });

    // POST /api/v1/plugin/mail-server/settings
    route('post', '/settings', { auth: true, admin: true }, async (req, res) => {
        // Validate the trusted-proxy allowlist BEFORE persisting: plain IPs only (no hostnames, no
        // wildcards, never "true"). This is the same guarantee parseTrustedProxyIps enforces at bind
        // time, surfaced to the admin as a clear error instead of silently dropping a typo.
        if (req.body.smtp_proxy_ips !== undefined) {
            const toks = String(req.body.smtp_proxy_ips).split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
            const bad = toks.filter(t => net.isIP(t) === 0);
            if (bad.length) {
                return res.status(400).json({ error: `Trusted proxy IPs must be plain IP addresses (no hostnames or wildcards). Invalid: ${bad.slice(0, 5).join(', ')}` });
            }
        }

        const fields = [
            'mail_from_email', 'mail_from_name',
            'smtp_listen_port', 'smtp_proxy_ips', 'smtp_catch_all',
            'mail_helo_host',
            // Relay / smarthost (mail_user/mail_pass route to the encrypted secrets table via isSecretOption).
            'mail_server', 'mail_port', 'mail_secure', 'mail_user', 'mail_pass', 'mail_relay_require_tls',
            'mail_security_dkim_domain', 'mail_security_dkim_selector',
            'mail_security_dnsbl_enabled', 'mail_security_spf_enabled', 'mail_security_spf_reject',
            'mail_undo_send_seconds'
        ];

        for (const f of fields) {
            if (req.body[f] === undefined) continue;
            // Don't wipe the stored relay password when the field is left blank on a normal save — the UI
            // only sends mail_pass when the admin is actually (re)setting it.
            if (f === 'mail_pass' && req.body[f] === '') continue;
            await updateOption(f, req.body[f]);
        }

        // Re-init BOTH the inbound listener AND the outbound relay transport so relay/port changes take
        // effect immediately (previously only initSMTPServer ran, so relay edits needed a full reload).
        await initSMTPServer();
        await initTransporter();
        res.json({ success: true, message: 'Server settings updated' });
    });

    // POST /api/v1/plugin/mail-server/test  — send a real test message (pass {to} to test EXTERNAL delivery)
    route('post', '/test', { auth: true, admin: true }, async (req, res) => {
        try {
            const to = (req.body && req.body.to) || req.user.userEmail;
            // A LOCAL recipient (any local account's address) is delivered straight to the DB inbox and
            // never touches MX / DKIM / port 25 — so a green result there proves NOTHING about real
            // deliverability. Detect it and tell the admin plainly instead of a misleading "success".
            const localUser = await User.findByEmail(to).catch(() => null);
            const result = await sendMail({
                to,
                subject: 'WordJS Mail Server — delivery test',
                text: 'If you received this, outbound delivery is working.',
                html: '<p>If you received this, <strong>outbound delivery</strong> is working.</p>',
                userId: req.user.id
            });
            const externalAttempted = (result.delivered && result.delivered.length) || (result.failed && result.failed.length);
            const localOnly = !!localUser && !externalAttempted;
            let message;
            if (localOnly) {
                message = `Delivered to the LOCAL mailbox of ${to} only — external MX / DKIM / port 25 were NOT exercised. Enter an OFF-domain address (e.g. a Gmail account) to test real internet deliverability.`;
            } else if (result.success) {
                message = 'Test message accepted by the recipient mail server (external delivery succeeded).';
            } else {
                message = 'Delivery failed — check rDNS/SPF/DKIM/DMARC and that outbound port 25 (or a configured relay) is reachable.';
            }
            res.status(result.success ? 200 : 207).json({
                success: result.success, to, localOnly,
                delivered: result.delivered, failed: result.failed, message
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v1/plugin/mail-server/security/dns-records — records to publish for deliverability
    route('get', '/security/dns-records', { auth: true, admin: true }, async (req, res) => {
        const priv = await getOption('mail_security_dkim_private_key', '');
        let domain = await getOption('mail_security_dkim_domain', '');
        if (!domain) { try { domain = await getSiteDomain(); } catch (e) { domain = ''; } }
        const selector = await getOption('mail_security_dkim_selector', 'default');
        let publicKeyPem = '';
        if (priv) {
            try { publicKeyPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }); }
            catch (e) { /* invalid stored key */ }
        }
        res.json({
            domain,
            selector,
            heloHost: await getHeloName(),
            dkimConfigured: !!priv,
            records: buildDnsRecords(domain, selector, publicKeyPem)
        });
    });

    // GET /api/v1/plugin/mail-server/security/dns-check — resolve the domain's LIVE DNS and compare it
    // to what WordJS expects, so the operator can confirm each record is actually published + correct
    // (not just eyeball it). Needs the `network` grant (same DNS resolver the outbound path already uses).
    route('get', '/security/dns-check', { auth: true, admin: true }, async (req, res) => {
        const priv = await getOption('mail_security_dkim_private_key', '');
        let domain = await getOption('mail_security_dkim_domain', '');
        if (!domain) { try { domain = await getSiteDomain(); } catch (e) { domain = ''; } }
        const selector = await getOption('mail_security_dkim_selector', 'default');
        let publicKeyPem = '';
        if (priv) { try { publicKeyPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }); } catch (e) { } }
        if (!domain) return res.status(400).json({ error: 'Set a sending domain (generate DKIM) before checking DNS.' });

        const expected = buildDnsRecords(domain, selector, publicKeyPem);
        const mailHost = `mail.${domain}`;
        // A provider may split a TXT into multiple quoted strings; DNS returns them as an array to join.
        const txt = async (name) => {
            try { return (await dns.resolveTxt(name)).map(parts => parts.join('')); } catch (e) { return null; }
        };
        const pOf = (s) => { const m = String(s || '').replace(/\s+/g, '').match(/p=([a-z0-9+/=]+)/i); return m ? m[1].toLowerCase() : ''; };
        const results = {};

        // MX → must point at our mail host (or the bare domain if that's the operator's choice).
        try {
            const mx = await dns.resolveMx(domain);
            const hosts = mx.map(m => String(m.exchange || '').replace(/\.$/, '').toLowerCase());
            const want = [mailHost.toLowerCase(), domain.toLowerCase()];
            results.mx = { status: hosts.length === 0 ? 'missing' : (hosts.some(h => want.includes(h)) ? 'ok' : 'mismatch'), found: hosts.join(', ') || null };
        } catch (e) { results.mx = { status: 'missing', found: null }; }

        // A → the mail host must resolve to an address.
        try {
            const ips = await dns.resolve4(mailHost);
            results.a = { status: ips && ips.length ? 'ok' : 'missing', found: (ips || []).join(', ') || null };
        } catch (e) { results.a = { status: 'missing', found: null }; }

        // SPF → a TXT on the domain with v=spf1.
        { const recs = await txt(domain); const spf = (recs || []).find(r => /v=spf1/i.test(r)); results.spf = { status: spf ? 'ok' : 'missing', found: spf || null }; }

        // DMARC → a TXT on _dmarc.<domain> with v=DMARC1.
        { const recs = await txt(`_dmarc.${domain}`); const d = (recs || []).find(r => /v=DMARC1/i.test(r)); results.dmarc = { status: d ? 'ok' : 'missing', found: d || null }; }

        // DKIM → the published p= key MUST equal the one WordJS generated (the strongest check).
        if (publicKeyPem) {
            const recs = await txt(`${selector}._domainkey.${domain}`);
            const dk = (recs || []).find(r => /v=DKIM1/i.test(r) || /p=/i.test(r));
            const foundP = pOf(dk), wantP = pOf(expected.dkim.value);
            results.dkim = {
                status: !dk ? 'missing' : (foundP && foundP === wantP ? 'ok' : 'mismatch'),
                found: dk ? (String(dk).slice(0, 48) + (String(dk).length > 48 ? '…' : '')) : null,
                detail: (dk && foundP !== wantP) ? 'A DKIM record is published but its key does NOT match the one WordJS generated — re-copy the current DKIM value above.' : undefined
            };
        } else {
            results.dkim = { status: 'nokey', found: null, detail: 'Generate a DKIM key first, then publish and re-check.' };
        }

        // PTR (reverse DNS) is set with the IP/hosting provider, not the domain's zone — not checkable here.

        // Persist the GENERIC `mail_delivery_ready` flag that core's password-recovery feature
        // ("olvidé mi contraseña") gates on — it is NOT a mail-server-specific option; any mail plugin
        // sets it to '1' when it is configured to deliver externally. For this self-hosted MTA that means
        // all deliverability records resolve (MX/A/SPF/DKIM/DMARC). Reflects the LAST real check;
        // re-checking after fixing a record clears/sets it accordingly.
        try {
            const allOk = ['mx', 'a', 'spf', 'dmarc', 'dkim'].every(k => results[k] && results[k].status === 'ok');
            await updateOption('mail_delivery_ready', allOk ? '1' : '0');
        } catch (e) { /* best-effort — never fail the check because the flag couldn't be saved */ }

        res.json({ domain, checkedAt: new Date().toISOString(), results });
    });

    // POST /api/v1/plugin/mail-server/security/dkim/generate — create a DKIM keypair + return DNS records
    route('post', '/security/dkim/generate', { auth: true, admin: true }, async (req, res) => {
        try {
            const selector = String((req.body && req.body.selector) || 'default').replace(/[^a-z0-9_-]/gi, '') || 'default';
            let domain = (req.body && req.body.domain) || '';
            if (!domain) { try { domain = await getSiteDomain(); } catch (e) { } }
            if (!domain) return res.status(400).json({ error: 'A sending domain is required' });

            // F8: don't silently overwrite an existing DKIM key — rotating it breaks signing for all
            // already-published DNS records until the operator re-publishes. Require an explicit force.
            const existing = await getOption('mail_security_dkim_private_key', '');
            if (existing && !(req.body && req.body.force === true)) {
                return res.status(409).json({
                    error: 'A DKIM key already exists. Rotating it invalidates your published DNS record until you re-publish. Resend with { "force": true } to rotate.'
                });
            }

            const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
            });
            await updateOption('mail_security_dkim_private_key', privateKey);
            await updateOption('mail_security_dkim_domain', domain);
            await updateOption('mail_security_dkim_selector', selector);

            res.json({ success: true, domain, selector, records: buildDnsRecords(domain, selector, publicKey) });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v1/plugin/mail-server/attachments/:fileId
    route('get', '/attachments/:fileId', { auth: true }, async (req, res) => {
        const fileId = req.params.fileId;

        try {
            const attachment = await Email.getAttachmentById(fileId);

            if (!attachment) return res.status(404).json({ error: 'File not found' });

            const email = await Email.findById(attachment.email_id);
            if (!email) return res.status(404).json({ error: 'Reference email not found' });

            // Security: a CC/BCC recipient (not just a To recipient) of the parent email may fetch its
            // attachments; whole-string equality on to_address leaked across recipients. Use membership.
            if (!canAccessEmail(email, req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const filePath = path.join(UPLOAD_DIR, attachment.storage_path);

            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file missing' });

            // Stream the file back through the bridge response (res.download is not available in the
            // isolate's mock res; send the buffer with a download disposition header instead).
            const buf = fs.readFileSync(filePath);
            // SECURITY (header injection / disposition spoof): attachment.filename is attacker-controlled
            // (inbound mail / upload originalname). Strip quotes + CR/LF for the ASCII quoted-string
            // fallback, and provide the real name via RFC 5987 filename*= (percent-encoded).
            const rawName = String(attachment.filename || 'download');
            const asciiName = rawName.replace(/[\r\n"]/g, '_');
            const encodedName = encodeURIComponent(rawName);
            res.set({
                'Content-Type': attachment.content_type || 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
            }).send(buf);

        } catch (e) {
            console.error("Download failed:", e);
            res.status(500).json({ error: 'Download failed' });
        }
    });

    // POST /api/v1/plugin/mail-server/upload/attachment
    // Host parses the multipart upload (multer) and forwards req.file metadata to this handler.
    route('post', '/upload/attachment', { auth: true, multipart: 'file' }, (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        res.json({
            success: true,
            file: {
                filename: req.file.originalname,
                path: req.file.path,
                contentType: req.file.mimetype,
                size: req.file.size
            }
        });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/read — explicit read/unread toggle (Gmail parity).
    route('put', '/emails/:id/read', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (!Email.canUserAccess(email, req.user.userEmail)) return res.status(403).json({ error: 'Forbidden' });

        await Email.setRead(req.params.id, !!req.body.read);
        res.json({ success: true });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/spam — mark/unmark spam AND teach the Bayes filter.
    route('put', '/emails/:id/spam', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (!canAccessEmail(email, req.user)) return res.status(403).json({ error: 'Forbidden' });

        const state = !!req.body.spam;
        await Email.setSpam(req.params.id, state);
        try {
            await classifier.learn((email.subject || '') + ' ' + (email.body_text || ''), state ? 'spam' : 'ham');
            await saveBayes();
        } catch (e) { /* training is best-effort */ }
        res.json({ success: true });
    });

    // POST /api/v1/plugin/mail-server/emails/bulk — one round-trip for multi-select actions.
    // Ownership is enforced per-row: ids the caller can't access are silently dropped, never touched.
    route('post', '/emails/bulk', { auth: true }, async (req, res) => {
        try {
            const action = String((req.body && req.body.action) || '');
            const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 200) : [];
            const ACTIONS = ['read', 'unread', 'star', 'unstar', 'archive', 'unarchive', 'trash', 'restore', 'spam', 'notspam', 'label', 'unlabel', 'delete'];
            if (!ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });
            if (ids.length === 0) return res.status(400).json({ error: 'No messages selected' });

            const rows = await Email.findByIds(ids);
            const mine = rows.filter(r => r.user_id === req.user.id || canAccessEmail(r, req.user));
            const okIds = mine.map(r => r.id);
            if (okIds.length === 0) return res.status(403).json({ error: 'No accessible messages in selection' });

            if (action === 'label' || action === 'unlabel') {
                const label = await Email.findLabel(parseInt(req.body.labelId, 10) || 0, req.user.id);
                if (!label) return res.status(404).json({ error: 'Label not found' });
                if (action === 'label') await Email.addLabelToEmails(okIds, label.id);
                else await Email.removeLabelFromEmails(okIds, label.id);
            } else if (action === 'delete') {
                // Permanent delete only for rows already in trash (mirrors the single-message rule).
                await Email.deleteManyPermanently(mine.filter(r => r.is_trash === 1).map(r => r.id));
            } else if (action === 'spam' || action === 'notspam') {
                await Email.bulkSetFlags(okIds, { isSpam: action === 'spam' ? 1 : 0, isArchived: 0 });
                // Teach the Bayes filter from a bounded sample (rows already carry full bodies here).
                let trained = 0;
                for (const r of mine) {
                    if (trained >= 25) break;
                    try {
                        await classifier.learn((r.subject || '') + ' ' + (r.body_text || ''), action === 'spam' ? 'spam' : 'ham');
                        trained++;
                    } catch (e) { /* keep going */ }
                }
                if (trained > 0) await saveBayes();
            } else {
                const map = {
                    read: { isRead: 1 }, unread: { isRead: 0 },
                    star: { isStarred: 1 }, unstar: { isStarred: 0 },
                    archive: { isArchived: 1 }, unarchive: { isArchived: 0 },
                    trash: { isTrash: 1 }, restore: { isTrash: 0 }
                };
                await Email.bulkSetFlags(okIds, map[action]);
            }
            res.json({ success: true, updated: okIds.length });
        } catch (error) {
            console.error('Bulk action failed:', error);
            res.status(500).json({ error: 'Bulk action failed' });
        }
    });

    // === Labels (Gmail-style, per user) =====================================================
    route('get', '/labels', { auth: true }, async (req, res) => {
        try {
            res.json({ labels: await Email.listLabels(req.user.id) });
        } catch (e) {
            res.status(500).json({ error: 'Failed to list labels' });
        }
    });

    const LABEL_COLOR_RE = /^#[0-9a-f]{6}$/i;
    route('post', '/labels', { auth: true }, async (req, res) => {
        try {
            const name = String((req.body && req.body.name) || '').trim();
            if (!name) return res.status(400).json({ error: 'Label name is required' });
            if (name.length > 40) return res.status(400).json({ error: 'Label name too long (max 40 characters)' });
            const color = String((req.body && req.body.color) || '#7c3aed');
            if (!LABEL_COLOR_RE.test(color)) return res.status(400).json({ error: 'Invalid color (use #rrggbb)' });
            const existing = await Email.listLabels(req.user.id);
            if (existing.length >= 50) return res.status(400).json({ error: 'Too many labels (max 50)' });
            const label = await Email.createLabel(req.user.id, name, color);
            res.json({ success: true, label });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Failed to create label' });
        }
    });

    route('put', '/labels/:id', { auth: true }, async (req, res) => {
        try {
            const patch = {};
            if (req.body.name !== undefined) {
                const name = String(req.body.name).trim();
                if (!name || name.length > 40) return res.status(400).json({ error: 'Invalid label name' });
                patch.name = name;
            }
            if (req.body.color !== undefined) {
                if (!LABEL_COLOR_RE.test(String(req.body.color))) return res.status(400).json({ error: 'Invalid color (use #rrggbb)' });
                patch.color = String(req.body.color);
            }
            const label = await Email.updateLabel(req.params.id, req.user.id, patch);
            if (!label) return res.status(404).json({ error: 'Label not found' });
            res.json({ success: true, label });
        } catch (e) {
            res.status(500).json({ error: 'Failed to update label' });
        }
    });

    route('delete', '/labels/:id', { auth: true }, async (req, res) => {
        const ok = await Email.deleteLabel(req.params.id, req.user.id);
        if (!ok) return res.status(404).json({ error: 'Label not found' });
        res.json({ success: true });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/labels — apply/remove labels on one message.
    route('put', '/emails/:id/labels', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (!canAccessEmail(email, req.user)) return res.status(403).json({ error: 'Forbidden' });

        const add = Array.isArray(req.body && req.body.add) ? req.body.add : [];
        const remove = Array.isArray(req.body && req.body.remove) ? req.body.remove : [];
        for (const lid of add.slice(0, 20)) {
            const label = await Email.findLabel(lid, req.user.id); // only YOUR labels apply
            if (label) await Email.addLabelToEmails([email.id], label.id);
        }
        for (const lid of remove.slice(0, 20)) {
            const label = await Email.findLabel(lid, req.user.id);
            if (label) await Email.removeLabelFromEmails([email.id], label.id);
        }
        const labels = await Email.getLabelsForEmails([email.id]);
        res.json({ success: true, labels: labels[email.id] || [] });
    });

    // === Per-user preferences: signature + vacation auto-responder ==========================
    route('get', '/prefs', { auth: true }, async (req, res) => {
        try {
            const prefs = await Email.getPrefs(req.user.id);
            const v = (prefs.vacation && typeof prefs.vacation === 'object') ? prefs.vacation : {};
            res.json({
                signature: typeof prefs.signature === 'string' ? prefs.signature : '',
                vacation: {
                    enabled: !!v.enabled,
                    subject: v.subject || '',
                    message: v.message || '',
                    startsAt: v.startsAt || '',
                    endsAt: v.endsAt || ''
                }
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to load preferences' });
        }
    });

    route('put', '/prefs', { auth: true }, async (req, res) => {
        try {
            const cur = await Email.getPrefs(req.user.id);
            const next = { ...cur };
            if (req.body.signature !== undefined) next.signature = String(req.body.signature).slice(0, 5000);
            if (req.body.vacation !== undefined) {
                const v = req.body.vacation || {};
                const isoOrEmpty = (x) => {
                    if (!x) return '';
                    const t = Date.parse(x);
                    return Number.isFinite(t) ? new Date(t).toISOString() : '';
                };
                next.vacation = {
                    enabled: !!v.enabled,
                    subject: String(v.subject || '').slice(0, 180),
                    message: String(v.message || '').slice(0, 5000),
                    startsAt: isoOrEmpty(v.startsAt),
                    endsAt: isoOrEmpty(v.endsAt)
                };
            }
            await Email.setPrefs(req.user.id, next);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Failed to save preferences' });
        }
    });

    // GET /api/v1/plugin/mail-server/contacts/suggest — recipient autocomplete that merges the site
    // user directory with the user's OWN correspondence history (people they actually mail).
    route('get', '/contacts/suggest', { auth: true }, async (req, res) => {
        const query = String(req.query.q || '').trim();
        if (query.length < 2) return res.json([]);
        try {
            const siteDomain = await getSiteDomain();
            const [users, history] = await Promise.all([
                User.findAll({ search: query, limit: 5 }).catch(() => []),
                Email.suggestContacts(req.user.id, query, 8).catch(() => [])
            ]);
            const out = new Map();
            for (const u of (users || [])) {
                if (!u || !u.userLogin) continue;
                const addr = `${String(u.userLogin).toLowerCase()}@${siteDomain}`;
                if (!out.has(addr)) out.set(addr, { email: addr, name: u.displayName || u.userLogin, source: 'user' });
            }
            for (const c of history) {
                if (!out.has(c.email)) out.set(c.email, { email: c.email, name: c.name || '', source: 'history' });
            }
            res.json([...out.values()].slice(0, 8));
        } catch (e) {
            res.json([]);
        }
    });

    // Register Admin Menu
    wordjs.adminMenu.add({
        href: '/admin/plugin/emails',
        label: 'Email Center',
        icon: 'fa-envelope',
        order: 90,
        cap: 'access_admin_panel',
        // Only a user whose account email is on the site domain has a WordJS inbox here; core hides this
        // per-user webmail from everyone else via the generic requiresProfessionalMailbox flag.
        requiresProfessionalMailbox: true
    });

    // Expose sendMail utility for other plugins (host installs a shim for wordjs.mail / global.wordjs_send_mail).
    wordjs.provideMail(sendMail);

    // Register as a Notification Transport
    wordjs.notify.registerTransport('email', async (notification) => {
        let targetEmail = null;
        if (notification.user_id !== 0) {
            const user = await User.findById(notification.user_id);
            if (user) targetEmail = user.userEmail;
        }

        if (targetEmail) {
            try {
                await sendMail({
                    to: targetEmail,
                    subject: notification.title,
                    text: notification.message,
                    html: `<p>${notification.message}</p>`
                });
            } catch (e) {
                console.error('❌ Mail Server Transport Failed:', e.message);
            }
        }
    });
};

exports.deactivate = function () {
    try { if (smtpServer) smtpServer.close(); } catch (e) { /* ignore */ }
    if (queueInterval) { clearInterval(queueInterval); queueInterval = null; }
    console.log('Mail Server plugin deactivated');
};
