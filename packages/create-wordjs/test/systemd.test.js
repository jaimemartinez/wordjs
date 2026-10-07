'use strict';

// `--systemd` and the low-port advice, exercised through the real index.js.
//
// Why this file exists: this installer used to tell Linux operators to run
//     sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(command -v node)")"
// and the capability family it belongs to is what broke a production site: a non-root service given
// CAP_NET_BIND_SERVICE through systemd's AmbientCapabilities= passes it to every child, the plugin
// sandbox shim cannot shed it without CAP_SETGID/CAP_SETPCAP, and every plugin was refused. These tests
// pin the replacement: a unit that runs as a dedicated account holding NO capabilities, ports below 1024
// reached through net.ipv4.ip_unprivileged_port_start (with its trade-off written down), and no
// capability advice left anywhere in what the CLI prints.
//
// Everything is driven through the exported functions or a child `node index.js` that is expected to
// stop in argument parsing, so no test can reach the network or the real create/upgrade flows.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INDEX = path.join(__dirname, '..', 'index.js');
const cli = require(INDEX);

/** Run the CLI with arguments that must be rejected (or answered) before any network access. */
function run(args) {
    const r = spawnSync(process.execPath, [INDEX, ...args], { encoding: 'utf8', timeout: 20000 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const directives = (unit) => unit.split('\n').filter((l) => /^[A-Za-z]+=/.test(l));
// What createSystemdStagingDir() returns, for the tests that only read the printed steps.
const STAGE = '/tmp/wordjs-systemd-abc123';

test('--help documents --systemd, --port and --service-user', () => {
    const r = run(['--help']);
    assert.strictEqual(r.status, 0);
    assert.match(r.out, /--systemd\b/);
    assert.match(r.out, /--port <n>/);
    assert.match(r.out, /--service-user <name>/);
    assert.match(r.out, /ip_unprivileged_port_start/);
});

test('the old setcap advice is gone from everything the CLI can print', () => {
    const source = fs.readFileSync(INDEX, 'utf8');
    // The exact recommendation this installer used to print, in any spelling of the grant. (assert.ok
    // rather than doesNotMatch: a failure should name the offending line, not dump the whole file.)
    for (const re of [/setcap\s+cap_net_bind_service/i, /cap_net_bind_service\s*=\s*\+?e?p/i]) {
        const hit = source.split('\n').find((l) => re.test(l));
        assert.ok(!hit, `index.js still carries the setcap grant: ${hit && hit.trim()}`);
    }
    // The replacement says what to do instead, and still mentions setcap only to rule it out.
    const advice = cli.LOW_PORT_ADVICE.join('\n');
    assert.match(advice, /reverse proxy/);
    assert.match(advice, /ip_unprivileged_port_start/);
    assert.match(advice, /Do not give node a capability/);
    assert.match(cli.HELP, /Do not\s+give node a capability with setcap or AmbientCapabilities=/);
});

test('parseArgs accepts --systemd with --port and --service-user for create and upgrade', () => {
    const c = cli.parseArgs(['my-site', '--systemd', '--port', '443', '--service-user', 'svc']);
    assert.strictEqual(c.mode, 'create');
    assert.strictEqual(c.dir, 'my-site');
    assert.strictEqual(c.systemd, true);
    assert.strictEqual(c.port, 443, 'the port is parsed to a number');
    assert.strictEqual(c.serviceUser, 'svc');

    const u = cli.parseArgs(['upgrade', '--systemd']);
    assert.strictEqual(u.mode, 'upgrade');
    assert.strictEqual(u.dir, '.');
    assert.strictEqual(u.systemd, true);
    assert.strictEqual(u.port, null, 'no --port means: keep the port the site config already sets');
    assert.strictEqual(u.serviceUser, null);

    assert.strictEqual(cli.parseArgs(['my-site']).systemd, false);
});

test('parseArgs rejects --systemd misuse before doing anything', () => {
    const cases = [
        [['my-site', '--port', '80'], /only apply together with --systemd/],
        [['my-site', '--service-user', 'svc'], /only apply together with --systemd/],
        [['my-site', '--systemd', '--service-user', 'root'], /must not run as root/],
        [['my-site', '--systemd', '--service-user', 'Bad User'], /not a usable account name/],
        [['my-site', '--systemd', '--port', '0'], /1 to 65535/],
        [['my-site', '--systemd', '--port', '70000'], /1 to 65535/],
        [['my-site', '--systemd', '--port', '80abc'], /1 to 65535/],
        [['gateway', '--systemd'], /not available for "gateway"/],
        [['join', 'backend', '--systemd'], /not available for "join"/],
    ];
    for (const [args, message] of cases) {
        const r = run(args);
        assert.strictEqual(r.status, 1, `${args.join(' ')} must exit 1, got ${r.status}: ${r.out}`);
        assert.match(r.out, message, args.join(' '));
    }
});

test('the unit runs as a dedicated non-root account and holds NO capabilities', () => {
    const { unit } = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port: 443 });
    const d = directives(unit);
    assert.ok(d.includes('User=wordjs'), unit);
    assert.ok(!d.some((l) => /^User=(root|0)$/.test(l)));
    assert.ok(!d.some((l) => l.startsWith('Group=')), 'the account\'s own primary group, not a group that may not exist');
    assert.ok(d.includes('WorkingDirectory=/srv/wordjs'));
    assert.ok(d.includes('ExecStart=/usr/bin/node /srv/wordjs/monolith.js prod'));
    assert.ok(d.includes('Environment=NODE_ENV=production'));
    assert.ok(d.includes('Environment=PORT=443'));
    assert.ok(d.includes('Restart=on-failure'));
    // No capability may be granted, in any directive that can grant one.
    assert.ok(!d.some((l) => /^(AmbientCapabilities|Capabilities|SecureBits)=/.test(l)), unit);
    assert.deepStrictEqual(d.filter((l) => l.startsWith('CapabilityBoundingSet=')), ['CapabilityBoundingSet='],
        'the bounding set is emptied, never widened');
    assert.doesNotMatch(unit, /CAP_[A-Z_]+/, 'no capability is named anywhere in the unit');
    assert.ok(d.includes('NoNewPrivileges=yes'));
    // Hardening that the lab run of a real install verified (see documentation/deployment.md).
    for (const want of ['PrivateTmp=yes', 'ProtectSystem=strict', 'ReadWritePaths=/srv/wordjs', 'ProtectHome=yes', 'Environment=HOME=/srv/wordjs']) {
        assert.ok(d.includes(want), `missing ${want}`);
    }
    assert.ok(d.includes('WantedBy=multi-user.target'));
});

test('a port below 1024 gets the sysctl drop-in, with its trade-off, and no capability', () => {
    const built = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port: 443 });
    assert.ok(built.sysctl, 'port 443 needs the privileged-port floor lowered');
    assert.strictEqual(built.sysctl.start, 443);
    assert.match(built.sysctl.content, /^net\.ipv4\.ip_unprivileged_port_start = 443$/m);
    assert.match(built.sysctl.content, /EVERY unprivileged/, 'the drop-in states that it is not a grant to WordJS alone');
    assert.match(built.sysctl.content, /reverse proxy/);
    assert.match(built.sysctl.content, /acme\.http01Port: 80/, 'HTTPS on 443 is warned that HTTP-01 needs 80');
    assert.match(built.unit, /install 60-wordjs-ports\.conf/);

    const steps = cli.systemdInstallSteps({ installDir: '/srv/wordjs', built, stageDir: STAGE }).join('\n');
    assert.match(steps, /sudo install -o root -g root -m 0644 \/tmp\/wordjs-systemd-abc123\/60-wordjs-ports\.conf \/etc\/sysctl\.d\/60-wordjs-ports\.conf && sudo sysctl --system/);
    assert.match(steps, /https:\/\/<your-host>\/install#token=/, 'port 443 is the https default, so the URL omits it');
    assert.doesNotMatch(steps, /setcap|AmbientCapabilities|CAP_NET/);
});

