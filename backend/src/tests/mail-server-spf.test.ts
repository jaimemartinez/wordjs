/**
 * mail-server inbound SPF regression suite (RFC 7208).
 *
 * WHY THIS FILE EXISTS: every SPF fix on this path — the blanket inbound rejection, the unbounded
 * DNS fan-out, redirect=, dual-cidr-length, tag-only gating, case-insensitive mechanism names — was
 * found and proven with a THROWAWAY harness that was never committed. CI therefore could not detect a
 * re-break of any of them, and the case-insensitivity defect (an uppercase "v=spf1 A/24 -all" was
 * FOUND by the /i record detector and then evaluated as if every mechanism were unknown, falling
 * through to -all -> 550 for a sender the policy explicitly authorizes) survived three review rounds
 * for exactly that reason. This suite is that harness, promoted.
 *
 * HOW IT AVOIDS THE "green suite over broken code" TRAP: it does NOT reimplement or re-describe the
 * SPF logic. It SOURCE-SLICES the real functions verbatim out of the shipped plugin
 * (marketplace/plugins/mail-server/index.js) — evaluateSPF, spfResolveAddrs, splitDualCidr,
 * qualifierToResult, spfAction, buildReceivedSpf, sanitizeHeaderValue, ipInCidr and the REAL
 * onMailFrom handler body — and runs those. A behaviour change in the plugin is therefore visible
 * here immediately; there is no parallel copy to drift.
 *
 * Only three things are injected, and only because they are the plugin's I/O boundary: the `dns`
 * bridge, `getOption`, and `siteDomain`. The DNS stub models failures the way the sandbox actually
 * marshals them — backend/src/core/plugin-isolate.ts rebuilds a rejection as `new Error(String(msg))`,
 * so the resolver code survives ONLY inside the message text, which is what isDnsNoRecord sniffs.
 * A stub that set `err.code` instead would be a fixture that does not match the real producer.
 *
 * If a sliced function is renamed or reshaped, the slicer FAILS LOUDLY rather than stubbing it out:
 * a suite that silently stops testing the thing it names is worse than no suite.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const PLUGIN_SRC = path.resolve(__dirname, '../../../marketplace/plugins/mail-server/index.js');

// --- Source slicer ------------------------------------------------------------------------------

/**
 * Brace-match from an index pointing at the '{' that opens a block, skipping over strings, comments
 * and regex literals so a '}' inside one of them does not close the block early.
 */
function matchBrace(text: string, openIdx: number): number {
    let depth = 0;
    let inStr: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    let inRegex = false;
    let prev = '';
    for (let i = openIdx; i < text.length; i++) {
        const c = text[i];
        const n = text[i + 1];
        if (inLineComment) { if (c === '\n') inLineComment = false; prev = c; continue; }
        if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i++; } prev = c; continue; }
        if (inStr) { if (c === '\\') { i++; prev = ''; continue; } if (c === inStr) inStr = null; prev = c; continue; }
        if (inRegex) { if (c === '\\') { i++; prev = ''; continue; } if (c === '/') inRegex = false; prev = c; continue; }
        if (c === '/' && n === '/') { inLineComment = true; i++; prev = ''; continue; }
        if (c === '/' && n === '*') { inBlockComment = true; i++; prev = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; prev = c; continue; }
        // A '/' is a regex literal iff the previous significant character cannot end an expression.
        if (c === '/' && !/[A-Za-z0-9_$)\]]/.test(prev)) { inRegex = true; prev = ''; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
        if (!/\s/.test(c)) prev = c;
    }
    throw new Error(`mail-server SPF suite: unbalanced braces from offset ${openIdx} in ${PLUGIN_SRC}`);
}

/** Match '(' … ')' so a default parameter value containing '{' (evaluateSPF's `budget = { lookups: 0 }`)
 *  is not mistaken for the start of the function body. */
function matchParen(text: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') { depth--; if (depth === 0) return i; }
    }
    throw new Error(`mail-server SPF suite: unbalanced parens from offset ${openIdx} in ${PLUGIN_SRC}`);
}

function sliceFn(text: string, name: string): string {
    const m = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm').exec(text);
    assert.ok(
        m,
        `mail-server SPF suite: function ${name}() not found in ${PLUGIN_SRC}. ` +
        'This suite runs the SHIPPED code by slicing it out of that file — if the function was renamed ' +
        'or restructured, update the slice list here so the SPF behaviour stays covered.'
    );
    const paramClose = matchParen(text, text.indexOf('(', m.index));
    const open = text.indexOf('{', paramClose);
    return text.slice(m.index, matchBrace(text, open) + 1);
}

/** Slice an object-literal method's BODY BLOCK (braces included) by its exact signature text. */
function sliceMethodBody(text: string, signature: string): string {
    const idx = text.indexOf(signature);
    assert.ok(idx >= 0, `mail-server SPF suite: method "${signature}" not found in ${PLUGIN_SRC}`);
    const open = text.indexOf('{', idx + signature.length - 1);
    return text.slice(open, matchBrace(text, open) + 1);
}

const SLICED_FUNCTIONS = [
    'isDnsNoRecord', 'spfResolveAddrs', 'splitDualCidr', 'evaluateSPF', 'qualifierToResult',
    'spfAction', 'sanitizeHeaderValue', 'buildReceivedSpf', 'cidrMatch', 'ipInCidr', 'isBlockedIp',
    'getOptionsBatch', 'isTrustedSmtpSession', 'bareIp', 'smtpError'
];

function buildHarnessSource(): string {
    const text = fs.readFileSync(PLUGIN_SRC, 'utf8');
    const consts = /^const SPF_MAX_DNS_LOOKUPS = \d+;\s*\nconst SPF_MAX_MX_RECORDS = \d+;\s*\nconst SPF_MAX_DEPTH = \d+;/m.exec(text);
    assert.ok(consts, `mail-server SPF suite: the SPF_MAX_* processing limits were not found in ${PLUGIN_SRC}`);
    // cidrMatch's "this term is broken" sentinel. Taken from the source rather than redeclared here:
    // a local `Symbol()` would be a DIFFERENT symbol, so evaluateSPF's `hit === CIDR_MALFORMED` would
    // never be true and the suite would silently stop testing the permerror path it exists to pin.
    const sentinel = /^const CIDR_MALFORMED = Symbol\('cidr-malformed'\);$/m.exec(text);
    assert.ok(sentinel, `mail-server SPF suite: the CIDR_MALFORMED sentinel was not found in ${PLUGIN_SRC}`);

    const out: string[] = ["'use strict';", "const net = require('net');"];
    // The ONLY things not taken verbatim from the shipped source: the plugin's I/O seams.
    out.push(
        'let dns = {' +
        ' resolveTxt: async () => { throw new Error("no dns stub installed"); },' +
        ' resolve4: async () => { throw new Error("no dns stub installed"); },' +
        ' resolve6: async () => { throw new Error("no dns stub installed"); },' +
        ' resolveMx: async () => { throw new Error("no dns stub installed"); } };'
    );
    out.push('let getOption = async (k, d) => d;');
    out.push('let siteDomain = "mx.site.test";');
    // The handler logs every non-clean verdict. Keep CI output readable; SPF_TEST_VERBOSE=1 restores it.
    out.push('const console = process.env.SPF_TEST_VERBOSE ? globalThis.console : new Proxy({}, { get: () => () => {} });');
    out.push(consts[0]);
    out.push(sentinel[0]);
    for (const fn of SLICED_FUNCTIONS) out.push(sliceFn(text, fn));
    out.push('const onMailFrom = function (address, session, callback) ' + sliceMethodBody(text, 'onMailFrom(address, session, callback)') + ';');
    out.push(
        'module.exports = { evaluateSPF, splitDualCidr, spfAction, buildReceivedSpf, sanitizeHeaderValue,' +
        ' cidrMatch, CIDR_MALFORMED, ipInCidr, isBlockedIp, isDnsNoRecord, onMailFrom,' +
        ' SPF_MAX_DNS_LOOKUPS, SPF_MAX_MX_RECORDS, SPF_MAX_DEPTH,' +
        ' __setDns: (d) => { dns = d; }, __setGetOption: (g) => { getOption = g; }, __setSiteDomain: (s) => { siteDomain = s; } };'
    );
    return out.join('\n\n');
}

