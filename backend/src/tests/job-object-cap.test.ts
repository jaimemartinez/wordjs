/**
 * Windows-only: proves the PREVENTIVE Job Object memory cap actually BITES. Forks a child that, on a
 * go-signal, commits 1 MB off-heap Buffers up to 600 MB; assigns it to a 200 MB-capped Job Object via
 * the SAME helper the sandbox uses (plugin-isolate.assignProcessToJobObject), then asserts the kernel
 * kills the child before it reaches the post-cap target. Off-heap on purpose — it exercises the TOTAL
 * commit cap, not the V8 heap flag. Skipped on non-win32 (the feature is Windows-only; CI runs Linux).
 */
const { test } = require('node:test');
const assert = require('node:assert');

test('Windows Job Object cap kills a child that commits past ProcessMemoryLimit', { skip: process.platform !== 'win32' ? 'win32-only feature' : false }, async () => {
    const { spawn } = require('child_process');
    const { assignProcessToJobObject } = require('../core/plugin-isolate');

    // Child: wait for the first stdin chunk, then commit 1 MB Buffers up to 600 MB, logging progress.
    // A 200 MB job cap must stop it well before the target. Whether the over-budget allocation surfaces
    // as a catchable RangeError or a fatal V8 OOM is nondeterministic, so the EXIT CODE is not a reliable
    // signal — the reliable proof is that it committed real memory yet never reached the target. Safety
    // net: self-exit after 25 s so a mis-wired test can never hang the suite.
    const BALLOON =
        'process.stdin.resume();setTimeout(function(){process.exit(2);},25000);' +
        "process.stdin.once('data',function(){var a=[];var i=0;try{for(i=1;i<=600;i++){a.push(Buffer.alloc(1048576,1));if(i%25===0)console.log('committed '+i);}console.log('REACHED_TARGET');}catch(e){console.log('ALLOC_FAILED '+i);}process.exit(0);});";

    const child = spawn(process.execPath, ['-e', BALLOON], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d: any) => { out += String(d); });

    const assigned = await assignProcessToJobObject(child.pid, 200 * 1024 * 1024);
    assert.strictEqual(assigned, true, 'helper reported the child assigned to a memory-capped Job Object');

    child.stdin.write('go\n'); // release the balloon now that it is capped
    await new Promise((res) => child.on('exit', () => res(null)));

    assert.ok(/committed 100/.test(out), `child must have committed real memory (>=100 MB) before being capped (out=${JSON.stringify(out)})`);
    assert.ok(!/REACHED_TARGET/.test(out), `cap MUST stop the child before 600 MB (out=${JSON.stringify(out)})`);
});
