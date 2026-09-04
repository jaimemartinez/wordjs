/**
 * THE REACTIVE PER-PLUGIN CPU WATCHDOG — the decision, pinned without burning a core.
 *
 * documentation/security.md §4 used to say, truthfully, that the per-plugin CPU quota was OPT-IN and that
 * "by default a plugin can still burn CPU (DoS)". The watchdog in core/plugin-isolate.ts closes that: the
 * host-side poll that already reads a child's rss now also reads its cumulative CPU time, and a child
 * holding >= 95% of ONE core for sandbox.cpuBurstSeconds (default 60) WITHOUT a single quiet tick is
 * SIGKILLed.
 *
 * IT SHIPPED WITH A HOLE, and half this file is here to keep it shut. The watchdog was skipped on win32
 * and in cgroup mode on the premise that both already had a PREVENTIVE kernel CPU cap. Neither did by
 * default: both caps are driven by sandbox.cpuQuotaPercent, which defaults to 0, and on Windows the rate
 * cap exists only on the AppContainer path and only when 0 < percent < 100 — the plain-fork Job Object
 * carries a memory limit alone. So a stock install had NO CPU bound anywhere while the docs said CPU was
 * bounded by default. The skip is now ONE predicate (preventiveCpuCapActive) over the launch's own facts,
 * win32 is sampled through `tasklist /V`, and cgroup-without-a-quota is a warned residual rather than a
 * silent one.
 *
 * The property that matters is a policy, not a syscall: an unbroken 60 s burn must kill, a shorter burst
 * must NOT, and one quiet tick must reset the window — because legitimate plugin work (an import, a
 * thumbnail batch, a sitemap rebuild) pegs a core for seconds and a false positive kills a WORKING plugin.
 * None of that can be asserted by actually pegging a core for a minute in CI, so the decision is a pure
 * exported function and this file drives it with synthetic sample runs. Deliberately: a test that really
 * burned CPU for 60 s would be slow, flaky on a loaded runner, and would still not prove the reset rule.
 *
 * It also pins the two things that would make the watchdog silently inert: the DEFAULT (0 here would mean
 * "shipped off", which is the exact residual this work removes) and the `ps -o cputime=` parser (a cputime
 * string the watchdog mis-reads is a watchdog that never fires).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

require('../config/app'); // preload in the trusted context, like the other isolate tests
const isolate = require('../core/plugin-isolate');
const { sandbox } = require('../config/app');

const isSustainedCpuBurn = isolate.isSustainedCpuBurn;
const parsePsCpuTime = isolate.parsePsCpuTime;
const parseTasklistCpuTime = isolate.parseTasklistCpuTime;
const capActive = isolate.__preventiveCpuCapActive;
const RATIO = isolate.CPU_BURN_RATIO;

// The real Linux poll interval, so the sample runs below have the same shape the watchdog actually sees.
const STEP_MS = 250;
const WINDOW_MS = 60_000;

/**
 * Build a run of samples from a list of per-tick utilisation ratios, spaced one poll apart. `at` is the
 * wall clock at which each tick ENDED, exactly as the watchdog records it.
 */
function samplesOf(ratios: number[], stepMs: number = STEP_MS): Array<{ at: number; ratio: number }> {
    const t0 = 1_700_000_000_000; // any fixed epoch — only the deltas matter
    return ratios.map((ratio, i) => ({ at: t0 + (i + 1) * stepMs, ratio }));
}

const burn = (n: number, ratio: number = 1.0) => new Array(n).fill(ratio);
const idle = (n: number, ratio: number = 0.02) => new Array(n).fill(ratio);