interface SpfModule {
    evaluateSPF(domain: string, ip: string): Promise<string>;
    splitDualCidr(text: string): { rest: string; v4: number | null; v6: number | null; malformed: boolean };
    spfAction(result: string, rejectEnabled: boolean): { code: number; tagged: boolean };
    buildReceivedSpf(result: string, opts: Record<string, unknown>): string;
    sanitizeHeaderValue(v: unknown, max?: number): string;
    cidrMatch(ip: string, cidr: string | null, family?: 4 | 6 | null): boolean | symbol;
    CIDR_MALFORMED: symbol;
    ipInCidr(ip: string, cidr: string): boolean;
    isBlockedIp(ip: string): boolean;
    onMailFrom(address: { address: string }, session: any, callback: (err?: any) => void): void;
    SPF_MAX_DNS_LOOKUPS: number;
    SPF_MAX_MX_RECORDS: number;
    SPF_MAX_DEPTH: number;
    __setDns(d: unknown): void;
    __setGetOption(g: (k: string, d: string) => Promise<string>): void;
    __setSiteDomain(s: string): void;
}

const SPF: SpfModule = (() => {
    const wrapper = vm.runInThisContext(
        `(function (module, exports, require, process, globalThis) {\n${buildHarnessSource()}\n})`,
        { filename: 'mail-server-index.spf-slice.js' }
    ) as (m: any, e: any, r: NodeRequire, p: NodeJS.Process, g: typeof globalThis) => void;
    const mod = { exports: {} as any };
    wrapper(mod, mod.exports, require, process, globalThis);
    return mod.exports as SpfModule;
})();

// --- DNS stub ------------------------------------------------------------------------------------

type ZoneEntry = {
    txt?: string[] | 'SERVFAIL' | 'TIMEOUT';
    a?: string[] | 'SERVFAIL' | 'BADNAME';
    aaaa?: string[] | 'SERVFAIL';
    mx?: string[] | 'SERVFAIL';
};
type Zone = Record<string, ZoneEntry>;

/**
 * The bridge marshals a rejection down to its MESSAGE only (see the file header), so the failure MODE
 * has to live in the message text — ENODATA/ENOTFOUND/NXDOMAIN are definitive ("no such record" ->
 * 'none' / non-match), everything else is transient -> 'temperror'. That asymmetry is the whole point
 * of several tests below, so it is modelled here exactly as node phrases it.
 */
function mkDns(zone: Zone): any {
    const fail = (msg: string) => { throw new Error(msg); };
    return {
        async resolveTxt(name: string) {
            const z = zone[name];
            if (!z || z.txt === undefined) fail(`queryTxt ENODATA ${name}`);
            if (z!.txt === 'SERVFAIL') fail(`queryTxt ESERVFAIL ${name}`);
            if (z!.txt === 'TIMEOUT') fail(`queryTxt ETIMEOUT ${name}`);
            return (z!.txt as string[]).map(s => [s]); // node returns string[][] (TXT chunks)
        },
        async resolve4(host: string) {
            const z = zone[host];
            if (!z || z.a === undefined) fail(`queryA ENOTFOUND ${host}`);
            if (z!.a === 'SERVFAIL') fail(`queryA ESERVFAIL ${host}`);
            if (z!.a === 'BADNAME') fail(`queryA EBADNAME ${host}`); // NOT definitive -> temperror
            return z!.a as string[];
        },
        async resolve6(host: string) {
            const z = zone[host];
            if (!z || z.aaaa === undefined) fail(`queryAaaa ENODATA ${host}`);
            if (z!.aaaa === 'SERVFAIL') fail(`queryAaaa ESERVFAIL ${host}`);
            return z!.aaaa as string[];
        },
        async resolveMx(host: string) {
            const z = zone[host];
            if (!z || z.mx === undefined) fail(`queryMx ENODATA ${host}`);
            if (z!.mx === 'SERVFAIL') fail(`queryMx ESERVFAIL ${host}`);
            return (z!.mx as string[]).map((h, i) => ({ exchange: h, priority: 10 + i }));
        }
    };
}

/** Evaluate a record against an IP. `zone` may add extra names (A/MX targets, included policies). */
async function evaluate(record: string | null, ip: string, extra: Zone = {}): Promise<string> {
    const zone: Zone = { ...extra };
    const own = zone['ex.test'] || {};
    zone['ex.test'] = record === null ? own : { ...own, txt: [record] };
    SPF.__setDns(mkDns(zone));
    return SPF.evaluateSPF('ex.test', ip);
}

/** Drive the REAL onMailFrom handler and report what the sending MTA would actually be told. */
async function deliver(opts: {
    record?: string | null;
    zone?: Zone;
    ip?: string;
    from?: string;
    helo?: string;
    options?: Record<string, string>;
    optionBridgeDown?: boolean;
}): Promise<{ code: number; message: string; session: any }> {
    const zone: Zone = { ...(opts.zone || {}) };
    if (opts.record !== undefined && opts.record !== null) {
        zone['ex.test'] = { ...(zone['ex.test'] || {}), txt: [opts.record] };
    }
    SPF.__setDns(mkDns(zone));
    SPF.__setGetOption(async (k, d) => {
        if (opts.optionBridgeDown) throw new Error('option bridge down');
        const o = opts.options || {};
        return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d;
    });
    SPF.__setSiteDomain('mx.site.test');
    const session: any = { remoteAddress: opts.ip || '203.0.113.9', clientHostname: opts.helo || 'relay.ex.test' };
    const err = await new Promise<any>((resolve) => {
        SPF.onMailFrom({ address: opts.from || 'spoof@ex.test' }, session, (e) => resolve(e));
    });
    return { code: err ? err.responseCode : 0, message: err ? err.message : '', session };
}

const verdictOf = (session: any): string => String(session.spfHeader || '').split(' ')[1] || '';

// --- 0. The suite is actually pointed at the shipped code -----------------------------------------

test('SPF suite runs the SHIPPED plugin source, not a copy', () => {
    assert.ok(fs.existsSync(PLUGIN_SRC), `plugin source missing: ${PLUGIN_SRC}`);
    for (const fn of ['evaluateSPF', 'splitDualCidr', 'spfAction', 'buildReceivedSpf', 'onMailFrom'] as const) {
        assert.strictEqual(typeof (SPF as any)[fn], 'function', `${fn} was not sliced out of the plugin`);
    }
    // RFC 7208 §4.6.4 mandates a limit of 10 DNS-consuming terms. Pinning it here means a change to the
    // shipped constant has to be a deliberate edit to a test that cites the RFC, not a silent drift.
    assert.strictEqual(SPF.SPF_MAX_DNS_LOOKUPS, 10, 'RFC 7208 §4.6.4 DNS-lookup budget');
    assert.strictEqual(SPF.SPF_MAX_MX_RECORDS, 10, 'RFC 7208 §4.6.4 per-`mx`-term address-lookup budget');
});

// --- 1. RFC 7208 §4.6.1 — mechanism and modifier NAMES are case-insensitive -----------------------

