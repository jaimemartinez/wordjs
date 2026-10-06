/**
 * Code 128 reader for camera frames — no dependency, pure functions (also loaded by Node tests).
 *
 * Phones without `BarcodeDetector` (iPhone Safari, Firefox) still need to read the registration-code
 * barcodes printed by `./barcode`. This module decodes them from grayscale/RGBA pixels:
 *
 * - `decodeCode128Row()` reads one scanline: local (min/max envelope) threshold with hysteresis and
 *   sub-pixel edges, run-length encoding, start-pattern search, then every 11-module symbol is
 *   matched by its edge-to-similar-edge distances (bar+space pairs), which are immune to the uniform
 *   ink spread / blur that makes bars look wider than spaces. Checksum, stop pattern and quiet zones
 *   are verified; each line is read in both directions, plain and then sharpened (out of focus).
 * - `decodeCode128Image()` samples rows, columns (90°/180°/270° codes) and slanted lines (codes held
 *   at an angle) and only returns a value that at least two scanlines decoded identically.
 * - `createScanConsensus()` lets the UI additionally require consecutive frames to agree.
 *
 * The symbol table is derived from the encoder's own `PATTERNS`/`STOP`, so both sides never drift.
 * No DOM is touched at module level; `scanVideoFrame()` is the only browser-only helper.
 */

import { PATTERNS, STOP } from './barcode';

/** Alphabet of the registration codes (no I, O, 0, 1). */
export const REG_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REG_CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;

/** True when `s` is a registration code: exactly 10 characters of `REG_CODE_ALPHABET`. */
export function isRegCode(s: string): boolean {
    return typeof s === 'string' && REG_CODE_RE.test(s);
}

export type Code128ScanOptions = {
    /** Only accept reads that are registration codes (default true). */
    regCodeOnly?: boolean;
    /** Minimum light margin before the start and after the stop, in modules (default 2). */
    quietZone?: number;
    /** Minimum local max-min luminance difference to consider a spot "printed" (default 16). */
    minContrast?: number;
    /** Radius in pixels of the local threshold window (default: max(16, line length / 20)). */
    window?: number;
    /**
     * Largest accepted squared distance between a symbol's measured edge-to-similar-edge widths and
     * the nearest pattern, in modules² (default 1.1).
     */
    maxError?: number;
};

export type Code128ImageOptions = Code128ScanOptions & {
    /** Scanlines per direction (default 15), spread over the middle of the image. */
    lines?: number;
    /** Fraction of the image skipped at each border when spreading the scanlines (default 0.1). */
    margin?: number;
    /** Scanlines that must decode the same value before it is returned (default 2). */
    minAgree?: number;
    /** Also scan columns, for codes held vertically (default true). */
    columns?: boolean;
    /** Pixel rows (or columns) averaged into each scanline, to cancel sensor noise (default 3). */
    thickness?: number;
    /**
     * Extra slanted scan directions in degrees, tried after the straight rows/columns found nothing,
     * for codes held at an angle (default [12, -12, 24, -24]: reads up to ~±30°, while a straight
     * line only crosses every bar up to ~±5-8°). Applied to rows and columns; [] disables them and
     * cuts the worst-case cost (a frame without any barcode) by about 5x.
     */
    slants?: number[];
};

export type ScanImage = {
    data: ArrayLike<number>;
    width: number;
    height: number;
    /** 4 = RGBA like canvas ImageData, 1 = grayscale. Inferred from the data length when omitted. */
    channels?: 1 | 4;
};

type Resolved = { regCodeOnly: boolean; quietZone: number; minContrast: number; window: number; maxD: number; minRuns: number };

// ---------------------------------------------------------------------------------------------
// Symbol table (derived from the encoder)
// ---------------------------------------------------------------------------------------------

