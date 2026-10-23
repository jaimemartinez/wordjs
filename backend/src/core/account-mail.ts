/**
 * WordJS — ACCOUNT MAIL: password-reset links, e-mail verification links and the sign-up notices next to
 * them, and the ONE rule for which transport may carry them.
 *
 * WHY THESE MESSAGES ARE DIFFERENT. A reset link IS the account: whoever reads it can set the password.
 * The site's ordinary outbound mail goes through a mail-PROVIDER plugin (core/mail-provider — the plugin
 * holding the `email:provider` grant), and a provider sees every message it sends. Routing reset links
 * through it made that grant administrator-equivalent: the provider could reset any administrator's
 * password and sign in as them. So account mail does not go to a plugin unless an administrator said so:
 *
 *   1. THE BUILT-IN TRANSPORT (default). An SMTP relay the administrator configures in Settings → Account email
 *      (host, port, TLS mode, credentials, from address), sent by the host itself with nodemailer — no
 *      plugin ever sees the message. The relay host goes through the egress policy like the AI provider's
 *      base URL: a server on this machine or a private network only from the primary site, link-local /
 *      metadata never, and the address connected to is the one that was checked (resolved and pinned,
 *      TLS still verified against the name).
 *   2. A PROVIDER PLUGIN, ONLY BY NAME. `account_mail_provider_allowed` lists the plugin folders an
 *      administrator explicitly allowed to carry account mail (with the warning that the plugin can then
 *      take over any account). Allowing one is per plugin: another plugin that later becomes the provider
 *      inherits nothing. Sites upgraded from a version that sent account mail through the provider keep
 *      that provider allowed (schema migration 0018), so password recovery does not silently stop — and
 *      Settings says so until the administrator chooses.
 *   3. OTHERWISE NOTHING IS SENT — account mail fails closed exactly like "no mail provider" always did
 *      (forgot-password answers the same 200, verification degrades to off).
 *
 * Secrets: the relay password is the option `account_mail_smtp_password` — a secret-shaped name, so the
 * options layer redacts it from hooks and the plugin bridge can neither read nor write it — and no route
 * returns it (the admin screen gets `hasPassword`). The settings and the allowance are protected option
 * names (core/plugin-api), so a settings:write plugin cannot point account mail at itself.
 */

const net = require('net');
const siteContext = require('./site-context');

const SMTP_OPTION = 'account_mail_smtp';
const SMTP_PASSWORD_OPTION = 'account_mail_smtp_password';
const PROVIDER_ALLOWED_OPTION = 'account_mail_provider_allowed';

const SECURITY_MODES = ['tls', 'starttls', 'none'] as const;
type SecurityMode = typeof SECURITY_MODES[number];

export interface SmtpSettings {
    host: string;
    port: number;
    security: SecurityMode;
    username: string;
    fromAddress: string;
    fromName: string;
}

class AccountMailError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 400, code = 'rest_invalid_param') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const EMAIL_RE = /^[^@\s<>"]{1,64}@[^@\s<>"]{1,253}$/;

function opts() { return require('./options'); }

function parseSmtp(raw: unknown): SmtpSettings | null {
    let v: any = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    if (!v || typeof v !== 'object' || typeof v.host !== 'string' || !v.host) return null;
    const port = Number(v.port);
    return {
        host: String(v.host).slice(0, 253),
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 587,
        security: (SECURITY_MODES as readonly string[]).includes(v.security) ? v.security : 'starttls',
        username: typeof v.username === 'string' ? v.username.slice(0, 320) : '',
        fromAddress: typeof v.fromAddress === 'string' ? v.fromAddress.slice(0, 320) : '',
        fromName: typeof v.fromName === 'string' ? v.fromName.slice(0, 200) : '',
    };
}

async function readSmtp(): Promise<SmtpSettings | null> {
    return parseSmtp(await opts().getOption(SMTP_OPTION, null));
}

async function readPassword(): Promise<string> {
    const p = await opts().getOption(SMTP_PASSWORD_OPTION, '');
    return typeof p === 'string' ? p : '';
}

/** The plugin folders an administrator allowed to carry account mail (empty = none). */
async function allowedProviders(): Promise<string[]> {
    let v: any = await opts().getOption(PROVIDER_ALLOWED_OPTION, []);
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = v ? [v] : []; } }
    return Array.isArray(v) ? v.filter((s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s)) : [];
}

