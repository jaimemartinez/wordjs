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
