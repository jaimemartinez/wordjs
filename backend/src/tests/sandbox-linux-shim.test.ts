/**
 * Unit tests for the parts of the Linux zero-config confinement layer that are testable ANYWHERE:
 * core/sandbox-linux.ts's argv construction and path rejection, plus the STRUCTURAL contract of
 * backend/scripts/landlock-seccomp-shim.pl read as text.
 *
 * WHAT THIS SUITE CANNOT DO, SAID PLAINLY SO NOBODY READS A GREEN RUN AS MORE THAN IT IS.
 * It does not certify Landlock or seccomp. It cannot: those are kernel behaviours, and this suite runs
 * on whatever host CI or a developer happens to have (it was written on Windows). The kernel behaviour
 * is certified by .github/workflows/sandbox-parity.yml on real Linux runners, control vs confined,
 * same binary and same script - ubuntu-latest and ubuntu-22.04 across different Landlock ABIs,
 * both reporting writeOutside=EACCES and tcp=EACCES against a control that got OK and CONNECTED - and at
 * RUNTIME by probeLinuxZeroConf(), which spawns a real child under the real shim and refuses to report
 * 'active' unless that child was really refused.
 *
 * What IS pinned here is everything a mistake could make silently wrong without any kernel noticing:
 *   . the argv the shim is handed, including which token means what and in what order,
 *   . which paths are REJECTED rather than repaired,
 *   . the arch table, against numbers read out of real kernel headers,
 *   . the exit-code contract shared by the script and the module, and
 *   . the FAIL-CLOSED structure of the script: that no confinement step can fail and still reach exec.
 *
 * THE MEMBERSHIP GATES ARE EXACT-SET ASSERTIONS ON PURPOSE. The read-grant list and the arch table are
 * compared with deepStrictEqual, not with "contains", so ADDING a member turns this suite RED and forces
 * the addition through review. That is the only way a list like "the trees a plugin may read" stays a
 * decision instead of drifting into an accident - the day someone adds /home to it, the reason it is
 * absent (it is the operator's data, and the whole point of not using one read-only rule on `/`) is a
 * comment nobody reads, but a failing test is a comment nobody can skip.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    shimArgs,
    shimPath,
    SHIM_PATH,
    SHIM_EXIT,
    PERL_BIN,
    probeLinuxZeroConf,
    getLinuxZeroConfState,
} = require('../core/sandbox-linux');

const SHIM_SRC: string = fs.readFileSync(SHIM_PATH, 'utf8');
/**
 * The same script with its FULL-LINE comments removed. Every "this string must NOT appear" assertion
 * runs against THIS, because the header of the shim quotes the very failure modes it now prevents
 * ("the old script printed `landlock=off`", "WRITE_FILE without MAKE_CHAR/MAKE_BLOCK") - and a prose
 * explanation of a hole is not the hole. Assertions that something MUST appear keep using the raw
 * text, since a few of them deliberately pin a trailing comment that labels a BPF instruction.
 */
