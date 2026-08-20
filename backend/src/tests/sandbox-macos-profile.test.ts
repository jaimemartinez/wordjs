/**
 * Unit tests for the PURE parts of core/sandbox-macos.ts — the SBPL profile builder, the SBPL string
 * escaper and the sandbox-exec argv builder.
 *
 * These run on EVERY platform on purpose. The Seatbelt layer itself can only be certified by
 * probeSeatbelt() on real macOS hardware (it spawns a child and requires it to be refused), but the part
 * that turns caller-supplied paths into profile TEXT is plain string work, and it is the part where a
 * mistake is silent: an over-broad or injected profile is accepted by the kernel and confines nothing.
 * So the text is pinned here, off-macOS, where it can be pinned.
 *
 * The injection cases are the point of this file. SBPL is a Lisp-like text format and the profile is
 * assembled by concatenation, so an unescaped path is an injection vector with the same shape as SQL
 * injection — and because SBPL resolves each operation to its LAST matching rule, a single injected
 * `(allow default)` silently overrides the `(deny default)` at the top of the profile.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    buildSeatbeltProfile,
    seatbeltArgs,
    sbplPath,
    probeSeatbelt,
    SEATBELT_BIN,
    SEATBELT_BOOTSTRAP_FILE,
    auditProfile,
    __probeSrc,
} = require('../core/sandbox-macos');

const APP_ROOT = '/srv/wordjs/backend';
const NODE = '/usr/local/bin/node-that-does-not-exist'; // synthetic: keeps realpathSync a no-op, so the output is deterministic on every host

function build(over: Record<string, any> = {}): string {
    return buildSeatbeltProfile({ appRoot: APP_ROOT, nodePath: NODE, writableDirs: [], denyNetwork: false, ...over });
}

describe('SBPL profile skeleton', () => {
    test('opens with (version 1) and denies by default, in that order', () => {
        const p = build();
        const version = p.indexOf('(version 1)');
        const denyDefault = p.indexOf('(deny default)');
        assert.strictEqual(version, 0, 'the profile must START with (version 1)');
        assert.ok(denyDefault > version, '(deny default) must follow the version line');
        // Last matching rule wins in SBPL: anything that re-broadened the default would have to appear
        // after (deny default), and nothing ever should.
        assert.ok(!/\(allow default\)/.test(p), 'a profile must never contain (allow default)');
    });

    test('everything the builder writes itself is ASCII', () => {
        // The profile text crosses an argv boundary into a parser this module has never been able to run.
        // Non-ASCII bytes in OUR OWN text buy nothing and risk everything, so the generated comments and
        // rules stay ASCII; only a caller-supplied PATH may carry UTF-8, because that is what the macOS
        // filesystem actually stores. (Same lesson as the PowerShell bridge, which PS 5.1 reads as ANSI.)
        const p = build({ writableDirs: ['/srv/wordjs/backend/uploads'], denyNetwork: true });
        // eslint-disable-next-line no-control-regex
        const nonAscii = p.match(/[^\x09\x0a\x20-\x7e]/g);
        assert.strictEqual(nonAscii, null, `generated profile must be ASCII, found ${JSON.stringify(nonAscii)}`);
    });

    test('never grants blanket exec, blanket mach-lookup, or inbound network', () => {
        const p = build();
        assert.ok(/\(deny process-exec\*\)/.test(p), 'exec must be denied before the Node carve-out');
        assert.ok(!/\(allow process-exec\*\)/.test(p), 'exec must never be granted unrestricted');
        // A blanket mach-lookup reaches launchd (job submission = escape) and WindowServer.
        assert.ok(!/\(allow mach-lookup\)/.test(p), 'mach-lookup must always carry a global-name allowlist');
        assert.ok(!/network-bind/.test(p), 'a plugin is never granted the ability to listen');
    });

    test('exec is carved out for the Node binary only', () => {
        const p = build();
        assert.ok(p.includes(`(allow process-exec (literal "${NODE}"))`), 'the Node binary must be exec-able');
        // and it must come AFTER the deny, or the deny would win.
        assert.ok(p.indexOf('(deny process-exec*)') < p.indexOf('(allow process-exec (literal'),
            'deny must precede the carve-out — SBPL resolves to the LAST matching rule');
    });

    test('the legacy builder fallback grants appRoot read-only', () => {
        const p = build();
        assert.ok(p.includes(`(allow file-read* (subpath "${APP_ROOT}"))`), 'the child must be able to read the app root');
        assert.ok(!p.includes(`file-write* (subpath "${APP_ROOT}")`), 'the app root must never be writable as a whole');
    });

    test('the production spelling reads only core, dependencies and this plugin — never appRoot', () => {
        const roots = [`${APP_ROOT}/dist/core`, `${APP_ROOT}/node_modules`, `${APP_ROOT}/plugins/acme`];
        const p = build({ readOnlyDirs: roots });
        for (const root of roots) assert.ok(p.includes(`(allow file-read* (subpath "${root}"))`));
        assert.ok(!p.includes(`(allow file-read* (subpath "${APP_ROOT}"))`), 'config, DB and sibling plugins must stay unreadable');
        assert.ok(!p.includes(`${APP_ROOT}/wordjs-config.json`));
    });

    test('sysctl is an exact-name allowlist with no process argv/environment aperture', () => {
        const p = build({ readOnlyDirs: [`${APP_ROOT}/dist/core`] });
        assert.ok(p.includes('(sysctl-name "hw.ncpu")'));
        assert.ok(p.includes('(sysctl-name "kern.osrelease")'));
        assert.ok(!/^\(allow sysctl-read\)$/m.test(p), 'blanket sysctl-read exposes KERN_PROCARGS2');
        assert.ok(!/kern\.procargs/i.test(p.replace(/^;;.*$/gm, '')), 'the process-argument MIB must be absent from rules');
        assert.deepStrictEqual(auditProfile(p), []);
        assert.ok(auditProfile(`${p}\n(allow sysctl-read)`).some((x: string) => x.includes('blanket')));
    });

    test('the only executable identity is one-shot and deleted before plugin code is released', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../core/sandbox-macos.ts'), 'utf8');
        const bootstrap = fs.readFileSync(SEATBELT_BOOTSTRAP_FILE, 'utf8');
        assert.match(source, /prepareSeatbeltRuntime/);
        assert.match(source, /const probeCodeRoots = \[pathm\.dirname\(SEATBELT_BOOTSTRAP_FILE\)\]/,
            'the real Seatbelt probe must be able to read the preload it launches with');
        assert.strictEqual((source.match(/readOnlyDirs: probeCodeRoots/g) || []).length, 2,
            'both network-policy probe profiles must carry the preload read root');
        assert.match(source, /disposeSeatbeltRuntime\(runtime\)[\s\S]*existsSync\(runtime\.exe\)/,
            'the host must unlink and verify the executable before sending the release marker');
        assert.match(bootstrap, /writeSync\(readyFd[\s\S]*readSync\(releaseFd/,
            'the preload must block synchronously before the plugin worker can load');
        assert.match(bootstrap, /process\.exit\(126\)/, 'a broken handshake must fail closed');
    });
});

describe('writable zones', () => {
    test('grants exactly the zones passed in, and nothing else', () => {
        const zones = ['/srv/wordjs/backend/uploads', '/srv/wordjs/backend/plugins/acme'];
        const p = build({ writableDirs: zones });
        for (const z of zones) {
            assert.ok(p.includes(`(allow file-read* file-write* (subpath "${z}"))`), `${z} must be writable`);
        }
        // A zone the caller did NOT pass must not appear ANYWHERE in the profile — not as a write grant,
        // not as a stray read grant, not in a comment. io-guard's write zones are the single declaration;
        // this module must never restate or widen them.
        const notPassed = '/srv/wordjs/backend/data';
        assert.ok(!p.includes(notPassed), 'a directory outside the caller-supplied list must never appear');
        assert.ok(!p.includes('/Users'), 'the builder must not invent home-directory grants');
        assert.ok(!p.includes('(subpath "/")'), 'the builder must never grant the whole filesystem');
    });

    test('an empty zone list grants no writes at all', () => {
        const p = build({ writableDirs: [] });
        assert.ok(!/file-write\* \(subpath/.test(p), 'no subpath write grants when no zones were passed');
        // /dev/null is the one write grant that is not a zone, and it is a literal, not a subpath.
        assert.ok(p.includes('(allow file-read* file-write* (literal "/dev/null"))'), '/dev/null stays writable');
    });

    test('duplicate zones collapse', () => {
        const p = build({ writableDirs: ['/srv/z', '/srv/z', '/srv/z/'] });
        const hits = p.split('(allow file-read* file-write* (subpath "/srv/z"))').length - 1;
        assert.strictEqual(hits, 1, 'the same zone (with or without a trailing slash) must be emitted once');
    });
});

describe('network policy', () => {
    test('denyNetwork emits an explicit (deny network*) and no outbound grant', () => {
        const p = build({ denyNetwork: true });
        assert.ok(/^\(deny network\*\)$/m.test(p), 'the native network denial must be stated explicitly');
        assert.ok(!/\(allow network-outbound\)/.test(p), 'a net-denied plugin must have no outbound grant');
        assert.ok(!/resolv\.conf/.test(p), 'a net-denied plugin has no reason to read DNS configuration');
    });

    test('a network-granted plugin gets outbound and DNS, and still no inbound', () => {
        const p = build({ denyNetwork: false });
        assert.ok(/\(allow network-outbound\)/.test(p), 'a network-granted plugin must be able to connect out');
        assert.ok(!/\(deny network\*\)/.test(p), 'the blanket network denial must not be emitted here');
        assert.ok(/resolv\.conf/.test(p), 'DNS configuration must be readable so getaddrinfo works');
        assert.ok(!/network-bind|network-inbound/.test(p), 'inbound is never granted, grant or no grant');
    });
});

describe('SBPL injection — a path must never be able to break out of its string', () => {
    test('a quote-bearing path is REJECTED, so the payload never reaches the profile at all', () => {
        // The classic break-out: close our string, append a rule, reopen a string so the rest still parses.
        // Because SBPL resolves each operation to its LAST matching rule, the appended (allow default)
        // would override the (deny default) at the top and the profile would confine nothing.
        //
        // The module REJECTS rather than escapes here. Escaping to \" is the textbook answer, but this
        // module has never run against a real Sandbox-framework parser, and if that guess were wrong the
        // escape would disguise the payload instead of neutralising it. So the assertion is the strong
        // one: the payload text is not present in the profile in ANY form, inert or otherwise.
        const evil = '/srv/evil") (allow default) (subpath "/';
        const p = build({ writableDirs: [evil] });
        assert.ok(!p.includes('(allow default)'), 'the injected rule must not appear in the profile at all');
        assert.ok(!p.includes('/srv/evil'), 'a quote-bearing zone must be dropped entirely, not escaped');
        assert.ok(/REJECTED as unrepresentable/.test(p), 'the drop must be recorded in the profile');
        assert.ok(/\(deny default\)/.test(p), 'and the profile is still a deny-by-default profile');
    });

    test('a newline-bearing path is REJECTED outright, not escaped-and-hoped', () => {
        // A newline inside an SBPL literal has no documented behaviour, and `;` comments END at a newline —
        // so a value carrying one could still change the meaning of the text that follows it. Reject.
        const evil = '/srv/evil\n(allow default)';
        const p = build({ writableDirs: [evil] });
        assert.ok(!/\(allow default\)/.test(p), 'the injected rule must not appear');
        assert.ok(!p.includes('/srv/evil'), 'a control-character path must be dropped entirely');
        assert.ok(/REJECTED as unrepresentable/.test(p), 'the drop must be recorded in the profile');
        // The record must NOT paste the offending value back in — not even inside a comment.
        assert.ok(!p.includes('(allow default)'), 'the rejected value is never echoed');
    });

    test('the escaper rejects what it cannot vouch for', () => {
        assert.strictEqual(sbplPath('/'), null, 'the whole filesystem is never a legitimate zone');
        assert.strictEqual(sbplPath('relative/path'), null, 'Seatbelt matches absolute, resolved paths');
        assert.strictEqual(sbplPath(''), null);
        assert.strictEqual(sbplPath('/a\u0000b'), null, 'NUL');
        assert.strictEqual(sbplPath('/a\nb'), null, 'newline');
        assert.strictEqual(sbplPath('/a\rb'), null, 'carriage return');
        assert.strictEqual(sbplPath('/a\tb'), null, 'tab');
        assert.strictEqual(sbplPath(42), null, 'non-strings');
        assert.strictEqual(sbplPath(undefined), null);
        // …and escapes what it can.
        assert.strictEqual(sbplPath('/srv/a"b'), null, 'a bare quote is rejected, not escaped');
        assert.strictEqual(sbplPath('/srv/a\\"b'), null, 'a backslash-quote pair is rejected too');
        // A backslash alone IS escaped: it is legal in a macOS filename and cannot terminate a literal,
        // so the worst case of a wrong doubling is a grant that matches nothing — the safe direction.
        assert.strictEqual(sbplPath('/srv/a\\b'), '"/srv/a\\\\b"');
        assert.strictEqual(sbplPath('/srv/x/'), '"/srv/x"', 'a trailing separator is stripped for subpath matching');
    });

    test('an unrepresentable appRoot yields NO read grant rather than a widened one', () => {
        const p = buildSeatbeltProfile({ appRoot: 'not-absolute', nodePath: NODE, writableDirs: [], denyNetwork: true });
        assert.ok(!/\(allow file-read\* \(subpath "not-absolute"\)\)/.test(p));
        assert.ok(/application root REJECTED/.test(p), 'the profile must say the root was not granted');
        assert.ok(/\(deny default\)/.test(p), 'the profile is still a deny-by-default profile');
    });
});

describe('sandbox-exec argv', () => {
    test('profile TEXT goes to -p, a profile PATH goes to -f', () => {
        const text = build();
        assert.deepStrictEqual(seatbeltArgs(text, ['/usr/bin/node', '-e', 'x']),
            ['-p', text, '/usr/bin/node', '-e', 'x']);
        assert.deepStrictEqual(seatbeltArgs('/tmp/plugin.sb', ['/usr/bin/node', 'w.js', 'cfg']),
            ['-f', '/tmp/plugin.sb', '/usr/bin/node', 'w.js', 'cfg']);
    });

    test('the node argv is passed through in order and unmodified', () => {
        const args = ['/usr/bin/node', '-r', 'ts-node/register', '--max-old-space-size=256', '/srv/w.js', '{"slug":"a"}'];
        const out = seatbeltArgs('/tmp/p.sb', args);
        assert.deepStrictEqual(out.slice(2), args, 'argv order is load-bearing — cfg must stay at process.argv[2]');
    });

    test('the binary itself is not part of the argv (the caller prepends it)', () => {
        const out = seatbeltArgs('/tmp/p.sb', ['/usr/bin/node']);
        assert.ok(!out.includes(SEATBELT_BIN), 'seatbeltArgs returns arguments, not a command line');
        assert.strictEqual(SEATBELT_BIN, '/usr/bin/sandbox-exec', 'absolute literal — never PATH-resolved');
    });
});

describe('probe', () => {
    test('the embedded Seatbelt probe remains valid JavaScript', () => {
        assert.doesNotThrow(() => new Function(__probeSrc));
        assert.ok(!__probeSrc.includes('process.execve'),
            'a refused execve aborts Node 22 on macOS before the probe can report the denial');
        assert.ok(!__probeSrc.includes('spawnSync'),
            'synchronous spawning uses internal IPC that aborts under a deny-by-default Seatbelt profile');
        assert.ok(__probeSrc.includes('runSpawn(process.execPath'),
            'the removed one-shot executable must be tested through an asynchronous error event');
    });

    test('reports unsupported off macOS, and never claims active', { skip: process.platform === 'darwin' ? 'this assertion is about the non-macOS path' : false }, async () => {
        const state = await probeSeatbelt();
        assert.strictEqual(state, 'unsupported', 'a non-macOS host gets no Seatbelt and must say so');
    });
});
