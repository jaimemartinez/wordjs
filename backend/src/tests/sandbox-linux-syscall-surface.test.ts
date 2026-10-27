/**
 * The Linux floor refuses the syscalls Landlock does not govern, and hands the child nothing else.
 *
 *   · Another process's limits, priority and scheduling (prlimit64, setpriority, ioprio_set, sched_set*):
 *     refused unless the pid argument is 0 - the child keeps its own.
 *   · semtimedop, mount_setattr, quotactl_fd, statmount, listmount, lsm_set_self_attr: refused.
 *   · chmod/chown/xattr by path (Landlock has no such rights at any ABI): refused; fchmod stays,
 *     because libuv's copyFile uses it on the descriptor it just created. Timestamps stay settable:
 *     copyFile stamps the copy too, and the probe certifies that a copy works inside the sandbox.
 *   · fcntl F_SETOWN/F_SETOWN_EX and ioctl FIOSETOWN/SIOCSPGRP (choosing who gets SIGIO): refused.
 *   · Landlock ABI < 3 cannot refuse truncation: truncate(2) and an O_RDONLY|O_TRUNC open are refused by
 *     seccomp there (openat2, whose flags BPF cannot see, answers ENOSYS).
 *   · Every inherited descriptor but stdio and the IPC channel is closed, and the child starts in `/`.
 * The kernel enforcement of each row is certified by the probe on real Linux (Sandbox parity); this
 * suite pins the shim's tables and the probe's checks on every platform.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';

const linux = require('../core/sandbox-linux');
const SHIM = fs.readFileSync(linux.SHIM_PATH, 'utf8');
const x86 = /if \(\$arch eq 'x86_64'\) \{([\s\S]*?)\nelsif/.exec(SHIM)?.[1] || '';
const arm = /elsif \(\$arch eq 'aarch64'\) \{([\s\S]*?)\n\}/.exec(SHIM)?.[1] || '';
const blocked = (arch: string) => {
    const list = /@BLOCKED = \(([\s\S]*?)\n {4}\);/.exec(arch)?.[1] || '';
    return new Set(list.replace(/#[^\n]*/g, '').split(/[\s,]+/).filter(Boolean).map(Number));
};

test('the missing calls are on both architectures\' denylists', () => {
    const X = blocked(x86), A = blocked(arm);
    // x86_64: semtimedop, mount_setattr, quotactl_fd, statmount, listmount, lsm_set_self_attr.
    for (const nr of [220, 442, 443, 457, 458, 460]) assert.ok(X.has(nr), `x86_64 ${nr}`);
    // aarch64 already had semtimedop (192) in its SysV block.
    for (const nr of [192, 442, 443, 457, 458, 460]) assert.ok(A.has(nr), `aarch64 ${nr}`);
});

test('mode, owner, timestamp and xattr changes by path are refused; fchmod is kept for copyFile', () => {
    const X = blocked(x86), A = blocked(arm);
    for (const nr of [90, 268, 452, 92, 93, 94, 260, 188, 189, 190, 197, 198, 199]) assert.ok(X.has(nr), `x86_64 ${nr}`);
    // Timestamps stay settable: libuv's copyFile stamps the copy through utimensat on its descriptor.
    for (const nr of [132, 235, 261, 280]) assert.ok(!X.has(nr), `x86_64 ${nr} (timestamps) must stay allowed`);
    for (const nr of [53, 452, 54, 55, 5, 6, 7, 14, 15, 16]) assert.ok(A.has(nr), `aarch64 ${nr}`);
    assert.ok(!A.has(88), 'aarch64 utimensat (timestamps) must stay allowed');
    assert.ok(!X.has(91), 'x86_64 fchmod stays (libuv copyFile)');
    assert.ok(!A.has(52), 'aarch64 fchmod stays (libuv copyFile)');
});

