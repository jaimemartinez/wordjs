'use strict';
/**
 * The TLS switch on the REAL gateway process (support/gateway-process.js), primary + workers.
 *
 *  · FALLOS 108: `{ enabled: false, key, cert }` serves plain HTTP (workers used to serve HTTPS as soon
 *    as a pair was stored, whatever the switch said);
 *  · FALLOS 111: a /config-update that only carries the site address keeps `ssl: false` off (it became
 *    `{}`, read as "on, auto-generate");
 *  · QA X1-02: /config-update { sslEnabled: false } turns HTTPS off with a certificate stored;
 *  · FALLOS 114: the gateway does not rewrite an address that is not its own listener (a tunnel or proxy
 *    port) when its TLS switch changes;
 *  · QA X1-03: /info reports what the workers serve; /edge-info gives a frontend node what it must follow;
 *  · a certificate upload stores the pair without flipping the switch.
 *
 * MUTATION PROOF: restore the worker's key/cert-before-switch order in src/index.js — the first test
 * gets a TLS answer on the plain port; restore `if (!config.ssl) config.ssl = {}` in /config-update —
 * the second test finds `ssl: {}` in the file.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const harness = require('./support/gateway-process');

const NAV = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';

function internal(gw, ca, identity, method, reqPath, body) {
    return harness.request({
        port: gw.internalPort,
        path: reqPath,
        method,
        secure: true,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        ca: ca.pem,
        key: identity.key,
        cert: identity.cert,
    });
}

const readConfig = (gw) => JSON.parse(fs.readFileSync(path.join(gw.dir, 'gateway-config.json'), 'utf8'));

async function servesHttp(gw) {
    const r = await harness.request({ port: gw.port, path: '/healthz' });
    return r.status === 200;
}
async function servesHttps(gw) {
    const r = await harness.request({ port: gw.port, path: '/healthz', secure: true });
    return r.status === 200;
}

describe('the real gateway: a stored certificate with the switch OFF serves HTTP (108)', () => {
    let up;
    let gw;
    let ca;
    let backendId;
    let frontendId;
    before(async () => {
        up = await harness.startEchoUpstream('frontend');
        ca = harness.makeCa();
        backendId = harness.makeLeaf(ca, 'backend');
        frontendId = harness.makeLeaf(ca, 'frontend');
        gw = await harness.bootGateway({
            storedCert: true,
            cluster: ca,
            upstreams: { frontend: up.port, backend: await harness.freePort() },
            extraConfig: { siteUrl: 'http://sep.example.test:3303' },
        });
    });
    after(async () => {
        if (gw) await gw.stop();
        if (up) await up.close();
    });

    it('serves plain HTTP and reports it', async () => {
        assert.ok(await servesHttp(gw), gw.output());
        assert.ok(!(await servesHttps(gw)), 'no TLS on the public port');
        await harness.eventually('every worker reported its transport', async () => {
            const r = await internal(gw, ca, backendId, 'GET', '/info');
            return r.status === 200 && JSON.parse(r.body).serving === 'http';
        });
        const info = JSON.parse((await internal(gw, ca, backendId, 'GET', '/info')).body);
        assert.strictEqual(info.sslEnabled, false);
        assert.strictEqual(info.serving, 'http');
    });

    it('turning HTTPS on serves the stored certificate, and the tunnel address is left alone', async () => {
        const r = await internal(gw, ca, backendId, 'POST', '/config-update', { sslEnabled: true });
        assert.strictEqual(r.status, 200, r.body);
        assert.strictEqual(JSON.parse(r.body).siteUrl, 'http://sep.example.test:3303', 'not rewritten to the gateway port (114)');
        await harness.eventually('workers reloaded on HTTPS', () => servesHttps(gw), 15000);
        await harness.eventually('workers report https', async () => JSON.parse((await internal(gw, ca, backendId, 'GET', '/info')).body).serving === 'https', 15000);
    });

    it('turning it off from the panel works with the certificate still stored (X1-02)', async () => {
        const r = await internal(gw, ca, backendId, 'POST', '/config-update', { sslEnabled: false });
        assert.strictEqual(r.status, 200, r.body);
        await harness.eventually('workers reloaded on HTTP', () => servesHttp(gw), 15000);
        const cfg = readConfig(gw);
        assert.strictEqual(cfg.ssl.enabled, false);
        assert.ok(cfg.ssl.cert, 'the certificate stays stored');
        assert.strictEqual(cfg.siteUrl, 'http://sep.example.test:3303');
    });

    it('a certificate upload stores the pair and keeps the switch off', async () => {
        const leaf = harness.makeLeaf(null, 'localhost');
        const r = await internal(gw, ca, backendId, 'POST', '/cert-upload', { key: leaf.key, cert: leaf.cert });
        assert.strictEqual(r.status, 200, r.body);
        await harness.sleep(1500);
        await harness.eventually('still HTTP after the reload', () => servesHttp(gw), 15000);
        const cfg = readConfig(gw);
        assert.strictEqual(cfg.ssl.enabled, false);
        assert.match(cfg.ssl.cert, /imported/);
    });

    it('/edge-info answers a frontend node with the address and the protocol served', async () => {
        await harness.eventually('workers report http', async () => JSON.parse((await internal(gw, ca, frontendId, 'GET', '/edge-info')).body).serving === 'http', 15000);
        const edge = JSON.parse((await internal(gw, ca, frontendId, 'GET', '/edge-info')).body);
        assert.strictEqual(edge.siteUrl, 'http://sep.example.test:3303');
        assert.strictEqual(edge.gatewayPort, gw.port);
        assert.strictEqual(edge.sslEnabled, false);
    });

    it('GET /cluster names the gateway itself and when each node\'s certificate expires (X1-08)', async () => {
        const reg = await internal(gw, ca, backendId, 'POST', '/register', { url: 'https://127.0.0.1:4999', routes: ['/api'] });
        assert.strictEqual(reg.status, 200, reg.body);
        const r = await internal(gw, ca, backendId, 'GET', '/cluster');
        assert.strictEqual(r.status, 200, r.body);
        const body = JSON.parse(r.body);
        assert.ok(body.gateway, 'the gateway is listed');
        assert.match(String(body.gateway.certExpiresAt), /^\d{4}-\d\d-\d\dT/);
        assert.strictEqual(body.gateway.serving, 'http');
        const node = body.nodes.find((n) => n.url === 'https://127.0.0.1:4999');
        assert.ok(node, JSON.stringify(body.nodes));
        assert.match(String(node.certExpiresAt), /^\d{4}-\d\d-\d\dT/);
    });

    it('a browser asking for a page while the frontend is down gets an HTML page (X1-04)', async () => {
        await up.close();
        const r = await harness.request({ port: gw.port, path: '/', headers: { host: 'localhost', accept: NAV } });
        assert.strictEqual(r.status, 503, r.body);
        assert.match(String(r.headers['content-type']), /text\/html/);
        assert.match(r.body, /back in a moment/i);
        up = null;
    });
});

describe('the real gateway: a site-address push keeps `ssl: false` off (111)', () => {
    let up;
    let gw;
    let ca;
    let backendId;
    before(async () => {
        up = await harness.startEchoUpstream('frontend');
        ca = harness.makeCa();
        backendId = harness.makeLeaf(ca, 'backend');
        gw = await harness.bootGateway({
            ssl: false,
            cluster: ca,
            upstreams: { frontend: up.port, backend: await harness.freePort() },
            extraConfig: { siteUrl: 'http://old.example.test:3303' },
        });
    });
    after(async () => {
        if (gw) await gw.stop();
        if (up) await up.close();
    });

    it('stays HTTP, and the file keeps the switch off', async () => {
        const r = await internal(gw, ca, backendId, 'POST', '/config-update', { siteUrl: 'http://new.example.test:3303' });
        assert.strictEqual(r.status, 200, r.body);
        const cfg = readConfig(gw);
        assert.deepStrictEqual(cfg.ssl, { enabled: false });
        assert.strictEqual(cfg.siteUrl, 'http://new.example.test:3303');
        await harness.sleep(1500);
        await harness.eventually('HTTP after the reload', () => servesHttp(gw), 15000);
        assert.ok(!fs.existsSync(path.join(gw.dir, 'ssl-auto.key')), 'no auto pair generated while off');
    });

    it('a control-plane write keeps what another writer put in the file after boot (the install wizard)', async () => {
        const file = path.join(gw.dir, 'gateway-config.json');
        const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
        onDisk.installedMarker = 'written-by-the-wizard';
        onDisk.siteUrl = 'http://wizard.example.test:3303';
        fs.writeFileSync(file, JSON.stringify(onDisk, null, 2));
        const leaf = harness.makeLeaf(null, 'localhost');
        const r = await internal(gw, ca, backendId, 'POST', '/cert-upload', { key: leaf.key, cert: leaf.cert });
        assert.strictEqual(r.status, 200, r.body);
        const after = readConfig(gw);
        assert.strictEqual(after.installedMarker, 'written-by-the-wizard');
        assert.strictEqual(after.siteUrl, 'http://wizard.example.test:3303');
        assert.ok(after.gatewaySecret, 'the secret is kept');
        assert.strictEqual(after.ssl.enabled, false);
        assert.strictEqual(after.sslAuto, undefined, 'the runtime flag is never written');
    });
});
