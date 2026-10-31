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
// NOTE: `spf-validator` is deliberately NOT required — it resolves DNS with the raw c-ares API, which
// the sandbox denies, so it threw on every inbound message. evaluateSPF() parses the record itself.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
// Write-side XSS control: inbound mail HTML is hostile by definition (any sender; catch-all reaches
// the admin mailbox). Sanitize to a strict allowlist BEFORE persisting on ingest (onData) so stored
// body_html is never a script-carrying string — the durable control for everything that later reads
// it, including the admin Reply/Forward re-quote. See lib/sanitize-email-html.js for the allowlist
// and why it is safe. (The admin compose sink is separately guarded client-side with DOMPurify.)
const { sanitizeEmailHtml } = require('./lib/sanitize-email-html');
// The store FACTORY, required here (not only where the store is constructed) so splitAddresses below
// can BE the store's address parser instead of a second one. Two parsers for "which addresses are on
// this row" is two ownership verdicts: this file split on [,;] while the predicate split on ',' alone.
const createEmailStore = require('./lib/email-store');
// Server administration (aliases, quotas, usage, stats, queue) and the per-user filing rules. Both are
// kept out of email-store.js, which stays the ownership boundary of user mail.
const createAdminStore = require('./lib/mail-admin-store');
const { createSendRate, parsePerMinute } = require('./lib/send-rate');
const MailRules = require('./lib/mail-rules');
// Inbound DKIM signature verification and DMARC evaluation (node:crypto + the host DNS bridge).
const MailAuth = require('./lib/mail-auth');

// Attachment storage lives in the plugin's OWN dir (untrusted plugins can't write shared uploads).
// The single source of truth is Email.UPLOAD_DIR (set in email-store); mirror it here for path joins.
const UPLOAD_DIR = path.join(__dirname, 'data/attachments');

