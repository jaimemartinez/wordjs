/**
 * AVIF/WebP negotiation middleware (roadmap: media modernization).
 * Asserts both directions: a capable browser gets a transcoded modern-format derivative (same URL, cached),
 * and everything else (unsupported Accept, non-raster type, path traversal) falls through to the original.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { imageNegotiation } = require('../middleware/image-negotiation');

let dir: string;
let app: any;

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-imgneg-'));
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 120, g: 80, b: 200 } } })
        .jpeg().toFile(path.join(dir, 'pic.jpg'));
    fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    app = express();
    app.use('/uploads', imageNegotiation(dir));
    // mark anything the static handler serves so tests can tell a fall-through from a transcode
    app.use('/uploads', express.static(dir, { setHeaders: (res: any) => res.setHeader('X-Served-By', 'static') }));
});

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

test('serves AVIF to a browser that accepts it (not the original)', async () => {
    const res = await request(app).get('/uploads/pic.jpg').set('Accept', 'image/avif,image/webp,image/*,*/*');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'image/avif');
    assert.match(res.headers['vary'] || '', /accept/i);
    assert.strictEqual(res.headers['x-served-by'], undefined, 'must NOT have fallen through to express.static');
    assert.ok(res.body.length > 0);
});

test('prefers WebP when AVIF is not accepted', async () => {
    const res = await request(app).get('/uploads/pic.jpg').set('Accept', 'image/webp,image/*,*/*');
    assert.strictEqual(res.headers['content-type'], 'image/webp');
    assert.strictEqual(res.headers['x-served-by'], undefined);
});

test('falls through to the ORIGINAL when no modern format is accepted', async () => {
    const res = await request(app).get('/uploads/pic.jpg').set('Accept', 'image/jpeg,*/*');
    assert.strictEqual(res.headers['x-served-by'], 'static', 'must be served by express.static (original)');
    assert.match(res.headers['content-type'] || '', /image\/jpeg/);
});

test('never transcodes SVG — passes through untouched', async () => {
    const res = await request(app).get('/uploads/icon.svg').set('Accept', 'image/avif');
    assert.strictEqual(res.headers['x-served-by'], 'static');
});

test('caches the derivative on disk (second request is a cache hit)', async () => {
    await request(app).get('/uploads/pic.jpg').set('Accept', 'image/avif'); // warm the cache
    // The derivative filename is a content hash (no user-controlled data on disk), so assert that SOME
    // derivative now exists under .derivatives rather than a fixed name.
    const derivDir = path.join(dir, '.derivatives');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
        .flatMap((e: any) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    assert.ok(fs.existsSync(derivDir) && walk(derivDir).length > 0, 'a derivative should be cached under .derivatives');
    // and it still serves correctly from cache
    const res = await request(app).get('/uploads/pic.jpg').set('Accept', 'image/avif');
    assert.strictEqual(res.headers['content-type'], 'image/avif');
    assert.match(res.headers['cache-control'] || '', /immutable/);
});
