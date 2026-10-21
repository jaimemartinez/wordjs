/**
 * Core mail pieces the three-mode lab pass found missing or wrong. All generic: none of them names a
 * plugin — they serve whichever mail-provider plugin the site runs.
 *
 *  · Settings → Discussion stored `comments_notify` / `moderation_notify` and nothing read them: no
 *    comment ever produced an email (core/comment-notify).
 *  · "Free port 25" disables the distro MTA for good; once the plugin that asked for the port is gone
 *    nothing listens there and the machine silently stops receiving mail. The liberation is now
 *    recorded and can be undone from the panel (core/port-conflicts).
 *  · The host's inbound SMTP greeted with the machine's hostname and offered STARTTLS with
 *    smtp-server's built-in example certificate (CN=localhost, expired, private key public). It now
 *    greets with the name the plugin gives and presents a key pair of its own (core/inbound-smtp).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-mail-core-qa-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const TLS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-inbound-tls-'));
process.env.WORDJS_INBOUND_SMTP_TLS_DIR = TLS_TMP;

let User: any;
let Post: any;
let Comment: any;
let options: any;
let mailProvider: any;
const ids: Record<string, number> = {};
const outbox: any[] = [];

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await require('../core/roles').loadRoles();
    User = require('../models/User');
    Post = require('../models/Post');
    Comment = require('../models/Comment');
    options = require('../core/options');
    mailProvider = require('../core/mail-provider');
    ids.admin = (await User.create({ username: 'siteadmin', email: 'owner.private@gmail.com', password: 'Admin-passphrase-123!', role: 'administrator' })).id;
    ids.author = (await User.create({ username: 'writer', email: 'writer@example.org', password: 'Writer-passphrase-123!', role: 'author' })).id;
    await options.updateOption('admin_email', 'owner.private@gmail.com');
    await options.updateOption('blogname', 'QA Site');
    ids.post = (await Post.create({ title: 'Hello world', content: 'x', status: 'publish', authorId: ids.author })).id;
    require('../core/comment-notify').initCommentNotify();
});

after(async () => {
    try { require('../core/comment-notify').stopCommentNotify(); } catch { /* */ }
    try { mailProvider.clearMailProvider(); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + s, { force: true }); } catch { /* */ } }
    try { fs.rmSync(TLS_TMP, { recursive: true, force: true }); } catch { /* */ }
});

const flush = () => new Promise((r) => setTimeout(r, 30));
const comment = (over: any = {}) => Comment.create({ postId: ids.post, author: 'Visitor Vee', authorEmail: 'vee@visitor.example', authorIp: '203.0.113.9', content: '<b>Nice</b> post &amp; thanks', ...over });

// ================================================================================================
// Comment notifications

test('a comment held for moderation emails the administration address; an approved one emails the author', async () => {
    mailProvider.setMailProvider((m: any) => { outbox.push(m); return { queued: true }; }, 'some-mailer');
    outbox.length = 0;
    await comment({ status: '0' });
    await flush();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, 'owner.private@gmail.com', 'the personal address may RECEIVE site notices');
    assert.match(outbox[0].subject, /^\[QA Site\] Please moderate: “Hello world”/);
    assert.match(outbox[0].text, /Visitor Vee/);
    assert.match(outbox[0].text, /“Nice post & thanks”/, 'plain text, tags dropped');
    assert.ok(!outbox[0].text.includes('vee@visitor.example') && !outbox[0].text.includes('203.0.113.9'), 'no commenter email or IP');
    assert.ok(!/<b>/.test(outbox[0].html), 'the comment HTML is never forwarded');
    assert.match(outbox[0].text, /\/admin\/comments/);

    outbox.length = 0;
    await comment({ status: '1' });
    await flush();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, 'writer@example.org');
    assert.match(outbox[0].subject, /Comment: “Hello world”/);
});

test('the switches are honoured — stored as numbers or strings — and spam, own comments and no provider send nothing', async () => {
    outbox.length = 0;
    await options.updateOption('moderation_notify', 0);
    await options.updateOption('comments_notify', '0');
    await comment({ status: '0' });
    await comment({ status: '1' });
    await flush();
    assert.equal(outbox.length, 0, 'both switched off');

    await options.updateOption('moderation_notify', '1');
    await options.updateOption('comments_notify', 1);
    await comment({ status: 'spam' });
    await comment({ status: '1', userId: ids.author, authorEmail: 'writer@example.org', author: 'writer' });
    await flush();
    assert.equal(outbox.length, 0, 'spam and the author\'s own comment');

    mailProvider.clearMailProvider();
    await comment({ status: '0' });
    await flush();
    assert.equal(outbox.length, 0, 'no mail provider, nothing (and the comment still saves)');
});