test('mechanism names are matched case-insensitively (RFC 7208 §4.6.1)', async () => {
    // Every one of these is a legitimate published record. Matched case-sensitively, the mechanism is
    // unknown -> silently skipped -> the trailing -all fires -> 'fail' -> SMTP 550.
    assert.strictEqual(await evaluate('v=spf1 A/24 -all', '192.0.2.77', { 'ex.test': { a: ['192.0.2.1'] } }), 'pass', 'A/24');
    assert.strictEqual(await evaluate('v=spf1 A:mail.ex.test/24 -all', '203.0.113.200', { 'mail.ex.test': { a: ['203.0.113.5'] } }), 'pass', 'A:host/24');
    assert.strictEqual(await evaluate('v=spf1 MX/24 -all', '198.51.100.250', { 'ex.test': { mx: ['mx1.ex.test'] }, 'mx1.ex.test': { a: ['198.51.100.10'] } }), 'pass', 'MX/24');
    assert.strictEqual(await evaluate('v=spf1 IP4:203.0.113.5 -all', '203.0.113.5'), 'pass', 'IP4:');
    assert.strictEqual(await evaluate('v=spf1 IP6:2001:db8::/32 -all', '2001:db8:dead::1'), 'pass', 'IP6:');
    assert.strictEqual(await evaluate('v=spf1 Include:o.test -all', '192.0.2.7', { 'o.test': { txt: ['v=spf1 ip4:192.0.2.7 -all'] } }), 'pass', 'Include:');
    assert.strictEqual(await evaluate('v=spf1 ReDiRect=_spf.ex.test', '192.0.2.9', { '_spf.ex.test': { txt: ['v=spf1 ip4:192.0.2.0/24 -all'] } }), 'pass', 'ReDiRect=');
    // Mixed case must work too — the fold is on the whole name token, not a hand-listed set of spellings.
    assert.strictEqual(await evaluate('v=spf1 Ip4:203.0.113.5 -All', '203.0.113.5'), 'pass', 'Ip4:');
});

test('an uppercase `all` still ENFORCES instead of degrading to neutral', async () => {
    // The under-enforcement half of the same defect: "-ALL" was an unknown mechanism, so evaluation ran
    // off the end of the record and returned 'neutral' — i.e. accept — for a domain that said "reject".
    assert.strictEqual(await evaluate('v=spf1 -ALL', '203.0.113.5'), 'fail', '-ALL');
    assert.strictEqual(await evaluate('v=spf1 ~All', '203.0.113.5'), 'softfail', '~All');
    assert.strictEqual(await evaluate('v=spf1 IP4:10.0.0.0/8 -AlL', '203.0.113.5'), 'fail', 'mixed-case all after a non-match');
});

test('an uppercase record does not get a legitimate sender 550-ed (end to end)', async () => {
    // The harm class this whole change set exists to remove, measured through the REAL handler.
    const authorized = await deliver({
        record: 'v=spf1 IP4:203.0.113.0/24 -ALL',
        ip: '203.0.113.9'
    });
    assert.strictEqual(authorized.code, 0, 'an authorized sender under an uppercase record must be accepted');
    assert.strictEqual(verdictOf(authorized.session), 'pass');

    // …and the same record still REJECTS someone it does not authorize (the fix must not be a blanket accept).
    const spoofer = await deliver({ record: 'v=spf1 IP4:203.0.113.0/24 -ALL', ip: '198.51.100.7' });
    assert.strictEqual(spoofer.code, 550, 'an unauthorized sender under an uppercase record must still be rejected');
});

test('the v=spf1 VERSION token is matched case-insensitively (RFC 7208 §4.5/§12)', async () => {
    // The record DETECTOR is a separate /i from the mechanism-name fold above, and nothing pinned it:
    // deleting that flag left this whole suite green. It is not cosmetic — an SPF record whose version
    // token is published uppercase is a real record (§12 spells `version = "v=spf1"` as an ABNF literal
    // string, which is case-insensitive), and missing it means the domain looks like it publishes NO
    // policy at all: evaluation returns 'none', which is accepted.
    assert.strictEqual(
        await evaluate('V=SPF1 ip4:203.0.113.0/24 -ALL', '203.0.113.9'), 'pass',
        'an uppercase record must be FOUND and evaluated, not read as "no policy"'
    );
    assert.strictEqual(await evaluate('V=spf1 ip4:198.51.100.1 ~all', '203.0.113.9'), 'softfail', 'mixed-case version token');
    // The under-enforcement half: undetected, "-ALL" stops rejecting anybody.
    assert.strictEqual(await evaluate('V=SPF1 -ALL', '203.0.113.9'), 'fail', 'an uppercase record still ENFORCES');
    // The duplicate-record check runs off the SAME detector, so it has to see both spellings: two
    // records that differ only in the case of their version token are still an ambiguous policy.
    SPF.__setDns(mkDns({ 'ex.test': { txt: ['v=spf1 ip4:1.1.1.1 -all', 'V=SPF1 -all'] } }));
    assert.strictEqual(
        await SPF.evaluateSPF('ex.test', '192.0.2.1'), 'permerror',
        'a case-variant second record is still a second record'
    );
});

test('an uppercase-version record still rejects a spoofer (end to end)', async () => {
    // Measured through the REAL handler: with the detector case-sensitive the verdict is 'none', which
    // spfAction accepts — the spoofer walks in past a record that says "-ALL".
    const spoofer = await deliver({ record: 'V=SPF1 ip4:203.0.113.0/24 -ALL', ip: '198.51.100.7' });
    assert.strictEqual(spoofer.code, 550, 'an unauthorized sender under an uppercase-version record must be rejected');
    assert.strictEqual(verdictOf(spoofer.session), 'fail');
});

test('mechanism VALUES are not case-folded', async () => {
    // DNS is case-insensitive, so an uppercase host must still resolve — but the value has to reach the
    // resolver as written, because macros (%{s}) and exp= strings are case-SENSITIVE.
    assert.strictEqual(
        await evaluate('v=spf1 a:MAIL.ex.test -all', '203.0.113.5', { 'MAIL.ex.test': { a: ['203.0.113.5'] } }),
        'pass',
        'the value reached the resolver with its original case'
    );
});

// --- 2. RFC 7208 §5.3/§5.4 dual-cidr-length -------------------------------------------------------

test('splitDualCidr parses every legal dual-cidr spelling and flags the illegal ones', () => {
    const cases: Array<[string, { rest: string; v4: number | null; v6: number | null; malformed: boolean }]> = [
        ['a', { rest: 'a', v4: null, v6: null, malformed: false }],
        ['a/24', { rest: 'a', v4: 24, v6: null, malformed: false }],
        ['a//64', { rest: 'a', v4: null, v6: 64, malformed: false }],
        ['a/24//64', { rest: 'a', v4: 24, v6: 64, malformed: false }],
        ['mail.ex.test/24', { rest: 'mail.ex.test', v4: 24, v6: null, malformed: false }],
        ['a/0', { rest: 'a', v4: 0, v6: null, malformed: false }],
        // Out of RANGE is still parsed (evaluateSPF turns it into permerror with a dedicated message).
        ['a/33', { rest: 'a', v4: 33, v6: null, malformed: false }],
        ['a//129', { rest: 'a', v4: null, v6: 129, malformed: false }],
        // Out of GRAMMAR: these used to match neither pattern, stay glued to the name, and vanish.
        ['a/1234', { rest: 'a', v4: null, v6: null, malformed: true }],
        ['a//1234', { rest: 'a', v4: null, v6: null, malformed: true }],
        ['a/abc', { rest: 'a', v4: null, v6: null, malformed: true }],
        ['a/', { rest: 'a', v4: null, v6: null, malformed: true }],
        ['a/24/', { rest: 'a', v4: null, v6: null, malformed: true }],
        ['a///64', { rest: 'a', v4: null, v6: null, malformed: true }]
    ];
    for (const [input, expected] of cases) {
        assert.deepStrictEqual(SPF.splitDualCidr(input), expected, `splitDualCidr(${JSON.stringify(input)})`);
    }
});

