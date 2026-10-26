/**
 * WordJS — the certificate screens' switches are booleans, and the renewal window is whole days.
 *
 * `staging`, `enabled` and `sslEnabled` were read by truthiness, so the string "false" turned staging or
 * automatic renewal ON, and `sslEnabled: 0` switched HTTPS off at the gateway without the main address
 * following it back to http (that path asks `sslEnabled === false`). Each route now accepts a real
 * boolean or nothing, and answers 400 otherwise; `renewBeforeDays` is a whole number from 1 to 60.
 *
 * MUTATION PROOF: put `!!staging` back in /auto-provision and the first test sees the CA reached with
 * staging on; drop the renewBeforeDays check and the window test stores 61.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const certManager = require('../core/cert-manager');
const configManager = require('../core/configManager');
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

/** Call a route with `stubbed` methods of `target` replaced by recorders. */
async function call(routePath: string, body: any, target: any, stubbed: string[]) {
    const originals: Record<string, any> = {};
    const reached: Record<string, any[][]> = {};
    for (const name of stubbed) {
        originals[name] = target[name];
        reached[name] = [];
        target[name] = (...args: any[]) => { reached[name].push(args); return name === 'saveConfig' ? true : Promise.resolve({ success: true, path: '/x' }); };
    }
    try {
        const { res, out } = fakeRes();
        await routeHandler(certsRouter, 'post', routePath)({ user: { id: 1 }, params: {}, query: {}, body }, res, () => {});
        return { out, reached };
    } finally {
        for (const name of stubbed) target[name] = originals[name];
    }
}

const NOT_BOOLEANS = ['false', 'true', 0, 1, 'yes', null, {}];

test('staging must be a boolean on every order route; "false" never reaches the CA as staging', async () => {
    const routes: Array<[string, string, any]> = [
        ['/auto-provision', 'provisionAutoHTTP', { domain: 'example.com', email: 'a@example.com' }],
        ['/dns-start', 'startDNSChallenge', { domain: 'example.com', email: 'a@example.com' }],
        ['/dns-finish', 'finishDNSChallenge', { step1Data: {}, email: 'a@example.com' }],
    ];
    for (const [route, method, body] of routes) {
        for (const staging of NOT_BOOLEANS) {
            const { out, reached } = await call(route, { ...body, staging }, certManager, [method]);
            assert.strictEqual(out.statusCode, 400, `${route} staging=${JSON.stringify(staging)}`);
            assert.strictEqual(reached[method].length, 0, `${route}: nothing was ordered`);
        }
        for (const [staging, expected] of [[false, false], [true, true], [undefined, false]] as const) {
            const { out, reached } = await call(route, { ...body, staging }, certManager, [method]);
            assert.strictEqual(out.statusCode, 200, `${route} staging=${String(staging)}: ${JSON.stringify(out.body)}`);
            const args = reached[method][0];
            assert.strictEqual(args[args.length - 1], expected, `${route} staging=${String(staging)}`);
        }
    }
});

test('sslEnabled must be a boolean: 0 or "false" changes nothing at the gateway', async () => {
    for (const sslEnabled of NOT_BOOLEANS) {
        const { out, reached } = await call('/config', { port: 3000, sslEnabled }, certManager, ['updateGatewayConfig', 'ensureGatewayCert']);
        assert.strictEqual(out.statusCode, 400, `sslEnabled=${JSON.stringify(sslEnabled)}`);
        assert.strictEqual(reached.updateGatewayConfig.length, 0);
        assert.strictEqual(reached.ensureGatewayCert.length, 0);
    }
});

test('acme-config: enabled and staging are booleans, renewBeforeDays is 1 to 60 whole days', async () => {
    const base = { email: 'a@example.com', domains: ['example.com'], challengeType: 'http-01', http01Port: null };
    for (const enabled of NOT_BOOLEANS) {
        const { out, reached } = await call('/acme-config', { ...base, enabled }, configManager, ['saveConfig']);
        assert.strictEqual(out.statusCode, 400, `enabled=${JSON.stringify(enabled)}`);
        assert.strictEqual(reached.saveConfig.length, 0, 'nothing was written');
    }
    for (const staging of NOT_BOOLEANS) {
        const { out } = await call('/acme-config', { ...base, enabled: false, staging }, configManager, ['saveConfig']);
        assert.strictEqual(out.statusCode, 400, `staging=${JSON.stringify(staging)}`);
    }
    for (const renewBeforeDays of [0, 61, 90, -5, 1.5, '30', 'x', true]) {
        const { out, reached } = await call('/acme-config', { ...base, enabled: false, renewBeforeDays }, configManager, ['saveConfig']);
        assert.strictEqual(out.statusCode, 400, `renewBeforeDays=${JSON.stringify(renewBeforeDays)}`);
        assert.strictEqual(reached.saveConfig.length, 0);
    }
    for (const [renewBeforeDays, stored] of [[1, 1], [60, 60], [undefined, 30], [null, 30]] as const) {
        const { out, reached } = await call('/acme-config', { ...base, enabled: false, staging: false, renewBeforeDays }, configManager, ['saveConfig']);
        assert.strictEqual(out.statusCode, 200, `renewBeforeDays=${String(renewBeforeDays)}: ${JSON.stringify(out.body)}`);
        const saved = reached.saveConfig[0][0].acme;
        assert.deepStrictEqual([saved.enabled, saved.staging, saved.renewBeforeDays], [false, false, stored]);
    }
});
