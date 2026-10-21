/**
 * DEPLOYMENT PAPER CUTS — the backend's own port, the proxy nobody trusts, the install banner, and the
 * CLI run as root in somebody else's install.
 *
 *   · PORT was ignored by the backend (only wordjs-config.json's `port` counted), in split mode too.
 *     In the monolith PORT is the PUBLIC port monolith.js listens on, so there it must stay ignored.
 *   · Behind nginx with no trustProxy every visitor is 127.0.0.1. Guessing would reopen the forgery
 *     core/client-ip closes, so the first such request logs one warning naming the setting.
 *   · The install banner's hint was printed as "WORDJS_PRINT_INSTALL_TOKEN=[redacted]": the console
 *     bridge's scrubber reads any `…TOKEN=<value>` as a credential. Every fixed banner line must reach
 *     the log as written.
 *   · `sudo npm run network -- enable` in an install owned by the service account left root-owned files
 *     the service could not write; the CLI now refuses and names the command to run instead.
 *
 * MUTATION PROOF: drop the PORT branch of resolveBackendPort and "PORT wins in split mode" fails; drop
 * its WORDJS_EMBEDDED guard and "the monolith ignores PORT" fails; put `WORDJS_PRINT_INSTALL_TOKEN=1` back
 * in the banner and the scrubber test fails; make rootWriteProblem return null and the refusal test fails.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('the backend listen port', () => {
    const { resolveBackendPort } = require('../config/app');
    const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
        const saved: Record<string, string | undefined> = {};
        for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
        try { fn(); } finally {
            for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        }
    };

    it('PORT wins in split mode, then the config file, then 4000', () => {
        withEnv({ PORT: '4123', WORDJS_EMBEDDED: undefined }, () => assert.strictEqual(resolveBackendPort(4100), 4123));
        withEnv({ PORT: undefined, WORDJS_EMBEDDED: undefined }, () => assert.strictEqual(resolveBackendPort(4100), 4100));
        withEnv({ PORT: undefined, WORDJS_EMBEDDED: undefined }, () => assert.strictEqual(resolveBackendPort(undefined), 4000));
    });

    it('an unusable value falls through instead of breaking the listen', () => {
        withEnv({ PORT: 'abc', WORDJS_EMBEDDED: undefined }, () => assert.strictEqual(resolveBackendPort(4100), 4100));
        withEnv({ PORT: '70000', WORDJS_EMBEDDED: undefined }, () => assert.strictEqual(resolveBackendPort('x'), 4000));
    });

    it('the monolith ignores PORT: it is the public port there, not the backend\'s', () => {
        withEnv({ PORT: '3000', WORDJS_EMBEDDED: '1' }, () => assert.strictEqual(resolveBackendPort(4000), 4000));
    });

    it('the monolith takes the loopback port it was started with (WORDJS_LOOPBACK_PORT), QA M1-24', () => {
        withEnv({ PORT: '3390', WORDJS_EMBEDDED: '1', WORDJS_LOOPBACK_PORT: '4390' }, () => assert.strictEqual(resolveBackendPort(4000), 4390));
        withEnv({ PORT: '3390', WORDJS_EMBEDDED: '1', WORDJS_LOOPBACK_PORT: 'nope' }, () => assert.strictEqual(resolveBackendPort(4100), 4100));
        // Split mode never reads it: PORT is the backend's own port there.
        withEnv({ PORT: undefined, WORDJS_EMBEDDED: undefined, WORDJS_LOOPBACK_PORT: '4390' }, () => assert.strictEqual(resolveBackendPort(4100), 4100));
    });
});

describe('a local reverse proxy nothing trusts', () => {
    const { untrustedProxyWarning } = require('../core/client-ip');
    const run = (mw: any, req: any) => new Promise<void>((resolve) => mw(req, {}, resolve));
    const req = (peer: string, xff?: string) => ({ ip: peer, socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });

    it('warns once, naming the setting, when the client resolves to loopback but a proxy relayed a real one', async () => {
        const lines: string[] = [];
        const mw = untrustedProxyWarning({ warn: (m: string) => lines.push(m) });
        await run(mw, req('127.0.0.1'));                       // the frontend's SSR
        await run(mw, req('127.0.0.1', '127.0.0.1'));          // a local client through a local proxy
        await run(mw, req('198.51.100.4', '198.51.100.4'));    // the gateway relayed the real client
        assert.strictEqual(lines.length, 0);
        await run(mw, req('127.0.0.1', '198.51.100.4, 127.0.0.1'));
        await run(mw, req('127.0.0.1', '198.51.100.5'));
        assert.strictEqual(lines.length, 1);
        assert.match(lines[0], /trustProxy/);
    });
});

describe('the install banner reaches the log as written', () => {
    const { scrubSecrets } = require('../core/logger');

    it('no fixed line of the banner is mistaken for a credential', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'install-token.ts'), 'utf8');
        const literals = [...src.matchAll(/console\.log\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]);
        assert.ok(literals.some((l) => l.includes('WORDJS_PRINT_INSTALL_TOKEN')), 'the hint is still in the banner');
        for (const line of literals) assert.strictEqual(scrubSecrets(line), line, `scrubbed: ${line}`);
    });
});

describe('the CLI as root in an install another account owns', () => {
    const owner = require('../../scripts/install-owner');
    const passwd = 'root:x:0:0:root:/root:/bin/bash\nwordjs:x:998:998::/nonexistent:/usr/sbin/nologin\n';
    const opts = (uid: number, over: any = {}) => ({ getuid: () => uid, env: {}, stat: () => ({ uid: 998, gid: 998 }), passwd, ...over });

    it('refuses as root and names the command to run as the owner', () => {
        const hint = owner.scriptHint('/srv/site/backend/scripts/network.js', ['enable', '--admin', 'ana']);
        const problem = owner.rootWriteProblem('/srv/site/backend', hint, opts(0));
        assert.ok(problem);
        assert.match(problem, /belongs to 'wordjs'/);
        assert.match(problem, /sudo -u wordjs node \S*network\.js'? enable --admin ana/);
    });

    it('lets the owner, another user, an install root owns, and WORDJS_ALLOW_ROOT=1 through', () => {
        assert.strictEqual(owner.rootWriteProblem('/srv/site/backend', '', opts(998)), null);
        assert.strictEqual(owner.rootWriteProblem('/srv/site/backend', '', opts(0, { stat: () => ({ uid: 0, gid: 0 }) })), null);
        assert.strictEqual(owner.rootWriteProblem('/srv/site/backend', '', opts(0, { env: { WORDJS_ALLOW_ROOT: '1' } })), null);
        assert.strictEqual(owner.rootWriteProblem('/srv/site/backend', '', opts(0, { getuid: null })), null, 'no getuid: not POSIX');
    });

    it('an account without a passwd entry is named by its uid', () => {
        assert.strictEqual(owner.accountName(1234, passwd), '1234');
    });

    it('arguments are quoted for a POSIX shell', () => {
        assert.match(owner.scriptHint('/x/s.js', ["it's"]), / 'it'\\''s'$/);
    });
});
