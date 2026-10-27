/**
 * No plugin has a network of its own, on any platform; a network-granted one reaches it through the host.
 *
 * The kernel layer gives every isolated plugin the same shape, granted or not: Landlock + seccomp refuse
 * IP sockets on Linux, Seatbelt denies the network on macOS, and the AppContainer has no network
 * capability on Windows (no Windows setting, prompt or administrator step is involved). A network-granted
 * plugin's connections go through the host egress tunnel (core/egress-tunnel), which applies its policy:
 * the ports below, its allowlist, and public destinations only unless an administrator approved an exact
 * host:port. Each platform's probe certifies, in its confined child, that a direct connect is refused and
 * that the tunnel opens a public host and refuses the cloud metadata address (Sandbox parity workflow);
 * egress-tunnel.test.ts runs the plugin side in a real child.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const isolate = require('../core/plugin-isolate');
const tunnel = require('../core/egress-tunnel');
const CORE = path.join(__dirname, '..', 'core');
const read = (rel: string) => fs.readFileSync(path.join(CORE, rel), 'utf8');

test('a plugin\'s ports are DNS + the web, what its manifest declares, and its approved private destinations', () => {
    const perms = require('../core/plugin-permissions');
    const io = require('../core/io-guard');
    const realDeclared = io.declaredPermissionsOf;
    const realPrivate = perms.getPrivateDestinations;
    try {
        io.declaredPermissionsOf = () => [{ scope: 'network', ports: [25, 587, 'x', 99999] }, { scope: 'database', access: 'read' }];
        perms.getPrivateDestinations = () => ['192.168.1.20:2525', '[fd00::1]:8443'];
        assert.deepStrictEqual(isolate.__egressTcpPortsFor('mailer'), [25, 53, 80, 443, 587, 2525, 8443]);
        io.declaredPermissionsOf = () => [];
        perms.getPrivateDestinations = () => [];
        assert.deepStrictEqual(isolate.__egressTcpPortsFor('plain'), [53, 80, 443]);
    } finally {
        io.declaredPermissionsOf = realDeclared;
        perms.getPrivateDestinations = realPrivate;
    }
});

test('mail-server declares the SMTP ports it relays and delivers on', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'marketplace', 'plugins', 'mail-server', 'manifest.json'), 'utf8'));
    const net = manifest.permissions.find((p: any) => p.scope === 'network');
    assert.deepStrictEqual(net.ports, [25, 465, 587, 2525]);
});

test('every platform launches a plugin with no network of its own, granted or not', () => {
    for (const netGranted of [false, true]) {
        const d = isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'active', netGranted });
        assert.strictEqual(d.denyNetwork, true, `Linux, network ${netGranted ? 'granted' : 'denied'}`);
    }
    const iso = read('plugin-isolate.ts');
    assert.match(iso, /readOnlyFiles: tsNodeProjectFiles,\s+denyNetwork: true,/, 'macOS: one Seatbelt profile, network denied');
    assert.match(iso, /allowNetwork: false,\s+allowPrivateNetwork: false,/, 'Windows: no network capability');
    assert.match(iso, /netGranted: false, netFlags: netPermFlags/, 'no --allow-net for the Node permission model');
    assert.doesNotMatch(iso, /tcpPorts: netGranted/, 'no kernel port list: the ports are the tunnel\'s to judge');
});

test('the host tunnel serves the plugin with its live policy, and the worker installs the tunnel only with the grant', () => {
    const iso = read('plugin-isolate.ts');
    assert.match(iso, /network: isNetworkGrantedFor\(slug\),/);
    assert.match(iso, /loaded: egressPolicyLoaded\(\),/);
    assert.match(iso, /ports: egressTcpPortsFor\(slug\),/);
    assert.match(iso, /msg\.kind === 'net'\) \{[\s\S]{0,200}egressTunnel\.handle\(msg\);/);
    const worker = read('plugin-worker.js');
    assert.match(worker, /if \(!netAllowed\) \{[\s\S]*?\} else \{[\s\S]*?tunnel\.installChildTunnel\(send\);/, 'the tunnel client is installed only on the network-granted branch');
    assert.match(worker, /eg\.installChildNetGuard\(tunnel\.connectViaTunnel\);/);
    assert.match(worker, /msg\.kind === 'net'\) \{[\s\S]{0,200}runWithContext\(slug, \(\) => netTunnel\.handleHostFrame\(msg\)\)/, 'tunnel events run as the plugin');
});

test('each platform\'s probe certifies the tunnel from its confined child', () => {
    const snippet = tunnel.probeTunnelSnippet('cb');
    assert.match(snippet, /host:'1\.1\.1\.1',port:443/);
    assert.match(snippet, /host:'169\.254\.169\.254',port:80/);
    assert.doesNotMatch(snippet, /op:'destroy'/, 'no frame from the child after its verdict');
    assert.strictEqual(tunnel.probeTunnelOk('public=opened;metadata=EACCES'), true);
    for (const bad of ['public=EACCES;metadata=EACCES', 'public=opened;metadata=opened', 'public=opened;metadata=TIMEOUT', 'TIMEOUT', undefined]) {
        assert.strictEqual(tunnel.probeTunnelOk(bad), false, String(bad));
    }
    for (const file of ['sandbox-linux.ts', 'sandbox-macos.ts', 'sandbox-windows.ts']) {
        const src = read(file);
        assert.match(src, /probeTunnelOk\(/, `${file} certifies the tunnel`);
        assert.match(src, /attachProbeTunnel\(/, `${file} serves the probe's tunnel with the real host code`);
    }
});

test('no Windows network setting, panel action or command remains', () => {
    const win = require('../core/sandbox-windows');
    for (const gone of ['readNetworkIsolationPolicy', 'applyNetworkIsolationPolicy', 'ensurePrivateRangeRule', 'firewallRulesScript']) {
        assert.strictEqual(win[gone], undefined, gone);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'routes', 'health.ts'), 'utf8'), /windows-network/);
    assert.doesNotMatch(read('site-health.ts'), /security\.pluginNetwork|security\.pluginPorts/);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'plugin-sandbox.js'), 'utf8'), /windows-network/);
});