test('a/mx honour a dual-cidr prefix instead of falling through to -all', async () => {
    const withA: Zone = { 'ex.test': { a: ['192.0.2.1'] } };
    assert.strictEqual(await evaluate('v=spf1 a/24 -all', '192.0.2.77', withA), 'pass', 'inside the /24');
    assert.strictEqual(await evaluate('v=spf1 a/24 -all', '198.51.100.9', withA), 'fail', 'outside the /24');
    assert.strictEqual(await evaluate('v=spf1 a/0 -all', '203.0.113.7', { 'ex.test': { a: ['10.0.0.1'] } }), 'pass', '/0 matches everything');
    assert.strictEqual(await evaluate('v=spf1 a -all', '192.0.2.2', withA), 'fail', 'no prefix = exact match');
    // a:host/24 used to ask the resolver for the literal name "host/24" — EBADNAME, which is NOT
    // definitive, so it counted as a transient failure and DEFERRED the message with 451.
    assert.strictEqual(
        await evaluate('v=spf1 a:mail.ex.test/24 -all', '203.0.113.200', {
            'mail.ex.test': { a: ['203.0.113.5'] },
            'mail.ex.test/24': { a: 'BADNAME' } // if this name is ever queried, the result would be temperror
        }),
        'pass',
        'a:host/24 resolves the HOST'
    );
    assert.strictEqual(await evaluate('v=spf1 mx/24 -all', '198.51.100.250', { 'ex.test': { mx: ['mx1.ex.test'] }, 'mx1.ex.test': { a: ['198.51.100.10'] } }), 'pass', 'mx/24');
    assert.strictEqual(await evaluate('v=spf1 mx:relay.ex.test/24 -all', '198.51.100.250', { 'relay.ex.test': { mx: ['m.ex.test'] }, 'm.ex.test': { a: ['198.51.100.10'] } }), 'pass', 'mx:host/24');
});

test('the IPv6 arm of a dual-cidr is used for an IPv6 sender', async () => {
    const withAaaa: Zone = { 'ex.test': { aaaa: ['2001:db8:1:2::1'] } };
    assert.strictEqual(await evaluate('v=spf1 a//64 -all', '2001:db8:1:2:ffff::9', withAaaa), 'pass', 'inside the /64');
    assert.strictEqual(await evaluate('v=spf1 a//64 -all', '2001:db8:1:3::9', withAaaa), 'fail', 'a different /64');
    assert.strictEqual(await evaluate('v=spf1 a/24//64 -all', '192.0.2.99', { 'ex.test': { a: ['192.0.2.1'] } }), 'pass', 'v4 arm for a v4 sender');
    assert.strictEqual(await evaluate('v=spf1 a/24 -all', '2001:db8::2', { 'ex.test': { aaaa: ['2001:db8::1'] } }), 'fail', 'v4-only prefix does not widen a v6 match');
});

test('an out-of-range or malformed prefix is permerror, never a silent non-match', async () => {
    const withA: Zone = { 'ex.test': { a: ['192.0.2.1'] } };
    // Silently ignoring these is what turned the sender's (or their admin's) typo into OUR 550.
    for (const record of ['v=spf1 a/33 -all', 'v=spf1 a//129 -all', 'v=spf1 a/1234 -all', 'v=spf1 a//1234 -all', 'v=spf1 a/abc -all', 'v=spf1 mx/99999 -all', 'v=spf1 a:mail.ex.test/1234 -all']) {
        assert.strictEqual(await evaluate(record, '192.0.2.1', withA), 'permerror', record);
    }
    // permerror is accepted-and-tagged, so a broken record does not cost the sender their mail.
    const r = await deliver({ record: 'v=spf1 a/1234 -all', zone: { 'ex.test': { a: ['192.0.2.1'] } } });
    assert.strictEqual(r.code, 0, 'permerror must not become an SMTP refusal');
    assert.strictEqual(verdictOf(r.session), 'permerror', 'and the verdict is recorded, not discarded');
});

test('ip4:/ip6: CIDRs are left alone by the dual-cidr peeler', async () => {
    // For ip4:/ip6: the "/len" is part of the VALUE — an actual network that ipInCidr consumes.
    assert.strictEqual(await evaluate('v=spf1 ip4:192.0.2.0/24 -all', '192.0.2.55'), 'pass');
    assert.strictEqual(await evaluate('v=spf1 ip4:192.0.2.0/24 -all', '192.0.3.55'), 'fail');
    assert.strictEqual(await evaluate('v=spf1 ip6:2001:db8::/32 -all', '2001:db8:dead::1'), 'pass');
});

// --- 2b. RFC 7208 §5.6 — a BROKEN ip4:/ip6: term is permerror, not a non-match --------------------

test('a malformed or out-of-range ip4: CIDR is permerror, never a silent non-match', async () => {
    // Exactly the a/mx defect above, left half-done on the other two mechanisms: the ip4/ip6 arm read
    // `matched = ipInCidr(ip, value)`, and ipInCidr answers a plain `false` for a network it cannot
    // parse. "Broken term" and "this IP is not in that network" therefore became the same answer, so
    // evaluation walked on to the trailing -all and returned 'fail' -> SMTP 550 for a sender the
    // record explicitly authorizes. §5.6 makes a malformed or out-of-range prefix a permerror.
    for (const record of [
        'v=spf1 ip4:203.0.113.0/33 -all',      // prefix past the v4 family width
        'v=spf1 ip4:203.0.113.0/999 -all',
        'v=spf1 ip4:203.0.113.0/abc -all',     // parseInt would have said NaN -> false
        'v=spf1 ip4:203.0.113.0/ -all',        // bare trailing slash
        // The prefix gate has to validate the TEXT, not just parse it: every case below is one that
        // parseInt(x, 10) turns into a PLAUSIBLE number instead of NaN, so an isNaN+range check waves it
        // through and silently evaluates a network the record never wrote. See the forged-pass test below.
        'v=spf1 ip4:203.0.113.0/0x1f -all',    // alternate radix -> parseInt stops at 'x' -> 0 -> /0
        'v=spf1 ip4:203.0.113.0/1e2 -all',     // exponent notation -> 1 -> /1
        'v=spf1 ip4:203.0.113.0/24abc -all',   // trailing garbage -> 24
        'v=spf1 ip4:203.0.113.0/+24 -all',     // a sign is not in the §12 ABNF -> 24
        'v=spf1 ip4:203.0.113.0/24.9 -all',    // a fraction is not either -> 24
        'v=spf1 ip4:203.0.113.0//24 -all',     // the dual-cidr spelling is not legal on ip4:
        // …and the extra slash must be judged on its own, not left to the digit check below: this one
        // has a perfectly well-formed "/24" in second position, so dropping the slash-count guard
        // would silently evaluate it as 203.0.113.0/24 — a MATCH — for a record that is not valid.
        'v=spf1 ip4:203.0.113.0/24/24 -all',
        'v=spf1 ip4:203.0.113 -all',           // not an ip4-network at all
        'v=spf1 ip4:2001:db8::1 -all',         // right mechanism, wrong family
        'v=spf1 ip4: -all',                    // ip4-network is REQUIRED
        'v=spf1 ip4 -all'
    ]) {
        assert.strictEqual(await evaluate(record, '203.0.113.9'), 'permerror', record);
    }
});

