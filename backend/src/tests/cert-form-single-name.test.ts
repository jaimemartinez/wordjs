/**
 * WordJS — the single-name certificate form refuses what it cannot order, before any CA work.
 *
 * In production (v2.8.0) "example.com, www.example.com" typed into Admin → Security → SSL reached the CA
 * client, failed there as "Invalid domain" and came back as a generic "Certificate provisioning failed".
 * POST /system/certs/auto-provision and /dns-start now answer 400 with a `code` the form translates, and
 * say where several names go (the automatic-renewal settings, which take a list).
 *
 * MUTATION PROOF: drop the singleCertificateNameProblem call from /auto-provision: the list reaches
 * provisionAutoHTTP (the stub records it) and the 400 assertions fail.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const certManager = require('../core/cert-manager');
const certsRouter = require('../routes/certs');

function routeHandler(router: any, method: string, routePath: string): any {
    for (const layer of router.stack || []) {
        const r = layer.route;
        if (!r || r.path !== routePath || !r.methods || !r.methods[method]) continue;
        const stack = r.stack || [];
        return stack[stack.length - 1].handle;
    }
    throw new Error(`no ${method.toUpperCase()} ${routePath} in this router`);
}

function fakeRes() {
    const out: any = { statusCode: 200, body: undefined };
    const res: any = {
        status(c: number) { out.statusCode = c; return res; },
        json(b: any) { out.body = b; return res; },
    };
    return { res, out };
}

async function call(routePath: string, body: any, stubbed: string) {
    const original = certManager[stubbed];
    const reached: any[] = [];
    certManager[stubbed] = async (...args: any[]) => { reached.push(args); return { success: true, path: '/x' }; };
    try {
        const { res, out } = fakeRes();
        await routeHandler(certsRouter, 'post', routePath)({ user: { id: 1 }, params: {}, query: {}, body }, res, () => {});
        return { out, reached };
    } finally {
        certManager[stubbed] = original;
    }
}

test('a list typed into the single-name form is refused with cert_one_name, and the CA is never asked', async () => {
    for (const domain of ['example.com, www.example.com', 'example.com www.example.com', 'a.example.com;b.example.com']) {
        const { out, reached } = await call('/auto-provision', { domain, email: 'admin@example.com' }, 'provisionAutoHTTP');
        assert.strictEqual(out.statusCode, 400, domain);
        assert.strictEqual(out.body.code, 'cert_one_name', domain);
        assert.match(out.body.error, /Automatic Certificate Renewal/, 'it says where several names go');
        assert.strictEqual(reached.length, 0, 'nothing was sent to the CA');
    }
});

test('a non-name and a wildcard over HTTP-01 are refused with their own codes', async () => {
    const bad = await call('/auto-provision', { domain: 'exa mple', email: 'a@example.com' }, 'provisionAutoHTTP');
    assert.strictEqual(bad.out.body.code, 'cert_one_name');
    const junk = await call('/auto-provision', { domain: '../etc', email: 'a@example.com' }, 'provisionAutoHTTP');
    assert.deepStrictEqual([junk.out.statusCode, junk.out.body.code], [400, 'cert_invalid_domain']);
    const wild = await call('/auto-provision', { domain: '*.example.com', email: 'a@example.com' }, 'provisionAutoHTTP');
    assert.deepStrictEqual([wild.out.statusCode, wild.out.body.code], [400, 'cert_wildcard_needs_dns']);
});

test('one good name goes through; a list in `domains` (the multi-name order) is not affected', async () => {
    const one = await call('/auto-provision', { domain: ' Example.com ', email: 'a@example.com' }, 'provisionAutoHTTP');
    assert.strictEqual(one.out.statusCode, 200);
    assert.strictEqual(one.reached.length, 1);
    const many = await call('/auto-provision', { domains: ['example.com', 'www.example.com'], email: 'a@example.com' }, 'provisionAutoHTTP');
    assert.strictEqual(many.out.statusCode, 200);
    assert.deepStrictEqual(many.reached[0][0], ['example.com', 'www.example.com']);
});

test('the DNS-01 form takes a wildcard but not a list', async () => {
    const wild = await call('/dns-start', { domain: '*.example.com', email: 'a@example.com' }, 'startDNSChallenge');
    assert.strictEqual(wild.out.statusCode, 200);
    const list = await call('/dns-start', { domain: 'example.com,www.example.com', email: 'a@example.com' }, 'startDNSChallenge');
    assert.deepStrictEqual([list.out.statusCode, list.out.body.code], [400, 'cert_one_name']);
    assert.strictEqual(list.reached.length, 0);
});