test('a port at or above 1024 needs no sysctl at all', () => {
    for (const port of [1024, 3000, 8443]) {
        const built = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port });
        assert.strictEqual(built.sysctl, null, `port ${port}`);
        const steps = cli.systemdInstallSteps({ installDir: '/srv/wordjs', built, stageDir: STAGE }).join('\n');
        assert.doesNotMatch(steps, /sysctl/, `port ${port}`);
        assert.match(steps, new RegExp(`https://<your-host>:${port}/install`));
    }
});

test('without --port the unit leaves the port to the site config and reads it for the sysctl decision', () => {
    const fresh = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node' });
    assert.ok(!directives(fresh.unit).some((l) => l.startsWith('Environment=PORT=')),
        'an inherited port written as PORT= would silently override a later config change');
    assert.strictEqual(fresh.publicPort, 3000);
    assert.strictEqual(fresh.sysctl, null);

    const configured = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', configuredPort: 443 });
    assert.ok(!directives(configured.unit).some((l) => l.startsWith('Environment=PORT=')));
    assert.strictEqual(configured.sysctl.start, 443);
});

test('the ACME HTTP-01 listener counts toward the floor only when HTTPS is on', () => {
    const https = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port: 443, acmeHttp01Port: 80 });
    assert.strictEqual(https.sysctl.start, 80);
    assert.doesNotMatch(https.sysctl.content, /acme\.http01Port: 80/, 'already at 80: no "lower it to 80" note');

    const http = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port: 8080, acmeHttp01Port: 80, http: true });
    assert.strictEqual(http.sysctl, null, 'monolith.js starts the ACME listener only beside HTTPS');
    assert.ok(directives(http.unit).includes('Environment=WORDJS_HTTP=1'));
});

