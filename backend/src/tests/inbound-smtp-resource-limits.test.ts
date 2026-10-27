/**
 * The host's inbound SMTP listener (core/inbound-smtp) bounds what unauthenticated senders can make it
 * hold: every in-progress message — its received bytes and the base64 copy handed to the plugin — is
 * reserved from one listener-wide byte budget and given back when the transaction ends, a message that
 * would exceed it gets a TEMPORARY 452 (the sender retries later), and one client address may hold only
 * a share of the connection slots (421 beyond it). Real smtp-server on a free local port, real nodemailer
 * and raw sockets as the senders.
 */
process.env.NODE_ENV = 'production';

const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');

const inbound = require('../core/inbound-smtp');
const OWNER = `wjs-smtp-limits-${process.pid}`;

after(async () => { try { await inbound.stop(OWNER); } catch { /* */ } });

function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

function send(port: number, text: string): Promise<{ ok: boolean; e?: any }> {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, connectionTimeout: 10000, socketTimeout: 30000 });
    return t.sendMail({ from: 'ext@outside.test', to: 'alice@acme.test', subject: 'big', text }).then(() => ({ ok: true }), (e: any) => ({ ok: false, e }));
}

/** The first line the server writes on a fresh connection (its greeting, or its refusal). */
function greeting(port: number): Promise<{ line: string; socket: any }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let buf = '';
        socket.on('data', (c: Buffer) => {
            buf += c.toString('utf8');
            const i = buf.indexOf('\n');
            if (i >= 0) resolve({ line: buf.slice(0, i).trim(), socket });
        });
        socket.on('error', reject);
    });
}

const until = async (cond: () => boolean, ms = 10000) => {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); }
};

test('the byte budget: reservations grow, refuse past the limit, and are released exactly once', () => {
    const budget = inbound._byteBudget(100);
    const a = budget.reserve();
    const b = budget.reserve();
    assert.equal(a.take(60), true);
    assert.equal(b.take(50), false, 'past the limit');
    assert.equal(b.take(40), true);
    assert.equal(budget.used, 100);
    a.release(); a.release();
    assert.equal(budget.used, 40, 'a second release gives nothing back twice');
    assert.equal(a.take(1), false, 'a released reservation takes nothing more');
    b.release();
    assert.equal(budget.used, 0);
});

test('messages held by the plugin count against one budget: the one that would exceed it gets 452, and the bytes come back', { timeout: 60000 }, async () => {
    const port = await freePort();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let dataCalls = 0;
    const invoke = async (phase: string) => {
        if (phase === 'data') { dataCalls++; if (dataCalls === 1) await gate; }
        return null;
    };
    // 1 MB messages: the budget's floor is three of them (one message plus its base64 copy fits, two do not).
    const st = await inbound.start(OWNER, { port, maxSize: 1024 * 1024, maxInflightBytes: 1 }, [port], invoke);
    assert.equal(st.ok, true, JSON.stringify(st));
    const body = ('a'.repeat(69) + '\n').repeat(Math.floor((930 * 1024) / 70));

    const first = send(port, body);                  // reaches the plugin and is held there
    await until(() => dataCalls === 1);
    const second = await send(port, body);           // arrives while the first holds its bytes
    assert.equal(second.ok, false, 'the second message must not be accepted while the budget is spent');
    assert.equal(second.e.responseCode, 452, second.e && second.e.message);
    assert.equal(dataCalls, 1, 'the refused message never reached the plugin');

    release();
    assert.equal((await first).ok, true);
    const third = await send(port, body);             // the first gave its bytes back
    assert.equal(third.ok, true, third.e && third.e.message);
    assert.equal(dataCalls, 2);
    await inbound.stop(OWNER);
});

test('one client address holds at most its share of the connection slots (421 beyond it)', { timeout: 30000 }, async () => {
    const port = await freePort();
    const st = await inbound.start(OWNER, { port, maxClients: 50, maxClientsPerIp: 2 }, [port], async () => null);
    assert.equal(st.ok, true, JSON.stringify(st));
    const a = await greeting(port);
    const b = await greeting(port);
    assert.match(a.line, /^220 /);
    assert.match(b.line, /^220 /);
    const c = await greeting(port);
    assert.match(c.line, /^421 /, c.line);
    // A slot comes back when its connection closes.
    a.socket.destroy();
    await new Promise((r) => setTimeout(r, 300));
    const d = await greeting(port);
    assert.match(d.line, /^220 /, d.line);
    for (const s of [b.socket, c.socket, d.socket]) s.destroy();
    await inbound.stop(OWNER);
});

test('the listener does no reverse DNS per connection, and bounds its shutdown and unauthenticated commands', { timeout: 30000 }, async () => {
    const lib = require('smtp-server');
    const Real = lib.SMTPServer;
    let seen: any = null;
    lib.SMTPServer = class extends Real { constructor(opts: any) { seen = opts; super(opts); } };
    const port = await freePort();
    const sessions: any[] = [];
    try {
        const st = await inbound.start(OWNER, { port }, [port], async (phase: string, args: any[]) => { if (phase === 'connect') sessions.push(args[0]); return null; });
        assert.equal(st.ok, true, JSON.stringify(st));
    } finally {
        lib.SMTPServer = Real;
    }
    assert.equal(seen.disableReverseLookup, true);
    assert.ok(seen.closeTimeout > 0 && seen.closeTimeout <= 10000, String(seen.closeTimeout));
    assert.ok(seen.maxAllowedUnauthenticatedCommands > 0 && seen.maxAllowedUnauthenticatedCommands <= 50, String(seen.maxAllowedUnauthenticatedCommands));
    // Observable too: the client's host name is its address literal, not a PTR answer.
    const g = await greeting(port);
    assert.match(g.line, /^220 /);
    await until(() => sessions.length === 1);
    assert.match(String(sessions[0].clientHostname || ''), /^\[[0-9a-f.:]+\]$/i, String(sessions[0].clientHostname));
    g.socket.destroy();
    await inbound.stop(OWNER);
});

// The addresses the host reports with the listener status (a sandboxed plugin cannot list interfaces).
// A mail plugin also sends over IPv6, so the global IPv6 addresses travel with the IPv4 ones.
test('the listener status names the public IPv4 and the global IPv6 addresses of this node', () => {
    const got = inbound._nodeAddresses({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
        eth0: [
            { address: '93.184.215.14', family: 'IPv4', internal: false },
            { address: '10.0.0.5', family: 'IPv4', internal: false },
            { address: '2606:2800:021F:cb07:0000:0000:0000:0025', family: 'IPv6', internal: false },
            { address: 'fe80::1%eth0', family: 'IPv6', internal: false },
            { address: 'fd00::5', family: 'IPv6', internal: false },
            { address: '2001:db8::1', family: 'IPv6', internal: false },
        ],
    });
    assert.deepStrictEqual(got, { public: ['93.184.215.14'], private: ['10.0.0.5'], public6: ['2606:2800:21f:cb07::25'] });
});
