/**
 * WordJS - Mail Server plugin (ISOLATED, operator-trusted).
 *
 * Runs in a worker via the capability bridge. ALL behavior is preserved (SMTP server, MX delivery,
 * DKIM, SPF, spam filter, retry queue, scheduled send, attachments) — only the core-access layer was
 * swapped to `wordjs`:
 *   - core models/Email          -> ./lib/email-store(wordjs.db)
 *   - core models/User           -> raw SQL on the `users` table via wordjs.db
 *   - core options get/update    -> wordjs.options.get/set
 *   - core config/app.site.url   -> stored option 'siteurl' (read via wordjs.options)
 *   - express router             -> wordjs.http.route(..., { absolute:true })
 *   - notificationService        -> wordjs.notify / wordjs.notify.registerTransport
 *   - registerAdminMenu          -> wordjs.adminMenu.add
 *   - global.wordjs_send_mail    -> wordjs.provideMail(sendMail)
 *
 * node builtins (net/dns/tls/crypto/os/path) and npm deps (nodemailer/smtp-server/mailparser/
 * spf-validator/dnsbl/bayes) are required normally — they are NOT blocked inside the worker.
 */
const nodemailer = require('nodemailer');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const dns = require('dns').promises;
const net = require('net');
const SPFValidator = require('spf-validator');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Define Attachment storage path (backend/uploads/mail-attachments)
const UPLOAD_DIR = path.join(__dirname, '../../uploads/mail-attachments');