const START_A = 103;
const START_C = 105;
/** Pseudo-symbol id for the stop's first six elements (11 modules, like a data symbol). */
const STOP_ID = PATTERNS.length;
const N_SYM = PATTERNS.length + 1;
/** Edge-to-similar-edge distances (w1+w2, w2+w3, w3+w4, w4+w5) of each symbol, in modules. */
const T_TAB = new Float32Array(N_SYM * 4);
[...PATTERNS, STOP.slice(0, 6)].forEach((p, id) => {
    const w = Array.from(p, Number);
    for (let k = 0; k < 4; k++) T_TAB[id * 4 + k] = w[k] + w[k + 1];
});
/** Stop's last two elements (space 1 + bar 2), used to verify the stop's seventh element. */
const STOP_TAIL = Number(STOP[5]) + Number(STOP[6]);
const STOP_MODULES = Array.from(STOP, Number).reduce((a, b) => a + b, 0);
/** Shortest symbol sequence: start, one data symbol, checksum, stop (runs). */
const MIN_RUNS = 6 * 3 + 7;
/**
 * Fewest runs a registration code can take (49): our encoder writes it in subset B (start, 10 characters,
 * checksum, stop = 79 runs), but label printers and barcode fonts switch to subset C for digit pairs —
 * START_C + 5 pairs + checksum + stop is the shortest 10-character encoding. Requiring 79 made those
 * badges unreadable here (BarcodeDetector reads them); isRegCode() on the decoded text stays the filter.
 */
const REG_RUNS = 6 * 7 + 7;

/**
 * Nearest symbol to the six runs at `pos`, normalised by their own total width (11 modules), or -1
 * when nothing lies within `maxD`. Comparing edge-to-similar-edge distances instead of raw widths
 * makes the match insensitive to bars bleeding into spaces.
 */
function matchSymbol(r: Float64Array, pos: number, maxD: number): number {
    const r0 = r[pos], r1 = r[pos + 1], r2 = r[pos + 2], r3 = r[pos + 3], r4 = r[pos + 4];
    const p = r0 + r1 + r2 + r3 + r4 + r[pos + 5];
    if (!(p > 0)) return -1;
    const k = 11 / p;
    const t0 = (r0 + r1) * k, t1 = (r1 + r2) * k, t2 = (r2 + r3) * k, t3 = (r3 + r4) * k;
    let best = -1;
    let bestD = maxD;
    for (let id = 0, o = 0; id < N_SYM; id++, o += 4) {
        let e = t0 - T_TAB[o];
        let d = e * e;
        if (d >= bestD) continue;
        e = t1 - T_TAB[o + 1]; d += e * e;
        if (d >= bestD) continue;
        e = t2 - T_TAB[o + 2]; d += e * e;
        if (d >= bestD) continue;
        e = t3 - T_TAB[o + 3]; d += e * e;
        if (d < bestD) { bestD = d; best = id; }
    }
    return best;
}

/** Symbol values (start, data…, checksum) to text, honouring code sets A/B/C, shift and code changes. */
function valuesToText(vals: number[]): string | null {
    let set = vals[0] === START_A ? 0 : vals[0] === START_C ? 2 : 1; // 0 = A, 1 = B, 2 = C
    let shift = false;
    let out = '';
    for (let j = 1; j < vals.length - 1; j++) {
        const v = vals[j];
        const cur = shift ? (set === 0 ? 1 : 0) : set;
        shift = false;
        if (cur === 2) {
            if (v < 100) out += (v < 10 ? '0' : '') + v;
            else if (v === 100) set = 1;
            else if (v === 101) set = 0;
            else if (v !== 102) return null; // 102 = FNC1, carries no text
            continue;
        }
        if (v < 96) {
            out += String.fromCharCode(cur === 1 ? v + 32 : v < 64 ? v + 32 : v - 64);
            continue;
        }
        switch (v) {
            case 96: case 97: case 102: break; // FNC3, FNC2, FNC1
            case 98: shift = true; break;
            case 99: set = 2; break;
            case 100: if (cur === 0) set = 1; break; // code B in A (FNC4 in B)
            case 101: if (cur === 1) set = 0; break; // code A in B (FNC4 in A)
            default: return null;
        }
    }
    return out;
}

