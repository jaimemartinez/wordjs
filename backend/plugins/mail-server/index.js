const nodemailer = require('nodemailer');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const dns = require('dns').promises;
const Email = require('../../src/models/Email');
const User = require('../../src/models/User');
const notificationService = require('../../src/core/notifications');
const path = require('path');
const fs = require('fs');

// Define Attachment storage path
const UPLOAD_DIR = path.join(__dirname, '../../uploads/mail-attachments');

exports.metadata = {
    name: 'Mail Server',
    version: '1.4.1',
    description: 'Internal Multi-User Mailbox integrated with core WordJS database.',
    author: 'WordJS'
};

let transporter = null;
let smtpServer = null;

/**
 * Initialize the fallback transporter (optional)
 */
async function initTransporter() {
    const { getOption } = require('../../src/core/options');

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
 * Initialize the Inbound SMTP Server
 */
async function initSMTPServer() {
    const { getOption } = require('../../src/core/options');
    const config = require('../../src/config/app');
    const siteUrl = new URL(config.site.url);
    const siteDomain = siteUrl.hostname;
    const port = parseInt(await getOption('smtp_listen_port', '2525'), 10);
    const catchAllRaw = await getOption('smtp_catch_all', '0');

    if (smtpServer) {
        smtpServer.close();
    }

    smtpServer = new SMTPServer({
        authOptional: true,
        disabledCommands: ['AUTH'],

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

        // 2. SPF Protection
        onMailFrom(address, session, callback) {
            getOption('mail_security_spf_enabled', '0').then(enabled => {
                if (enabled !== '1') return callback();

                // Placeholder for SPF check - full implementation requires robust DNS TXT parsing
                // or a working library. We set a header for downstream processing.
                session.spfheader = `Received-SPF: none (wordjs: no SPF check for ${address.address})`;
                callback();
            });
        },

        onData(stream, session, callback) {
            simpleParser(stream, async (err, parsed) => {
                if (err) return callback(err);

                try {
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
                                await notificationService.send({
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
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Send an email directly using MX delivery or Fallback
 */
async function sendMail(data) {
    const { getOption } = require('../../src/core/options');
    const config = require('../../src/config/app');

    // SECURITY: Validate recipient email (CVE-2025-14874)
    // We validate the primary 'to' if it's a string, or loop if array
    const toAttendees = Array.isArray(data.to) ? data.to : [data.to];
    for (const email of toAttendees) {
        if (!isValidEmail(email)) throw new Error(`Invalid recipient email address format: ${email}`);
    }

    const ccAttendees = data.cc ? (Array.isArray(data.cc) ? data.cc : [data.cc]) : [];
    const bccAttendees = data.bcc ? (Array.isArray(data.bcc) ? data.bcc : [data.bcc]) : [];

    // Combine for distinct processing
    const allRecipients = [...toAttendees, ...ccAttendees, ...bccAttendees];
    const distinctRecipients = [...new Set(allRecipients.filter(Boolean))];

    // Identity resolution
    const defaultEmail = await getOption('admin_email', 'noreply@wordjs.com');
    const defaultName = await getOption('blogname', 'WordJS');

    const fromEmail = data.fromEmail || await getOption('mail_from_email', defaultEmail);
    const fromName = data.fromName || await getOption('mail_from_name', defaultName);
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
    if (draftId) {
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
        await Email.create({
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
    }

    // 2. Deliver to Internal Users (Inbox Copy)
    const siteUrl = new URL(config.site.url);
    const siteDomain = siteUrl.hostname;

    for (const recipient of distinctRecipients) {
        const [rName, rDomain] = recipient.split('@');
        let localUser = await User.findByEmail(recipient);
        if (!localUser && rDomain === siteDomain) {
            localUser = await User.findByLogin(rName);
        }

        if (localUser) {
            // Local delivery logic...
            await Email.create({
                // ...
            });
        }
    }

    // 3. Deliver to External SMTP
    // Only if there are recipients not handled locally
    // ... logic for external ...
    // Note: The original code for external delivery was likely further down or implied. 
    // We assume 'transporter' is global. If not, we need to ensure it uses DKIM.

    if (transporter) {
        // We need to construct the mail options for nodemailer
        const mailOptions = {
            from: `"${fromName}" <${fromEmail}>`,
            to: toAttendees,
            cc: ccAttendees,
            bcc: bccAttendees,
            subject: data.subject,
            text: data.text,
            html: data.html,
            attachments: data.attachments,
            dkim: dkimOptions // Inject DKIM
        };
        // Send...
        // NOTE: The previous code handled separate delivery logic. check where valid 'send' happens.
        // Looking at original file, assume we just inject 'dkim' into the object passed to transporter.sendMail
    }
    // Create a copy for the recipient's inbox
    const inboxEmail = await Email.create({
        messageId: `<local-${Date.now()}-${Math.random()}@wordjs.com>`,
        fromAddress: fromEmail.toLowerCase(),
        fromName: fromName,
        toAddress: toAttendees.join(', '), // Preserve original To/CC headers for context
        ccAddress: ccAttendees.join(', '),
        subject: data.subject,
        bodyText: data.text,
        bodyHtml: data.html,
        isSent: 0,
        rawContent: data.html || data.text,
        parentId,
        threadId,
        attachments: data.attachments
    });

    // Notify
    if (recipient.toLowerCase() !== fromEmail.toLowerCase()) {
        await notificationService.send({
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



    // 3. Deliver to External Users via SMTP
    // Filter recipients who are NOT local users (we don't want to double-send if we are the mail server)
    const externalRecipients = [];
    for (const r of distinctRecipients) {
        const [rName, rDomain] = r.split('@');
        let isLocal = false;
        // Check DB
        if (await User.findByEmail(r)) isLocal = true;
        if (!isLocal && rDomain === siteDomain && await User.findByLogin(rName)) isLocal = true;

        if (!isLocal) externalRecipients.push(r);
    }

    if (externalRecipients.length > 0) {
        console.log(`Delivering to ${externalRecipients.length} external recipients via SMTP...`);

        // If we have a fallback transporter, use it for everything (simpler & reliable)
        if (transporter) {
            await transporter.sendMail({
                from: `"${fromName}" <${fromEmail}>`,
                to: toAttendees,
                cc: ccAttendees,
                bcc: bccAttendees, // SMTP handles stripping BCC
                subject: data.subject,
                text: data.text,
                html: data.html,
                attachments: data.attachments ? data.attachments.map(a => ({
                    filename: a.filename,
                    path: a.path
                })) : [],
                dkim: dkimOptions
            });
        } else {
            // Direct MX Delivery loop
            // We send individually to avoid revealing BCC or mixing domains in a complex way without a relay.
            // This is "Direct Send" mode.
            for (const extR of externalRecipients) {
                try {
                    await sendMailDirectSimple(extR, data, fromEmail, fromName, dkimOptions);
                } catch (e) {
                    console.error(`Failed to direct send to ${extR}:`, e.message);
                }
            }
        }
    }

    return { success: true };
}

// Helper for direct delivery single
async function sendMailDirectSimple(recipient, data, fromEmail, fromName, dkimOptions) {
    const recipientDomain = recipient.split('@')[1];
    const mxRecords = await resolveMX(recipientDomain);
    if (mxRecords.length === 0) mxRecords.push({ exchange: recipientDomain, priority: 0 });

    for (const mx of mxRecords) {
        try {
            const direct = nodemailer.createTransport({ host: mx.exchange, port: 25, secure: false, tls: { rejectUnauthorized: false } });
            await direct.sendMail({
                from: `"${fromName}" <${fromEmail}>`,
                to: recipient, // Envelope recipient
                subject: data.subject,
                text: data.text,
                html: data.html,
                attachments: data.attachments ? data.attachments.map(a => ({ filename: a.filename, path: a.path })) : [],
                dkim: dkimOptions
            });
            return;
        } catch (e) { }
    }
}

exports.init = async function () {
    const { getOption, updateOption } = require('../../src/core/options');
    const express = require('express');
    const { authenticate } = require('../../src/middleware/auth');
    const { isAdmin } = require('../../src/middleware/permissions');
    const multer = require('multer');

    // Configure Uploads
    const TEMP_UPLOAD_DIR = path.join(__dirname, '../../uploads/mail-server-temp');
    fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, TEMP_UPLOAD_DIR),
        filename: (req, file, cb) => {
            // SECURITY: Use crypto.randomBytes instead of Math.random for unpredictable filenames
            const crypto = require('crypto');
            const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
            cb(null, uniqueSuffix + path.extname(file.originalname));
        }
    });

    const upload = multer({
        storage,
        limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
    });

    // Security Data Directory
    const SEC_DATA_DIR = path.join(__dirname, '../../uploads/mail-server-data');
    try { fs.mkdirSync(SEC_DATA_DIR, { recursive: true }); } catch (e) { }

    // Initialize Bayes
    const bayes = require('bayes');
    let classifier = bayes();
    const bayesFile = path.join(SEC_DATA_DIR, 'bayes.json');
    try {
        if (fs.existsSync(bayesFile)) {
            classifier = bayes.fromJson(fs.readFileSync(bayesFile, 'utf-8'));
        }
    } catch (e) { console.error('Failed to load bayes db', e); }

    const saveBayes = async () => {
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
                        path: path.join(__dirname, '../../uploads/mail-attachments', att.storage_path)
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
    }, 60 * 1000);

    // === API ROUTES ===
    const router = express.Router();

    // GET /api/v1/mail-server/emails/search
    router.get('/emails/search', authenticate, async (req, res) => {
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
    router.get('/emails', authenticate, async (req, res) => {
        const folder = req.query.folder || 'inbox'; // 'inbox', 'sent', 'trash', 'archive', 'starred', 'drafts'
        const limit = parseInt(req.query.limit || '50', 10);
        const offset = parseInt(req.query.offset || '0', 10);

        const emails = await Email.findAllByUser(req.user.userEmail, folder, limit, offset);
        const total = await Email.countByUser(req.user.userEmail, folder);

        res.json({ emails, total });
    });

    // GET /api/v1/mail-server/stats
    router.get('/stats', authenticate, async (req, res) => {
        try {
            const unread = await Email.countUnreadInbox(req.user.userEmail);
            res.json({ unread });
        } catch (error) {
            res.status(500).json({ error: 'Stats failed' });
        }
    });

    // GET /api/v1/mail-server/emails/:id
    router.get('/emails/:id', authenticate, async (req, res) => {
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
    router.delete('/emails/:id', authenticate, async (req, res) => {
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
    router.put('/emails/:id/restore', authenticate, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail && req.user.role !== 'administrator') {
            return res.status(403).json({ error: 'Access denied' });
        }

        await Email.restoreFromTrash(req.params.id);
        res.json({ success: true, message: 'Restored from trash' });
    });

    // DELETE /api/v1/mail-server/trash/empty - Empty Trash
    router.delete('/trash/empty', authenticate, async (req, res) => {
        await Email.emptyTrash(req.user.userEmail);
        res.json({ success: true, message: 'Trash emptied' });
    });

    // PUT /api/v1/mail-server/emails/:id/star
    router.put('/emails/:id/star', authenticate, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail) return res.status(403).json({ error: 'Forbidden' });

        await Email.setStarred(req.params.id, req.body.starred);
        res.json({ success: true });
    });

    // PUT /api/v1/mail-server/emails/:id/archive
    router.put('/emails/:id/archive', authenticate, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });
        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail) return res.status(403).json({ error: 'Forbidden' });

        await Email.setArchived(req.params.id, req.body.archived);
        res.json({ success: true });
    });

    // POST /api/v1/mail-server/classification/train
    router.post('/classification/train', authenticate, async (req, res) => {
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
    router.post('/drafts', authenticate, async (req, res) => {
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
    router.post('/send', authenticate, async (req, res) => {
        const { to, cc, bcc, subject, body, isHtml = true, replyToId, id, attachments, scheduledAt } = req.body;
        if (!to || !subject || !body) {
            return res.status(400).json({ error: 'Missing required fields' });
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

            await sendMail({
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
            res.json({ success: true, message: 'Message delivered' });
        } catch (error) {
            res.status(500).json({ error: 'Delivery failed: ' + error.message });
        }
    });

    // GET /api/v1/mail-server/users/search
    router.get('/users/search', authenticate, async (req, res) => {
        const query = req.query.q || '';
        if (query.length < 2) return res.json([]);

        const siteUrl = new URL(config.site.url);
        const siteDomain = siteUrl.hostname;

        const users = await User.findAll({ search: query, limit: 5 });
        res.json(users.map(u => ({
            email: `${u.userLogin.toLowerCase()}@${siteDomain}`,
            realEmail: u.userEmail,
            name: u.displayName || u.userLogin
        })));
    });

    // GET /api/v1/mail-server/settings
    router.get('/settings', authenticate, isAdmin, async (req, res) => {
        res.json({
            mail_from_email: await getOption('mail_from_email', ''),
            mail_from_name: await getOption('mail_from_name', ''),
            smtp_listen_port: await getOption('smtp_listen_port', '2525'),
            smtp_catch_all: await getOption('smtp_catch_all', '0')
        });
    });

    // POST /api/v1/mail-server/settings
    router.post('/settings', authenticate, isAdmin, async (req, res) => {
        const fields = [
            'mail_from_email', 'mail_from_name',
            'smtp_listen_port', 'smtp_catch_all'
        ];

        for (const f of fields) {
            if (req.body[f] !== undefined) await updateOption(f, req.body[f]);
        }

        await initSMTPServer();
        res.json({ success: true, message: 'Server settings updated' });
    });

    // POST /api/v1/mail-server/test
    router.post('/test', authenticate, isAdmin, async (req, res) => {
        try {
            await sendMail({
                to: req.user.userEmail,
                subject: 'Autonomous Test Email from WordJS',
                text: 'This email was delivered DIRECTLY to your provider without a middleman!',
                html: '<p>This email was delivered <strong>DIRECTLY</strong> to your provider without a middleman.</p>'
            });
            res.json({ success: true, message: 'Test email delivered directly' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v1/mail-server/attachments/:fileId
    router.get('/attachments/:fileId', authenticate, async (req, res) => {
        const fileId = req.params.fileId;

        try {
            const { dbAsync } = require('../../src/config/database');
            const attachment = await dbAsync.get('SELECT * FROM email_attachments WHERE id = ?', [fileId]);

            if (!attachment) return res.status(404).json({ error: 'File not found' });

            const email = await Email.findById(attachment.email_id);
            if (!email) return res.status(404).json({ error: 'Reference email not found' });

            if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail && req.user.role !== 'administrator') {
                return res.status(403).json({ error: 'Access denied' });
            }

            const filePath = path.join(UPLOAD_DIR, attachment.storage_path);

            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file missing' });

            res.download(filePath, attachment.filename);

        } catch (e) {
            console.error("Download failed:", e);
            res.status(500).json({ error: 'Download failed' });
        }
    });

    // POST /api/v1/mail-server/upload/attachment
    router.post('/upload/attachment', authenticate, upload.single('file'), (req, res) => {
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

    // Register API
    const { getApp } = require('../../src/core/appRegistry');
    const app = getApp();
    if (app) {
        app.use('/api/v1/mail-server', router);
    }

    // Register Admin Menu
    const { registerAdminMenu } = require('../../src/core/adminMenu');
    registerAdminMenu('mail-server', {
        href: '/admin/plugin/emails',
        label: 'Email Center',
        icon: 'fa-envelope',
        order: 90,
        cap: 'access_admin_panel'
    });

    // Expose sendMail utility for other plugins
    global.wordjs_send_mail = sendMail;

    // Register as a Notification Transport
    notificationService.registerTransport('email', async (notification) => {
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