test('a malformed or out-of-range ip6: CIDR is permerror, never a silent non-match', async () => {
    for (const record of [
        'v=spf1 ip6:2001:db8::/129 -all',
        'v=spf1 ip6:2001:db8::/abc -all',
        'v=spf1 ip6:2001:db8::/ -all',
        // The ip4 twins of these are in the test above, and they matter more here: the v6 family is 128
        // bits wide, so parseInt's leftovers ("0x40" -> 0) widen the term by a great deal more.
        'v=spf1 ip6:2001:db8::/0x40 -all',
        'v=spf1 ip6:2001:db8::/1e2 -all',
        'v=spf1 ip6:2001:db8::/64abc -all',
        'v=spf1 ip6:2001:db8::/+64 -all',
        'v=spf1 ip6:2001:db8::/64.9 -all',
        'v=spf1 ip6:2001:db8:://64 -all',
        'v=spf1 ip6:2001:db8::/64/64 -all',    // see the ip4 twin above: a second, VALID-looking prefix
        'v=spf1 ip6:not-an-address -all',
        'v=spf1 ip6:203.0.113.1 -all',         // right mechanism, wrong family
        'v=spf1 ip6 -all'
    ]) {
        assert.strictEqual(await evaluate(record, '2001:db8::9'), 'permerror', record);
    }
    // A broken term is broken for EVERY sender, including one of the other family that the term could
    // never have matched anyway — the record is unevaluable, so the verdict cannot be 'fail'.
    assert.strictEqual(await evaluate('v=spf1 ip6:2001:db8::/129 -all', '203.0.113.9'), 'permerror', 'v4 sender, broken ip6: term');
    assert.strictEqual(await evaluate('v=spf1 ip4:203.0.113.0/33 -all', '2001:db8::9'), 'permerror', 'v6 sender, broken ip4: term');
});

test('a non-decimal prefix cannot be re-parsed into a WIDER network (a forged pass)', async () => {
    // WHY THE PREFIX GATE VALIDATES THE TEXT RATHER THAN JUST PARSING IT. parseInt(x, 10) does not
    // reject what it cannot use — it stops there and returns what it already has. So "0x1f" is not NaN,
    // it is 0; "1e2" is 1; "24abc" is 24. An `isNaN(bits) || bits > totalBits` gate sees a perfectly
    // legal prefix in every one of those and cidrMatch then builds the mask for a network the record
    // never wrote — /0 for "0x1f", i.e. EVERY address on the internet.
    //
    // The harm is not a refusal (both verdicts below are accepted at SMTP time). It is that
    // "v=spf1 ip4:203.0.113.0/0x1f -all" would hand a 'pass' — the verdict DMARC alignment and every
    // downstream filter read as proof the domain authorised this sender — to an ARBITRARY unauthorised
    // one, off a record whose author authorised a single /24 and mistyped the length. §5.6 says an
    // unevaluable term is a permerror, and permerror is the only answer here that is not a forgery.
    //
    // The /abc, bare-/ and /999 cases in the tests above do NOT cover this: those are the shapes an
    // isNaN+range check also happens to catch, so on their own they leave the weaker gate green.
    const forgeries: Array<[string, string]> = [
        ['v=spf1 ip4:203.0.113.0/0x1f -all', '198.51.100.7'],  // -> 0  -> /0  -> matches everything
        ['v=spf1 ip4:203.0.113.0/1e2 -all', '198.51.100.7'],   // -> 1  -> /1  -> half of IPv4 space
        ['v=spf1 ip4:203.0.113.0/24abc -all', '203.0.113.9'],  // -> 24 -> the term evaluates as written
        ['v=spf1 ip4:203.0.113.0/+24 -all', '203.0.113.9'],
        ['v=spf1 ip6:2001:db8::/0x40 -all', '2606:4700::1111'],
        ['v=spf1 ip6:2001:db8::/1e2 -all', '2606:4700::1111'],
        ['v=spf1 ip6:2001:db8::/64abc -all', '2001:db8::9']
    ];
    for (const [record, sender] of forgeries) {
        const verdict = await evaluate(record, sender);
        assert.notStrictEqual(verdict, 'pass', `${record} must never authorise ${sender}`);
        assert.strictEqual(verdict, 'permerror', record);
    }

    // Through the REAL handler, since 'pass' vs 'permerror' is the entire difference: the record we
    // stamp on the message has to say the policy was unevaluable, not that we checked and it held.
    const forged = await deliver({ record: 'v=spf1 ip4:203.0.113.0/0x1f -all', ip: '198.51.100.7' });
    assert.strictEqual(verdictOf(forged.session), 'permerror', 'an unevaluable record must not be recorded as a pass');
    assert.strictEqual(forged.code, 0, 'and it still must not cost the sender their mail');
});

test('an ip6: network written with a dotted-quad tail is parsed as the address it IS', async () => {
    // RFC 4291 §2.2(3): the low 32 bits of an IPv6 literal may be written as a dotted quad, and all of
    // "::ffff:203.0.113.9", "64:ff9b::192.0.2.1" and "2001:db8::192.0.2.1" are legal addresses a domain
    // is free to publish in an ip6: term. The hextet expander reads each group with parseInt(p, 16),
    // which STOPS at the '.': "192.0.2.1" comes back as 0x192. Nothing raises a syntax error — the term
    // is a well-formed ip6-network, so there is no permerror to notice — the record simply evaluates
    // against a DIFFERENT network than the one it publishes, in whichever direction the digits fall.
    //
    // Both directions are covered below because both are real harm: the authorised sender that the
    // record names is silently 550-ed, and some unrelated address the record never mentioned is handed
    // a 'pass'.
    assert.strictEqual(
        SPF.cidrMatch('2001:db8::c000:201', '2001:db8::192.0.2.1', 6), true,
        'the dotted and hex spellings of ONE address must compare equal'
    );
    assert.strictEqual(
        SPF.cidrMatch('2001:db8::192', '2001:db8::192.0.2.1', 6), false,
        'and must not collapse onto the address parseInt happens to stop at'
    );
    // The quad can also sit directly behind the "::" (RFC 4291 §2.5.5.1), which is the other shape the
    // rewrite has to leave expandable — getting the zero-fill count wrong here shifts the whole address.
    assert.strictEqual(
        SPF.cidrMatch('::c000:201', '::192.0.2.1', 6), true,
        'a quad directly behind the "::" expands to the same address'
    );

    // Under-enforcement: the sender the record explicitly authorises.
    assert.strictEqual(
        await evaluate('v=spf1 ip6:2001:db8::192.0.2.1 -all', '2001:db8::c000:201'), 'pass',
        'the authorised sender is the one written in the record'
    );
    assert.strictEqual(
        await evaluate('v=spf1 ip6:64:ff9b::203.0.113.9/128 -all', '64:ff9b::cb00:7109'), 'pass',
        'with an explicit prefix too'
    );
    // The record and the sender must be compared as ADDRESSES, not as strings: this is the same address
    // in its two legal spellings. (Writing the sender in dotted form here too would prove nothing — both
    // sides would be mis-parsed identically and the errors would cancel.)
    assert.strictEqual(
        await evaluate('v=spf1 ip6:::ffff:203.0.113.9 -all', '::ffff:cb00:7109'), 'pass',
        'the IPv4-mapped spelling equals its hex spelling'
    );

    // Over-enforcement, the forged-pass half: 0x192 is where parseInt stops on "192.0.2.1", so a sender
    // at 2001:db8::192 used to inherit an authorisation written for 2001:db8::c000:201.
    assert.strictEqual(
        await evaluate('v=spf1 ip6:2001:db8::192.0.2.1 -all', '2001:db8::192'), 'fail',
        'an address the record never named must not inherit its authorisation'
    );
    assert.strictEqual(
        await evaluate('v=spf1 ip6:64:ff9b::203.0.113.9/120 -all', '64:ff9b::203'), 'fail',
        'and the same with a prefix'
    );

    // The negative control: a hex-only literal, which was never affected, still behaves exactly as before.
    assert.strictEqual(await evaluate('v=spf1 ip6:2001:db8::/32 -all', '2001:db8:dead::1'), 'pass', 'hex-only network');
    assert.strictEqual(await evaluate('v=spf1 ip6:2001:db8::/32 -all', '2001:db9::1'), 'fail', 'hex-only non-match');
});

