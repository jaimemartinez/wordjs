/**
 * cache.onBusReady: a handler runs on EVERY (re)connect of the cluster-bus subscriber, not only the first.
 *
 * Redis pub/sub is fire-and-forget: whatever is published while a node's subscriber is disconnected (a
 * Redis restart, a network blip, the boot window before the first SUBSCRIBE) is simply not delivered.
 * core/coherence.ts registers a plugin-policy re-sync here so a node catches up the moment its bus comes
 * back instead of running on stale grants until the next periodic tick. This drives the REAL ioredis
 * subscriber against a minimal RESP server on loopback, drops the connection, and counts the handler.
 *
 * The second case is the boot window: cache.ts's own subscription connects the bus when the module loads,
 * so by the time core/coherence.ts subscribes and registers, the first 'ready' is long gone. A handler
 * registered on an already-ready bus must still run — once its consumer's SUBSCRIBE is acknowledged.
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');

type Conn = { sock: any; buf: Buffer };
const conns = new Set<Conn>();
const subscribed: string[] = [];
const acked = new Map<string, number>();
const SLOW_ACK_CHANNEL = 'wordjs:late-consumer';

/** Parse every complete RESP array command at the head of `c.buf`; return them and keep the rest. */
function takeCommands(c: Conn): string[][] {
    const out: string[][] = [];
    for (;;) {
        const s = c.buf.toString('latin1');
        if (!s.startsWith('*')) { c.buf = Buffer.alloc(0); return out; }
        let i = s.indexOf('\r\n');
        if (i < 0) return out;
        const n = Number(s.slice(1, i));
        let pos = i + 2;
        const args: string[] = [];
        for (let k = 0; k < n; k++) {
            if (s[pos] !== '$') return out;
            i = s.indexOf('\r\n', pos);
            if (i < 0) return out;
            const len = Number(s.slice(pos + 1, i));
            if (s.length < i + 2 + len + 2) return out;
            args.push(s.slice(i + 2, i + 2 + len));
            pos = i + 2 + len + 2;
        }
        c.buf = c.buf.subarray(pos);
        out.push(args);
    }
}

const bulk = (v: string) => `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
const server = net.createServer((sock: any) => {
    const c: Conn = { sock, buf: Buffer.alloc(0) };
    conns.add(c);
    sock.on('close', () => conns.delete(c));
    sock.on('error', () => { /* */ });
    sock.on('data', (d: Buffer) => {
        c.buf = Buffer.concat([c.buf, d]);
        for (const [cmd, ...args] of takeCommands(c)) {
            const name = String(cmd).toLowerCase();
            if (name === 'info') sock.write(bulk('# Server\r\nredis_version:7.2.0\r\nloading:0\r\n'));
            else if (name === 'subscribe') {
                args.forEach((ch, idx) => {
                    subscribed.push(ch);
                    const ack = () => { acked.set(ch, Date.now()); sock.write(`*3\r\n${bulk('subscribe')}${bulk(ch)}:${idx + 1}\r\n`); };
                    // One channel is confirmed late, to see whether a handler waits for its consumer's SUBSCRIBE.
                    if (ch === SLOW_ACK_CHANNEL) setTimeout(ack, 400); else ack();
                });
            } else if (name === 'ping') sock.write('+PONG\r\n');
            else if (name === 'quit') { sock.write('+OK\r\n'); sock.end(); }
            else sock.write('+OK\r\n');
        }
    });
});

let cache: any = null;
after(async () => {
    try { if (cache) await cache.closeAll(); } catch { /* */ }
    for (const c of conns) { try { c.sock.destroy(); } catch { /* */ } }
    await new Promise<void>((r) => server.close(() => r()));
});

async function until(pred: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
    return pred();
}

test('a bus-ready handler runs when the subscriber connects AND again after every reconnect', async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const config = require('../config/app');
    config.redis = { enabled: true, host: '127.0.0.1', port: server.address().port, db: 0, prefix: 'wordjs:' };
    cache = require('../core/cache');

    let calls = 0;
    cache.onBusReady(() => { calls += 1; });
    cache.subscribe('wordjs:option-changed', () => { /* */ });

    assert.ok(await until(() => calls >= 1, 10000), 'the handler did not run on the first connect');
    assert.ok(await until(() => subscribed.includes('wordjs:option-changed'), 5000), 'precondition: the channel was subscribed');
    const first = calls;

    // The bus drops: every connection to "Redis" is cut. ioredis reconnects and re-subscribes on its own.
    subscribed.length = 0;
    for (const c of conns) c.sock.destroy();
    assert.ok(await until(() => calls > first, 10000), 'the handler did not run again after the subscriber reconnected');
    assert.ok(await until(() => subscribed.includes('wordjs:option-changed'), 5000), 'ioredis re-subscribed the channel');
});

test('a handler registered on a bus that is ALREADY ready runs once, after its consumer\'s SUBSCRIBE is confirmed', async () => {
    // Precondition: the bus has been up for a while (the case above left it connected and subscribed).
    assert.ok(cache, 'precondition: the previous case loaded the cache module');
    assert.ok(await until(() => subscribed.includes('wordjs:option-changed'), 5000), 'precondition: the bus is up');
    await new Promise((r) => setTimeout(r, 200));
    const reconnectsBefore = conns.size;

    // What core/coherence.ts does at boot: subscribe its channels, then register its catch-up.
    let ranAt = 0;
    let runs = 0;
    cache.subscribe(SLOW_ACK_CHANNEL, () => { /* */ });
    cache.onBusReady(() => { runs += 1; if (!ranAt) ranAt = Date.now(); });

    assert.ok(await until(() => ranAt > 0, 5000),
        'a handler registered after the bus became ready never ran: the boot window is left to the periodic timer');
    const ackAt = acked.get(SLOW_ACK_CHANNEL) || 0;
    assert.ok(ackAt > 0 && ranAt >= ackAt,
        `the handler ran before its consumer's SUBSCRIBE was confirmed (ran ${ranAt}, confirmed ${ackAt}): a publish in between would still be missed`);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(runs, 1, 'it ran more than once without a reconnect');
    assert.strictEqual(conns.size, reconnectsBefore, 'control: no reconnect was needed for it to run');
});
