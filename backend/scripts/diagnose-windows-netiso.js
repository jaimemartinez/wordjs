/**
 * Diagnose how Windows classifies private destinations for an AppContainer that holds only
 * internetClient. Run elevated on Windows: node -r ts-node/register scripts/diagnose-windows-netiso.js
 *
 * It measures one connect per target from a real contained child after each of these, in order, and
 * prints a table; it changes machine settings, so it is meant for a disposable host (a CI runner):
 *   baseline · the private-ranges policy · + subnet definitions authoritative · + firewall service
 *   restart · + per-package outbound block rules (with the firewall profiles shown and, if they are off,
 *   turned on).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sw = require('../src/core/sandbox-windows');

const TARGETS = [
    { name: 'metadata', host: '169.254.169.254', port: 80 },
    { name: 'wireserver(public control)', host: '168.63.129.16', port: 80 },
    { name: 'rfc1918-gw', host: null, port: 53 },
];
const RANGES = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10';
const KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\NetworkIsolation';
let firewallBefore = [];

function ps(script) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 180000 });
    return String(r.stdout || '').trim() + (r.stderr ? ` [stderr: ${String(r.stderr).trim().slice(0, 300)}]` : '');
}

async function main() {
    // A 10.x address this host routes to: its default gateway, when it is in RFC 1918.
    const gw = ps("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop");
    TARGETS[2].host = /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(gw) ? gw : null;
    console.log('gateway:', gw);
    console.log('profiles:', ps('Get-NetConnectionProfile | ForEach-Object { $_.InterfaceAlias + "=" + $_.NetworkCategory }'));
    const fw = ps('Get-NetFirewallProfile | ForEach-Object { $_.Name + "=" + $_.Enabled }');
    console.log('firewall:', fw);
    firewallBefore = fw.split(/\s+/).map((l) => l.split('=')).filter((p) => p.length === 2 && /^(True|False)$/.test(p[1])).map(([name, enabled]) => ({ name, enabled }));

    const profile = `WordJSPluginSandbox.diag-netiso-${process.pid}`;
    const zone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-diag-'));
    const sid = await sw.ensureAppContainerProfile(profile);
    await sw.grantAppContainerAccess(sid, [zone], 'full');
    const exe = await sw.ensureAppContainerRuntime(sid);
    console.log('package sid:', sid);

    async function probe(t) {
        if (!t.host) return 'n/a';
        const out = path.join(zone, `r-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
        const launched = await sw.launchInAppContainer({
            sid, exe, cwd: zone, allowNetwork: true, allowPrivateNetwork: false,
            args: ['-e', `var fs=require('fs');var d=function(c){fs.writeFileSync(process.env.WJS_OUT,c);process.exit(0)};var s=require('net').connect(${t.port},'${t.host}');s.on('connect',function(){d('CONNECTED')});s.on('error',function(e){d((e&&e.code)||'THROW')});setTimeout(function(){d('TIMEOUT')},6000)`],
            env: { SystemRoot: process.env.SystemRoot, windir: process.env.windir, PATH: process.env.PATH, TEMP: zone, TMP: zone, WJS_OUT: out },
        });
        await new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(null); } }; launched.child.on('exit', f); setTimeout(f, 30000); });
        try { launched.child.kill(); } catch { /* */ }
        return fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'NO-RESULT';
    }
    async function row(label) {
        const cells = [];
        for (const t of TARGETS) cells.push(`${t.name}=${await probe(t)}`);
        console.log(`NETISO ${label.padEnd(34)} ${cells.join('  ')}`);
    }

    try {
        await row('baseline');
        spawnSync('reg', ['add', KEY, '/v', 'DomainSubnets', '/t', 'REG_SZ', '/d', RANGES, '/f'], { stdio: 'ignore' });
        spawnSync('gpupdate', ['/target:computer', '/force'], { stdio: 'ignore', timeout: 180000 });
        await row('policy DomainSubnets');
        for (const v of ['DSubnetsAuthoritive', 'DSubnetsAuthoritative', 'DomainSubnetsAuthoritative']) {
            spawnSync('reg', ['add', KEY, '/v', v, '/t', 'REG_DWORD', '/d', '1', '/f'], { stdio: 'ignore' });
        }
        spawnSync('gpupdate', ['/target:computer', '/force'], { stdio: 'ignore', timeout: 180000 });
        await row('+ subnets authoritative');
        console.log('restart mpssvc:', ps('try { Restart-Service mpssvc -Force -ErrorAction Stop; "restarted" } catch { $_.Exception.Message }'));
        await row('+ mpssvc restart');
        console.log('rule:', ps(`try { New-NetFirewallRule -DisplayName 'wjs-diag-private' -Direction Outbound -Action Block -RemoteAddress ${RANGES.split(',').map((r) => `'${r}'`).join(',')} -Package '${sid}' -ErrorAction Stop | Out-Null; 'added' } catch { $_.Exception.Message }`));
        await row('+ per-package block rule');
        console.log('enable profiles:', ps("try { Set-NetFirewallProfile -All -Enabled True -ErrorAction Stop; 'enabled' } catch { $_.Exception.Message }"));
        console.log('firewall now:', ps('Get-NetFirewallProfile | ForEach-Object { $_.Name + "=" + $_.Enabled + "/out=" + $_.DefaultOutboundAction }'));
        await row('+ firewall profiles on');
    } finally {
        // Leave the host as it was for the steps after this one.
        ps("Remove-NetFirewallRule -DisplayName 'wjs-diag-private' -ErrorAction SilentlyContinue");
        for (const v of ['DomainSubnets', 'DSubnetsAuthoritive', 'DSubnetsAuthoritative', 'DomainSubnetsAuthoritative']) {
            spawnSync('reg', ['delete', KEY, '/v', v, '/f'], { stdio: 'ignore' });
        }
        spawnSync('gpupdate', ['/target:computer', '/force'], { stdio: 'ignore', timeout: 180000 });
        ps(`${firewallBefore.map((f) => `Set-NetFirewallProfile -Name ${f.name} -Enabled ${f.enabled}`).join('; ')}`);
        try { await sw.revokeAppContainerAccess(sid, [zone, path.dirname(sw.getAppContainerRuntimePath())]); } catch { /* */ }
        try { await sw.deleteAppContainerProfile(profile); } catch { /* */ }
        try { fs.rmSync(zone, { recursive: true, force: true }); } catch { /* */ }
    }
}

main().then(() => process.exit(0), (e) => { console.log('diagnose failed:', e && e.stack); process.exit(0); });
