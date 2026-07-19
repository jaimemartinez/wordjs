// @ts-nocheck
/**
 * Minimal QR encoder (ISO/IEC 18004) — byte mode, error-correction level M, versions 1–10
 * (≈ up to 213 bytes — far beyond any table-QR URL). Zero dependencies: the admin page renders
 * table QR codes fully client-side (the sandbox/frontend ships no QR library).
 *
 * Returns a boolean module matrix; qrSvg() wraps it in a crisp print-ready SVG.
 */

// ---- GF(256) arithmetic for Reed-Solomon (polynomial 0x11D) --------------------------------------
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed-Solomon EC codewords for a data block. */
function rsEncode(data, ecLen) {
    // Generator polynomial: Π (x − α^i), i = 0..ecLen−1
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
        const next = new Array(gen.length + 1).fill(0);
        for (let j = 0; j < gen.length; j++) {
            next[j] ^= gen[j];
            next[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
        }
        gen = next;
    }
    const res = new Array(ecLen).fill(0);
    for (const d of data) {
        const factor = d ^ res[0];
        res.shift();
        res.push(0);
        if (factor !== 0) {
            for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j + 1], factor);
        }
    }
    return res;
}

// ---- version tables (error-correction level M only) ----------------------------------------------
// [totalDataCodewords, ecPerBlock, blocks: [count, dataPerBlock][]]
const VERSIONS = [
    null,
    { data: 16, ec: 10, blocks: [[1, 16]] },
    { data: 28, ec: 16, blocks: [[1, 28]] },
    { data: 44, ec: 26, blocks: [[1, 44]] },
    { data: 64, ec: 18, blocks: [[2, 32]] },
    { data: 86, ec: 24, blocks: [[2, 43]] },
    { data: 108, ec: 16, blocks: [[4, 27]] },
    { data: 124, ec: 18, blocks: [[4, 31]] },
    { data: 154, ec: 22, blocks: [[2, 38], [2, 39]] },
    { data: 182, ec: 22, blocks: [[3, 36], [2, 37]] },
    { data: 216, ec: 26, blocks: [[4, 43], [1, 44]] },
];

const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function utf8Bytes(s) {
    const out = [];
    for (const ch of String(s)) {
        const cp = ch.codePointAt(0);
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return out;
}

/** BCH-protected 15-bit format info (level M) for a mask id. */
function formatBits(mask) {
    const data = (0 << 3) | mask; // EC level M = 0b00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
    return (((data << 10) | (rem & 0x3ff)) ^ 0x5412) & 0x7fff;
}

/** BCH-protected 18-bit version info (versions ≥ 7). */
function versionBits(v) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) & 1 ? 0x1f25 : 0);
    return ((v << 12) | (rem & 0xfff)) & 0x3ffff;
}

const MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i, j) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

/** Standard penalty score — lower is better (any mask yields a valid symbol). */
function penalty(m) {
    const n = m.length;
    let score = 0;
    // N1: runs of ≥5 same-color modules (rows + cols)
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
            let run = 1;
            let prev = pass ? m[0][i] : m[i][0];
            for (let j = 1; j < n; j++) {
                const cur = pass ? m[j][i] : m[i][j];
                if (cur === prev) {
                    run++;
                    if (j === n - 1 && run >= 5) score += 3 + (run - 5);
                } else {
                    if (run >= 5) score += 3 + (run - 5);
                    run = 1;
                    prev = cur;
                }
            }
        }
    }
    // N2: 2×2 blocks
    for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < n - 1; j++) {
            const v = m[i][j];
            if (m[i][j + 1] === v && m[i + 1][j] === v && m[i + 1][j + 1] === v) score += 3;
        }
    }
    // N3: finder-like 1:1:3:1:1 pattern with 4 light modules on a side
    const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    const pat2 = pat1.slice().reverse();
    const matches = (get, i, pat) => pat.every((p, k) => get(i + k) === p);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= n - 11; j++) {
            if (matches((k) => m[i][k], j, pat1) || matches((k) => m[i][k], j, pat2)) score += 40;
            if (matches((k) => m[k][i], j, pat1) || matches((k) => m[k][i], j, pat2)) score += 40;
        }
    }
    // N4: dark-module proportion deviation from 50%
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
    return score;
}

/**
 * Encode text → boolean[][] module matrix (true = dark), or null when it doesn't fit v10-M.
 */