describe('isSustainedCpuBurn — the kill decision', () => {
    test('a sustained burn longer than the window KILLS', () => {
        // 300 ticks x 250 ms = 74.75 s of unbroken saturation, comfortably past the 60 s window.
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(300)), RATIO, WINDOW_MS), true);
    });

    test('a burst SHORTER than the window does not kill — this is the honest-plugin case', () => {
        // ~25 s pegging a core: an import or a thumbnail batch. Must survive.
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(100)), RATIO, WINDOW_MS), false);
        // Even with a long idle history in front of it, only the trailing unbroken run counts.
        assert.strictEqual(isSustainedCpuBurn(samplesOf([...idle(500), ...burn(100)]), RATIO, WINDOW_MS), false);
    });

    test('an idle child never kills, however long it runs', () => {
        assert.strictEqual(isSustainedCpuBurn(samplesOf(idle(1000)), RATIO, WINDOW_MS), false);
        // Busy-but-not-saturated (half a core, sustained for hours) is legitimate work, not a DoS.
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(1000, 0.5)), RATIO, WINDOW_MS), false);
    });

    test('ONE quiet tick inside the run resets the window', () => {
        // A full window of burn, then a single sample below the ratio, then more burn that is by itself
        // too short. If the quiet tick did not reset, this would kill a plugin that visibly yielded.
        const run = [...burn(300), 0.10, ...burn(100)];
        assert.strictEqual(isSustainedCpuBurn(samplesOf(run), RATIO, WINDOW_MS), false);
    });

    test('after a reset, a NEW full window kills again — the reset is not a permanent amnesty', () => {
        const run = [...burn(100), 0.10, ...burn(300)];
        assert.strictEqual(isSustainedCpuBurn(samplesOf(run), RATIO, WINDOW_MS), true);
    });

    test('a child that has just gone quiet is never killed on its history', () => {
        // Newest sample below the ratio ⇒ false, no matter how long the burn before it was. The watchdog
        // kills what is burning NOW, not what burned.
        assert.strictEqual(isSustainedCpuBurn(samplesOf([...burn(1000), 0.0]), RATIO, WINDOW_MS), false);
    });

    test('the window boundary is inclusive, and one tick under it is not enough', () => {
        // 241 samples ⇒ span = 240 * 250 ms = exactly 60 000 ms.
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(241)), RATIO, WINDOW_MS), true);
        // 240 samples ⇒ 59 750 ms. One poll tick short, and the answer must flip.
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(240)), RATIO, WINDOW_MS), false);
    });

    test('the threshold is inclusive: exactly at the ratio burns, a hair under does not', () => {
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(300, RATIO)), RATIO, WINDOW_MS), true);
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(300, RATIO - 0.0001)), RATIO, WINDOW_MS), false);
    });

    test('a multi-threaded child pegging several cores still reads as a burn', () => {
        // Δcpu/Δwall > 1 is normal for a threaded child; it must not fall out of the >= comparison.
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(300, 3.7)), RATIO, WINDOW_MS), true);
    });

    test('windowMs <= 0 is the DISABLED spelling and never kills', () => {
        // sandbox.cpuBurstSeconds = 0. "No window" must not degrade into "any burn qualifies" — that
        // would turn the opt-out into the most aggressive setting there is.
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(1000)), RATIO, 0), false);
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(1000)), RATIO, -1), false);
    });

    test('degenerate inputs are answered false, not thrown', () => {
        assert.strictEqual(isSustainedCpuBurn([], RATIO, WINDOW_MS), false);
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(1)), RATIO, WINDOW_MS), false);
        assert.strictEqual(isSustainedCpuBurn(null as any, RATIO, WINDOW_MS), false);
        assert.strictEqual(isSustainedCpuBurn(undefined as any, RATIO, WINDOW_MS), false);
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(300)), 0, WINDOW_MS), false);
    });

    test('a slower poll reaches the same verdict — the rule is time, not sample count', () => {
        // macOS polls every 400 ms, Linux every 250 ms. 151 samples x 400 ms = 60 000 ms exactly.
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(151), 400), RATIO, WINDOW_MS), true);
        assert.strictEqual(isSustainedCpuBurn(samplesOf(burn(150), 400), RATIO, WINDOW_MS), false);
    });
});

describe('parsePsCpuTime — the macOS input', () => {
    test('parses every shape `ps -o cputime=` emits', () => {
        assert.strictEqual(parsePsCpuTime('0:03.42'), 3.42);          // macOS default mm:ss.ss
        assert.strictEqual(parsePsCpuTime('  12:34  '), 754);         // padded mm:ss
        assert.strictEqual(parsePsCpuTime('01:02:03'), 3723);         // hh:mm:ss
        assert.strictEqual(parsePsCpuTime('2-03:04:05'), 183_845);    // dd-hh:mm:ss
        assert.strictEqual(parsePsCpuTime('0:00'), 0);                // a brand-new child
    });

    test('anything it does not fully understand is -1, so the tick is SKIPPED', () => {
        // -1 matters: noteCpuSeconds ignores a negative reading, whereas a fake 0 would look like the
        // counter went backwards and would silently reset a window a real burn had already filled.
        for (const bad of ['', '   ', 'abc', '12', '1:2:3:4', '-5:00', 'x:yy', '1:', ':30', '1:aa']) {
            assert.strictEqual(parsePsCpuTime(bad), -1, `expected -1 for ${JSON.stringify(bad)}`);
        }
        assert.strictEqual(parsePsCpuTime(undefined as any), -1);
        assert.strictEqual(parsePsCpuTime(null as any), -1);
    });

    test('cumulative time only ever grows, so successive readings give a non-negative delta', () => {
        assert.ok(parsePsCpuTime('0:59.99') < parsePsCpuTime('1:00.00'));
        assert.ok(parsePsCpuTime('59:59') < parsePsCpuTime('1:00:00'));
        assert.ok(parsePsCpuTime('23:59:59') < parsePsCpuTime('1-00:00:00'));
    });
});