function isLoopbackHost(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** A relay on this machine or a private network: only the primary site (the network's own administrators). */
function privateRelayAllowed(): boolean {
    if (process.env.WORDJS_ACCOUNT_MAIL_ALLOW_PRIVATE_RELAY === '1') return true;
    try { return siteContext.isPrimarySite(); } catch { return false; }
}

/**
 * Resolve the relay host under the egress policy and return the ADDRESS to connect to (so the address
 * checked is the address used). Link-local / metadata / multicast / unspecified are refused on every
 * site; loopback and private ranges only where privateRelayAllowed().
 */
async function resolveRelay(host: string): Promise<string> {
    const egress = require('./egress-guard');
    const bare = host.replace(/^\[|\]$/g, '');
    const judge = (ip: string) => {
        if (egress.isNeverExemptIp(ip)) throw new AccountMailError('That mail server address can never be used: link-local and cloud-metadata addresses are refused.', 400, 'account_mail_address_blocked');
        if (egress.isBlockedIp(ip) && !privateRelayAllowed()) {
            throw new AccountMailError('That mail server address is not allowed from this site. Use a public mail relay (a server on this machine or a private network is only accepted on the primary site).', 400, 'account_mail_address_blocked');
        }
        return ip;
    };
    if (net.isIP(bare)) return judge(bare);
    if (/^localhost$|\.localhost$/i.test(bare)) {
        if (!privateRelayAllowed()) judge('127.0.0.1');
        return '127.0.0.1';
    }
    const addresses: Array<{ address: string }> = await new Promise((resolve, reject) => {
        require('dns').lookup(bare, { all: true, verbatim: true }, (err: any, list: any) => (err ? reject(err) : resolve(list)));
    }).catch((e: any) => {
        throw new AccountMailError(`Could not resolve the mail server ${bare}${e && e.code ? ` (${e.code})` : ''}.`, 502, 'account_mail_unreachable');
    }) as any;
    if (!addresses.length) throw new AccountMailError(`Could not resolve the mail server ${bare}.`, 502, 'account_mail_unreachable');
    for (const a of addresses) judge(a.address);
    return addresses[0].address;
}

function validateSmtpInput(input: any): SmtpSettings {
    const host = String(input && input.host != null ? input.host : '').trim();
    if (!host || !(HOST_RE.test(host) || net.isIP(host.replace(/^\[|\]$/g, '')))) throw new AccountMailError('Enter the mail server host name (for example smtp.example.com).');
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AccountMailError('The port must be a number between 1 and 65535.');
    const security = String(input.security || 'starttls') as SecurityMode;
    if (!(SECURITY_MODES as readonly string[]).includes(security)) throw new AccountMailError('Security must be one of tls, starttls or none.');
    // Credentials and reset links in clear text are only acceptable to a relay on this machine.
    if (security === 'none' && !isLoopbackHost(host)) throw new AccountMailError('An unencrypted connection is only allowed to a mail server on this machine. Use TLS or STARTTLS.');
    const username = String(input.username || '').trim();
    if (username.length > 320 || /[\r\n]/.test(username)) throw new AccountMailError('That username is not valid.');
    const fromAddress = String(input.fromAddress || '').trim();
    if (!EMAIL_RE.test(fromAddress) || /[\r\n]/.test(fromAddress)) throw new AccountMailError('Enter the address the messages are sent from.');
    const fromName = String(input.fromName || '').trim().slice(0, 200);
    if (/[\r\n]/.test(fromName)) throw new AccountMailError('That sender name is not valid.');
    return { host, port, security, username, fromAddress, fromName };
}

/** Save (or clear, with `{ clear: true }`) the built-in transport. The password is only touched when sent. */
async function saveSmtpSettings(input: any): Promise<{ configured: boolean; host: string; passwordChanged: boolean }> {
    const { updateOption } = opts();
    if (input && input.clear === true) {
        await updateOption(SMTP_OPTION, '');
        await updateOption(SMTP_PASSWORD_OPTION, '');
        return { configured: false, host: '', passwordChanged: true };
    }
    const s = validateSmtpInput(input || {});
    await resolveRelay(s.host);
    await updateOption(SMTP_OPTION, JSON.stringify(s));
    let passwordChanged = false;
    if (typeof input.password === 'string' && input.password !== '') {
        if (input.password.length > 1024 || /[\r\n]/.test(input.password)) throw new AccountMailError('That password is not valid.');
        await updateOption(SMTP_PASSWORD_OPTION, input.password);
        passwordChanged = true;
    }
    if (!s.username && (await readPassword())) {
        await updateOption(SMTP_PASSWORD_OPTION, '');
        passwordChanged = true;
    }
    return { configured: true, host: s.host, passwordChanged };
}

/** Allow (or stop allowing) the plugin `slug` to carry account mail. */
async function setProviderAllowed(slug: string, allowed: boolean): Promise<string[]> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(slug || ''))) throw new AccountMailError('Name the plugin by its folder.');
    const current = new Set(await allowedProviders());
    if (allowed) current.add(slug); else current.delete(slug);
    const next = Array.from(current).sort();
    await opts().updateOption(PROVIDER_ALLOWED_OPTION, JSON.stringify(next));
    return next;
}