export function qrModules(text) {
    const bytes = utf8Bytes(text);

    // Pick the smallest version that fits: 4 mode bits + count bits + payload ≤ data bits.
    let version = 0;
    for (let v = 1; v <= 10; v++) {
        const countBits = v <= 9 ? 8 : 16;
        if (4 + countBits + bytes.length * 8 <= VERSIONS[v].data * 8) { version = v; break; }
    }
    if (!version) return null;
    const spec = VERSIONS[version];
    const size = version * 4 + 17;

    // ---- bit stream ------------------------------------------------------------------------------
    const bits = [];
    const push = (val, len) => { for (let k = len - 1; k >= 0; k--) bits.push((val >> k) & 1); };
    push(4, 4); // byte mode
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const cap = spec.data * 8;
    push(0, Math.min(4, cap - bits.length)); // terminator
    while (bits.length % 8 !== 0) bits.push(0);
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
        codewords.push(b);
    }
    const PADS = [0xec, 0x11];
    let padIdx = 0;
    while (codewords.length < spec.data) codewords.push(PADS[(padIdx++) % 2]);

    // ---- block split + Reed-Solomon + interleave -------------------------------------------------
    const dataBlocks = [];
    const ecBlocks = [];
    let off = 0;
    for (const [count, dlen] of spec.blocks) {
        for (let b = 0; b < count; b++) {
            const block = codewords.slice(off, off + dlen);
            off += dlen;
            dataBlocks.push(block);
            ecBlocks.push(rsEncode(block, spec.ec));
        }
    }
    const inter = [];
    const maxD = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxD; i++) for (const b of dataBlocks) if (i < b.length) inter.push(b[i]);
    for (let i = 0; i < spec.ec; i++) for (const b of ecBlocks) inter.push(b[i]);

    // ---- matrix skeleton (null = data slot) ------------------------------------------------------
    const m = Array.from({ length: size }, () => new Array(size).fill(null));
    const setFn = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v; };

    const placeFinder = (r, c) => {
        for (let i = -1; i <= 7; i++) {
            for (let j = -1; j <= 7; j++) {
                const inside = i >= 0 && i <= 6 && j >= 0 && j <= 6;
                const dark = inside && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4));
                setFn(r + i, c + j, dark);
            }
        }
    };
    placeFinder(0, 0);
    placeFinder(0, size - 7);
    placeFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
        if (m[6][i] === null) m[6][i] = i % 2 === 0;
        if (m[i][6] === null) m[i][6] = i % 2 === 0;
    }

    // Alignment patterns — skipped ONLY at the three finder corners; centers on the timing
    // row/column (e.g. (6,22) on v7) are real and overwrite the timing modules they cover.
    const centers = ALIGNMENT[version];
    for (const r of centers) {
        for (const c of centers) {
            const inFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
            if (inFinder) continue;
            for (let i = -2; i <= 2; i++) {
                for (let j = -2; j <= 2; j++) {
                    m[r + i][c + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1;
                }
            }
        }
    }

    // Reserve format areas (filled after masking) + dark module
    for (let i = 0; i < 9; i++) {
        if (m[8][i] === null) m[8][i] = false;
        if (m[i][8] === null) m[i][8] = false;
    }
    for (let i = 0; i < 8; i++) {
        if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
        if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
    }
    m[size - 8][8] = true; // dark module

    // Version info areas (v ≥ 7)
    if (version >= 7) {
        const vb = versionBits(version);
        for (let i = 0; i < 18; i++) {
            const bit = ((vb >> i) & 1) === 1;
            m[Math.floor(i / 3)][(i % 3) + size - 11] = bit;
            m[(i % 3) + size - 11][Math.floor(i / 3)] = bit;
        }
    }

    // Snapshot of function modules (data placement + masking must not touch them)
    const isFn = m.map((row) => row.map((v) => v !== null));

    // ---- data placement (zigzag) — try all 8 masks, keep the lowest penalty ----------------------
    let best = null;
    let bestScore = Infinity;
    let bestMask = 0;
    for (let mask = 0; mask < 8; mask++) {
        const g = m.map((row) => row.slice());
        let inc = -1;
        let row = size - 1;
        let bitIndex = 7;
        let byteIndex = 0;
        for (let col = size - 1; col > 0; col -= 2) {
            if (col === 6) col--;
            for (;;) {
                for (let c = 0; c < 2; c++) {
                    if (g[row][col - c] !== null) continue;
                    let dark = false;
                    if (byteIndex < inter.length) dark = ((inter[byteIndex] >>> bitIndex) & 1) === 1;
                    if (MASKS[mask](row, col - c)) dark = !dark;
                    g[row][col - c] = dark;
                    bitIndex--;
                    if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
                }
                row += inc;
                if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
            }
        }
        // Format info for this mask
        const fb = formatBits(mask);
        for (let i = 0; i < 15; i++) {
            const bit = ((fb >> i) & 1) === 1;
            // copy 1 (around top-left finder)
            if (i < 6) g[i][8] = bit;
            else if (i < 8) g[i + 1][8] = bit;
            else g[size - 15 + i][8] = bit;
            // copy 2
            if (i < 8) g[8][size - 1 - i] = bit;
            else if (i < 9) g[8][15 - i - 1 + 1] = bit;
            else g[8][15 - i - 1] = bit;
        }
        g[size - 8][8] = true;
        const score = penalty(g);
        if (score < bestScore) { bestScore = score; best = g; bestMask = mask; }
    }
    void bestMask;
    void isFn;
    return best;
}

/** Crisp SVG for a QR matrix (4-module quiet zone, black on white). */
export function qrSvg(text, pixelSize) {
    const m = qrModules(text);
    if (!m) return "";
    const n = m.length;
    const quiet = 4;
    const total = n + quiet * 2;
    const px = pixelSize || 4;
    let path = "";
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (m[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
        }
    }
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * px}" height="${total * px}" shape-rendering="crispEdges">` +
        `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
        `<path d="${path}" fill="#000000"/>` +
        `</svg>`
    );
}
