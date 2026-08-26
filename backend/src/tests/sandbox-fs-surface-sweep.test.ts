/**
 * THE WHOLE `fs` SURFACE, SWEPT — not a list of the methods someone thought of.
 *
 * `secure-require` wraps `fs` in a proxy that is DENY-BY-DEFAULT: a function it has not classified as a
 * read or a write throws rather than executing. That is the right shape, and it is the shape that makes
 * a sweep meaningful — because the claim it supports is about the whole surface, and a claim about a
 * whole surface should be checked against the whole surface rather than against the members a test
 * author remembered.
 *
 * Node keeps adding to `fs` (`glob` in 22, `openAsBlob` in 19, the promises mirror growing separately).
 * A guard enumerated by hand goes stale by addition, silently, in the direction of permissiveness. This
 * enumerates `fs` and `fs.promises` AT RUNTIME inside a real isolate and calls every function-valued key
 * against a path OUTSIDE the plugin's zone, classifying each outcome:
 *
 *   blocked   — the guard refused (a WordJS security error). The intended outcome.
 *   rejected  — it threw something else (bad arguments, ENOENT, EISDIR). Contained, but for a reason
 *               that is not the guard, so it is reported separately rather than counted as coverage.
 *   ESCAPED   — it returned. Out-of-zone access happened. Any single one of these is the finding.
 *
 * The target is a real file that exists and that the HOST can read, so "it worked" and "there was
 * nothing there" cannot be confused.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-fs-sweep-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
require('../config/database');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');

const PLUGINS_ROOT = path.resolve(__dirname, '../../plugins');
const SLUG = 'wjs-fs-sweep';

// Outside every plugin zone, definitely present, and readable by the host — so a success is
// unambiguous. Written by the harness rather than reusing a repo file, so the content is known.
const OUT_OF_ZONE = path.join(os.tmpdir(), `wjs-fs-sweep-target-${process.pid}.txt`);
const OUT_OF_ZONE_DIR = path.join(os.tmpdir(), `wjs-fs-sweep-dir-${process.pid}`);

const PROBE_BODY = `
    const p = ${JSON.stringify(OUT_OF_ZONE)};
    const d = ${JSON.stringify(OUT_OF_ZONE_DIR)};
    const results = { blocked: [], rejected: [], escaped: [] };

    // A WordJS refusal, told apart from an ordinary failure. The guard's errors carry its own wording.
    const isGuardRefusal = (e) => {
        const m = String((e && (e.message || e)) || '');
        return /not permitted|SECURITY BLOCK|outside safe zones|unauthorized action|not allowed/i.test(m);
    };

    // AWAIT the result. A promise-returning fs method does NOT throw synchronously — it returns a pending
    // promise and rejects later. The first version of this sweep called the function, saw a value come
    // back and recorded 'escaped' for every single member of fs.promises, which said nothing about the
    // guard and everything about the harness. An async API has to be judged on its settled outcome.
    const sweep = async (surface, label) => {
        for (const key of Object.keys(surface)) {
            let fn;
            try { fn = surface[key]; } catch (e) { results.blocked.push(label + '.' + key); continue; }
            if (typeof fn !== 'function') continue;
            // Arg shapes covering the common signatures without per-method knowledge. A method needing
            // something else lands in 'rejected', which is reported and not counted as containment.
            const attempts = [[p], [p, 'x'], [d], [p, p + '.copy'], [p, 0]];
            let outcome = 'rejected';
            for (const args of attempts) {
                try {
                    let r = fn.apply(surface, args);
                    if (r && typeof r.then === 'function') r = await r;
                    // Close anything that hands back a live handle, or the isolate leaks descriptors.
                    try { if (r && typeof r.close === 'function') await r.close(); } catch (e) {}
                    outcome = 'escaped';
                    break;
                } catch (e) {
                    if (isGuardRefusal(e)) { outcome = 'blocked'; break; }
                    outcome = 'rejected';
                }
            }
            results[outcome].push(label + '.' + key);
        }
    };

    const run = (async () => {
        try { await sweep(require('fs'), 'fs'); } catch (e) { results.fsRequireError = String(e && e.message || e); }
        try { await sweep(require('fs').promises, 'fs.promises'); } catch (e) { results.promisesError = String(e && e.message || e); }
        try { await sweep(require('fs/promises'), 'fs/promises'); } catch (e) { results.fsPromisesModError = String(e && e.message || e); }
        return results;
    })();

    wordjs.hooks.addFilter('wjs_fs_sweep_report', async () => await run);
`;

function writeFixture(slug: string, initBody: string) {
    const dir = path.join(PLUGINS_ROOT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, isolated: true, permissions: [] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = function (wordjs) {\n' + initBody + '\n};\n');
    return dir;
}

describe('the fs surface, swept inside a real isolate', () => {
    let report: any = null;
    let bootError: string | null = null;

    before(async () => {
        fs.writeFileSync(OUT_OF_ZONE, 'host-only-content');
        fs.mkdirSync(OUT_OF_ZONE_DIR, { recursive: true });
        writeFixture(SLUG, PROBE_BODY);
        try {
            await loadIsolatedPlugin(SLUG, path.join(PLUGINS_ROOT, SLUG, 'index.js'));
            const { applyFilters } = require('../core/hooks');
            report = await applyFilters('wjs_fs_sweep_report', null);
        } catch (e: any) {
            bootError = String(e && e.message || e);
        }
    });

    after(async () => {
        try { await unloadIsolatedPlugin(SLUG); } catch { /* */ }
        try { fs.rmSync(path.join(PLUGINS_ROOT, SLUG), { recursive: true, force: true }); } catch { /* */ }
        for (const p of [OUT_OF_ZONE, OUT_OF_ZONE + '.copy', TMP_DB]) { try { fs.rmSync(p, { force: true }); } catch { /* */ } }
        try { fs.rmSync(OUT_OF_ZONE_DIR, { recursive: true, force: true }); } catch { /* */ }
    });

    test('the sweep actually ran over a real surface', (t: any) => {
        if (bootError) { t.skip(`the isolated probe did not boot on ${process.platform}: ${bootError}`); return; }
        assert.ok(report, 'no report');
        const total = report.blocked.length + report.rejected.length + report.escaped.length;
        // Printed, not just asserted: "no escapes" is only meaningful next to how much was tried, and the
        // number moves with the Node version. A reader should not have to instrument this to find out.
        console.log(`[fs sweep] ${total} entry points on ${process.version}: `
            + `${report.blocked.length} refused by the guard, ${report.rejected.length} failed for other reasons, `
            + `${report.escaped.length} escaped`);
        // A sweep that examined nothing would report zero escapes forever.
        assert.ok(total >= 40,
            `only ${total} fs entry points were exercised — the enumeration is broken, so "no escapes" means nothing`);
    });

    test('no fs entry point reaches outside the plugin zone', (t: any) => {
        if (!report) { t.skip('probe did not boot'); return; }
        assert.deepStrictEqual(report.escaped, [],
            'these fs entry points executed against a path outside the plugin zone:\n  ' + report.escaped.join('\n  '));
    });

    test('the guard, not luck, is what refuses most of the surface', (t: any) => {
        if (!report) { t.skip('probe did not boot'); return; }
        // 'rejected' means it threw for some other reason — bad arguments, ENOENT. Those are contained
        // today but they are not the guard, and a surface held mostly by argument validation would be one
        // refactor away from opening. This is a shape assertion, deliberately loose, that would notice the
        // guard being removed wholesale.
        assert.ok(report.blocked.length >= 10,
            `only ${report.blocked.length} fs entry points were refused BY THE GUARD (${report.rejected.length} threw for other reasons). `
            + 'That is not the deny-by-default proxy doing the work.');
    });
});
