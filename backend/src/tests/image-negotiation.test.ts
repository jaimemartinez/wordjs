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
    // In a SUBDIRECTORY, so a request can carry an INTERNAL duplicate slash (leading ones were already
    // stripped) — the shape that used to mint a fresh cache key for the same file.
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 200, b: 90 } } })
        .jpeg().toFile(path.join(dir, 'sub', 'nested.jpg'));
    // Over the decoded-size budget (3500*2400*3 = 25.2MB > 24MB) so negotiation must decline it.
    await sharp({ create: { width: 3500, height: 2400, channels: 3, background: { r: 200, g: 30, b: 30 } } })
        .jpeg().toFile(path.join(dir, 'huge.jpg'));
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

const walkDerivatives = (): string[] => {
    const derivDir = path.join(dir, '.derivatives');
    if (!fs.existsSync(derivDir)) return [];
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
        .flatMap((e: any) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    return walk(derivDir);
};

// SECURITY (DoS) — the cache key hashed the RAW request path while the source lookup used path.join,
// which normalizes. So '/sub/nested.jpg' and '/sub//nested.jpg' resolved to the same file on disk under
// DIFFERENT keys: each spelling was a cache MISS that started another full-resolution transcode. The
// slash count is unbounded, so one publicly-linked image was an unlimited supply of misses for an
// ANONYMOUS client — no account, no crafted upload, and /uploads is behind no rate limiter.
test('duplicate slashes do NOT mint a new derivative for the same file', async () => {
    const first = await request(app).get('/uploads/sub/nested.jpg').set('Accept', 'image/avif');
    assert.strictEqual(first.headers['content-type'], 'image/avif');
    const after1 = walkDerivatives().length;

    for (const url of ['/uploads/sub//nested.jpg', '/uploads/sub///nested.jpg', '/uploads//sub////nested.jpg']) {
        const res = await request(app).get(url).set('Accept', 'image/avif');
        assert.strictEqual(res.headers['content-type'], 'image/avif', `${url} must still serve the derivative`);
    }
    assert.strictEqual(walkDerivatives().length, after1,
        'every spelling of the same path must hit the SAME cached derivative, not transcode again');
});

// SECURITY (DoS) — limitInputPixels bounds PIXELS, but the cost that OOMs a host is the decoded buffer
// plus the encoder's working set. Measured: a 24MP source cost 1120MB peak RSS and 18.3s for ONE
// anonymous GET, well under the 40MP pixel cap. Over the decoded-byte budget we must decline and let
// express.static serve the original — identical bytes and dimensions for every client.
test('an over-budget image is NOT transcoded — the original is served instead', async () => {
    const before = walkDerivatives().length;
    const res = await request(app).get('/uploads/huge.jpg').set('Accept', 'image/avif,image/webp,*/*');
    assert.strictEqual(res.status, 200, 'it must still be served, just not transcoded');
    assert.strictEqual(res.headers['x-served-by'], 'static', 'must fall through to the original');
    assert.match(res.headers['content-type'] || '', /image\/jpeg/);
    assert.strictEqual(walkDerivatives().length, before, 'no derivative may be produced for an over-budget source');
});
