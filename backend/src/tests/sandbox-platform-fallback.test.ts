/**
 * THE FALLBACK. What must still be true on a host where the new per-platform kernel layer is NOT active.
 *
 * Two OS-specific confinement layers were just wired into core/plugin-isolate.ts — a zero-capability
 * AppContainer on Windows, a deny-by-default Seatbelt profile on macOS. On the hosts where their probes
 * pass, they are a real second floor. On every OTHER host — which today is nearly all of them, since both
 * are opt-in and one of them has never run on the hardware it targets — the ONLY thing that matters is
 * that nothing changed. A plugin must still load, still serve its routes, still apply its filters, and
 * still be confined by the floors that were already there.
 *
 * That is the property most likely to break and the one that would hurt real users, so it is the property
 * this file pins. It is deliberately written to be meaningful on EVERY platform, including the ones where
 * the new layers can never activate: the launch decision is exported as a PURE function precisely so the
 * fallback can be asserted without a Mac, without an AppContainer, and without mutating the host.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not certify either new layer. Nothing here proves an AppContainer
 * refuses a socket or that a Seatbelt profile parses; those are what the modules' own probes and
 * backend/scripts/verify-sandbox-parity.mjs are for, on real hardware. This file proves the opposite and
 * more urgent thing: that a host where those probes say NO is left exactly as it was.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

require('../config/app'); // preload in the trusted context, like the other isolate tests
const express = require('express');
const request = require('supertest');
const isolate = require('../core/plugin-isolate');
const { setApp } = require('../core/appRegistry');
const hooks = require('../core/hooks');

const decide = isolate.__platformLaunchDecision;
const STATES = ['unknown', 'unsupported', 'disabled', 'active', 'degraded'];

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. THE DECISION. Every path that must NOT take the new launch, asserted directly.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('platform launch decision — when the new layer is used, and (mostly) when it is not', () => {
    test('a probe that did not certify this host NEVER routes the launch through the new layer', () => {
        // This is the whole fallback contract, and it is asserted for every non-active state on both new
        // platforms rather than for one representative pair: 'degraded' in particular must behave exactly
        // like 'disabled' here. A layer that was enabled and could not be demonstrated is the "looks
        // secure but isn't" state, and the one response that is never acceptable to it is using it anyway.
        for (const platform of ['win32', 'darwin']) {
            for (const state of ['unknown', 'unsupported', 'disabled', 'degraded']) {
                const d = decide({ platform, state, netGranted: false, tsNode: false });
                assert.strictEqual(d.use, false, `${platform}/${state} must fall back, not confine`);
                assert.ok(/did not certify/.test(d.reason), `${platform}/${state} must say WHY it fell back, got: ${d.reason}`);
            }
        }
    });

    test('a certified host DOES route the launch through the new layer (the fallback is not universal)', () => {
        // A test that only ever asserts "false" would still pass if the integration were dead code, which
        // is the same defect class as a probe with no positive control. Pin the affirmative case too.
        for (const [platform, mechanism] of [['win32', 'appcontainer'], ['darwin', 'seatbelt']] as const) {
            const d = decide({ platform, state: 'active', netGranted: false, tsNode: false });
            assert.strictEqual(d.use, true, `${platform} with a certified probe must use its kernel layer`);
            assert.strictEqual(d.mechanism, mechanism);
        }
    });

    test('a network-GRANTED plugin is never put in the new container, even on a certified host', () => {
        // A zero-capability AppContainer cannot hold a socket at all, and the macOS profile shape that
        // permits outbound traffic is one no probe has ever exercised. Both stay on the existing launch,
        // bounded by the in-process egress guard — the same posture Linux takes when it withholds
        // --unshare-net from a granted plugin. Getting this wrong does not weaken the sandbox; it breaks
        // every network plugin on the platform, silently, at load time.
        for (const platform of ['win32', 'darwin']) {
            const d = decide({ platform, state: 'active', netGranted: true, tsNode: false });
            assert.strictEqual(d.use, false, `${platform}: a network-granted plugin must keep the standard launch`);
            assert.ok(/network/.test(d.reason));
        }
    });

    test('the Windows container is applied to the compiled child only, never under ts-node', () => {
        // The container requires --preserve-symlinks, which CHANGES MODULE IDENTITY, and ts-node resolving
        // the whole .ts core inside the child is the consumer most sensitive to that. Same carve-out as the
        // permission model and blockCodeGen. macOS needs no such flag and therefore gets no such carve-out.
        assert.strictEqual(decide({ platform: 'win32', state: 'active', netGranted: false, tsNode: true }).use, false);
        assert.strictEqual(decide({ platform: 'darwin', state: 'active', netGranted: false, tsNode: true }).use, true);
    });

    test('Linux is not routed through this decision at all, in any state', () => {
        // The bwrap launch is built by its own path. If this function ever started answering `true` for
        // Linux it would mean the new code had taken over a launch it must never touch.
        for (const state of STATES) {
            const d = decide({ platform: 'linux', state, netGranted: false, tsNode: false });
            assert.strictEqual(d.use, false, `linux/${state} must not be claimed by the platform decision`);
            assert.strictEqual(d.mechanism, 'bwrap');
        }
    });

    test('an unknown platform reports no mechanism rather than guessing one', () => {
        const d = decide({ platform: 'freebsd', state: 'active', netGranted: false, tsNode: false });
        assert.strictEqual(d.mechanism, 'none');
        assert.strictEqual(d.use, false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. THE REPORTED STATE. It must be honest on this host, whatever this host is.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('platform confinement state — honest about this host', () => {
    test('the probe resolves without throwing and yields a coherent report', async () => {
        const state = await isolate.probePlatformConfinement();
        assert.ok(STATES.includes(state), `state must be a known enum, got '${state}'`);

        const report = isolate.getSandboxPlatformConfinement();
        assert.strictEqual(report.state, state, 'the report must agree with the probe');
        assert.ok(['bwrap', 'appcontainer', 'seatbelt', 'none'].includes(report.mechanism));
        assert.ok(STATES.includes(report.network.state));
        assert.ok(typeof report.note === 'string' && report.note.length > 0,
            'every state must carry a sentence saying what it means — a bare enum is not actionable');

        // MECHANISM AND STATE ARE INDEPENDENT, and that independence is the point of the field. Before it,
        // 'unsupported' meant both "this OS has no such layer" and "the layer is here and failed", which
        // demand opposite actions. A platform that HAS a mechanism must never report 'unsupported' merely
        // because the operator has not enabled it.
        if (report.mechanism === 'none') {
            assert.strictEqual(report.state, 'unsupported', 'no mechanism ⇒ genuinely unsupported');
        } else {
            assert.notStrictEqual(report.state, 'unknown', 'the probe has run, so the state cannot still be unknown');
        }
    });

    test("Linux's report is the bwrap state, copied — this section cannot change the Linux path", async () => {
        if (process.platform !== 'linux') return;
        await isolate.probeKernelHardening();
        await isolate.probePlatformConfinement();
        assert.strictEqual(isolate.getSandboxPlatformState(), isolate.getSandboxHardeningState());
        assert.strictEqual(isolate.getSandboxPlatformNetworkState(), isolate.getSandboxNetnsState());
    });

    test('off Linux the bwrap fields stay bwrap-specific and are NOT overloaded', async () => {
        if (process.platform === 'linux') return;
        // Both probes, because they are independent: probePlatformConfinement() delegates to the bwrap
        // probe only on Linux, so off Linux the bwrap state is still 'unknown' until something asks for
        // it. That separation is the point — one probe must not be able to write the other's answer.
        await isolate.probeKernelHardening();
        await isolate.probePlatformConfinement();
        // Widening `sandboxHardeningState` to mean "whatever this platform has" would have silently
        // changed the meaning of a value operators already read on /settings/all. It must keep saying
        // exactly what it always said about bubblewrap.
        assert.strictEqual(isolate.getSandboxHardeningState(), 'unsupported',
            'the bwrap state must remain bwrap-specific off Linux');
        assert.strictEqual(isolate.isSandboxHardeningDegraded(), false, 'unsupported is not a degradation');
    });

    test('the health surface separates "no such layer" from "the layer failed here"', () => {
        const health = require('../core/system-health').checkSandbox();
        assert.ok(health.kernel, '/health/details must carry the per-platform kernel block');
        assert.strictEqual(typeof health.kernelDegraded, 'boolean');
        assert.strictEqual(health.kernelDegraded, health.kernel.state === 'degraded',
            'the alarm boolean must be exactly "the layer was enabled and is not there"');
        // 'disabled' and 'unsupported' are chosen postures and must never raise the alarm.
        if (['disabled', 'unsupported'].includes(health.kernel.state)) {
            assert.strictEqual(health.kernelDegraded, false);
        }
        // The overall status must never read OK unless a probe actually certified this host.
        if (health.status === 'OK') assert.strictEqual(health.kernel.state, 'active');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. DRIFT GUARDS. Two numbers and one flag set that live in more than one module and MUST agree.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('drift guards between plugin-isolate and the platform modules', () => {
    test('the Windows module budgets the SAME resident cap the isolate does', () => {
        // sandbox-windows.ts hands ProcessMemoryLimit to the AppContainer relay from its OWN copy of the
        // 768 MB budget. If the two ever diverge, a contained plugin gets a different memory ceiling from
        // an uncontained one on the same host — and nothing would report it, because both would be "a cap".
        const win = require('../core/sandbox-windows');
        assert.strictEqual(win.RSS_BUDGET_BYTES, 768 * 1024 * 1024,
            'the AppContainer relay budget must stay the shared 768 MB resident budget');
        assert.ok(win.APPCONTAINER_NODE_FLAGS.includes('--preserve-symlinks-main'));
        assert.ok(win.APPCONTAINER_NODE_FLAGS.includes('--preserve-symlinks'),
            'BOTH flags are required: main-only loads the entry module and then dies on the first require()');
    });

    test('the macOS profile confines writes to the zones it was handed, and nothing else', () => {
        // The io-guard write zones are declared ONCE in plugin-isolate and passed to three consumers
        // (bwrap binds, --allow-fs-write, this profile). Assert the profile really is derived from the
        // argument rather than from a second, drifting list of its own.
        const mac = require('../core/sandbox-macos');
        const profile = mac.buildSeatbeltProfile({
            writableDirs: ['/srv/app/uploads'],
            denyNetwork: true,
            appRoot: '/srv/app',
        });
        assert.ok(profile.startsWith('(version 1)'), 'a profile must open with its version form');
        assert.ok(profile.includes('(deny default)'), 'deny-by-default is the whole design');
        assert.ok(profile.includes('"/srv/app/uploads"'), 'the granted zone must appear in the profile');
        assert.ok(!profile.includes('"/srv/app/node_modules"'), 'nothing may be writable that was not passed in');
        assert.ok(/deny\s+network/.test(profile), 'a non-network plugin must have its network denied');
        // seatbeltArgs must produce ARGUMENTS (like bwrapProfile), not a command line, or the composition
        // inside the `sh -c 'ulimit …; exec "$@"'` memory-cap wrapper would not be possible at all.
        const args = mac.seatbeltArgs(profile, ['/usr/bin/node', '-e', '0']);
        assert.deepStrictEqual(args.slice(0, 2), ['-p', profile]);
        assert.deepStrictEqual(args.slice(2), ['/usr/bin/node', '-e', '0']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 4. THE REAL THING. A plugin loads and is still confined on THIS host, whatever it decided above.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
const SLUG = 'test-platform-fallback-plugin';
const dir = path.join(path.resolve(__dirname, '../../plugins'), SLUG);
const entry = path.join(dir, 'index.js');
const app = express();

describe('an isolated plugin on this host: loads, serves, and is still confined by the existing floors', () => {
    let loaded = false;

    before(async () => {
        setApp(app);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [] }));
        fs.writeFileSync(entry,
            "exports.init = function (wordjs) {\n" +
            "  wordjs.hooks.addFilter('platform_fallback_filter', (v) => '[ok]' + v);\n" +
            "  wordjs.http.route('get', '/confinement', (req, res) => {\n" +
            // The floors that were already there, checked from INSIDE the child. None of them depend on
            // the new layers, and all of them must survive whichever launch path this host chose.
            "    let netBlocked = false; try { require('net').createServer(); } catch (e) { netBlocked = true; }\n" +
            "    let fetchBlocked = false; try { void fetch; } catch (e) { fetchBlocked = true; }\n" +
            // child_process resolves to a SHIM rather than throwing at require() time, so the honest
            // check is whether the capability works — requiring it proves nothing either way.
            "    let cpBlocked = false; try { require('child_process').spawn(process.execPath, ['-e', '0']); } catch (e) { cpBlocked = true; }\n" +
            "    let escapeBlocked = false; try { process.binding('fs'); } catch (e) { escapeBlocked = true; }\n" +
            "    res.status(200).json({ netBlocked, fetchBlocked, cpBlocked, escapeBlocked });\n" +
            "  });\n" +
            "};\n");
        await isolate.loadIsolatedPlugin(SLUG, entry);
        loaded = true;
    });

    after(() => {
        try { isolate.unloadIsolatedPlugin(SLUG); } catch { /* */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    });

    test('it loaded at all — the layer being absent, disabled or degraded must not fail a load', () => {
        // The single most important assertion in this file. A confinement layer that cannot be applied has
        // exactly one correct behaviour, and it is to get out of the way.
        assert.strictEqual(loaded, true);
        assert.strictEqual(isolate.isIsolated(SLUG), true);
    });

    test('its hook still applies over the bridge', async () => {
        assert.strictEqual(await hooks.applyFilters('platform_fallback_filter', 'x'), '[ok]x');
    });

    test('its route is still served — the IPC bridge survives whichever launch this host chose', async () => {
        const r = await request(app).get(`/api/v1/plugin/${SLUG}/confinement`);
        assert.strictEqual(r.status, 200);
    });

    test('the pre-existing floors are STILL enforced, whichever launch path was taken', async () => {
        // These are the guarantees the sandbox already made before any of this work. The new layers were
        // added underneath them, not in place of them, so a fallback host must be no worse off than it was
        // and a confined host must be no worse off either.
        const r = await request(app).get(`/api/v1/plugin/${SLUG}/confinement`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.netBlocked, true, 'raw sockets must stay blocked for a plugin with no network grant');
        assert.strictEqual(r.body.fetchBlocked, true, 'the binding-backed global fetch must stay trapped');
        assert.strictEqual(r.body.cpBlocked, true, 'spawning a child process must stay blocked');
        assert.strictEqual(r.body.escapeBlocked, true, 'process.binding must stay blocked');
    });

    test('the host still knows the child by pid, so teardown is still exact', () => {
        // livePids means "we spawned it and have not observed its death" and every teardown path depends
        // on it. It must hold on every launch path, including the one where child.pid is a relay.
        assert.ok(isolate.getLivePids(SLUG).length >= 1, 'the isolate must have a live pid registered');
    });

    test('unloading still stops it', async () => {
        isolate.unloadIsolatedPlugin(SLUG);
        assert.strictEqual(isolate.isIsolated(SLUG), false);
        assert.strictEqual(await isolate.awaitIsolateStopped(SLUG, 5000), true, 'the child must actually be gone');
    });
});