describe('parseTasklistCpuTime — the Windows input', () => {
    test('parses the H:MM:SS the CPU Time column emits, with UNBOUNDED hours', () => {
        assert.strictEqual(parseTasklistCpuTime('0:00:00'), 0);        // a brand-new child
        assert.strictEqual(parseTasklistCpuTime('0:01:05'), 65);
        // 26 hours, NOT a day field and NOT 2 hours. tasklist keeps counting hours past 24, and a parser
        // that wrapped or truncated here would read a long-lived burner as newly idle.
        assert.strictEqual(parseTasklistCpuTime('26:00:01'), 93_601);
        assert.strictEqual(parseTasklistCpuTime('  "1:00:00"  '), 3600); // the raw CSV field, quotes and all
    });

    test('anything else is -1, so the tick is SKIPPED rather than read as zero', () => {
        // "N/D"/"N/A" is what tasklist prints in this column for a process it cannot query — LOCALIZED,
        // which is the whole reason nothing in this parser trusts text. A fake 0 here would look like the
        // cumulative counter went backwards and would reset a window a real burn had already filled.
        for (const bad of ['', '   ', 'N/D', 'N/A', 'abc', '0:00', '1:2:3', '1:00:00:00', '-1:00:00', '0:00:00.5']) {
            assert.strictEqual(parseTasklistCpuTime(bad), -1, `expected -1 for ${JSON.stringify(bad)}`);
        }
        assert.strictEqual(parseTasklistCpuTime(undefined as any), -1);
        assert.strictEqual(parseTasklistCpuTime(null as any), -1);
    });

    test('a REAL `tasklist /V /FO CSV /NH` row is read by POSITION, not by header', () => {
        // Captured on the development host (Windows 11, Spanish) against a live `node -e "setInterval..."`
        // child; only the account name is replaced, because that is not fixture material. Note what the
        // localization does: the memory column uses "." as the thousands separator and the window title of
        // a console child is "N/D", not "N/A". Headers are suppressed by /NH and would be translated
        // anyway, so the columns are addressed by index:
        //   0 Image Name  1 PID  2 Session Name  3 Session#  4 Mem Usage
        //   5 Status      6 User Name           7 CPU Time  8 Window Title
        const row = '"node.exe","19800","Console","1","44.856 KB","Unknown","PC\\wordjs","0:00:34","N/D"\r\n';
        const fields = row.match(/"[^"]*"/g) as string[];
        assert.strictEqual(fields.length, 9);
        assert.strictEqual(parseTasklistCpuTime(fields[7]), 34);
        // The rss read on the same row must be field 4 and NOT the last field: under /V the last field is
        // the window title, so "take the last quoted field" — which is what the poll used to do — yields
        // no digits at all and the resident cap silently stops enforcing.
        assert.strictEqual(parseInt(fields[4].replace(/\D/g, ''), 10) * 1024, 45_932_544);
        assert.strictEqual(fields[fields.length - 1].replace(/\D/g, ''), '');
    });
});

describe('parseProcStatCpuTicks — the Linux input', () => {
    /**
     * A real /proc/<pid>/stat line, with the field numbers spelled out so an off-by-one is visible in the
     * fixture itself: 1 pid, 2 comm (IN PARENS), 3 state, 4 ppid, 5 pgrp, 6 session, 7 tty_nr, 8 tpgid,
     * 9 flags, 10 minflt, 11 cminflt, 12 majflt, 13 cmajflt, 14 utime, 15 stime.
     * Here utime = 4210 and stime = 313, so the answer must be 4523 ticks and nothing else — reading
     * cmajflt/utime (an off-by-one low) would give 4210, reading stime/cutime (one high) would give 313.
     */
    const statLine = (comm: string, utime: number, stime: number) =>
        `4242 (${comm}) S 1 4242 4242 0 -1 4194560 91234 0 7 0 ${utime} ${stime} 0 0 20 0 11 0 987654 ` +
        '1258291200 45678 18446744073709551615 4194304 4198400 140736 0 0 0 0 4096 16386 0 0 0 17 3 0 0 0 0 0\n';

    test('reads utime+stime, not the fault counters on either side of them', () => {
        assert.strictEqual(isolate.parseProcStatCpuTicks(statLine('node', 4210, 313)), 4523);
        assert.strictEqual(isolate.parseProcStatCpuTicks(statLine('node', 0, 0)), 0);
    });

    test('a comm containing spaces and parens does NOT shift the fields', () => {
        // This is the whole reason the parser counts from the LAST ')'. A plugin can set its own process
        // title; if it picks one like this, a naive split on spaces reads flags or minflt as CPU time and
        // the watchdog silently stops meaning anything.
        assert.strictEqual(isolate.parseProcStatCpuTicks(statLine('my (evil) plugin', 4210, 313)), 4523);
        assert.strictEqual(isolate.parseProcStatCpuTicks(statLine(') ) ) 0 0 0 0 0 0 0 0 0 0 999999', 4210, 313)), 4523);
    });

    test('a line it cannot read is -1, so the tick is skipped rather than invented', () => {
        for (const bad of ['', 'not a stat line at all', '4242 (node) S 1 2 3']) {
            assert.strictEqual(isolate.parseProcStatCpuTicks(bad), -1, `expected -1 for ${JSON.stringify(bad)}`);
        }
        assert.strictEqual(isolate.parseProcStatCpuTicks(undefined as any), -1);
    });
});