// Best-effort HTML -> plaintext for the text/plain MIME alternative and list previews. A single-pass
// tag strip (/<[^>]*>/g) is an INCOMPLETE sanitizer: removing a complete tag can splice two fragments
// into a NEW tag (e.g. "<<script>script>" -> "<script>"), so one pass can leave a live tag behind
// (CodeQL js/incomplete-multi-character-sanitization). Repeat to a fixpoint, then drop any residual
// angle brackets left by unterminated tags. Text nodes / whitespace / newlines are preserved.
// HTML → the text/plain body (stored body_text, list snippets, the outgoing text part). Line breaks
// survive as newlines, and character references are decoded AFTER the tags are gone: the result is
// plain text, so "R&amp;D" must read "R&D" (it used to travel and show as "R&amp;D"), and a decoded
// '<' can no longer start a tag because nothing parses this as HTML again.
function stripHtml(s) {
    let out = String(s == null ? '' : s)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n');
    for (let prev = null; prev !== out; ) { prev = out; out = out.replace(/<[^>]*>/g, ''); }
    return out.replace(/[<>]/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
        .replace(/&#(\d{1,7});/g, (m, d) => { const n = Number(d); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; })
        .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; })
        .replace(/&amp;/gi, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

exports.metadata = {
    name: 'Mail Server',
    version: '3.3.9',
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

// DNSBL over the host's TXT lookup. A blocklist answers a listed IP with BOTH an A record in 127/8
// and a TXT record explaining the listing; unlisted IPs are NXDOMAIN. The host bridge strips loopback
// A answers (by design — it never hands a plugin an internal address), so the A form can never say
// "listed" here; the TXT form can, and goes through the same governed resolver. Returns true (listed),
// false (not listed) or null (no verdict: IPv6, a resolver error, or the list REFUSING the query —
// Spamhaus answers queries from public/open resolvers with an error record, not a listing).
const DNSBL_ZONE = 'zen.spamhaus.org';
async function dnsblListed(ip, zone = DNSBL_ZONE) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
    if (!m || m.slice(1).some(o => Number(o) > 255)) return null;
    let records;
    try {
        records = await dns.resolveTxt(`${m[4]}.${m[3]}.${m[2]}.${m[1]}.${zone}`);
    } catch (e) {
        return /ENOTFOUND|ENODATA|NXDOMAIN/i.test(`${e && e.code} ${e && e.message}`) ? false : null;
    }
    const text = (records || []).map(r => (Array.isArray(r) ? r.join('') : String(r))).join(' ');
    if (!text) return false;
    if (/open resolver|public resolver|returnc|query refused|error/i.test(text)) return null;
    return true;
}

// === Bridge-backed module state (set in init) ===
let wordjs = null;        // the injected capability bridge
let Email = null;         // plugin-local email store backed by wordjs.db
let queueTickRunning = false; // see the queue interval below
let Admin = null;         // aliases / quotas / stats / queue (lib/mail-admin-store)
let SendRate = null;      // the general queue's messages-per-minute cap (lib/send-rate)
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
// wordjs.users.* returns a PROJECTION
// {id,userLogin,username,userEmail,displayName,role,pluginCapabilities,accountCapabilities} — never
// user_pass. The
// field names already match what the rest of this file expects (mapUser-compatible), so no
// normalization is needed here. The host writes the underlying query (core User model).
// `accountCapabilities` carries the ADMIN-OWNED corporate-mailbox grant — see hasCorporateMailbox below;
// it is the host's fact, not something this plugin may derive.
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

/**
 * === THE MAIL DOMAIN — THE ONE EXPRESSION (SSOT) ==============================================
 *
 * The domain this server is AUTHORITATIVE FOR: the one it announces, signs and sends as, the one the
 * DNS-records page tells the operator to publish SPF/DKIM/DMARC/MX on, and therefore the one whose
 * local parts are corporate mailboxes.
 *
 * It is `mail_security_dkim_domain` when set, else the site hostname — NOT the site hostname alone.
 * That override exists precisely for the `www.` case (see the long note at the From-rewrite below): an
 * install at https://www.acme.com that publishes its mail records on acme.com sets it, and from then
 * on every place that has to name "our mail domain" must move together. Four sites used to spell this
 * expression out by hand (HELO host, DNS-records page, DNS-check page, From-alignment) and a fifth —
 * the inbound/local-delivery test — used the bare site hostname, so on exactly that install the server
 * signed and sent as acme.com while refusing to deliver anything addressed to it.
 */
function resolveMailDomain(dkimDomain, siteDomain) {
    const explicit = String(dkimDomain == null ? '' : dkimDomain).trim().toLowerCase().replace(/\.$/, '');
    if (explicit) return explicit;
    return String(siteDomain == null ? '' : siteDomain).trim().toLowerCase();
}
/**
 * The last value mirrored to the host, so the steady state costs no writes. Module-scoped: a fresh worker
 * starts as null and re-mirrors once, which is exactly the backfill an existing install needs.
 */
let lastMirroredMailDomain = null;

/**
 * PUBLISH the resolved domain to the host as the plain `mail_domain` option.
 *
 * The host has to know this domain too — it reserves those local parts so an unprivileged account cannot
 * claim <someone>@<mailDomain> (core/email-address.ts). It CANNOT read our source of truth: the host tried
 * `getOption('mail_security_dkim_domain')` against the core options table, where that key never appears in
 * production. `mail_security_dkim_domain` matches this plugin's SECRET_OPTION_RE and the host's
 * PROTECTED_OPTION_RE (both on /dkim/), so every writer routes it into wjp_mail_server_secrets instead —
 * the host read silently returned '' and, on a `www.` install, the reservation protected the wrong name.
 *
 * So the plugin mirrors the RESOLVED answer into a non-secret key the host can actually read. Fire and
 * forget: a failed mirror must never break sending, and the next call re-attempts it.
 */
function mirrorMailDomain(domain) {
    const d = String(domain || '').trim().toLowerCase();
    if (!d || d === lastMirroredMailDomain) return;
    lastMirroredMailDomain = d;
    Promise.resolve(updateOption('mail_domain', d)).catch((e) => {
        lastMirroredMailDomain = null; // let the next resolve retry
        console.warn(`[MailServer] could not publish mail_domain to the host: ${e && e.message}`);
    });
}

async function getMailDomain() {
    // Split from resolveMailDomain so sendMail — which already fetches both inputs in its one parallel
    // RPC wave — can apply the SAME expression without paying two more round-trips per message.
    const [dkimDomain, siteDomain] = await Promise.all([
        getOption('mail_security_dkim_domain', ''),
        getSiteDomain()
    ]);
    const resolved = resolveMailDomain(dkimDomain, siteDomain);
    // Every path that can CHANGE the answer (boot, settings save, DKIM generate) comes back through here,
    // so one hook keeps the host's copy current without a write per call.
    mirrorMailDomain(resolved);
    return resolved;
}

/**
 * === ACTIVE CORPORATE MAILBOX — THE ONE DEFINITION (SSOT) ======================================
 *
 * A user has an ACTIVE CORPORATE (professional) MAILBOX when an ADMINISTRATOR HAS ENABLED ONE for
 * them — the "Professional mail account" toggle on the user form. This plugin DECLARES that toggle as
 * the account capability `mail_server_mailbox` (manifest.json `accountCapabilities`); the host renders
 * it, lets only an `edit_users` administrator change it, stores it, and hands it to this plugin in
 * `user.accountCapabilities` (backend/src/core/account-capabilities.ts). The host knows nothing about
 * what it means — this plugin is the only place that does.
 *
 * IT IS NOT DERIVED FROM THE ACCOUNT'S EMAIL ADDRESS ANY MORE, and that is the whole point. The old
 * rule — "their own account email is on the site domain" — read a field the account itself writes:
 * PUT /users/me is guarded by `authenticate` alone, so any subscriber could set their address to
 * me@<mailDomain> and self-issue the entire mail surface (sending DKIM-signed mail as the site), and
 * with `users_can_register` on, POST /auth/register let an ANONYMOUS attacker do the same. The host
 * now also refuses those two writes (core/email-address refuseSelfServiceEmailChange: the published
 * `mail_domain` is reserved, and the declaration's `locksEmail` stops a mailbox holder moving the
 * address), so the address can no longer be claimed either — but the GATE does not depend on it at all.
 *
 * Reading the FLAG (not the address) is also what makes the gate immune to a mail-domain change: an
 * operator setting `mail_security_dkim_domain` cannot 403 every non-admin out of the whole webmail.
 *
 * The HOST reads the SAME fact for admin-menu visibility (backend/src/routes/plugins.ts, via the
 * generic `requiresAccountCapability` item field, admins always kept), so a menu entry can never appear
 * for a user whose page only 403s.
 *
 * NOT cached, deliberately: `user` is the host's per-request projection, rebuilt from the DB by
 * middleware/auth.ts on EVERY request, so an admin flipping the mailbox toggle off denies the very
 * next request instead of a stale grant living on in this process.
 */
const MAILBOX_CAPABILITY = 'mail_server_mailbox';
function hasCorporateMailbox(user) {
    // Fail closed on a missing/older projection.
    return !!(user && Array.isArray(user.accountCapabilities) && user.accountCapabilities.includes(MAILBOX_CAPABILITY));
}

/**
 * The domain part of an address, by the SAME rule the host applies (backend/src/core/email-address.ts:
 * `domainOfAddress`): an address is exactly one '@' with a non-empty local part and a dotted domain,
 * and anything else has NO domain. `a@gmail.com@acme.example` is therefore not an address at all —
 * previously this file took the text after the LAST '@' and the host took the text after the FIRST, so
 * the two disagreed about who that user was. The two copies exist only because this plugin runs in a
 * sandboxed child process and cannot require host modules; the gate suite asserts they agree on a
 * shared adversarial table so they cannot drift.
 */
const MAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function mailboxDomainOf(email) {
    const s = String(email == null ? '' : email).trim().normalize('NFC').toLowerCase();
    if (!MAIL_ADDRESS_RE.test(s)) return '';
    return s.slice(s.indexOf('@') + 1); // exactly one '@' — indexOf === lastIndexOf
}

/**
 * THE SITE'S SENDER — the From of every message that is not a user's (core notices, other plugins'
 * mail through the provider, the delivery test, bounces).
 *
 * It is the configured "From email" when that address is ON the mail domain, else
 * noreply@<mail domain>. It is NEVER the administrator's account email: that address is personal (often
 * @gmail.com), it may only RECEIVE account mail, and sending as it both leaks it to every recipient and
 * fails SPF/DMARC everywhere. (Up to 3.1.1 an empty "From email" fell back to admin_email.)
 */
function siteSenderAddress(configuredFrom, mailDomain) {
    const domain = String(mailDomain == null ? '' : mailDomain).trim().toLowerCase();
    const configured = String(configuredFrom == null ? '' : configuredFrom).trim().toLowerCase();
    if (configured && domain && mailboxDomainOf(configured) === domain) return configured;
    if (!domain) return 'noreply@localhost';
    return net.isIP(domain) ? `noreply@[${domain}]` : `noreply@${domain}`;
}

/**
 * The address a user actually RECEIVES at, or '' when they receive nowhere here.
 *
 * Delivery needs BOTH halves: the admin-owned grant AND an account address that really is on the mail
 * domain. The grant alone would make a flagged user whose address is personal the delivery target for
 * `<their login>@<mailDomain>`; the address alone is what let an attacker claim an unused corporate
 * address and have its mail land in their inbox. Used by inbound onData and sendMail's internal
 * delivery branch — never by the route gate, which is the grant alone (see hasCorporateMailbox).
 */
function mailboxAddressOf(user, mailDomain) {
    if (!hasCorporateMailbox(user)) return '';
    const domain = String(mailDomain == null ? '' : mailDomain).trim().toLowerCase();
    if (!domain) return ''; // unknown mail domain -> fail closed
    const addr = String(user.userEmail == null ? '' : user.userEmail).trim().normalize('NFC').toLowerCase();
    return mailboxDomainOf(addr) === domain ? addr : '';
}

/**
 * Is `domain` a real, publicly-resolvable mail domain we could plausibly be authenticated FOR?
 *
 * getSiteDomain() is just `new URL(siteurl).hostname` (backend/src/core/plugin-api.ts) with a
 * 'localhost' fallback — so on a LAN/homelab/Proxmox install it is routinely an IP literal
 * ('192.168.1.50'), 'localhost', or a bare single-label hostname. None of those can ever host a
 * mailbox, an SPF record or a DKIM key, so rewriting an outgoing From onto them produces an address
 * that is strictly WORSE than the original (postmaster@192.168.1.50 is rejected by every receiver).
 */
function isPublicSendingDomain(domain) {
    let d = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
    if (!d) return false;
    if (d.startsWith('[') && d.endsWith(']')) d = d.slice(1, -1); // URL.hostname brackets IPv6 literals
    if (net.isIP(d)) return false;                                 // IP literal — never a mail domain
    if (!d.includes('.')) return false;                            // bare hostname ('localhost', 'mail')
    if (/(^|\.)(localhost|local|localdomain|internal|home|lan|invalid|test|example)$/.test(d)) return false;
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
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
    return createEmailStore.splitAddressList(value);
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
        // NOT-A-DELIVERY-PATH: resolves the SITE ADMINISTRATOR, not an inbound recipient. The result
        // owns catch-all mail that matched no mailbox; it never turns a recipient address into an inbox.
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
//
// An auto-reply is mail WE originate to an address the inbound message merely CLAIMS, so without
// sender authentication it is a reflector: forge the From of a victim, hit a vacationing mailbox, and
// our MTA (with our DKIM/SPF reputation) mails the victim. Two bounds close that:
//   1. vacationSenderVerified(): inbound mail only gets a reply when the transaction's SPF verdict is
//      'pass' AND the envelope MAIL FROM domain (what SPF authenticated) is the header From domain the
//      reply goes to. Anything else — neutral/none/softfail/permerror, SPF disabled, a null sender,
//      or a From that SPF never vouched for — gets no reply (conservative by design).
//   2. A per-mailbox cap on DISTINCT recipients per 24 h window (the per-sender 24 h dedupe above
//      makes every reply a distinct recipient), so even authenticated senders cannot turn one
//      mailbox into a bulk mailer.
const VACATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const VACATION_MAX_RECIPIENTS = 50;
const _vacationSent = new Map(); // `${userId}:${senderLower}` -> last reply ts
const _vacationQuota = new Map(); // userId -> { count, first }
function _vacationKeySweep() {
    const cutoff = Date.now() - VACATION_WINDOW_MS;
    for (const [k, ts] of _vacationSent) {
        if (ts < cutoff) _vacationSent.delete(k);
    }
    for (const [k, q] of _vacationQuota) {
        if (q.first < cutoff) _vacationQuota.delete(k);
    }
    // Hard cap so a sender-address flood can't grow the map unbounded between sweeps. The
    // per-mailbox quota (kept separately) still bounds replies after a clear.
    if (_vacationSent.size > 5000) _vacationSent.clear();
}

/** Take one auto-reply slot for this mailbox in the current window; false when exhausted. */
function _vacationQuotaTake(userId, now) {
    const q = _vacationQuota.get(userId);
    if (!q || now - q.first >= VACATION_WINDOW_MS) {
        _vacationQuota.set(userId, { count: 1, first: now });
        return true;
    }
    if (q.count >= VACATION_MAX_RECIPIENTS) return false;
    q.count += 1;
    return true;
}

/**
 * True only when the inbound transaction authenticated the address a vacation reply would go to:
 * the Received-SPF verdict recorded by onMailFrom is 'pass' and the envelope MAIL FROM domain equals
 * the header From domain.
 */
function vacationSenderVerified(spfHeader, envelopeFrom, headerFrom) {
    const m = String(spfHeader || '').match(/^Received-SPF: ([a-z]+) /);
    if (!m || m[1] !== 'pass') return false;
    const domainOf = (a) => {
        const s = String(a || '').trim().toLowerCase();
        const at = s.lastIndexOf('@');
        return at > 0 ? s.slice(at + 1) : '';
    };
    const envDomain = domainOf(envelopeFrom);
    return !!envDomain && envDomain === domainOf(headerFrom);
}

/**
 * May an EXTERNAL SMTP session deliver a message that claims to come from our own mail domain?
 * Only when SPF authenticated the transaction for that same domain (the envelope MAIL FROM is on it,
 * the verdict is 'pass', and the header From domain matches — vacationSenderVerified). Anything else
 * presenting `someone@<mailDomain>` from outside is a forgery of a local mailbox: a colleague, the
 * administrator. Returns null to accept, or the address the refusal names. The header From and the
 * envelope MAIL FROM are both checked, because either one is what a reader or a reply would trust.
 */
function localDomainImpersonation(mailDomain, spfHeader, envelopeFrom, headerFroms, dkimPassDomains = []) {
    const dom = String(mailDomain || '').toLowerCase();
    if (!dom) return null;
    const domainOf = (a) => {
        const s = String(a || '').trim().toLowerCase();
        const at = s.lastIndexOf('@');
        return at > 0 ? s.slice(at + 1) : '';
    };
    const isLocal = (a) => { const d = domainOf(a); return !!d && (d === dom || d.endsWith('.' + dom)); };
    const claims = [envelopeFrom, ...(headerFroms || [])].filter(isLocal);
    if (claims.length === 0) return null;
    // A valid DKIM signature of the claimed domain (d= the domain or a parent of it) authenticates it too.
    const signedFor = (a) => {
        const d = domainOf(a);
        return (dkimPassDomains || []).some(s => { const x = String(s || '').toLowerCase(); return !!x && (d === x || d.endsWith('.' + x)); });
    };
    for (const from of claims) {
        if (!vacationSenderVerified(spfHeader, envelopeFrom, from) && !signedFor(from)) return String(from).toLowerCase();
    }
    return null;
}

/** The whole message as a Buffer: the host hands one over, the plugin's own listener a stream. */
function readRawMessage(input) {
    if (Buffer.isBuffer(input)) return Promise.resolve(input);
    if (typeof input === 'string') return Promise.resolve(Buffer.from(input, 'utf8'));
    return new Promise((resolve, reject) => {
        const chunks = [];
        input.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        input.on('end', () => resolve(Buffer.concat(chunks)));
        input.on('error', reject);
    });
}

/**
 * DKIM + DMARC for one inbound transaction. SPF was already evaluated at MAIL FROM; its verdict is
 * read back from the Received-SPF header onMailFrom recorded. Never throws: an evaluation problem
 * yields no verdict (the message is then treated exactly as before this check existed).
 */
async function authenticateInbound(raw, session, headerFroms, receiver) {
    try {
        const m = String((session && session.spfHeader) || '').match(/^Received-SPF: ([a-z]+) /);
        return await MailAuth.authenticateMessage(raw, {
            resolveTxt: (name) => dns.resolveTxt(name),
            spfResult: m ? m[1] : '',
            envelopeFrom: (session && session.envelope && session.envelope.mailFrom && session.envelope.mailFrom.address) || '',
            fromAddresses: headerFroms,
            receiver,
        });
    } catch (e) {
        console.warn(`[Security][DKIM] evaluation error: ${e && e.message}`);
        return null;
    }
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
        if (now - last < VACATION_WINDOW_MS) return;
        if (!_vacationQuotaTake(user.id, now)) return;
        _vacationSent.set(key, now);

        const subject = String(v.subject || 'Automatic reply').slice(0, 180)
            + (origSubject ? `: ${String(origSubject).slice(0, 120)}` : '');
        const html = String(v.message).slice(0, 5000);
        await sendMail({
            to: sender,
            subject,
            text: stripHtml(html),
            html,
            identity: await sendingIdentityOf(user),
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
    const terms = [];
    const exclude = [];
    // Tokens: `key:value`, `key:"a phrase"`, `"a phrase"`, `-word`, `-"a phrase"`, plain words. A quoted
    // phrase used to be split on its space ("prueba 1" → `"prueba` + `1"`) and matched nothing.
    const re = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
    let m;
    const src = String(raw || '').trim();
    while ((m = re.exec(src)) !== null) {
        const neg = m[1] === '-';
        const key = m[2] ? m[2].toLowerCase() : '';
        const val = m[3] !== undefined ? m[3] : m[4];
        if (!val) continue;
        if (key && !neg) {
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
        const text = key ? `${key}:${val}` : val;
        (neg ? exclude : terms).push(text);
    }
    if (terms.length) { q.terms = terms; q.text = terms.join(' '); }
    if (exclude.length) q.exclude = exclude;
    return q;
}

/**
 * The relay/smarthost, when one is configured. A configured relay is the ONLY outbound path: when it is
 * unreachable, external mail waits in the retry queue and the console says why ("Relay unavailable:
 * <reason>") — it never falls back to direct-to-MX delivery behind the operator's back. (A host that
 * blocks outbound port 25 is the usual reason a relay is configured at all, so a silent fallback would
 * only trade a clear error for a queue of mail that cannot leave.)
 *
 * The relay host is resolved HERE (dns.lookup, the one resolver the sandbox leaves plugins) and nodemailer
 * is handed the address, with the configured name kept for TLS SNI and certificate checks: nodemailer's own
 * resolver (dns.Resolver) is denied inside the sandbox, so handing it a NAME could never connect.
 *
 * A relay on a PRIVATE address (a LAN smarthost) is reachable only once an administrator approves that
 * exact host:port for this plugin (the Configuration tab → Sandbox access → "Allow <host>:<port>", which calls
 * the host's POST /plugins/mail-server/private-egress). Without that, the sandbox refuses the connection
 * and relayStatus says so.
 */
let relayStatus = { configured: false, ok: false, host: '', port: null, error: null, sandboxBlocked: false, checkedAt: null };
let relayRetryAt = 0;
const RELAY_RECHECK_MS = 60 * 1000;

function relayErrorText(e, host, port) {
    const msg = String((e && e.message) || e || 'unknown error');
    if (/network egress to .* is blocked/i.test(msg)) {
        // Name what the sandbox actually refused: when the approval is already in place, a bare
        // "approve <host>:<port>" sent the operator in circles and hid the real destination.
        const m = /network egress to (\S+?)(?::(\d+))? is blocked/i.exec(msg);
        const blocked = m ? `${m[1]}${m[2] ? ':' + m[2] : ''}` : `${host}:${port}`;
        return `the WordJS plugin sandbox refused the connection to ${blocked} (a private address) — approve ${host}:${port} under "Sandbox access" in the Configuration tab; if it is already approved, restart the plugin from Plugins → Mail Server (sandbox: ${msg.slice(0, 200)})`;
    }
    if (/network' is blocked|grant Network access|\[sandbox\] .*(net|tls).*blocked/i.test(msg)) {
        return 'this plugin does not hold the Network permission (Plugins → Mail Server → Permissions)';
    }
    // The kernel sandbox lets this plugin connect only to the SMTP ports its manifest declares (and to the
    // port of an approved private destination): another relay port is refused before any packet leaves.
    if (e && (e.code === 'EACCES' || e.code === 'EPERM') && ![25, 465, 587, 2525].includes(Number(port))) {
        return `the WordJS plugin sandbox only lets this plugin connect to the SMTP ports 25, 465, 587 and 2525, and the relay is on port ${port}: use one of those ports for the relay (or, for a relay on your own network, approve ${host}:${port} under "Sandbox access" in the Configuration tab)`;
    }
    return msg;
}

// The stored relay settings, as one string. The transport (and relayStatus) are per process; the settings
// are shared. A queue pass running in a process that did not handle the settings save kept delivering — or
// refusing — through the relay it had built earlier: after the relay was removed, queued mail kept failing
// with "Relay unavailable" for minutes (X4-15). readyRelay() rebuilds when this changes.
async function relaySettingsFingerprint() {
    const parts = await Promise.all([
        getOption('mail_server', ''), getOption('mail_port', '587'), getOption('mail_secure', '0'),
        getOption('mail_user', ''), getOption('mail_pass', ''), getOption('mail_relay_require_tls', '1'),
    ]);
    return crypto.createHash('sha256').update(parts.map((v) => String(v == null ? '' : v).trim()).join(String.fromCharCode(0))).digest('hex');
}
let relayBuiltFrom = null;

async function initTransporter() {
    relayBuiltFrom = await relaySettingsFingerprint();
    const host = String(await getOption('mail_server', '') || '').trim();
    const port = parseInt(await getOption('mail_port', '587'), 10) || 587;
    const user = await getOption('mail_user', '');
    const pass = await getOption('mail_pass', '');
    const secureRaw = await getOption('mail_secure', '0');
    const secure = secureRaw === '1';

    transporter = null;
    const wasRelayed = relayStatus.configured;
    if (!host) {
        relayStatus = { configured: false, ok: false, host: '', port: null, error: null, sandboxBlocked: false, checkedAt: null };
        // The relay was what made mail deliverable; without it, readiness is the DNS check's to establish.
        if (wasRelayed) await setDeliveryReady(false);
        return;
    }
    relayStatus = { configured: true, ok: false, host, port, error: null, sandboxBlocked: false, checkedAt: new Date().toISOString() };
    relayRetryAt = Date.now() + RELAY_RECHECK_MS;

    // The relay/smarthost is OPERATOR-configured (admin-only setting) and may LEGITIMATELY be an INTERNAL
    // host (a LAN smarthost / corporate MTA). Unlike the attacker-controlled direct-MX recipient domain,
    // it is therefore NOT subject to this plugin's public-only SSRF pin (MAIL-RELAY-SSRF); the sandbox
    // still applies its own rule (see the comment above).
    let address = host;
    if (!net.isIP(host)) {
        try {
            address = (await require('dns').promises.lookup(host)).address;
        } catch (e) {
            relayStatus.error = `cannot resolve ${host}: ${relayErrorText(e, host, port)}`;
            console.error(`   ✗ Relay unavailable: ${relayStatus.error}`);
            return;
        }
    }
    const requireRelayTls = String(await getOption('mail_relay_require_tls', '1')) !== '0';
    const candidateOptions = {
        host: address,
        port,
        secure,
        // The configured NAME, for SNI and the certificate check (we connect to its resolved address).
        ...(address !== host ? { servername: host } : {}),
        // `port` rides in the TLS options because nodemailer's STARTTLS upgrade calls
        // tls.connect({ socket, host, ...tls }) with NO port of its own, and the sandbox approves a
        // private relay as an exact host AND port — without it a LAN smarthost that advertises STARTTLS
        // was refused at the upgrade even after "Allow <host>:<port>" (the TCP connect had passed).
        tls: { ...(address !== host ? { servername: host } : {}), port },
        // STARTTLS downgrade protection: force STARTTLS on the non-implicit-TLS path so an on-path attacker
        // can't strip it and capture the relay creds. An operator with a TLS-less INTERNAL smarthost can
        // opt out via the mail_relay_require_tls='0' setting (REG-2). secure:true (465) is implicit TLS.
        requireTLS: requireRelayTls && !secure,
        // Credentials are optional: an internal smarthost often relays for its LAN by address.
        ...(user && pass ? { auth: { user, pass } } : {}),
        connectionTimeout: 15000,
        greetingTimeout: 15000,
    };
    let candidate = nodemailer.createTransport(candidateOptions);

    try {
        try {
            await candidate.verify();
        } catch (e) {
            // With "Require STARTTLS" off (an internal relay without TLS), a relay that ADVERTISES STARTTLS
            // and then refuses it with an SMTP reply (Mailpit: "502 5.5.1 Command not implemented") gets
            // the mail in plaintext — the rule the direct-to-MX path already applies to such servers. A
            // handshake that starts and then fails is not downgraded, and with STARTTLS required nothing is.
            if (requireRelayTls || secure) throw e;
            if (/upgrading connection with STARTTLS: [45]\d\d/i.test(String(e && e.message))) {
                console.warn(`   [MailServer][TLS] relay ${host}:${port} refused STARTTLS (${e.message}) — Require STARTTLS is off, so connecting without TLS`);
                candidate = nodemailer.createTransport({ ...candidateOptions, ignoreTLS: true, requireTLS: false });
            } else if (isTlsVerifyError(e)) {
                // An internal relay whose certificate cannot be verified (self-signed — what another WordJS
                // server presents — or expired): with "Require STARTTLS" off the operator already accepted
                // plaintext to this host, so encrypting without verification is strictly better than the
                // plaintext they allowed. The same certificate-only rule as the direct-to-MX fallback.
                console.warn(`   [MailServer][TLS] relay ${host}:${port} certificate could not be verified (${e.message}) — Require STARTTLS is off, so using STARTTLS without verification`);
                candidate = nodemailer.createTransport({ ...candidateOptions, tls: { ...(candidateOptions.tls || {}), rejectUnauthorized: false } });
            } else {
                throw e;
            }
            await candidate.verify();
        }
        transporter = candidate;
        relayStatus.ok = true;
        console.log(`   ✓ Relay ${host}:${port} ready`);
    } catch (error) {
        relayStatus.error = relayErrorText(error, host, port);
        relayStatus.sandboxBlocked = /plugin sandbox refused the connection/.test(relayStatus.error);
        console.error(`   ✗ Relay unavailable: ${relayStatus.error}`);
    }
    await setDeliveryReady(relayStatus.ok);
}

/**
 * The host's `mail_delivery_ready` flag gates password recovery and e-mail verification. With a relay,
 * the relay answering IS the readiness: the smarthost owns MX/SPF/DKIM for its senders, so the DNS check
 * (which requires all five records on OUR domain) can never pass on a relay-only site and recovery stayed
 * off for good. Without a relay the DNS check sets it (see /security/dns-check).
 */
async function setDeliveryReady(ready) {
    try { await updateOption('mail_delivery_ready', ready ? '1' : '0'); } catch (e) { /* best-effort */ }
}

/** The ready relay, re-checking a configured-but-failed one at most once a minute. null = none ready. */
async function readyRelay() {
    // Settings changed in another process (or this one) since the transport was built: rebuild first, so a
    // removed relay stops holding mail back and a new one is used at once.
    try {
        if (relayBuiltFrom !== null && (await relaySettingsFingerprint()) !== relayBuiltFrom) await initTransporter();
    } catch (e) { /* relayStatus describes a failed rebuild */ }
    if (transporter) return transporter;
    if (relayStatus.configured && Date.now() >= relayRetryAt) {
        try { await initTransporter(); } catch (e) { /* relayStatus already describes it */ }
    }
    return transporter;
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
 * Classify a DNS failure surfaced by the HOST bridge as "definitive no-record" vs "temporary".
 *
 * ENODATA / ENOTFOUND / NXDOMAIN are DEFINITIVE answers: the name genuinely has no record of that
 * type, which SPF must treat as a plain non-match (or 'none' at the top level). EVERYTHING ELSE
 * (ETIMEOUT, ESERVFAIL, EREFUSED, ECONNREFUSED, a missing 'network' grant, …) means we were simply
 * UNABLE to evaluate right now — RFC 7208 §2.6.6 calls that 'temperror' and mandates a 4xx so the
 * sender retries, NOT a permanent 550.
 *
 * We must match on the error TEXT, not `err.code`: the sandbox RPC boundary marshals a rejection as
 * `String(e.message)` (backend/src/core/plugin-isolate.ts) and the worker rebuilds it with
 * `new Error(msg)` (plugin-worker.js), so every property EXCEPT the message is lost crossing the
 * isolate. node embeds the code in the message ("queryTxt ENODATA example.com"), which is why this
 * (and the pre-existing TXT check it generalizes) sniffs the string.
 */
function isDnsNoRecord(err) {
    return /ENODATA|ENOTFOUND|NXDOMAIN/i.test(String((err && err.message) || err));
}

/**
 * Resolve `host` to the addresses that could possibly match the connecting IP, for the SPF `a` / `mx`
 * mechanisms.
 *
 * The bridge maps `dns.resolve()` to resolve4 ONLY (backend/src/core/plugin-api.ts), so an IPv6-only
 * sender evaluated against "v=spf1 mx -all" could NEVER match and was permanently rejected. resolve6
 * exists on the bridge and was unused — so query the family that matches the connecting IP (a v6
 * source address can only ever equal a AAAA answer, and vice versa; querying the other family is both
 * useless and an extra DNS round-trip).
 *
 * Returns { addrs } on a definitive answer (possibly empty = genuine non-match), or { temp: true }
 * when the lookup failed TEMPORARILY and the caller must yield 'temperror'.
 */
async function spfResolveAddrs(host, ip) {
    try {
        const addrs = net.isIPv6(ip) ? await dns.resolve6(host) : await dns.resolve4(host);
        return { addrs: addrs || [], temp: false };
    } catch (e) {
        if (isDnsNoRecord(e)) return { addrs: [], temp: false }; // no A/AAAA of that family — non-match
        return { addrs: [], temp: true };
    }
}

// RFC 7208 §4.6.4 processing limits. These are DoS bounds, not style: an inbound message hands us a
// MAIL FROM domain of the SENDER's choosing, and every term we honour is a DNS query WE make.
//
//  - SPF_MAX_DNS_LOOKUPS caps the DNS-consuming terms (a / mx / ptr / exists / include / redirect)
//    over the WHOLE evaluation, shared across every nesting level. A per-level recursion guard alone
//    does NOT bound this: it only limits DEPTH, so a record can still fan out BREADTH-wise. Measured
//    on the previous code, a hostile 10-wide × 5-deep include tree turned ONE inbound message into
//    111,111 DNS lookups — an amplifier pointed at our resolver (and at whatever the record names).
//  - SPF_MAX_MX_RECORDS caps the address lookups a SINGLE `mx` term may trigger. This is a separate
//    budget in the RFC because one `mx` term is one term but N published MX records: 500 MX records
//    previously cost 500 address lookups, and nesting that behind 10 includes cost 5,000.
//  - SPF_MAX_DEPTH is only a structural backstop; the lookup budget already bounds nesting, since
//    every level costs at least one `include`/`redirect`.
//
// Exceeding any of them is 'permerror' per the RFC — the sender's published policy is unevaluable,
// which is NOT the same as "unauthorized", so we must not turn it into a 550.
const SPF_MAX_DNS_LOOKUPS = 10;
const SPF_MAX_MX_RECORDS = 10;
const SPF_MAX_DEPTH = 10;

/**
 * Split an RFC 7208 §5.3/§5.4 `dual-cidr-length` suffix off an `a` / `mx` term.
 *
 *   dual-cidr-length = [ "/" ip4-cidr-length ] [ "//" ip6-cidr-length ]
 *
 * so all of `a`, `a/24`, `a//64`, `a/24//64`, `a:host/24`, `mx:host//64` are legal. The term splitter
 * only cut on ':' and '=', so the prefix stayed GLUED to whatever it followed and both spellings were
 * wrong in a way that could reject legitimate mail:
 *   - "a/24"      → name became the literal "a/24", matched no known mechanism, was silently IGNORED,
 *                   and evaluation fell through to the record's `-all` → 'fail' → 550.
 *   - "a:host/24" → we asked the resolver for the literal host "host/24", which answers EBADNAME. That
 *                   is not ENODATA/ENOTFOUND/NXDOMAIN, so it counted as a TEMPORARY failure → 451.
 * Same bug, two different wrong answers, and neither of them is "does this /24 contain the sender".
 *
 * Returns the leftover text, the two prefix lengths (null = absent → treat the address as an exact
 * match) and a `malformed` flag. NOTE: only ever applied to `a`/`mx`. For ip4:/ip6: the "/len" is part
 * of the VALUE (an actual CIDR that ipInCidr consumes) and must stay attached.
 *
 * MALFORMED is a real answer, not an absent prefix. The first version anchored the length at 1-3 digits
 * and stripped from the right, so "a/1234", "a//1234", "a/abc" and a bare "a/" matched neither pattern,
 * stayed glued to the name, matched NO mechanism, and were silently skipped — falling through to the
 * record's `-all` → 'fail' → 550. That is the same harm class as the bug this function was written to
 * fix, just reached through a different spelling. RFC 7208 §4.6/§5.3 says a syntax error in the record
 * is 'permerror', which the caller accepts (and tags) rather than rejects, so the sender's mail gets
 * through and the operator's admin error is what shows up in the header.
 */
function splitDualCidr(text) {
    const raw = String(text == null ? '' : text);
    const slash = raw.indexOf('/');
    if (slash < 0) return { rest: raw, v4: null, v6: null, malformed: false };
    // ABNF §12: ip4-cidr-length is at most 2 digits, ip6-cidr-length at most 3, and the "//" form must
    // follow the "/" form. Match the WHOLE suffix in one shot so anything else is unambiguously a
    // syntax error instead of a prefix we quietly decline to parse.
    const m = /^(?:\/(\d{1,2}))?(?:\/\/(\d{1,3}))?$/.exec(raw.slice(slash));
    const rest = raw.slice(0, slash);
    if (!m || (m[1] === undefined && m[2] === undefined)) return { rest, v4: null, v6: null, malformed: true };
    return {
        rest,
        v4: m[1] === undefined ? null : parseInt(m[1], 10),
        v6: m[2] === undefined ? null : parseInt(m[2], 10),
        malformed: false
    };
}

/**
 * Real inbound SPF evaluation.
 *
 * We fetch the domain's TXT records ourselves (through the HOST DNS bridge) and evaluate the v=spf1
 * policy against the connecting IP: the a / mx / ip4 / ip6 / include mechanisms, the `redirect=`
 * modifier and the trailing `all` qualifier.
 *
 * NOTE: this used to start with a `new SPFValidator(domain).hasRecords()` presence check. That package
 * does its OWN RAW DNS resolution internally, which the sandbox DENIES (dns.resolve* bypasses egress
 * filtering) — so it threw on EVERY inbound message, tripping the fail-closed branch in onMailFrom and
 * REJECTING ALL INBOUND MAIL with "unable to verify SPF". The TXT fetch below subsumes it: it yields
 * 'none' both when the domain publishes no TXT record at all and when none of them is a v=spf1 policy.
 *
 * `budget` is threaded through the recursion so the DNS-lookup limit is GLOBAL to one evaluation. It
 * defaults per top-level call, so it is per-MESSAGE state — never module state.
 *
 * Returns one of: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror'.
 * 'temperror' is returned (never thrown) so the caller can answer 451 "retry" instead of 550.
 */
async function evaluateSPF(domain, ip, depth = 0, budget = { lookups: 0 }) {
    if (!ip) return 'none';                        // nothing to evaluate against
    if (depth > SPF_MAX_DEPTH) return 'permerror'; // backstop; the lookup budget normally trips first

    // Charge one DNS-consuming term to the GLOBAL budget. Returns true when the budget is blown, at
    // which point the caller must abandon the evaluation with 'permerror' (RFC 7208 §4.6.4).
    const overBudget = () => ++budget.lookups > SPF_MAX_DNS_LOOKUPS;

    // Fetch and locate the v=spf1 record.
    //
    // "No TXT records" is NOT a DNS failure: RFC 7208 §4.6 says a domain with no policy evaluates to
    // 'none' (which we accept). But the resolver signals that by REJECTING with ENODATA/ENOTFOUND
    // instead of returning [], so it MUST be mapped to 'none' here — otherwise the caller's fail-closed
    // branch would 451 every legitimate sender that simply doesn't publish SPF, which is barely better
    // than the blanket rejection this whole change exists to fix.
    // Any OTHER failure (SERVFAIL, timeout, a missing 'network' grant) is 'temperror' → 4xx.
    let txt;
    try {
        txt = await dns.resolveTxt(domain);
    } catch (e) {
        if (isDnsNoRecord(e)) return 'none';
        return 'temperror';
    }
    const records = (txt || []).map(chunks => Array.isArray(chunks) ? chunks.join('') : String(chunks));
    // RFC 7208 §4.5: the version token is "v=spf1" followed by a space or end-of-record (`\b` would
    // also accept "v=spf1-all"), and a domain publishing MORE THAN ONE such record has an ambiguous
    // policy → permerror. Silently taking the first could evaluate the wrong half of a migration and
    // manufacture a 'fail' (→ 550) for a legitimate sender.
    const spfRecords = records.filter(r => /^v=spf1(\s|$)/i.test(r.trim()));
    if (spfRecords.length > 1) return 'permerror';
    const spf = spfRecords[0];
    if (!spf) return 'none';

    // Evaluate mechanisms left-to-right; first match wins.
    const terms = spf.trim().split(/\s+/).slice(1); // drop "v=spf1"
    let redirectTo = null;
    for (const term of terms) {
        const qualifier = '+-~?'.includes(term[0]) ? term[0] : '+';
        const mechanism = '+-~?'.includes(term[0]) ? term.slice(1) : term;
        // Split on the first ':' or '=' into mechanism name and its value (a:host, ip4:cidr, include:dom).
        //
        // The NAME is case-INSENSITIVE (RFC 7208 §4.6.1 ABNF spells every mechanism and modifier out of
        // literal strings, which are case-insensitive in ABNF), so fold it before every comparison
        // below. Matching it case-sensitively was NOT a cosmetic omission: the record detector above is
        // already /i, so a record published as "v=spf1 A/24 -all" or "v=spf1 IP4:203.0.113.5 -all" was
        // FOUND and then evaluated as if every one of its mechanisms were unknown — each silently
        // skipped, falling through to the trailing -all → 'fail' → 550 for a sender the policy
        // explicitly authorizes. "-ALL" failed the other way, degrading to 'neutral' (accept).
        //
        // Fold the NAME ONLY. The VALUE must survive verbatim: a domain-spec is case-insensitive for
        // DNS, but macros (%{s}, %{S}) and the exp= explanation string are NOT, and lower-casing the
        // envelope-derived text we may one day expand there would silently corrupt it.
        const sepMatch = mechanism.match(/[:=]/);
        let name = (sepMatch ? mechanism.slice(0, sepMatch.index) : mechanism).toLowerCase();
        let value = sepMatch ? mechanism.slice(sepMatch.index + 1) : null;

        // RFC 7208 §5.3/§5.4: `a` and `mx` may carry a dual-cidr-length, which the ':' / '=' split above
        // leaves glued either to the NAME (bare "a/24", no ':' at all) or to the VALUE ("a:host/24").
        // Peel it off both places; see splitDualCidr for what each spelling used to do wrong.
        let cidr4 = null;
        let cidr6 = null;
        // A malformed prefix is only ever judged on a mechanism we actually KNOW: an unknown term with a
        // slash in it stays ignored (conservative), exactly as before.
        const bare = splitDualCidr(name);
        if (bare.rest === 'a' || bare.rest === 'mx') {
            if (bare.malformed) return 'permerror';
            name = bare.rest; cidr4 = bare.v4; cidr6 = bare.v6;
        }
        if ((name === 'a' || name === 'mx') && value !== null) {
            const spec = splitDualCidr(value);
            if (spec.malformed) return 'permerror';
            value = spec.rest || null;
            if (spec.v4 !== null) cidr4 = spec.v4;
            if (spec.v6 !== null) cidr6 = spec.v6;
        }
        // A prefix wider than the address family is a SYNTAX error in the sender's record (RFC 7208
        // §5.3) → permerror. Silently clamping it would manufacture a non-match that a trailing -all
        // then turns into a 550 for mail the policy never meant to reject.
        if ((cidr4 !== null && cidr4 > 32) || (cidr6 !== null && cidr6 > 128)) return 'permerror';

        // Address test for a / mx: honour the prefix of the family we are actually evaluating (the
        // resolver only ever returns that family — see spfResolveAddrs). No prefix = exact address.
        const cidrLen = net.isIPv6(ip) ? cidr6 : cidr4;
        const addrMatches = (a) => ipInCidr(ip, cidrLen === null ? a : `${a}/${cidrLen}`);

        // MODIFIERS (name=value) are not mechanisms: they never match and are applied only AFTER the
        // whole mechanism list has been scanned (RFC 7208 §6). Just record them here.
        if (name === 'redirect') { if (value) redirectTo = value; continue; }
        if (name === 'exp') continue; // explanation string — cosmetic, ignored

        let matched = false;
        let temp = false;
        if (name === 'all') {
            matched = true;
        } else if (name === 'ip4' || name === 'ip6') {
            // RFC 7208 §5.6: the network literal and its optional prefix are part of the MECHANISM'S
            // SYNTAX, so a malformed or out-of-range one is a permerror for the whole record — the
            // same call the a/mx dual-cidr check above already makes. This arm used to be a bare
            // `ipInCidr(ip, value)`, which answers a plain `false` for anything it cannot parse: the
            // broken term was silently skipped, evaluation fell through to the trailing -all, and an
            // AUTHORIZED sender got a permanent SMTP 550 ("v=spf1 ip4:203.0.113.0/33 -all" rejected
            // 203.0.113.9). Telling the two apart needs the family the mechanism NAME declares, so a
            // legal ip6: term against a v4 sender stays an ordinary non-match.
            const hit = cidrMatch(ip, value, name === 'ip4' ? 4 : 6);
            if (hit === CIDR_MALFORMED) return 'permerror';
            matched = hit;
        } else if (name === 'a') {
            if (overBudget()) return 'permerror';
            const r = await spfResolveAddrs(value || domain, ip);
            temp = r.temp;
            // Compare NUMERICALLY via ipInCidr (a bare address = /32 or /128, or the term's own
            // dual-cidr prefix): a textual `includes()` misses the many equivalent spellings of one
            // IPv6 address (2001:db8::1 vs 2001:0db8:0:0:0:0:0:1).
            matched = !temp && r.addrs.some(addrMatches);
        } else if (name === 'mx') {
            if (overBudget()) return 'permerror';
            const host = value || domain;
            let mx = [];
            try {
                mx = (await dns.resolveMx(host)) || [];
            } catch (e) {
                if (!isDnsNoRecord(e)) temp = true;
            }
            // RFC 7208 §4.6.4: ONE `mx` term costs one term but may name arbitrarily many exchanges,
            // each needing its own address lookup. Publishing 500 MX records is a legal way to make us
            // do 500 lookups per message, so the RFC caps this at 10 and mandates permerror past it.
            if (mx.length > SPF_MAX_MX_RECORDS) return 'permerror';
            for (const rec of mx) {
                const r = await spfResolveAddrs(rec.exchange, ip);
                if (r.temp) { temp = true; continue; }
                if (r.addrs.some(addrMatches)) { matched = true; temp = false; break; }
            }
        } else if (name === 'include' && value) {
            if (overBudget()) return 'permerror';
            // Recurse into the included policy, sharing the GLOBAL lookup budget; a 'pass' there counts
            // as a match here. RFC 7208 §5.2 maps the recursive result: pass→match,
            // fail/softfail/neutral→no match, temperror→temperror, none/permerror→permerror. The last
            // one matters: without it, an unevaluable include silently degrades to "no match" and a
            // trailing -all turns an UNKNOWN answer into a 550 — and the budget above could never be
            // observed at the top level.
            const sub = await evaluateSPF(value, ip, depth + 1, budget);
            if (sub === 'temperror') temp = true;
            else if (sub === 'permerror' || sub === 'none') return 'permerror';
            else matched = sub === 'pass';
        } else if (name === 'ptr' || name === 'exists') {
            // Still not EVALUATED (both need macro expansion, which we don't implement, so they stay a
            // conservative non-match). But they are DNS-consuming terms and RFC 7208 §4.6.4 counts them,
            // so charge the budget anyway — otherwise a record could hide its fan-out behind the terms
            // we happen to skip and re-open the amplifier from the other side.
            if (overBudget()) return 'permerror';
        }
        // Any other unknown mechanism is ignored — conservative.

        // A TEMPORARY DNS failure inside a mechanism must NOT be swallowed into "no match". The old code
        // caught it and set matched=false, so evaluation fell through to a trailing `-all` → 'fail' →
        // smtpError(550): a PERMANENT rejection of mail that was merely unverifiable at that instant (a
        // real 32s queryTxt ETIMEOUT was observed live). RFC 7208 mandates temperror → 4xx here.
        if (temp) return 'temperror';

        // `all` always matches, so we return here — which is also exactly why a `redirect=` in a record
        // that has an `all` mechanism is never applied (RFC 7208 §6.1 requires it to be ignored).
        if (matched) return qualifierToResult(qualifier);
    }

    // RFC 7208 §6.1 `redirect=`: applied ONLY when no mechanism matched, and it REPLACES this record's
    // result wholesale (there is no `all` left to fall back on — see above). Without this, gmail.com's
    // "v=spf1 redirect=_spf.google.com" evaluated to 'neutral' for EVERY IP, i.e. SPF was a complete
    // NO-OP for the largest sender on the internet and a spoofed @gmail.com envelope sailed through.
    // The recursion shares the same GLOBAL DNS-lookup budget, so a redirect chain is bounded exactly
    // like include: is — and a redirect LOOP burns the budget and terminates in permerror.
    if (redirectTo) {
        if (overBudget()) return 'permerror';
        const sub = await evaluateSPF(redirectTo, ip, depth + 1, budget);
        // "no SPF record at the redirect target" is a broken policy, not an absent one → permerror.
        return sub === 'none' ? 'permerror' : sub;
    }

    // No mechanism matched, no `all`, no redirect → neutral.
    return qualifierToResult('?');
}

function qualifierToResult(q) {
    if (q === '+') return 'pass';
    if (q === '-') return 'fail';
    if (q === '~') return 'softfail';
    return 'neutral'; // '?'
}

/**
 * Map an SPF verdict + the operator's preference to an SMTP action. PURE — no I/O — so the policy is
 * one readable table instead of a chain of early returns whose ORDER silently decided things.
 *
 * `mail_security_spf_reject = '0'` is the operator saying "do not turn SPF into a refusal, tag and let
 * me filter". It used to gate ONLY the fail/softfail 550, because the temperror branch ran BEFORE the
 * option was ever read — so a tag-only site still had inbound mail DEFERRED with 451 whenever a
 * resolver hiccup anywhere inside an a/mx/include made a domain unevaluable. A 451 is not a rejection,
 * but it is still SPF refusing the message: the sender queues it, retries for days and eventually
 * bounces it. That is precisely the outcome the operator opted out of, so the override now gates EVERY
 * SPF-driven refusal — temperror included.
 *
 * The verdicts and why each lands where it does:
 *   pass / neutral / none  — nothing to refuse (`none` = the domain publishes no policy at all).
 *   permerror              — the sender's published policy is UNEVALUABLE (malformed, ambiguous, or over
 *                            the RFC 7208 §4.6.4 lookup budget). §8.6 leaves it to local policy and it
 *                            is NOT a statement that the IP is unauthorized, so we accept in BOTH modes
 *                            rather than turn someone else's admin error into a 550. It is not silently
 *                            discarded: the verdict is recorded in the Received-SPF header stored with
 *                            the message (see buildReceivedSpf).
 *   temperror              — we could not evaluate RIGHT NOW → 451 so the sender retries; never 550.
 *   softfail               — "probably not authorized" (`~all`). RFC 7208 §8.5 is explicit that a softfail
 *                            is WEAK evidence and SHOULD NOT be used on its own to reject. It is also what
 *                            the large providers publish — gmail, google and microsoft all end in `~all` —
 *                            so a 550 here permanently bounces legitimate forwarded and mailing-list mail,
 *                            which is the SAME user-visible symptom as the sandbox-DNS bug this file
 *                            already fixed, reached by a different code path. Accept in BOTH modes and let
 *                            Received-SPF carry the verdict, exactly like permerror.
 *   fail                   — the domain owner states this IP is NOT authorized (`-all`) → 550.
 *
 * @returns {{code: 0|451|550, tagged: boolean}} code 0 = accept.
 */
function spfAction(result, rejectEnabled) {
    if (result === 'pass' || result === 'neutral' || result === 'none') return { code: 0, tagged: false };
    // Accepted-but-not-clean in BOTH modes. Neither verdict asserts the IP is unauthorized: permerror is
    // the sender's own broken policy, softfail is their explicit "probably not, but don't reject on this".
    if (result === 'permerror' || result === 'softfail') return { code: 0, tagged: true };
    // temperror / fail are refusals — unless the operator asked for tag-only.
    if (!rejectEnabled) return { code: 0, tagged: true };
    if (result === 'temperror') return { code: 451, tagged: true };
    return { code: 550, tagged: true };
}

/**
 * Build the RFC 7208 §9.1 Received-SPF header for a checked message.
 *
 * WHY THIS EXISTS: onMailFrom used to stash `session.spfheader` and `session.spfResult` and NOTHING
 * ever read them — no header was attached, nothing was persisted, and the verdict was discarded the
 * moment the transaction ended. That made "we accept permerror" indefensible: an over-budget record
 * (say 12 includes) went from a 550 to an accept with no trace anywhere. onData now stores this string
 * on the message row, so an accepted-but-not-clean verdict is visible in the mailbox and to anything
 * that reads the row.
 *
 *   header-field = "Received-SPF:" [CFWS] result FWS [comment FWS] [ key-value-list ] CRLF
 *
 * Every interpolated value except `result` is remote-controlled (envelope sender, HELO), so fold each
 * one through a strict scrub first: no CR/LF (this string is a header — it must never be able to
 * introduce a second one), no other control characters, and a hard length cap.
 */
function sanitizeHeaderValue(v, max = 255) {
    return String(v == null ? '' : v)
        // CR/LF and every other C0/DEL control char -> a single space. This is the header-injection
        // boundary: without it an envelope sender carrying a bare CRLF could forge a second header.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]+/g, ' ')
        // Structural characters of the header grammar itself (comment parens, the key-value
        // separator, the angle brackets we wrap envelope-from in).
        .replace(/[()<>;]/g, '')
        // A header is ASCII (RFC 5322); anything else would need RFC 2047 encoding, and a raw non-ASCII
        // byte from a remote envelope has no business in a field we generate.
        .replace(/[^\x20-\x7e]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function buildReceivedSpf(result, { domain, mailFrom, ip, helo, receiver } = {}) {
    const res = ['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror'].includes(result)
        ? result
        : 'none';
    const rcv = sanitizeHeaderValue(receiver || 'wordjs', 128) || 'wordjs';
    const dom = sanitizeHeaderValue(domain, 253);
    const from = sanitizeHeaderValue(mailFrom, 320);
    const cip = sanitizeHeaderValue(ip, 45);
    const hel = sanitizeHeaderValue(helo, 253);

    const EXPLAIN = {
        pass: `domain of ${from || 'sender'} designates ${cip || 'the client'} as permitted sender`,
        fail: `domain of ${from || 'sender'} does not designate ${cip || 'the client'} as permitted sender`,
        softfail: `domain of transitioning ${from || 'sender'} does not designate ${cip || 'the client'} as permitted sender`,
        neutral: `${dom || 'sender domain'} is neither permitted nor denied by domain of ${from || 'sender'}`,
        none: `${dom || 'sender domain'} does not designate permitted sender hosts`,
        temperror: `error in processing during lookup of ${dom || 'sender domain'}: try again later`,
        permerror: `permanent error in processing domain of ${dom || 'sender domain'}: unevaluable SPF record`
    };

    const kv = [`client-ip=${cip}`, `envelope-from=<${from}>`];
    if (hel) kv.push(`helo=${hel}`);
    kv.push(`receiver=${rcv}`, 'identity=mailfrom');
    return `Received-SPF: ${res} (${rcv}: ${EXPLAIN[res]}) ${kv.join('; ')};`;
}

/**
 * Returned by cidrMatch() for a term that is SYNTACTICALLY BROKEN, as opposed to one that is
 * well-formed and simply does not contain the IP. RFC 7208 §5.6 makes the first a permerror for the
 * whole record; collapsing it into the second is what turns the sender's typo into OUR 550.
 */
const CIDR_MALFORMED = Symbol('cidr-malformed');

/**
 * Match an IP against a CIDR or bare address (IPv4/IPv6). No external deps.
 *
 * `family` is the address family the CALLER'S SYNTAX declares — 4 for an `ip4:` mechanism, 6 for an
 * `ip6:` one — or null where the family is only implied and a mismatch is unremarkable (the addresses
 * we resolved ourselves for a/mx, and isBlockedIp's block-lists). Only a declared family lets us tell
 * a BROKEN term from a non-matching one: "ip4:2001:db8::1" is a syntax error, while a perfectly legal
 * "ip6:2001:db8::/32" merely has nothing to say about an IPv4 sender. With a family, anything that is
 * not a well-formed network of that family — bogus literal, missing value, extra slash, non-numeric or
 * out-of-range prefix — is CIDR_MALFORMED. Without one, every such case stays `false`, as before.
 *
 * Returns true | false | CIDR_MALFORMED.
 */
function cidrMatch(ip, cidr, family = null) {
    // Fold every "cannot parse this" exit through one helper: for an implied family the historical
    // answer (a plain non-match) is the only safe one, since isBlockedIp treats truthy as "blocked".
    const broken = () => (family === null ? false : CIDR_MALFORMED);

    // §5.6 ABNF: ip4:/ip6: REQUIRE a network. A bare "ip4" or an empty "ip4:" is a broken term, not a
    // mechanism that quietly matches nothing.
    if (cidr === null || cidr === undefined || cidr === '') return broken();

    // Split on EVERY '/': an IPv6 literal never contains one, so a second slash ("192.0.2.0//24" —
    // the dual-cidr spelling, which is legal only on a/mx) is a syntax error, not something to parse
    // around. The old two-element destructure silently dropped it.
    const parts = String(cidr).split('/');
    if (parts.length > 2) return broken();
    const range = parts[0];
    const bitsRaw = parts.length > 1 ? parts[1] : undefined;

    const rangeIsV4 = net.isIPv4(range);
    const rangeIsV6 = net.isIPv6(range);
    if (family === 4 && !rangeIsV4) return CIDR_MALFORMED;
    if (family === 6 && !rangeIsV6) return CIDR_MALFORMED;
    if (!rangeIsV4 && !rangeIsV6) return broken();

    // §5.6: ip4-cidr-length is 0-32 and ip6-cidr-length is 0-128, digits only — no sign, no spaces, no
    // empty "/". parseInt is far too forgiving to be the gate on its own ("24abc" -> 24, "" -> NaN,
    // " 24" -> 24), and NaN silently lost to `isNaN(bits) -> return false` is exactly the swallow this
    // whole change removes. Validate the TEXT first, then the range.
    const totalBits = rangeIsV6 ? 128 : 32;
    let bits = totalBits;
    if (bitsRaw !== undefined) {
        if (!/^\d{1,3}$/.test(bitsRaw)) return broken();
        bits = parseInt(bitsRaw, 10);
        if (bits > totalBits) return broken();
    }

    // Only now, with the term established as well-formed, does the SENDER's family matter: a legal
    // network of the other family is an ordinary non-match, and must stay one — every dual-stack
    // record on the internet publishes both, and permerror-ing those would disable enforcement.
    const isV6 = net.isIPv6(ip) && rangeIsV6;
    if (!isV6 && !(net.isIPv4(ip) && rangeIsV4)) return false;

    const toBig = (addr, asV6) => {
        if (!asV6) {
            return addr.split('.').reduce((acc, o) => (acc << 8n) + BigInt(parseInt(o, 10)), 0n);
        }
        // RFC 4291 §2.2(3): the low 32 bits of an IPv6 literal may be written as a dotted quad, so
        // "::ffff:203.0.113.9", "64:ff9b::192.0.2.1" and "2001:db8::192.0.2.1" are all legal addresses
        // a domain may publish in an ip6: term. That tail is TWO hextets, and the reducer below reads
        // each group with parseInt(p, 16), which STOPS at the '.' — "192.0.2.1" comes back as 0x192,
        // and the fill count is short by one besides. There is no syntax error to catch (the term IS a
        // well-formed ip6-network), so the record silently evaluates against a DIFFERENT network than
        // the one it publishes: the sender it names gets -all'd, and whichever address the truncation
        // lands on gets that authorisation instead. Rewrite the tail to hex before expanding.
        // Both callers already passed net.isIPv6, so the octets are known to be in range.
        const quad = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
        const text = quad
            ? quad[1] + (((+quad[2] << 8) | +quad[3]).toString(16)) + ':' + (((+quad[4] << 8) | +quad[5]).toString(16))
            : addr;

        // Expand IPv6 to 8 hextets.
        let [head, tail] = text.split('::');
        const h = head ? head.split(':') : [];
        const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
        let parts2;
        if (t === null) { parts2 = h; }
        else { parts2 = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]; }
        return parts2.reduce((acc, p) => (acc << 16n) + BigInt(parseInt(p || '0', 16)), 0n);
    };

    const ipBig = toBig(ip, isV6);
    const rangeBig = toBig(range, isV6);
    const mask = bits === 0 ? 0n : (~0n << BigInt(totalBits - bits)) & ((1n << BigInt(totalBits)) - 1n);
    return (ipBig & mask) === (rangeBig & mask);
}

/**
 * Boolean view of cidrMatch for the callers with no declared family: the a/mx address test (whose
 * addresses came from our own resolver) and isBlockedIp, the outbound-delivery SSRF guard.
 *
 * The sentinel must NEVER reach isBlockedIp — it is truthy, so `V4_BLOCKED.some(c => ipInCidr(a, c))`
 * would report every public MX as a private address and silently stop ALL outbound mail. Passing no
 * family guarantees cidrMatch cannot produce it; the `=== true` is the belt to that braces.
 */
function ipInCidr(ip, cidr) {
    return cidrMatch(ip, cidr) === true;
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

// Build an SMTP rejection carrying a REAL status code. smtp-server reads `err.responseCode`; without it
// it answers 550 and prefixes our text verbatim, which produced the malformed "550 451 Temporary
// failure…" — i.e. a PERMANENT reject for what we meant as a temporary one, so the sending MTA gave up
// for good instead of retrying. 4xx = try again later, 5xx = permanent.
function smtpError(code, message) {
    const err = new Error(message);
    err.responseCode = code;
    return err;
}

/**
 * Why port 25 could not be bound, as the operator reads it in the admin UI (`inbound_reason`).
 *
 * Each answer names the cause the errno actually identifies, because the old EACCES text sent operators
 * to give node CAP_NET_BIND_SERVICE with `setcap` — advice that is withdrawn: a capability on node or on
 * the service (AmbientCapabilities=) is exactly what the plugin sandbox has to strip before it confines a
 * plugin, and a file capability on node extends to every node script on the machine.
 *   EACCES      on Linux a non-root process may not bind below net.ipv4.ip_unprivileged_port_start
 *               (1024 by default). The 2525 fallback is bindable, so a firewall redirect 25 -> 2525 works,
 *               and so does lowering the sysctl to 25 — at the cost of letting every unprivileged process
 *               bind 25-1023, which the text says.
 *   EPERM       the operating system refused a listening socket outright. On Linux that is the plugin
 *               sandbox's seccomp filter, which denies bind/listen to every isolated plugin on every port.
 *               Measured on Linux 7.0 under the shim with the network grant: EPERM on 25 and on 2525 alike.
 *               No port setting can help there, and "grant port 25" would send the operator the wrong way.
 *   EADDRINUSE  another MTA already holds 25.
 */
function inboundPortReason(code) {
    if (code === 'EACCES') {
        return 'binding port 25 was denied (EACCES): on Linux a non-root process may not bind a port below ' +
            'net.ipv4.ip_unprivileged_port_start (1024 by default). Inbound falls back to 2525: redirect ' +
            '25 to it in the firewall (nftables/iptables REDIRECT 25 → 2525), or set the sysctl ' +
            'net.ipv4.ip_unprivileged_port_start=25, which lets EVERY unprivileged process on the host bind 25-1023, ' +
            'not only WordJS. Do not setcap the node binary or give the service capabilities (documentation/deployment.md).';
    }
    if (code === 'EPERM') {
        return 'the operating system refused this plugin a listening socket (EPERM). On Linux this is the plugin ' +
            'sandbox: its seccomp filter does not let an isolated plugin bind or listen on any port, so this plugin ' +
            'cannot run its own SMTP listener here, and no port, sysctl or capability setting changes it. Grant the ' +
            'plugin the "Receive internet email (port 25)" permission (smtp:inbound) in Plugins → Permissions: WordJS ' +
            'then listens on port 25 for it. Sending and local mail are unaffected.';
    }
    if (code === 'EADDRINUSE') return 'port 25 is already in use by another mail server — stop it, or map 25 → 2525';
    return `could not bind port 25 (${code || 'unknown error'})`;
}

/**
 * May this server accept mail for `address` (RCPT TO)? null = yes, else the SMTP error to answer.
 * Yes for a mailbox on our mail domain (the same predicate as delivery: mailboxAddressOf), an alias, or
 * any address on the domain while catch-all is on. Another domain is relaying (5.7.1); an address on our
 * domain with none of those is unknown (5.1.1). A lookup failure is a temporary 4xx, never a silent accept.
 */
async function recipientVerdict(rawAddress, mailDomain, catchAllRaw) {
    const address = String(rawAddress || '').trim().toLowerCase();
    const at = address.lastIndexOf('@');
    const local = at > 0 ? address.slice(0, at) : '';
    const domain = at > 0 ? address.slice(at + 1) : '';
    if (!local || !domain || domain !== mailDomain) {
        return smtpError(550, `5.7.1 Relaying denied: this server only accepts mail for ${mailDomain}`);
    }
    try {
        let mailbox = null;
        const candidate = await User.findByEmail(address) || await User.findByLogin(local);
        if (mailboxAddressOf(candidate, mailDomain)) {
            mailbox = candidate;
        }
        if (mailbox) return null;
        if (Admin && await Admin.findAliasByLocalPart(local)) return null;
        if (catchAllRaw === '1') return null;
        return smtpError(550, `5.1.1 <${address}>: no such user here`);
    } catch (e) {
        console.warn(`[MailServer] RCPT check failed for ${address}: ${e && e.message}`);
        return smtpError(451, '4.3.0 Temporary local problem, try again later');
    }
}

// The Bayesian verdict needs EVIDENCE before it may file mail as spam. The library's categorize()
// answers "the most probable category" however thin the training: after one message marked spam and
// one marked not-spam, every text full of words it never saw tied — and the tie went to 'spam', so a
// normal message from an SPF-authenticated sender landed in Spam (and lost its vacation reply and
// forward with it). Found in the production lab. So: no verdict until each class has a minimum of
// training documents, only words the classifier has seen count (an unseen word carries no evidence,
// it merely favours the class with less text), and spam needs a clear margin — at least ~90 %.
const BAYES_MIN_DOCS = 5;
const BAYES_SPAM_MARGIN = Math.log(9); // posterior odds 9:1
const GTUBE = 'XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X';
function isGtube(text) {
    return String(text || '').replace(/\s+/g, '').includes(GTUBE);
}

async function isLikelySpam(c, text) {
    try {
        const spamDocs = (c && c.docCount && c.docCount.spam) || 0;
        const hamDocs = (c && c.docCount && c.docCount.ham) || 0;
        if (spamDocs < BAYES_MIN_DOCS || hamDocs < BAYES_MIN_DOCS) return false;
        const freq = c.frequencyTable(await c.tokenizer(text));
        const total = spamDocs + hamDocs;
        let logSpam = Math.log(spamDocs / total);
        let logHam = Math.log(hamDocs / total);
        let seen = 0;
        for (const token of Object.keys(freq)) {
            if (!c.vocabulary || !c.vocabulary[token]) continue;
            seen++;
            logSpam += freq[token] * Math.log(c.tokenProbability(token, 'spam'));
            logHam += freq[token] * Math.log(c.tokenProbability(token, 'ham'));
        }
        if (seen === 0) return false;
        return (logSpam - logHam) > BAYES_SPAM_MARGIN;
    } catch (e) {
        return false; // a classifier problem never files mail away
    }
}

/**
 * Initialize the Inbound SMTP Server
 */
async function initSMTPServer() {
    // The domain we ACCEPT mail for — the same one we sign/send as and publish MX on (see getMailDomain).
    const mailDomain = await getMailDomain();
    if (!isPublicSendingDomain(mailDomain)) {
        console.warn(`   ⚠️  Mail domain is '${mailDomain}', which is not a public domain: mailboxes are addressed @${mailDomain} and no other server can deliver to them. Give the site its real domain (Settings → Site address) or set the domain in the DKIM card of the Configuration tab.`);
    }
    // Default to 25 — the ONLY port the world delivers mail to (the MX record implies :25). This makes
    // inbound work with zero config wherever the process may bind it. Where it CAN'T bind 25 we fall back
    // to 2525 below and report WHY, naming the real cause (inboundPortReason) — never a silent no-inbound.
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

    // The greeting names the server by its HELO name (220 mail.example.com ESMTP), not the machine's
    // hostname — the same name outbound mail announces and PTR must match.
    let greetingName = '';
    try { greetingName = String(await getHeloName() || ''); } catch (e) { greetingName = ''; }
    const serverOptions = {
        // Only ever an explicit IP allowlist, never `true` (see parseTrustedProxyIps for why).
        ...(trustedProxyIps.length ? { useProxy: trustedProxyIps } : {}),
        ...(greetingName ? { name: greetingName } : {}),
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

                dnsblListed(ip).then(listed => {
                    if (listed === true) {
                        console.warn(`[Security][DNSBL] IP ${ip} is listed on ${DNSBL_ZONE} — rejecting`);
                        return callback(smtpError(554, 'Connection rejected: your IP is listed on a DNS blocklist'));
                    }
                    // FAIL OPEN on no verdict: Spamhaus refuses queries from public/cloud resolvers, so
                    // that is a COMMON case — rejecting on it would blackhole ALL inbound mail. SPF and
                    // the Bayesian filter still apply. Only a POSITIVE listing rejects.
                    if (listed === null) console.warn(`[Security][DNSBL] no verdict for ${ip} from ${DNSBL_ZONE} — accepting (fail open)`);
                    callback();
                }).catch(() => callback());
            }).catch((e) => {
                // The option lookup itself failed — accept (fail open) rather than blackhole inbound.
                console.warn(`[Security][DNSBL] option lookup error: ${e.message} — accepting (fail open)`);
                callback();
            });
        },

        // 2. SPF Protection — real check against the connecting IP and MAIL FROM domain.
        // Default ON, FAIL CLOSED for external senders: reject on an explicit SPF fail (`-all`), defer on a
        // lookup error. 'pass'/'neutral'/'none' (no SPF record) are accepted to avoid false rejects, and so
        // are 'softfail' (§8.5 — weak evidence, and what gmail/google/microsoft publish) and 'permerror'.
        // WHAT each verdict costs the sender lives in ONE place — spfAction() — deliberately, because
        // the previous chain of early returns let the temperror 451 fire BEFORE the operator's
        // reject-override was even read (see spfAction).
        onMailFrom(address, session, callback) {
            // A session can carry several transactions: never let a previous MAIL FROM's verdict
            // describe this one (onData reads it to persist and to gate vacation replies).
            delete session.spfHeader;
            // Loopback / authenticated senders are our own relay path — never SPF-gate them.
            if (isTrustedSmtpSession(session)) return callback();

            // Default ON: only an explicit operator override ('0') disables the check. Both options are
            // read in ONE parallel wave: the reject preference must be known BEFORE we decide anything,
            // and batching keeps that off the per-message latency path.
            getOptionsBatch({ mail_security_spf_enabled: '1', mail_security_spf_reject: '1' }).then(async (opts) => {
                if (opts.mail_security_spf_enabled === '0') return callback();
                const rejectEnabled = opts.mail_security_spf_reject !== '0';

                const ip = bareIp(session.remoteAddress); // '::ffff:1.2.3.4' → '1.2.3.4' so SPF matches
                const mailFrom = (address && address.address) || '';
                const domain = mailFrom.split('@')[1] || '';

                let result = 'none';
                try {
                    if (domain) result = await evaluateSPF(domain, ip);
                } catch (e) {
                    // An UNEXPECTED throw (never mind a DNS answer) is exactly "we could not evaluate
                    // right now" — i.e. temperror. Mapping it here instead of carrying a separate
                    // evalError flag keeps ONE verdict driving both the action and the recorded header
                    // (the old code left result='none', so the header claimed 'none' while we 451'd).
                    console.warn(`[Security][SPF] evaluation error for ${domain} (${ip}): ${e.message} — treating as temperror`);
                    result = 'temperror';
                }

                // Record the verdict on the session so onData can PERSIST it with the message (it writes
                // this string to the message row's received_spf column). This is what makes accepting
                // 'permerror' defensible: the verdict survives the transaction.
                //
                // ONE field, because one thing reads it. A parallel `session.spfResult = result` was
                // written here too and had zero readers repo-wide — the very defect (a verdict stashed
                // on the session that nothing consumes) that this change set exists to remove, so
                // re-introducing it in the fix would have been the bug wearing the patch's clothes.
                session.spfHeader = buildReceivedSpf(result, {
                    domain, mailFrom, ip,
                    helo: session.clientHostname,
                    // `receiver` is US. Use the mailDomain this listener was started with (already in
                    // closure scope) rather than getHeloName(), which would cost up to two extra option
                    // RPCs on the per-message inbound path for a purely cosmetic field.
                    receiver: mailDomain
                });

                const action = spfAction(result, rejectEnabled);
                if (action.code === 451) {
                    console.warn(`[Security][SPF] ${result} for ${mailFrom || 'sender'} from ${ip} — deferring (451)`);
                    return callback(smtpError(451, 'Temporary failure: unable to verify SPF for ' + (domain || 'sender') + ', try again later'));
                }
                if (action.code === 550) {
                    console.warn(`[Security][SPF] Rejecting ${mailFrom} from ${ip} (SPF ${result})`);
                    return callback(smtpError(550, 'SPF check failed: sending IP not authorized for ' + domain));
                }
                if (action.tagged) {
                    console.warn(`[Security][SPF] ${result} for ${mailFrom || 'sender'} from ${ip} — accepted and tagged` +
                        (rejectEnabled ? '' : ' (reject overridden off)'));
                }
                callback();
            }).catch((e) => {
                // The option lookup itself failed — we do not know the operator's preference, so we
                // cannot honour tag-only. Fail closed with a 4xx (retryable), never a 5xx.
                console.warn(`[Security][SPF] option lookup error: ${e.message} — deferring (fail closed)`);
                callback(smtpError(451, 'Temporary failure, try again later'));
            });
        },

        // 3. RCPT TO: the administrator's site-wide sender blocklist (refused before any DATA is
        //    transferred; trusted loopback/authenticated sessions are our own relay and never gated), then
        //    the recipient itself — a mailbox, an alias, or catch-all on OUR mail domain, or a 550. Accepting
        //    an address that delivers nowhere told the sender "250 OK" and then dropped the message, so
        //    nobody ever learned it was lost (found in the production lab).
        onRcptTo(address, session, callback) {
            const envelopeFrom = (session && session.envelope && session.envelope.mailFrom && session.envelope.mailFrom.address) || '';
            const blocked = (envelopeFrom && !isTrustedSmtpSession(session))
                ? getDeliveryPolicy().then((policy) => MailRules.senderMatches(envelopeFrom, policy.blocked)).catch(() => false)
                : Promise.resolve(false);
            blocked.then(async (isBlocked) => {
                if (isBlocked) {
                    console.warn(`[Security] Sender ${envelopeFrom} is on the site blocklist — rejecting`);
                    return callback(smtpError(550, '5.7.1 Sender rejected by recipient policy'));
                }
                callback(await recipientVerdict(address && address.address, mailDomain, catchAllRaw));
            }).catch(() => callback(smtpError(451, '4.3.0 Temporary local problem, try again later')));
        },

        onData(stream, session, callback) {
            // The raw bytes are kept: DKIM signs them exactly, and the parsed message cannot give them back.
            readRawMessage(stream).then(raw => simpleParser(raw, async (err, parsed) => {
                if (err) return callback(err);

                try {
                    // 2a. DKIM + DMARC (lib/mail-auth.js) for mail from outside. Our own relay path
                    //     (loopback / authenticated) is never gated; the operator can turn it off.
                    const external = !isTrustedSmtpSession(session);
                    // Every address the From names, groups included ("team: a@x, b@y;" lists its
                    // members under .group, never as an address of its own).
                    const headerFroms = (parsed.from?.value || [])
                        .flatMap(v => (v && Array.isArray(v.group) ? v.group : [v]))
                        .map(v => v && v.address).filter(Boolean);
                    let auth = null;
                    if (external && (await getOption('mail_security_dmarc_enabled', '1')) !== '0') {
                        auth = await authenticateInbound(raw, session, headerFroms, mailDomain);
                    }

                    // 2b. From alignment — a message from OUTSIDE may not speak for a local mailbox
                    //     unless SPF or a DKIM signature of that domain authenticated it (see
                    //     localDomainImpersonation).
                    if (external) {
                        // Only a signature that covers the whole body speaks for its domain (see MailAuth.fullPass).
                        const dkimDomains = auth ? auth.dkim.filter(MailAuth.fullPass).map(d => d.domain) : [];
                        const forged = localDomainImpersonation(mailDomain, session?.spfHeader,
                            session?.envelope?.mailFrom?.address, headerFroms, dkimDomains);
                        if (forged) {
                            console.warn(`[Security] Rejecting external message claiming to be from ${forged} (not authenticated for ${mailDomain})`);
                            return callback(smtpError(550, `5.7.1 Sender address ${forged} is not authorized from this host`));
                        }
                    }

                    // 2c. The From domain's DMARC policy: p=reject refuses the message, p=quarantine
                    //     files it in Spam (whatever the mailbox's own rules say).
                    const dmarc = auth && auth.dmarc;
                    if (dmarc && dmarc.disposition === 'reject') {
                        console.warn(`[Security][DMARC] Rejecting a message from ${dmarc.domain}: ${dmarc.reason}`);
                        // permerror + reject is a From that cannot be evaluated at all (several From
                        // fields, too many From domains): not any one domain's policy.
                        return callback(smtpError(550, dmarc.result === 'permerror'
                            ? '5.7.1 Message rejected: its From header cannot be authenticated (DMARC)'
                            : `5.7.1 Message rejected by the DMARC policy of ${dmarc.domain}`));
                    }
                    const quarantined = !!(dmarc && dmarc.disposition === 'quarantine');
                    if (quarantined) console.warn(`[Security][DMARC] Quarantining a message from ${dmarc.domain}: ${dmarc.reason}`);

                    // 3. Bayesian Analysis
                    const text = (parsed.subject || '') + ' ' + (parsed.text || '');
                    // GTUBE (the standard anti-spam test string) is spam by definition, trained or not: it
                    // is how an operator checks that the filter files spam at all.
                    const isSpam = isGtube(text + ' ' + (parsed.html || '')) || await isLikelySpam(classifier, text);

                    if (isSpam) console.log(`[Security] Bayesian Filter marked message as SPAM`);

                    // 4. Processing
                    // WHO GETS A COPY is the SMTP envelope — the RCPT TO addresses this transaction
                    // was accepted for (onRcptTo → recipientVerdict) — never the To:/Cc: headers. The
                    // headers are whatever the sender wrote: delivering to them handed a message to
                    // every local mailbox or alias it NAMED (one accepted RCPT was enough), and lost
                    // the Cc/Bcc/list copies whose recipient appears only in the envelope. Headers are
                    // display only. One entry per address, however often the envelope repeats it.
                    const toAddresses = [];
                    const seenRcpt = new Set();
                    for (const r of (session?.envelope?.rcptTo || [])) {
                        const address = String((r && r.address) || '').trim().toLowerCase();
                        if (!address || seenRcpt.has(address)) continue;
                        seenRcpt.add(address);
                        toAddresses.push({ address });
                    }

                    // The first From address is what the list shows; when the From names several
                    // domains, the stored Authentication-Results lists them all and the webmail says so.
                    const fromAddr = headerFroms[0]
                        || session?.envelope?.mailFrom?.address
                        || '';
                    const fromName = (parsed.from?.value?.[0]?.address && parsed.from.value[0].name) || '';

                    // Thread an inbound reply back into its conversation (THREAD-XREF): a reply's
                    // In-Reply-To / References headers echo the Message-ID of a message we already have
                    // (e.g. the Sent copy we delivered with that exact Message-ID). Resolve them and
                    // inherit that message's thread so the reply lands in the same árbol instead of
                    // starting a new one. Falls back to 0 (its own new thread) when nothing matches.
                    // The lookup is PER RECEIVING MAILBOX: the headers are the sender's to write, so
                    // they may only ever point into a conversation that mailbox already owns.
                    const refIds = []
                        .concat(parsed.inReplyTo || [])
                        .concat(parsed.references || [])
                        .join(' ')
                        .split(/\s+/)
                        .map(s => s.trim())
                        .filter(Boolean)
                        .slice(0, 20);
                    const threadFor = async (mailbox) => {
                        if (!mailbox || !mailbox.id) return 0;
                        try {
                            for (const rid of refIds) {
                                // NOT-A-USER-PATH: inbound SMTP delivery. The id is a Message-ID from the
                                // message's own In-Reply-To/References header, resolved only among the
                                // receiving mailbox's own rows to thread the copy we are about to write.
                                const parent = await Email.findByMessageId(rid, mailbox.id, mailbox.userEmail);
                                if (parent) return parent.thread_id || parent.id;
                            }
                        } catch (e) {
                            console.error('[MailServer] Inbound thread lookup failed:', e.message);
                        }
                        return 0;
                    };

                    // A message we forwarded ourselves must never be forwarded again (loop guard).
                    const alreadyForwarded = !!(parsed.headers && parsed.headers.get && parsed.headers.get(FORWARD_HEADER.toLowerCase()));
                    const autoGenerated = isAutoGenerated(parsed);
                    let storedCount = 0;
                    let quotaRejected = 0;
                    const deliveredTo = new Set(); // one copy per mailbox even if To lists it twice / via an alias
                    const pendingForwards = [];    // { via, to: [...], rowId }

                    const baseCopy = {
                        messageId: parsed.messageId,
                        fromAddress: fromAddr,
                        fromName: fromName,
                        subject: parsed.subject || '(no subject)',
                        bodyText: parsed.text || '',
                        // STORED XSS (P1): inbound HTML is attacker-controlled (any sender;
                        // catch-all reaches the admin mailbox). Sanitize on the durable write
                        // path so no reader — including Reply/Forward, which re-quotes this
                        // body into the live admin editor — ever loads a script-bearing string.
                        bodyHtml: sanitizeEmailHtml(parsed.html || ''),
                        rawContent: parsed.textAsHtml || parsed.text || '',
                        // The SPF verdict for THIS transaction, as the RFC 7208 §9.1 header
                        // (built in onMailFrom). Empty when SPF was skipped — trusted/loopback
                        // session or the check disabled. Persisting it is what keeps an
                        // ACCEPTED-but-not-clean verdict (permerror, or fail/softfail on a
                        // tag-only site) visible instead of silently discarded.
                        receivedSpf: session?.spfHeader || '',
                        // RFC 8601 Authentication-Results for DKIM / DMARC ('' when not evaluated).
                        authResults: auth ? auth.header : '',
                        // The sender's own Reply-To, so the webmail's Reply goes where they asked.
                        replyTo: (parsed.replyTo && parsed.replyTo.value && parsed.replyTo.value[0] && parsed.replyTo.value[0].address) || '',
                        quarantined,
                        threadId: 0, // per mailbox — see threadFor
                        attachments: parsed.attachments,
                        // Spam goes to the SPAM FOLDER (reviewable, auto-purged after 30 days by
                        // the queue sweep) — not silently into Trash with a mangled subject.
                        isSpam: (isSpam || quarantined) ? 1 : 0
                    };

                    // Deliver one copy into a REAL mailbox (filed by the site lists + the owner's rules).
                    const deliverTo = async (mailbox, toAddress) => {
                        if (deliveredTo.has(mailbox.id)) return;
                        deliveredTo.add(mailbox.id);
                        const res = await deliverLocalCopy(mailbox, { ...baseCopy, toAddress, threadId: await threadFor(mailbox) });
                        if (!res.ok) { quotaRejected++; return; }
                        storedCount++;
                        if (!res.quiet) {
                            await wordjs.notify({
                                user_id: mailbox.id,
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
                        // ...and only to a sender SPF authenticated (see vacationSenderVerified):
                        // otherwise a forged From turns the mailbox into a reflector.
                        if (!res.filing.isSpam && !autoGenerated
                            && vacationSenderVerified(session?.spfHeader, session?.envelope?.mailFrom?.address, fromAddr)) {
                            maybeVacationAutoReply(mailbox, fromAddr, parsed.subject).catch(() => { });
                        }
                        if (res.forwardTo && !alreadyForwarded) {
                            pendingForwards.push({ via: String(mailbox.userEmail || '').toLowerCase(), to: [res.forwardTo], rowId: res.row && res.row.id, rateKey: mailbox.id });
                        }
                    };

                    for (const addr of toAddresses) {
                        if (!addr || !addr.address) continue;
                        const [recName, recDomain] = addr.address.toLowerCase().split('@');

                        // Only ACCEPT/store inbound mail for OUR MAIL DOMAIN. A recipient on any external
                        // domain (a user's personal gmail.com, or a foreign address) must never be
                        // captured into a WordJS inbox, and catch-all stays scoped to @mailDomain (never a
                        // blanket accept-anything that would hoard mail meant for other providers).
                        //
                        // A user only receives here when mailboxAddressOf() gives them an address: the
                        // ADMIN-ENABLED mailbox grant PLUS an account address genuinely on this domain.
                        // The grant half is what closes the inbox-hijack — before it, self-setting an
                        // unused corporate address on your own account was enough to have that address's
                        // incoming mail delivered to you.
                        const isLocalDomain = !!(recDomain && recDomain === mailDomain);
                        if (!isLocalDomain) continue;
                        let user = null;
                        const candidate = await User.findByEmail(addr.address) || await User.findByLogin(recName);
                        if (mailboxAddressOf(candidate, mailDomain)) {
                            user = candidate;
                        }
                        if (user) {
                            await deliverTo(user, user.userEmail);
                            continue;
                        }

                        // An ALIAS / distribution list: copies for its local members, forwards for the rest.
                        const exp = await expandAlias(recName, mailDomain);
                        if (exp.alias) {
                            for (const member of exp.users) await deliverTo(member, addr.address);
                            if (exp.forwards.length > 0 && !alreadyForwarded) {
                                pendingForwards.push({ via: addr.address.toLowerCase(), to: exp.forwards, rowId: 0 });
                            }
                            if (exp.users.length === 0) storedCount++; // a forward-only alias still accepted it
                            continue;
                        }

                        // Catch-all mail (no matching mailbox) is OWNED BY THE SITE ADMIN — previously it
                        // was stored with no owner and matched nobody's address, i.e. it vanished.
                        if (catchAllRaw === '1') {
                            const owner = await getAdminUser();
                            if (owner && owner.id) {
                                await deliverTo(owner, addr.address);
                            } else {
                                await Email.create({ ...baseCopy, toAddress: addr.address, userId: 0 });
                                storedCount++;
                            }
                        }
                    }

                    // Forwards run after the transaction is accepted and never fail it. Spam is not
                    // forwarded (it would spend OUR reputation on someone else's junk).
                    if (pendingForwards.length > 0 && !isSpam && !quarantined && !autoGenerated) {
                        (async () => {
                            let staged = null;
                            for (const f of pendingForwards) {
                                let attachments = f.rowId ? await storedAttachmentPaths(f.rowId) : null;
                                if (!attachments) {
                                    if (!staged) staged = await stageAttachmentBuffers(parsed.attachments);
                                    attachments = staged;
                                }
                                await forwardMessage({
                                    via: f.via, to: f.to, from: fromAddr, fromName,
                                    subject: parsed.subject || '(no subject)', text: parsed.text || '',
                                    html: baseCopy.bodyHtml, attachments, rateKey: f.rateKey
                                });
                            }
                            if (staged) await unstage(staged);
                        })().catch((e) => console.error('[MailServer] Inbound forward failed:', e.message));
                    }

                    // Every mailbox it was for is full: ask the sender to retry later (452, RFC 5321 §4.5.3.1.10)
                    // instead of accepting mail we did not store.
                    if (storedCount === 0 && quotaRejected > 0) {
                        return callback(smtpError(452, '4.2.2 Mailbox full, try again later'));
                    }
                    callback();
                } catch (error) {
                    console.error('Failed to store incoming email:', error);
                    callback(error);
                }
            })).catch(callback);
        }
    };

    // smtp:inbound — on every platform the plugin sandbox refuses an isolated plugin a listening socket, so
    // the HOST opens port 25 for the one plugin an administrator granted this exclusive capability and asks
    // these same handlers what to do at each step (core/inbound-smtp.ts). Without the grant (or on an older
    // core) the plugin keeps its own listener below, which works only where its platform allows one.
    if (wordjs && wordjs.smtp && typeof wordjs.smtp.listen === 'function') {
        const viaCallback = (fn, ...args) => new Promise((resolve) => {
            try {
                fn(...args, (err) => resolve(err ? { code: err.responseCode || 550, message: err.message } : null));
            } catch (e) {
                resolve({ code: 451, message: 'Temporary local problem, try again later' });
            }
        });
        const handlers = {
            connect: (session) => viaCallback(serverOptions.onConnect, session),
            mailFrom: (address, session) => viaCallback(serverOptions.onMailFrom, address, session),
            rcptTo: (address, session) => viaCallback(serverOptions.onRcptTo, address, session),
            // mailparser takes the raw message Buffer directly.
            data: (raw, session) => viaCallback(serverOptions.onData, raw, session),
            close: () => { },
        };
        const listenOn = (p) => wordjs.smtp.listen(handlers, { port: p, fallbackPort: 2525, maxSize: serverOptions.size, maxClients: serverOptions.maxClients, proxyIps: trustedProxyIps, name: greetingName }).catch((e) => ({ ok: false, granted: false, error: e && e.message }));
        let res = await listenOn(port);
        // The host opens only the ports this plugin declares (claimPorts: 25) and unprivileged ones (1024+).
        // An smtp_listen_port it refuses must not leave the server with NO listener: fall back to the
        // standard port and say which port was refused and why.
        if (res && res.granted && !res.ok && !res.boundPort && port !== 25) {
            const refusal = res.error || res.reason || 'refused by the host';
            res = await listenOn(25);
            if (res && res.granted) {
                const note = `smtp_listen_port ${port} could not be used (${refusal}); listening on ${res.boundPort || 25} instead.`;
                res.reason = res.reason ? `${note} ${res.reason}` : note;
                res.degraded = true;
                console.warn(`   ⚠️  Inbound SMTP: ${note}`);
            }
        }
        if (res && res.granted) {
            inboundStatus = {
                requestedPort: res.requestedPort || port, boundPort: res.boundPort || null, degraded: !!res.degraded,
                reason: res.ok ? (res.reason || null) : (res.reason || res.error || 'the host could not open the inbound SMTP port'),
                proxyIps: res.proxyIps || trustedProxyIps, mode: 'host',
                // The STARTTLS certificate the host presents for us (subject / expiry, never the key).
                tls: res.tls || null,
                // Where the host listens: its addresses (the sandbox hides the interfaces from us).
                addresses: res.addresses || null
            };
            if (res.ok) console.log(`   ✓ Inbound SMTP: the host is listening on port ${res.boundPort} for this plugin (smtp:inbound).`);
            else console.warn(`   ⚠️  Inbound SMTP: the host could not listen for this plugin: ${inboundStatus.reason}`);
            return;
        }
    }

    smtpServer = new SMTPServer(serverOptions);


    inboundStatus = { requestedPort: port, boundPort: null, degraded: false, reason: null, proxyIps: trustedProxyIps };

    // Probe-then-bind. Rebinding a net.Server after a listen error is unreliable, so instead of trying
    // to recover from a failed bind we TEST whether the standard port 25 is bindable first, with a
    // throwaway socket. If it isn't, fall back to the unprivileged 2525 and record WHY (inboundPortReason)
    // so the admin UI can tell the operator what actually stands between the internet and this listener.
    // A non-25 operator override is respected as-is.
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
            inboundStatus.reason = inboundPortReason(probe.code);
            port = 2525;
        }
    }

    smtpServer.on('error', err => {
        console.error('   ✗ Inbound SMTP Server error:', err.message);
    });

    smtpServer.listen(port, () => {
        inboundStatus.boundPort = port;
        if (inboundStatus.degraded) {
            console.warn(`   ⚠️  Inbound SMTP: could not bind port 25 (${inboundStatus.reason}). Fell back to ${port}. Internet mail is delivered to port 25, so EXTERNAL inbound will NOT arrive until port 25 reaches this listener (see the reason above). Local + relay mail are unaffected.`);
        } else {
            const note = port === 25 ? '' : ` — NON-STANDARD: internet mail expects port 25, so map 25 → ${port}`;
            console.log(`   ✓ Inbound SMTP Server listening on port ${port} (Domain: ${mailDomain})${note}`);
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
// Site and provider mail (user_id 0: password resets, notifications, other plugins' transactional mail)
// has no account to charge; its automatic retries draw on this budget of their own, sized for a busy
// site, so they never compete with — or are starved by — anything a user sends.
const SITE_RETRY_LIMITS = { messages: 1000, recipients: 5000 };
const SITE_RETRY_KEY = 'retry:site';
function outboundRateLimitOk(userId, recipientCount, limits = null) {
    const maxMessages = (limits && limits.messages) || OUTBOUND_MAX_MESSAGES;
    const maxRecipients = (limits && limits.recipients) || OUTBOUND_MAX_RECIPIENTS;
    const now = Date.now();
    let e = _outboundUsage.get(userId);
    if (!e || now - e.windowStart > OUTBOUND_WINDOW_MS) {
        e = { windowStart: now, messages: 0, recipients: 0 };
        _outboundUsage.set(userId, e);
    }
    if (e.messages + 1 > maxMessages) return false;
    if (e.recipients + recipientCount > maxRecipients) return false;
    e.messages += 1;
    e.recipients += recipientCount;
    return true;
}

// The background queues (scheduled sends and automatic retries) deliver on their own clock, so the
// limit has to hold THERE too — a row is only as rate-limited as the last check it passed. POST /send
// already charges a message when it queues it for the undo window / a schedule; it records that charge
// here so the dispatch does not count the same message twice. Anything the queue picks up WITHOUT a
// matching charge (or with more recipients than were charged) is charged at dispatch.
const _queuedCharges = new Map(); // email id -> recipients already charged by POST /send
const QUEUED_CHARGES_MAX = 10000;
const RATE_LIMIT_DEFER_MS = 5 * 60 * 1000;
function noteQueuedCharge(emailId, recipientCount) {
    const id = parseInt(emailId, 10) || 0;
    if (!id) return;
    _queuedCharges.delete(id);
    if (_queuedCharges.size >= QUEUED_CHARGES_MAX) _queuedCharges.delete(_queuedCharges.keys().next().value);
    _queuedCharges.set(id, recipientCount);
}
function queueRateKey(email) {
    const uid = parseInt(email && email.user_id, 10) || 0;
    return uid > 0 ? uid : 'queue:site';
}
function queuedDispatchAllowed(email, recipientCount) {
    const id = parseInt(email && email.id, 10) || 0;
    const charged = _queuedCharges.get(id);
    _queuedCharges.delete(id);
    if (charged !== undefined && recipientCount <= charged) return true;
    return outboundRateLimitOk(queueRateKey(email), recipientCount);
}

// The automatic retry queue re-sends ONE message up to MAX_DELIVERY_ATTEMPTS times: it is charged once
// for that message, not on every pass. A user's message was charged when it was sent (POST /send, the
// scheduled queue, a forward, a manual retry) — updateRetryState records that charge when the send
// leaves the row waiting for a retry — so its retries cost nothing more. A row the queue meets without
// a recorded charge (site/provider mail, or a row from before a restart) is charged at its first pass:
// to its owner, or to the site's own retry budget when nobody owns it.
const _retryCharges = new Map(); // email id -> recipients its retry cycle is already paid for
function noteRetryCharge(emailId, recipientCount) {
    const id = parseInt(emailId, 10) || 0;
    if (!id) return;
    _retryCharges.delete(id);
    if (_retryCharges.size >= QUEUED_CHARGES_MAX) _retryCharges.delete(_retryCharges.keys().next().value);
    _retryCharges.set(id, recipientCount);
}
function retryDispatchAllowed(email, recipientCount) {
    const id = parseInt(email && email.id, 10) || 0;
    const charged = _retryCharges.get(id);
    if (charged !== undefined && recipientCount <= charged) return true;
    const uid = parseInt(email && email.user_id, 10) || 0;
    const ok = uid > 0
        ? outboundRateLimitOk(uid, recipientCount)
        : outboundRateLimitOk(SITE_RETRY_KEY, recipientCount, SITE_RETRY_LIMITS);
    if (ok) noteRetryCharge(id, recipientCount);
    return ok;
}

// THE GENERAL QUEUE'S SENDING RATE ("Messages per minute", the queue screen). A cap on every message
// handed to the outside world — user mail, scheduled sends, retries, the site's and other plugins' mail —
// counted once per message whatever its recipients, shared by every node (lib/send-rate.js). A message
// over the cap is not refused and not lost: it waits in the queue (`paced`) and goes out in a later
// minute, in order. While messages wait, new mail queues behind them. Three kinds go out at once and
// still count: account mail the core marks (password reset, address verification), the delivery test,
// and an administrator's "Retry now". 0 = no cap (the default: the behaviour before the setting).
const SEND_RATE_OPTION = 'mail_queue_per_minute';
let _sendRateCache = { at: 0, value: 0 };
async function sendRateLimit() {
    if (Date.now() - _sendRateCache.at < 5000) return _sendRateCache.value;
    const value = parsePerMinute(await getOption(SEND_RATE_OPTION, '0'));
    _sendRateCache = { at: Date.now(), value };
    return value;
}
function forgetSendRateLimit() { _sendRateCache = { at: 0, value: 0 }; }

// === SYSTEM SENT LOG ===============================================================================
// Mail the SITE sends — no mailbox owns it: the core's and other plugins' mail through the provider,
// the email notification transport — is recorded in wjp_mail_server_system_sent (lib/mail-admin-store)
// so an administrator can see it after it left the queue. A user's own mail is never recorded: it has
// its Sent folder. Kept for `mail_system_sent_retention` days (7/30/90/180, 0 = keep nothing; default
// 30) and purged on the queue's sweep. Bodies are stored for the admin's preview and NEVER logged.
const SYSTEM_SENT_RETENTION_OPTION = 'mail_system_sent_retention';
// Who handed a message over. A Symbol, so it is set only by this file's own wrappers and never by a
// field a caller put on the message (the provider's messages arrive as plain data over the bridge).
const SYSTEM_SOURCE = Symbol('mail-server:system-source');
let _retentionCache = { at: 0, value: null };
async function systemSentRetentionDays() {
    if (_retentionCache.value !== null && Date.now() - _retentionCache.at < 30 * 1000) return _retentionCache.value;
    const value = createAdminStore.normalizeRetentionDays(await getOption(SYSTEM_SENT_RETENTION_OPTION, String(createAdminStore.SYSTEM_SENT_RETENTION_DEFAULT)));
    _retentionCache = { at: Date.now(), value };
    return value;
}
function forgetSystemSentRetention() { _retentionCache = { at: 0, value: null }; }
let _lastSystemSentPurge = 0; // last retention sweep of the system Sent log (at most hourly)
let _lastInterruptedSweep = 0; // last sweep for interrupted first deliveries (at most every 5 min)

/** Mark a message as handed over by `source` (see SYSTEM_SOURCE). Returns the same object. */
function fromSource(msg, source) {
    if (msg && typeof msg === 'object') msg[SYSTEM_SOURCE] = source;
    return msg;
}

/**
 * The rate gate in front of external delivery. Answers null when the message may go out now, or the
 * moment (ms) it is held until. `data.paceClaimed`: the queue already claimed its slot (in order).
 */
async function sendRateGate(data, sentRecordId) {
    if (!SendRate || data.paceClaimed) return null;
    const limit = await sendRateLimit();
    if (!(limit > 0)) return null;
    // A message with no queue row to wait on (an alias forward) cannot be held: it goes out and counts.
    const force = data.priority === 'account' || !!data.noRetry || !!data.paceForce || !sentRecordId;
    // In order: while messages are waiting for the rate, new mail waits behind them.
    if (!force && await Email.countPaced() > 0) {
        return (Math.floor(Date.now() / SendRate.MINUTE_MS) + 1) * SendRate.MINUTE_MS;
    }
    const c = await SendRate.claim({ force });
    return c.ok ? null : c.retryAt;
}

/** Hold a message for the rate: its external recipients wait on its row, in order (see markPaced). */
async function holdForSendRate(sentRecordId, data, externalRecipients, until, note = 'Waiting for the queue\'s sending rate') {
    try {
        // The recipients still to reach, as a retry would store them. This runs FIRST: the rewrite clears
        // the delivery state, and markPaced below sets it. NOT-A-USER-PATH: the delivery state machine's
        // own row (the store refuses a rewrite that would drop a party from an un-attributed row).
        await Email.update(sentRecordId, { toAddress: externalRecipients.join(', ') });
    } catch (e) { /* non-fatal */ }
    // NOT-A-USER-PATH: the same row, mid-delivery.
    await Email.markPaced(sentRecordId, new Date(until).toISOString(), note);
    // Waiting is not a delivery attempt: the pass that sends it later costs nothing more (users and site).
    noteRetryCharge(sentRecordId, externalRecipients.length);
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

// === THE SENDING IDENTITY IS MINTED FROM AN ACCOUNT, NEVER READ OFF A ROW =====================
//
// THE FINDING. `from_address` is the one address column update() cannot rewrite, so on a pre-v2.1
// shared row (user_id = 0, several local parties) it SURVIVES every rewrite — and the scheduled-send
// queue used it verbatim as `fromEmail`. A party to such a row could therefore make the queue emit a
// message, signed with the SITE's DKIM key, whose From is a COLLEAGUE'S address; local copies were
// written with that same address, so the colleague's own mailbox showed mail "from the boss".
// sendMail never checked that the From it was handed belonged to whoever asked for the send.
//
// THE SHAPE OF THE FIX. A string cannot carry provenance, so the identity is no longer a string
// argument: it is a token these two functions mint FROM AN ACCOUNT OBJECT, tagged with a
// module-private Symbol. `data.fromEmail` is dead as an input — sendMail ignores it (see below) —
// so there is no spelling of a row column that can become a sending identity, and a queue that only
// has a row must resolve the row's OWNER (user_id) to send at all. For an un-attributed row there is
// no owner, so there is no user identity: it goes out as the site itself, which is the only identity
// the server can actually vouch for.
//
// READERS AND WRITERS OF THE FROM HEADER, enumerated, because half a change is what produced the
// finding: the only WRITER is `fromEmail` inside sendMail, computed solely from an identity token or
// the site options; the READERS are the wire From/DKIM alignment (deliverDirect), the stored Sent
// copy, the local inbox copies, the Message-ID right-hand side and sendBounce — and sendMail writes
// the resolved value back into `data.fromEmail` before any of them runs, so all five read the value
// the identity produced rather than the one the caller passed.
const SENDING_IDENTITY = Symbol('mail-server:sending-identity');

/**
 * An ACCOUNT sends as its MAILBOX ADDRESS — mailboxAddressOf(), the very predicate delivery uses — and
 * never as its account email when that is anywhere else. The route gate is the grant alone
 * (hasCorporateMailbox), so an account an administrator gave a mailbox while its email is personal
 * (someone@gmail.com), or one whose primary email moved off the domain, passes the gate yet has no
 * address here: it used to send with that PERSONAL address in From (local copies, the Sent record, the
 * relay path) or in Reply-To (direct-to-MX, after the alignment rewrite), so replies leaked to a private
 * inbox. Such an account now gets this refusal instead — a clear one, never a quiet fallback.
 */
const NO_MAILBOX_ADDRESS = 'mail_no_mailbox_address';
function noMailboxAddressError(mailDomain) {
    const e = new Error(mailDomain
        ? `This account has no address on the mail domain (${mailDomain}), so it cannot send mail from here. An administrator can give it one: Users → edit user → account email <name>@${mailDomain}.`
        : 'This account has no address on the mail domain, so it cannot send mail from here.');
    e.code = NO_MAILBOX_ADDRESS;
    return e;
}

/** The token itself, from an address that is already known to be a mailbox address on our domain. */
function identityFromMailboxAddress(address, name) {
    return { [SENDING_IDENTITY]: true, fromEmail: String(address).trim().toLowerCase(), fromName: String(name || '') };
}

/**
 * Mint the sending identity OF AN ACCOUNT (the requester, or a row's resolved owner): its mailbox address
 * on the mail domain. Throws NO_MAILBOX_ADDRESS when the account has none — every caller is a send made
 * on that account's behalf, which must not go out under any other address.
 *
 * The one exception keeps the catch-all working: an ADMINISTRATOR without a mailbox of their own still
 * owns the site's catch-all inbox (see canUseMailSurface), and answers that mail AS THE SITE — null, the
 * site identity every un-attributed message already uses — never as their own personal address.
 */
/**
 * The name an account sends under: its directory display name. The request's user is not a reliable
 * source (the host fills its displayName with the login), so the login ("m4a") was the From name of
 * every webmail send and every Sent copy, while recipients of queued mail saw the real name.
 */
async function displayNameOf(user) {
    if (!user) return '';
    const login = user.username || user.userLogin || '';
    if (user.id) {
        try {
            const full = await User.findById(user.id);
            const n = full && String(full.displayName || '').trim();
            if (n) return n;
        } catch (e) { /* fall back to what the request carries */ }
    }
    return String(user.displayName || '').trim() || login;
}

async function sendingIdentityOf(user, mailDomain) {
    const domain = mailDomain || await getMailDomain().catch(() => '');
    const address = mailboxAddressOf(user, domain);
    if (!address && user && user.role === 'administrator') return null;
    if (!address) throw noMailboxAddressError(domain);
    return identityFromMailboxAddress(address, await displayNameOf(user));
}

/**
 * Mint the sending identity of the OWNER of a stored row — resolved from `user_id`, which is the
 * ownership verdict itself, and never from the row's own from_address.
 *
 * Returns null for an un-attributed row (user_id = 0): nobody owns it, so nobody's identity may be
 * spent on it. The caller then sends as the site (queue) or refuses (a user-facing route).
 */
async function sendingIdentityOfOwner(userId) {
    const uid = parseInt(userId, 10) || 0;
    if (!(uid > 0)) return null;
    // NOT-A-DELIVERY-PATH: resolves the OWNER of an outbound row to use as its sending identity. It
    // turns no recipient address into an inbox and writes no row.
    const owner = await User.findById(uid).catch(() => null);
    return owner ? await sendingIdentityOf(owner) : null;
}

// === LOCAL DELIVERY POLICY: quotas, block lists, filing rules, aliases, forwarding ================
//
// Every copy that lands in a local mailbox — inbound SMTP (onData) and internal mail (sendMail) — goes
// through deliverLocalCopy(), so the two paths can never disagree about quota, blocked senders or the
// owner's rules. The policy values are admin options, read at most every 30s.

let _policyCache = { at: 0, value: null };
async function getDeliveryPolicy() {
    const now = Date.now();
    if (_policyCache.value && now - _policyCache.at < 30 * 1000) return _policyCache.value;
    const o = await getOptionsBatch({
        mail_blocked_senders: '', mail_allowed_senders: '', mail_quota_default_mb: '0', mail_forwarding_allowed: '1'
    });
    const value = {
        blocked: MailRules.normalizeSenderList(o.mail_blocked_senders, 2000),
        allowed: MailRules.normalizeSenderList(o.mail_allowed_senders, 2000),
        defaultQuotaMb: Math.max(parseInt(o.mail_quota_default_mb, 10) || 0, 0),
        forwardingAllowed: o.mail_forwarding_allowed !== '0',
    };
    _policyCache = { at: now, value };
    return value;
}
function invalidateDeliveryPolicy() { _policyCache = { at: 0, value: null }; }

// Usage per mailbox, cached briefly: a burst of inbound mail must not run the SUM per message.
const _usageCache = new Map(); // userId -> { at, bytes, messages }
async function mailboxUsage(userId, fresh = false) {
    const hit = _usageCache.get(userId);
    if (!fresh && hit && Date.now() - hit.at < 60 * 1000) return hit;
    const u = await Admin.usageOf(userId);
    const entry = { at: Date.now(), bytes: u.bytes, messages: u.messages };
    _usageCache.set(userId, entry);
    if (_usageCache.size > 5000) _usageCache.clear();
    return entry;
}

/** The quota that applies to a mailbox, in MB (0 = unlimited). */
async function effectiveQuotaMb(userId) {
    const [override, policy] = await Promise.all([Admin.getQuotaOverride(userId), getDeliveryPolicy()]);
    return override >= 0 ? override : policy.defaultQuotaMb;
}

async function quotaStatus(userId, fresh = false) {
    const [usage, quotaMb] = await Promise.all([mailboxUsage(userId, fresh), effectiveQuotaMb(userId)]);
    const quotaBytes = quotaMb > 0 ? quotaMb * 1024 * 1024 : 0;
    return {
        usedBytes: usage.bytes,
        messages: usage.messages,
        quotaMb,
        percent: quotaBytes ? Math.min(100, Math.round((usage.bytes / quotaBytes) * 1000) / 10) : 0,
        full: quotaBytes > 0 && usage.bytes >= quotaBytes,
    };
}

/**
 * Store ONE copy in `user`'s mailbox, filed by the site lists and the owner's own rules.
 * @returns {{ ok: true, row, filing, quiet, prefs } | { ok: false, reason: 'quota' }}
 */
async function deliverLocalCopy(user, createData) {
    const q = await quotaStatus(user.id);
    if (q.full) return { ok: false, reason: 'quota' };
    // A HARD quota: the copy must fit, measured the way usage is (stored bodies + attachments). Checking
    // only "already full" let one large message far past the limit in (1 MB quota, 1.2 MB accepted).
    if (q.quotaMb > 0) {
        const len = (v) => (typeof v === 'string' ? v.length : 0);
        let incoming = len(createData.bodyText) + len(createData.bodyHtml) + len(createData.rawContent);
        for (const a of (createData.attachments || [])) {
            incoming += Number(a && a.size) || (a && a.content && a.content.length) || 0;
        }
        if (q.usedBytes + incoming > q.quotaMb * 1024 * 1024) return { ok: false, reason: 'quota' };
    }

    const [prefs, policy] = await Promise.all([Email.getPrefs(user.id).catch(() => ({})), getDeliveryPolicy()]);
    const filing = MailRules.evaluateDelivery(prefs, {
        from: createData.fromAddress,
        fromName: createData.fromName,
        to: createData.toAddress,
        cc: createData.ccAddress,
        subject: createData.subject,
        text: createData.bodyText,
        isSpam: !!createData.isSpam,
    }, policy);

    // Auto-forward without "keep a copy" files the local copy away (read + archived) instead of
    // deleting it: nothing is ever lost because a forward failed downstream.
    const fwd = MailRules.normalizeForwarding(prefs && prefs.forwarding);
    const forwardsAway = fwd.enabled && !fwd.keepCopy && policy.forwardingAllowed && !filing.isSpam;

    const row = await Email.create({
        ...createData,
        userId: user.id,
        isRead: filing.isRead || (forwardsAway ? 1 : 0),
        isStarred: filing.isStarred,
        isArchived: filing.isArchived || (forwardsAway ? 1 : 0),
        isTrash: filing.isTrash,
        // A DMARC quarantine verdict files the copy in Spam whatever the owner's rules say.
        isSpam: (filing.isSpam || createData.quarantined) ? 1 : 0,
    });
    // A rule may only apply the owner's OWN labels — re-checked here so a stale label id in the prefs
    // (deleted, or never theirs) is simply skipped.
    for (const lid of filing.labelIds) {
        try {
            const label = await Email.findLabel(lid, user.id);
            // NOT-A-USER-PATH: delivery. row is the copy Email.create JUST wrote for this owner and the
            // label was re-checked to be theirs on the line above; no request chose either id.
            if (label && row) await Email.addLabelToEmails([row.id], label.id);
        } catch (e) { /* a label failure never loses the message */ }
    }
    // Keep the cached usage honest between refreshes: the bodies AND the attachments this copy stored.
    // Counting the text alone let a mailbox with a 1 MB quota take message after message carrying
    // megabytes of attachments until the cache expired (found in the production lab).
    const hit = _usageCache.get(user.id);
    if (hit) {
        let added = String(createData.bodyText || '').length + String(createData.bodyHtml || '').length + String(createData.rawContent || '').length;
        for (const att of (createData.attachments || [])) {
            added += (att && att.content && att.content.length) || (att && Number(att.size)) || 0;
        }
        hit.bytes += added;
    }
    // Quiet filing (read, archived, trashed or spam) gets no "new mail" notification.
    const quiet = !!(filing.isSpam || createData.quarantined || filing.isTrash || filing.isRead || filing.isArchived || forwardsAway);
    const forwardTo = (fwd.enabled && policy.forwardingAllowed && !filing.isSpam && !createData.quarantined && !filing.isTrash) ? fwd.address : '';
    return { ok: true, row, filing, quiet, prefs, forwardTo };
}

/**
 * Expand a local-domain address that is NOT a mailbox into its alias destinations.
 * Local destinations become mailboxes (same delivery predicate as everywhere: mailboxAddressOf);
 * everything else is an external forward. One level of nesting: an alias may name another alias.
 */
async function expandAlias(localPart, mailDomain, depth = 0) {
    const out = { alias: null, users: [], forwards: [] };
    if (!Admin) return out;
    const alias = await Admin.findAliasByLocalPart(localPart).catch(() => null);
    if (!alias) return out;
    out.alias = alias;
    for (const dest of alias.destinations) {
        const [dLocal, dDomain] = dest.split('@');
        if (dDomain === mailDomain) {
            // The candidate only receives when mailboxAddressOf() confirms the admin grant AND an
            // address on this domain — the same predicate as a direct recipient.
            const candidate = await User.findByEmail(dest).catch(() => null);
            let member = null;
            if (mailboxAddressOf(candidate, mailDomain)) { member = candidate; }
            if (member) {
                if (!out.users.some(u => u.id === member.id)) out.users.push(member);
            } else if (depth < 1) {
                const nested = await expandAlias(dLocal, mailDomain, depth + 1);
                for (const u of nested.users) if (!out.users.some(x => x.id === u.id)) out.users.push(u);
                for (const f of nested.forwards) if (!out.forwards.includes(f)) out.forwards.push(f);
            }
        } else if (!out.forwards.includes(dest)) {
            out.forwards.push(dest);
        }
    }
    return out;
}

// Write inbound attachment buffers into the plugin's own attachment dir (a registered attachment
// root) so a forward can send them; the caller removes them afterwards.
async function stageAttachmentBuffers(list) {
    const staged = [];
    for (const att of (list || [])) {
        if (!att || !att.content) continue;
        const name = crypto.randomBytes(16).toString('hex') + '.bin';
        const full = path.join(UPLOAD_DIR, name);
        try {
            await fs.promises.writeFile(full, att.content);
            staged.push({ filename: att.filename || 'attachment', path: full });
        } catch (e) { /* skip this one */ }
    }
    return staged;
}
async function unstage(staged) {
    for (const s of (staged || [])) { try { await fs.promises.unlink(s.path); } catch (e) { /* gone */ } }
}

/** Attachments of a stored row, as paths a forward can send. */
async function storedAttachmentPaths(rowId) {
    if (!rowId) return [];
    try {
        // NOT-A-USER-PATH: delivery/forwarding. rowId is a copy the delivery path itself just stored;
        // the attachments leave only towards that mailbox's own configured forward.
        return (await Email.getAttachments(rowId)).map(a => ({ filename: a.filename, path: path.join(UPLOAD_DIR, a.storage_path) }));
    } catch (e) { return []; }
}

const FORWARD_HEADER = 'X-WordJS-Forwarded';

/**
 * Forward a delivered message to EXTERNAL addresses (alias destinations or a user's auto-forward).
 * Sent from the forwarding address (on our domain, so DKIM/SPF align) with the original sender in
 * Reply-To, tagged so a forward is never forwarded again, and counted against the outbound limit.
 */
async function forwardMessage({ via, viaName, to, from, fromName, subject, text, html, attachments, rateKey }) {
    const targets = [...new Set((to || []).map(a => String(a || '').toLowerCase()).filter(a => isValidEmail(a)))];
    if (targets.length === 0) return;
    if (!outboundRateLimitOk(rateKey || `fwd:${via}`, targets.length)) {
        console.warn(`[MailServer] Forward from ${via} skipped: outbound rate limit reached.`);
        return;
    }
    const label = `${fromName || from || 'Unknown sender'} (via ${via})`;
    try {
        await sendMail({
            to: targets,
            subject,
            text,
            html,
            replyTo: from || undefined,
            // `via` is the address the message was DELIVERED to — a mailbox or alias on our domain — minted
            // through the same mailbox rule as any account (and re-checked by sendMail before anything goes out).
            identity: await sendingIdentityOf({ userEmail: via, displayName: viaName || label, accountCapabilities: [MAILBOX_CAPABILITY] }),
            attachments: attachments || [],
            noSentCopy: true,
            isForward: true,
            extraHeaders: { [FORWARD_HEADER]: via },
        });
    } catch (e) {
        console.error(`[MailServer] Forward from ${via} failed: ${e.message}`);
    }
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
    // A Reply-To handed by the site or another plugin (contact-forms: the visitor) is ONE plain address.
    if (data.replyTo !== undefined) {
        const r = String(stripCRLF(data.replyTo) || '').trim();
        data.replyTo = MAIL_ADDRESS_RE.test(r) && r.length <= 320 ? r : undefined;
    }

    // A caller-supplied From is NOT an identity — see SENDING_IDENTITY above. Anything left in these
    // two fields is dropped here, before a single reader of them runs, so that a value carried on a
    // row (or on a request body reaching a provideMail consumer) can never reach the wire, the stored
    // copy or the bounce. They are re-populated below from the identity token, if there is one.
    delete data.fromEmail;
    delete data.fromName;
    const identity = (data.identity && data.identity[SENDING_IDENTITY]) ? data.identity : null;

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
    const [defaultName, optFromEmail, optFromName, dkimKey, dkimDomain, dkimSelector, siteDomain] = await Promise.all([
        getOption('blogname', 'WordJS'),
        getOption('mail_from_email', ''),
        getOption('mail_from_name', ''),
        getOption('mail_security_dkim_private_key', ''),
        getOption('mail_security_dkim_domain', ''),
        getOption('mail_security_dkim_selector', 'default'),
        getSiteDomain()
    ]);
    // THE mail domain, from the same one expression every other site uses (see getMailDomain) — built
    // from the values this wave already fetched instead of paying two more RPCs per message.
    const mailDomain = resolveMailDomain(dkimDomain, siteDomain);
    // THE CHOKE POINT for every user-identity send (webmail, queue, retry, vacation, forwards): the identity
    // must be an address on the mail domain. An account's personal address can never become a From, a
    // Reply-To, a stored Sent copy or a local copy's sender — see sendingIdentityOf.
    if (identity && mailboxDomainOf(identity.fromEmail) !== mailDomain) throw noMailboxAddressError(mailDomain);

    // stripCRLF the resolved fromEmail/fromName too (covers the admin-configured option fallbacks).
    // The identity token is the ONLY way a user address gets here; with no token the message is the
    // SITE's, which is the only other identity this server can vouch for.
    const fromEmail = stripCRLF((identity && identity.fromEmail) || siteSenderAddress(optFromEmail, mailDomain));
    const fromName = stripCRLF((identity && identity.fromName) || optFromName || defaultName);
    // Write the resolved identity back so every downstream reader of `data` — sendBounce is the one
    // outside this function — sees the address that was actually sent from, not the one it was asked
    // to send from. Two values for one header is how the row's from_address stayed alive.
    data.fromEmail = fromEmail;
    data.fromName = fromName;

    // One stable Message-ID reused for BOTH the stored Sent record AND the on-the-wire Message-ID
    // header. When the remote party replies, their In-Reply-To/References echo this exact value, so the
    // inbound handler can look it up and thread the reply back into this conversation (THREAD-XREF).
    //
    // KNOWN NIT (deliberately not fixed here): the right-hand side is derived from the ORIGINAL
    // fromEmail, so on the direct-to-MX path where the From is later rewritten for DMARC alignment the
    // Message-ID domain no longer matches the From domain. That is cosmetic — no receiver authenticates
    // the Message-ID — and it CANNOT be recomputed after the rewrite without desyncing the value already
    // persisted on the Sent record above, which is exactly what threading looks replies up by.
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
        } else if (data.noSentCopy) {
            // A forward (alias / auto-forward) is not something the forwarding mailbox "sent": no copy.
        } else if (draftId) {
            console.log(`[MailServer] Updating draft ${draftId} to Sent status.`);
            // NOT-A-USER-PATH: a continuation of POST /send, which has ALREADY put this row through
            // Email._ownsRow before calling sendMail — draftId is that same checked id. Note the gate
            // there answers the READ question while this call rewrites the address columns; for an
            // un-attributed row those columns ARE the ownership verdict, so the store itself refuses
            // any rewrite that would drop a party (mail_shared_row_party_narrowed). The route gate is
            // not load-bearing for that; the store is.
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
                // Remembered on the row so a queued retry goes out as an auto-reply again (null
                // return path + Auto-Submitted), not as the user's own mail.
                isAutoReply: data.isAutoReply ? 1 : 0,
                attachments: data.attachments
            });
            sentRecordId = sentRec ? sentRec.id : 0;
        }
    } catch (e) {
        console.error('[MailServer] Failed to save/update SENT record:', e);
        throw e; // If we can't save the sent record, we probably shouldn't send? Or warn?
    }

    // 1b. The system Sent log (see SYSTEM SENT LOG): a NEW message of the SITE — no mailbox identity and
    // no owning account. A retry, a scheduled draft or a forward is not a new message; a user's own mail
    // has its Sent folder. The status follows the queue row from here on (onDeliveryState).
    let systemLogId = 0;
    if (!identity && senderUserId === 0 && !isRetry && !draftId && !data.noSentCopy && Admin) {
        try {
            if (await systemSentRetentionDays() > 0) {
                systemLogId = await Admin.recordSystemSent({
                    emailId: sentRecordId,
                    messageId: outboundMessageId,
                    from: fromEmail.toLowerCase(),
                    fromName,
                    to: distinctRecipients,
                    subject: data.subject,
                    source: data[SYSTEM_SOURCE] || 'core',
                    html: data.html,
                    text: data.text,
                });
                if (systemLogId && sentRecordId) firstDeliveriesInFlight.set(sentRecordId, Date.now());
            }
        } catch (e) {
            // Never in the way of the delivery, and never the message itself in the log.
            console.error('[MailServer] Could not record the system message:', e && e.message);
        }
    }

    // 2. Deliver to Internal Users (Inbox Copy). mailDomain came from the parallel wave above.
    console.log(`[MailServer] Processing internal delivery for domain: ${mailDomain}`);

    // Track which recipients are local so we filter them out of SMTP
    const localRecipients = new Set();
    // Declared before local delivery: a full local mailbox is recorded as a (permanent) failure too.
    const delivered = [];
    const failed = [];
    // One inbox copy per MAILBOX per message: a mailbox named directly AND reached through an alias (or
    // through two aliases) gets the message once, as the inbound path already does (deliveredTo there).
    const deliveredMailboxIds = new Set();

    // On a retry pass the local inbox copies were already delivered on the first attempt;
    // the recipients we were handed are the still-failed EXTERNAL ones. Skip local delivery.
    for (const recipient of (isRetry ? [] : distinctRecipients)) {
        try {
            console.log(`[MailServer] Checking recipient: ${recipient}`);
            const [rName, rDomain] = recipient.split('@');
            // A recipient is LOCAL (delivered into a WordJS inbox) ONLY when it is a corporate mailbox on
            // OUR mail domain. A user's PERSONAL email (e.g. gmail.com) MUST be delivered OUT to that
            // provider, never captured locally — a user without a professional mailbox has no WordJS
            // inbox; their personal address is only for things like password recovery / external
            // notifications. (Previously `User.findByEmail(recipient)` matched regardless of domain, so
            // mail to a user's personal address was stored in WordJS instead of being sent to Gmail/etc.)
            let localUser = null;
            if (rDomain && rDomain === mailDomain) {
                const candidate = await User.findByEmail(recipient) || await User.findByLogin(rName);
                // Exactly the predicate the INBOUND path uses — mailboxAddressOf(): the admin-enabled
                // mailbox grant plus an account address really on this domain. Without the grant they
                // have no inbox even when a @mailDomain address maps to their username — deliver out.
                if (mailboxAddressOf(candidate, mailDomain)) {
                    localUser = candidate;
                }
            }

            // Not a mailbox but on our domain: maybe an ALIAS / distribution list.
            let targets = localUser ? [localUser] : [];
            let aliasForwards = [];
            let isAlias = false;
            if (!localUser && rDomain && rDomain === mailDomain) {
                const exp = await expandAlias(rName, mailDomain);
                if (exp.alias) {
                    isAlias = true;
                    targets = exp.users;
                    aliasForwards = data.isForward ? [] : exp.forwards;
                }
            }

            if (targets.length > 0 || isAlias) {
                // The address is ours (a mailbox or an alias): never relay it out over SMTP.
                localRecipients.add(recipient);
                const sendableAttachments = (data.attachments || []).filter(a => a && a.path);
                for (const target of targets) {
                    if (!target.id) continue;
                    if (deliveredMailboxIds.has(Number(target.id))) continue; // already has its copy (alias overlap)
                    deliveredMailboxIds.add(Number(target.id));
                    console.log(`[MailServer] Local mailbox found: ${target.id} (${target.username})`);
                    // Self-delivery: when the sender is also the recipient (e.g. replying to a message you
                    // sent yourself), the Sent copy already represents this message for that user. Creating a
                    // second "received" copy gives the thread two rows with the same thread_id, so the message
                    // shows up TWICE in the conversation view (and redundantly in the sender's own inbox).
                    // Skip the inbox copy for self-sends — the Sent record already covers it. (SELF-DUP)
                    if (String(target.userEmail || recipient).toLowerCase() === fromEmail.toLowerCase()) {
                        console.log(`[MailServer] Self-delivery to ${recipient} — skipping duplicate inbox copy.`);
                        continue;
                    }

                    // Local delivery: a copy in the recipient's mailbox, OWNED by that recipient (user_id is
                    // what folder listings key on) and filed by the site lists + the recipient's own rules.
                    const res = await deliverLocalCopy(target, {
                        messageId: `<local-${Date.now()}-${Math.random()}@wordjs.com>`,
                        fromAddress: fromEmail.toLowerCase(),
                        fromName: fromName,
                        toAddress: toAttendees.join(', '), // Preserve context
                        ccAddress: ccAttendees.join(', '),
                        subject: data.subject,
                        bodyText: data.text,
                        bodyHtml: data.html,
                        isSent: 0, // Received
                        rawContent: data.html || data.text,
                        parentId,
                        threadId,
                        replyTo: identity ? '' : (data.replyTo || ''),
                        attachments: data.attachments
                    });
                    if (!res.ok) {
                        console.warn(`[MailServer] Mailbox ${target.id} is over quota — ${recipient} not delivered.`);
                        failed.push({ recipient: target.userEmail || recipient, error: 'Mailbox full (quota exceeded)', permanent: true });
                        continue;
                    }
                    const inboxEmail = res.row;
                    console.log(`[MailServer] ✅ Delivered to local inbox: ${inboxEmail && inboxEmail.id}`);

                    if (!res.quiet && inboxEmail) {
                        await wordjs.notify({
                            user_id: target.id,
                            type: 'email',
                            title: 'New Internal Email',
                            message: `You have a new message from ${fromName}: "${data.subject}"`,
                            icon: 'fa-envelope',
                            color: 'indigo',
                            action_url: `/admin/plugin/emails?id=${inboxEmail.id}`,
                            transports: ['db', 'sse']
                        });
                    }
                    // Vacation auto-responder for internal mail too (Gmail replies regardless of
                    // where the sender is). Never triggered BY an auto-reply or a forward (loop guard).
                    if (!data.isAutoReply && !data.isForward && !res.filing.isSpam) {
                        maybeVacationAutoReply(target, fromEmail, data.subject).catch(() => { });
                    }
                    // The recipient's own auto-forward (to an external address).
                    if (res.forwardTo && !data.isForward && !data.isAutoReply) {
                        forwardMessage({
                            via: String(target.userEmail || '').toLowerCase(), to: [res.forwardTo],
                            from: fromEmail, fromName, subject: data.subject, text: data.text, html: data.html,
                            attachments: sendableAttachments, rateKey: target.id
                        }).catch(() => { });
                    }
                }
                if (aliasForwards.length > 0) {
                    forwardMessage({
                        via: recipient.toLowerCase(), to: aliasForwards,
                        from: fromEmail, fromName, subject: data.subject, text: data.text, html: data.html,
                        attachments: sendableAttachments
                    }).catch(() => { });
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

    // The general queue's sending rate (see sendRateGate): over the cap, the message waits in the queue.
    if (externalRecipients.length > 0) {
        const heldUntil = await sendRateGate(data, sentRecordId);
        if (heldUntil) {
            await holdForSendRate(sentRecordId, data, externalRecipients, heldUntil);
            console.log(`[MailServer] Message ${sentRecordId} waits for the queue's sending rate (${externalRecipients.length} recipient(s)).`);
            return { success: true, queued: true, delivered, failed: [], waiting: externalRecipients.length };
        }
    }

    if (externalRecipients.length > 0) {
        // Snapshot the relay ONCE: the same decision must drive both the From-rewrite below and the
        // delivery branch further down (a re-read could disagree if initTransporter() runs in between).
        // `relayConfigured` with no ready relay means the relay is DOWN: the mail waits, it never goes
        // direct-to-MX instead (see initTransporter).
        // In 'fallback' mode the relay is only the backup of direct delivery: everything below that
        // depends on "a relay is configured" (the From rewrite, "never direct while it is down") follows
        // the direct-delivery rules instead.
        const mode = await relayMode();
        const relay = await readyRelay();
        const relayConfigured = mode === 'fallback' ? false : (!!relay || relayStatus.configured);

        // DMARC/SPF ALIGNMENT (DIRECT-TO-MX ONLY): when WE are the MTA, we may only send as a domain we
        // can actually AUTHENTICATE for (the one our DKIM key signs and our SPF/PTR cover). A user whose
        // account email is on an EXTERNAL provider (e.g. someone@gmail.com) would otherwise make us emit
        // `From: someone@gmail.com` straight from our IP — which every DMARC-enforcing receiver rejects:
        //   "550-5.7.26 Unauthenticated email from gmail.com is not accepted due to domain's DMARC policy"
        // So we rewrite the wire identity to our own domain and put the user's real address in Reply-To,
        // so replies still reach the human. LOCAL/internal delivery and the stored Sent copy keep the
        // original address (no DMARC involved there).
        //
        // TWO CASES WHERE REWRITING IS WRONG AND MUST BE SKIPPED:
        //  1. A RELAY/SMARTHOST IS CONFIGURED. Then the smarthost — not us — owns authentication and
        //     alignment: it signs with its own DKIM key and its SPF covers its own IPs, and it enforces
        //     which senders the authenticated account may use. Forcing postmaster@<sendingDomain> there
        //     just hands it an identity the account is not authorized for, and it refuses the message
        //     ("Sender address rejected: not owned by user" / SendGrid "does not match a verified Sender
        //     Identity"). Leave the operator's From alone on this path.
        //  2. sendingDomain IS NOT A REAL PUBLIC DOMAIN. On a LAN/homelab install siteDomain is an IP
        //     literal or 'localhost' (see isPublicSendingDomain), so the "aligned" address we would
        //     synthesize — postmaster@192.168.1.50 — is undeliverable and unverifiable. Keeping the
        //     original From is strictly better.
        //
        // DELIBERATE (reviewed): sendingDomain is the DKIM domain if one is set, else the RAW site
        // hostname — INCLUDING a 'www.' prefix. So a site at https://www.acme.com with no DKIM key
        // rewrites From: admin@acme.com to postmaster@www.acme.com, even though acme.com's own SPF may
        // already cover us. We keep it, because the alternative is worse than the cosmetic cost:
        //   - This is EXACTLY the domain the DNS-records page tells the operator to publish SPF, DKIM,
        //     DMARC and MX on (it derives its `domain` the same way — dkimDomain || getSiteDomain()).
        //     An operator who followed that page has records on www.acme.com and NOT necessarily on
        //     acme.com, so postmaster@www.acme.com is the address we can actually authenticate for.
        //   - Gating the rewrite on "a DKIM key is configured" would silently stop aligning for every
        //     SPF-only install (SPF is published by hand from that same page; DKIM needs a key
        //     generated in the UI), sending unauthenticated cross-domain From straight at DMARC
        //     enforcers — the exact failure this rewrite exists to prevent.
        //   - The escape hatch already exists and is one setting: mail_security_dkim_domain wins over
        //     siteDomain here AND on the DNS-records page, so an operator who wants the bare apex sets
        //     it to acme.com and both the rewrite target and the records to publish move together.
        // THE mail domain — the same one expression as the HELO host, the DNS-records page and the
        // inbound/local-delivery test (resolveMailDomain), so an operator who moves it moves all of them.
        const sendingDomain = mailDomain;
        const fromDomain = String(fromEmail.split('@')[1] || '').toLowerCase();
        let wireFrom = fromEmail;
        let wireReplyTo = data.replyTo || undefined;
        const mayRewriteFrom = !relayConfigured && isPublicSendingDomain(sendingDomain);
        if (mayRewriteFrom && fromDomain && fromDomain !== sendingDomain) {
            const configured = String(optFromEmail || '');
            wireFrom = (configured && String(configured.split('@')[1] || '').toLowerCase() === sendingDomain)
                ? configured
                : `postmaster@${sendingDomain}`;
            // Only the SITE's own configured address may travel as Reply-To here. A user identity is on the
            // mail domain by construction (the choke point above), so it never reaches this branch — and an
            // account's off-domain address must never be handed to remote parties as where to reply.
            if (!wireReplyTo && !identity) wireReplyTo = fromEmail;
            console.warn(`[MailServer] From '${fromEmail}' is not on the sending domain '${sendingDomain}' — sending as '${wireFrom}' with Reply-To '${wireReplyTo}' so DMARC/SPF align (remote servers reject unauthenticated cross-domain From).`);
        } else if (!relayConfigured && fromDomain && sendingDomain && fromDomain !== sendingDomain && !isPublicSendingDomain(sendingDomain)) {
            console.warn(`[MailServer] From '${fromEmail}' is off our sending domain, but '${sendingDomain}' is not a public mail domain (LAN host/IP/localhost) — keeping the original From. Set a DKIM domain or a real site URL for DMARC alignment.`);
        }

        // SECOND SINK of the client-path class (the first is Email.saveAttachment): nodemailer opens
        // `path` and ships the bytes OUT over SMTP, so '../../src/index.ts' in a composed message is
        // an exfiltration channel that never touches the attachment table at all. Same resolver, same
        // roots — a path the store would refuse to copy is a path we refuse to send. Entries that do
        // not resolve are DROPPED, not substituted, and the send continues with the rest.
        const attachments = [];
        for (const a of (data.attachments || [])) {
            const source = await Email.resolveAttachmentSource(a && a.path);
            if (!source) {
                if (a && a.path) console.error(`[MailServer] Dropping outbound attachment outside the permitted upload roots: ${String(a.path).slice(0, 200)}`);
                continue;
            }
            attachments.push({ filename: a.filename, path: source });
        }
        // RFC 3834: an auto-generated reply announces itself so remote auto-responders don't answer it.
        const extraHeaders = (data.isAutoReply || data.extraHeaders)
            ? { ...(data.extraHeaders || {}), ...(data.isAutoReply ? { 'Auto-Submitted': 'auto-replied' } : {}) }
            : undefined;
        const mailObj = { fromEmail: wireFrom, envelopeFrom: envelopeSenderOf(data, wireFrom), fromName, replyTo: wireReplyTo, subject: data.subject, text: data.text, html: data.html, attachments, messageId: outboundMessageId, headers: extraHeaders };

        if (relay && mode !== 'fallback') {
            // Relay/smarthost path (used only if a relay is configured). NOTE: wireFrom === fromEmail
            // here by construction (see mayRewriteFrom above) — the smarthost owns alignment.
            console.log(`[MailServer] Delivering ${externalRecipients.length} recipient(s) via configured relay...`);
            for (const extR of externalRecipients) {
                try {
                    const info = await deliverViaRelay(relay, extR, mailObj, dkimOptions);
                    delivered.push({ recipient: extR, via: 'relay', response: info.response });
                } catch (e) {
                    console.error(`[MailServer] ❌ Relay delivery to ${extR} failed: ${e.message}`);
                    // Classify by SMTP reply code exactly as the direct-to-MX path does: a 5xx is a permanent
                    // reject (bounce now), anything else — 4xx, network, TLS — is transient and retries on the
                    // attempt² schedule. This used to be `permanent: false` unconditionally, so a relay 5xx was
                    // retried MAX_DELIVERY_ATTEMPTS times before bouncing, contradicting the documented policy.
                    const code = Number(e && e.responseCode) || 0;
                    failed.push({ recipient: extR, error: e.message, permanent: code >= 500 && code < 600 });
                }
            }
        } else if (relayConfigured) {
            // The configured relay is unavailable. Say so and keep the mail for the retry schedule; never
            // reroute it direct-to-MX.
            const reason = `Relay unavailable: ${relayStatus.error || 'not reachable'}`;
            console.error(`[MailServer] ❌ ${reason} — ${externalRecipients.length} recipient(s) left in the retry queue.`);
            for (const extR of externalRecipients) failed.push({ recipient: extR, error: reason, permanent: false });
        } else {
            // Direct-to-MX delivery (real MTA), with the relay as its backup in 'fallback' mode.
            const backup = mode === 'fallback' ? relay : null;
            const viaBackup = async (extR, why) => {
                try {
                    const info = await deliverViaRelay(backup, extR, mailObj, dkimOptions);
                    console.log(`[MailServer] ✅ Delivered to ${extR} via the backup relay (${why}).`);
                    delivered.push({ recipient: extR, via: 'relay', response: info.response });
                } catch (e) {
                    console.error(`[MailServer] ❌ Backup relay delivery to ${extR} failed: ${e.message}`);
                    const code = Number(e && e.responseCode) || 0;
                    failed.push({ recipient: extR, error: e.message, permanent: code >= 500 && code < 600 });
                }
            };
            // A delivery test is a diagnostic: it always tries, pause or not, and reports what it found.
            const isPaused = () => !data.noRetry && directPausedUntil > Date.now();
            // Direct delivery is paused and there is no backup: the message waits for the pause like it
            // waits for the sending rate — not a delivery attempt, so its retries are not spent.
            if (isPaused() && !backup && sentRecordId) {
                await holdForSendRate(sentRecordId, data, externalRecipients, directPausedUntil,
                    `Direct delivery paused: outbound port 25 gave no reply (until ${new Date(directPausedUntil).toISOString()})`);
                console.log(`[MailServer] Message ${sentRecordId} waits for direct delivery to resume (${externalRecipients.length} recipient(s)).`);
                return { success: true, queued: true, delivered, failed: [], waiting: externalRecipients.length };
            }
            const heloName = await getHeloName();
            console.log(`[MailServer] Direct MX delivery for ${externalRecipients.length} recipient(s) as ${heloName}...`);
            for (const extR of externalRecipients) {
                if (isPaused()) {
                    if (backup) { await viaBackup(extR, 'direct delivery is paused'); continue; }
                    failed.push({ recipient: extR, error: 'Direct delivery paused: outbound port 25 gave no reply', permanent: false });
                    continue;
                }
                try {
                    const r = await deliverDirect(extR, mailObj, dkimOptions, heloName);
                    console.log(`[MailServer] ✅ Delivered to ${extR} via ${r.mx}: ${r.response}`);
                    delivered.push({ recipient: extR, via: r.mx, response: r.response });
                } catch (e) {
                    console.error(`[MailServer] ❌ ${e.message}`);
                    if (e.unreachable) pauseDirectDelivery(`no mail server of ${extR.split('@')[1]} replied on port 25`);
                    if (backup && !e.permanent) { await viaBackup(extR, 'direct delivery failed'); continue; }
                    failed.push({ recipient: extR, error: e.message, permanent: !!e.permanent });
                }
            }
        }
    }

    // Update the retry queue state on the Sent record (Feature: retry temporary failures).
    // Only meaningful when we actually attempted external delivery and have a record to track.
    await updateRetryState(sentRecordId, data, externalRecipients, failed);
    firstDeliveriesInFlight.delete(sentRecordId);
    // A logged system message with no queue row to follow: its outcome is final here.
    if (systemLogId && !sentRecordId) {
        await Admin.setSystemSentStatus(systemLogId, failed.length === 0 ? 'delivered' : 'failed',
            failed.length ? failed.map(f => `${f.recipient}: ${f.error}`).join('; ') : null).catch(() => null);
    }

    // Surface delivery outcome so callers (the /send, /test endpoints) report accurately instead of
    // silently "succeeding". The Sent record + local inbox copies are already persisted above.
    return { success: failed.length === 0, delivered, failed };
}

const MAX_DELIVERY_ATTEMPTS = 5;

// Logged system messages whose FIRST delivery this worker is running (row id → start), so the sweep
// for interrupted deliveries (Admin.requeueInterruptedSystemMail) never re-queues one still going out.
const firstDeliveriesInFlight = new Map();
const INTERRUPTED_AFTER_MS = 15 * 60 * 1000;
const INTERRUPTED_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

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
        // NOT-A-USER-PATH: the delivery state machine. sentRecordId is the row sendMail JUST created
        // (or the draft POST /send had already checked); this writes back the outcome of an SMTP
        // transaction, and no request ever named this id.
        try { await Email.markSent(sentRecordId); } catch (e) { /* non-fatal */ }
        return;
    }

    if (!failed || failed.length === 0) {
        // NOT-A-USER-PATH: same row, same delivery transaction — see above.
        try { await Email.markSent(sentRecordId); } catch (e) { /* non-fatal */ }
        return;
    }

    const attempts = (parseInt(data.deliveryAttempts, 10) || 0) + 1;
    const temporary = failed.filter(f => !f.permanent);
    const permanent = failed.filter(f => f.permanent);
    const lastError = failed.map(f => `${f.recipient}: ${f.error}`).join('; ');

    // Permanent failures never retry. If everything left is permanent (or we're out of attempts),
    // mark failed and bounce to the sender.
    // A delivery TEST (POST /test) is a diagnostic, not mail anyone is waiting for: its failure is the
    // answer, so it is recorded as failed at once instead of sitting in the queue for five retries.
    if (data.noRetry || temporary.length === 0 || attempts >= MAX_DELIVERY_ATTEMPTS) {
        try {
            // Persist the failed recipients for visibility — BEFORE the status, because a recipient
            // rewrite clears the delivery state (Email.update) and must not wipe the outcome.
            // NOT-A-USER-PATH: the delivery state machine's own row. This narrows the recipient list,
            // which on an un-attributed row would BE a change of the ownership verdict — the store
            // refuses that case itself (mail_shared_row_party_narrowed); the catch keeps the queue moving.
            await Email.update(sentRecordId, { toAddress: failed.map(f => f.recipient).join(', ') });
        } catch (e) { /* non-fatal */ }
        try {
            // NOT-A-USER-PATH: the delivery state machine writing back the outcome for its own row.
            await Email.markFailed(sentRecordId, attempts, lastError);
        } catch (e) { /* non-fatal */ }
        if (!data.noRetry) await sendBounce(data, failed);
        return;
    }

    // Schedule a retry for the temporary failures only. Exponential backoff: attempt^2 minutes, cap ~6h.
    const backoffMinutes = Math.min(attempts * attempts, 360);
    const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();
    try {
        // Store ONLY the still-failed recipients so the next pass retries exactly those. This runs
        // FIRST: the rewrite clears the delivery state, and markRetry below re-arms it.
        // NOT-A-USER-PATH: as above — the queue's own record, mid-delivery, and the store still
        // refuses an address rewrite that would drop a party from an un-attributed row.
        await Email.update(sentRecordId, { toAddress: temporary.map(f => f.recipient).join(', ') });
    } catch (e) { /* non-fatal */ }
    try {
        // NOT-A-USER-PATH: the queue's own record, mid-delivery — see above.
        await Email.markRetry(sentRecordId, attempts, nextAttemptAt, lastError);
    } catch (e) { /* non-fatal */ }
    // The send that just ran was this message's charge when a user made it (a first send, or a manual
    // retry, which charges up front): its automatic retries are already paid for. Site mail
    // (user_id 0) was never charged, so the retry queue charges the site budget once instead.
    if ((parseInt(data.userId, 10) || 0) > 0 && (!data.isRetry || data.retryCharged)) {
        noteRetryCharge(sentRecordId, temporary.length);
    }

    // If there were also permanent failures mixed in, bounce those now (they won't be retried).
    if (permanent.length > 0) await sendBounce(data, permanent);
}

/**
 * Best-effort bounce notification to the sender for permanently failed recipients.
 */
async function sendBounce(data, failedList) {
    try {
        const fromEmail = (data.fromEmail || '').toLowerCase();
        const ownerId = parseInt(data.userId, 10) || 0;
        if (!fromEmail && !ownerId) return;
        // NOT-A-DELIVERY-PATH: resolves the SENDER to notify them that their own message bounced.
        // Nothing is delivered to this account and no inbox row is written for it. The owner id first:
        // the From is the mailbox address, which need not be the account's lookup email.
        const user = ownerId ? await User.findById(ownerId) : await User.findByEmail(fromEmail);
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
    // Otherwise it is THE mail domain (one expression — see resolveMailDomain), never the raw site
    // hostname on its own: announcing a name we are not the authority for is what breaks rDNS/SPF.
    const mailDomain = await getMailDomain();
    if (mailDomain) return mailDomain;
    try { return new URL(await getSiteUrl()).hostname; } catch (e) { return os.hostname(); }
}

/**
 * This node's own IPv4 addresses (non-loopback), split into public and private. In a multi-machine
 * install the plugin — and therefore inbound SMTP and direct delivery — runs on the BACKEND node, which
 * is not the address visitors reach the site on, so the console names the address it listens on
 * instead of leaving the operator to guess. Best effort: an unreadable interface list is empty.
 */
/**
 * The addresses the HOST reported with the listener status, else what this process can see. The host
 * reports IPv4 only; the public IPv6 addresses (`public6`) are this node's own — the same node, since
 * the plugin and its listener run together.
 */
function nodeAddressesKnown() {
    const a = inboundStatus && inboundStatus.addresses;
    const local = serverAddresses();
    if (a && ((a.public && a.public.length) || (a.private && a.private.length))) {
        return { ...a, public6: (a.public6 && a.public6.length) ? a.public6 : local.public6 };
    }
    return local;
}

function serverAddresses() {
    const out = { public: [], private: [], public6: [] };
    try {
        for (const list of Object.values(os.networkInterfaces() || {})) {
            for (const a of list || []) {
                if (!a || a.internal) continue;
                if (a.family === 'IPv6' || a.family === 6) {
                    // Only a global address can send to the internet: link-local, ULA and the like are blocked.
                    const ip = canonicalIp(a.address);
                    if (!isBlockedIp(ip) && !out.public6.includes(ip)) out.public6.push(ip);
                    continue;
                }
                if (a.family !== 'IPv4' && a.family !== 4) continue;
                const bucket = isBlockedIp(a.address) ? out.private : out.public;
                if (!bucket.includes(a.address)) bucket.push(a.address);
            }
        }
    } catch (e) { /* interfaces unavailable in this sandbox */ }
    return out;
}

/** One spelling per address, so a DNS answer and an interface address compare equal (IPv6 has many). */
function canonicalIp(ip) {
    const v = String(ip || '').trim();
    if (!net.isIPv6(v)) return v;
    try { return new URL(`http://[${v}]/`).hostname.slice(1, -1); } catch (e) { return v.toLowerCase(); }
}

/**
 * Build the DNS records the operator must publish for deliverability, given a DKIM public key.
 */
function buildDnsRecords(domain, selector, publicKeyPem, ctx = {}) {
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
        a: (() => {
            // The detected PUBLIC address of the node this plugin runs on, when it has one. Behind NAT
            // (only private addresses) the internet-facing address cannot be seen from here: say so,
            // and name the private one the router must forward port 25 to.
            const pub = (ctx.addresses && ctx.addresses.public) || [];
            const priv = (ctx.addresses && ctx.addresses.private) || [];
            if (pub.length) {
                return {
                    host: mailHost, type: 'A', value: pub[0], detected: true,
                    note: `${pub[0]} is this mail server's public IPv4 (detected on the node it runs on). Point ${mailHost} at it (skip if MX points at the bare domain and it already has an A record).`
                };
            }
            return {
                host: mailHost, type: 'A', value: 'YOUR_SERVER_PUBLIC_IP', detected: false,
                note: `Point this at the PUBLIC IPv4 the internet reaches this server on.` +
                    (priv.length ? ` This node only has private addresses (${priv.join(', ')}): use your router's public address and forward TCP port 25 to ${priv[0]}.` : '') +
                    ` (Skip if MX points at the bare domain and it already has an A record.)`
            };
        })(),
        // The mail host's IPv6, when this node has a public one: direct delivery also leaves over IPv6
        // (see pickDeliveryAddresses), and the name remote servers check must resolve to it too.
        aaaa: (() => {
            const pub6 = (ctx.addresses && ctx.addresses.public6) || [];
            if (!pub6.length) return undefined;
            return {
                host: mailHost, type: 'AAAA', value: pub6[0], detected: true,
                note: `${pub6[0]} is this mail server's public IPv6. Point ${mailHost} at it too: mail also leaves over IPv6.`
            };
        })(),
        dkim: {
            host: `${selector}._domainkey.${domain}`,
            type: 'TXT',
            value: dkimValue,
            valueChunked: dkimValue.length > 255 ? chunkTxt(dkimValue) : dkimValue,
            note: dkimValue.length > 255 ? 'Exceeds the 255-char DNS TXT limit. Most providers auto-split; if yours does not, paste the quoted-segment form.' : undefined
        },
        spf: (() => {
            // Name every detected sending address outright: `a mx` only covers them while the A/AAAA records
            // above stay in place.
            const ips = [
                ...((ctx.addresses && ctx.addresses.public) || []).slice(0, 1).map(ip => `ip4:${ip}`),
                ...((ctx.addresses && ctx.addresses.public6) || []).slice(0, 1).map(ip => `ip6:${ip}`),
            ];
            return {
                host: domain,
                type: 'TXT',
                value: ['v=spf1 a mx', ...ips, '~all'].join(' '),
                note: 'Add the sending host/IP if it is not the A/MX record (e.g. ip4:YOUR.IP).'
            };
        })(),
        dmarc: {
            host: `_dmarc.${domain}`,
            type: 'TXT',
            value: `v=DMARC1; p=none; rua=mailto:postmaster@${domain}`
        },
        ptr: {
            type: 'PTR (reverse DNS)',
            value: ctx.heloHost || mailHost,
            // Every public address mail can leave from needs its own reverse record (IPv4 and IPv6).
            addresses: [...((ctx.addresses && ctx.addresses.public) || []), ...((ctx.addresses && ctx.addresses.public6) || [])],
            note: `Reverse DNS for your sending IP MUST resolve to ${ctx.heloHost || mailHost} — the name this server announces (HELO) — and that name must resolve back to the same IP. Without rDNS, Gmail/Outlook reject or spam your mail. Set this with your IP/hosting provider.`
        }
    };
}

// SECURITY (TLS-downgrade): the certificate-VERIFICATION failures that — and only that — let
// deliverDirect retry an MX host with verification disabled. No message-substring fallbacks (the old
// msg.includes('tls')/'certificate'/'altname' matched transient/non-cert TLS and even generic errors,
// letting an active MITM force the downgrade with a non-cert error), and no broad `ERR_TLS_` code prefix
// (it matched handshake/protocol errors).
//
// Each entry pairs the Node/OpenSSL code with the text Node gives the error, because the code does not
// reach us: Node destroys the STARTTLS socket with an Error carrying the verify code, and nodemailer (9
// and 10) passes every socket error through _onError(err, 'ESOCKET') → _formatError, which OVERWRITES
// err.code with 'ESOCKET' on that same object. A code-only match never fired, so every direct-MX
// delivery to a host with a bad certificate failed outright instead of taking the logged downgrade.
// What survives is the message: OpenSSL's fixed verify reason ("self signed" before OpenSSL 3), which
// newer Node suffixes with "; if the root CA is installed locally, try running Node.js with
// --use-system-ca", or Node's own ERR_TLS_CERT_ALTNAME_INVALID text. Every entry is driven through the
// real nodemailer against a real TLS server in mail-server-mx-tls-fallback.test.ts, so a wording change
// fails that suite on the runtime running it instead of silently disabling the fallback again — CI pins
// one Node line, so run the suite on a new Node line before supporting it in production.
const TLS_CERT_VERIFY_FAILURES = [
    ['ERR_TLS_CERT_ALTNAME_INVALID', /^Hostname\/IP does not match certificate's altnames: /], // hostname / SAN mismatch
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /^self[- ]signed certificate(?:;|$)/],                       // self-signed leaf
    ['SELF_SIGNED_CERT_IN_CHAIN', /^self[- ]signed certificate in certificate chain(?:;|$)/],    // self-signed CA in chain
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /^unable to verify the first certificate(?:;|$)/],      // issuer neither sent nor trusted
    ['CERT_HAS_EXPIRED', /^certificate has expired(?:;|$)/],                                     // expired cert
];

function isTlsVerifyError(e) {
    if (!e) return false;
    const code = e.code ? String(e.code).toUpperCase() : '';
    // An error that still carries the verify code: what Node's TLS socket raises before nodemailer's
    // rewrite, so the fallback keeps working if nodemailer ever stops overwriting err.code.
    if (TLS_CERT_VERIFY_FAILURES.some(([c]) => c === code)) return true;
    // Otherwise only nodemailer's socket-error shape qualifies: nodemailer tags nothing but the socket's
    // own 'error' event ESOCKET, and never with a server reply, so its message is Node's local text. An
    // error tied to an SMTP reply has another code and the server-chosen reply appended to its message —
    // server text never reaches the anchored comparison below. (Defence in depth: nodemailer prefixes
    // every reply-carrying message, so the anchors alone reject those today; the gate keeps server text
    // out even for an error shape that does not.)
    if (code !== 'ESOCKET') return false;
    const message = String(e.message || '');
    return TLS_CERT_VERIFY_FAILURES.some(([, reason]) => reason.test(message));
}

/**
 * Did the MX REFUSE STARTTLS with an SMTP reply (e.g. "454 4.7.0 TLS not available due to local
 * problem" from a Postfix with no certificate)? nodemailer reports that as code ETLS carrying the
 * server's reply code. Only that shape qualifies: a handshake that starts and then fails (reset,
 * protocol error) is NOT this, and stays undowngraded — see the TLS suite.
 *
 * Continuing in plaintext after such a refusal is opportunistic TLS as every MTA does it (Postfix
 * `smtp_tls_security_level = may`): it is the same outcome as a server that does not advertise STARTTLS
 * at all, which we already accept, so an on-path attacker gains nothing they could not get by stripping
 * the advertisement. Without it, mail to a provider with a broken TLS setup was retried for hours and
 * then bounced (found in the production lab).
 */
function isStartTlsRefused(e) {
    if (!e || String(e.code || '').toUpperCase() !== 'ETLS') return false;
    const code = Number(e.responseCode) || 0;
    return code >= 400 && code < 600;
}

/**
 * The SMTP envelope sender (MAIL FROM) for an outbound message. RFC 3834 §3.3: an automatic response
 * (the vacation responder) goes out with a NULL return path, MAIL FROM:<>, so a reply that cannot be
 * delivered is dropped by the remote MTA instead of bouncing back into the vacationing user's inbox —
 * which is what happened while the envelope carried the user's address. The header From, Reply-To,
 * DKIM signature and Auto-Submitted header are unaffected; only the envelope changes. Everything else
 * (normal sends, and forwards, which keep the forwarding address for SPF alignment) uses the wire From.
 * nodemailer turns `envelope.from: ''` into exactly `MAIL FROM:<>` on both the direct and relay paths.
 */
function envelopeSenderOf(data, wireFrom) {
    return data && data.isAutoReply ? '' : wireFrom;
}

// A mail object without envelopeFrom keeps the historical behaviour: the envelope sender is the wire From.
function envelopeFromOf(mail) {
    return typeof mail.envelopeFrom === 'string' ? mail.envelopeFrom : mail.fromEmail;
}

/**
 * Deliver ONE message to ONE recipient through the configured relay/smarthost. Resolves with
 * nodemailer's info; a rejection carries nodemailer's responseCode for the caller to classify.
 */
async function deliverViaRelay(relay, recipient, mail, dkimOptions) {
    return await relay.sendMail({
        envelope: { from: envelopeFromOf(mail), to: recipient },
        from: `"${mail.fromName}" <${mail.fromEmail}>`, to: recipient,
        replyTo: mail.replyTo,
        messageId: mail.messageId,
        subject: mail.subject, text: mail.text, html: mail.html, attachments: mail.attachments, dkim: dkimOptions,
        headers: mail.headers
    });
}

// The address family (4 or 6) that last reached a remote MX on port 25. Some providers filter or throttle
// outbound port 25 on one family only (a VPS that rate-limits IPv4 SMTP while IPv6 gets through): after one
// success the next deliveries try that family first instead of waiting out a connection timeout each time.
let outboundFamilyHint = 4;

// How many MX hosts of one domain may give no reply at all before a delivery stops trying the rest.
const UNREACHABLE_MX_LIMIT = 2;
// When a delivery got no reply from any mail server, direct delivery pauses this long: retrying at once
// only adds connections to the count that keeps a provider's port-25 limit engaged (Hostinger: 5 a minute).
const DIRECT_PAUSE_MS = 5 * 60 * 1000;
let directPausedUntil = 0;

function pauseDirectDelivery(reason) {
    directPausedUntil = Date.now() + DIRECT_PAUSE_MS;
    console.warn(`[MailServer] Direct delivery paused until ${new Date(directPausedUntil).toISOString()}: ${reason}`);
}

/** 'fallback': deliver direct-to-MX and use the configured relay only when that fails; 'always': relay only. */
async function relayMode() {
    return String(await getOption('mail_relay_mode', 'always')) === 'fallback' ? 'fallback' : 'always';
}

/** One validated address per family, the family that last worked first (at most two connection attempts per MX). */
function pickDeliveryAddresses(addrs) {
    const v4 = addrs.find(a => net.isIPv4(a));
    const v6 = addrs.find(a => net.isIPv6(a));
    const ordered = outboundFamilyHint === 6 ? [v6, v4] : [v4, v6];
    return ordered.filter(Boolean);
}

function noteOutboundFamily(ip) {
    const family = net.isIPv6(ip) ? 6 : 4;
    if (family !== outboundFamilyHint) console.log(`[MailServer] Outbound SMTP now prefers IPv${family}: it reached a remote MX where IPv${outboundFamilyHint} did not.`);
    outboundFamilyHint = family;
}

/** An SMTP refusal aimed at the IPv6 sending address itself (missing PTR, IPv6 sender rules), not at the message. */
function isIpv6PolicyRefusal(e) {
    const text = String((e && (e.response || e.message)) || '');
    return !!(e && e.responseCode) && /IPv6|PTR|reverse DNS/i.test(text);
}

/** The connection never got an SMTP reply (timeout, refused, unreachable): another address may work. */
function isUnreachable(e) {
    if (!e || e.responseCode) return false;
    if (['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(e.code)) return true;
    // nodemailer reports every socket error as ESOCKET (see isTlsVerifyError): only a failed CONNECT counts.
    return e.code === 'ESOCKET' && /\bconnect (ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|ETIMEDOUT)\b/.test(String(e.message || ''));
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
    const sendVia = async (pinnedIp, serverName, rejectUnauthorized, plaintext = false) => {
        const transport = nodemailer.createTransport({
            host: pinnedIp,               // already-validated public IP — no second resolution
            port: 25,
            secure: false,
            // Only after this host REFUSED STARTTLS with a reply (isStartTlsRefused): do not ask again.
            ...(plaintext ? { ignoreTLS: true } : {}),
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
                // Envelope (MAIL FROM / RCPT TO) drives SPF alignment & bounces; keep it our domain
                // (or the null return path for an auto-reply — see envelopeSenderOf).
                envelope: { from: envelopeFromOf(mail), to: recipient },
                from: `"${mail.fromName}" <${mail.fromEmail}>`,
                to: recipient,
                replyTo: mail.replyTo,
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

    let lastErr = null;
    let permanent = false;
    let unreachableMx = 0;   // MX hosts tried on every address without a single SMTP reply
    let anyReply = false;    // some MX answered (a reply, a TLS handshake): the network path works
    mxLoop:
    for (const mx of mxRecords) {
        // SECURITY (M2-SSRF): resolve this MX host and reject if it points at an internal/private IP
        // (loopback/RFC1918/link-local incl. cloud metadata/CGNAT/ULA). Skip to the next MX on a
        // blocked/unresolvable host rather than connecting. PIN the validated address: we connect the
        // socket to this exact IP below (not the hostname) so there is no second, attacker-controlled
        // DNS resolution at connect time (M2 DNS-rebinding/TOCTOU defense).
        let candidates;
        try {
            // All returned addresses were checked; one per family, the family that last worked first.
            candidates = pickDeliveryAddresses(await assertPublicHost(mx.exchange));
        } catch (e) {
            lastErr = e;
            console.warn(`[MailServer][SSRF] Skipping MX ${mx.exchange} for ${recipient}: ${e.message}`);
            continue;
        }

        for (let i = 0; i < candidates.length; i++) {
            const pinnedIp = candidates[i];
            const delivered = (info, extra = {}) => {
                noteOutboundFamily(pinnedIp);
                return { ok: true, mx: mx.exchange, response: info.response, ...extra };
            };
            try {
                // M2-TLS: try with full certificate verification first. Connect to the pinned IP, verify the
                // cert against the real MX hostname (mx.exchange) via servername.
                return delivered(await sendVia(pinnedIp, mx.exchange, true));
            } catch (e) {
                // On a TLS *verification* failure (and only that), retry THIS host once with verification
                // disabled, logging the downgrade explicitly. Other failures fall through to the next MX.
                if (isTlsVerifyError(e)) {
                    anyReply = true; // a TLS handshake: the host answered
                    console.warn(`[MailServer][TLS] STARTTLS verification FAILED for ${mx.exchange} (${e.message}) — retrying with verification DISABLED (downgraded, opportunistic encryption only).`);
                    try {
                        return delivered(await sendVia(pinnedIp, mx.exchange, false), { tlsDowngraded: true });
                    } catch (e2) {
                        lastErr = e2;
                        const code = e2.responseCode || 0;
                        permanent = code >= 500 && code < 600;
                        if (permanent) break mxLoop;
                        continue mxLoop;
                    }
                }
                // The host refused STARTTLS with a reply: deliver to it without TLS, as opportunistic TLS
                // does, and say so in the log.
                if (isStartTlsRefused(e)) {
                    anyReply = true; // an SMTP reply: the host answered
                    console.warn(`[MailServer][TLS] ${mx.exchange} refused STARTTLS (${e.responseCode}) — retrying WITHOUT TLS (opportunistic, plaintext).`);
                    try {
                        return delivered(await sendVia(pinnedIp, mx.exchange, false, true), { tlsDowngraded: true, plaintext: true });
                    } catch (e2) {
                        lastErr = e2;
                        const code2 = e2.responseCode || 0;
                        permanent = code2 >= 500 && code2 < 600;
                        if (permanent) break mxLoop;
                        continue mxLoop;
                    }
                }
                lastErr = e;
                const code = e.responseCode || 0;
                // A receiver that refuses IPv6 senders it cannot verify (Gmail's IPv6 sending guidelines: no
                // PTR record) may accept the same message over IPv4: that refusal is about the address.
                if (net.isIPv6(pinnedIp) && i + 1 < candidates.length && isIpv6PolicyRefusal(e)) {
                    console.warn(`[MailServer] ${mx.exchange} refused IPv6 delivery (${e.message}) — trying ${candidates[i + 1]}.`);
                    continue;
                }
                permanent = code >= 500 && code < 600;
                if (permanent) break mxLoop; // a hard 5xx reject won't differ on another MX
                // This address could not be reached at all (no SMTP reply): the same host over the other
                // family may be — a provider that filters outbound port 25 on IPv4 but not on IPv6.
                if (isUnreachable(e) && i + 1 < candidates.length) {
                    console.warn(`[MailServer] ${mx.exchange} unreachable at ${pinnedIp} (${e.message}) — trying ${candidates[i + 1]}.`);
                    continue;
                }
                // Reaching here, the earlier addresses of this host were unreachable too (see above).
                const replied = !isUnreachable(e);
                if (replied) anyReply = true;
                // Every address of this host gave no reply. When that happens on more than one host the
                // problem is OUR outbound port 25 (a provider filter or rate limit), not theirs: each
                // further host only adds connections to the count that keeps it blocked.
                if (!replied && ++unreachableMx >= UNREACHABLE_MX_LIMIT) {
                    console.warn(`[MailServer] ${unreachableMx} mail servers of ${domain} gave no reply on port 25 — stopping here; outbound port 25 looks blocked or rate-limited.`);
                    break mxLoop;
                }
                continue mxLoop;
            }
        }
    }
    const err = new Error(`Direct delivery to ${recipient} failed: ${lastErr ? lastErr.message : 'no MX reachable'}`);
    err.permanent = permanent;
    // No server answered at all: the caller pauses direct delivery (see pauseDirectDelivery).
    err.unreachable = !anyReply && unreachableMx > 0;
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

// Where a setting lives in the site's options (see getOption): under this plugin's own name, except the
// values the core reads under a shared name.
const SHARED_OPTION_NAMES = new Set(['mail_domain', 'mail_delivery_ready', 'blogname']);
const OPTION_UNSET = '\u0000mail-server:unset';
const optionName = (key) => (SHARED_OPTION_NAMES.has(String(key).toLowerCase()) ? String(key) : 'mail_server_' + String(key));

// THE HOST'S ANSWER BUDGET. Every call the host makes into this worker — an HTTP route, the core's mail
// hand-off (provideMail), a notification — must answer within the host's 30 s RPC timeout, or the host
// treats the worker as wedged and KILLS it: the caller gets "Isolated plugin error" and a delivery cut
// off mid-SMTP is neither sent nor re-queued. Direct-to-MX delivery to a server that does not answer
// takes up to connection + greeting + socket timeouts per MX, i.e. minutes. So these callers wait at
// most this long and let the delivery finish in the background (it writes its own outcome to the row).
const HANDOFF_ANSWER_MS = 20000;
// A manual "Retry now" answers sooner: a quick verdict (delivered, DNS failure) is still reported as
// such, a slow one is reported as "retrying in the background".
const RETRY_ANSWER_MS = 10000;
// A manually retried row is re-armed for the automatic queue this far ahead BEFORE the attempt, so a
// background attempt that never reports back (worker restart) is retried later instead of lost.
const RETRY_SAFETY_NET_MS = 15 * 60 * 1000;
// Rows with a manual retry running in this worker: a second click must not start a second delivery.
const retriesInFlight = new Set();

/**
 * Settle `promise` within `ms`: `{ done: true, value }` when it settled in time (a rejection in time
 * rejects), `{ done: false }` when it is still running — it keeps running, and a later failure is
 * logged as `label` instead of becoming an unhandled rejection.
 */
function settleWithin(promise, ms, label) {
    return new Promise((resolve, reject) => {
        let answered = false;
        const timer = setTimeout(() => { answered = true; resolve({ done: false }); }, ms);
        Promise.resolve(promise).then(
            (value) => { if (answered) return; answered = true; clearTimeout(timer); resolve({ done: true, value }); },
            (e) => {
                if (answered) { console.error(`[MailServer] ${label} failed in the background: ${e && e.message}`); return; }
                answered = true; clearTimeout(timer); reject(e);
            });
    });
}

/**
 * Re-attempt a message whose delivery FAILED (or is mid-retry), NOW, instead of waiting for the
 * backoff. On a failed/retry row, to_address holds exactly the still-failed recipients
 * (updateRetryState rewrites it), so they are re-sent through sendMail with isRetry:true — reusing the
 * same Sent record (no duplicate copy). A manual retry resets the attempt counter (fresh cycle).
 * The CALLER has already authorized the row (owner, or an administrator).
 *
 * Answers within RETRY_ANSWER_MS: an attempt still running then is reported as 202 `pending` and goes
 * on in the background (see HANDOFF_ANSWER_MS for why a route must never wait it out).
 */
async function retryFailedDelivery(email, rateKey, { force = false } = {}) {
    if (email.delivery_status !== 'failed' && email.delivery_status !== 'retry') {
        return { status: 409, body: { error: 'This message is not in a failed state — nothing to retry.' } };
    }
    const pending = { status: 202, body: { success: true, pending: true, id: email.id, status: 'retry', message: 'Still trying — delivery continues in the background.' } };
    if (retriesInFlight.has(email.id)) return pending;
    const recipients = splitAddresses(email.to_address);
    if (recipients.length === 0) return { status: 400, body: { error: 'No recipients to retry.' } };

    // Per-user outbound rate limit still applies to a manual retry.
    if (!outboundRateLimitOk(rateKey, recipients.length)) {
        return { status: 429, body: { error: 'Outbound mail rate limit exceeded. Please try again later.' } };
    }
    retriesInFlight.add(email.id);
    // NOT-A-USER-PATH: the row the caller authorized. Shown as "retrying" from now on, and the queue's
    // safety net if this attempt never writes its outcome back.
    await Email.markRetry(email.id, email.delivery_attempts || 0,
        new Date(Date.now() + RETRY_SAFETY_NET_MS).toISOString(), email.last_error).catch(() => null);
    const attempt = deliverRetry(email, recipients, force).finally(() => retriesInFlight.delete(email.id));
    const r = await settleWithin(attempt, RETRY_ANSWER_MS, `The retry of message ${email.id}`);
    return r.done ? r.value : pending;
}

async function deliverRetry(email, recipients, force) {
    try {
        // NOT-A-USER-PATH: a continuation of a route that already authorized this row (the owner's
        // POST /emails/:id/retry through canAccessEmail, or an administrator's queue retry).
        const attachments = (await Email.getAttachments(email.id)).map(att => ({
            filename: att.filename,
            path: path.join(UPLOAD_DIR, att.storage_path)
        }));
        const result = await sendMail({
            to: recipients,
            subject: email.subject,
            text: email.body_text,
            html: email.body_html,
            // The OWNER's identity, resolved from user_id — see the queue above.
            identity: await sendingIdentityOfOwner(email.user_id),
            parentId: email.parent_id,
            threadId: email.thread_id,
            userId: email.user_id || 0,
            isRetry: true,
            retryCharged: true, // charged just above
            isAutoReply: Number(email.is_auto_reply) === 1,
            sentRecordId: email.id,
            deliveryAttempts: 0, // manual retry → fresh cycle, not stuck at max attempts
            // An administrator's "Retry now" goes out at once (it still counts against the sending rate).
            paceForce: force,
            attachments
        });
        // NOT-A-USER-PATH: re-reads the same, already-authorized row to report its new delivery state.
        const after = await Email.findById(email.id);
        // Held, not sent: it waits for the sending rate or for direct delivery to resume (sendMail's
        // `queued`). "Delivered" would be false — and the row says it is waiting.
        if (result.queued) {
            return { status: 202, body: { success: true, pending: true, waiting: true, id: email.id, status: after ? after.delivery_status : 'retry', message: 'Waiting in the queue: it goes out when the sending rate or a pause of direct delivery allows.' } };
        }
        if (result.success) {
            return { status: 200, body: { success: true, id: email.id, status: after ? after.delivery_status : 'sent', message: 'Delivered.' } };
        }
        // Still failing — report the fresh reason (sendMail already persisted last_error + status).
        return {
            status: 207,
            body: {
                success: false,
                id: email.id,
                status: after ? after.delivery_status : 'failed',
                lastError: after ? after.last_error : null,
                failed: result.failed,
                message: after && after.delivery_status === 'retry'
                    ? 'Still undeliverable — re-queued for automatic retry.'
                    : 'Still undeliverable.'
            }
        };
    } catch (error) {
        if (error && error.code === NO_MAILBOX_ADDRESS) {
            // NOT-A-USER-PATH: a continuation of a route that already authorized this row (see above).
            await Email.markFailed(email.id, email.delivery_attempts || 0, error.message).catch(() => null);
            return { status: 403, body: { error: error.message, code: NO_MAILBOX_ADDRESS } };
        }
        return { status: 500, body: { error: 'Retry failed: ' + error.message } };
    }
}

/** Tell a row's owner their queued message was not sent because their account has no mailbox address. */
async function notifyNoMailboxAddress(email, err) {
    const uid = parseInt(email && email.user_id, 10) || 0;
    if (!(uid > 0)) return;
    await wordjs.notify({
        user_id: uid,
        type: 'alert',
        title: 'Email not sent',
        message: `"${String(email.subject || '').slice(0, 120)}" was not sent: ${err.message}`,
        icon: 'fa-exclamation-triangle',
        color: 'red',
        transports: ['db', 'sse']
    });
}

exports.init = async function (bridge) {
    wordjs = bridge;
    // The store cannot look a user up itself (the SQL guard denies every table outside its prefix), so
    // it is handed the ONE identity question its one-time ownership backfill needs. It is used ONLY by
    // _backfillOwnership, which attributes pre-v2.1 rows so the store can keep a single ownership
    // predicate instead of the unanchored `to_address LIKE '%me%'` arm that let one mailbox read and
    // permanently delete another's mail.
    Email = createEmailStore(wordjs.db, {
        // IDENTITY — "which site account IS this address" — and nothing else.
        //
        // It used to answer with mailboxAddressOf(account, domain), the DELIVERY predicate, which also
        // demands the admin-granted professional-mailbox flag. Host migration 0006 leaves that flag OFF
        // for every account that is neither an administrator nor able to edit_users, so on EXACTLY the
        // upgrade this backfill exists for, every address resolved to 0, every historic row fell
        // through to the catch-all owner, and the administrator inherited the whole site's mail —
        // subject and snippet in a listing where it had never appeared, and destroyable with one
        // "Empty trash" — while the real owners lost it from every listing, counter and search,
        // IRREVERSIBLY (once a row is no longer user_id = 0 the exact-filtered path cannot find it).
        //
        // Identity is safe to trust here: the host refuses self-service assignment of an address on the
        // mail domain (core/email-address refuseSelfServiceEmailChange, enforced on PUT /users/me,
        // PUT /users/:id and POST /auth/register), so nobody can claim an unused corporate address and
        // inherit its history — which is the hijack the delivery predicate was reached for.
        //
        // NOTE this uses findByEmail ALONE. mail-server-mailbox-gate.test.ts keys the delivery-path
        // assertion on the `findByEmail || findByLogin` pair precisely so a non-delivery resolver like
        // this one is not required to carry a delivery guard it must not have.
        resolveUserIdByAddress: async (address) => {
            try {
                const want = String(address || '').trim().normalize('NFC').toLowerCase();
                if (!want) return 0;
                // NOT-A-DELIVERY-PATH: answers IDENTITY ("which account IS this address") for the
                // ownership backfill. Adding a delivery guard here is the #5 regression: mailboxAddressOf
                // is OFF for every non-administrator, so it would answer 0 for the whole site.
                const account = await User.findByEmail(want);
                return account && account.id ? account.id : 0;
            } catch (e) {
                // THROW, never 0. Returning 0 said "this address belongs to no account here", which is
                // a FACT the store acts on: it is the difference between "nobody else would lose this
                // message" and "we could not check". The store distinguishes them (UNKNOWN_IDENTITY)
                // and refuses to destroy on the second — but only if we let the failure reach it.
                throw new Error(`mail identity lookup failed for an address: ${e && e.message}`);
            }
        },
        // NO fallbackOwnerId, deliberately: a row nobody claims — or that several accounts are party
        // to — stays at user_id = 0, where the store's exact-filtered path already serves it to all of
        // them. See _resolveLegacyOwner in lib/email-store.js.

        // The system Sent log follows every delivery-state write of a queue row (see SYSTEM SENT LOG).
        onDeliveryState: async (id, status, lastError, paced) => {
            if (Admin) await Admin.syncSystemSent(id, status, lastError, paced);
        }
    });

    // getOption/updateOption transparently route secret/security-critical keys to the plugin's own
    // secrets table (the host blocks those via the generic options bridge) and everything else to
    // wordjs.options. admin_email is also protected by the host → served from the site bridge.
    //
    // The host lets a plugin write only options named after it ('mail_server_…'), so every setting is
    // kept under that name. Two values are the exception, published under the names the core reads from
    // the site's mail provider: 'mail_domain' and 'mail_delivery_ready'; and 'blogname' is the site's own.
    // A setting an earlier version kept under its bare name is read from there once and carried over.
    getOption = async (key, def) => {
        if (String(key).toLowerCase() === 'admin_email') {
            try { return (await wordjs.site.adminEmail()) || def; } catch (e) { return def; }
        }
        if (isSecretOption(key)) return await Email.getSecret(key, def === undefined ? '' : def);
        const name = optionName(key);
        let v = await wordjs.options.get(name, OPTION_UNSET);
        if (v === OPTION_UNSET && name !== key) {
            v = await wordjs.options.get(key, OPTION_UNSET);
            if (v !== OPTION_UNSET) { try { await wordjs.options.set(name, v); } catch (e) { /* read it again next time */ } }
        }
        if (v === OPTION_UNSET) v = def;
        // Every setting of this plugin is a string ('0'/'1', '587', …), but the host hands back what it
        // parsed: a stored '0' arrives as the NUMBER 0, and `0 !== '0'` read every switched-off toggle
        // (Require STARTTLS, SPF, forwarding, …) as on. Normalize scalars to the string this file compares.
        return (typeof v === 'number' || typeof v === 'boolean') ? String(v) : v;
    };
    updateOption = async (key, value) => {
        if (isSecretOption(key)) return await Email.setSecret(key, value);
        return await wordjs.options.set(optionName(key), value);
    };

    // Schema first so the secrets table exists before getOption/updateOption touch it.
    await Email.initSchema();
    Admin = createAdminStore(wordjs.db);
    SendRate = createSendRate(wordjs.db, 'wjp_mail_server_send_rate', sendRateLimit);
    await Admin.initSchema();

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
    queueTickRunning = false;
    // One due row of the scheduled-send queue. Answers 'stop' when the sending rate is used up for now.
    const dispatchScheduled = async (email) => {
        try {
            const toList = splitAddresses(email.to_address);
            const ccList = splitAddresses(email.cc_address);
            const bccList = splitAddresses(email.bcc_address);
            // The minute's slot first, in queue order: refused, the row stays due and the pass stops here.
            const slot = await claimQueueSlot();
            if (!slot) return 'stop';
            if (!queuedDispatchAllowed(email, toList.length + ccList.length + bccList.length)) {
                // Over the sender's outbound limit: postpone, never drop.
                // NOT-A-USER-PATH: the scheduled-send queue's own row (see below).
                await Email.update(email.id, { scheduledAt: new Date(Date.now() + RATE_LIMIT_DEFER_MS).toISOString() });
                console.warn(`[MailServer] Scheduled email ${email.id} postponed: outbound rate limit reached.`);
                return;
            }
            // NOT-A-USER-PATH: the scheduled-send queue. `email` comes from
            // Email.getPendingScheduled() — rows the server selected by scheduled_at — so no
            // request supplied this id and nothing here is returned to a caller.
            // Load attachments if any
            const attachments = await Email.getAttachments(email.id);
            const formattedAttachments = attachments.map(att => ({
                filename: att.filename,
                path: path.join(UPLOAD_DIR, att.storage_path)
            }));

            await sendMail({
                // to/cc/bcc are stored as comma-joined lists — split them back into real
                // recipient arrays (a joined string would read as ONE malformed address).
                to: toList,
                cc: ccList,
                bcc: bccList,
                subject: email.subject,
                text: email.body_text,
                html: email.body_html,
                // THE OWNER'S identity, resolved from user_id — never `email.from_address`,
                // which on a pre-v2.1 shared row is a COLLEAGUE'S address that no rewrite can
                // clear. A row nobody owns yields null and goes out as the site itself.
                identity: await sendingIdentityOfOwner(email.user_id),
                parentId: email.parent_id,
                threadId: email.thread_id,
                userId: email.user_id || 0,
                draftId: email.id, // Re-use existing record to mark as sent
                paceClaimed: true,
                attachments: formattedAttachments
            });
            console.log(`[MailServer] Scheduled email ${email.id} sent.`);
        } catch (err) {
            if (err && err.code === NO_MAILBOX_ADDRESS) {
                // The owner has no address to send from (any more): never send it as anyone else. It
                // goes back to their Drafts, marked failed with the reason, and they are told.
                // NOT-A-USER-PATH: the scheduled-send queue's own row.
                await Email.cancelScheduled(email.id).catch(() => null);
                // NOT-A-USER-PATH: the same queue row, marked with the reason.
                await Email.markFailed(email.id, 0, err.message).catch(() => null);
                await notifyNoMailboxAddress(email, err).catch(() => null);
                return;
            }
            console.error(`[MailServer] Failed to send scheduled email ${email.id}:`, err);
        }
    };

    // One due row of the retry queue (temporary failures, and messages waiting for the sending rate).
    const dispatchRetry = async (email) => {
        try {
            // to_address holds exactly the still-failed (external) recipients for this row.
            const recipients = (email.to_address || '').split(',').map(s => s.trim()).filter(Boolean);
            if (recipients.length === 0) {
                // NOT-A-USER-PATH: the retry queue, over rows Email.getPendingRetries()
                // selected by delivery_status/next_attempt_at.
                await Email.markFailed(email.id, email.delivery_attempts || 0, 'No recipients to retry');
                return;
            }

            const slot = await claimQueueSlot();
            if (!slot) return 'stop';

            if (!retryDispatchAllowed(email, recipients.length)) {
                // Over the sender's outbound limit: push the attempt back without spending one.
                // NOT-A-USER-PATH: the retry queue — same rows Email.getPendingRetries() selected.
                await Email.markRetry(email.id, email.delivery_attempts || 0,
                    new Date(Date.now() + RATE_LIMIT_DEFER_MS).toISOString(),
                    'Outbound rate limit reached; delivery postponed');
                return;
            }

            // NOT-A-USER-PATH: the retry queue — same rows Email.getPendingRetries() selected.
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
                // THE OWNER'S identity, resolved from user_id — never `email.from_address`,
                // which on a pre-v2.1 shared row is a COLLEAGUE'S address that no rewrite can
                // clear. A row nobody owns yields null and goes out as the site itself.
                identity: await sendingIdentityOfOwner(email.user_id),
                parentId: email.parent_id,
                threadId: email.thread_id,
                userId: email.user_id || 0,
                // Reuse the existing Sent record instead of creating a duplicate copy.
                isRetry: true,
                isAutoReply: Number(email.is_auto_reply) === 1,
                sentRecordId: email.id,
                deliveryAttempts: email.delivery_attempts || 0,
                paceClaimed: true,
                attachments: formattedAttachments
            });
        } catch (err) {
            if (err && err.code === NO_MAILBOX_ADDRESS) {
                // No address to send from: stop retrying (never send as anyone else) and say why.
                // NOT-A-USER-PATH: the retry queue — same rows Email.getPendingRetries() selected.
                await Email.markFailed(email.id, email.delivery_attempts || 0, err.message).catch(() => null);
                await notifyNoMailboxAddress(email, err).catch(() => null);
                return;
            }
            console.error(`[MailServer] Failed to retry email ${email.id}:`, err);
        }
    };

    // The queue's slot for the next row, in order: true = send it now.
    const claimQueueSlot = async () => {
        if (!SendRate || !(await sendRateLimit() > 0)) return true;
        return (await SendRate.claim()).ok;
    };

    const queueTick = async () => {
        // Scheduled sends and retries are ONE queue: due rows go out oldest first, whichever list they
        // are on, so the sending rate (see sendRateGate) hands its slots out in order. When the rate is
        // used up the pass stops; what is left stays due and is first in line next time.
        try {
            const [scheduled, retries] = await Promise.all([Email.getPendingScheduled(), Email.getPendingRetries()]);
            const dueAt = (v) => { const t = createAdminStore.sqlTimeOf(v); return Number.isFinite(t) ? t : 0; };
            const due = [
                ...scheduled.map((email) => ({ kind: 'scheduled', email, at: dueAt(email.scheduled_at) })),
                ...retries.map((email) => ({ kind: 'retry', email, at: dueAt(email.next_attempt_at) })),
            ].sort((a, b) => (a.at - b.at) || ((parseInt(a.email.id, 10) || 0) - (parseInt(b.email.id, 10) || 0)));
            if (scheduled.length > 0) console.log(`[MailServer] Processing ${scheduled.length} scheduled emails...`);
            if (retries.length > 0) console.log(`[MailServer] Processing ${retries.length} retry emails...`);
            for (const item of due) {
                const r = item.kind === 'scheduled' ? await dispatchScheduled(item.email) : await dispatchRetry(item.email);
                if (r === 'stop') {
                    console.log(`[MailServer] Sending rate reached; ${due.length - due.indexOf(item)} message(s) wait for the next minute.`);
                    break;
                }
            }
        } catch (e) {
            console.error('[MailServer] Queue error:', e);
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
                // Same cadence: staged uploads nobody sent or saved within a day.
                await Email.sweepStaging().catch(() => 0);
                if (SendRate) await SendRate.sweep().catch(() => null);
            }
        } catch (e) {
            console.error('[MailServer] Spam purge error:', e);
        }

        // Logged system messages whose first delivery was cut off (see requeueInterruptedSystemMail).
        try {
            const now = Date.now();
            if (Admin && now - _lastInterruptedSweep > 5 * 60 * 1000) {
                _lastInterruptedSweep = now;
                for (const [id, at] of firstDeliveriesInFlight) if (now - at > 60 * 60 * 1000) firstDeliveriesInFlight.delete(id);
                const ids = await Admin.requeueInterruptedSystemMail(INTERRUPTED_AFTER_MS, INTERRUPTED_MAX_AGE_MS, new Set(firstDeliveriesInFlight.keys()));
                if (ids.length > 0) console.warn(`[MailServer] Re-queued ${ids.length} system message(s) whose first delivery was interrupted: ${ids.join(', ')}.`);
            }
        } catch (e) {
            console.error('[MailServer] Interrupted-delivery sweep error:', e && e.message);
        }

        // The system Sent log's retention (see SYSTEM SENT LOG), at most hourly.
        try {
            const now = Date.now();
            if (now - _lastSystemSentPurge > 60 * 60 * 1000) {
                _lastSystemSentPurge = now;
                const purged = await Admin.purgeSystemSent(await systemSentRetentionDays());
                if (purged > 0) console.log(`[MailServer] Purged ${purged} system message(s) past their retention.`);
            }
        } catch (e) {
            console.error('[MailServer] System Sent purge error:', e && e.message);
        }
        // 15s tick (was 60s): the queue drives UNDO SEND (a message sits in the outbox for
        // ~10s before dispatch), so a 60s tick would stretch "sending…" to over a minute. All the
        // sweeps above are indexed probes that no-op when there's nothing pending.
    };
    // ONE pass at a time: a slow delivery (a relay doing STARTTLS, a remote MX taking its time) used to
    // overlap the next 15 s tick, which picked the same still-pending row and sent it a second time.
    queueInterval = setInterval(async () => {
        if (queueTickRunning) return;
        queueTickRunning = true;
        try { await queueTick(); } finally { queueTickRunning = false; }
    }, 15 * 1000);

    // === API ROUTES — namespaced by the host under /api/v1/plugin/mail-server/* ===
    // No 'absolute' bypass exists anymore: wordjs.http.route prefixes /api/v1/plugin/<slug>, so we pass
    // only the sub-path. The plugin's frontend (client/) calls api('/plugin/mail-server/...').

    // === MAIL-SURFACE GATE ========================================================================
    // Using the mail features requires an ACTIVE CORPORATE MAILBOX (hasCorporateMailbox — the one
    // definition, up top: the grant an ADMINISTRATOR set, never anything the account can write itself).
    // `{ auth: true }` alone is NOT enough: it only proves *some* account is logged in, so before this
    // every authenticated user — a subscriber with no inbox on this server at all — could POST /send and
    // push mail through the site MTA, signed with the site DKIM key, spending the domain's reputation.
    //
    // The check lives in THIS helper rather than in ~30 handlers so it cannot be forgotten on a future
    // route: a route opts in with `mailbox: true` and the guard is applied for it, once, here.
    // `mailbox` is a PLUGIN-LOCAL option — the host only understands auth/admin/multipart — so it is
    // stripped before the registration crosses the bridge, and it implies auth (a gated route without
    // authentication would have no user to check, i.e. it would deny everything).
    //
    // AND THE OPTION-LESS FORM FAILS CLOSED. `route(method, sub, handler)` — a form this helper has
    // always accepted — used to register a route with NO options at all, i.e. UNAUTHENTICATED, which is
    // the worst possible default for a mail plugin and the one a reviewer is least likely to notice. It
    // now means `{ auth: true, mailbox: true }`. A route that genuinely wants to be public or
    // admin-only has to say so, and the gate suite's registered-vs-declared set equality fails on any
    // route that reaches the bridge without being classified — in ANY syntactic form.
    //
    // ADMINISTRATORS PASS WITHOUT A MAILBOX OF THEIR OWN, deliberately:
    //   - inbound catch-all mail (no matching mailbox) is stored OWNED BY THE SITE ADMIN
    //     (getAdminUser() in the onData handler), so an admin whose account email is a personal
    //     address would otherwise be locked out of the mail they own;
    //   - canAccessEmail already grants administrators read access to any message (same role-based
    //     override, same reason: req.user here is the users:read projection and carries no capability
    //     map). Denying them the surface would contradict that;
    //   - the host makes the same call for menu visibility — backend/src/routes/plugins.ts keeps
    //     `requiresAccountCapability` items visible to administrators — so a stricter rule here
    //     would show an admin a menu entry whose page only 403s.
    // If a capability bridge ever lands, replace BOTH role checks (here and canAccessEmail) with an
    // explicit capability at the same time.
    //
    // NOTE it does NOT consult the mail domain. Access is the GRANT alone, so changing
    // `mail_security_dkim_domain` (or moving the site to/from a `www.` host) can never 403 every
    // non-admin out of the whole webmail while the server happily keeps signing and sending.
    const canUseMailSurface = (user) => {
        if (!user) return false;
        if (user.role === 'administrator') return true;
        return hasCorporateMailbox(user);
    };
    const denyNoMailbox = (res) => res.status(403).json({
        code: 'mail_no_corporate_mailbox',
        error: 'Your account has no active corporate mailbox, so it cannot send or read mail on this ' +
            'server. Ask an administrator to enable the professional mail account for your user ' +
            '(Users → edit user → Professional Mail Account), then reload this page.'
    });

    const route = (method, sub, opts, handler) => {
        // FAIL CLOSED on the option-less form: no declaration means the strictest one, not none.
        if (typeof opts === 'function') { handler = opts; opts = { auth: true, mailbox: true }; }
        const { mailbox, ...hostOpts } = (opts || {});
        if (mailbox) hostOpts.auth = true; // a mailbox-gated route is always authenticated
        const finalHandler = mailbox
            ? async (req, res) => {
                // Re-evaluated on EVERY request off the host's freshly-loaded req.user — never cached,
                // so losing the mailbox denies immediately (see hasCorporateMailbox).
                if (!canUseMailSurface(req.user)) return denyNoMailbox(res);
                return handler(req, res);
            }
            : handler;
        wordjs.http.route(method, sub, hostOpts, finalHandler);
    };

    // GET /api/v1/plugin/mail-server/mailbox — "may I use the mail UI?", for the client shell.
    // Deliberately NOT mailbox-gated: it is the probe that TELLS a user they have no mailbox, so it
    // must answer instead of 403-ing. Answers through canUseMailSurface so the UI can never disagree
    // with the gate.
    route('get', '/mailbox', { auth: true }, async (req, res) => {
        const mailDomain = await getMailDomain();
        const hasMailbox = hasCorporateMailbox(req.user);
        res.json({
            hasMailbox,
            canUseMail: canUseMailSurface(req.user),
            isAdmin: req.user.role === 'administrator',
            // The address they actually receive at — empty when the grant is on but the account address
            // is not on the mail domain (an admin-side inconsistency the UI should not paper over).
            address: mailboxAddressOf(req.user, mailDomain) || null,
            siteDomain: mailDomain
        });
    });

    // SECURITY: authorize a request against a single email record — THE ownership predicate, and the
    // SAME one every collection query in the store uses (Email._ownsRow is the JS twin of
    // _ownerClause). There is deliberately one rule for the whole plugin.
    //
    // It used to be Email.canUserAccess(email, user.userEmail): pure ADDRESS membership. Under the
    // ownership model every party holds their OWN copy of a message and every copy names every
    // recipient — so address membership authorized Ana over MARIANA'S rows. That is how irreversible
    // cross-user destruction survived the fix for it: emptyTrash was tightened to _ownsRow while
    // DELETE /emails/:id and POST /emails/bulk {action:'delete'} kept the address rule and reached the
    // very same Email.deleteManyPermanently — as did every flag writer (star/archive/read/spam/labels)
    // and the attachment download. _ownsRow falls back to canUserAccess ONLY for un-backfilled
    // (user_id = 0) rows, which nobody owns yet.
    //
    // (The address rule itself replaced `email.to_address !== req.user.userEmail`, which matched
    // neither cc/bcc recipients nor a member of a multi-recipient To list; canUserAccess survives as
    // that exact-token membership test inside _ownsRow's legacy arm.)
    //
    // The `administrator` override is preserved (existing behavior); note that in this sandboxed plugin
    // req.user is the users:read projection {id,userLogin,username,userEmail,displayName,role} and
    // carries no capability map, so the override keys off role. If/when a dedicated capability bridge
    // exists, gate this behind an explicit 'read_others_mail' capability instead of the bare role.
    const canAccessEmail = (email, user) =>
        !!user && (Email._ownsRow(email, user.id, user.userEmail) || user.role === 'administrator');

    // FORWARDED ATTACHMENTS: to forward a message WITH its files, the composer names each stored
    // attachment by its row id (`attachmentId`) — never by a path. The id is honoured only when the
    // caller may read the message it belongs to (the same canAccessEmail test as the download route),
    // and it becomes a path inside our own attachment dir built from storage_path. An id the caller
    // may not read, or that does not exist, is DROPPED. Entries without an id (fresh uploads) pass
    // through unchanged to the store's path resolver.
    //
    // A fresh upload whose file can no longer be read (expired staging, or a path from before 3.2.0
    // that pointed into the host's temp dir) is collected in `out.unreadable`: the routes REFUSE the
    // send/save with its name instead of delivering the message without the file the user attached.
    const resolveComposerAttachments = async (list, user) => {
        const out = [];
        out.unreadable = [];
        for (const a of (Array.isArray(list) ? list : []).slice(0, 50)) {
            if (!a || typeof a !== 'object') continue;
            if (a.attachmentId === undefined || a.attachmentId === null) {
                if (a.path && !(await Email.resolveAttachmentSource(a.path))) {
                    out.unreadable.push(String(a.filename || 'attachment').slice(0, 120));
                    continue;
                }
                out.push(a);
                continue;
            }
            // NOT-A-USER-PATH: read only to be gated — canAccessEmail(parent) below decides before any use.
            const row = await Email.getAttachmentById(parseInt(a.attachmentId, 10) || 0);
            // NOT-A-USER-PATH: the parent row is what the gate below is asked about.
            const parent = row && await Email.findById(row.email_id);
            if (!row || !row.storage_path || !parent || !canAccessEmail(parent, user)) continue;
            out.push({ filename: row.filename, contentType: row.content_type, size: row.size, path: path.join(UPLOAD_DIR, row.storage_path) });
        }
        return out;
    };

    const refuseUnreadableAttachments = (res, attachments) => {
        if (!attachments || !attachments.unreadable || !attachments.unreadable.length) return false;
        res.status(400).json({
            code: 'mail_attachment_unreadable',
            unreadable: attachments.unreadable,
            error: `These attachments could not be read and were not sent: ${attachments.unreadable.join(', ')}. Remove them and attach the files again.`
        });
        return true;
    };

    // GET /api/v1/plugin/mail-server/emails/search — operator-aware (from:/to:/subject:/label:/in:/
    // has:attachment/is:unread/is:starred + free text), scoped to the requester's mailbox.
    route('get', '/emails/search', { auth: true, mailbox: true }, async (req, res) => {
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
            const labels = await Email.getLabelsForEmails(emails.map(e => e.id), req.user.id);
            res.json({ emails, labels });
        } catch (error) {
            console.error("Search error:", error);
            res.status(500).json({ error: "Search failed" });
        }
    });

    // GET /api/v1/plugin/mail-server/emails — folder listing. Also accepts folder=spam and
    // folder=label:<id>. Returns badge counts + the listed messages' labels in the SAME response so
    // the client needs ONE request per poll (it used to issue /emails + /stats).
    route('get', '/emails', { auth: true, mailbox: true }, async (req, res) => {
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
            const labels = await Email.getLabelsForEmails(emails.map(e => e.id), req.user.id);
            res.json({ emails, total, counts, labels });
        } catch (error) {
            console.error('Listing failed:', error);
            res.status(500).json({ error: 'Failed to load messages' });
        }
    });

    // GET /api/v1/plugin/mail-server/stats — kept for back-compat; same single-pass counters.
    route('get', '/stats', { auth: true, mailbox: true }, async (req, res) => {
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
    route('get', '/emails/:id', { auth: true, mailbox: true }, async (req, res) => {
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
        // The requester's ID as well as their address: the thread returns FULL rows, so it is filtered
        // by OWNERSHIP (and excludes drafts, which are nobody else's conversation — an unsent reply in
        // a shared thread was being handed over verbatim).
        const thread = await Email.findByThreadId(threadIdToSearch, req.user.id, req.user.userEmail, { includeSpam: !!email.is_spam });

        const ids = [email.id, ...(thread || []).map(t => t.id)];
        const [attMap, labelMap] = await Promise.all([
            Email.getAttachmentsForEmails(ids),
            Email.getLabelsForEmails(ids, req.user.id)
        ]);
        const withExtras = (msg) => ({ ...msg, attachments: attMap[msg.id] || [], labels: labelMap[msg.id] || [] });

        if (thread && thread.length > 1) {
            return res.json({ ...withExtras(email), thread: thread.map(withExtras) });
        }
        res.json(withExtras(email));
    });

    // DELETE /api/v1/plugin/mail-server/emails/:id - Move to Trash (Soft Delete)
    route('delete', '/emails/:id', { auth: true, mailbox: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        if (!canAccessEmail(email, req.user)) {
            return res.status(403).json({ error: 'Cannot delete this message' });
        }

        // If already in trash, delete permanently. The ACTOR travels with the call: the store's
        // deleteManyPermanently re-checks every row against Email._mayDestroyRow, which is STRICTER
        // than canAccessEmail above — an un-attributed (user_id = 0) row can have several site
        // accounts as parties, and permanent destruction is not a thing any of them may do to the
        // others. See the ownership header in lib/email-store.js.
        if (email.is_trash === 1) {
            const destroyed = await Email.deletePermanently(req.params.id, {
                userId: req.user.id, userEmail: req.user.userEmail
            });
            if (destroyed === 0) {
                return res.status(409).json({
                    code: 'mail_shared_legacy_row',
                    error: 'This message predates the mailbox upgrade and more than one account is a ' +
                        'party to it, so it cannot be destroyed permanently — it stays in your trash.'
                });
            }
            return res.json({ success: true, message: 'Deleted permanently' });
        }

        await Email.moveToTrash(req.params.id);
        res.json({ success: true, message: 'Moved to trash' });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/restore - Restore from Trash
    route('put', '/emails/:id/restore', { auth: true, mailbox: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        if (!canAccessEmail(email, req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await Email.restoreFromTrash(req.params.id);
        res.json({ success: true, message: 'Restored from trash' });
    });

    // DELETE /api/v1/plugin/mail-server/trash/empty - Empty Trash
    //
    // This is a PERMANENT, collection-wide delete (attachment blobs included), and it is the only one
    // reachable by a plain button press. The per-id routes above check canAccessEmail and /emails/bulk
    // filters to `mine`; emptyTrash was the one path that deleted by clause alone, which is how one
    // mailbox could destroy another's trash. Email.emptyTrash now applies the same exact ownership
    // check to every row before deleting it, and reports how many were actually destroyed rather than
    // an unconditional "Trash emptied".
    route('delete', '/trash/empty', { auth: true, mailbox: true }, async (req, res) => {
        try {
            const deleted = await Email.emptyTrash(req.user.id, req.user.userEmail);
            res.json({ success: true, deleted, message: `Trash emptied (${deleted} message(s) deleted)` });
        } catch (e) {
            // The store REFUSES rather than half-emptying a trash it could only partly enumerate.
            // Reporting "Trash emptied (0 deleted)" over mail that is still there is the failure this
            // replaces, so surface the refusal instead of swallowing it into a cheerful success.
            if (e && (e.code === 'mail_legacy_scan_incomplete' || e.code === 'mail_identity_unavailable')) {
                return res.status(503).json({ code: e.code, error: e.message });
            }
            console.error('[MailServer] Empty trash failed:', e && e.message);
            res.status(500).json({ error: 'Empty trash failed' });
        }
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/star
    route('put', '/emails/:id/star', { auth: true, mailbox: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        // canAccessEmail, like every other per-id route: writing a flag onto ANOTHER user's row is a
        // cross-mailbox mutation even when it is only a star.
        if (!canAccessEmail(email, req.user)) return res.status(403).json({ error: 'Forbidden' });

        await Email.setStarred(req.params.id, req.body.starred);
        res.json({ success: true });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/archive
    route('put', '/emails/:id/archive', { auth: true, mailbox: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (!canAccessEmail(email, req.user)) return res.status(403).json({ error: 'Forbidden' });

        await Email.setArchived(req.params.id, req.body.archived);
        res.json({ success: true });
    });

    // POST /api/v1/plugin/mail-server/classification/train
    route('post', '/classification/train', { auth: true, mailbox: true }, async (req, res) => {
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
                await Email.setSpam(id, true, req.user.id);
            } else if (category === 'ham') {
                await Email.setSpam(id, false, req.user.id);
                if (email.is_trash) await Email.restoreFromTrash(id);
            }

            res.json({ success: true, message: `Learned as ${category}` });
        } catch (error) {
            console.error('Training failed:', error);
            res.status(500).json({ error: 'Training failed' });
        }
    });

    // POST /api/v1/plugin/mail-server/drafts
    route('post', '/drafts', { auth: true, mailbox: true }, async (req, res) => {
        const { id, to, cc, bcc, subject, body, isHtml = true, replyToId } = req.body;
        const attachments = await resolveComposerAttachments(req.body.attachments, req.user);
        if (refuseUnreadableAttachments(res, attachments)) return;

        // A draft is a message waiting to be sent: it may not hold more recipients than a send allows.
        const draftRecipients = splitAddresses(to).length + splitAddresses(cc).length + splitAddresses(bcc).length;
        if (draftRecipients > MAX_RECIPIENTS_PER_MESSAGE) {
            return res.status(400).json({ error: `Too many recipients (max ${MAX_RECIPIENTS_PER_MESSAGE} per message).` });
        }

        try {
            const data = {
                // The address this draft would be SENT from: the caller's mailbox address, never a personal
                // account email ('' when the account has none — the send itself is then refused).
                fromAddress: mailboxAddressOf(req.user, await getMailDomain().catch(() => '')),
                fromName: await displayNameOf(req.user),
                toAddress: splitAddresses(to).join(', '),
                ccAddress: splitAddresses(cc).join(', '),
                bccAddress: splitAddresses(bcc).join(', '),
                subject: subject || '',
                bodyText: isHtml ? stripHtml(body) : body,
                bodyHtml: isHtml ? body : null,
                rawContent: body || '',
                isDraft: 1,
                isSent: 0,
                parentId: 0,
                threadId: 0,
                userId: req.user.id,
                attachments: attachments || []
            };

            // A reply joins the parent's conversation only when the parent is the CALLER'S OWN row
            // (_ownsRow): an id they merely guessed, or can read as an administrator, starts a new one.
            if (replyToId) {
                const parent = await Email.findById(replyToId);
                if (parent && Email._ownsRow(parent, req.user.id, req.user.userEmail)) {
                    data.parentId = parent.id;
                    data.threadId = parent.thread_id || parent.id;
                }
            }

            let email;
            if (id) {
                const existing = await Email.findById(id);
                // SECURITY (IDOR): the row must be the CALLER'S OWN, by ownership. Comparing
                // from_address to the caller's address accepted the RECIPIENT'S COPY of any message
                // this user had sent them — a row owned by that recipient — and Email.update below
                // then overwrote its subject and body and flipped it to is_draft = 1, destroying the
                // message in the other mailbox. _ownsRow still covers a legacy (user_id = 0) draft of
                // the caller's through the exact-token address check.
                if (!existing || !Email._ownsRow(existing, req.user.id, req.user.userEmail)) {
                    return res.status(403).json({ error: 'Access denied' });
                }
                // SAVE AS NEW, NOT IN PLACE, on a pre-v2.1 row that is the only copy several
                // mailboxes have. Rewriting it here would overwrite a colleague's message while every
                // membership check still said yes — round 4's reproduction. The store refuses it
                // outright (mail_shared_row_immutable); doing it deliberately HERE means the author
                // keeps their draft, owned by them, instead of getting a 409 they cannot act on. The
                // response carries the new id, so the composer's next autosave is an ordinary update.
                if (await Email._isSharedRow(existing)) {
                    email = await Email.create(data);
                } else {
                    email = await Email.update(id, data);
                }
            } else {
                email = await Email.create(data);
            }
            res.json({ success: true, id: email.id });
        } catch (error) {
            // The store refuses to shrink the party set of a pre-v2.1 shared row — that is not a
            // server fault, it is the other mailbox's copy being protected. Say so.
            // Both refusals mean the same thing to a client: this row belongs to more than one
            // mailbox, so it cannot be changed in place. The routes above already turn that into a
            // save-as-new, so reaching here means a path that did not — say so instead of a 500.
            if (error && (error.code === 'mail_shared_row_party_narrowed' || error.code === 'mail_shared_row_immutable')) {
                return res.status(409).json({ error: error.message });
            }
            console.error("Draft save failed:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /api/v1/plugin/mail-server/send
    route('post', '/send', { auth: true, mailbox: true }, async (req, res) => {
        const { to, cc, bcc, isHtml = true, replyToId, id, scheduledAt } = req.body;
        // A message may have an empty subject or body (the composer asks first) — only a recipient is required.
        const subject = String(req.body.subject == null ? '' : req.body.subject);
        const body = String(req.body.body == null ? '' : req.body.body);
        if (!to) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // WHO this goes out as: the caller's mailbox address on the mail domain, and nothing else. An
        // account that passes the gate on the grant but has no on-domain address (its email is personal)
        // is refused here, visibly, before anything is queued or charged — see sendingIdentityOf.
        let identity;
        try { identity = await sendingIdentityOf(req.user); } catch (e) {
            if (e && e.code === NO_MAILBOX_ADDRESS) return res.status(403).json({ error: e.message, code: NO_MAILBOX_ADDRESS });
            throw e;
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
        // could overwrite (and effectively send as) another user's draft by guessing its id. The
        // `|| from_address matches me` arm that used to widen this accepted rows OWNED BY SOMEONE
        // ELSE (their copy of a message I sent them carries my address); _ownsRow keeps the legacy
        // (user_id = 0) case it was really there for and drops the rest.
        // A pre-v2.1 row shared with another mailbox is not this caller's to promote into the
        // outbox: doing so overwrote the colleague's message AND left the row's from_address — a
        // colleague's address — as the identity the send queue would have used. Send it as a NEW
        // message of the caller's own instead; the shared row is left exactly as it was.
        const attachments = await resolveComposerAttachments(req.body.attachments, req.user);
        if (refuseUnreadableAttachments(res, attachments)) return;

        let sendAsNew = false;
        if (id) {
            const existing = await Email.findById(id);
            if (!existing || !Email._ownsRow(existing, req.user.id, req.user.userEmail)) {
                return res.status(403).json({ error: 'Access denied' });
            }
            sendAsNew = await Email._isSharedRow(existing);
        }

        let parentId = 0;
        let threadId = 0;

        // Same rule as POST /drafts: only the caller's own row lends its conversation to a reply.
        if (replyToId) {
            const parent = await Email.findById(replyToId);
            if (parent && Email._ownsRow(parent, req.user.id, req.user.userEmail)) {
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
                    // null = an administrator answering as the site (sendingIdentityOf); the queue resolves it again.
                    fromAddress: identity ? identity.fromEmail : '',
                    fromName: identity ? identity.fromName : await displayNameOf(req.user),
                    toAddress: toList.join(', '),
                    ccAddress: ccList.join(', '),
                    bccAddress: bccList.join(', '),
                    subject: subject || '',
                    bodyText: isHtml ? stripHtml(body) : body,
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
                if (id && !sendAsNew) {
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
                noteQueuedCharge(email.id, recipientCount);

                if (scheduledAt) {
                    return res.json({ success: true, message: 'Message scheduled', id: email.id });
                }
                return res.json({ success: true, queued: true, undoSeconds, id: email.id, message: 'Sending…' });
            }

            // Undo window disabled (mail_undo_send_seconds = 0) → immediate delivery, answered within
            // HANDOFF_ANSWER_MS (a slow MX finishes in the background; the Sent copy shows the outcome).
            const sending = sendMail({
                to: toList,
                cc: ccList,
                bcc: bccList,
                subject,
                text: isHtml ? stripHtml(body) : body,
                html: isHtml ? body : null,
                identity,
                parentId,
                threadId,
                userId: req.user.id,
                // A shared row is never the record this send updates — see sendAsNew above. Without
                // an id sendMail writes a fresh Sent copy owned by the sender.
                draftId: sendAsNew ? 0 : id,
                attachments: attachments || []
            });
            const settled = await settleWithin(sending, HANDOFF_ANSWER_MS, 'A message sent from the mailbox');
            if (!settled.done) {
                return res.status(202).json({ success: true, pending: true, message: 'Still sending — delivery continues in the background.' });
            }
            const result = settled.value;
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
            // Both refusals mean the same thing to a client: this row belongs to more than one
            // mailbox, so it cannot be changed in place. The routes above already turn that into a
            // save-as-new, so reaching here means a path that did not — say so instead of a 500.
            if (error && (error.code === 'mail_shared_row_party_narrowed' || error.code === 'mail_shared_row_immutable')) {
                return res.status(409).json({ error: error.message });
            }
            res.status(500).json({ error: 'Delivery failed: ' + error.message });
        }
    });

    // POST /api/v1/plugin/mail-server/emails/:id/unsend — cancel a message still in its undo window
    // (or a scheduled send) and turn it back into a draft. Guarded on is_sent = 0 in the UPDATE
    // itself, so racing the queue can never "unsend" something already handed to delivery.
    route('post', '/emails/:id/unsend', { auth: true, mailbox: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        // Same ownership predicate as every other per-id route (the from_address arm this replaces
        // accepted rows owned by their recipient).
        if (!Email._ownsRow(email, req.user.id, req.user.userEmail)) return res.status(403).json({ error: 'Forbidden' });
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
    route('post', '/emails/:id/retry', { auth: true, mailbox: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        // canAccessEmail is exactly "own it, or be an administrator", which is what this route meant.
        if (!canAccessEmail(email, req.user)) return res.status(403).json({ error: 'Forbidden' });
        const out = await retryFailedDelivery(email, req.user.id);
        res.status(out.status).json(out.body);
    });

    // GET /api/v1/plugin/mail-server/users/search
    route('get', '/users/search', { auth: true, mailbox: true }, async (req, res) => {
        const query = req.query.q || '';
        if (query.length < 2) return res.json([]);

        // Suggest the address a colleague can actually RECEIVE at — the same mailboxAddressOf() the
        // delivery paths use. Synthesizing `<login>@<domain>` for every user in the directory advertised
        // addresses that do not exist (mail to them lands in the catch-all, or bounces).
        const mailDomain = await getMailDomain();
        const users = await User.findAll({ search: query, limit: 5 });
        res.json(users
            .map(u => ({ addr: mailboxAddressOf(u, mailDomain), u }))
            .filter(x => !!x.addr)
            .map(({ addr, u }) => ({
                email: addr,
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
            mail_relay_require_tls: '1', mail_relay_mode: 'always',
            mail_security_dkim_domain: '', mail_security_dkim_selector: 'default',
            mail_security_dkim_private_key: '',
            // Defaults reflect the SAFE posture (H12): DNSBL + SPF default ON, SPF reject default ON.
            mail_security_dnsbl_enabled: '1', mail_security_spf_enabled: '1', mail_security_spf_reject: '1',
            mail_security_dmarc_enabled: '1',
            mail_undo_send_seconds: '10',
            mail_blocked_senders: '', mail_allowed_senders: '', mail_quota_default_mb: '0', mail_forwarding_allowed: '1',
            [SEND_RATE_OPTION]: '0',
            [SYSTEM_SENT_RETENTION_OPTION]: String(createAdminStore.SYSTEM_SENT_RETENTION_DEFAULT)
        });
        const mailDomainNow = await getMailDomain().catch(() => '');
        res.json({
            mail_from_email: o.mail_from_email,
            // The address site mail ACTUALLY goes out as (an off-domain stored value is not used).
            mail_from_effective: siteSenderAddress(o.mail_from_email, mailDomainNow),
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
            // 'host' = WordJS listens for this plugin (smtp:inbound); 'plugin' = the plugin's own listener.
            inbound_mode: inboundStatus.mode || 'plugin',
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
            // 'always' (every external message through the relay) or 'fallback' (direct first, the relay
            // when that fails or is paused).
            mail_relay_mode: o.mail_relay_mode === 'fallback' ? 'fallback' : 'always',
            // While a delivery with no reply from any mail server keeps direct delivery paused (ISO).
            direct_paused_until: directPausedUntil > Date.now() ? new Date(directPausedUntil).toISOString() : null,
            // The general queue's sending rate (messages per minute, 0 = no cap).
            [SEND_RATE_OPTION]: String(parsePerMinute(o[SEND_RATE_OPTION])),
            // Whether the configured relay answered its last check, and why not (see initTransporter).
            relay_status: relayStatus,
            // The domain mailboxes live on, and whether the internet can deliver to it at all (a site
            // reached by IP, 'localhost' or a LAN name gives mailboxes like admin@localhost).
            mail_domain: mailDomainNow,
            mail_domain_public: isPublicSendingDomain(mailDomainNow),
            mail_security_dkim_domain: o.mail_security_dkim_domain,
            mail_security_dkim_selector: o.mail_security_dkim_selector,
            mail_security_dkim_enabled: o.mail_security_dkim_private_key ? '1' : '0',
            mail_security_dnsbl_enabled: o.mail_security_dnsbl_enabled,
            mail_security_spf_enabled: o.mail_security_spf_enabled,
            mail_security_spf_reject: o.mail_security_spf_reject,
            mail_security_dmarc_enabled: o.mail_security_dmarc_enabled,
            // Undo-send window in seconds (0 disables and restores synchronous delivery).
            mail_undo_send_seconds: o.mail_undo_send_seconds,
            // Site-wide policy: sender block/allow lists (one address or @domain per line), the default
            // mailbox quota in MB (0 = unlimited) and whether users may auto-forward outside the server.
            mail_blocked_senders: o.mail_blocked_senders,
            mail_allowed_senders: o.mail_allowed_senders,
            mail_quota_default_mb: o.mail_quota_default_mb,
            mail_forwarding_allowed: o.mail_forwarding_allowed,
            // Days the system Sent log keeps a message (0 = it keeps nothing).
            [SYSTEM_SENT_RETENTION_OPTION]: String(createAdminStore.normalizeRetentionDays(o[SYSTEM_SENT_RETENTION_OPTION]))
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

        // The site's From must be an address on the mail domain (see siteSenderAddress): refuse an
        // off-domain one here, clearly, instead of storing a value sendMail would never use.
        if (req.body.mail_from_email !== undefined && String(req.body.mail_from_email).trim() !== '') {
            const from = String(req.body.mail_from_email).trim().toLowerCase();
            const dkimDomain = req.body.mail_security_dkim_domain !== undefined
                ? req.body.mail_security_dkim_domain
                : await getOption('mail_security_dkim_domain', '');
            const domain = resolveMailDomain(dkimDomain, await getSiteDomain());
            if (!MAIL_ADDRESS_RE.test(from) || mailboxDomainOf(from) !== domain) {
                return res.status(400).json({
                    code: 'mail_from_off_domain',
                    error: `The From email must be an address on the mail domain (${domain}), for example noreply@${domain}. Leave it empty to use that one.`
                });
            }
            req.body.mail_from_email = from;
        }

        const fields = [
            'mail_from_email', 'mail_from_name',
            'smtp_listen_port', 'smtp_proxy_ips', 'smtp_catch_all',
            'mail_helo_host',
            // Relay / smarthost (mail_user/mail_pass route to the encrypted secrets table via isSecretOption).
            'mail_server', 'mail_port', 'mail_secure', 'mail_user', 'mail_pass', 'mail_relay_require_tls', 'mail_relay_mode',
            'mail_security_dkim_domain', 'mail_security_dkim_selector',
            'mail_security_dnsbl_enabled', 'mail_security_spf_enabled', 'mail_security_spf_reject',
            'mail_security_dmarc_enabled',
            'mail_undo_send_seconds',
            'mail_blocked_senders', 'mail_allowed_senders', 'mail_quota_default_mb', 'mail_forwarding_allowed',
            SEND_RATE_OPTION
        ];
        // Normalize the policy values before they are stored (bounded, typed, one entry per line).
        if (req.body.mail_blocked_senders !== undefined) req.body.mail_blocked_senders = MailRules.normalizeSenderList(req.body.mail_blocked_senders, 2000).join('\n');
        if (req.body.mail_allowed_senders !== undefined) req.body.mail_allowed_senders = MailRules.normalizeSenderList(req.body.mail_allowed_senders, 2000).join('\n');
        if (req.body.mail_quota_default_mb !== undefined) req.body.mail_quota_default_mb = String(Math.min(Math.max(parseInt(req.body.mail_quota_default_mb, 10) || 0, 0), 1048576));
        if (req.body.mail_forwarding_allowed !== undefined) req.body.mail_forwarding_allowed = req.body.mail_forwarding_allowed === '0' || req.body.mail_forwarding_allowed === false ? '0' : '1';
        if (req.body[SEND_RATE_OPTION] !== undefined) req.body[SEND_RATE_OPTION] = String(parsePerMinute(req.body[SEND_RATE_OPTION]));
        if (req.body.mail_relay_mode !== undefined) req.body.mail_relay_mode = req.body.mail_relay_mode === 'fallback' ? 'fallback' : 'always';

        // The system Sent log's retention: one of the offered choices, nothing else. A SHORTER period
        // (or "keep nothing") deletes what it no longer covers right away — the screen asks first.
        let systemSentPurged = null;
        if (req.body[SYSTEM_SENT_RETENTION_OPTION] !== undefined) {
            const days = parseInt(String(req.body[SYSTEM_SENT_RETENTION_OPTION]), 10);
            if (!createAdminStore.SYSTEM_SENT_RETENTION_CHOICES.includes(days)) {
                return res.status(400).json({ code: 'mail_retention_invalid', error: `Retention must be one of ${createAdminStore.SYSTEM_SENT_RETENTION_CHOICES.join(', ')} days.` });
            }
            const before = await systemSentRetentionDays();
            await updateOption(SYSTEM_SENT_RETENTION_OPTION, String(days));
            forgetSystemSentRetention();
            if (days === 0 || before === 0 || days < before) {
                try { systemSentPurged = await Admin.purgeSystemSent(days); }
                catch (e) { return res.status(500).json({ error: 'The retention was saved, but the older messages could not be deleted yet; the hourly sweep will retry.' }); }
            }
        }
        // Saving only the retention (the system Sent screen) touches nothing the listeners depend on.
        const sentKeys = Object.keys(req.body || {});
        if (sentKeys.length > 0 && sentKeys.every(k => k === SYSTEM_SENT_RETENTION_OPTION)) {
            return res.json({ success: true, message: 'Server settings updated', systemSentPurged });
        }

        for (const f of fields) {
            if (req.body[f] === undefined) continue;
            // Don't wipe the stored relay password when the field is left blank on a normal save — the UI
            // only sends mail_pass when the admin is actually (re)setting it.
            if (f === 'mail_pass' && req.body[f] === '') continue;
            await updateOption(f, req.body[f]);
        }

        // Re-init BOTH the inbound listener AND the outbound relay transport so relay/port changes take
        // effect immediately (previously only initSMTPServer ran, so relay edits needed a full reload).
        invalidateDeliveryPolicy();
        _usageCache.clear();
        forgetSendRateLimit();
        await initSMTPServer();
        await initTransporter();
        res.json({ success: true, message: 'Server settings updated', systemSentPurged });
    });

    // POST /api/v1/plugin/mail-server/test  — send a real test message (pass {to} to test EXTERNAL delivery)
    route('post', '/test', { auth: true, admin: true }, async (req, res) => {
        try {
            const to = (req.body && req.body.to) || req.user.userEmail;
            // A LOCAL recipient (any local account's address) is delivered straight to the DB inbox and
            // never touches MX / DKIM / port 25 — so a green result there proves NOTHING about real
            // deliverability. Detect it and tell the admin plainly instead of a misleading "success".
            // NOT-A-DELIVERY-PATH: a DIAGNOSTIC probe for the admin-only test route. It only decides the
            // wording of the answer; sendMail below performs the real (guarded) delivery.
            const localUser = await User.findByEmail(to).catch(() => null);
            const settled = await settleWithin(sendMail({
                to,
                subject: 'WordJS Mail Server — delivery test',
                text: 'If you received this, outbound delivery is working.',
                html: '<p>If you received this, <strong>outbound delivery</strong> is working.</p>',
                userId: req.user.id,
                noRetry: true
            }), HANDOFF_ANSWER_MS, 'The delivery test');
            if (!settled.done) {
                // Not a verdict either way: the recipient's server has not answered yet (see HANDOFF_ANSWER_MS).
                return res.status(202).json({
                    success: false, pending: true, to, relay: relayStatus, delivered: [], failed: [],
                    message: `The recipient's mail server has not answered after ${HANDOFF_ANSWER_MS / 1000} s. The test goes on in the background; its result appears on the test message in your Sent folder. A server this slow usually means outbound port 25 is blocked or filtered.`
                });
            }
            const result = settled.value;
            const externalAttempted = (result.delivered && result.delivered.length) || (result.failed && result.failed.length);
            const localOnly = !!localUser && !externalAttempted;
            let message;
            if (localOnly) {
                message = `Delivered to the LOCAL mailbox of ${to} only — external MX / DKIM / port 25 were NOT exercised. Enter an OFF-domain address (e.g. a Gmail account) to test real internet deliverability.`;
            } else if (result.success) {
                message = 'Test message accepted by the recipient mail server (external delivery succeeded).';
            } else if (relayStatus.configured && !relayStatus.ok) {
                message = `Relay unavailable: ${relayStatus.error || 'not reachable'}. A test is not retried; real mail waits in the queue, and it is not sent direct-to-MX while a relay is configured.`;
            } else {
                message = 'Delivery failed — check rDNS/SPF/DKIM/DMARC and that outbound port 25 (or a configured relay) is reachable.';
            }
            res.status(result.success ? 200 : 207).json({
                success: result.success, to, localOnly, relay: relayStatus,
                delivered: result.delivered, failed: result.failed, message
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v1/plugin/mail-server/security/dns-records — records to publish for deliverability
    route('get', '/security/dns-records', { auth: true, admin: true }, async (req, res) => {
        const priv = await getOption('mail_security_dkim_private_key', '');
        // THE mail domain — one expression, shared with the HELO host, the From-alignment rewrite and
        // the inbound/local-delivery test, so the records this page tells the operator to publish are
        // always for the domain the server actually signs, sends and receives as.
        let domain = '';
        try { domain = await getMailDomain(); } catch (e) { domain = ''; }
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
            records: buildDnsRecords(domain, selector, publicKeyPem, { addresses: nodeAddressesKnown(), heloHost: await getHeloName() })
        });
    });

    // GET /api/v1/plugin/mail-server/security/dns-check — resolve the domain's LIVE DNS and compare it
    // to what WordJS expects, so the operator can confirm each record is actually published + correct
    // (not just eyeball it). Needs the `network` grant (same DNS resolver the outbound path already uses).
    route('get', '/security/dns-check', { auth: true, admin: true }, async (req, res) => {
        const priv = await getOption('mail_security_dkim_private_key', '');
        // THE mail domain — one expression, shared with the HELO host, the From-alignment rewrite and
        // the inbound/local-delivery test, so the records this page tells the operator to publish are
        // always for the domain the server actually signs, sends and receives as.
        let domain = '';
        try { domain = await getMailDomain(); } catch (e) { domain = ''; }
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

        // AAAA → when this node has a public IPv6, the mail host must resolve to it as well.
        const addrs = nodeAddressesKnown();
        const pub4 = (addrs.public || []).filter(ip => net.isIPv4(ip));
        const pub6 = addrs.public6 || [];
        const resolvedSet = async (host) => new Set([
            ...(await dns.resolve4(host).catch(() => [])),
            ...(await dns.resolve6(host).catch(() => [])),
        ].map(canonicalIp));
        const mailHostIps = await resolvedSet(mailHost);
        if (pub6.length) {
            const found = [...mailHostIps].filter(ip => net.isIPv6(ip));
            results.aaaa = { status: found.length === 0 ? 'missing' : (pub6.some(ip => mailHostIps.has(canonicalIp(ip))) ? 'ok' : 'mismatch'), found: found.join(', ') || null };
        }

        // Each public address mail can leave from, IPv4 and IPv6 alike — remote servers judge the one a
        // message actually came from: the mail host points at it, SPF authorizes it, and the HELO name
        // resolves back to it (the forward half of the reverse-DNS check). The PTR itself is set with the
        // IP provider and cannot be looked up from here (the host bridge offers no reverse lookups).
        const heloHost = await getHeloName();
        const heloIps = await resolvedSet(heloHost);
        results.senders = await Promise.all([...pub4, ...pub6].map(async (ip) => ({
            ip,
            family: net.isIPv6(ip) ? 6 : 4,
            host: mailHostIps.has(canonicalIp(ip)) ? 'ok' : 'missing',
            spf: await evaluateSPF(domain, ip).catch(() => 'temperror'),
            helo: heloIps.has(canonicalIp(ip)) ? 'ok' : 'mismatch',
            heloHost,
        })));

        // Persist the GENERIC `mail_delivery_ready` flag that core's password-recovery feature
        // ("olvidé mi contraseña") gates on — it is NOT a mail-server-specific option; any mail plugin
        // sets it to '1' when it is configured to deliver externally. For this self-hosted MTA that means
        // all deliverability records resolve (MX/A/SPF/DKIM/DMARC). Reflects the LAST real check;
        // re-checking after fixing a record clears/sets it accordingly.
        try {
            const allOk = ['mx', 'a', 'spf', 'dmarc', 'dkim'].every(k => results[k] && results[k].status === 'ok');
            // A configured relay decides readiness by answering (initTransporter), not by our DNS.
            if (!relayStatus.configured) await updateOption('mail_delivery_ready', allOk ? '1' : '0');
        } catch (e) { /* best-effort — never fail the check because the flag couldn't be saved */ }

        res.json({ domain, checkedAt: new Date().toISOString(), results });
    });

    // POST /api/v1/plugin/mail-server/security/dkim/generate — create a DKIM keypair + return DNS records
    route('post', '/security/dkim/generate', { auth: true, admin: true }, async (req, res) => {
        try {
            const selector = String((req.body && req.body.selector) || 'default').replace(/[^a-z0-9_-]/gi, '') || 'default';
            let domain = (req.body && req.body.domain) || '';
            if (!domain) { try { domain = await getMailDomain(); } catch (e) { } }
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

            res.json({ success: true, domain, selector, records: buildDnsRecords(domain, selector, publicKey, { addresses: nodeAddressesKnown(), heloHost: await getHeloName() }) });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v1/plugin/mail-server/attachments/:fileId
    route('get', '/attachments/:fileId', { auth: true, mailbox: true }, async (req, res) => {
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
    route('post', '/upload/attachment', { auth: true, mailbox: true, multipart: 'file' }, async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        // req.file.path comes from the HOST's multipart handler (multer), never from the request body.
        // The host deletes its temp file when THIS request ends, so the bytes are copied into the
        // plugin's own staging dir now and the composer gets an opaque token, never a server path.
        // A copy that fails is an upload that failed — said here, not discovered after sending.
        let token;
        try {
            token = await Email.stageUpload(req.file.path);
        } catch (e) {
            console.error(`[MailServer] Could not stage an uploaded attachment: ${e && e.message}`);
            return res.status(500).json({
                code: 'mail_attachment_unreadable',
                error: 'The mail server could not read the uploaded file, so it cannot be attached. Try again; if it keeps failing, check the Mail Server plugin in Plugins.'
            });
        }
        res.json({
            success: true,
            file: {
                filename: req.file.originalname,
                path: token,
                contentType: req.file.mimetype,
                size: req.file.size
            }
        });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/read — explicit read/unread toggle (Gmail parity).
    route('put', '/emails/:id/read', { auth: true, mailbox: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (!canAccessEmail(email, req.user)) return res.status(403).json({ error: 'Forbidden' });

        await Email.setRead(req.params.id, !!req.body.read);
        res.json({ success: true });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/spam — mark/unmark spam AND teach the Bayes filter.
    route('put', '/emails/:id/spam', { auth: true, mailbox: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (!canAccessEmail(email, req.user)) return res.status(403).json({ error: 'Forbidden' });

        const state = !!req.body.spam;
        // WHO flagged it is written to the row: the spam flag decides what site-wide retention
        // permanently destroys, and this route only asks the READ question (an administrator passes
        // it on anybody's mail). See Email._scopeClause / purgeOldSpam.
        await Email.setSpam(req.params.id, state, req.user.id);
        try {
            await classifier.learn((email.subject || '') + ' ' + (email.body_text || ''), state ? 'spam' : 'ham');
            await saveBayes();
        } catch (e) { /* training is best-effort */ }
        res.json({ success: true });
    });

    // POST /api/v1/plugin/mail-server/emails/bulk — one round-trip for multi-select actions.
    // Ownership is enforced per-row: ids the caller can't access are silently dropped, never touched.
    route('post', '/emails/bulk', { auth: true, mailbox: true }, async (req, res) => {
        try {
            const action = String((req.body && req.body.action) || '');
            const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 200) : [];
            const ACTIONS = ['read', 'unread', 'star', 'unstar', 'archive', 'unarchive', 'trash', 'restore', 'spam', 'notspam', 'label', 'unlabel', 'delete'];
            if (!ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });
            if (ids.length === 0) return res.status(400).json({ error: 'No messages selected' });

            const rows = await Email.findByIds(ids);
            // ONE predicate. The `r.user_id === req.user.id ||` prefix that used to sit here was
            // redundant (canAccessEmail now decides ownership first) and read as if the address arm
            // after it were a mere widening for legacy rows — while in fact it authorized this
            // caller over rows OWNED BY SOMEONE ELSE, and the 'delete' branch below is permanent.
            const mine = rows.filter(r => canAccessEmail(r, req.user));
            const okIds = mine.map(r => r.id);
            if (okIds.length === 0) return res.status(403).json({ error: 'No accessible messages in selection' });

            if (action === 'label' || action === 'unlabel') {
                const label = await Email.findLabel(parseInt(req.body.labelId, 10) || 0, req.user.id);
                if (!label) return res.status(404).json({ error: 'Label not found' });
                if (action === 'label') await Email.addLabelToEmails(okIds, label.id);
                else await Email.removeLabelFromEmails(okIds, label.id);
            } else if (action === 'delete') {
                // Permanent delete only for rows already in trash (mirrors the single-message rule).
                // The ACTOR is mandatory: the store re-checks each row against the STRICTER destruction
                // predicate, so a shared un-attributed row survives a bulk delete just as it survives
                // the per-id one. Same call, same gate, no third answer.
                await Email.deleteManyPermanently(
                    mine.filter(r => r.is_trash === 1).map(r => r.id),
                    { userId: req.user.id, userEmail: req.user.userEmail }
                );
            } else if (action === 'spam' || action === 'notspam') {
                await Email.bulkSetFlags(okIds, { isSpam: action === 'spam' ? 1 : 0, isArchived: 0 }, req.user.id);
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
                await Email.bulkSetFlags(okIds, map[action], req.user.id);
            }
            res.json({ success: true, updated: okIds.length });
        } catch (error) {
            console.error('Bulk action failed:', error);
            res.status(500).json({ error: 'Bulk action failed' });
        }
    });

    // === Labels (Gmail-style, per user) =====================================================
    route('get', '/labels', { auth: true, mailbox: true }, async (req, res) => {
        try {
            res.json({ labels: await Email.listLabels(req.user.id) });
        } catch (e) {
            res.status(500).json({ error: 'Failed to list labels' });
        }
    });

    const LABEL_COLOR_RE = /^#[0-9a-f]{6}$/i;
    route('post', '/labels', { auth: true, mailbox: true }, async (req, res) => {
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

    route('put', '/labels/:id', { auth: true, mailbox: true }, async (req, res) => {
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

    route('delete', '/labels/:id', { auth: true, mailbox: true }, async (req, res) => {
        const ok = await Email.deleteLabel(req.params.id, req.user.id);
        if (!ok) return res.status(404).json({ error: 'Label not found' });
        res.json({ success: true });
    });

    // PUT /api/v1/plugin/mail-server/emails/:id/labels — apply/remove labels on one message.
    route('put', '/emails/:id/labels', { auth: true, mailbox: true }, async (req, res) => {
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
        const labels = await Email.getLabelsForEmails([email.id], req.user.id);
        res.json({ success: true, labels: labels[email.id] || [] });
    });

    // === Per-user preferences: signature + vacation auto-responder ==========================
    route('get', '/prefs', { auth: true, mailbox: true }, async (req, res) => {
        try {
            const [prefs, policy] = await Promise.all([Email.getPrefs(req.user.id), getDeliveryPolicy()]);
            const v = (prefs.vacation && typeof prefs.vacation === 'object') ? prefs.vacation : {};
            res.json({
                signature: typeof prefs.signature === 'string' ? prefs.signature : '',
                vacation: {
                    enabled: !!v.enabled,
                    subject: v.subject || '',
                    message: v.message || '',
                    startsAt: v.startsAt || '',
                    endsAt: v.endsAt || ''
                },
                // Server-side filters, blocked senders, auto-forward and reply templates.
                rules: MailRules.normalizeRules(prefs.rules),
                blockedSenders: MailRules.normalizeSenderList(prefs.blockedSenders),
                forwarding: MailRules.normalizeForwarding(prefs.forwarding),
                templates: MailRules.normalizeTemplates(prefs.templates),
                // Whether the administrator allows forwarding outside the server at all.
                forwardingAllowed: policy.forwardingAllowed
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to load preferences' });
        }
    });

    route('put', '/prefs', { auth: true, mailbox: true }, async (req, res) => {
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
            if (req.body.rules !== undefined) next.rules = MailRules.normalizeRules(req.body.rules);
            if (req.body.blockedSenders !== undefined) next.blockedSenders = MailRules.normalizeSenderList(req.body.blockedSenders);
            if (req.body.templates !== undefined) next.templates = MailRules.normalizeTemplates(req.body.templates);
            if (req.body.forwarding !== undefined) {
                const fwd = MailRules.normalizeForwarding(req.body.forwarding);
                const policy = await getDeliveryPolicy();
                if (fwd.enabled && !policy.forwardingAllowed) {
                    return res.status(403).json({ error: 'The administrator has disabled forwarding mail outside this server.', code: 'mail_forwarding_disabled' });
                }
                // Forwarding to yourself (or anywhere on this server) is just a loop: refuse it.
                const mailDomain = await getMailDomain();
                if (fwd.enabled && fwd.address.split('@')[1] === mailDomain) {
                    return res.status(400).json({ error: 'Forward to an address outside this server — local addresses already receive here.', code: 'mail_forwarding_local' });
                }
                next.forwarding = fwd;
            }
            await Email.setPrefs(req.user.id, next);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Failed to save preferences' });
        }
    });

    // GET /api/v1/plugin/mail-server/contacts/suggest — recipient autocomplete that merges the site
    // user directory with the user's OWN correspondence history (people they actually mail).
    route('get', '/contacts/suggest', { auth: true, mailbox: true }, async (req, res) => {
        const query = String(req.query.q || '').trim();
        if (query.length < 2) return res.json([]);
        try {
            const mailDomain = await getMailDomain();
            const [users, history] = await Promise.all([
                User.findAll({ search: query, limit: 5 }).catch(() => []),
                Email.suggestContacts(req.user.id, req.user.userEmail, query, 8).catch(() => [])
            ]);
            const out = new Map();
            for (const u of (users || [])) {
                if (!u || !u.userLogin) continue;
                // Only colleagues who really have a mailbox here — same rule as delivery (see
                // mailboxAddressOf); a synthesized `<login>@<domain>` for everyone suggested addresses
                // that nobody receives at.
                const addr = mailboxAddressOf(u, mailDomain);
                if (!addr) continue;
                if (!out.has(addr)) out.set(addr, { email: addr, name: u.displayName || u.userLogin, source: 'user' });
            }
            for (const c of history) {
                if (!out.has(c.email)) out.set(c.email, { email: c.email, name: c.name || '', source: 'history' });
            }
            // The domain's enabled aliases / distribution lists are addresses colleagues write to as well.
            // Only the address is suggested — never who is behind it.
            try {
                const needle = query.toLowerCase();
                for (const a of await Admin.listAliases()) {
                    if (!a.enabled || !mailDomain) continue;
                    const addr = `${a.local_part}@${mailDomain}`;
                    if (!addr.includes(needle) || out.has(addr)) continue;
                    out.set(addr, { email: addr, name: '', source: 'alias' });
                }
            } catch (e) { /* aliases are a convenience here */ }
            res.json([...out.values()].slice(0, 8));
        } catch (e) {
            res.json([]);
        }
    });

    // GET /api/v1/plugin/mail-server/quota — this mailbox's storage use and limit (aggregates only).
    route('get', '/quota', { auth: true, mailbox: true }, async (req, res) => {
        try {
            res.json(await quotaStatus(req.user.id, true));
        } catch (e) {
            res.status(500).json({ error: 'Failed to read mailbox usage' });
        }
    });

    // === SERVER ADMINISTRATION (administrators only) =========================================
    // Not mailbox use: an administrator manages the server whether or not they have an inbox here,
    // exactly like /settings (see ADMIN_CONFIG_ROUTES in the gate suite).

    // GET /admin/overview — traffic for the last 14 days, totals, storage, queue and recent activity.
    route('get', '/admin/overview', { auth: true, admin: true }, async (req, res) => {
        try {
            const [stats, recent, policy, aliases] = await Promise.all([
                Admin.overview(14),
                Admin.recentActivity(20),
                getDeliveryPolicy(),
                Admin.listAliases()
            ]);
            res.json({
                ...stats,
                recent,
                aliases: aliases.length,
                inbound: {
                    boundPort: inboundStatus.boundPort,
                    // Where that port is: this node's addresses (on a multi-machine install, the backend).
                    addresses: nodeAddressesKnown(),
                    tls: inboundStatus.tls || null,
                    mode: inboundStatus.mode || 'plugin',
                    ok: inboundStatus.boundPort === 25,
                    degraded: inboundStatus.degraded,
                    reason: inboundStatus.reason
                },
                relay: relayStatus.configured,
                relayStatus,
                defaultQuotaMb: policy.defaultQuotaMb,
                mailDomain: await getMailDomain(),
                mailDomainPublic: isPublicSendingDomain(await getMailDomain()),
                // The generic flag the host reads to offer password recovery through this server.
                deliveryReady: String(await getOption('mail_delivery_ready', '0')) === '1'
            });
        } catch (e) {
            console.error('[MailServer] overview failed:', e);
            res.status(500).json({ error: 'Failed to load the overview' });
        }
    });

    // GET /admin/mailboxes — every account with a mailbox (or stored mail), with usage and quota.
    route('get', '/admin/mailboxes', { auth: true, admin: true }, async (req, res) => {
        try {
            const mailDomain = await getMailDomain();
            const [users, usage, overrides, policy] = await Promise.all([
                User.findAll({ search: String(req.query.q || ''), limit: 200 }).catch(() => []),
                Admin.usageByUser(),
                Admin.listQuotaOverrides(),
                getDeliveryPolicy()
            ]);
            const byId = new Map();
            for (const u of (users || [])) if (u && u.id) byId.set(u.id, u);
            // Owners of stored mail that the directory page did not return (search cap / filter).
            if (!req.query.q) {
                for (const id of Object.keys(usage).map(Number).filter(id => !byId.has(id)).slice(0, 100)) {
                    const u = await User.findById(id).catch(() => null);
                    if (u && u.id) byId.set(u.id, u);
                }
            }
            const list = [];
            for (const u of byId.values()) {
                const use = usage[u.id] || { messages: 0, unread: 0, sent: 0, spam: 0, bytes: 0, lastActivity: null };
                const hasMailbox = hasCorporateMailbox(u);
                if (!hasMailbox && use.messages === 0) continue;
                const override = overrides[u.id] !== undefined ? overrides[u.id] : -1;
                const quotaMb = override >= 0 ? override : policy.defaultQuotaMb;
                list.push({
                    id: u.id,
                    login: u.userLogin || u.username,
                    name: u.displayName || u.username || u.userLogin,
                    email: u.userEmail,
                    role: u.role,
                    hasMailbox,
                    address: mailboxAddressOf(u, mailDomain) || null,
                    // The grant without an address on the mail domain: this account can neither send (it has
                    // no identity to send as) nor receive here — flagged so an administrator fixes its email.
                    missingAddress: hasMailbox && !mailboxAddressOf(u, mailDomain),
                    ...use,
                    quotaOverride: override,
                    quotaMb,
                    percent: quotaMb > 0 ? Math.min(100, Math.round((use.bytes / (quotaMb * 1048576)) * 1000) / 10) : 0
                });
            }
            list.sort((a, b) => b.bytes - a.bytes || String(a.name).localeCompare(String(b.name)));
            res.json({ mailboxes: list, defaultQuotaMb: policy.defaultQuotaMb, mailDomain });
        } catch (e) {
            console.error('[MailServer] mailboxes failed:', e);
            res.status(500).json({ error: 'Failed to load mailboxes' });
        }
    });

    // PUT /admin/mailboxes/:userId — set this mailbox's quota (MB; -1 = site default, 0 = unlimited).
    route('put', '/admin/mailboxes/:userId', { auth: true, admin: true }, async (req, res) => {
        try {
            const q = await Admin.setQuotaOverride(req.params.userId, req.body && req.body.quotaMb);
            _usageCache.delete(parseInt(req.params.userId, 10) || 0);
            res.json({ success: true, quotaOverride: q });
        } catch (e) {
            res.status(400).json({ error: e.message || 'Failed to save the quota' });
        }
    });

    // Aliases / distribution lists: <name>@<mail domain> → local mailboxes and/or external addresses.
    route('get', '/admin/aliases', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json({ aliases: await Admin.listAliases(), mailDomain: await getMailDomain() });
        } catch (e) {
            res.status(500).json({ error: 'Failed to load aliases' });
        }
    });

    // An alias must not shadow a real mailbox: mail to that address would silently stop reaching it.
    const aliasClashesWithMailbox = async (localPart) => {
        const mailDomain = await getMailDomain();
        const addr = `${localPart}@${mailDomain}`;
        // NOT-A-DELIVERY-PATH: an admin-side uniqueness check for a new alias name; nothing is delivered.
        const u = await User.findByEmail(addr).catch(() => null);
        return !!mailboxAddressOf(u, mailDomain);
    };
    const saveAliasFrom = async (req, res, id) => {
        try {
            const lp = createAdminStore.normalizeLocalPart(req.body && req.body.localPart);
            if (lp && await aliasClashesWithMailbox(lp)) {
                return res.status(409).json({ error: 'That address already belongs to a mailbox.', code: 'mail_alias_is_mailbox' });
            }
            const row = await Admin.saveAlias(id, req.body || {});
            res.json({ success: true, alias: row });
        } catch (e) {
            const status = e.code === 'mail_alias_exists' ? 409 : 400;
            res.status(status).json({ error: e.message || 'Failed to save the alias', code: e.code });
        }
    };
    route('post', '/admin/aliases', { auth: true, admin: true }, async (req, res) => saveAliasFrom(req, res, 0));
    route('put', '/admin/aliases/:id', { auth: true, admin: true }, async (req, res) => saveAliasFrom(req, res, parseInt(req.params.id, 10) || 0));
    route('delete', '/admin/aliases/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await Admin.deleteAlias(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Failed to delete the alias' });
        }
    });

    // GET /admin/queue — every outbound message not yet delivered (scheduled, retrying, failed).
    route('get', '/admin/queue', { auth: true, admin: true }, async (req, res) => {
        try {
            const [items, waiting, rate] = await Promise.all([
                Admin.listQueue(200),
                Admin.countWaiting(),
                SendRate ? SendRate.status() : Promise.resolve({ perMinute: 0, sentThisMinute: 0, sentLastMinute: 0 }),
            ]);
            // At the configured rate, how long the waiting messages take to go out (null = no cap).
            const etaMinutes = rate.perMinute > 0 && waiting > 0 ? Math.ceil(waiting / rate.perMinute) : (waiting > 0 ? 0 : null);
            res.json({ items, pacing: { ...rate, waiting, etaMinutes } });
        } catch (e) {
            res.status(500).json({ error: 'Failed to load the queue' });
        }
    });

    // POST /admin/queue/:id/retry — deliver a failed/retrying message NOW (administrator override).
    route('post', '/admin/queue/:id/retry', { auth: true, admin: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Message not found' });
        // Administrators may act on any queued row — canAccessEmail is that role-based allowance.
        if (!canAccessEmail(email, req.user)) return res.status(403).json({ error: 'Forbidden' });
        const out = await retryFailedDelivery(email, `admin:${req.user.id}`, { force: true });
        res.status(out.status).json(out.body);
    });

    // DELETE /admin/queue/:id — stop a queued message: a scheduled/undo-window send goes back to its
    // owner's drafts; a retrying one is marked failed for good. Nothing is deleted.
    route('delete', '/admin/queue/:id', { auth: true, admin: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Message not found' });
        if (!canAccessEmail(email, req.user)) return res.status(403).json({ error: 'Forbidden' });
        try {
            if (!email.is_sent && !email.is_draft && email.scheduled_at) {
                await Email.cancelScheduled(email.id);
                return res.json({ success: true, action: 'drafted' });
            }
            if (email.delivery_status === 'retry') {
                await Admin.abandonRetry(email.id, `Cancelled by an administrator (${req.user.userLogin || req.user.id}). ${email.last_error || ''}`.trim());
                return res.json({ success: true, action: 'failed' });
            }
            res.status(409).json({ error: 'This message is not waiting in the queue.' });
        } catch (e) {
            res.status(500).json({ error: 'Failed to cancel the message' });
        }
    });

    // === SYSTEM SENT LOG (administrators only) ===================================================
    // The host enforces `admin: true`; the handlers check the role again, because these rows carry
    // message bodies (personal data) and a mis-declared route must not be what stands between them
    // and any logged-in account.
    const denyNotAdmin = (req, res) => {
        if (req.user && req.user.role === 'administrator') return false;
        res.status(403).json({ error: 'Forbidden', code: 'mail_admin_only' });
        return true;
    };

    // GET /admin/system-sent — one page of the log, headers only. ?q= (recipient / subject), status,
    // source, from, to (YYYY-MM-DD), page, perPage.
    route('get', '/admin/system-sent', { auth: true, admin: true }, async (req, res) => {
        if (denyNotAdmin(req, res)) return;
        try {
            const q = req.query || {};
            const [page, retentionDays] = await Promise.all([
                Admin.listSystemSent({ q: q.q, status: q.status, source: q.source, from: q.from, to: q.to, page: q.page, perPage: q.perPage }),
                systemSentRetentionDays(),
            ]);
            res.json({ ...page, retentionDays, retentionChoices: createAdminStore.SYSTEM_SENT_RETENTION_CHOICES });
        } catch (e) {
            res.status(500).json({ error: 'Failed to load the system Sent log' });
        }
    });

    // GET /admin/system-sent/:id — one message: headers, the HTML (sanitized here, again, whatever was
    // stored), the plain text, and its queue row when it is still waiting there.
    route('get', '/admin/system-sent/:id', { auth: true, admin: true }, async (req, res) => {
        if (denyNotAdmin(req, res)) return;
        try {
            const row = await Admin.getSystemSent(req.params.id);
            if (!row) return res.status(404).json({ error: 'Message not found' });
            let queue = null;
            if (Number(row.email_id) > 0) {
                const item = await Admin.getQueueItem(row.email_id);
                if (item && (item.delivery_status === 'retry' || item.delivery_status === 'failed')) {
                    queue = { id: item.id, status: item.delivery_status };
                }
            }
            const { body_html: html, body_text: text, ...headers } = row;
            res.json({
                ...headers,
                html: sanitizeEmailHtml(String(html || '')),
                text: String(text || ''),
                queue,
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to load the message' });
        }
    });

    // Register Admin Menu
    wordjs.adminMenu.add({
        href: '/admin/plugin/emails',
        label: 'Email Center',
        // Shown in the admin's language (sidebar); `label` stays for cores without per-language labels.
        labels: { en: 'Email Center', es: 'Centro de correo', pt: 'Central de e-mail' },
        icon: 'fa-envelope',
        order: 90,
        cap: 'access_admin_panel',
        // Only a user for whom an ADMINISTRATOR enabled a professional mailbox has an inbox here; core
        // hides this per-user webmail from every other non-administrator via the generic
        // requiresAccountCapability field, reading the same grant this plugin's route gate reads.
        requiresAccountCapability: MAILBOX_CAPABILITY
    });

    // Expose sendMail utility for other plugins (host installs a shim for wordjs.mail / global.wordjs_send_mail).
    // The host does not say WHICH caller handed a message over, so the system Sent log names it 'core'.
    // Answered within HANDOFF_ANSWER_MS: the core waits on this call (a test from Settings → Emails, a
    // plugin's wordjs.mail), and a host RPC that outlives its timeout kills this worker mid-delivery.
    // A delivery still running then is reported as accepted and finishes in the background.
    wordjs.provideMail(async (msg) => {
        const settled = await settleWithin(sendMail(fromSource(msg, 'core')), HANDOFF_ANSWER_MS, 'A site message');
        return settled.done ? settled.value : { success: true, pending: true, delivered: [], failed: [] };
    });

    // Register as a Notification Transport
    wordjs.notify.registerTransport('email', async (notification) => {
        let targetEmail = null;
        if (notification.user_id !== 0) {
            const user = await User.findById(notification.user_id);
            if (user) targetEmail = user.userEmail;
        }

        if (targetEmail) {
            try {
                // Within the host's RPC budget, like provideMail above.
                await settleWithin(sendMail(fromSource({
                    to: targetEmail,
                    subject: notification.title,
                    text: notification.message,
                    html: `<p>${notification.message}</p>`
                }, 'notifications')), HANDOFF_ANSWER_MS, 'A notification email');
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
