/**
 * Settings → Emails (core/email-templates, routes/email-templates).
 *
 *  · every core message renders from the registry, in the site's language or the one asked for, inside
 *    the layout (header, card, button, footer) with a plain-text part generated from the same body;
 *  · placeholder values are escaped — `{user_name}` is chosen by an anonymous registrant — and unknown
 *    `{words}` stay as they are;
 *  · stored bodies keep only the mail allowlist; the site-address notice keeps no link at all;
 *  · the action link (reset / verify) is drawn by the layout from the sender's URL: an edited template
 *    cannot drop it, and no edited field — subject, body, button text — can ever carry its token;
 *  · the routes: admin only, a security message's edit needs the password, writes are audited, and the
 *    real reset mail goes out with an administrator's wording and the system's link.
 *
 * MUTATION PROOF: render the subject through escHtml-free substitution of the action URL (add `link` to
 * the values), and "no edited field carries the token" fails; drop the second sanitize after
 * substitution, and the `javascript:` value case fails; make the button conditional on the body
 * mentioning it, and "the link is always there" fails.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-email-templates-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

let et: any;
let options: any;
const TOKEN = 'f00dfacecafebeef0123456789abcdef';
const RESET_URL = `https://site.example/reset-password?uid=7&token=${TOKEN}`;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    options = require('../core/options');
    await options.updateOption('blogname', 'Café Luna');
    await options.updateOption('WPLANG', 'en_US');
    et = require('../core/email-templates');
});

after(async () => {
    try { delete (global as any).wordjs_send_mail; } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + s, { force: true }); } catch { /* */ } }
});

describe('rendering', () => {
    it('every core message renders in en, es and pt inside the layout, with a text part', async () => {
        const ids = et.listTemplates().filter((t: any) => !t.source).map((t: any) => t.id).sort();
        assert.deepStrictEqual(ids, ['account.mail_test', 'account.password_reset', 'account.signup_attempt', 'account.verify_email', 'comments.moderation', 'comments.new', 'site.address_changed']);
        for (const id of ids) {
            for (const lang of ['en', 'es', 'pt']) {
                const m = await et.renderSample(id, lang);
                assert.strictEqual(m.lang, lang);
                assert.ok(m.subject && !/[\r\n]/.test(m.subject), `${id}/${lang}: one-line subject`);
                assert.ok(!m.subject.includes('{'), `${id}/${lang}: every placeholder of the subject filled: ${m.subject}`);
                assert.match(m.html, /^<!DOCTYPE html>/);
                assert.match(m.html, /<html lang="(en|es|pt)">/);
                assert.match(m.html, /role="presentation"/, 'table-based');
                assert.match(m.html, /prefers-color-scheme: dark/);
                assert.ok(m.html.includes('Café Luna'), 'the header names the site');
                assert.ok(m.text.length > 20 && !['<p', '<strong', '<a ', '<table', '<br'].some((tag) => m.text.includes(tag)), `${id}/${lang}: the text part has no tags`);
                assert.ok(!m.text.includes('{') , `${id}/${lang}: no unfilled placeholder in the text: ${m.text}`);
            }
        }
    });

    it('follows the site language, and an explicit language wins', async () => {
        await options.updateOption('WPLANG', 'es_ES');
        const es = await et.renderEmail('account.signup_attempt', {});
        assert.strictEqual(es.lang, 'es');
        assert.match(es.subject, /^Intento de registro en Café Luna$/);
        const pt = await et.renderEmail('account.signup_attempt', { lang: 'pt' });
        assert.match(pt.subject, /^Tentativa de cadastro em Café Luna$/);
        await options.updateOption('WPLANG', 'en_US');
        const en = await et.renderEmail('account.signup_attempt', { lang: 'de' });
        assert.strictEqual(en.lang, 'en', 'an unsupported language falls back to the site language');
    });

    it('the defaults say what the hard-coded messages said', async () => {
        const m = await et.renderEmail('account.password_reset', { lang: 'en', values: { user_name: 'jane', expires: '30 minutes' }, actionUrl: RESET_URL });
        assert.strictEqual(m.subject, 'Password reset for Café Luna');
        assert.match(m.text, /Someone requested a password reset for your Café Luna account \(jane\)\./);
        assert.match(m.text, /The link is valid for 30 minutes\./);
        assert.match(m.text, /Reset your password:\nhttps:\/\/site\.example\/reset-password\?uid=7&token=/);
    });

    it('the plain-text part reads paragraphs, lists, quotes and links from the same body', () => {
        const text = et.plainText('<p>Hello <strong>there</strong> &amp; welcome</p><ul><li>one</li><li>two</li></ul><blockquote>quoted</blockquote><p>Read <a href="https://docs.example/x">the guide</a>.</p><h2>Title</h2><p>a<br>b</p>');
        assert.strictEqual(text, 'Hello there & welcome\n\n- one\n- two\n\n> quoted\n\nRead the guide (https://docs.example/x).\n\nTitle\n\na\nb');
    });

    it('the button colour comes from the layout override, else the theme', async () => {
        const before = await et.renderSample('account.password_reset', 'en');
        await et.saveLayout({ accentColor: '#ff6600', backgroundColor: '', showLogo: true, footerText: 'Calle 1, Bogotá' });
        const after = await et.renderSample('account.password_reset', 'en');
        assert.ok(after.html.includes('background:#ff6600'), 'the override paints the button');
        assert.ok(after.html.includes('Calle 1, Bogotá') && after.text.includes('Calle 1, Bogotá'), 'the footer line in both parts');
        assert.notStrictEqual(before.html, after.html);
        await assert.rejects(() => et.saveLayout({ accentColor: 'red;background:url(x)' }), /colour/);
        await et.saveLayout({ accentColor: '', backgroundColor: '', showLogo: true, footerText: '' });
    });
});