test('a WELL-FORMED ip4:/ip6: term of the other family is an ordinary non-match', async () => {
    // The negative control for the two tests above: the fix must distinguish "broken" from "does not
    // apply". Publishing both families in one record is completely routine, and an ip6: mechanism has
    // simply nothing to say about an IPv4 connection — turning that into permerror would disable
    // enforcement on every dual-stack record on the internet.
    assert.strictEqual(
        await evaluate('v=spf1 ip6:2001:db8::/32 ip4:203.0.113.0/24 -all', '203.0.113.9'), 'pass',
        'the ip6: term is skipped, the ip4: term still matches'
    );
    assert.strictEqual(
        await evaluate('v=spf1 ip4:203.0.113.0/24 ip6:2001:db8::/32 -all', '2001:db8::9'), 'pass',
        'and the other way round'
    );
    assert.strictEqual(
        await evaluate('v=spf1 ip6:2001:db8::/32 -all', '203.0.113.9'), 'fail',
        'a non-matching family still falls through to -all, exactly as before'
    );
});

test('legal ip4:/ip6: prefixes still match at the family boundaries', async () => {
    // The other negative control: /32 and /128 are the LARGEST legal prefixes, /0 the smallest, and a
    // bare address carries no prefix at all. An over-eager range check would 'permerror' these.
    assert.strictEqual(await evaluate('v=spf1 ip4:203.0.113.9/32 -all', '203.0.113.9'), 'pass', 'ip4 /32');
    assert.strictEqual(await evaluate('v=spf1 ip4:0.0.0.0/0 -all', '203.0.113.9'), 'pass', 'ip4 /0');
    assert.strictEqual(await evaluate('v=spf1 ip4:203.0.113.9 -all', '203.0.113.9'), 'pass', 'ip4 bare address');
    assert.strictEqual(await evaluate('v=spf1 ip6:2001:db8::9/128 -all', '2001:db8::9'), 'pass', 'ip6 /128');
    assert.strictEqual(await evaluate('v=spf1 ip6:2001:db8::/0 -all', '2001:db8::9'), 'pass', 'ip6 /0');
    assert.strictEqual(await evaluate('v=spf1 ip6:2001:db8::9 -all', '2001:db8::9'), 'pass', 'ip6 bare address');
});

test('a broken ip4: CIDR costs the sender a header, not their mail (end to end)', async () => {
    // The harm, and the fix, measured through the REAL onMailFrom: 550 before, accepted-and-tagged now.
    const r = await deliver({ record: 'v=spf1 ip4:203.0.113.0/33 -all', ip: '203.0.113.9' });
    assert.strictEqual(r.code, 0, 'an unevaluable record must not become an SMTP refusal');
    assert.strictEqual(verdictOf(r.session), 'permerror', 'and the verdict is recorded, not discarded');
    // The fix must not become a blanket accept: a WELL-FORMED record that says no still says no.
    const spoofer = await deliver({ record: 'v=spf1 ip4:203.0.113.0/24 -all', ip: '198.51.100.7' });
    assert.strictEqual(spoofer.code, 550, 'a well-formed record still rejects an unauthorized sender');
});

test('ipInCidr stays a strict BOOLEAN for its non-SPF callers', () => {
    // isBlockedIp — the outbound-delivery SSRF guard — asks `V4_BLOCKED.some(c => ipInCidr(addr, c))`.
    // The "this term is malformed" signal must NEVER leak out of ipInCidr into that expression: any
    // non-boolean sentinel is truthy there, so every public MX would look like a private address and
    // the mail server would silently stop delivering ALL outbound mail.
    const probes: Array<[string, string | null]> = [
        ['203.0.113.9', '10.0.0.0/8'], ['10.1.2.3', '10.0.0.0/8'], ['203.0.113.9', '203.0.113.0/33'],
        ['203.0.113.9', '203.0.113.0/abc'], ['203.0.113.9', '203.0.113.0/'], ['203.0.113.9', 'garbage'],
        ['203.0.113.9', null], ['2001:db8::1', 'fc00::/7'], ['2001:db8::1', '10.0.0.0/8']
    ];
    for (const [ip, cidr] of probes) {
        assert.strictEqual(typeof SPF.ipInCidr(ip, cidr as string), 'boolean', `ipInCidr(${ip}, ${cidr})`);
    }
    // Driven through the REAL consumer, not just the type: the guard must still classify correctly.
    assert.strictEqual(SPF.isBlockedIp('203.0.113.9'), false, 'a public address is deliverable');
    assert.strictEqual(SPF.isBlockedIp('10.1.2.3'), true, 'RFC1918 is blocked');
    assert.strictEqual(SPF.isBlockedIp('169.254.169.254'), true, 'cloud metadata is blocked');
    assert.strictEqual(SPF.isBlockedIp('::ffff:10.1.2.3'), true, 'IPv4-mapped RFC1918 is blocked');
    assert.strictEqual(SPF.isBlockedIp('2606:4700::1111'), false, 'a public IPv6 address is deliverable');
});

// --- 3. redirect= (RFC 7208 §6.1) -----------------------------------------------------------------

test('redirect= is followed and replaces the record result', async () => {
    // gmail.com publishes "v=spf1 redirect=_spf.google.com". Unfollowed, SPF was a complete NO-OP for
    // the largest sender on the internet and a spoofed @gmail.com envelope sailed through as 'neutral'.
    const target: Zone = { '_spf.ex.test': { txt: ['v=spf1 ip4:192.0.2.0/24 -all'] } };
    assert.strictEqual(await evaluate('v=spf1 redirect=_spf.ex.test', '192.0.2.9', target), 'pass');
    assert.strictEqual(await evaluate('v=spf1 redirect=_spf.ex.test', '198.51.100.9', target), 'fail', 'the redirect target rejects too');
    // §6.1: a redirect in a record that HAS an all mechanism is ignored.
    assert.strictEqual(await evaluate('v=spf1 -all redirect=_spf.ex.test', '192.0.2.9', target), 'fail', 'all wins over redirect');
    // No policy at the redirect target is a BROKEN policy, not an absent one.
    assert.strictEqual(await evaluate('v=spf1 redirect=nowhere.test', '192.0.2.9'), 'permerror');
});

test('a redirect loop terminates in permerror instead of running away', async () => {
    assert.strictEqual(
        await evaluate('v=spf1 redirect=b.test', '192.0.2.9', {
            'b.test': { txt: ['v=spf1 redirect=c.test'] },
            'c.test': { txt: ['v=spf1 redirect=b.test'] }
        }),
        'permerror'
    );
});

// --- 4. temperror vs. genuine non-match -----------------------------------------------------------