// ================================================================================================
// Giving port 25 back

test('a freed MTA is recorded and can be turned back on — only with consent, only a recorded one', async () => {
    const pc = require('../core/port-conflicts');
    const runs: string[][] = [];
    const deps = { execFileAsync: async (cmd: string, args: string[]) => { runs.push([cmd, ...args]); return { stdout: '' }; } };

    await pc.recordFreedService('mail-server', 25, 'postfix', 'Postfix');
    const list = await pc.listFreedServices();
    assert.deepEqual(list.map((r: any) => [r.slug, r.port, r.service]), [['mail-server', 25, 'postfix']]);

    await assert.rejects(pc.restoreFreedService('postfix', deps), (e: any) => e.code === 'CONSENT_REQUIRED');
    await assert.rejects(pc.restoreFreedService('sshd', { ...deps, allowEnable: true }), (e: any) => e.code === 'NOT_FREED', 'never a service it did not disable');
    assert.equal(runs.length, 0);

    const done = await pc.restoreFreedService('postfix', { ...deps, allowEnable: true });
    assert.equal(done.restored, true);
    assert.deepEqual(runs, [['systemctl', 'enable', '--now', 'postfix']]);
    assert.deepEqual(await pc.listFreedServices(), [], 'the record is gone');

    // A stored record naming something outside the known-MTA list is ignored.
    await options.updateOption('port_conflicts_freed', JSON.stringify([{ slug: 'x', port: 25, service: 'sshd', label: 'SSH', at: '' }]));
    assert.deepEqual(await pc.listFreedServices(), []);
});

// ================================================================================================
// Inbound SMTP: greeting name and certificate

function greeting(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        let buf = '';
        s.on('data', (d: Buffer) => {
            buf += d.toString('utf8');
            if (/\r\n$/.test(buf) && !buf.includes('EHLO-SENT')) { s.write('EHLO probe.test\r\n'); buf += 'EHLO-SENT'; }
            else if (/250 [^\r\n]*\r\n$/.test(buf)) { s.end('QUIT\r\n'); resolve(buf); }
        });
        s.on('error', reject);
        setTimeout(() => { s.destroy(); resolve(buf); }, 4000).unref();
    });
}

test('inbound SMTP greets with the plugin\'s HELO name and offers STARTTLS with this install\'s own certificate', async () => {
    const inbound = require('../core/inbound-smtp');
    const free = await new Promise<number>((r) => { const t = net.createServer().listen(0, () => { const p = (t.address() as any).port; t.close(() => r(p)); }); });
    const nothing = async () => null;
    try {
        const st = await inbound.start('mailer', { port: free, name: 'mail.qa.example' }, [free], nothing);
        assert.equal(st.ok, true, JSON.stringify(st));
        assert.ok(st.tls, 'a certificate was prepared');
        assert.equal(st.tls.subject, 'CN=mail.qa.example');
        assert.equal(st.tls.selfSigned, true);
        assert.ok(Date.parse(st.tls.validTo) > Date.now() + 365 * 24 * 3600 * 1000);
        assert.ok(fs.existsSync(path.join(TLS_TMP, 'tls.key')));
        const talk = await greeting(free);
        assert.match(talk, /^220 mail\.qa\.example /, talk);
        assert.match(talk, /STARTTLS/);

        // Restarting keeps the same certificate; a different name re-issues it.
        const pem = fs.readFileSync(path.join(TLS_TMP, 'tls.crt'), 'utf8');
        await inbound.start('mailer', { port: free, name: 'mail.qa.example' }, [free], nothing);
        assert.equal(fs.readFileSync(path.join(TLS_TMP, 'tls.crt'), 'utf8'), pem);
        const renamed = await inbound.start('mailer', { port: free, name: 'mx.other.example' }, [free], nothing);
        assert.equal(renamed.tls.subject, 'CN=mx.other.example');

        // A name that is not a host name is ignored, never sent in the banner.
        assert.equal(inbound._hostName('evil\r\n250 hi'), '');
        assert.equal(inbound._hostName('Mail.QA.Example.'), 'mail.qa.example');
    } finally {
        await inbound.stop('mailer');
    }
});
