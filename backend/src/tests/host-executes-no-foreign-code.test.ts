/**
 * THE ONE PROPERTY THE WHOLE SANDBOX RESTS ON: the host process never executes third-party code.
 *
 * Landlock, Seatbelt and AppContainer confine a CHILD. None of them protects anything if the code ends
 * up running in the parent instead — and this repository has been there. Themes used to execute their
 * `functions.js` on the host main thread, where there is no eval/Function/dynamic-import guard, and a
 * malicious theme reached host RCE (audit #6/#7/#8/#9/#20). The fix, on 2026-07-18, was to load theme
 * logic through `loadIsolatedPlugin('theme:<slug>', …)` — the same fork and the same OS confinement a
 * plugin gets. In-process plugin loading was removed outright: a plugin must declare `"isolated": true`
 * or it is skipped.
 *
 * All of that is true today and NONE of it was checked. What was checked was nothing; what existed was
 * prose — and two of those comments still asserted the pre-2026-07-18 world, naming the static scanner
 * as the only thing standing between a theme and host RCE. A comment about where a trust boundary sits
 * is part of the boundary, and a boundary nothing tests is a boundary that moves.
 *
 * These are structural checks over the source, not behavioural ones, and that is deliberate: the
 * property is "there is no such code path", which you demonstrate by its absence, not by exercising it.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const CORE = path.resolve(__dirname, '..', 'core');

function coreSources(): string[] {
    return fs.readdirSync(CORE, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(ts|js)$/.test(e.name) && !e.name.endsWith('.d.ts'))
        .map((e) => path.join(CORE, e.name));
}

/** Strip comments and string/template literals so prose ABOUT a pattern is not read as the pattern. */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

