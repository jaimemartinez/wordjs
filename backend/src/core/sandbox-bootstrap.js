/**
 * macOS one-shot executable handshake.
 *
 * Seatbelt must allow sandbox-exec to exec the initial Node image. This preload runs before the plugin
 * worker, tells the host that Node has mapped that image, and blocks until the host unlinks the private
 * executable copy. Once released, the literal process-exec allowance names no existing path, so plugin
 * code cannot replace itself with a fresh Node that omitted the permission flags and runtime guards.
 */
'use strict';

if (process.env.WORDJS_SEATBELT_BOOTSTRAP === '1') {
    const fs = require('fs');
    const readyFd = Number(process.env.WORDJS_SEATBELT_READY_FD || '4');
    const releaseFd = Number(process.env.WORDJS_SEATBELT_RELEASE_FD || '5');
    const ack = Buffer.alloc(1);
    try {
        fs.writeSync(readyFd, Buffer.from('R'));
        const n = fs.readSync(releaseFd, ack, 0, 1, null);
        if (n !== 1 || ack[0] !== 0x47) throw new Error('invalid release acknowledgement');
    } catch (error) {
        try { process.stderr.write(`[Sandbox] Seatbelt bootstrap failed: ${error && error.message}\n`); } catch { /* */ }
        process.exit(126);
    }
    delete process.env.WORDJS_SEATBELT_BOOTSTRAP;
    delete process.env.WORDJS_SEATBELT_READY_FD;
    delete process.env.WORDJS_SEATBELT_RELEASE_FD;
}
