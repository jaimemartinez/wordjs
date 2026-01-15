const nodemailer = require('nodemailer');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const dns = require('dns').promises;
const Email = require('../../src/models/Email');
const User = require('../../src/models/User');
const notificationService = require('../../src/core/notifications');

exports.metadata = {
    name: 'Mail Server',
    version: '1.4.0',
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
        onData(stream, session, callback) {
            simpleParser(stream, async (err, parsed) => {
                if (err) return callback(err);

                try {
                    const toAddresses = Array.isArray(parsed.to.value) ? parsed.to.value : [parsed.to.value];

                    for (const addr of toAddresses) {
                        const [recName, recDomain] = addr.address.split('@');

                        console.log(`📩 Incoming mail for ${addr.address}. Local user check...`);
                        let user = await User.findByEmail(addr.address);
                        if (!user && recDomain === siteDomain) {
                            user = await User.findByLogin(recName);
                        }

                        if (user) {
                            console.log(`   ✅ Local user found: ${user.userLogin} (ID: ${user.id})`);
                        } else {
                            console.log(`   ❌ No local user for ${addr.address}`);
                        }

                        if (user || catchAllRaw === '1') {
                            await Email.create({
                                messageId: parsed.messageId,
                                fromAddress: parsed.from.value[0].address,
                                fromName: parsed.from.value[0].name,
                                toAddress: user ? user.userEmail : addr.address, // Route to user's real email box
                                subject: parsed.subject,
                                bodyText: parsed.text,
                                bodyHtml: parsed.html,
                                rawContent: parsed.textAsHtml || parsed.text
                            });

                            // Real-time notification for the user
                            if (user) {
                                console.log(`   🔔 Sending real-time notification to user ${user.id}`);
                                await notificationService.send({
                                    user_id: user.id,
                                    type: 'email',
                                    title: 'New Inbound Email',
                                    message: `You have a new message from ${parsed.from.text}: "${parsed.subject}"`,
                                    icon: 'fa-envelope',
                                    color: 'blue',
                                    action_url: `/admin/plugin/emails`,
                                    transports: ['db', 'sse'] // Don't send an email about a new inbound email
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
        },
        disabledCommands: ['AUTH']
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
 * Send an email directly using MX delivery
 */
async function sendMail(data) {
    const { getOption } = require('../../src/core/options');
    const config = require('../../src/config/app');

    // Identity resolution: Use provided identity OR site defaults
    const defaultEmail = await getOption('admin_email', 'noreply@wordjs.com');
    const defaultName = await getOption('blogname', 'WordJS');

    const fromEmail = data.fromEmail || await getOption('mail_from_email', defaultEmail);
    const fromName = data.fromName || await getOption('mail_from_name', defaultName);
    const parentId = data.parentId || 0;
    const threadId = data.threadId || 0;

    const [recipientName, recipientDomain] = data.to.split('@');
    if (!recipientDomain) throw new Error('Invalid recipient email address');

    // Get current site domain for internal routing
    const siteUrl = new URL(config.site.url);
    const siteDomain = siteUrl.hostname;

    // 0. Internal Delivery Check
    // We check both: registered email AND user_login@siteDomain
    let localUser = await User.findByEmail(data.to);

    // If not found by email, try finding by username if it's our domain
    if (!localUser && recipientDomain === siteDomain) {
        localUser = await User.findByLogin(recipientName);
    }

    if (localUser) {
        console.log(`Internal delivery detected: delivering to local user ${localUser.userEmail} (target: ${data.to})`);

        // Use the user's primary registered email for database storage consistency
        const targetEmail = localUser.userEmail;

        await Email.create({
            messageId: `<local-${Date.now()}@wordjs.com>`,
            fromAddress: fromEmail,
            fromName: fromName,
            toAddress: targetEmail,
            subject: data.subject,
            bodyText: data.text,
            bodyHtml: data.html,
            isSent: 0,
            rawContent: data.html || data.text,
            parentId,
            threadId
        });

        // Also store a copy in the sender's sent folder (if sender has an email)
        await Email.create({
            messageId: `<sent-${Date.now()}@wordjs.com>`,
            fromAddress: fromEmail,
            fromName: fromName,
            toAddress: targetEmail,
            subject: data.subject,
            bodyText: data.text,
            bodyHtml: data.html,
            isSent: 1,
            rawContent: data.html || data.text,
            parentId,
            threadId
        });

        // Real-time notification for the local recipient
        await notificationService.send({
            user_id: localUser.id,
            type: 'email',
            title: 'New Internal Email',
            message: `You have a new message from ${fromName}: "${data.subject}"`,
            icon: 'fa-envelope',
            color: 'indigo',
            action_url: `/admin/plugin/emails`,
            transports: ['db', 'sse'] // Don't send an email about a new internal email
        });

        return { success: true, internal: true };
    }

    console.log(`Attempting direct delivery to ${data.to}...`);

    // 1. Resolve MX records
    const mxRecords = await resolveMX(recipientDomain);

    if (mxRecords.length === 0) {
        // Fallback to A record if no MX (older SMTP behavior)
        mxRecords.push({ exchange: recipientDomain, priority: 0 });
    }

    // 2. Try each MX record until success
    let lastError = null;
    let delivered = false;

    for (const mx of mxRecords) {
        console.log(`   Trying MX: ${mx.exchange} (Priority: ${mx.priority})`);

        const directTransporter = nodemailer.createTransport({
            host: mx.exchange,
            port: 25,
            secure: false,
            tls: { rejectUnauthorized: false }
        });

        try {
            await directTransporter.sendMail({
                from: `"${fromName}" <${fromEmail}>`,
                to: data.to,
                subject: data.subject,
                text: data.text,
                html: data.html
            });
            console.log(`   ✓ Successfully delivered to ${mx.exchange}`);
            delivered = true;
            break;
        } catch (error) {
            console.warn(`   ✗ Failed delivery to ${mx.exchange}:`, error.message);
            lastError = error;
        }
    }

    // 3. Fallback to configured provider if direct failed
    if (!delivered && transporter) {
        console.log('   Falling back to configured SMTP provider...');
        try {
            await transporter.sendMail({
                from: `"${fromName}" <${fromEmail}>`,
                to: data.to,
                subject: data.subject,
                text: data.text,
                html: data.html
            });
            delivered = true;
        } catch (error) {
            lastError = error;
        }
    }

    if (delivered) {
        // Store in "Sent" folder
        await Email.create({
            messageId: `<${Date.now()}@wordjs.com>`,
            fromAddress: fromEmail,
            fromName: fromName,
            toAddress: data.to,
            subject: data.subject,
            bodyText: data.text,
            bodyHtml: data.html,
            isSent: 1,
            rawContent: data.html || data.text,
            parentId,
            threadId
        });
        return { success: true };
    }

    throw lastError || new Error(`Could not deliver email to ${data.to} via any MX server.`);
}

exports.init = async function () {
    const { getOption, updateOption } = require('../../src/core/options');
    const express = require('express');
    const { authenticate } = require('../../src/middleware/auth');
    const { isAdmin } = require('../../src/middleware/permissions');

    // Initialize
    await Email.initSchema();
    await initTransporter();
    await initSMTPServer();

    // === API ROUTES ===
    const router = express.Router();

    // GET /api/v1/mail-server/emails - List Inbox/Sent (Filtered by User)
    router.get('/emails', authenticate, async (req, res) => {
        const folder = req.query.folder || 'inbox'; // 'inbox' or 'sent'
        const limit = parseInt(req.query.limit || '50', 10);
        const offset = parseInt(req.query.offset || '0', 10);

        const emails = await Email.findAllByUser(req.user.userEmail, folder, limit, offset);
        const total = await Email.countByUser(req.user.userEmail, folder);

        res.json({ emails, total });
    });

    // GET /api/v1/mail-server/emails/:id - Get Details (Ownership required)
    router.get('/emails/:id', authenticate, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        // Security: Must be either the recipient or the sender
        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail && req.user.role !== 'administrator') {
            return res.status(403).json({ error: 'Access denied to this message' });
        }

        await Email.markAsRead(req.params.id);

        // Fetch full thread if it exists (either as child or parent)
        const threadIdToSearch = email.thread_id || email.id;
        const thread = await Email.findByThreadId(threadIdToSearch);

        if (thread && thread.length > 1) {
            return res.json({ ...email, thread });
        }

        res.json(email);
    });

    // DELETE /api/v1/mail-server/emails/:id - Delete (Ownership required)
    router.delete('/emails/:id', authenticate, async (req, res) => {
        const email = await Email.findById(req.params.id);
        if (!email) return res.status(404).json({ error: 'Email not found' });

        if (email.to_address !== req.user.userEmail && email.from_address !== req.user.userEmail && req.user.role !== 'administrator') {
            return res.status(403).json({ error: 'Cannot delete this message' });
        }

        await Email.delete(req.params.id);
        res.json({ success: true });
    });

    // POST /api/v1/mail-server/send - Compose Personal Email
    router.post('/send', authenticate, async (req, res) => {
        const { to, subject, body, isHtml = true, replyToId } = req.body;
        if (!to || !subject || !body) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        let parentId = 0;
        let threadId = 0;

        // If replying, fetch parent to identify thread
        if (replyToId) {
            const parent = await Email.findById(replyToId);
            if (parent) {
                parentId = parent.id;
                // If parent already has a thread_id, join it. Else, parent IS the start -> use parent.id
                threadId = parent.thread_id || parent.id;
            }
        }

        try {
            await sendMail({
                to,
                subject,
                text: isHtml ? body.replace(/<[^>]*>/g, '') : body,
                html: isHtml ? body : null,
                fromEmail: req.user.userEmail,
                fromName: req.user.displayName || req.user.userLogin,
                parentId,
                threadId
            });
            res.json({ success: true, message: 'Message delivered' });
        } catch (error) {
            res.status(500).json({ error: 'Delivery failed: ' + error.message });
        }
    });

    // GET /api/v1/mail-server/users/search - Autocomplete for "To" field
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

    // GET /api/v1/mail-server/settings (Strict Admin)
    router.get('/settings', authenticate, isAdmin, async (req, res) => {
        res.json({
            mail_from_email: await getOption('mail_from_email', ''),
            mail_from_name: await getOption('mail_from_name', ''),
            smtp_listen_port: await getOption('smtp_listen_port', '2525'),
            smtp_catch_all: await getOption('smtp_catch_all', '0')
        });
    });

    // POST /api/v1/mail-server/settings (Strict Admin)
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

    // Expose sendMail utility
    global.wordjs_send_mail = sendMail;

    // Register as a Notification Transport
    notificationService.registerTransport('email', async (notification) => {
        // Find user email if user_id is provided
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

    // Filter admin menu items visibility
    const { addFilter } = require('../../src/core/hooks');
    const config = require('../../src/config/app');
    const siteUrl = new URL(config.site.url);
    const siteDomain = siteUrl.hostname;

    addFilter('admin_menu_items', (items, { user }) => {
        if (!user) return items;

        // Professional email pattern: username@siteDomain (case-insensitive check)
        const professionalEmail = `${user.userLogin.toLowerCase()}@${siteDomain.toLowerCase()}`;
        const isProfessional = user.userEmail.toLowerCase() === professionalEmail;

        if (!isProfessional && user.role !== 'administrator') {
            // Hide "Email Center" for non-professional users (except admins for safety)
            return items.filter(item => item.plugin !== 'mail-server');
        }

        return items;
    });

    console.log('Mail Server plugin v1.3.1 initialized (Async Config)!');
};

exports.deactivate = function () {
    const { unregisterAdminMenu } = require('../../src/core/adminMenu');
    unregisterAdminMenu('mail-server');
    if (smtpServer) {
        smtpServer.close();
    }
    console.log('Mail Server plugin deactivated');
};
