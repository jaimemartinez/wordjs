'use strict';
/**
 * src/upstream-down.js — a browser asking for a page while the service behind it is down gets an HTML
 * page (503 + Retry-After), an API client the JSON it parses. QA X1-04: visitors saw raw JSON.
 */
const test = require('node:test');
const assert = require('node:assert');

const { sendUpstreamFailure, wantsHtmlPage } = require('../src/upstream-down');

function fakeRes() {
    const headers = {};
    return {
        headersSent: false,
        statusCode: 200,
        headers,
        body: undefined,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        end(b) { this.body = b; this.headersSent = true; },
    };
}

const NAV = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

test('only a page navigation outside /api and /_next wants the HTML page', () => {
    assert.strictEqual(wantsHtmlPage({ method: 'GET', url: '/', headers: { accept: NAV } }), true);
    assert.strictEqual(wantsHtmlPage({ method: 'HEAD', url: '/blog', headers: { accept: NAV } }), true);
    assert.strictEqual(wantsHtmlPage({ method: 'GET', url: '/api/v1/posts', headers: { accept: NAV } }), false);
    assert.strictEqual(wantsHtmlPage({ method: 'GET', url: '/_next/static/x.js', headers: { accept: NAV } }), false);
    assert.strictEqual(wantsHtmlPage({ method: 'POST', url: '/login', headers: { accept: NAV } }), false);
    assert.strictEqual(wantsHtmlPage({ method: 'GET', url: '/', headers: { accept: 'application/json' } }), false);
    assert.strictEqual(wantsHtmlPage({ method: 'GET', url: '/', headers: {} }), false);
});

test('a refused upstream: 503 + Retry-After, an HTML page for a browser', () => {
    const res = fakeRes();
    sendUpstreamFailure({ method: 'GET', url: '/', headers: { accept: NAV } }, res, 'down');
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.headers['retry-after'], '10');
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body, /<!doctype html>/i);
    assert.match(res.body, /back in a moment/i);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
});

test('a refused upstream: the same JSON body as before for an API client', () => {
    const res = fakeRes();
    sendUpstreamFailure({ method: 'GET', url: '/api/v1/posts', headers: { accept: 'application/json' } }, res, 'down');
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(JSON.parse(res.body), { error: 'Service Unavailable', message: 'The upstream service is starting or down.' });
});

test('a failure mid-way stays 502 without Retry-After', () => {
    const res = fakeRes();
    sendUpstreamFailure({ method: 'GET', url: '/api/v1/x', headers: {} }, res, 'error');
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.headers['retry-after'], undefined);
    assert.strictEqual(JSON.parse(res.body).error, 'Upstream Error');
});

test('nothing is written twice', () => {
    const res = fakeRes();
    res.headersSent = true;
    sendUpstreamFailure({ method: 'GET', url: '/', headers: { accept: NAV } }, res, 'down');
    assert.strictEqual(res.body, undefined);
});