describe('preventiveCpuCapActive — the ONLY reason the watchdog stands down', () => {
    /** The launch facts, defaulted to the shape that has no cap, so each case names only what it changes. */
    const at = (over: Partial<{ platform: string; appContainer: boolean; cgroupOk: boolean; quotaPercent: number }>) =>
        capActive({ platform: 'linux', appContainer: false, cgroupOk: false, quotaPercent: 0, ...over });

    test('win32 + AppContainer + a quota ⇒ capped (the relay installs the Job Object rate control)', () => {
        assert.strictEqual(at({ platform: 'win32', appContainer: true, quotaPercent: 50 }), true);
        assert.strictEqual(at({ platform: 'win32', appContainer: true, quotaPercent: 1 }), true);
    });

    test('win32 with the quota at its 0 DEFAULT ⇒ NOT capped — this is the whole defect', () => {
        // The rate cap was documented as "default-on". It is not: sandbox.cpuQuotaPercent defaults to 0
        // and the relay installs nothing at 0, so a stock Windows host had no CPU bound at all while the
        // watchdog was being skipped there for having one.
        assert.strictEqual(at({ platform: 'win32', appContainer: true, quotaPercent: 0 }), false);
    });

    test('win32 WITHOUT the relay is never capped, whatever the quota says', () => {
        // The non-AppContainer launch gets assignProcessToJobObject, which sets ProcessMemoryLimit and no
        // CPU rate at all — so a quota there is a number nobody applies.
        assert.strictEqual(at({ platform: 'win32', appContainer: false, quotaPercent: 50 }), false);
    });

    test('win32 at 100% or above is NOT capped — the relay guards `cpu > 0 && cpu < 100`', () => {
        // A HARD_CAP at a full core is not expressible through JOBOBJECT_CPU_RATE_CONTROL_INFORMATION the
        // way this relay writes it, so it installs nothing. Linux has no such bound, which is exactly why
        // the two platforms cannot share one comparison.
        assert.strictEqual(at({ platform: 'win32', appContainer: true, quotaPercent: 100 }), false);
        assert.strictEqual(at({ platform: 'win32', appContainer: true, quotaPercent: 200 }), false);
    });

    test('linux cgroup mode + a quota ⇒ capped; cgroup mode alone ⇒ NOT capped', () => {
        assert.strictEqual(at({ cgroupOk: true, quotaPercent: 25 }), true);
        assert.strictEqual(at({ cgroupOk: true, quotaPercent: 200 }), true); // 2 cores is a legal CPUQuota
        // The residual this work names out loud: a scope with MemoryMax and no CPUQuota. The plugin has no
        // CPU bound AND cannot be sampled (child.pid is systemd-run), so it must not read as covered.
        assert.strictEqual(at({ cgroupOk: true, quotaPercent: 0 }), false);
    });

    test('plain linux, macOS and anything unrecognised are never capped', () => {
        assert.strictEqual(at({ quotaPercent: 50 }), false);                      // no cgroup ⇒ no scope ⇒ no CPUQuota
        assert.strictEqual(at({ platform: 'darwin', quotaPercent: 50 }), false);  // macOS has no such mechanism
        assert.strictEqual(at({ platform: 'darwin', cgroupOk: true, quotaPercent: 50 }), false);
        assert.strictEqual(at({ platform: 'freebsd', quotaPercent: 50 }), false);
    });

    test('a garbage quota reads as NO cap — "config unavailable" must never mean "already bounded"', () => {
        for (const q of [NaN, -1, undefined, null, 'lots'] as any[]) {
            assert.strictEqual(at({ platform: 'win32', appContainer: true, quotaPercent: q }), false);
            assert.strictEqual(at({ cgroupOk: true, quotaPercent: q }), false);
        }
    });
});

