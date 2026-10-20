/**
 * PNG → raw pixels for the badge PDF (conference-manager 2.29.0): the designer's images may be PNGs with
 * transparency (a logo), which a PDF draws as an RGB image plus a soft mask. Non-interlaced 8-bit PNGs of
 * every colour type (grey, RGB, palette, grey + alpha, RGBA) — what a browser canvas and the usual tools
 * write; anything else answers null and the image is left out of the PDF (the designer never sends one).
 */
'use strict';

const zlib = require('zlib');

const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const MAX_PIXELS = 25 * 1000 * 1000;

/** { w, h, rgb: Buffer (w·h·3), alpha: Buffer (w·h) | null } or null. */
function decodePng(buf) {
    if (!buf || buf.length < 33 || SIG.some((b, i) => buf[i] !== b)) return null;
    let i = 8, w = 0, h = 0, depth = 0, type = -1, interlace = 0;
    let palette = null, trns = null;
    const idat = [];
    while (i + 8 <= buf.length) {
        const len = buf.readUInt32BE(i);
        const tag = buf.toString('latin1', i + 4, i + 8);
        const data = buf.subarray(i + 8, i + 8 + len);
        if (tag === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
        else if (tag === 'PLTE') palette = data;
        else if (tag === 'tRNS') trns = data;
        else if (tag === 'IDAT') idat.push(data);
        else if (tag === 'IEND') break;
        i += 12 + len;
    }
    if (!w || !h || w * h > MAX_PIXELS || depth !== 8 || interlace !== 0) return null;
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    if (!channels || (type === 3 && !palette)) return null;
    let raw;
    try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return null; }
    const stride = w * channels;
    if (raw.length < h * (stride + 1)) return null;
    // Undo the per-row filters.
    const px = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? px[dst + x - channels] : 0;
            const b = y > 0 ? px[prev + x] : 0;
            const c = y > 0 && x >= channels ? px[prev + x - channels] : 0;
            let v = raw[src + x];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            else if (f !== 0) return null;
            px[dst + x] = v & 255;
        }
    }
    const n = w * h;
    const rgb = Buffer.alloc(n * 3);
    const alpha = Buffer.alloc(n);
    let opaque = true;
    for (let p = 0; p < n; p++) {
        let r, g, b, a = 255;
        if (type === 0) { r = g = b = px[p]; }
        else if (type === 2) { r = px[p * 3]; g = px[p * 3 + 1]; b = px[p * 3 + 2]; }
        else if (type === 3) { const k = px[p]; r = palette[k * 3] || 0; g = palette[k * 3 + 1] || 0; b = palette[k * 3 + 2] || 0; if (trns && k < trns.length) a = trns[k]; }
        else if (type === 4) { r = g = b = px[p * 2]; a = px[p * 2 + 1]; }
        else { r = px[p * 4]; g = px[p * 4 + 1]; b = px[p * 4 + 2]; a = px[p * 4 + 3]; }
        rgb[p * 3] = r; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = b;
        alpha[p] = a;
        if (a !== 255) opaque = false;
    }
    return { w, h, rgb, alpha: opaque ? null : alpha };
}

module.exports = { decodePng };