test('node outside systemd\'s PATH is put on PATH, so plugin dependency installs can find npm', () => {
    const system = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node' });
    assert.ok(!directives(system.unit).some((l) => l.startsWith('Environment=PATH=')));
    const opt = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/opt/node-v22/bin/node' });
    assert.ok(directives(opt.unit).includes('Environment=PATH=/opt/node-v22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin'));
});

test('directives that would hide the site or node are left out, with a warning, instead of shipped broken', () => {
    const home = cli.buildSystemdFiles({ installDir: '/home/alice/site', nodePath: '/usr/bin/node' });
    assert.ok(!directives(home.unit).includes('ProtectHome=yes'));
    assert.ok(home.warnings.some((w) => /home directory/.test(w)));

    const nvm = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/home/alice/.nvm/versions/node/v22.0.0/bin/node' });
    assert.ok(!directives(nvm.unit).includes('ProtectHome=yes'));
    assert.ok(nvm.warnings.some((w) => /nvm/.test(w)));

    const tmp = cli.buildSystemdFiles({ installDir: '/var/tmp/site', nodePath: '/usr/bin/node' });
    assert.ok(!directives(tmp.unit).includes('PrivateTmp=yes'));
    assert.ok(tmp.warnings.some((w) => /temporary directory/.test(w)));

    const plain = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node' });
    assert.deepStrictEqual(plain.warnings, []);
});