test('a TRANSIENT DNS failure is temperror, not a fall-through to -all', async () => {
    // The bug that produced live 550s: a 32s queryTxt ETIMEOUT inside an a/mx term was caught, set
    // matched=false, and the trailing -all turned "we could not check" into "you are forged".
    assert.strictEqual(await evaluate(null, '192.0.2.1', { 'ex.test': { txt: 'SERVFAIL' } }), 'temperror', 'SERVFAIL on the TXT lookup');
    assert.strictEqual(await evaluate(null, '192.0.2.1', { 'ex.test': { txt: 'TIMEOUT' } }), 'temperror', 'timeout on the TXT lookup');
    assert.strictEqual(await evaluate('v=spf1 a -all', '192.0.2.1', { 'ex.test': { a: 'SERVFAIL' } }), 'temperror', 'SERVFAIL inside `a`');
    assert.strictEqual(await evaluate('v=spf1 mx -all', '192.0.2.1', { 'ex.test': { mx: 'SERVFAIL' } }), 'temperror', 'SERVFAIL inside `mx`');
    assert.strictEqual(await evaluate('v=spf1 include:o.test -all', '192.0.2.1', { 'o.test': { txt: 'SERVFAIL' } }), 'temperror', 'SERVFAIL inside `include`');
});

test('a DEFINITIVE "no such record" is a non-match / none, not an error', async () => {
    assert.strictEqual(await evaluate(null, '192.0.2.1'), 'none', 'the domain publishes no TXT at all');
    assert.strictEqual(await evaluate(null, '192.0.2.1', { 'ex.test': { txt: ['v=spf2.0/pra ~all'] } }), 'none', 'TXT records but no v=spf1 policy');
    assert.strictEqual(await evaluate('v=spf1 a -all', '192.0.2.1'), 'fail', 'ENODATA on `a` is a real non-match -> -all');
    assert.strictEqual(await evaluate('v=spf1 ip4:10.0.0.0/8 ~all', '192.0.2.7'), 'softfail', 'softfail is preserved');
    assert.strictEqual(await evaluate('v=spf1 ip4:10.0.0.0/8 ?all', '192.0.2.7'), 'neutral', 'neutral is preserved');
});

test('two v=spf1 records are permerror (an ambiguous policy is not a licence to reject)', async () => {
    SPF.__setDns(mkDns({ 'ex.test': { txt: ['v=spf1 ip4:1.1.1.1 -all', 'v=spf1 -all'] } }));
    assert.strictEqual(await SPF.evaluateSPF('ex.test', '192.0.2.1'), 'permerror');
    // "v=spf1-all" is NOT a v=spf1 record (the version token ends at a space or end-of-record).
    assert.strictEqual(await evaluate(null, '192.0.2.1', { 'ex.test': { txt: ['v=spf1-all'] } }), 'none');
});

// --- 5. RFC 7208 §4.6.4 global DNS lookup budget --------------------------------------------------

/** A record whose mechanisms each cost exactly one DNS lookup. */
function chainedIncludes(count: number): { record: string; zone: Zone } {
    const zone: Zone = {};
    const terms: string[] = [];
    for (let i = 0; i < count; i++) {
        terms.push(`include:i${i}.test`);
        zone[`i${i}.test`] = { txt: ['v=spf1 ip4:10.0.0.1 -all'] };
    }
    return { record: `v=spf1 ${terms.join(' ')} -all`, zone };
}

test('the DNS-lookup budget is GLOBAL to one evaluation and bounded at 10', async () => {
    const at = chainedIncludes(SPF.SPF_MAX_DNS_LOOKUPS);
    assert.strictEqual(await evaluate(at.record, '192.0.2.1', at.zone), 'fail', 'exactly 10 lookups is within budget');
    const over = chainedIncludes(SPF.SPF_MAX_DNS_LOOKUPS + 1);
    assert.strictEqual(await evaluate(over.record, '192.0.2.1', over.zone), 'permerror', 'the 11th lookup blows the budget');

    // BREADTH, not just depth: a per-level budget would let this through. Measured on the pre-fix code a
    // 10-wide x 5-deep tree turned ONE inbound message into 111,111 DNS queries.
    const zone: Zone = {};
    const top: string[] = [];
    for (let i = 0; i < 3; i++) {
        top.push(`include:t${i}.test`);
        const inner = [0, 1, 2].map(j => `include:t${i}n${j}.test`);
        zone[`t${i}.test`] = { txt: [`v=spf1 ${inner.join(' ')} -all`] };
        for (const n of inner) zone[n.slice('include:'.length)] = { txt: ['v=spf1 ip4:10.0.0.1 -all'] };
    }
    assert.strictEqual(await evaluate(`v=spf1 ${top.join(' ')} -all`, '192.0.2.1', zone), 'permerror', '3 + 9 lookups across 2 levels');
});

test('the budget is per-MESSAGE state, never module state', async () => {
    // If the counter ever became module-level, the second message in a process would start pre-charged
    // and every subsequent sender would silently permerror.
    const { record, zone } = chainedIncludes(SPF.SPF_MAX_DNS_LOOKUPS);
    assert.strictEqual(await evaluate(record, '192.0.2.1', zone), 'fail', '1st evaluation');
    assert.strictEqual(await evaluate(record, '192.0.2.1', zone), 'fail', '2nd evaluation');
    assert.strictEqual(await evaluate(record, '192.0.2.1', zone), 'fail', '3rd evaluation');
});

test('one `mx` term cannot fan out past the per-term cap, and ptr/exists are charged too', async () => {
    const many = Array.from({ length: SPF.SPF_MAX_MX_RECORDS + 1 }, (_, i) => `m${i}.test`);
    assert.strictEqual(await evaluate('v=spf1 mx -all', '192.0.2.1', { 'ex.test': { mx: many } }), 'permerror', '11 MX records');
    // ptr/exists are not EVALUATED (they need macro expansion) but they are DNS-consuming terms, so a
    // record must not be able to hide its fan-out behind exactly the terms we skip.
    const ptrs = Array.from({ length: SPF.SPF_MAX_DNS_LOOKUPS + 1 }, () => 'ptr').join(' ');
    assert.strictEqual(await evaluate(`v=spf1 ${ptrs} -all`, '192.0.2.1'), 'permerror', '11 ptr terms');
    const exists = Array.from({ length: SPF.SPF_MAX_DNS_LOOKUPS + 1 }, (_, i) => `exists:e${i}.test`).join(' ');
    assert.strictEqual(await evaluate(`v=spf1 ${exists} -all`, '192.0.2.1'), 'permerror', '11 exists terms');
});

// --- 6. Policy table + the tag-only override ------------------------------------------------------

test('spfAction maps every verdict to one SMTP outcome', () => {
    const table: Array<[string, boolean, { code: number; tagged: boolean }]> = [
        ['pass', true, { code: 0, tagged: false }],
        ['none', true, { code: 0, tagged: false }],
        ['neutral', true, { code: 0, tagged: false }],
        // An unevaluable policy is NOT a statement that the IP is unauthorized (§8.6) — never a refusal.
        ['permerror', true, { code: 0, tagged: true }],
        ['permerror', false, { code: 0, tagged: true }],
        ['temperror', true, { code: 451, tagged: true }],
        ['fail', true, { code: 550, tagged: true }],
        ['softfail', true, { code: 550, tagged: true }],
        // mail_security_spf_reject='0' — "do not turn SPF into a refusal, tag and let me filter".
        ['temperror', false, { code: 0, tagged: true }],
        ['fail', false, { code: 0, tagged: true }],
        ['softfail', false, { code: 0, tagged: true }]
    ];
    for (const [result, rejectEnabled, expected] of table) {
        assert.deepStrictEqual(SPF.spfAction(result, rejectEnabled), expected, `spfAction(${result}, reject=${rejectEnabled})`);
    }
});