describe('the win32 sampler is WIRED, not merely described', () => {
    // Branch placement, asserted on the source for the same reason sandbox-linux-zeroconf-wiring.test.ts
    // does it: WHERE these calls sit is the behaviour. The watchdog was skipped on Windows by omission —
    // there was no flag to flip, just a missing call — so a comment claiming coverage proves nothing.
    const source = fs.readFileSync(path.resolve(__dirname, '../core/plugin-isolate.ts'), 'utf8');
    const configSource = fs.readFileSync(path.resolve(__dirname, '../config/app.ts'), 'utf8');

    test('the Windows poll asks tasklist for the VERBOSE row', () => {
        assert.match(source, /spawn\('tasklist', \['\/V', '\/FI', `PID eq \$\{pollPid\}`, '\/NH', '\/FO', 'CSV'\]/,
            'without /V there is no CPU Time column to sample');
    });

    test('the Windows branch feeds noteCpuSeconds from column 7', () => {
        assert.match(source, /noteCpuSeconds\(parseTasklistCpuTime\(fields\[7\]\)\)/);
        // …and only where no preventive cap holds the child, spaced by the sampling floor.
        assert.match(source, /!preventiveCpuCap && fields\.length >= 8 && \(now - lastWinCpuAt\) >= WIN_CPU_SAMPLE_MIN_MS/);
    });

    test('rss is read by POSITION, never as "the last quoted field"', () => {
        // The regression /V would otherwise introduce: the last field becomes the window title and the
        // resident cap stops enforcing without a word on the health surface.
        assert.match(source, /const digits = fields\[4\]\.replace/);
        assert.doesNotMatch(source, /fields\[fields\.length - 1\]/);
    });

    test('the skip is one predicate, and the old "win32 is exempt" rule is gone', () => {
        assert.match(source, /let preventiveCpuCap = preventiveCpuCapActive\(\{/);
        assert.doesNotMatch(source, /WHERE IT IS DELIBERATELY NOT WIRED/);
        assert.doesNotMatch(source, /the Job Object CPU RATE cap there is PREVENTIVE and default-on/);
        assert.doesNotMatch(configSource, /Skipped on win32/);
    });

    test('cgroup mode without a quota WARNS once instead of passing for covered', () => {
        assert.match(source, /cgroupOk && !preventiveCpuCap && !cgroupNoCpuQuotaWarned/);
        assert.match(source, /cgroupNoCpuQuotaWarned = true;/);
        assert.match(source, /isolated plugins have NO CPU bound on this host/);
    });

    test('the Windows sampling floor is 30 s, and it is not a guess', () => {
        // tasklist's CPU Time column has 1 s resolution. Measured on the development host against a real
        // spinning child: at 1 s spacing one ratio inside an unbroken burn read 0.000 and at 10 s spacing
        // one read 0.900 — either resets the window, i.e. a watchdog that can never fire. At 30 s the same
        // burn read 0.968, matching the worst case (Δwall − 1 s)/Δwall = 0.967 > CPU_BURN_RATIO.
        assert.strictEqual(isolate.WIN_CPU_SAMPLE_MIN_MS, 30_000);
        assert.ok((isolate.WIN_CPU_SAMPLE_MIN_MS - 1000) / isolate.WIN_CPU_SAMPLE_MIN_MS > RATIO,
            'a shorter floor lets 1 s of quantisation push a full burn under the ratio');
    });
});

describe('the watchdog ships ON', () => {
    test('sandbox.cpuBurstSeconds defaults to 60 — this is the residual being closed', () => {
        // If someone changes this default to 0, the CPU DoS residual is back and the docs are wrong; that
        // is precisely the regression this assertion exists to make red.
        assert.strictEqual(sandbox.cpuBurstSeconds, 60);
        assert.strictEqual(isolate.__cpuBurstWindowMs(), 60_000);
        assert.strictEqual(isolate.CPU_BURST_SECONDS_DEFAULT, 60);
    });

    test('the burn ratio is a full core, not a fraction of one', () => {
        assert.strictEqual(RATIO, 0.95);
        // A ratio at or above 1 would be unreachable in practice (a single-threaded child never quite
        // reaches 1.0 across a poll), and a low one would kill honest half-load plugins.
        assert.ok(RATIO > 0.5 && RATIO < 1);
    });
});
