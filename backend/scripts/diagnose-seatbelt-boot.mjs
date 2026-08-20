#!/usr/bin/env node
/** Bounded macOS-only differential used after a parity failure; it never changes production policy. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mac = require('../dist/core/sandbox-macos.js');
const dir = mkdtempSync(join(tmpdir(), 'wjs-seatbelt-diagnostic-'));
const home = process.env.HOME || '';
const literal = (value) => JSON.stringify(value);
const base = mac.buildSeatbeltProfile({
  appRoot: process.cwd(),
  nodePath: process.execPath,
  writableDirs: [dir],
  readOnlyDirs: [],
  denyNetwork: true,
  logDenials: true,
});

const variants = [
  ['base/no-ipc', '', false],
  ['base/ipc', '', true],
  ['file-read-all/ipc', '(allow file-read-data)', true],
  ['file-write-all/ipc', '(allow file-write-data)', true],
  ['user-encoding/ipc', `(allow file-read-data (literal ${literal(join(home, '.CFUserTextEncoding'))}))`, true],
  ['user-global-prefs/ipc', `(allow file-read-data (literal ${literal(join(home, 'Library/Preferences/.GlobalPreferences.plist'))}))`, true],
  ['library-global-prefs/ipc', '(allow file-read-data (literal "/Library/Preferences/.GlobalPreferences.plist") (literal "/Library/Managed Preferences/.GlobalPreferences.plist"))', true],
  ['library-apple-frameworks/ipc', '(allow file-read* (subpath "/Library/Apple/System/Library/Frameworks") (subpath "/Library/Apple/System/Library/PrivateFrameworks"))', true],
  ['private-etc/ipc', '(allow file-read-data (subpath "/private/etc"))', true],
  ['private-var/ipc', '(allow file-read-data (subpath "/private/var"))', true],
  ['system/ipc', '(allow file-read-data (subpath "/System"))', true],
  ['usr/ipc', '(allow file-read-data (subpath "/usr"))', true],
  ['user-home/ipc', `(allow file-read-data (subpath ${literal(home)}))`, true],
  ['vnode-socket/ipc', '(allow file-read-data (vnode-type SOCKET))', true],
  ['vnode-fifo/ipc', '(allow file-read-data (vnode-type FIFO))', true],
  ['non-regular/ipc', '(allow file-read-data (require-not (vnode-type REGULAR-FILE)))', true],
  ['non-content-vnode/ipc', '(allow file-read-data (require-all (require-not (vnode-type REGULAR-FILE)) (require-not (vnode-type DIRECTORY)) (require-not (vnode-type SYMLINK)) (require-not (vnode-type BLOCK-DEVICE)) (require-not (vnode-type CHARACTER-DEVICE))))', true],
  ['network/ipc', '(allow network*)', true],
  ['file-data/ipc', '(allow file-read-data file-write-data)', true],
  ['system-socket/ipc', '(allow system-socket)', true],
  ['posix-ipc/ipc', '(allow ipc-posix-shm)\n(allow ipc-posix-sem)', true],
  ['same-domain-mach/ipc', '(allow mach-priv-task-port (target same-sandbox))', true],
  ['reference-baseline/ipc', [
    '(allow network*)',
    '(allow file-read-data file-write-data)',
    '(allow system-socket)',
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow mach-priv-task-port (target same-sandbox))',
    '(allow iokit-get-properties)',
    '(allow user-preference-read)',
  ].join('\n'), true],
  ['permissive-control/ipc', '(allow default)', true],
];

function run(label, extra, ipc) {
  return new Promise((resolve) => {
    const source = ipc
      ? 'if(!process.send)process.exit(31);process.send({boot:true},()=>process.exit(0))'
      : 'process.stdout.write("BOOT")';
    const stdio = ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'];
    const child = spawn(mac.SEATBELT_BIN, ['-p', `${base}\n${extra}`, process.execPath, '-e', source], {
      stdio,
      timeout: 5000,
    });
    let stdout = '', stderr = '', message = null;
    child.stdout?.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-256); });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-512); });
    child.on('message', (value) => { message = value; });
    child.on('error', (error) => resolve({ label, error: error.message }));
    child.on('close', (code, signal) => resolve({ label, code, signal: signal || '', stdout, stderr, message }));
  });
}

try {
  for (const [label, extra, ipc] of variants) {
    console.log(JSON.stringify(await run(label, extra, ipc)));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