exports.metadata = {
    name: 'Mail Server',
    version: '1.4.1',
    description: 'Internal Multi-User Mailbox integrated with core WordJS database.',
    author: 'WordJS'
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

// === User lookups via raw SQL on the `users` table (replaces core models/User) ===
// Normalize raw rows so the rest of the code can keep using .userEmail / .username / .displayName.
function mapUser(row) {
    if (!row) return null;
    return {
        id: row.id,
        userLogin: row.user_login,
        username: row.user_login,
        userEmail: row.user_email,
        displayName: row.display_name,
        role: row.role
    };
}

const User = {
    async findByEmail(email) {
        const row = await wordjs.db.get('SELECT * FROM users WHERE LOWER(user_email) = LOWER(?)', [email]);
        return mapUser(row);
    },
    async findByLogin(login) {
        const row = await wordjs.db.get('SELECT * FROM users WHERE user_login = ?', [login]);
        return mapUser(row);
    },
    async findById(id) {
        const row = await wordjs.db.get('SELECT * FROM users WHERE id = ?', [id]);
        return mapUser(row);
    },
    async findAll({ search, limit } = {}) {
        const term = `%${search || ''}%`;
        const lim = limit || 50;
        const rows = await wordjs.db.all(
            'SELECT * FROM users WHERE (user_login LIKE ? OR display_name LIKE ? OR user_email LIKE ?) LIMIT ?',
            [term, term, term, lim]
        );
        return (rows || []).map(mapUser);
    }
};

// Resolve the site URL from options (replaces core config/app.site.url).
async function getSiteUrl() {
    return await getOption('siteurl', await getOption('home', 'http://localhost'));
}
async function getSiteDomain() {
    try { return new URL(await getSiteUrl()).hostname; } catch (e) { return 'localhost'; }
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

    transporter = nodemailer.createTransport({
        host,
        port,
        secure,
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
 * Initialize the Inbound SMTP Server
 */
async function initSMTPServer() {
    const siteDomain = await getSiteDomain();
    const port = parseInt(await getOption('smtp_listen_port', '2525'), 10);
    const catchAllRaw = await getOption('smtp_catch_all', '0');

    if (smtpServer) {
        smtpServer.close();
    }

    smtpServer = new SMTPServer({
        authOptional: true,
        disabledCommands: ['AUTH'],

        // DoS containment for the unauthenticated inbound MTA: cap per-message size and concurrent
        // connections so a flood of huge/many messages can't exhaust worker memory or tmp disk.
        size: 25 * 1024 * 1024, // 25 MB hard cap per message
        maxClients: 50,
        socketTimeout: 60 * 1000, // drop idle/slow-loris connections after 60s

        // 1. DNSBL Protection (Connection Level)
        onConnect(session, callback) {
            if (session.remoteAddress === '127.0.0.1' || session.remoteAddress === '::1') return callback();

            getOption('mail_security_dnsbl_enabled', '0').then(enabled => {
                if (enabled !== '1') return callback();

                const dnsbl = require('dnsbl');
                dnsbl.lookup(session.remoteAddress, 'zen.spamhaus.org').then(listed => {
                    if (listed) {
                        console.warn(`[Security] IP ${session.remoteAddress} blocked by DNSBL`);
                        return callback(new Error('Connection rejected by DNSBL'));
                    }
                    callback();
                }).catch(() => callback()); // Fail open on error
            });
        },

        // 2. SPF Protection — real check against the connecting IP and MAIL FROM domain.
        onMailFrom(address, session, callback) {
            getOption('mail_security_spf_enabled', '0').then(async (enabled) => {
                if (enabled !== '1') return callback();

                const ip = session.remoteAddress;
                const mailFrom = (address && address.address) || '';
                const domain = mailFrom.split('@')[1] || '';

                // Fail OPEN on any problem: no domain, validator error, or DNS timeout → tag 'none', accept.
                let result = 'none';
                try {
                    if (domain) result = await evaluateSPF(domain, ip);
                } catch (e) {
                    console.warn(`[Security][SPF] evaluation error for ${domain} (${ip}): ${e.message} — failing open`);
                    result = 'none';
                }

                // Set the Received-SPF header for downstream storage (RFC 7208 §9.1 shape).
                session.spfheader = `Received-SPF: ${result} (wordjs: ${domain || 'unknown'} via ${ip})`;
                session.spfResult = result;

                // Optionally reject hard failures, but only if explicitly enabled (default: just tag).
                if (result === 'fail') {
                    const rejectRaw = await getOption('mail_security_spf_reject', '0');
                    if (rejectRaw === '1') {
                        console.warn(`[Security][SPF] Rejecting ${mailFrom} from ${ip} (hard SPF fail)`);
                        return callback(new Error('550 SPF check failed: sending IP not authorized for ' + domain));
                    }
                    console.warn(`[Security][SPF] SPF fail for ${mailFrom} from ${ip} — tagged only (reject disabled)`);
                }
                callback();
            }).catch(() => callback()); // Fail open if the option lookup itself throws.
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
                    const toAddresses = Array.isArray(parsed.to.value) ? parsed.to.value : [parsed.to.value];
                    for (const addr of toAddresses) {
                        const [recName, recDomain] = addr.address.split('@');

                        let user = await User.findByEmail(addr.address);
                        if (!user && recDomain === siteDomain) {
                            user = await User.findByLogin(recName);
                        }

                        if (user || catchAllRaw === '1') {
                            await Email.create({
                                messageId: parsed.messageId,
                                fromAddress: parsed.from.value[0].address,
                                fromName: parsed.from.value[0].name,
                                toAddress: user ? user.userEmail : addr.address,
                                subject: (isSpam ? '[SPAM] ' : '') + parsed.subject,
                                bodyText: parsed.text,
                                bodyHtml: parsed.html,
                                rawContent: parsed.textAsHtml || parsed.text,
                                attachments: parsed.attachments,
                                isTrash: isSpam ? 1 : 0 // Auto-trash spam
                            });

                            // Auto-learn (Naive logic: if we accepted it and user didn't mark it, it's ham.
                            // But here we just classify. Learning should happen on user action.)

                            if (user) {
                                await wordjs.notify({
                                    user_id: user.id,
                                    type: isSpam ? 'alert' : 'email',
                                    title: isSpam ? 'Spam Detected' : 'New Inbound Email',
                                    message: `From ${parsed.from.text}: "${parsed.subject}"`,
                                    action_url: `/admin/plugin/emails`,
                                    transports: ['db', 'sse']
                                });
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

    smtpServer.listen(port, () => {
        console.log(`   ✓ Inbound SMTP Server listening on port ${port} (Domain: ${siteDomain})`);
    });

    smtpServer.on('error', err => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`   ⚠️  Inbound SMTP Server could not start: Port ${port} is busy.`);
        } else {
            console.error('   ✗ Inbound SMTP Server error:', err.message);
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
    // Block multiple @ symbols (CVE-2025-13033 prevention)
    if ((email.match(/@/g) || []).length !== 1) return false;
    // Block quoted local parts with @ (CVE-2025-13033)
    if (email.includes('"') && email.includes('@')) {
        const localPart = email.split('@')[0];
        if (localPart.includes('@')) return false;
    }
    // Standard RFC 5322 simplified validation
    // Allow "localhost" for internal mail
    const emailRegex = /^[^\s@]+@([^\s@]+\.[^\s@]+|localhost)$/;
    return emailRegex.test(email);
}

/**
 * Send an email directly using MX delivery or Fallback
 */
async function sendMail(data) {
    console.log(`[MailServer] sendMail called. Subject: "${data.subject}"`);

    // SECURITY: Validate recipient email (CVE-2025-14874)
    // We validate the primary 'to' if it's a string, or loop if array
    const toAttendees = Array.isArray(data.to) ? data.to : [data.to];
    for (const email of toAttendees) {
        if (!isValidEmail(email)) throw new Error(`Invalid recipient email address format: ${email}`);
    }

    // SECURITY (H7): strip CR/LF from header-bound fields to prevent email-header injection. A newline
    // in subject/fromName could smuggle extra headers (e.g. Bcc:) into the outbound message. Recipients
    // are validated above; this defends the remaining user-controlled header fields at the source.
    const stripCRLF = (v) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim() : v);
    if (data.subject !== undefined) data.subject = stripCRLF(data.subject);
    if (data.fromName !== undefined) data.fromName = stripCRLF(data.fromName);

    const ccAttendees = data.cc ? (Array.isArray(data.cc) ? data.cc : [data.cc]) : [];
    const bccAttendees = data.bcc ? (Array.isArray(data.bcc) ? data.bcc : [data.bcc]) : [];

    // Combine for distinct processing
    const allRecipients = [...toAttendees, ...ccAttendees, ...bccAttendees];
    const distinctRecipients = [...new Set(allRecipients.filter(Boolean))];

    console.log(`[MailServer] Total unique recipients: ${distinctRecipients.length}`);

    // Identity resolution
    const defaultEmail = await getOption('admin_email', 'noreply@wordjs.com');
    const defaultName = await getOption('blogname', 'WordJS');

    const fromEmail = data.fromEmail || await getOption('mail_from_email', defaultEmail);
    // stripCRLF the final fromName too (covers the admin-configured mail_from_name fallback).
    const fromName = stripCRLF(data.fromName || await getOption('mail_from_name', defaultName));
    const parentId = data.parentId || 0;
    const threadId = data.threadId || 0;
    const draftId = data.draftId || 0;

    // DKIM Config
    const dkimKey = await getOption('mail_security_dkim_private_key', '');
    const dkimDomain = await getOption('mail_security_dkim_domain', '');
    const dkimSelector = await getOption('mail_security_dkim_selector', 'default');

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
                messageId: `<sent-${Date.now()}@wordjs.com>`,
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
                attachments: data.attachments
            });
            sentRecordId = sentRec ? sentRec.id : 0;
        }
    } catch (e) {
        console.error('[MailServer] Failed to save/update SENT record:', e);
        throw e; // If we can't save the sent record, we probably shouldn't send? Or warn?
    }

    // 2. Deliver to Internal Users (Inbox Copy)
    const siteDomain = await getSiteDomain();

    console.log(`[MailServer] Processing internal delivery for domain: ${siteDomain}`);

    // Track which recipients are local so we filter them out of SMTP
    const localRecipients = new Set();

    // On a retry pass the local inbox copies were already delivered on the first attempt;
    // the recipients we were handed are the still-failed EXTERNAL ones. Skip local delivery.
    for (const recipient of (isRetry ? [] : distinctRecipients)) {
        try {
            console.log(`[MailServer] Checking recipient: ${recipient}`);
            const [rName, rDomain] = recipient.split('@');
            let localUser = await User.findByEmail(recipient);

            if (!localUser && rDomain === siteDomain) {
                console.log(`[MailServer] Searching by login for ${rName}...`);
                localUser = await User.findByLogin(rName);
            }

            if (localUser) {
                console.log(`[MailServer] Local user found: ${localUser.id} (${localUser.username})`);

                // Check if user_id is valid
                if (!localUser.id) {
                    console.error(`[MailServer] ❌ Critical: Local user found but has no ID!`, localUser);
                    continue;
                }

                localRecipients.add(recipient);

                // Local delivery: Create a copy in the recipient's inbox
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
                    user_id: localUser.id,
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
        const mailObj = { fromEmail, fromName, subject: data.subject, text: data.text, html: data.html, attachments };

        if (transporter) {
            // Relay/smarthost path (used only if a relay is configured).
            console.log(`[MailServer] Delivering ${externalRecipients.length} recipient(s) via configured relay...`);
            for (const extR of externalRecipients) {
                try {
                    const info = await transporter.sendMail({
                        envelope: { from: fromEmail, to: extR },
                        from: `"${fromName}" <${fromEmail}>`, to: extR,
                        subject: data.subject, text: data.text, html: data.html, attachments, dkim: dkimOptions
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
    return {
        dkim: {
            host: `${selector}._domainkey.${domain}`,
            type: 'TXT',
            value: `v=DKIM1; k=rsa; p=${pubDer}`
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
    const mxRecords = await resolveMX(domain);
    if (mxRecords.length === 0) mxRecords.push({ exchange: domain, priority: 0 });

    let lastErr = null;
    let permanent = false;
    for (const mx of mxRecords) {
        const transport = nodemailer.createTransport({
            host: mx.exchange,
            port: 25,
            secure: false,
            name: heloName,               // EHLO/HELO hostname (must match rDNS)
            connectionTimeout: 20000,
            greetingTimeout: 15000,
            socketTimeout: 30000,
            tls: { rejectUnauthorized: false } // remote MX certs vary; STARTTLS still used when offered
        });
        try {
            const info = await transport.sendMail({
                // Envelope (MAIL FROM / RCPT TO) drives SPF alignment & bounces; keep it our domain.
                envelope: { from: mail.fromEmail, to: recipient },
                from: `"${mail.fromName}" <${mail.fromEmail}>`,
                to: recipient,
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
                attachments: mail.attachments,
                dkim: dkimOptions
            });
            return { ok: true, mx: mx.exchange, response: info.response };
        } catch (e) {
            lastErr = e;
            const code = e.responseCode || 0;
            permanent = code >= 500 && code < 600;
            if (permanent) break; // a hard 5xx reject won't differ on another MX
        } finally {
            try { transport.close(); } catch (e2) { /* ignore */ }
        }
    }
    const err = new Error(`Direct delivery to ${recipient} failed: ${lastErr ? lastErr.message : 'no MX reachable'}`);
    err.permanent = permanent;
    throw err;
}

exports.init = async function (bridge) {
    wordjs = bridge;
    getOption = (key, def) => wordjs.options.get(key, def);
    updateOption = (key, value) => wordjs.options.set(key, value);
    Email = require('./lib/email-store')(wordjs.db);

    // Security Data Directory (confined fs writes within uploads dir are allowed)
    const SEC_DATA_DIR = path.join(__dirname, '../../uploads/mail-server-data');
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

    // Initialize
    await Email.initSchema();
    await initTransporter();
    await initSMTPServer();

    // === BACKGROUND TASKS ===
    // Process Scheduled Emails every minute
    setInterval(async () => {
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
                        to: email.to_address,
                        cc: email.cc_address,
                        bcc: email.bcc_address,
                        subject: email.subject,
                        text: email.body_text,
                        html: email.body_html,
                        fromEmail: email.from_address,
                        fromName: email.from_name,
                        parentId: email.parent_id,
                        threadId: email.thread_id,
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
    }, 60 * 1000);

    // === API ROUTES (host keeps the original /api/v1/mail-server/* paths via opts.absolute) ===
    const ROUTE_BASE = '/api/v1/mail-server';
    const route = (method, sub, opts, handler) => {
        if (typeof opts === 'function') { handler = opts; opts = {}; }
        wordjs.http.route(method, ROUTE_BASE + sub, Object.assign({ absolute: true }, opts), handler);
    };

    // GET /api/v1/mail-server/emails/search
    route('get', '/emails/search', { auth: true }, async (req, res) => {
        const query = req.query.q || '';
        if (query.length < 2) return res.json({ emails: [] });

        try {
            const emails = await Email.searchByUser(req.user.userEmail, query);
            res.json({ emails });
        } catch (error) {
            console.error("Search error:", error);
            res.status(500).json({ error: "Search failed" });
        }
    });

    // GET /api/v1/mail-server/emails
    route('get', '/emails', { auth: true }, async (req, res) => {
        const folder = req.query.folder || 'inbox'; // 'inbox', 'sent', 'trash', 'archive', 'starred', 'drafts'
        const limit = parseInt(req.query.limit || '50', 10);
        const offset = parseInt(req.query.offset || '0', 10);

        const emails = await Email.findAllByUser(req.user.userEmail, folder, limit, offset);
        const total = await Email.countByUser(req.user.userEmail, folder);

        res.json({ emails, total });
    });

    // GET /api/v1/mail-server/stats
    route('get', '/stats', { auth: true }, async (req, res) => {
        try {
            const unread = await Email.countUnreadInbox(req.user.userEmail);
            res.json({ unread });
        } catch (error) {
            res.status(500).json({ error: 'Stats failed' });
        }
    });

    // GET /api/v1/mail-server/emails/:id
    route('get', '/emails/:id', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        // Security: Must be either the recipient or the sender
        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail && req.user.role !== 'administrator') {
            return res.status(403).json({ error: 'Access denied to this message' });
        }

        await Email.markAsRead(req.params.id);

        const threadIdToSearch = email.thread_id || email.id;
        const thread = await Email.findByThreadId(threadIdToSearch, req.user.userEmail);

        if (thread && thread.length > 1) {
            return res.json({ ...email, thread });
        }

        const attachments = await Email.getAttachments(email.id);
        res.json({ ...email, attachments });
    });

    // DELETE /api/v1/mail-server/emails/:id - Move to Trash (Soft Delete)
    route('delete', '/emails/:id', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail && req.user.role !== 'administrator') {
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

    // PUT /api/v1/mail-server/emails/:id/restore - Restore from Trash
    route('put', '/emails/:id/restore', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail && req.user.role !== 'administrator') {
            return res.status(403).json({ error: 'Access denied' });
        }

        await Email.restoreFromTrash(req.params.id);
        res.json({ success: true, message: 'Restored from trash' });
    });

    // DELETE /api/v1/mail-server/trash/empty - Empty Trash
    route('delete', '/trash/empty', { auth: true }, async (req, res) => {
        await Email.emptyTrash(req.user.userEmail);
        res.json({ success: true, message: 'Trash emptied' });
    });

    // PUT /api/v1/mail-server/emails/:id/star
    route('put', '/emails/:id/star', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail) return res.status(403).json({ error: 'Forbidden' });

        await Email.setStarred(req.params.id, req.body.starred);
        res.json({ success: true });
    });

    // PUT /api/v1/mail-server/emails/:id/archive
    route('put', '/emails/:id/archive', { auth: true }, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail) return res.status(403).json({ error: 'Forbidden' });

        await Email.setArchived(req.params.id, req.body.archived);
        res.json({ success: true });
    });

    // POST /api/v1/mail-server/classification/train
    route('post', '/classification/train', { auth: true }, async (req, res) => {
        try {
            const { id, category } = req.body; // category: 'spam' or 'ham'
            if (!['spam', 'ham'].includes(category)) return res.status(400).json({ error: 'Invalid category' });

            const email = await Email.findById(id);
            if (!email) return res.status(404).json({ error: 'Email not found' });

            // Learn
            const text = (email.subject || '') + ' ' + (email.body_text || '');
            await classifier.learn(text, category);
            await saveBayes();

            // Auto-move
            if (category === 'spam') {
                await Email.update(id, { isTrash: 1 });
            } else if (category === 'ham' && email.isTrash) {
                await Email.update(id, { isTrash: 0 });
            }

            res.json({ success: true, message: `Learned as ${category}` });
        } catch (error) {
            console.error('Training failed:', error);
            res.status(500).json({ error: 'Training failed' });
        }
    });

    // POST /api/v1/mail-server/drafts
    route('post', '/drafts', { auth: true }, async (req, res) => {
        const { id, to, cc, bcc, subject, body, isHtml = true, replyToId, attachments } = req.body;

        try {
            const data = {
                fromAddress: req.user.userEmail,
                fromName: req.user.displayName || req.user.userLogin,
                toAddress: Array.isArray(to) ? to.join(',') : (to || ''),
                ccAddress: Array.isArray(cc) ? cc.join(',') : (cc || ''),
                bccAddress: Array.isArray(bcc) ? bcc.join(',') : (bcc || ''),
                subject: subject || '',
                bodyText: isHtml ? body.replace(/<[^>]*>/g, '') : body,
                bodyHtml: isHtml ? body : null,
                rawContent: body || '',
                isDraft: 1,
                isSent: 0,
                parentId: 0,
                threadId: 0,
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

    // POST /api/v1/mail-server/send
    route('post', '/send', { auth: true }, async (req, res) => {
        const { to, cc, bcc, subject, body, isHtml = true, replyToId, id, attachments, scheduledAt } = req.body;
        if (!to || !subject || !body) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // SECURITY (H8): cap recipients per message and enforce a per-user outbound rate limit.
        const recipientCount = [].concat(to || [], cc || [], bcc || []).filter(Boolean).length;
        if (recipientCount > MAX_RECIPIENTS_PER_MESSAGE) {
            return res.status(400).json({ error: `Too many recipients (max ${MAX_RECIPIENTS_PER_MESSAGE} per message).` });
        }
        if (!outboundRateLimitOk(req.user.id, recipientCount)) {
            return res.status(429).json({ error: 'Outbound mail rate limit exceeded. Please try again later.' });
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
            // Check for Scheduled Send
            if (scheduledAt) {
                const data = {
                    fromAddress: req.user.userEmail,
                    fromName: req.user.displayName || req.user.userLogin,
                    toAddress: Array.isArray(to) ? to.join(',') : (to || ''),
                    ccAddress: Array.isArray(cc) ? cc.join(',') : (cc || ''),
                    bccAddress: Array.isArray(bcc) ? bcc.join(',') : (bcc || ''),
                    subject: subject || '',
                    bodyText: isHtml ? body.replace(/<[^>]*>/g, '') : body,
                    bodyHtml: isHtml ? body : null,
                    rawContent: body || '',
                    isDraft: 0,
                    isSent: 0, // Not sent yet
                    parentId,
                    threadId,
                    attachments: attachments || [],
                    scheduledAt: new Date(scheduledAt).toISOString()
                };

                // Create or Update (if it was a draft)
                let email;
                if (id) {
                    await Email.update(id, data);
                    email = { id };
                } else {
                    email = await Email.create(data);
                }

                return res.json({ success: true, message: 'Message scheduled', id: email.id });
            }

            const result = await sendMail({
                to, // Now supports array
                cc,
                bcc,
                subject,
                text: isHtml ? body.replace(/<[^>]*>/g, '') : body,
                html: isHtml ? body : null,
                fromEmail: req.user.userEmail,
                fromName: req.user.displayName || req.user.userLogin,
                parentId,
                threadId,
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

    // GET /api/v1/mail-server/users/search
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

    // GET /api/v1/mail-server/settings
    route('get', '/settings', { auth: true, admin: true }, async (req, res) => {
        res.json({
            mail_from_email: await getOption('mail_from_email', ''),
            mail_from_name: await getOption('mail_from_name', ''),
            smtp_listen_port: await getOption('smtp_listen_port', '2525'),
            smtp_catch_all: await getOption('smtp_catch_all', '0'),
            mail_helo_host: await getOption('mail_helo_host', ''),
            mail_security_dkim_domain: await getOption('mail_security_dkim_domain', ''),
            mail_security_dkim_selector: await getOption('mail_security_dkim_selector', 'default'),
            mail_security_dkim_enabled: (await getOption('mail_security_dkim_private_key', '')) ? '1' : '0',
            mail_security_dnsbl_enabled: await getOption('mail_security_dnsbl_enabled', '0'),
            mail_security_spf_enabled: await getOption('mail_security_spf_enabled', '0'),
            mail_security_spf_reject: await getOption('mail_security_spf_reject', '0')
            // NOTE: the DKIM private key is never returned (secret).
        });
    });

    // POST /api/v1/mail-server/settings
    route('post', '/settings', { auth: true, admin: true }, async (req, res) => {
        const fields = [
            'mail_from_email', 'mail_from_name',
            'smtp_listen_port', 'smtp_catch_all',
            'mail_helo_host',
            'mail_security_dkim_domain', 'mail_security_dkim_selector',
            'mail_security_dnsbl_enabled', 'mail_security_spf_enabled', 'mail_security_spf_reject'
        ];

        for (const f of fields) {
            if (req.body[f] !== undefined) await updateOption(f, req.body[f]);
        }

        await initSMTPServer();
        res.json({ success: true, message: 'Server settings updated' });
    });

    // POST /api/v1/mail-server/test  — send a real test message (pass {to} to test EXTERNAL delivery)
    route('post', '/test', { auth: true, admin: true }, async (req, res) => {
        try {
            const to = (req.body && req.body.to) || req.user.userEmail;
            const result = await sendMail({
                to,
                subject: 'WordJS Mail Server — delivery test',
                text: 'If you received this, direct MX delivery is working.',
                html: '<p>If you received this, <strong>direct MX delivery</strong> is working.</p>'
            });
            // Report exactly what happened so the admin can diagnose (MX hit, SMTP response, or error).
            res.status(result.success ? 200 : 207).json({
                success: result.success,
                to,
                delivered: result.delivered,
                failed: result.failed,
                message: result.success
                    ? 'Test message accepted by the recipient mail server'
                    : 'Delivery failed — check rDNS/SPF/DKIM/DMARC and that outbound port 25 is open'
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v1/mail-server/security/dns-records — records to publish for deliverability
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

    // POST /api/v1/mail-server/security/dkim/generate — create a DKIM keypair + return DNS records
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

    // GET /api/v1/mail-server/attachments/:fileId
    route('get', '/attachments/:fileId', { auth: true }, async (req, res) => {
        const fileId = req.params.fileId;

        try {
            const attachment = await wordjs.db.get('SELECT * FROM email_attachments WHERE id = ?', [fileId]);

            if (!attachment) return res.status(404).json({ error: 'File not found' });

            const email = await Email.findById(attachment.email_id);
            if (!email) return res.status(404).json({ error: 'Reference email not found' });

            if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail && req.user.role !== 'administrator') {
                return res.status(403).json({ error: 'Access denied' });
            }

            const filePath = path.join(UPLOAD_DIR, attachment.storage_path);

            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file missing' });

            // Stream the file back through the bridge response (res.download is not available in the
            // isolate's mock res; send the buffer with a download disposition header instead).
            const buf = fs.readFileSync(filePath);
            res.set({
                'Content-Type': attachment.content_type || 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${attachment.filename}"`
            }).send(buf);

        } catch (e) {
            console.error("Download failed:", e);
            res.status(500).json({ error: 'Download failed' });
        }
    });

    // POST /api/v1/mail-server/upload/attachment
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

    // Register Admin Menu
    wordjs.adminMenu.add({
        href: '/admin/plugin/emails',
        label: 'Email Center',
        icon: 'fa-envelope',
        order: 90,
        cap: 'access_admin_panel'
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
    console.log('Mail Server plugin deactivated');
};