/** Decode the symbol sequence whose start symbol (`start`, total width `p`) sits at run `i`. */
function decodeFrom(r: Float64Array, count: number, i: number, start: number, p: number, o: Resolved): string | null {
    const vals = [start];
    let pos = i + 6;
    let prevP = p;
    for (;;) {
        if (pos + 7 > count) return null;
        const id = matchSymbol(r, pos, o.maxD);
        if (id < 0) return null;
        const pk = r[pos] + r[pos + 1] + r[pos + 2] + r[pos + 3] + r[pos + 4] + r[pos + 5];
        // Neighbouring symbols have (almost) the same width; a jump means we left the barcode.
        if (pk > prevP * 1.35 || pk * 1.35 < prevP) return null;
        prevP = pk;
        if (id === STOP_ID) {
            const p7 = pk + r[pos + 6];
            const tail = (r[pos + 5] + r[pos + 6]) * (STOP_MODULES / p7);
            if (tail < STOP_TAIL - 0.75 || tail > STOP_TAIL + 0.75) return null;
            const after = pos + 7;
            if (after >= count) return null; // stop bar runs into the border: no quiet zone at all
            const m7 = p7 / STOP_MODULES;
            const q = r[after];
            if (q < o.quietZone * m7 && !(after === count - 1 && q >= m7)) return null;
            break;
        }
        if (id >= START_A) return null; // a start symbol inside the data
        vals.push(id);
        pos += 6;
        if (vals.length > 64) return null;
    }
    if (vals.length < 3) return null;
    let sum = vals[0];
    for (let j = 1; j < vals.length - 1; j++) sum += vals[j] * j;
    if (sum % 103 !== vals[vals.length - 1]) return null;
    const text = valuesToText(vals);
    if (text === null || !text.length) return null;
    if (o.regCodeOnly && !isRegCode(text)) return null;
    return text;
}