test('tag-only gates EVERY SPF-driven refusal, the 451 included', async () => {
    const tagOnly = { mail_security_spf_reject: '0' };
    // The regression: the temperror branch ran BEFORE the option was read, so a tag-only site still had
    // mail DEFERRED on any resolver hiccup. A 451 is not a rejection, but the sender queues, retries for
    // days and eventually bounces — precisely the outcome the operator opted out of.
    const temp = await deliver({ record: 'v=spf1 a -all', zone: { 'ex.test': { a: 'SERVFAIL' } }, options: tagOnly });
    assert.strictEqual(temp.code, 0, 'tag-only + temperror is accepted');
    assert.strictEqual(verdictOf(temp.session), 'temperror', 'and the verdict is still recorded');

    const hard = await deliver({ record: 'v=spf1 -all', options: tagOnly });
    assert.strictEqual(hard.code, 0, 'tag-only + hard fail is accepted');
    assert.strictEqual(verdictOf(hard.session), 'fail');

    const soft = await deliver({ record: 'v=spf1 ~all', options: tagOnly });
    assert.strictEqual(soft.code, 0, 'tag-only + softfail is accepted');
});

test('the DEFAULT (reject enabled) still defers and rejects', async () => {
    const deferred = await deliver({ record: 'v=spf1 a -all', zone: { 'ex.test': { a: 'SERVFAIL' } } });
    assert.strictEqual(deferred.code, 451, 'temperror defers so the sender retries');
    assert.match(deferred.message, /try again later/i);
    const rejected = await deliver({ record: 'v=spf1 -all' });
    assert.strictEqual(rejected.code, 550, 'an explicit fail is a permanent rejection');
});

test('onMailFrom skips SPF where it must and fails CLOSED where it must', async () => {
    const off = await deliver({ record: 'v=spf1 -all', options: { mail_security_spf_enabled: '0' } });
    assert.strictEqual(off.code, 0, 'the operator disabled SPF');
    assert.strictEqual(off.session.spfHeader, undefined, 'and nothing is recorded');

    const loopback = await deliver({ record: 'v=spf1 -all', ip: '127.0.0.1' });
    assert.strictEqual(loopback.code, 0, 'our own relay path is never SPF-gated');
    assert.strictEqual(loopback.session.spfHeader, undefined);

    const bridgeDown = await deliver({ record: 'v=spf1 ip4:203.0.113.9 -all', optionBridgeDown: true });
    assert.strictEqual(bridgeDown.code, 451, 'if we cannot read the policy options we defer, not accept');
});

test('an unexpected throw out of evaluateSPF becomes temperror, and the header says so', async () => {
    // A malformed (non-array) TXT answer reaches `.map` OUTSIDE evaluateSPF's own try — the real path
    // into onMailFrom's catch. The old code left result='none', so the header claimed 'none' while we
    // 451-ed: the record and the action disagreed.
    SPF.__setDns({
        resolveTxt: async () => ({ not: 'an array' }),
        resolve4: async () => [], resolve6: async () => [], resolveMx: async () => []
    });
    SPF.__setGetOption(async (_k, d) => d);
    SPF.__setSiteDomain('mx.site.test');
    const session: any = { remoteAddress: '203.0.113.9', clientHostname: 'h.test' };
    const err = await new Promise<any>((resolve) => SPF.onMailFrom({ address: 'a@ex.test' }, session, (e) => resolve(e)));
    assert.strictEqual(err ? err.responseCode : 0, 451);
    assert.strictEqual(verdictOf(session), 'temperror');
});

test('an IPv4-mapped sender address is normalised before evaluation', async () => {
    // A dual-stack listener reports IPv4 peers as ::ffff:1.2.3.4, which matches no ip4: mechanism.
    const r = await deliver({ record: 'v=spf1 ip4:203.0.113.9 -all', ip: '::ffff:203.0.113.9' });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(verdictOf(r.session), 'pass');
});

// --- 7. Received-SPF (RFC 7208 §9.1) --------------------------------------------------------------

test('the recorded verdict always AGREES with the action taken', async () => {
    const cases: Array<[string, string, Zone]> = [
        ['v=spf1 ip4:203.0.113.9 -all', 'pass', {}],
        ['v=spf1 ?all', 'neutral', {}],
        ['v=spf1 ~all', 'softfail', {}],
        ['v=spf1 -all', 'fail', {}],
        ['v=spf1 a/33 -all', 'permerror', { 'ex.test': { a: ['192.0.2.1'] } }],
        ['v=spf1 a -all', 'temperror', { 'ex.test': { a: 'SERVFAIL' } }]
    ];
    for (const [record, expected, zone] of cases) {
        const r = await deliver({ record, zone });
        assert.strictEqual(verdictOf(r.session), expected, `${record} -> ${expected}`);
    }
});

test('the SPF verdict is recorded in exactly ONE place — the field onData reads', async () => {
    // onData persists session.spfHeader into the message row's received_spf column. A parallel
    // session.spfResult was also written and had ZERO readers repo-wide; a verdict stashed on the
    // session that nothing consumes is the "silent enforcement loss" defect wearing a fix's clothes.
    const r = await deliver({ record: 'v=spf1 -all', options: { mail_security_spf_reject: '0' } });
    assert.strictEqual(typeof r.session.spfHeader, 'string', 'spfHeader is what onData persists');
    assert.ok(
        !('spfResult' in r.session),
        'onMailFrom must not write session fields nothing reads — wire a consumer or drop the write'
    );
});

test('Received-SPF has the RFC 7208 §9.1 shape', () => {
    const h = SPF.buildReceivedSpf('pass', {
        domain: 'ex.test', mailFrom: 'a@ex.test', ip: '203.0.113.9', helo: 'relay.ex.test', receiver: 'mx.site.test'
    });
    assert.match(h, /^Received-SPF: pass \(mx\.site\.test: [^)]+\) /, 'field name, result, then the comment');
    assert.match(h, /client-ip=203\.0\.113\.9;/);
    assert.match(h, /envelope-from=<a@ex\.test>;/);
    assert.match(h, /helo=relay\.ex\.test;/);
    assert.match(h, /receiver=mx\.site\.test;/);
    assert.match(h, /identity=mailfrom;$/);
    // A verdict outside the RFC's result set must be clamped, never interpolated raw.
    assert.strictEqual(SPF.buildReceivedSpf('bogus', {}).split(' ')[1], 'none');
    for (const v of ['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror']) {
        assert.strictEqual(SPF.buildReceivedSpf(v, { ip: '1.2.3.4' }).split(' ')[1], v, `${v} survives verbatim`);
    }
});

test('Received-SPF cannot be used to inject a second header', () => {
    // Every interpolated value except the result is remote-controlled (envelope sender, HELO).
    const h = SPF.buildReceivedSpf('fail', {
        domain: 'ex.test',
        mailFrom: 'a@b.test\r\nX-Injected: yes',
        ip: '203.0.113.9',
        helo: 'h\r\nBcc: victim@example.test',
        receiver: 'mx.site.test'
    });
    assert.ok(!/[\r\n]/.test(h), 'no CR or LF survives into the header');
    assert.strictEqual(h.split(/\r|\n/).length, 1, 'the whole field stays ONE line');
    assert.ok(!/X-Injected/i.test(h) || !/\n/.test(h), 'no forged header boundary');
    // Control chars, header-grammar chars and non-ASCII are scrubbed; the field is length-capped.
    assert.ok(!/[^\x20-\x7e]/.test(SPF.sanitizeHeaderValue('josé@ex.test')), 'non-ASCII and control chars removed');
    assert.ok(!/[()<>;]/.test(SPF.sanitizeHeaderValue('a(b)c<d>e;f')), 'header-grammar chars removed');
    assert.ok(
        SPF.buildReceivedSpf('pass', { mailFrom: 'x'.repeat(5000) + '@y.test', ip: '1.2.3.4' }).length < 2000,
        'an oversized envelope sender cannot blow up the header'
    );
});