test('paths a unit cannot hold verbatim, and root, are refused rather than escaped or accepted', () => {
    for (const installDir of ['relative/site', '/srv/my site', '/srv/50%', '/srv/$HOME', '/srv/"q"', '/srv/../etc']) {
        assert.throws(() => cli.buildSystemdFiles({ installDir, nodePath: '/usr/bin/node' }), /cannot go into a systemd unit/, installDir);
    }
    assert.throws(() => cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/opt/my node/node' }), /node binary/);
    assert.throws(() => cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', user: 'root' }), /must not run as root/);
});

test('install steps create the account without a login shell and, on upgrade, remove old capabilities', () => {
    const built = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', user: 'svc' });
    const create = cli.systemdInstallSteps({ installDir: '/srv/wordjs', user: 'svc', built, stageDir: STAGE }).join('\n');
    assert.match(create, /sudo useradd --system --home-dir \/srv\/wordjs --shell \/usr\/sbin\/nologin svc/);
    assert.match(create, /sudo chown -R svc: \/srv\/wordjs/);
    assert.match(create, /systemctl enable --now wordjs/);
    assert.match(create, /backend\/data\/install-token/);

    const upgrade = cli.systemdInstallSteps({ installDir: '/srv/wordjs', user: 'svc', built, upgrade: true, nodePath: '/usr/bin/node', stageDir: STAGE }).join('\n');
    assert.match(upgrade, /systemctl restart wordjs/);
    assert.match(upgrade, /getcap \/usr\/bin\/node/);
    assert.match(upgrade, /sudo setcap -r \/usr\/bin\/node/, 'an upgrade tells the operator how to REMOVE a file capability');
});

// The upgrade path is how a site started with `npm run start:mono`, pm2 or a unit of another name moves
// to this unit (LOW_PORT_ADVICE sends it there). Measured on Linux: daemon-reload + restart left the unit
// "active" but "disabled", so the site stayed down after the next reboot.
test('upgrade ENABLES the unit, and says to retire whatever served the site before', () => {
    const built = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node' });
    const upgrade = cli.systemdInstallSteps({ installDir: '/srv/wordjs', built, upgrade: true, nodePath: '/usr/bin/node', stageDir: STAGE }).join('\n');
    assert.match(upgrade, /sudo systemctl daemon-reload && sudo systemctl enable wordjs && sudo systemctl restart wordjs/);
    assert.match(upgrade, /stop and disable whatever served this site until now/);
    assert.match(upgrade, /systemctl disable --now <name>/);
    assert.match(upgrade, /pm2 delete <name>/);
    assert.match(upgrade, /npm run start:mono/);
});

// A site that moves from 443 to a high port behind a proxy left the lowered floor installed in
// /etc/sysctl.d, letting every unprivileged process bind 443-1023 for no reason.
test('upgrade to a high port says how to WITHDRAW a drop-in an earlier run installed', () => {
    const built = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port: 3000 });
    const upgrade = cli.systemdInstallSteps({ installDir: '/srv/wordjs', built, upgrade: true, stageDir: STAGE }).join('\n');
    assert.match(upgrade, /sudo rm -f \/etc\/sysctl\.d\/60-wordjs-ports\.conf && sudo sysctl -w net\.ipv4\.ip_unprivileged_port_start=1024 && sudo sysctl --system/);
    const low = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port: 443 });
    assert.doesNotMatch(cli.systemdInstallSteps({ installDir: '/srv/wordjs', built: low, upgrade: true, stageDir: STAGE }).join('\n'), /sudo rm -f \/etc\/sysctl/);
    assert.match(low.sysctl.content, /# Withdraw: sudo rm \/etc\/sysctl\.d\/60-wordjs-ports\.conf/);
});

// THE FILES ROOT INSTALLS ARE NEVER STAGED WHERE THE SERVICE CAN WRITE. They used to be written into the
// site directory, which the very next printed step hands to the service account (chown -R): a
// compromised service could rewrite them before root copied them into /etc, or plant a symlink so this
// CLI, run with sudo, wrote through it - reproduced on Linux against a root-only 0600 file.
test('every root-consumed file is installed FROM the staging directory, never from the site', () => {
    for (const port of [443, 3000]) {
        const built = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port });
        for (const upgrade of [false, true]) {
            const steps = cli.systemdInstallSteps({ installDir: '/srv/wordjs', built, upgrade, stageDir: STAGE }).join('\n');
            assert.doesNotMatch(steps, /\/srv\/wordjs\/(wordjs\.service|60-wordjs-ports\.conf)/, `port ${port} upgrade=${upgrade}`);
            assert.doesNotMatch(steps, /sudo cp /, 'root installs a root-owned copy (install -o root -m 0644), not whatever mode a cp keeps');
            assert.match(steps, /sudo install -o root -g root -m 0644 \/tmp\/wordjs-systemd-abc123\/wordjs\.service \/etc\/systemd\/system\/wordjs\.service/);
        }
    }
});