/** Look for a start symbol (with its quiet zone) anywhere in the runs and decode from there. */
function decodeRuns(r: Float64Array, count: number, firstDark: boolean, o: Resolved): string | null {
    // Dark runs sit at even indices when the line starts dark, odd otherwise; a start needs a light
    // run (its quiet zone) before it, so the first candidate is index 1 or 2.
    for (let i = firstDark ? 2 : 1; i + o.minRuns <= count; i += 2) {
        const p = r[i] + r[i + 1] + r[i + 2] + r[i + 3] + r[i + 4] + r[i + 5];
        const m = p / 11;
        // Every start symbol begins bar 2, space 1, bar 1: cheap pre-check before the full match.
        const a = (r[i] + r[i + 1]) / m;
        if (a < 2.3 || a > 3.7) continue;
        const b = (r[i + 1] + r[i + 2]) / m;
        if (b < 1.3 || b > 2.7) continue;
        const q = r[i - 1];
        if (q < o.quietZone * m && !(i === 1 && q >= m)) continue;
        const start = matchSymbol(r, i, o.maxD);
        if (start < START_A || start > START_C) continue;
        const text = decodeFrom(r, count, i, start, p, o);
        if (text !== null) return text;
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
// Scanline binarisation
// ---------------------------------------------------------------------------------------------

type Work = {
    size: number;
    line: Float32Array;
    smooth: Float32Array;
    sharp: Float32Array;
    mx: Float32Array;
    mn: Float32Array;
    gMax: Float32Array;
    hMax: Float32Array;
    gMin: Float32Array;
    hMin: Float32Array;
    edges: Float64Array;
    runs: Float64Array;
    rev: Float64Array;
};
let work: Work | null = null;

/** Scratch buffers shared by all calls (the decoder is synchronous and single-threaded). */
function getWork(n: number): Work {
    if (!work || work.size < n) {
        const size = Math.max(n, 64);
        work = {
            size,
            line: new Float32Array(size),
            smooth: new Float32Array(size),
            sharp: new Float32Array(size),
            mx: new Float32Array(size),
            mn: new Float32Array(size),
            gMax: new Float32Array(size),
            hMax: new Float32Array(size),
            gMin: new Float32Array(size),
            hMin: new Float32Array(size),
            edges: new Float64Array(size + 1),
            runs: new Float64Array(size + 2),
            rev: new Float64Array(size + 2),
        };
    }
    return work;
}

/**
 * Sliding maximum and minimum over [i - R, i + R] (van Herk/Gil-Werman: block prefix/suffix extremes,
 * a few operations per pixel whatever R). Near the line start the window may reach up to 2R ahead.
 */
function slidingMinMax(v: Float32Array, n: number, R: number, wk: Work): void {
    const { mx, mn, gMax, hMax, gMin, hMin } = wk;
    const k = 2 * R + 1;
    for (let b = 0; b < n; b += k) {
        const e = Math.min(n, b + k);
        let hi = v[b], lo = v[b];
        for (let x = b; x < e; x++) {
            const t = v[x];
            if (t > hi) hi = t;
            if (t < lo) lo = t;
            gMax[x] = hi;
            gMin[x] = lo;
        }
        hi = v[e - 1];
        lo = hi;
        for (let x = e - 1; x >= b; x--) {
            const t = v[x];
            if (t > hi) hi = t;
            if (t < lo) lo = t;
            hMax[x] = hi;
            hMin[x] = lo;
        }
    }
    for (let i = 0; i < n; i++) {
        const j = i - R < 0 ? 0 : i - R;
        const e = i + R > n - 1 ? n - 1 : i + R;
        const a1 = hMax[j], b1 = gMax[e], a2 = hMin[j], b2 = gMin[e];
        mx[i] = a1 > b1 ? a1 : b1;
        mn[i] = a2 < b2 ? a2 : b2;
    }
}

/**
 * Binarise `v` against the midpoint of its local min/max envelope (`wk.mx`/`wk.mn`, filled by
 * `slidingMinMax`), with hysteresis (a fraction of the local contrast) so noise does not add edges,
 * and record each edge at the sub-pixel position where the signal crossed the threshold. Spots whose
 * local contrast is below `minContrast` count as light (plain background).
 * Returns the number of edges; whether the line starts dark is reported through `out.firstDark`.
 */
function findEdges(v: Float32Array, n: number, o: Resolved, hyst: number, wk: Work, out: { firstDark: boolean }): number {
    const { mx, mn, edges } = wk;
    const minC = o.minContrast;
    let c = mx[0] - mn[0];
    let t = (mx[0] + mn[0]) * 0.5;
    let dark = c >= minC && v[0] < t;
    out.firstDark = dark;
    let prevD = v[0] - t;
    let lastCross = -1;
    let lastEdge = 0;
    let ne = 0;
    for (let i = 1; i < n; i++) {
        c = mx[i] - mn[i];
        t = (mx[i] + mn[i]) * 0.5;
        const d = v[i] - t;
        if ((d < 0) !== (prevD < 0)) lastCross = i - 0.5 + prevD / (prevD - d);
        prevD = d;
        let want: boolean;
        if (c < minC) want = false;
        else if (dark) want = d <= hyst * c;
        else want = d < -hyst * c;
        if (want !== dark) {
            const e = lastCross > lastEdge ? lastCross : i;
            edges[ne++] = e;
            lastEdge = e;
            dark = want;
        }
    }
    return ne;
}

/** Edges to run widths (first and last runs reach the line ends). */
function edgesToRuns(edges: Float64Array, ne: number, n: number, runs: Float64Array): number {
    runs[0] = edges[0];
    for (let k = 1; k < ne; k++) runs[k] = edges[k] - edges[k - 1];
    runs[ne] = n - edges[ne - 1];
    return ne + 1;
}

function resolveOptions(opts: Code128ScanOptions): Resolved {
    const regCodeOnly = opts.regCodeOnly ?? true;
    return {
        regCodeOnly,
        quietZone: opts.quietZone ?? 2,
        minContrast: opts.minContrast ?? 16,
        window: opts.window ?? 0,
        maxD: opts.maxError ?? 1.1,
        minRuns: regCodeOnly ? REG_RUNS : MIN_RUNS,
    };
}

/**
 * One binarisation attempt: optional [1 2 1] smoothing (noise), optional sharpening
 * v + k·(2v - left - right) (blur: restores the contrast of 1-module elements) and the hysteresis as
 * a fraction of the local contrast. Tried in order until one decodes; measured on synthetic frames,
 * the plain pass handles clean/low-contrast lines, the sharpened ones out-of-focus frames.
 */
type Pass = { smooth: boolean; sharpen: number; hyst: number };
const PASSES: ReadonlyArray<Pass> = [
    { smooth: false, sharpen: 0, hyst: 0.06 },
    { smooth: false, sharpen: 1, hyst: 0.06 },
    { smooth: true, sharpen: 1.5, hyst: 0.06 },
];

/** Decode a scanline held in the shared work buffer `wk.line` (length `n`). */
function decodeLine(n: number, o: Resolved, wk: Work, passes: ReadonlyArray<Pass> = PASSES): string | null {
    if (n < 30) return null;
    // Envelope window: wide (default ±n/20 px) so runs of 1-module elements, whose contrast blur
    // flattens, are still compared with the full black and white of wider neighbours.
    const R = o.window > 0 ? o.window : Math.max(16, Math.round(n / 20));
    const flag = { firstDark: false };
    for (const pass of passes) {
        let v = wk.line;
        if (pass.smooth) {
            const s = wk.smooth;
            s[0] = (3 * v[0] + v[1]) / 4;
            for (let i = 1; i < n - 1; i++) s[i] = (v[i - 1] + 2 * v[i] + v[i + 1]) / 4;
            s[n - 1] = (v[n - 2] + 3 * v[n - 1]) / 4;
            v = s;
        }
        if (pass.sharpen > 0) {
            const s = wk.sharp;
            const k = pass.sharpen;
            s[0] = v[0];
            for (let i = 1; i < n - 1; i++) s[i] = v[i] + k * (2 * v[i] - v[i - 1] - v[i + 1]);
            s[n - 1] = v[n - 1];
            v = s;
        }
        // Per-pass envelope: the sharpened signal's own extremes give the better midpoint (measured).
        slidingMinMax(v, n, R, wk);
        const ne = findEdges(v, n, o, pass.hyst, wk, flag);
        // Not enough runs for a symbol. (No early exit for the later passes: under heavy blur the
        // plain pass merges most 1-module elements, and the sharpened passes recover them.)
        if (ne + 1 < o.minRuns) continue;
        const count = edgesToRuns(wk.edges, ne, n, wk.runs);
        const fwd = decodeRuns(wk.runs, count, flag.firstDark, o);
        if (fwd !== null) return fwd;
        // Read the same line right-to-left (upside-down code).
        const rev = wk.rev;
        for (let k = 0; k < count; k++) rev[k] = wk.runs[count - 1 - k];
        const lastDark = ((count - 1) % 2 === 0) === flag.firstDark;
        const back = decodeRuns(rev, count, lastDark, o);
        if (back !== null) return back;
    }
    return null;
}

/**
 * Decode one scanline of luminance values (0-255, dark bars on a light background), reading it in
 * both directions. Returns the text, or null when no valid Code 128 symbol (checksum, stop and quiet
 * zones verified) is found — or, with `regCodeOnly` (default), when the text is not a registration code.
 */
export function decodeCode128Row(lum: ArrayLike<number>, opts: Code128ScanOptions = {}): string | null {
    const n = lum.length;
    const wk = getWork(n);
    for (let i = 0; i < n; i++) wk.line[i] = lum[i];
    return decodeLine(n, resolveOptions(opts), wk);
}

// ---------------------------------------------------------------------------------------------
// Whole images
// ---------------------------------------------------------------------------------------------

/**
 * Sample one scanline into `out` as luminance: a row (or a column when `vertical`) whose cross
 * coordinate is `centre` at the middle of the image and changes by `slope` per pixel along it.
 * `thickness` neighbouring lines are averaged. Returns the number of samples (slanted lines stop
 * where they leave the image).
 */
function sampleLine(img: ScanImage, ch: number, vertical: boolean, centre: number, slope: number, thickness: number, out: Float32Array): number {
    const { data, width: w, height: h } = img;
    const n = vertical ? h : w;
    const across = vertical ? w : h;
    const half = Math.max(0, Math.floor((thickness - 1) / 2));
    const along = (vertical ? w : 1) * ch; // index step along the line
    const cross = (vertical ? 1 : w) * ch; // index step across it
    if (slope === 0) {
        const a0 = Math.max(0, centre - half);
        const a1 = Math.min(across - 1, centre + half);
        out.fill(0, 0, n);
        for (let a = a0; a <= a1; a++) {
            let idx = a * cross;
            if (ch === 4) {
                for (let i = 0; i < n; i++, idx += along) out[i] += (data[idx] * 77 + data[idx + 1] * 150 + data[idx + 2] * 29) / 256;
            } else {
                for (let i = 0; i < n; i++, idx += along) out[i] += data[idx];
            }
        }
        const k = 1 / (a1 - a0 + 1);
        for (let i = 0; i < n; i++) out[i] *= k;
        return n;
    }
    const inv = 1 / (2 * half + 1);
    let m = 0;
    for (let i = 0; i < n; i++) {
        const pos = centre + slope * (i - n / 2);
        if (pos < 0 || pos > across - 1) {
            if (m) break; // left the image after entering it
            continue;
        }
        const base = i * along;
        let acc = 0;
        for (let t = -half; t <= half; t++) {
            // Nearest pixel across the line: that direction runs along the bars, so it barely matters.
            const q = Math.round(pos + t);
            const idx = base + (q < 0 ? 0 : q > across - 1 ? across - 1 : q) * cross;
            acc += ch === 4 ? (data[idx] * 77 + data[idx + 1] * 150 + data[idx + 2] * 29) / 256 : data[idx];
        }
        out[m++] = acc * inv;
    }
    return m;
}

/** 0, 1, …, n-1 reordered from the middle outwards (central lines are tried first). */
function centreOut(n: number): number[] {
    const order: number[] = [];
    const mid = (n - 1) / 2;
    for (let d = 0; order.length < n; d++) {
        const a = Math.floor(mid - d), b = Math.ceil(mid + d);
        if (a >= 0 && !order.includes(a)) order.push(a);
        if (b < n && !order.includes(b)) order.push(b);
    }
    return order;
}

/**
 * Decode a Code 128 barcode anywhere in an image (RGBA or grayscale). Rows are scanned from the centre
 * outwards, then columns (codes held vertically), then rows and columns slanted by `slants` degrees
 * (codes held at an angle); each line is read both ways (upside-down codes). When a line decodes,
 * nearby parallel lines are read to confirm it: the value is only returned once `minAgree`
 * (default 2) lines decoded it identically, otherwise null.
 */
export function decodeCode128Image(img: ScanImage, opts: Code128ImageOptions = {}): string | null {
    const { width: w, height: h } = img;
    if (!(w > 0 && h > 0) || !img.data) return null;
    const ch = img.channels ?? (img.data.length >= w * h * 4 ? 4 : 1);
    const o = resolveOptions(opts);
    const lines = Math.max(1, Math.min(64, Math.round(opts.lines ?? 15)));
    const margin = Math.max(0, Math.min(0.45, opts.margin ?? 0.1));
    const need = Math.max(1, Math.round(opts.minAgree ?? 2));
    const thickness = Math.max(1, Math.round(opts.thickness ?? 3));
    const columns = opts.columns !== false;
    const wk = getWork(Math.max(w, h));
    const votes = new Map<string, number>();

    const pass = (vertical: boolean, slope: number, count: number): string | null => {
        const extent = vertical ? w : h;
        const lo = extent * margin;
        const step = (extent * (1 - 2 * margin)) / count;
        const scanned = new Set<number>();
        const read = (at: number): string | null => {
            if (at < 0 || at >= extent || scanned.has(at)) return null;
            scanned.add(at);
            const n = sampleLine(img, ch, vertical, at, slope, thickness, wk.line);
            const r = decodeLine(n, o, wk);
            if (r === null) return null;
            const c = (votes.get(r) ?? 0) + 1;
            votes.set(r, c);
            return c >= need ? r : '';
        };
        const near = Math.max(2, Math.round(step / 4));
        for (const k of centreOut(count)) {
            const at = Math.min(extent - 1, Math.floor(lo + step * (k + 0.5)));
            const r = read(at);
            if (r) return r;
            if (r === '') {
                // A hit: confirm it on neighbouring lines before moving on.
                for (const off of [near, -near, 2 * near, -2 * near]) {
                    const r2 = read(at + off);
                    if (r2) return r2;
                }
            }
        }
        return null;
    };

    const found = pass(false, 0, lines) ?? (columns ? pass(true, 0, lines) : null);
    if (found) return found;
    for (const deg of opts.slants ?? [12, -12, 24, -24]) {
        if (!deg || Math.abs(deg) >= 45) continue;
        const slope = Math.tan((deg * Math.PI) / 180);
        const r = pass(false, slope, lines) ?? (columns ? pass(true, slope, lines) : null);
        if (r) return r;
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
// Frame-to-frame consensus and the browser helper
// ---------------------------------------------------------------------------------------------

export type ScanConsensus = {
    /**
     * Feed one frame's result (null = nothing read). Returns the value once, on the frame where it
     * has been read `frames` times in a row; repeats of the same value stay silent until a different
     * value is read, the code is missing for more than `maxGap` frames, or `reset()` is called.
     */
    push(value: string | null): string | null;
    reset(): void;
};

/**
 * Require `frames` consecutive agreeing reads before accepting a value. Up to `maxGap` empty frames
 * (motion blur, focus hunting) may sit between agreeing reads; a different value restarts the count.
 */
export function createScanConsensus(frames = 2, maxGap = 3): ScanConsensus {
    let last: string | null = null;
    let streak = 0;
    let gap = 0;
    let fired = false;
    const reset = () => { last = null; streak = 0; gap = 0; fired = false; };
    return {
        push(value: string | null): string | null {
            if (value === null || value === undefined || value === '') {
                if (last !== null && ++gap > maxGap) reset();
                return null;
            }
            gap = 0;
            if (value === last) streak++;
            else { last = value; streak = 1; fired = false; }
            if (!fired && streak >= Math.max(1, frames)) { fired = true; return value; }
            return null;
        },
        reset,
    };
}

/**
 * Browser only: draw the current video frame onto `canvas`, downscaled so its longer side is at most
 * `maxSide` px (default 960), and decode it. Returns null when the video has no frame yet, outside
 * a browser, or when nothing is read.
 */
export function scanVideoFrame(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    opts: Code128ImageOptions & { maxSide?: number } = {},
): string | null {
    if (typeof document === 'undefined' || !video || !canvas) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return null;
    const scale = Math.min(1, (opts.maxSide ?? 960) / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    return decodeCode128Image({ data: frame.data, width: w, height: h, channels: 4 }, opts);
}