test('another process\'s limits, priority and scheduling are refused, the child\'s own are not', () => {
    assert.match(x86, /@PID_ARG = \(\[302, 0\], \[141, 1\], \[251, 1\], \[142, 0\], \[144, 0\], \[203, 0\], \[314, 0\]\);/);
    assert.match(arm, /@PID_ARG = \(\[261, 0\], \[140, 1\], \[30, 1\], \[118, 0\], \[119, 0\], \[122, 0\], \[274, 0\]\);/);
    assert.match(SHIM, /push @p, \[0x15, 1, 0, 0\]; {12}# pid 0 \(self\) skips the denial/);
});

test('F_SETOWN and its ioctl twins are refused', () => {
    assert.match(x86, /@CMD_ARG = \(\[72, 1, 8, 15\], \[16, 1, 0x8901, 0x8902\]\);/);
    assert.match(arm, /@CMD_ARG = \(\[25, 1, 8, 15\], \[29, 1, 0x8901, 0x8902\]\);/);
});

test('below Landlock ABI 3, truncation of a read-only file is refused by seccomp', () => {
    assert.match(SHIM, /my \$trunc_cover = \$abi < 3 \? 1 : 0;/);
    assert.match(SHIM, /push @p, \[0x54, 0, 0, 01003\]; {5}# A &= O_ACCMODE \| O_TRUNC/);
    assert.match(SHIM, /push @p, \[0x15, 0, 0, 01000\]; {5}# O_RDONLY \| O_TRUNC -> EPERM/);
    assert.match(x86, /@OPEN_FLAGS_ARG = \(\[2, 1\], \[257, 2\]\);/);
    assert.match(arm, /@OPEN_FLAGS_ARG = \(\[56, 2\]\);/);
    assert.match(SHIM, /push @enosys_jumps, scalar\(@p\);\r?\n {4}push @p, \[0x15, 0, 0, \$NR_openat2\];/);
    assert.match(SHIM, /\(\$trunc_cover \? '\+trunc' : ''\)/, 'the SHIM: line says when the cover is active');
});

test('a filter too long for its 8-bit jumps refuses to install instead of jumping elsewhere', () => {
    assert.match(SHIM, /fail\("seccomp filter too long for its jumps \(\$far\)"\) if \$p\[\$i\]->\[0\] != 0x05 && \$far > 255;/);
});

test('inherited descriptors are closed and the child starts in /', () => {
    assert.match(SHIM, /opendir\(my \$dh, '\/proc\/self\/fd'\)/);
    assert.match(SHIM, /syscall\(\$NR_close, 0 \+ \$fd\) if \$fd > 2 && \$fd != \$chan;/);
    assert.match(SHIM, /chdir\('\/'\) or fail\("chdir \/: \$!"\);/);
    assert.match(x86, /\$NR_close = 3;/);
    assert.match(arm, /\$NR_close = 57;/);
    // The close runs after seccomp is installed (close is allowed) and right before the exec.
    assert.ok(SHIM.indexOf("opendir(my $dh, '/proc/self/fd')") > SHIM.indexOf('seccomp(SET_MODE_FILTER)'));
    assert.ok(SHIM.indexOf("opendir(my $dh, '/proc/self/fd')") < SHIM.indexOf('exec { $cmd[0] } @cmd;'));
});

test('the probe proves each row on the kernel: another pid\'s priority, truncation, chmod, a leaked fd', () => {
    const src = String(linux.__probeSrc);
    assert.match(src, /os\.setPriority\(victim,19\)/);
    assert.match(src, /os\.setPriority\(0,os\.getPriority\(0\)\)/, 'its own priority stays settable');
    assert.match(src, /fs\.constants\.O_RDONLY\|fs\.constants\.O_TRUNC/);
    assert.match(src, /fs\.chmodSync\(inside,384\)/);
    assert.match(src, /fs\.copyFileSync\(inside,inside\+"\.copy"\)/, 'a copy inside the zone is part of the certified surface');
    assert.match(src, /fs\.fstatSync\(32\)/);
    assert.match(src, /fs\.fchmodSync\(pfd,448\)/, 'the W^X row still makes its payload executable, with the call that remains');
    const mod = fs.readFileSync(require('path').join(__dirname, '..', 'core', 'sandbox-linux.ts'), 'utf8');
    // The extra fd sits far above what Node opens at startup, so Node can never reuse its number.
    const stdio = linux.__probeStdio();
    assert.strictEqual(stdio.length, 33);
    assert.deepStrictEqual(stdio.slice(0, 4), ['ignore', 'ignore', 'pipe', 'ipc']);
    assert.strictEqual(stdio[32], 'pipe', 'the probe hands the child an extra fd 32 to be closed');
    assert.ok(stdio.slice(4, 32).every((x: string) => x === 'ignore'));
    assert.match(mod, /stdio: probeStdio\(\)/);
    assert.match(mod, /m\.fdCode === 'EBADF'/);
    assert.match(mod, /&& m\.copyCode === 'OK'\)/);
    assert.match(mod, /&& confinedSurface && tunnelOk\)/, 'the confined leg must pass the syscall-surface checks to certify');
    assert.doesNotThrow(() => new Function(src));
});

test('the kernel rlimit caps are set by prlimit from a system path, with no shell in the launch', () => {
    const iso = require('../core/plugin-isolate');
    assert.deepStrictEqual(iso.__rlimitArgs(1024, true), ['--as=1048576', '--nofile=4096', '--']);
    assert.deepStrictEqual(iso.__rlimitArgs(1024, false), ['--as=1048576', '--']);
    for (const p of iso.__prlimitCandidates) assert.ok(require('path').posix.isAbsolute(p), `${p} is a fixed absolute path`);
    const mod = fs.readFileSync(require('path').join(__dirname, '..', 'core', 'plugin-isolate.ts'), 'utf8');
    assert.doesNotMatch(mod, /spawn\('sh'/, 'no isolated-plugin launch goes through a shell');
    assert.match(mod, /spawn\(prlimitPath\(\) as string, \[\.\.\.rlimitArgs\(capKb, osCapNofile\), \.\.\.nodeArgv\]/);
});