test('the files are staged in a FRESH private directory outside the site, and written exclusively', () => {
    const a = cli.createSystemdStagingDir();
    const b = cli.createSystemdStagingDir();
    try {
        assert.notStrictEqual(a, b, 'a new directory per run, under a name nobody can predict');
        assert.ok(path.resolve(a).startsWith(path.resolve(os.tmpdir())), a);
        if (process.platform !== 'win32') assert.strictEqual(fs.statSync(a).mode & 0o777, 0o700, 'only the account running the CLI may enter it');

        const low = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port: 80 });
        const w = cli.writeSystemdFiles(a, low);
        assert.strictEqual(path.dirname(w.unitPath), a);
        assert.strictEqual(fs.readFileSync(w.unitPath, 'utf8'), low.unit);
        assert.strictEqual(fs.readFileSync(w.sysctlPath, 'utf8'), low.sysctl.content);

        const high = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port: 8443 });
        assert.strictEqual(cli.writeSystemdFiles(b, high).sysctlPath, null);
        assert.ok(!fs.existsSync(path.join(b, '60-wordjs-ports.conf')));
    } finally {
        fs.rmSync(a, { recursive: true, force: true });
        fs.rmSync(b, { recursive: true, force: true });
    }
});

test('a name that already exists - a planted symlink above all - is never written through', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-systemd-'));
    try {
        const victim = path.join(dir, 'victim');
        fs.writeFileSync(victim, 'ROOT-ONLY');
        const built = cli.buildSystemdFiles({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', port: 443 });
        // A plain file under the name: refused, not truncated.
        fs.writeFileSync(path.join(dir, '60-wordjs-ports.conf'), 'PLANTED');
        const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-systemd-'));
        try {
            fs.writeFileSync(path.join(plain, 'wordjs.service'), 'PLANTED');
            assert.throws(() => cli.writeSystemdFiles(plain, built), /EEXIST/);
            assert.strictEqual(fs.readFileSync(path.join(plain, 'wordjs.service'), 'utf8'), 'PLANTED');
        } finally { fs.rmSync(plain, { recursive: true, force: true }); }
        // A symlink under the name: refused, and its target untouched.
        try { fs.symlinkSync(victim, path.join(dir, 'wordjs.service')); } catch (e) {
            if (process.platform === 'win32') { t.skip(`symlinks need privilege on this Windows host (${e.code})`); return; }
            throw e;
        }
        assert.throws(() => cli.writeSystemdFiles(dir, built), /EEXIST/);
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ROOT-ONLY', 'the symlink target must be untouched');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Checked BEFORE anything is downloaded or installed: a path the unit cannot hold used to be found
// only after a full create had fetched and installed the release (or an upgrade had applied it).
test('systemdPreflight refuses an unusable site or node path, and the service account running the CLI', () => {
    assert.strictEqual(cli.systemdPreflight({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', user: 'wordjs', runningAs: 'admin' }), null);
    assert.strictEqual(cli.systemdPreflight({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', user: 'wordjs', runningAs: 'root' }), null);
    assert.match(cli.systemdPreflight({ installDir: '/opt/wjsrev/my site', nodePath: '/usr/bin/node' }).message, /site directory path .* cannot go into a systemd unit/);
    assert.match(cli.systemdPreflight({ installDir: '/srv/wordjs', nodePath: '/opt/my node/node' }).message, /node binary path/);
    const self = cli.systemdPreflight({ installDir: '/srv/wordjs', nodePath: '/usr/bin/node', user: 'wordjs', runningAs: 'wordjs' });
    assert.match(self.message, /running as "wordjs", the account the service will run as/);
    assert.match(self.hint, /must not be writable by the service/);
});

test('main() runs the preflight right after the platform check, before the create/upgrade flows', () => {
    const source = fs.readFileSync(INDEX, 'utf8').replace(/\r\n/g, '\n');
    const main = source.slice(source.indexOf('async function main()'));
    const pre = main.indexOf('systemdPreflight(');
    assert.ok(pre > 0, 'main() must call systemdPreflight');
    for (const later of ["if (opts.mode === 'upgrade') return upgrade(opts);", 'fs.mkdirSync(targetDir', 'obtainBundleZip(']) {
        assert.ok(main.indexOf(later) > pre, `systemdPreflight must run before: ${later}`);
    }
    // And a refusal inside emitSystemd THROWS (so upgrade's `finally { cleanup() }` runs) instead of exiting.
    const emit = source.slice(source.indexOf('function emitSystemd('), source.indexOf('// Printed on Linux after a plain'));
    assert.ok(emit.length > 100 && !/\bfail\(/.test(emit), 'emitSystemd must not process.exit through fail()');
});
