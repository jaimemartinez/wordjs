/**
 * QR Code encoder for the badges (conference-manager 2.22.0) — the server's copy of client/lib/qr.ts, so the
 * PDF and the credential page draw the very symbol the admin shows and the meal scanner reads. No dependency.
 * A parity test keeps the two encoders equal, and a round-trip test decodes what they draw.
 *
 * ISO/IEC 18004, model 2: versions 1-10 (up to 57×57 modules — a registration code needs version 1),
 * alphanumeric mode when every character allows it (the registration codes: A-Z and 2-9), else byte mode
 * (UTF-8). The smallest version that holds the text at the requested error-correction level is used, and the
 * mask with the lowest penalty score.
 */
'use strict';

const MAX_VERSION = 10;
// Per version 1-10 (index 0 unused), from the specification's table 9.
const ECC_CODEWORDS_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const NUM_ERROR_CORRECTION_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function rawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7) result -= 36;
    }
    return result;
}
const dataCodewords = (ver, ecl) => Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];

function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
}

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}
function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}
function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
    }
    return result;
}

/** The payload as bits: mode, character count, data (alphanumeric when possible, else UTF-8 bytes). */
function segmentBits(text) {
    const alnum = text.length > 0 && [...text].every((ch) => ALPHANUMERIC.includes(ch));
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    if (alnum) {
        for (let i = 0; i + 1 < text.length; i += 2) push(ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
        if (text.length % 2) push(ALPHANUMERIC.indexOf(text[text.length - 1]), 6);
        return { mode: 0x2, count: text.length, bits, countBits: (ver) => (ver <= 9 ? 9 : 11) };
    }
    const bytes = [...new TextEncoder().encode(text)];
    for (const b of bytes) push(b, 8);
    return { mode: 0x4, count: bytes.length, bits, countBits: (ver) => (ver <= 9 ? 8 : 16) };
}

/**
 * Encode `text` as a QR Code. `ecl` = 'L' | 'M' | 'Q' | 'H' (default 'M').
 * Returns { version, size, modules } — modules[y][x], true = dark — without the quiet zone.
 */
function encodeQr(text, ecl = 'M') {
    const s = String(text == null ? '' : text);
    if (!s.length) throw new Error('qr: empty text');
    if (!FORMAT_BITS.hasOwnProperty(ecl)) throw new Error('qr: bad error-correction level');
    const seg = segmentBits(s);
    let ver = 1;
    for (; ver <= MAX_VERSION; ver++) {
        if (seg.count >= 1 << seg.countBits(ver)) continue;
        if (4 + seg.countBits(ver) + seg.bits.length <= dataCodewords(ver, ecl) * 8) break;
    }
    if (ver > MAX_VERSION) throw new Error('qr: text too long');

    // Data codewords: mode, count, data, terminator, byte padding, pad codewords.
    const capacity = dataCodewords(ver, ecl) * 8;
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(seg.mode, 4);
    push(seg.count, seg.countBits(ver));
    for (const b of seg.bits) bits.push(b);
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        data.push(byte);
    }

    // Error correction per block, then interleaved.
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    const rawCodewords = Math.floor(rawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(blockEccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
        k += dat.length;
        const ecc = rsRemainder(dat, divisor);
        if (i < numShortBlocks) dat.push(0);
        blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
            if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(block[i]);
        });
    }

    // The matrix: function patterns, then the codewords in the zigzag order.
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setFn(x, y, dist !== 2 && dist !== 4);
        }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const align = alignmentPositions(ver, size);
    for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = (mask) => {
        const d = (FORMAT_BITS[ecl] << 3) | mask;
        let rem = d;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const f = ((d << 10) | rem) ^ 0x5412;
        const bit = (i) => ((f >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
        setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
        for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
        setFn(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const v = (ver << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const dark = ((v >>> i) & 1) !== 0;
            const a = size - 11 + (i % 3), b = Math.floor(i / 3);
            setFn(a, b, dark); setFn(b, a, dark);
        }
    }
    let n = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!isFunction[y][x] && n < codewords.length * 8) {
                    modules[y][x] = ((codewords[n >>> 3] >>> (7 - (n & 7))) & 1) !== 0;
                    n++;
                }
            }
        }
    }

    const applyMask = (mask) => {
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            if (isFunction[y][x]) continue;
            let invert;
            switch (mask) {
                case 0: invert = (x + y) % 2 === 0; break;
                case 1: invert = y % 2 === 0; break;
                case 2: invert = x % 3 === 0; break;
                case 3: invert = (x + y) % 3 === 0; break;
                case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
                case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            }
            if (invert) modules[y][x] = !modules[y][x];
        }
    };
    let best = 0, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        applyMask(mask);
        drawFormat(mask);
        const score = penalty(modules);
        if (score < bestScore) { best = mask; bestScore = score; }
        applyMask(mask);
    }
    applyMask(best);
    drawFormat(best);
    return { version: ver, size, modules };
}

/** The specification's mask penalty (rules N1-N4); only used to pick a mask — every mask decodes. */
function penalty(m) {
    const size = m.length;
    let score = 0, dark = 0;
    const FINDER_LIKE = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];
    for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
            const at = (b) => (pass === 0 ? m[a][b] : m[b][a]);
            let run = 1;
            for (let b = 1; b <= size; b++) {
                if (b < size && at(b) === at(b - 1)) { run++; continue; }
                if (run >= 5) score += 3 + (run - 5);
                run = 1;
            }
            for (let b = 0; b + 11 <= size; b++) {
                for (const pat of FINDER_LIKE) {
                    let match = true;
                    for (let k = 0; k < 11 && match; k++) if ((at(b + k) ? 1 : 0) !== pat[k]) match = false;
                    if (match) score += 40;
                }
            }
        }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (m[y][x]) dark++;
        if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
}

/** The modules as one '0'/'1' string per row (the display list's compact form). */
const qrRows = (qr) => qr.modules.map((row) => row.map((d) => (d ? '1' : '0')).join(''));

module.exports = { encodeQr, qrRows, ALPHANUMERIC };