const SHIM_CODE: string = SHIM_SRC.split('\n').filter((l: string) => !/^\s*#/.test(l)).join('\n');

// A realistic zone set: EXACTLY the array plugin-isolate.ts builds (own dir + io-guard's SAFE_WRITE_DIRS).
const APP_ROOT = '/srv/wordjs/backend';
const ZONES = [
    `${APP_ROOT}/plugins/acme`,
    `${APP_ROOT}/uploads`, `${APP_ROOT}/data`, `${APP_ROOT}/logs`,
    `${APP_ROOT}/os-tmp`, `${APP_ROOT}/themes`,
];

describe('shimArgs — the argv is the confinement, so its shape is pinned', () => {
    test('emits read and executable roots, then zones, network policy, separator and command', () => {
        const argv = shimArgs({
            zone: ZONES,
            denyNetwork: true,
            readRoot: [APP_ROOT, '/opt/node-22'],
            execRoot: ['/usr/bin/node'],
            nodeArgs: ['/usr/bin/node', '--enable-source-maps', '/srv/wordjs/backend/dist/core/plugin-worker.js', '{}'],
        });
        assert.deepStrictEqual(argv, [
            SHIM_PATH,
            `--read-root=${APP_ROOT}`,
            '--read-root=/opt/node-22',
            '--exec-root=/usr/bin/node',
            ...ZONES,
            '1',
            '--',
            '/usr/bin/node', '--enable-source-maps', '/srv/wordjs/backend/dist/core/plugin-worker.js', '{}',
        ]);
    });

    test('the network flag is the LAST token before `--`, which is what makes a variable-length zone list unambiguous', () => {
        for (const zone of [[ZONES[0]], ZONES]) {
            const argv = shimArgs({ zone, denyNetwork: false, readRoot: APP_ROOT, nodeArgs: ['/usr/bin/node'] });
            const sep = argv.indexOf('--');
            assert.ok(sep > 0, 'there must be a `--` separator');
            assert.strictEqual(argv[sep - 1], '0', 'the token immediately before `--` is the network flag');
            // The zones occupy the slots between the last option and the flag, so the option sits TWO
            // places further back than the zone count: [.., --read-root, ...zones, flag, '--'].
            assert.deepStrictEqual(argv.slice(sep - 1 - zone.length, sep - 1), zone, 'the zones sit immediately before the flag');
            assert.strictEqual(argv[sep - 2 - zone.length], `--read-root=${APP_ROOT}`, 'the options sit in front of the zones');
        }
    });

    test('denyNetwork maps to exactly `1`/`0`, never a truthy string the shim would reject', () => {
        const on = shimArgs({ zone: ZONES[0], denyNetwork: true, nodeArgs: [] });
        const off = shimArgs({ zone: ZONES[0], denyNetwork: false, nodeArgs: [] });
        assert.strictEqual(on[on.indexOf('--') - 1], '1');
        assert.strictEqual(off[off.indexOf('--') - 1], '0');
        // The shim fails closed on anything that is not exactly '0' or '1'; a caller must never be able to
        // produce a third spelling by passing an odd truthy value.
        const weird = shimArgs({ zone: ZONES[0], denyNetwork: 'yes' as any, nodeArgs: [] });
        assert.strictEqual(weird[weird.indexOf('--') - 1], '1');
    });

    test('a single zone accepts the string spelling as well as the array', () => {
        assert.deepStrictEqual(
            shimArgs({ zone: ZONES[0], denyNetwork: true, nodeArgs: ['/usr/bin/node'] }),
            shimArgs({ zone: [ZONES[0]], denyNetwork: true, nodeArgs: ['/usr/bin/node'] }),
        );
    });

    test('duplicate zones and read roots collapse, preserving order', () => {
        const argv = shimArgs({
            zone: [ZONES[0], ZONES[1], ZONES[0]],
            readRoot: [APP_ROOT, APP_ROOT],
            denyNetwork: true,
            nodeArgs: [],
        });
        assert.deepStrictEqual(argv, [SHIM_PATH, `--read-root=${APP_ROOT}`, ZONES[0], ZONES[1], '1', '--']);
    });

    test('an unrepresentable zone is DROPPED, never repaired — the failure direction is more restrictive', () => {
        const argv = shimArgs({
            zone: [ZONES[0], 'relative/path', '/', '', null as any, 42 as any],
            denyNetwork: true,
            nodeArgs: ['/usr/bin/node'],
        });
        assert.deepStrictEqual(argv, [SHIM_PATH, ZONES[0], '1', '--', '/usr/bin/node']);
    });

    test('when EVERY zone is rejected the argv carries none, so the shim fails closed instead of guessing', () => {
        const argv = shimArgs({ zone: ['relative', '/'], denyNetwork: true, nodeArgs: ['/usr/bin/node'] });
        assert.deepStrictEqual(argv, [SHIM_PATH, '1', '--', '/usr/bin/node']);
        // And the script must treat "no zone" as fatal rather than as "confine nothing".
        assert.ok(/at least one writable zone is required/.test(SHIM_SRC),
            'the shim must refuse to run without a writable zone');
    });

    test('nothing in the argv can be mistaken for an option', () => {
        // Zones must be absolute, so a hostile plugin slug can never produce a token starting with `-`.
        assert.strictEqual(shimPath('--read-root=/etc'), null);
        assert.strictEqual(shimPath('-rf'), null);
        const argv = shimArgs({ zone: ['--read-root=/etc', ZONES[0]], denyNetwork: true, nodeArgs: [] });
        assert.ok(!argv.slice(1, argv.indexOf('--')).some((t: string) => t.startsWith('-') && !t.startsWith('--read-root=')),
            'no zone token may look like an option');
    });
});

describe('shimPath — the rejection boundary', () => {
    test('accepts an absolute path and strips one trailing separator', () => {
        assert.strictEqual(shimPath('/srv/app/uploads'), '/srv/app/uploads');
        assert.strictEqual(shimPath('/srv/app/uploads/'), '/srv/app/uploads');
    });
    test('rejects the values that would silently mean something else', () => {
        for (const bad of ['', '/', 'relative', './x', '../x', 'C:\\Windows', null, undefined, 42, {}, []]) {
            assert.strictEqual(shimPath(bad as any), null, `${JSON.stringify(bad)} must be rejected`);
        }
    });
    test('rejects control characters, which would break the single-line SHIM: diagnostic or the argv itself', () => {
        assert.strictEqual(shimPath('/srv/app/up\nloads'), null);
        assert.strictEqual(shimPath('/srv/app/up\u0000loads'), null);
        assert.strictEqual(shimPath('/srv/app/up\u007floads'), null);
        assert.strictEqual(shimPath('/srv/app/up\tloads'), null);
    });
    test('a UTF-8 directory name is fine — the filesystem really stores those', () => {
        assert.strictEqual(shimPath('/srv/app/plugins/café'), '/srv/app/plugins/café');
    });
});

describe('the shim script, read as text — the arch table', () => {
    // Read out of REAL kernel headers on a Linux host, not from memory:
    //   x86_64  /usr/include/x86_64-linux-gnu/asm/unistd_64.h
    //   aarch64 /usr/include/asm-generic/unistd.h  (aarch64 uses the asm-generic table verbatim)
    const VERIFIED: Record<string, { prctl: number; seccomp: number; socket: number; socketpair: number; clone: number; clone3: number; capset: number; setgroups: number; audit: number }> = {
        x86_64: { prctl: 157, seccomp: 317, socket: 41, socketpair: 53, clone: 56, clone3: 435, capset: 126, setgroups: 116, audit: 0xc000003e },
        aarch64: { prctl: 167, seccomp: 277, socket: 198, socketpair: 199, clone: 220, clone3: 435, capset: 91, setgroups: 159, audit: 0xc00000b7 },
    };

    test('exactly two architectures are supported, and ADDING one turns this red on purpose', () => {
        const arms = [...SHIM_SRC.matchAll(/\$arch eq '([a-z0-9_]+)'/g)].map((m) => m[1]);
        assert.deepStrictEqual(arms.sort(), Object.keys(VERIFIED).sort(),
            'a new architecture needs its syscall numbers read out of that arch\'s real header first — a wrong number does not fail loudly, it calls SOMETHING ELSE');
    });

    test('each arm carries the numbers the real headers report', () => {
        for (const [arch, n] of Object.entries(VERIFIED)) {
            const arm = new RegExp(`(?:if|elsif) \\(\\$arch eq '${arch}'\\) \\{([\\s\\S]*?)\\n\\}`)
                .exec(SHIM_SRC)?.[1];
            assert.ok(arm, `no arm for ${arch}`);
            const flat = arm!.replace(/\s+/g, ' ');
            assert.ok(flat.includes(`(${n.prctl}, ${n.seccomp}, ${n.socket}, ${n.socketpair}, ${n.clone}, ${n.clone3}, ${n.capset}, ${n.setgroups}, 0x${n.audit.toString(16)},`),
                `${arch} must carry the verified setup, socket and capability syscall numbers`);
            assert.match(flat, /@BLOCKED = \(/, `${arch} must carry its dangerous-syscall table`);
        }
    });

    test('an unknown architecture refuses to run rather than guessing', () => {
        assert.ok(/else \{ unsupported\(/.test(SHIM_SRC), 'the else arm must call unsupported(), not fall through');
    });

    test('the landlock syscall numbers are the shared asm-generic ones', () => {
        assert.ok(/\(\$NR_ll_create, \$NR_ll_add, \$NR_ll_restrict\) = \(444, 445, 446\)/.test(SHIM_SRC));
    });
});

describe('the shim script, read as text — FAIL CLOSED', () => {
    test('the exit-code contract in the script and in the module are the same numbers', () => {
        assert.deepStrictEqual(Object.keys(SHIM_EXIT).sort(), ['EXEC', 'FAIL', 'UNSUPPORTED']);
        assert.ok(SHIM_SRC.includes(`my $EX_UNSUPPORTED = ${SHIM_EXIT.UNSUPPORTED};`));
        assert.ok(SHIM_SRC.includes(`my $EX_FAIL        = ${SHIM_EXIT.FAIL};`));
        assert.ok(SHIM_SRC.includes(`my $EX_EXEC        = ${SHIM_EXIT.EXEC};`));
        // The three codes must be distinct, or the probe cannot tell 'unsupported' from 'degraded'.
        assert.strictEqual(new Set(Object.values(SHIM_EXIT)).size, 3);
    });

    test('there is exactly ONE exec, and it is the last thing the script does', () => {
        const lines = SHIM_SRC.split('\n');
        const execLines = lines
            .map((l, i) => ({ l: l.trim(), i }))
            .filter((x) => /^exec\b/.test(x.l) || /^\s*exec \{/.test(x.l));
        assert.strictEqual(execLines.length, 1, 'a second exec is a second, unreviewed way to launch the child');
        // Everything after it must be the FAILURE path only.
        const after = lines.slice(execLines[0].i + 1).join('\n');
        assert.ok(/SHIM-FAIL: exec/.test(after) && /exit \$EX_EXEC/.test(after),
            'the lines after exec are the failure path and must stay');
    });

    test('exec uses the block form, so a single-element command can never reach /bin/sh', () => {
        // `exec @cmd` with one element is checked by Perl for shell metacharacters and handed to /bin/sh
        // when it finds any — inserting a shell into a confinement boundary on exactly the inputs an
        // attacker would choose.
        assert.ok(/exec \{ \$cmd\[0\] \} @cmd;/.test(SHIM_SRC));
        assert.ok(!/\bexec @ARGV\b/.test(SHIM_CODE), 'the old list form must be gone');
    });

    test('an absent Landlock is UNSUPPORTED and stops — it must never degrade into running the child bare', () => {
        // This is the defect the committed version had: `$landlock = "off"` and carry on to exec. It was
        // demonstrated, not theorised — with the landlock syscall numbers bent to nonexistent ones the old
        // script printed `landlock=off seccomp=off`, ran the target, wrote a file OUTSIDE its zone and
        // exited 0.
        assert.ok(/unsupported\("landlock_create_ruleset is unavailable/.test(SHIM_SRC));
        assert.ok(!/\$landlock\s*=\s*'off'/.test(SHIM_CODE), 'there must be no "landlock is off, carry on" state');
        assert.ok(!/landlock=off/.test(SHIM_CODE), 'the script must not be able to REPORT an off landlock');
    });

    test('every confinement step that can fail is followed by a hard stop', () => {
        const required = [
            /\$rfd\s*=\s*syscall\(\$NR_ll_create[\s\S]{0,300}?fail\("landlock_create_ruleset/,
            /\$grant->\(\$r, \$read_access\) or fail\("cannot grant the read root/,
            /\$grant->\(\$z, \$ZONE_ACC\) or fail\("cannot grant the writable zone/,
            /PR_SET_NO_NEW_PRIVS[\s\S]{0,80}?or fail\("prctl\(NO_NEW_PRIVS\)/,
            /\$NR_ll_restrict[\s\S]{0,60}?or fail\("landlock_restrict_self/,
            /\$NR_seccomp[\s\S]{0,60}?or fail\("seccomp/,
        ];
        for (const re of required) {
            assert.ok(re.test(SHIM_SRC), `a confinement step is missing its hard stop: ${re}`);
        }
    });

    test('the argument grammar is validated before anything is confined', () => {
        for (const re of [
            /expected `--` before the command/,
            /no command given after `--`/,
            /must be the network flag, 0 or 1/,
            /paths must be absolute/,
            /`\/` is never a valid zone or read root/,
        ]) {
            assert.ok(re.test(SHIM_SRC), `missing argument check: ${re}`);
        }
    });
});

describe('the shim script, read as text — what the child may READ', () => {
    // The read list is "the operating system", NOT "the whole filesystem" and NOT "the paths Node
    // happens to touch". One read-only rule on `/` would be simpler and
    // strictly worse: it exposes the operator's home directory, their ssh keys and every other site's
    // document root for reading. Enumerating only Node's paths would be tighter and also worse: the set
    // differs by distro and by Node version, so one missing entry is a child that never reaches
    // JavaScript and a failure that looks like "Landlock is broken here".
    const EXPECTED_READ_TREES = [
        '/usr/lib', '/usr/lib64', '/lib', '/lib64', '/lib32', '/libx32',
        '/usr/share/zoneinfo', '/usr/share/locale', '/usr/share/icu',
        '/etc/ssl', '/etc/ca-certificates', '/etc/localtime', '/etc/hosts', '/etc/nsswitch.conf', '/etc/resolv.conf', '/etc/gai.conf',
        '/proc/self', '/proc/thread-self', '/sys/devices/system/cpu', '/nix/store',
    ];
    // Absent BY DECISION. Each of these is the operator's data, not the OS.
    const MUST_NOT_BE_READABLE = ['/home', '/root', '/srv', '/media', '/mnt', '/tmp', '/var/tmp', '/var/www', '/var/backups'];

    function readTrees(): string[] {
        const m = /my @READ_TREES = qw\(([\s\S]*?)\);/.exec(SHIM_SRC);
        assert.ok(m, 'the read list must stay a single qw() so it can be reviewed as one thing');
        return m![1].split(/\s+/).filter(Boolean);
    }

    test('the read list is EXACTLY this set — adding a member turns this red', () => {
        assert.deepStrictEqual(readTrees(), EXPECTED_READ_TREES);
    });

    test('no tree holding the operator\'s data is readable', () => {
        const trees = readTrees();
        for (const forbidden of MUST_NOT_BE_READABLE) {
            assert.ok(!trees.includes(forbidden),
                `${forbidden} is the operator's data, not the OS — granting it would give a plugin their home directory, ssh keys or another site's document root`);
        }
    });

    test('/dev is never granted as a tree; only four harmless literal devices are exposed', () => {
        assert.ok(!/\$grant->\('\/dev',/.test(SHIM_SRC), 'the /dev tree would expose raw and future devices');
        for (const d of ['/dev/urandom', '/dev/random', '/dev/zero', '/dev/null']) {
            assert.ok(SHIM_SRC.includes(d), `${d} must be handled as a literal`);
        }
        assert.ok(/'\/dev\/null', \$FS_READ_FILE \| \$FS_WRITE_FILE/.test(SHIM_SRC));
        assert.ok(!/\$ZONE_ACC[\s\S]{0,250}?MAKE_CHAR|\$ZONE_ACC[\s\S]{0,250}?MAKE_BLOCK/.test(SHIM_SRC),
            'writable storage must never receive device-node creation rights');
    });

    test('read roots do not execute, executable roots are separate, and writable zones are W^X', () => {
        assert.ok(/my \$RO = \$FS_READ_FILE \| \$FS_READ_DIR;/.test(SHIM_SRC));
        assert.ok(/my \$read_access = -d \$r \? \$RO : \$FS_READ_FILE;/.test(SHIM_SRC),
            'a literal file read root must not inherit the directory-enumeration right');
        assert.ok(/my \$RX_FILE = \$FS_READ_FILE \| \$FS_EXECUTE;/.test(SHIM_SRC));
        assert.ok(/\$grant->\(\$r, \$read_access\) or fail\("cannot grant the read root/.test(SHIM_SRC));
        assert.ok(/\$grant->\(\$r, \$RX_FILE\) or fail\("cannot grant the executable root/.test(SHIM_SRC));
        const zoneExpr = /my \$ZONE_ACC =([\s\S]*?);\nfor my \$z/.exec(SHIM_SRC)?.[1] || '';
        assert.ok(zoneExpr.length > 0 && !zoneExpr.includes('$FS_EXECUTE'),
            'a zone the plugin can write must not also be executable');
    });

    test('application paths are never hardcoded — narrow roots arrive from the caller', () => {
        const trees = readTrees();
        assert.ok(!trees.some((t) => /wordjs|backend|plugins|themes/.test(t)),
            'narrow application roots arrive as --read-root / WORDJS_READ_ROOT, so this module never guesses where WordJS is installed');
        assert.ok(/--read-root=\(\.\*\)\$/.test(SHIM_SRC) || /read-root=/.test(SHIM_SRC));
        assert.ok(/\$ENV\{WORDJS_READ_ROOT\}/.test(SHIM_SRC), 'the env spelling the CI workflow uses must keep working');
    });
});

describe('the shim script, read as text — the network denial', () => {
    test('denied plugins cannot create any socket; granted plugins get only AF_INET/AF_INET6 clients', () => {
        assert.match(SHIM_SRC, /if \(\$denyNet eq '1'\) \{[\s\S]*?\$NR_socket[\s\S]*?\$NR_socketpair/,
            'the denied shape must refuse both socket creation entry points');
        assert.match(SHIM_SRC, /args\[0\][\s\S]*?\[0x15, 0, 0, 2\][\s\S]*?\[0x15, 0, 0, 10\]/,
            'the granted shape must allow only AF_INET and AF_INET6');
        assert.match(SHIM_SRC, /all other families -> EACCES/);
        assert.match(SHIM_SRC, /\$NR_socketpair/);
        assert.ok(/0x0005000d/.test(SHIM_SRC), 'the refusal must be SECCOMP_RET_ERRNO(EACCES=13), which is what the probe requires to see');
    });

    test('a wrong-architecture caller is KILLED, not allowed', () => {
        assert.match(SHIM_SRC, /\[0x15, 1, 0, \$AUDIT_ARCH\][\s\S]{0,100}?\[0x06, 0, 0, 0\]/);
    });

    test('dangerous syscalls are filtered for both network-policy shapes', () => {
        const beforeNetworkBranch = SHIM_SRC.slice(0, SHIM_SRC.indexOf("if ($denyNet eq '1')"));
        assert.match(beforeNetworkBranch, /for my \$nr \(sort \{ \$a <=> \$b \} @BLOCKED\)/);
        assert.match(SHIM_SRC, /0x00050001/, 'dangerous syscalls must return EPERM');
        assert.match(SHIM_SRC, /seccomp=on\//, 'the diagnostic must never report seccomp off');
    });

    test('process creation is denied while CLONE_THREAD remains available to Node', () => {
        assert.match(SHIM_SRC, /0x00010000[^\n]*CLONE_THREAD/,
            'clone flags must be reduced to CLONE_THREAD before a clone is allowed');
        assert.match(SHIM_SRC, /process clone -> EPERM/);
        assert.match(SHIM_SRC, /\$NR_clone3[\s\S]{0,180}?inspectable clone\(\) fallback/,
            'clone3 flags live behind a pointer, so it must be forced through inspectable clone()');
        assert.match(SHIM_SRC, /0x00050026[^\n]*ENOSYS/);
        const x86Arm = /if \(\$arch eq 'x86_64'\) \{([\s\S]*?)\nelsif/.exec(SHIM_SRC)?.[1] || '';
        assert.match(x86Arm, /\b57, 58,/, 'x86 fork and vfork syscall numbers must be in the always-on denylist');
    });

    test('anonymous executable and namespace escape paths are in both architecture denylists', () => {
        const x86Arm = /if \(\$arch eq 'x86_64'\) \{([\s\S]*?)\nelsif/.exec(SHIM_SRC)?.[1] || '';
        const arm64Arm = /elsif \(\$arch eq 'aarch64'\) \{([\s\S]*?)\n\}/.exec(SHIM_SRC)?.[1] || '';
        for (const nr of [319, 322, 272]) assert.match(x86Arm, new RegExp(`\\b${nr}\\b`), `x86_64 syscall ${nr} must be denied`);
        for (const nr of [279, 281, 97]) assert.match(arm64Arm, new RegExp(`\\b${nr}\\b`), `aarch64 syscall ${nr} must be denied`);
        assert.match(SHIM_SRC, /Anonymous executable creation \/ alternate exec/);
    });

    test('x86_64 denies the x32 ABI instead of letting it bypass the syscall table', () => {
        assert.match(SHIM_SRC, /0x40000000/);
        assert.match(SHIM_SRC, /deny the complete x32 ABI range/);
    });

    test('Landlock ABI 4 adds a SECOND, independent TCP denial, and only when the network is denied', () => {
        assert.ok(/\$handle_net = \(\$denyNet eq '1' && \$abi >= 4\) \? 1 : 0;/.test(SHIM_SRC),
            'a network-GRANTED plugin must not get the Landlock net restriction');
        assert.ok(/\$NET_BIND_TCP \| \$NET_CONNECT_TCP/.test(SHIM_SRC));
        // And seccomp must still be there, because Landlock's network hook is SOCK_STREAM only — it does
        // not see UDP, and therefore does not see DNS.
        assert.ok(/SOCK_STREAM only/.test(SHIM_SRC), 'the reason seccomp is still needed must stay written down');
    });

    test('the ABI ladder is asked for exactly what each kernel knows', () => {
        assert.ok(/\$HANDLED = \$abi >= 5 \? 0xffff : \(\$abi >= 3 \? 0x7fff : \(\$abi >= 2 \? 0x3fff : 0x1fff\)\);/.test(SHIM_SRC),
            'asking for bits a kernel does not know makes create_ruleset reject the whole request with E2BIG');
        assert.match(SHIM_SRC, /\$abi >= 5 \? \$FS_IOCTL_DEV : 0/,
            'ABI 5 IOCTL_DEV must be handled and granted only to the /dev/null literal');
    });

    test('privileged service launches irreversibly shed every Linux capability before exec', () => {
        assert.match(SHIM_SRC, /syscall\(\$NR_setgroups, 0, 0\)/);
        assert.match(SHIM_SRC, /PR_SET_SECUREBITS, 15/);
        assert.match(SHIM_SRC, /for my \$cap \(0 \.\. 63\)/);
        assert.match(SHIM_SRC, /syscall\(\$NR_capset, \$cap_header, \$cap_data\)/);
        assert.match(SHIM_SRC, /qw\(CapInh CapPrm CapEff CapBnd CapAmb\)/,
            'all capability sets, including bounding and ambient, must be verified empty');
    });

    test('Landlock ABI 6 scopes abstract Unix sockets and cross-process signals', () => {
        assert.match(SHIM_SRC, /my \$scoped = \$abi >= 6 \? 3 : 0/);
        assert.match(SHIM_SRC, /pack\("QQQ", \$HANDLED,[\s\S]*?\$scoped\)/);
    });
});

describe('probeLinuxZeroConf — off Linux it reports the truth and spawns nothing', () => {
    test('a non-Linux host is `unsupported`, never `active`', async (t: any) => {
        if (process.platform === 'linux') { t.skip('this leg asserts the off-Linux answer'); return; }
        const state = await probeLinuxZeroConf();
        assert.strictEqual(state, 'unsupported');
        assert.strictEqual(getLinuxZeroConfState(), 'unsupported');
    });

    test('the interpreter is an absolute literal, never PATH-resolved', () => {
        assert.strictEqual(PERL_BIN, '/usr/bin/perl');
        assert.ok(path.isAbsolute(PERL_BIN));
    });

    test('the shim path resolves inside backend/scripts and the file is really there', () => {
        assert.ok(SHIM_PATH.replace(/\\/g, '/').endsWith('/backend/scripts/landlock-seccomp-shim.pl'), SHIM_PATH);
        assert.ok(fs.existsSync(SHIM_PATH));
    });
});

/**
 * The dynamic leg. It only runs where it can mean something — a Linux host with perl — and it exercises
 * the FAIL-CLOSED contract for real: bad argv must exit 79 having exec'd nothing, and a working host must
 * confine a real child. Skipped everywhere else rather than faked, because a test that pretends to have
 * measured a kernel is worse than no test.
 */
describe('the shim, actually run (Linux + perl only)', () => {
    const canRun = process.platform === 'linux' && fs.existsSync(PERL_BIN);
    const { spawnSync } = require('child_process');

    function run(args: string[]) {
        return spawnSync(PERL_BIN, [SHIM_PATH, ...args], { encoding: 'utf8', timeout: 20000 });
    }

    test('every argument-level failure exits 79 WITHOUT running the command', (t: any) => {
        if (!canRun) { t.skip('needs Linux + /usr/bin/perl'); return; }
        const marker = 'WJS-SHOULD-NEVER-PRINT';
        const cases: string[][] = [
            ['/tmp', '1', '/bin/echo', marker],                    // no `--`
            ['/tmp', '1', '--'],                                   // no command
            ['/tmp', 'yes', '--', '/bin/echo', marker],            // bad flag
            ['1', '--', '/bin/echo', marker],                      // no zone
            ['relative', '1', '--', '/bin/echo', marker],          // relative zone
            ['/', '1', '--', '/bin/echo', marker],                 // zone is /
            ['/nonexistent-wjs-zone', '1', '--', '/bin/echo', marker], // a zone that will not grant
        ];
        for (const args of cases) {
            const r = run(args);
            assert.strictEqual(r.status, SHIM_EXIT.FAIL, `expected exit ${SHIM_EXIT.FAIL} for ${JSON.stringify(args)}; got ${r.status} / ${r.stderr}`);
            assert.ok(!String(r.stdout).includes(marker), `the command RAN despite a failed confinement: ${JSON.stringify(args)}`);
        }
    });
});
