/**
 * A network-granted plugin is bounded by the KERNEL, not only by the in-process egress guard.
 *
 * With the network permission, every platform used to open outbound sockets wholesale at the kernel
 * level: seccomp admitted any IP client, Landlock's TCP rules were off, Seatbelt allowed all outbound,
 * and Windows' internetClient counted many private ranges (a VPN, a routed LAN, 169.254) as the Internet.
 * Now:
 *   · Linux: Landlock (ABI >= 4) refuses every TCP connect outside the plugin's ports and every TCP bind;
 *   · macOS: Seatbelt allows only those TCP ports and never loopback;
 *   · Windows: the private network ranges are made private for every AppContainer by a one-time machine
 *     policy (Site Health applies it), and only a plugin with an approved private destination gets
 *     privateNetworkClientServer.
 * The kernels themselves are certified by each platform's probe in the Sandbox parity workflow (a
 * connect to a loopback port outside the list must be refused there); this suite pins the policy every
 * platform is handed.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const linux = require('../core/sandbox-linux');
const mac = require('../core/sandbox-macos');
const win = require('../core/sandbox-windows');
const isolate = require('../core/plugin-isolate');

test('the Linux shim receives the ports, and only for a network-granted plugin', () => {
    const granted = linux.shimArgs({ zone: ['/srv/z'], denyNetwork: false, tcpPorts: [443, 25, 443, 0, 70000], nodeArgs: ['node'] });
    assert.deepStrictEqual(granted.filter((a: string) => a.startsWith('--tcp-port=')), ['--tcp-port=25', '--tcp-port=443'], 'sorted, de-duplicated, invalid ones dropped');
    const denied = linux.shimArgs({ zone: ['/srv/z'], denyNetwork: true, tcpPorts: [443], nodeArgs: ['node'] });
    assert.ok(!denied.some((a: string) => a.startsWith('--tcp-port=')), 'a denied plugin has no socket at all; ports would mean nothing');
    assert.ok(granted.indexOf('--tcp-port=25') < granted.indexOf('/srv/z'), 'options precede the zones, as the shim grammar requires');
});

test('the shim turns the ports into CONNECT-only Landlock rules and handles TCP for granted plugins too', () => {
    const shim = fs.readFileSync(linux.SHIM_PATH, 'utf8');
    assert.match(shim, /--\(read-root\|exec-root\|tcp-port\)=/);
    assert.match(shim, /my \$handle_net = \(\$abi >= 4 && \(\$denyNet eq '1' \|\| @tcp_ports\)\) \? 1 : 0;/);
    assert.match(shim, /syscall\(\$NR_ll_add, \$rfd, 2, pack\("QQ", \$NET_CONNECT_TCP, \$port\), 0\)/);
    assert.match(shim, /landlock-net=" \. \(\$handle_net \? \(\$denyNet eq '1' \? 'deny' : 'ports:'/, 'the SHIM: line says whether ports are kernel-enforced');
});

test('the Linux probe certifies the port rule: a granted child is refused a loopback port outside the list', () => {
    const src = String(linux.__probeSrc);
    assert.match(src, /net\.connect\(portTarget,"127\.0\.0\.1"\)/);
    const mod = fs.readFileSync(path.join(__dirname, '..', 'core', 'sandbox-linux.ts'), 'utf8');
    assert.match(mod, /tcpPorts: DEFAULT_EGRESS_TCP_PORTS/);
    assert.match(mod, /portsByKernel\s*\? REFUSAL_CODES\.has\(String\(allowed\.msg\.portCode\)\)/);
    assert.deepStrictEqual(linux.DEFAULT_EGRESS_TCP_PORTS, [53, 80, 443]);
});

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

test('macOS: only the plugin\'s TCP ports, UDP clients, mDNSResponder - and never loopback', () => {
    const p = mac.buildSeatbeltProfile({ writableDirs: ['/srv/wordjs/backend/data/plugin-own/x'], denyNetwork: false, egressTcpPorts: [443, 25], appRoot: '/srv/wordjs/backend', nodePath: '/usr/local/bin/node' });
    assert.ok(p.includes('(allow network-outbound (remote tcp "*:25"))') && p.includes('(allow network-outbound (remote tcp "*:443"))'));
    assert.ok(!p.includes('(remote tcp "*:80")'), 'a port the plugin was not given is absent');
    assert.ok(!/\(allow network-outbound\)/.test(p), 'never an unfiltered outbound grant');
    assert.ok(p.indexOf('(deny network-outbound (remote ip "localhost:*"))') > p.lastIndexOf('(allow network-outbound'), 'loopback is denied after (so over) every allow');
    assert.deepStrictEqual(mac.auditProfile(p), [], 'the profile still passes its own invariants');
    const denied = mac.buildSeatbeltProfile({ writableDirs: ['/srv/z'], denyNetwork: true, egressTcpPorts: [443], appRoot: '/srv/wordjs/backend', nodePath: '/usr/local/bin/node' });
    assert.ok(!/remote tcp/.test(denied), 'a denied plugin gets no port at all');
});

test('macOS probe: the granted shape must be refused a loopback port', () => {
    const mod = fs.readFileSync(path.join(__dirname, '..', 'core', 'sandbox-macos.ts'), 'utf8');
    assert.match(mod, /allowed\.netCode === 'CONNECTED' && refused\(allowed\.portCode\)/);
    assert.match(String(mac.__probeSrc), /net\.connect\(loopPort,"127\.0\.0\.1"\)/);
});

test('Windows: the private ranges policy, and privateNetworkClientServer only with an approved destination', () => {
    assert.deepStrictEqual(win.PRIVATE_NETWORK_RANGES, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', 'fc00::/7', 'fe80::/10']);
    const script = win.networkIsolationScript();
    assert.match(script, /HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\NetworkIsolation/);
    assert.match(script, /Set-ItemProperty -Path \$key -Name DomainSubnets/);
    assert.match(script, /if \(\$all -notcontains \$r\)/, 'ranges an administrator set already are kept');
    for (const r of win.PRIVATE_NETWORK_RANGES) assert.ok(script.includes(r));
    assert.ok([...script].every((c) => c === '\t' || c === '\n' || c === '\r' || (c >= ' ' && c <= '~')), 'ASCII, like every generated PowerShell');
    const relay = win.__buildRelayScript();
    assert.ok(relay.includes('S-1-15-3-3') && relay.includes('WJS_AC_PRIVATE_NETWORK'));
    const iso = fs.readFileSync(path.join(__dirname, '..', 'core', 'plugin-isolate.ts'), 'utf8');
    assert.match(iso, /allowPrivateNetwork: netGranted && egressTcpPortsHasPrivate\(slug\)/);
    if (process.platform !== 'win32') {
        assert.deepStrictEqual(win.readNetworkIsolationPolicy(), { platform: false, configured: false, missing: [] });
    } else {
        const st = win.readNetworkIsolationPolicy();
        assert.strictEqual(st.platform, true);
        assert.strictEqual(st.configured, st.missing.length === 0);
    }
});

test('Site Health shows the Windows setting with a panel action, and the panel calls it', () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const realRead = win.readNetworkIsolationPolicy;
    const realExposure = win.getSecretExposure;
    try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        win.readNetworkIsolationPolicy = () => ({ platform: true, configured: false, missing: ['10.0.0.0/8'] });
        win.getSecretExposure = () => ({ checked: true, protectedPaths: [], exposed: [] });
        const checks = require('../core/site-health').pluginSandboxChecks();
        const c = checks.find((x: any) => x.id === 'security.pluginNetwork');
        assert.ok(c, 'the check is there');
        assert.strictEqual(c.status, 'warn');
        assert.deepStrictEqual(c.action && c.action.endpoint, '/health/sandbox/windows-network');
    } finally {
        Object.defineProperty(process, 'platform', realPlatform);
        win.readNetworkIsolationPolicy = realRead;
        win.getSecretExposure = realExposure;
    }
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'health.ts'), 'utf8');
    assert.match(route, /router\.post\('\/sandbox\/windows-network', authenticate, isAdmin/);
    const page = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'frontend', 'src', 'app', 'admin', 'site-health', 'page.tsx'), 'utf8');
    assert.match(page, /apiPost\(c\.action\.endpoint, c\.action\.body \|\| \{\}\)/);
    for (const lang of ['es', 'en', 'pt']) assert.ok(page.includes('siteHealth.check.security.pluginNetwork.missing'), lang);
});