async function smtpTransport(s: SmtpSettings): Promise<any> {
    const nodemailer = require('nodemailer');
    const address = await resolveRelay(s.host);
    const password = await readPassword();
    const servername = net.isIP(s.host.replace(/^\[|\]$/g, '')) ? undefined : s.host;
    return nodemailer.createTransport({
        host: address,
        port: s.port,
        secure: s.security === 'tls',
        requireTLS: s.security === 'starttls',
        ignoreTLS: s.security === 'none',
        auth: s.username ? { user: s.username, pass: password } : undefined,
        // The address connected to was checked above; the certificate is still verified against the NAME.
        tls: { servername, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
        disableFileAccess: true,
        disableUrlAccess: true,
    });
}

/** Which transport would carry account mail right now. */
async function route(): Promise<{ kind: 'core'; smtp: SmtpSettings } | { kind: 'provider'; slug: string } | { kind: 'none'; providerSlug: string | null }> {
    const smtp = await readSmtp();
    if (smtp) return { kind: 'core', smtp };
    const mailProvider = require('./mail-provider');
    const slug = mailProvider.isEmailProviderAvailable() ? mailProvider.currentProviderSlug() : null;
    if (slug && (await allowedProviders()).includes(slug)) return { kind: 'provider', slug };
    return { kind: 'none', providerSlug: slug };
}

/**
 * Can account mail be delivered? The built-in transport counts as ready once configured; an allowed
 * provider additionally has to have declared itself delivery-ready (`mail_delivery_ready`, the signal
 * routes/auth always required of it).
 */
async function accountMailReady(): Promise<boolean> {
    try {
        const r = await route();
        if (r.kind === 'core') return true;
        if (r.kind === 'provider') return String(await opts().getOption('mail_delivery_ready', '0')) === '1';
        return false;
    } catch {
        return false;
    }
}

/**
 * Send an account message ({ to, subject, text, html }). Throws when no transport may carry it — callers
 * keep their answers uniform and swallow it, as they did when no provider was registered.
 */
async function sendAccountMail(msg: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const r = await route();
    if (r.kind === 'core') {
        const transport = await smtpTransport(r.smtp);
        const from = r.smtp.fromName ? { name: r.smtp.fromName, address: r.smtp.fromAddress } : r.smtp.fromAddress;
        try {
            await transport.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
        } finally {
            try { transport.close(); } catch { /* */ }
        }
        return;
    }
    if (r.kind === 'provider') {
        const send = require('./mail-provider').sendMailFn();
        if (typeof send !== 'function') throw new AccountMailError('No mail transport', 503, 'account_mail_unavailable');
        await send(msg);
        return;
    }
    throw new AccountMailError('No transport may carry account mail', 503, 'account_mail_unavailable');
}

/**
 * HAND an account message to its transport and return without waiting for delivery: resolves once the
 * provider was called or the SMTP send was started, never rejects (a failure is logged without the
 * message). Callers answer uniformly whatever the relay does, and do not wait on it.
 */
async function handOffAccountMail(msg: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const log = require('./module-logger').moduleLogger('core/account-mail');
    const failed = (e: any) => log.warn({ code: e && e.code }, '[account-mail] an account message was not sent');
    try {
        const r = await route();
        if (r.kind === 'none') { failed({ code: 'account_mail_unavailable' }); return; }
        if (r.kind === 'provider') {
            const send = require('./mail-provider').sendMailFn();
            if (typeof send !== 'function') { failed({ code: 'account_mail_unavailable' }); return; }
            // Called now, like the provider always was; its promise is not waited for.
            try { Promise.resolve(send(msg)).catch(failed); } catch (e) { failed(e); }
            return;
        }
        // The built-in transport: resolving the relay and the SMTP exchange happen after the answer.
        Promise.resolve().then(() => sendAccountMail(msg)).catch(failed);
    } catch (e) {
        failed(e);
    }
}

/** What the admin screen may see: everything but the password. */
async function getStatus() {
    const smtp = await readSmtp();
    const mailProvider = require('./mail-provider');
    const providerSlug = mailProvider.isEmailProviderAvailable() ? mailProvider.currentProviderSlug() : null;
    const allowed = await allowedProviders();
    const r = await route();
    return {
        route: r.kind,
        smtp: smtp ? { ...smtp } : null,
        hasPassword: !!(await readPassword()),
        provider: providerSlug,
        providerAllowed: !!(providerSlug && allowed.includes(providerSlug)),
        allowedProviders: allowed,
        ready: await accountMailReady(),
    };
}

/** Send a test message through the built-in transport (never through a plugin). */
async function sendTest(to: string): Promise<void> {
    const smtp = await readSmtp();
    if (!smtp) throw new AccountMailError('Configure the mail server first.', 409, 'account_mail_not_configured');
    if (!EMAIL_RE.test(String(to || '')) || /[\r\n]/.test(String(to))) throw new AccountMailError('Enter the address to send the test to.');
    // The words come from the editable template (Settings → Emails), in the site's language.
    const m = await require('./email-templates').renderEmail('account.mail_test', {});
    const transport = await smtpTransport(smtp);
    try {
        await transport.sendMail({
            from: smtp.fromName ? { name: smtp.fromName, address: smtp.fromAddress } : smtp.fromAddress,
            to,
            subject: m.subject,
            text: m.text,
            html: m.html,
        });
    } catch (e: any) {
        // The relay's answer, without credentials (nodemailer never puts the password in the message).
        throw new AccountMailError(`The mail server refused the test: ${String(e && (e.response || e.message) || e).slice(0, 300)}`, 502, 'account_mail_send_failed');
    } finally {
        try { transport.close(); } catch { /* */ }
    }
}

/**
 * Tell every OTHER administrator, in-app, that `user`'s password was just reset through an emailed link.
 * In-app (the notifications table and the live stream) on purpose: it must reach them even when the mail
 * path is the thing that was abused. The message names the account and the address, never the token.
 */
async function notifyAdminsOfReset(user: any, ip: string | null | undefined): Promise<void> {
    const { dbAsync } = require('../config/database');
    const rows: Array<{ user_id: number }> = (await dbAsync.all(
        "SELECT DISTINCT user_id FROM user_meta WHERE meta_key = 'role' AND meta_value = 'administrator' ORDER BY user_id LIMIT 100")) || [];
    const targets = rows.map((r) => Number(r.user_id)).filter((id) => id && id !== Number(user && user.id));
    if (!targets.length) return;
    const who = String((user && (user.displayName || user.userLogin)) || `#${user && user.id}`).slice(0, 120);
    const login = String((user && user.userLogin) || '').slice(0, 120);
    const where = ip ? ` from ${String(ip).slice(0, 45)}` : '';
    const message = `The password of ${who}${login && login !== who ? ` (${login})` : ''} was reset with an emailed link${where}. `
        + 'If nobody expected this, check that account now, and check how password-reset email is delivered (Settings → Account email).';
    const notifications = require('./notifications');
    const { runAsHost } = require('./plugin-context');
    for (const id of targets) {
        await runAsHost(() => notifications.send({
            user_id: id,
            type: 'warning',
            title: 'A password was reset',
            message,
            icon: 'fa-key',
            action_url: user && user.id ? `/admin/users/${Number(user.id)}` : '/admin/users',
            transports: ['db', 'sse'],
        }));
    }
}

module.exports = {
    notifyAdminsOfReset,
    SMTP_OPTION,
    SMTP_PASSWORD_OPTION,
    PROVIDER_ALLOWED_OPTION,
    AccountMailError,
    accountMailReady,
    sendAccountMail,
    handOffAccountMail,
    saveSmtpSettings,
    setProviderAllowed,
    allowedProviders,
    getStatus,
    sendTest,
    _resolveRelay: resolveRelay,
};