describe('placeholders', () => {
    it('values are escaped into the body and the subject stays text', async () => {
        const evil = '</strong><a href="https://evil.example/login">Sign in again</a><img src=x onerror=alert(1)>';
        const m = await et.renderEmail('account.verify_email', { lang: 'en', values: { user_name: evil, expires: '24 hours' }, actionUrl: 'https://site.example/verify-email?token=abc' });
        assert.ok(!m.html.includes('<a href="https://evil.example'), 'no injected link');
        assert.ok(!m.html.includes('<img src=x'), 'no injected image');
        assert.ok(m.html.includes('&lt;a href="https://evil.example/login"&gt;Sign in again&lt;/a&gt;'), 'shown as text');
        assert.ok(m.text.includes(evil), 'the text part carries the value verbatim (it is text)');
    });

    it('a value cannot become an attribute: the body is sanitized again after substitution', async () => {
        await et.saveTemplate('comments.new', 'en', { subject: 'x {post_title}', body: '<p>By {comment_author}</p>', actionLabel: 'Open' });
        const m = await et.renderEmail('comments.new', { lang: 'en', values: { comment_author: 'javascript:alert(1)', post_title: 'T' }, actionUrl: 'https://site.example/admin/comments' });
        assert.ok(!/href="javascript:/i.test(m.html));
        await et.resetTemplate('comments.new');
    });

    it('only declared placeholders are filled; others stay literal; the site name always comes from the site', async () => {
        await et.saveTemplate('account.signup_attempt', 'en', { subject: '{site_name} {nope} {user_name}', body: '<p>{site_name} {link} {token}</p>' });
        const m = await et.renderEmail('account.signup_attempt', { lang: 'en', values: { site_name: 'Spoofed', user_name: 'x', link: RESET_URL, token: TOKEN } });
        assert.strictEqual(m.subject, 'Café Luna {nope} {user_name}');
        assert.ok(m.text.startsWith('Café Luna {link} {token}'));
        assert.ok(!m.html.includes(TOKEN) && !m.text.includes(TOKEN));
        await et.resetTemplate('account.signup_attempt');
    });
});

describe('sanitizing', () => {
    it('stored bodies keep only the mail allowlist', async () => {
        await et.saveTemplate('account.mail_test', 'en', {
            subject: 'Line one\r\nBcc: victim@example.com',
            body: '<p onclick="x()" style="color:red">Hi <b>bold</b> <i>it</i> <img src="https://t.example/p.gif"><a href="javascript:alert(1)">js</a> <a href="https://ok.example" target="_blank">ok</a></p><script>bad()</script><iframe src="https://x"></iframe><style>p{}</style>',
        });
        const d = await et.describeTemplate('account.mail_test');
        const body = d.languages.en.body;
        assert.strictEqual(d.languages.en.subject, 'Line one Bcc: victim@example.com', 'one line: no header injection');
        assert.strictEqual(body, '<p>Hi <strong>bold</strong> <em>it</em> <a>js</a> <a href="https://ok.example">ok</a></p>');
        assert.deepStrictEqual(d.customized, ['en']);
        await et.resetTemplate('account.mail_test', 'en');
        assert.deepStrictEqual((await et.describeTemplate('account.mail_test')).customized, []);
    });

    it('a value written around the screen is held to the same allowlist at render', async () => {
        await options.updateOption('email_templates', JSON.stringify({ 'account.mail_test': { en: { subject: 'S', body: '<p>ok</p><script>x()</script><a href="javascript:x">j</a>' } } }));
        const m = await et.renderEmail('account.mail_test', { lang: 'en' });
        assert.ok(!m.html.includes('<script') && !/javascript:/i.test(m.html));
        await et.resetTemplate('account.mail_test');
    });

    it('the site-address notice keeps no link, whatever the edit says', async () => {
        await et.saveTemplate('site.address_changed', 'en', { subject: 'Moved', body: '<p>{change} <a href="https://phish.example">confirm here</a></p>' });
        const m = await et.renderEmail('site.address_changed', { lang: 'en', values: { change: 'Main address changed.' } });
        assert.ok(!m.html.includes('phish.example') && !m.text.includes('phish.example'));
        assert.ok(!m.html.includes('<a '), 'not one anchor in the whole message (footer address is text)');
        await et.resetTemplate('site.address_changed');
    });

    it('rejects an empty subject, body or button text and an unknown language', async () => {
        await assert.rejects(() => et.saveTemplate('account.password_reset', 'en', { subject: ' ', body: '<p>x</p>', actionLabel: 'Go' }), /subject/);
        await assert.rejects(() => et.saveTemplate('account.password_reset', 'en', { subject: 'S', body: '<script>x</script>', actionLabel: 'Go' }), /message/);
        await assert.rejects(() => et.saveTemplate('account.password_reset', 'en', { subject: 'S', body: '<p>x</p>', actionLabel: '' }), /button/);
        await assert.rejects(() => et.saveTemplate('account.password_reset', 'fr', { subject: 'S', body: '<p>x</p>', actionLabel: 'Go' }), /language/);
        await assert.rejects(() => et.saveTemplate('nope.nothing', 'en', { subject: 'S', body: '<p>x</p>' }), /No email template/);
    });
});

describe('the action link is the system\'s', () => {
    it('an edit that leaves the link out still sends it, as the button and as the copy-this line', async () => {
        await et.saveTemplate('account.password_reset', 'en', { subject: 'Reset {user_name}', body: '<p>Just text, no link at all.</p>', actionLabel: 'Go' });
        const m = await et.renderEmail('account.password_reset', { lang: 'en', values: { user_name: 'jane', expires: '30 minutes' }, actionUrl: RESET_URL });
        const escaped = RESET_URL.replace(/&/g, '&amp;');
        assert.strictEqual(m.html.split(`href="${escaped}"`).length - 1, 2, 'button + fallback link');
        assert.ok(m.text.includes(RESET_URL), 'and in the text part');
        await et.resetTemplate('account.password_reset');
    });

    it('no edited field can carry the token', async () => {
        await et.saveTemplate('account.password_reset', 'en', {
            subject: '{link} {action_url} {token} {url} {user_name} {expires}',
            body: '<p>{link} {action_url} {token} {url} {reset_link}</p><p><a href="{link}">here</a></p>',
            actionLabel: '{link} {token}',
        });
        const m = await et.renderEmail('account.password_reset', { lang: 'en', values: { user_name: 'jane', expires: '30 minutes' }, actionUrl: RESET_URL });
        assert.ok(!m.subject.includes(TOKEN), 'not in the subject');
        const body = m.html.slice(m.html.indexOf('class="wjs-body"'));
        const editable = body.slice(0, body.indexOf('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px'));
        assert.ok(!editable.includes(TOKEN), 'not in the edited body');
        assert.ok(m.html.includes('>{link} {token}</a></td>'), 'the button text is the edit, left literal');
        // The token appears exactly where the layout puts it: the button href, the fallback href and text.
        assert.strictEqual(m.html.split(TOKEN).length - 1, 3);
        await et.resetTemplate('account.password_reset');
    });

    it('a message with a button refuses to render without its link', async () => {
        await assert.rejects(() => et.renderEmail('account.password_reset', { lang: 'en', values: {} }), /needs its link/);
        await assert.rejects(() => et.renderEmail('account.password_reset', { lang: 'en', actionUrl: 'javascript:alert(1)' }), /needs its link/);
    });
});

describe('plugin templates', () => {
    it('a plugin registers its own message under its folder and cannot replace a core one', async () => {
        assert.throws(() => et.registerEmailTemplate({ id: 'account.password_reset', subject: 'x', body: '<p>x</p>' }, 'evil'), /core message|start with its folder/);
        assert.throws(() => et.registerEmailTemplate({ id: 'other.hello', subject: 'x', body: '<p>x</p>' }, 'mine'), /start with its folder/);
        const t = et.registerEmailTemplate({ id: 'mine.hello', name: 'Hello', subject: { en: 'Hi {site_name}', es: 'Hola {site_name}' }, body: '<p>Hi {first}</p><script>x</script>', placeholders: [{ key: 'first', label: 'First name', sample: 'Ana' }], transport: 'account' }, 'mine');
        assert.strictEqual(t.group, 'plugin');
        assert.strictEqual(t.transport, 'site', 'a plugin message never rides the account transport');
        assert.strictEqual(t.body.en, '<p>Hi {first}</p>');
        const m = await et.renderEmail('mine.hello', { lang: 'es', values: { first: 'Ana' } });
        assert.strictEqual(m.subject, 'Hola Café Luna');
        et.unregisterPluginTemplates('mine');
        assert.throws(() => et.getTemplate('mine.hello'), /No email template/);
    });
});

describe('routes and the real senders', () => {
    let request: any;
    let app: any;
    let adminId = 0;
    let editorId = 0;
    const sent: any[] = [];
    const PW = 'Admin-passphrase-123!';

    before(async () => {
        request = require('supertest');
        await require('../core/roles').loadRoles();
        const User = require('../models/User');
        adminId = (await User.create({ username: 'mailadmin', email: 'mailadmin@example.org', password: PW, role: 'administrator' })).id;
        editorId = (await User.create({ username: 'mailed', email: 'mailed@example.org', password: 'Editor-passphrase-123!', role: 'editor' })).id;
        (global as any).wordjs_send_mail = (m: any) => { sent.push(m); return { queued: true }; };
        require('../core/mail-provider').setMailProvider((global as any).wordjs_send_mail, 'test-mailer');
        await options.updateOption('account_mail_provider_allowed', JSON.stringify(['test-mailer']));
        await options.updateOption('mail_delivery_ready', '1');
        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/v1/email-templates', require('../routes/email-templates'));
        app.use('/api/v1/auth', require('../routes/auth'));
    });

    const asUser = (id: number) => `Bearer ${jwt.sign({ userId: id }, config.jwt.secret, { expiresIn: '1h' })}`;

    it('is administrators only', async () => {
        const r = await request(app).get('/api/v1/email-templates').set('Authorization', asUser(editorId));
        assert.strictEqual(r.status, 403);
        const ok = await request(app).get('/api/v1/email-templates').set('Authorization', asUser(adminId));
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.ok(ok.body.templates.length >= 7 && ok.body.layout && ok.body.languages.length === 3);
    });

    it('a security message needs the password; a comment message does not; both are audited', async () => {
        const body = { subject: 'Restablece {user_name}', body: '<p>Pediste un enlace nuevo para <strong>{site_name}</strong>.</p>', actionLabel: 'Elegir contraseña' };
        const no = await request(app).put('/api/v1/email-templates/account.password_reset/es').set('Authorization', asUser(adminId)).send(body);
        assert.strictEqual(no.status, 403);
        const yes = await request(app).put('/api/v1/email-templates/account.password_reset/es').set('Authorization', asUser(adminId)).send({ ...body, currentPassword: PW });
        assert.strictEqual(yes.status, 200, JSON.stringify(yes.body));
        assert.deepStrictEqual(yes.body.customized, ['es']);
        const c = await request(app).put('/api/v1/email-templates/comments.new/en').set('Authorization', asUser(adminId)).send({ subject: 'New comment', body: '<p>{comment_author} wrote</p>', actionLabel: 'See it' });
        assert.strictEqual(c.status, 200, JSON.stringify(c.body));
        const rows = await database.dbAsync.all("SELECT action, target_id, detail FROM audit_log WHERE action LIKE 'email_template.%' ORDER BY id");
        assert.deepStrictEqual(rows.map((r: any) => `${r.action} ${r.target_id}`), ['email_template.update account.password_reset', 'email_template.update comments.new']);
        assert.ok(!rows.some((r: any) => String(r.detail).includes('Pediste')), 'the audit row never holds the text');
        const reset = await request(app).post('/api/v1/email-templates/comments.new/reset').set('Authorization', asUser(adminId)).send({});
        assert.strictEqual(reset.status, 200);
        assert.deepStrictEqual(reset.body.customized, []);
    });

    it('the preview renders an unsaved draft and stores nothing', async () => {
        const r = await request(app).post('/api/v1/email-templates/account.verify_email/preview').set('Authorization', asUser(adminId))
            .send({ lang: 'pt', draft: { subject: 'Rascunho {user_name}', body: '<p>Olá</p>', actionLabel: 'Confirmar' } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.match(r.body.subject, /^Rascunho /);
        assert.ok(r.body.html.includes('Confirmar') && r.body.text.includes('Olá'));
        const d = await et.describeTemplate('account.verify_email');
        assert.deepStrictEqual(d.customized, []);
    });

    it('"send a test" goes to the signed-in administrator through the message\'s transport', async () => {
        sent.length = 0;
        const r = await request(app).post('/api/v1/email-templates/comments.moderation/test').set('Authorization', asUser(adminId)).send({ lang: 'en' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].to, 'mailadmin@example.org');
        assert.ok(sent[0].html.includes('<!DOCTYPE html>') && sent[0].text);
    });

    it('the real reset mail uses the edited words, the reader\'s language and the system\'s link', async () => {
        sent.length = 0;
        const res = await request(app).post('/api/v1/auth/forgot-password').set('Cookie', 'wordjs-lang=es').send({ login: 'mailadmin' });
        assert.strictEqual(res.status, 200);
        await new Promise((r) => setTimeout(r, 50));
        assert.strictEqual(sent.length, 1);
        const m = sent[0];
        assert.strictEqual(m.subject, 'Restablece mailadmin');
        assert.match(m.text, /Pediste un enlace nuevo para Café Luna\./);
        const link = /https?:\/\/[^\s]+\/reset-password\?uid=\d+&token=[a-f0-9]+/.exec(m.text);
        assert.ok(link, `the link is in the text part:\n${m.text}`);
        assert.ok(m.html.includes(link![0].replace(/&/g, '&amp;')), 'and in the html');
        assert.ok(m.html.includes('Elegir contraseña'));
        await et.resetTemplate('account.password_reset');
    });
});