test('no core module require()s a computed path', () => {
    // The host loads foreign code only if it can name a foreign path. Every require in core is a string
    // literal today; this keeps it that way. `plugin-worker.js` is the CHILD's entry point, which loads
    // the plugin by design — it is the one file that legitimately does this, and it does not run here.
    const offenders: string[] = [];
    for (const file of coreSources()) {
        if (path.basename(file) === 'plugin-worker.js') continue;
        const code = codeOnly(fs.readFileSync(file, 'utf8'));
        // require(<anything that is not a quoted literal>)
        for (const m of code.matchAll(/\brequire\s*\(\s*([^)'"`\s][^)]*)\)/g)) {
            const arg = m[1].trim();
            if (arg.startsWith("''") || arg.startsWith('""') || arg.startsWith('``')) continue;
            offenders.push(`${path.basename(file)}: require(${arg.slice(0, 60)})`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'a core module resolves a require() target at runtime — that is how foreign code reaches the host process:\n  ' + offenders.join('\n  '));
});

test('theme logic is loaded through the isolate, never required by the host', () => {
    const src = fs.readFileSync(path.join(CORE, 'theme-engine.ts'), 'utf8');
    const code = codeOnly(src);

    // NOT `/loadIsolatedPlugin\s*\(/`: that substring also occurs inside `unloadIsolatedPlugin(`, which
    // theme-engine calls to RETIRE isolates. The first version of this assertion matched the teardown
    // call and passed with the load call deleted — a gate that read a spelling instead of the identifier.
    const loadCalls = [...code.matchAll(/(?<![\w$])loadIsolatedPlugin\s*\(/g)];
    assert.ok(loadCalls.length > 0,
        'theme-engine no longer routes functions.js through loadIsolatedPlugin — theme code may be running on the host again');

    // And there must be no host-side require of the theme's own directory.
    for (const m of code.matchAll(/\brequire\s*\(\s*([^)'"`\s][^)]*)\)/g)) {
        assert.fail(`theme-engine computes a require() target: require(${m[1].trim().slice(0, 60)})`);
    }
});

test('in-process plugin execution stays removed', () => {
    // A plugin that does not declare isolation must be SKIPPED, not run some other way.
    //
    // Anchored on the CHECK, not on the message. The first version asserted the error text — and that
    // text appears twice, so deleting one occurrence (which is what deleting the guard would do) left
    // the other and the assertion passed. Message strings are not the control; `!manifest.isolated` is.
    const code = codeOnly(fs.readFileSync(path.join(CORE, 'plugins.ts'), 'utf8'));
    const guards = [...code.matchAll(/!\s*manifest\s*(?:&&|\|\|)?\s*(?:\|\|\s*)?!\s*manifest\.isolated|!\s*manifest\.isolated/g)];
    assert.ok(guards.length >= 2,
        `the loader checks manifest.isolated in only ${guards.length} place(s); the load path and the activation path must BOTH refuse a plugin that did not ask to be isolated`);

    const src = fs.readFileSync(path.join(CORE, 'plugins.ts'), 'utf8');
    assert.match(src, /legacy in-process (?:plugins are no longer supported|loading was removed)/,
        'the loader no longer states that non-isolated plugins are refused rather than run');
});

test('the host bridge allows exactly the methods the child calls', () => {
    // THE OTHER DIRECTION OF THE SAME BOUNDARY. The child cannot execute host code, but it can ASK the
    // host to. `callApi` walks the method string as a dotted path on the api object, so an exact
    // allow-list is what stands between a malicious child and, say, `hooks.addAction` — which would
    // bypass the registration path's caps, its raw-HTML denylist and its teardown tracking.
    //
    // The allow-list's own comment says "Keep in sync with the callHost('…') calls in plugin-worker.js".
    // That is an instruction, and instructions are carried out by whoever remembers. Both sides are read
    // here instead, so the two sets are compared rather than trusted:
    //   · called-but-not-allowed is a broken plugin API (fails closed — safe, but silently broken);
    //   · allowed-but-never-called is host surface reachable over IPC that nothing needs.
    const iso = fs.readFileSync(path.join(CORE, 'plugin-isolate.ts'), 'utf8');
    const worker = fs.readFileSync(path.join(CORE, 'plugin-worker.js'), 'utf8');

    const m = iso.match(/const ALLOWED_BRIDGE_METHODS = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(m, 'could not read ALLOWED_BRIDGE_METHODS — this assertion would otherwise pass vacuously');
    const allowed = new Set([...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    const called = new Set([...worker.matchAll(/callHost\(\s*'([^']+)'/g)].map((x) => x[1]));

    assert.ok(allowed.size >= 20, `parsed only ${allowed.size} allow-list entries`);
    assert.ok(called.size >= 20, `parsed only ${called.size} callHost sites`);

    const calledNotAllowed = [...called].filter((k) => !allowed.has(k)).sort();
    assert.deepStrictEqual(calledNotAllowed, [],
        `the worker calls bridge methods the host refuses — these plugin APIs are broken: ${calledNotAllowed.join(', ')}`);

    const allowedNotCalled = [...allowed].filter((k) => !called.has(k)).sort();
    assert.deepStrictEqual(allowedNotCalled, [],
        `the host permits bridge methods nothing calls — surface reachable over IPC for no reason: ${allowedNotCalled.join(', ')}`);
});

test('no comment still describes theme functions.js as running on the host', () => {
    // THE STALE-MAP CHECK. Two comments asserted the pre-2026-07-18 boundary long after it moved, and
    // one of them named the static scanner as the ONLY control between a theme and host RCE. Someone
    // deciding what is safe to relax reads these.
    const stale: string[] = [];
    for (const file of coreSources()) {
        const src = fs.readFileSync(file, 'utf8');
        for (const [i, line] of src.split('\n').entries()) {
            if (!/functions\.js/i.test(line)) continue;
            if (!/IN-PROCESS on the host|in-process on the host/i.test(line)) continue;
            // A line that explicitly frames it as history is fine — that is the correction, not the claim.
            if (/used to|no longer|until 2026|has not since|was true until/i.test(line)) continue;
            stale.push(`${path.basename(file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
    }
    assert.deepStrictEqual(stale, [],
        'a comment still says theme functions.js runs on the host; it runs in an isolate:\n  ' + stale.join('\n  '));
});
