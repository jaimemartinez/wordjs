/**
 * Barcode reader for camera frames — no dependency, pure functions (also loaded by Node tests).
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
 * 2.15.1: the scanner shows WHATEVER it reads — a product box held under the camera must say «Código
 * leído: …» instead of nothing. `decodeBarcodeRow()` / `decodeBarcodeImage()` read, on the same
 * binarised scanlines, Code 128 plus the retail symbologies EAN-13, EAN-8, UPC-A (an EAN-13 whose first
 * digit is 0), UPC-E (number system 0) and Code 39, and return the text WITH its symbology. EAN/UPC digits are matched
 * like the Code 128 symbols (edge-to-similar-edge distances, ink spread measured on the guard bars to
 * tell 1/7 and 2/8 apart) and verified by guard patterns, quiet zones and the check digit; Code 39 by its
 * three-wide-of-nine patterns, the `*` start/stop and the quiet zones. `decodeVideoRegion()` decodes the
 * part of a video frame under the aiming frame at full resolution (`aimCrop()` maps it).
 *
 * The symbol table is derived from the encoder's own `PATTERNS`/`STOP`, so both sides never drift.
 * No DOM is touched at module level; `scanVideoFrame()` and `decodeVideoRegion()` take the browser
 * objects they draw with as arguments.
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

/** Symbologies the built-in reader decodes (BarcodeDetector's names). */
export type BarcodeFormat = 'code_128' | 'ean_13' | 'ean_8' | 'upc_a' | 'upc_e' | 'code_39';
/** Every symbology `decodeBarcodeRow()` / `decodeBarcodeImage()` read by default. */
export const BUILTIN_FORMATS: readonly BarcodeFormat[] = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39'];
/** A decoded barcode: its text and its symbology. */
export type BarcodeRead = { text: string; format: BarcodeFormat };

export type BarcodeScanOptions = Omit<Code128ScanOptions, 'regCodeOnly'> & {
    /** Only accept reads that are registration codes (default FALSE here: show whatever is read). */
    regCodeOnly?: boolean;
    /** Symbologies to read (default `BUILTIN_FORMATS`). */
    formats?: readonly BarcodeFormat[];
};
export type BarcodeImageOptions = Omit<Code128ImageOptions, 'regCodeOnly'> & BarcodeScanOptions;

type Resolved = {
    regCodeOnly: boolean; quietZone: number; minContrast: number; window: number; maxD: number;
    /** Fewest runs a line needs for ANY enabled symbology (early exit before decoding). */
    minRuns: number;
    /** Fewest runs from a Code 128 start candidate to the line end. */
    c128Runs: number;
    c128: boolean; ean13: boolean; upcA: boolean; ean8: boolean; upcE: boolean; c39: boolean;
};

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
function decodeCode128Runs(r: Float64Array, count: number, firstDark: boolean, o: Resolved): string | null {
    // Dark runs sit at even indices when the line starts dark, odd otherwise; a start needs a light
    // run (its quiet zone) before it, so the first candidate is index 1 or 2.
    for (let i = firstDark ? 2 : 1; i + o.c128Runs <= count; i += 2) {
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
// EAN-13 / UPC-A, EAN-8 and UPC-E
// ---------------------------------------------------------------------------------------------

/**
 * Widths of the odd-parity ("L") digits 0-9, space first, 7 modules each. The even-parity ("G") digit is
 * the same widths reversed; the right-hand ("R") digit the same widths starting with a bar.
 */
const EAN_L = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'];
/** A digit as the reader sees it: its two edge-to-similar-edge distances and its dark modules. */
type DigitPattern = { digit: number; even: boolean; e1: number; e2: number; dark: number };
const LEFT_DIGITS: DigitPattern[] = [];
const RIGHT_DIGITS: DigitPattern[] = [];
EAN_L.forEach((s, digit) => {
    const w = Array.from(s, Number);
    const g = [...w].reverse();
    LEFT_DIGITS.push({ digit, even: false, e1: w[0] + w[1], e2: w[1] + w[2], dark: w[1] + w[3] });
    LEFT_DIGITS.push({ digit, even: true, e1: g[0] + g[1], e2: g[1] + g[2], dark: g[1] + g[3] });
    RIGHT_DIGITS.push({ digit, even: false, e1: w[0] + w[1], e2: w[1] + w[2], dark: w[0] + w[2] });
});
/** EAN-13: the parity (L = odd, G = even) of the six left digits encodes the first digit. */
const EAN13_FIRST = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
/** UPC-E, number system 0: the parity of the six digits encodes the check digit (system 1 is not read: see readUpcE). */
const UPCE_NS0 = ['GGGLLL', 'GGLGLL', 'GGLLGL', 'GGLLLG', 'GLGGLL', 'GLLGGL', 'GLLLGG', 'GLGLGL', 'GLGLLG', 'GLLGLG'];
/** Light modules required before and after an EAN/UPC symbol (the specification asks for 7-11). */
const EAN_QUIET = 4;
/** Largest squared distance (modules²) between a digit's measured and nominal edge distances. */
const DIGIT_MAX_D = 0.7;
/** Runs of each symbol, guards included (quiet zones not). */
const EAN13_RUNS = 3 + 24 + 5 + 24 + 3;
const EAN8_RUNS = 3 + 16 + 5 + 16 + 3;
const UPCE_RUNS = 3 + 24 + 6;

/**
 * Ink spread in modules (bars measured wider than nominal by it, spaces narrower), from a guard of
 * one-module elements starting at `pos` (`n` runs, `firstBar` when it starts with a bar).
 */
function guardSpread(r: Float64Array, pos: number, n: number, firstBar: boolean, m: number): number {
    let bars = 0, nb = 0, spaces = 0, ns = 0;
    for (let k = 0; k < n; k++) {
        if ((k % 2 === 0) === firstBar) { bars += r[pos + k]; nb++; } else { spaces += r[pos + k]; ns++; }
    }
    if (!nb || !ns) return 0;
    const s = (bars / nb - spaces / ns) / (2 * m);
    return s < -0.6 ? -0.6 : s > 0.6 ? 0.6 : s;
}

/** A guard of `n` one-module elements at `pos`: every element and every bar+space pair near nominal. */
function guardOk(r: Float64Array, pos: number, n: number, m: number): boolean {
    for (let k = 0; k < n; k++) {
        const x = r[pos + k] / m;
        if (x < 0.3 || x > 1.9) return false;
        if (k > 0) {
            const pair = (r[pos + k - 1] + r[pos + k]) / m;
            if (pair < 1.35 || pair > 2.65) return false;
        }
    }
    return true;
}

/**
 * The digit whose four runs start at `pos`, or null. `table` is LEFT_DIGITS (runs start with a space)
 * or RIGHT_DIGITS (start with a bar). The two edge-to-similar-edge distances pick the pattern; the pairs
 * that share them (1/7, 2/8) are told apart by their dark modules, corrected by the measured ink spread.
 */
function matchDigit(r: Float64Array, pos: number, table: DigitPattern[], m: number, spread: number): DigitPattern | null {
    const a = r[pos], b = r[pos + 1], c = r[pos + 2], d = r[pos + 3];
    const p = a + b + c + d;
    // A digit is 7 modules; allow the perspective of a code held at an angle.
    if (!(p > 0) || p < 5.2 * m || p > 8.8 * m) return null;
    const k = 7 / p;
    const t1 = (a + b) * k, t2 = (b + c) * k;
    let best: DigitPattern | null = null;
    let bestD = DIGIT_MAX_D;
    for (const pt of table) {
        const e = t1 - pt.e1, f = t2 - pt.e2;
        const dist = e * e + f * f;
        if (dist < bestD) { bestD = dist; best = pt; }
    }
    if (!best) return null;
    const dark = (table === RIGHT_DIGITS ? a + c : b + d) * k - 2 * spread;
    let pick = best;
    for (const pt of table) {
        if (pt !== best && pt.e1 === best.e1 && pt.e2 === best.e2 && pt.even === best.even
            && Math.abs(dark - pt.dark) < Math.abs(dark - pick.dark)) pick = pt;
    }
    return pick;
}

/** GS1 check digit: weights 3 and 1 alternating from the digit next to the check digit. */
function checkDigitOk(d: number[]): boolean {
    const n = d.length;
    let sum = 0;
    for (let i = 0; i < n - 1; i++) sum += d[i] * ((n - 2 - i) % 2 === 0 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === d[n - 1];
}

/** The light run `at` is a quiet zone: wide enough, or (cut by the image border) at least 2.5 modules. */
function quietAt(r: Float64Array, count: number, at: number, m: number, modules: number): boolean {
    if (at < 0 || at >= count) return false;
    const q = r[at];
    return q >= modules * m || ((at === 0 || at === count - 1) && q >= 2.5 * m);
}

/** Module width of the `runs` runs at `i` spanning `modules` modules. */
function moduleOf(r: Float64Array, i: number, runs: number, modules: number): number {
    let w = 0;
    for (let k = 0; k < runs; k++) w += r[i + k];
    return w / modules;
}

/** Read `n` digits from `pos` (4 runs each) into `out`/`parity`; false when one does not match. */
function readDigits(r: Float64Array, pos: number, n: number, table: DigitPattern[], m: number, spread: number, out: number[], parity: string[]): boolean {
    for (let j = 0; j < n; j++) {
        const pt = matchDigit(r, pos + 4 * j, table, m, spread);
        if (!pt) return false;
        out.push(pt.digit);
        parity.push(pt.even ? 'G' : 'L');
    }
    return true;
}

/** EAN-13 (or UPC-A, its first digit 0) whose start guard is the dark run `i`. */
function readEan13(r: Float64Array, count: number, i: number, o: Resolved): BarcodeRead | null {
    if (i + EAN13_RUNS >= count) return null;
    const m = moduleOf(r, i, EAN13_RUNS, 95);
    if (!quietAt(r, count, i - 1, m, EAN_QUIET) || !quietAt(r, count, i + EAN13_RUNS, m, EAN_QUIET)) return null;
    if (!guardOk(r, i, 3, m) || !guardOk(r, i + 27, 5, m) || !guardOk(r, i + 56, 3, m)) return null;
    const digits: number[] = [];
    const parity: string[] = [];
    if (!readDigits(r, i + 3, 6, LEFT_DIGITS, m, guardSpread(r, i, 3, true, m), digits, parity)) return null;
    if (!readDigits(r, i + 32, 6, RIGHT_DIGITS, m, guardSpread(r, i + 27, 5, false, m), digits, parity)) return null;
    const first = EAN13_FIRST.indexOf(parity.slice(0, 6).join(''));
    if (first < 0) return null;
    const all = [first, ...digits];
    if (!checkDigitOk(all)) return null;
    if (first === 0) return o.upcA ? { text: all.slice(1).join(''), format: 'upc_a' } : null;
    return o.ean13 ? { text: all.join(''), format: 'ean_13' } : null;
}

/** EAN-8 whose start guard is the dark run `i`. */
function readEan8(r: Float64Array, count: number, i: number): BarcodeRead | null {
    if (i + EAN8_RUNS >= count) return null;
    const m = moduleOf(r, i, EAN8_RUNS, 67);
    if (!quietAt(r, count, i - 1, m, EAN_QUIET) || !quietAt(r, count, i + EAN8_RUNS, m, EAN_QUIET)) return null;
    if (!guardOk(r, i, 3, m) || !guardOk(r, i + 19, 5, m) || !guardOk(r, i + 40, 3, m)) return null;
    const digits: number[] = [];
    const parity: string[] = [];
    if (!readDigits(r, i + 3, 4, LEFT_DIGITS, m, guardSpread(r, i, 3, true, m), digits, parity)) return null;
    if (parity.includes('G')) return null; // EAN-8 has no even-parity digits
    if (!readDigits(r, i + 24, 4, RIGHT_DIGITS, m, guardSpread(r, i + 19, 5, false, m), digits, parity)) return null;
    if (!checkDigitOk(digits)) return null;
    return { text: digits.join(''), format: 'ean_8' };
}

/** UPC-E digits (number system, six digits, check) as the UPC-A they abbreviate (11 digits + check). */
function upcEToUpcA(ns: number, d: number[], check: number): number[] {
    const last = d[5];
    const body = last <= 2 ? [d[0], d[1], last, 0, 0, 0, 0, d[2], d[3], d[4]]
        : last === 3 ? [d[0], d[1], d[2], 0, 0, 0, 0, 0, d[3], d[4]]
            : last === 4 ? [d[0], d[1], d[2], d[3], 0, 0, 0, 0, 0, d[4]]
                : [d[0], d[1], d[2], d[3], d[4], 0, 0, 0, 0, last];
    return [ns, ...body, check];
}

/**
 * UPC-E whose start guard is the dark run `i` (the 8-digit text BarcodeDetector reports). Number system 0
 * ONLY. A number-system-1 UPC-E is, bar for bar, the LEFT HALF of an EAN-13 whose first digit is its
 * check digit (its parities are the EAN-13 first-digit table: they start with L, number system 0's start
 * with G), and the EAN-13 centre guard plus the first bar of the right half is its end guard. An EAN-13
 * whose right half is lost — cut by the aiming band, washed out by glare — then read as a WRONG UPC-E
 * whenever the 1-in-10 check happened to pass (3043959823297 → 10439593). On the screen that shows
 * whatever was read, a wrong number is worse than none; number system 1 is practically unused.
 */
function readUpcE(r: Float64Array, count: number, i: number): BarcodeRead | null {
    if (i + UPCE_RUNS >= count) return null;
    const m = moduleOf(r, i, UPCE_RUNS, 51);
    if (!quietAt(r, count, i - 1, m, EAN_QUIET) || !quietAt(r, count, i + UPCE_RUNS, m, EAN_QUIET)) return null;
    if (!guardOk(r, i, 3, m) || !guardOk(r, i + 27, 6, m)) return null;
    const digits: number[] = [];
    const parity: string[] = [];
    if (!readDigits(r, i + 3, 6, LEFT_DIGITS, m, guardSpread(r, i, 3, true, m), digits, parity)) return null;
    const check = UPCE_NS0.indexOf(parity.join(''));
    if (check < 0) return null;
    if (!checkDigitOk(upcEToUpcA(0, digits, check))) return null;
    return { text: `0${digits.join('')}${check}`, format: 'upc_e' };
}

/** Any enabled EAN/UPC symbol starting at a dark run preceded by a quiet zone. */
function decodeUpcEanRuns(r: Float64Array, count: number, firstDark: boolean, o: Resolved): BarcodeRead | null {
    for (let i = firstDark ? 2 : 1; i + UPCE_RUNS < count; i += 2) {
        // Cheap pre-check: a start guard is bar-space-bar of one module each.
        const g = (r[i] + r[i + 1] + r[i + 2]) / 3;
        if (r[i] < 0.35 * g || r[i] > 1.65 * g || r[i + 1] < 0.35 * g || r[i + 1] > 1.65 * g || r[i + 2] < 0.35 * g || r[i + 2] > 1.65 * g) continue;
        if (r[i - 1] < 2.5 * g) continue;
        const found = ((o.ean13 || o.upcA) ? readEan13(r, count, i, o) : null)
            ?? (o.ean8 ? readEan8(r, count, i) : null)
            ?? (o.upcE ? readUpcE(r, count, i) : null);
        if (found) return found;
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
// Code 39
// ---------------------------------------------------------------------------------------------

/** Code 39 characters and their nine-element patterns (bar first; bit set = wide element). */
const C39_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
const C39_CODES = [
    0x034, 0x121, 0x061, 0x160, 0x031, 0x130, 0x070, 0x025, 0x124, 0x064,
    0x109, 0x049, 0x148, 0x019, 0x118, 0x058, 0x00d, 0x10c, 0x04c, 0x01c,
    0x103, 0x043, 0x142, 0x013, 0x112, 0x052, 0x007, 0x106, 0x046, 0x016,
    0x181, 0x0c1, 0x1c0, 0x091, 0x190, 0x0d0, 0x085, 0x184, 0x0c4, 0x0a8,
    0x0a2, 0x08a, 0x02a,
];
const C39_STAR = 0x094;
const C39_CHAR = new Map<number, string>(C39_CODES.map((c, i) => [c, C39_ALPHABET[i]]));
C39_CHAR.set(C39_STAR, '*');
/** Start + stop with their gap: the shortest line a Code 39 symbol can be read on. */
const C39_MIN_RUNS = 9 + 1 + 9;

/**
 * The Code 39 character whose nine runs start at `pos`: exactly three are wide, clearly wider than the
 * six narrow ones. Returns the character, the runs' total width and the narrow element's width.
 */
function c39At(r: Float64Array, pos: number): { ch: string; width: number; narrow: number } | null {
    const w: number[] = [];
    let total = 0;
    for (let k = 0; k < 9; k++) { w.push(r[pos + k]); total += r[pos + k]; }
    const sorted = [...w].sort((a, b) => b - a);
    const wideMin = sorted[2], narrowMax = sorted[3];
    if (!(narrowMax > 0) || wideMin < narrowMax * 1.3) return null;
    const cut = (wideMin + narrowMax) / 2;
    let code = 0;
    let narrow = 0;
    for (let k = 0; k < 9; k++) {
        const wide = w[k] > cut;
        code = (code << 1) | (wide ? 1 : 0);
        if (!wide) narrow += w[k];
    }
    const ch = C39_CHAR.get(code);
    return ch === undefined ? null : { ch, width: total, narrow: narrow / 6 };
}

/** The Code 39 symbol (`*` … `*`) whose start character begins at the dark run `i`. */
function readCode39At(r: Float64Array, count: number, i: number): string | null {
    const start = c39At(r, i);
    if (!start || start.ch !== '*') return null;
    const x = start.narrow;
    if (!quietAt(r, count, i - 1, x, 5)) return null;
    let text = '';
    let pos = i + 9;
    for (;;) {
        if (pos + 10 > count) return null;
        const gap = r[pos];
        if (gap > 3.5 * x) return null; // a wide light run: the symbol ended without its stop
        const c = c39At(r, pos + 1);
        if (!c) return null;
        if (c.width > start.width * 1.35 || c.width * 1.35 < start.width) return null;
        if (c.ch === '*') {
            if (!text.length || !quietAt(r, count, pos + 10, x, 5)) return null;
            return text;
        }
        text += c.ch;
        if (text.length > 48) return null;
        pos += 10;
    }
}

function decodeCode39Runs(r: Float64Array, count: number, firstDark: boolean): string | null {
    for (let i = firstDark ? 2 : 1; i + C39_MIN_RUNS < count; i += 2) {
        const text = readCode39At(r, count, i);
        if (text !== null) return text;
    }
    return null;
}

/** Every enabled symbology on one run-length encoded line (read in the given direction only). */
function decodeAllRuns(r: Float64Array, count: number, firstDark: boolean, o: Resolved): BarcodeRead | null {
    if (o.c128) {
        const text = decodeCode128Runs(r, count, firstDark, o);
        if (text !== null) return { text, format: 'code_128' };
    }
    if (!o.regCodeOnly && (o.ean13 || o.upcA || o.ean8 || o.upcE)) {
        // EAN/UPC carry 8, 12 or 13 digits: never a registration code, so skipped under regCodeOnly.
        const found = decodeUpcEanRuns(r, count, firstDark, o);
        if (found) return found;
    }
    if (o.c39) {
        const text = decodeCode39Runs(r, count, firstDark);
        if (text !== null && (!o.regCodeOnly || isRegCode(text))) return { text, format: 'code_39' };
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

/**
 * `defaultRegCodeOnly`: the Code 128 entry points keep their historical default (true); the
 * multi-symbology ones default to false — their caller wants to see whatever is read.
 */
function resolveOptions(opts: BarcodeScanOptions, defaultRegCodeOnly: boolean, defaultFormats: readonly BarcodeFormat[]): Resolved {
    const regCodeOnly = opts.regCodeOnly ?? defaultRegCodeOnly;
    const f = new Set(opts.formats ?? defaultFormats);
    const o: Resolved = {
        regCodeOnly,
        quietZone: opts.quietZone ?? 2,
        minContrast: opts.minContrast ?? 16,
        window: opts.window ?? 0,
        maxD: opts.maxError ?? 1.1,
        minRuns: 0,
        c128Runs: regCodeOnly ? REG_RUNS : MIN_RUNS,
        c128: f.has('code_128'),
        ean13: f.has('ean_13'),
        upcA: f.has('upc_a'),
        ean8: f.has('ean_8'),
        upcE: f.has('upc_e'),
        c39: f.has('code_39'),
    };
    // A symbol plus the light runs on both sides of it.
    const needs: number[] = [];
    if (o.c128) needs.push(o.c128Runs);
    if (!regCodeOnly && (o.ean13 || o.upcA)) needs.push(EAN13_RUNS + 2);
    if (!regCodeOnly && o.ean8) needs.push(EAN8_RUNS + 2);
    if (!regCodeOnly && o.upcE) needs.push(UPCE_RUNS + 2);
    if (o.c39) needs.push(C39_MIN_RUNS + 2);
    o.minRuns = needs.length ? Math.min(...needs) : Number.MAX_SAFE_INTEGER;
    return o;
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
function decodeLine(n: number, o: Resolved, wk: Work, passes: ReadonlyArray<Pass> = PASSES): BarcodeRead | null {
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
        const fwd = decodeAllRuns(wk.runs, count, flag.firstDark, o);
        if (fwd !== null) return fwd;
        // Read the same line right-to-left (upside-down code).
        const rev = wk.rev;
        for (let k = 0; k < count; k++) rev[k] = wk.runs[count - 1 - k];
        const lastDark = ((count - 1) % 2 === 0) === flag.firstDark;
        const back = decodeAllRuns(rev, count, lastDark, o);
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
    return decodeBarcodeRow(lum, { ...opts, regCodeOnly: opts.regCodeOnly ?? true, formats: ['code_128'] })?.text ?? null;
}

/**
 * Decode one scanline in any of `opts.formats` (default: every built-in symbology), both directions.
 * Returns the text and its symbology, or null. `regCodeOnly` defaults to FALSE here.
 */
export function decodeBarcodeRow(lum: ArrayLike<number>, opts: BarcodeScanOptions = {}): BarcodeRead | null {
    const n = lum.length;
    const wk = getWork(n);
    for (let i = 0; i < n; i++) wk.line[i] = lum[i];
    return decodeLine(n, resolveOptions(opts, false, BUILTIN_FORMATS), wk);
}

/** Human name of a symbology («EAN-13»), for BarcodeDetector's names too («qr_code» → «QR»). */
export function formatLabel(format: string): string {
    const known: Record<string, string> = {
        code_128: 'Code 128', code_39: 'Code 39', code_93: 'Code 93', codabar: 'Codabar', ean_13: 'EAN-13', ean_8: 'EAN-8',
        upc_a: 'UPC-A', upc_e: 'UPC-E', itf: 'ITF', qr_code: 'QR', data_matrix: 'Data Matrix', pdf417: 'PDF417', aztec: 'Aztec',
    };
    const f = String(format || '').trim();
    return known[f] || f.replace(/_/g, ' ').toUpperCase();
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
    return decodeBarcodeImage(img, { ...opts, regCodeOnly: opts.regCodeOnly ?? true, formats: ['code_128'] })?.text ?? null;
}

/**
 * `decodeCode128Image()` for every symbology in `opts.formats` (default: all built-in ones): the
 * same scan order and the same `minAgree` lines agreeing on text AND symbology. `regCodeOnly` defaults
 * to FALSE: the phone scanner shows whatever it reads and decides afterwards what to post.
 */
export function decodeBarcodeImage(img: ScanImage, opts: BarcodeImageOptions = {}): BarcodeRead | null {
    const { width: w, height: h } = img;
    if (!(w > 0 && h > 0) || !img.data) return null;
    const ch = img.channels ?? (img.data.length >= w * h * 4 ? 4 : 1);
    const o = resolveOptions(opts, false, BUILTIN_FORMATS);
    const lines = Math.max(1, Math.min(64, Math.round(opts.lines ?? 15)));
    const margin = Math.max(0, Math.min(0.45, opts.margin ?? 0.1));
    const need = Math.max(1, Math.round(opts.minAgree ?? 2));
    const thickness = Math.max(1, Math.round(opts.thickness ?? 3));
    const columns = opts.columns !== false;
    const wk = getWork(Math.max(w, h));
    // Votes per symbology AND text: the same digits read as two symbologies are two different reads.
    const votes = new Map<string, number>();
    const reads = new Map<string, BarcodeRead>();

    const pass = (vertical: boolean, slope: number, count: number): string | null => {
        const extent = vertical ? w : h;
        const lo = extent * margin;
        const step = (extent * (1 - 2 * margin)) / count;
        const scanned = new Set<number>();
        const read = (at: number): string | null => {
            if (at < 0 || at >= extent || scanned.has(at)) return null;
            scanned.add(at);
            const n = sampleLine(img, ch, vertical, at, slope, thickness, wk.line);
            const hit = decodeLine(n, o, wk);
            if (hit === null) return null;
            const key = `${hit.format}\n${hit.text}`;
            reads.set(key, hit);
            const c = (votes.get(key) ?? 0) + 1;
            votes.set(key, c);
            return c >= need ? key : '';
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
    if (found) return reads.get(found) ?? null;
    for (const deg of opts.slants ?? [12, -12, 24, -24]) {
        if (!deg || Math.abs(deg) >= 45) continue;
        const slope = Math.tan((deg * Math.PI) / 180);
        const r = pass(false, slope, lines) ?? (columns ? pass(true, slope, lines) : null);
        if (r) return reads.get(r) ?? null;
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

// ---------------------------------------------------------------------------------------------
// The aiming band, at full resolution
// ---------------------------------------------------------------------------------------------

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * The part of a camera frame shown under the on-screen aiming frame, in VIDEO pixels. The video is
 * drawn with `object-fit: cover` into a `view` box (CSS px); `frame` is the aiming frame's box relative
 * to that view. The band is widened by `padX` / `padY` (fractions of the frame's width / height: nobody
 * aims exactly) and clamped to the video. Null when the geometry is unusable (nothing laid out yet):
 * the caller then decodes the whole frame.
 */
export function aimCrop(videoW: number, videoH: number, view: { width: number; height: number }, frame: Rect, padX = 0.1, padY = 0.6): Rect | null {
    if (!(videoW > 0 && videoH > 0 && view.width > 0 && view.height > 0 && frame.width > 0 && frame.height > 0)) return null;
    const s = Math.max(view.width / videoW, view.height / videoH); // cover: the video fills the view
    const offX = (view.width - videoW * s) / 2;
    const offY = (view.height - videoH * s) / 2;
    const x0 = Math.max(0, Math.floor((frame.x - frame.width * padX - offX) / s));
    const x1 = Math.min(videoW, Math.ceil((frame.x + frame.width * (1 + padX) - offX) / s));
    const y0 = Math.max(0, Math.floor((frame.y - frame.height * padY - offY) / s));
    const y1 = Math.min(videoH, Math.ceil((frame.y + frame.height * (1 + padY) - offY) / s));
    if (x1 - x0 < 16 || y1 - y0 < 8) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** What `decodeVideoRegion()` draws from and onto (an HTMLVideoElement and an HTMLCanvasElement). */
export type VideoLike = { videoWidth: number; videoHeight: number };
export type CanvasLike = {
    width: number;
    height: number;
    getContext(type: '2d', opts?: { willReadFrequently?: boolean }): {
        drawImage(src: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
        getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
    } | null;
};

/**
 * Draw `region` of the current video frame (default: the whole frame) onto `canvas` and decode it.
 * The region keeps its full camera resolution up to `maxSide` px (default 1600) on its longer side:
 * downscaling the WHOLE frame first (what 2.15.0 did) thins a product barcode's 1-module bars below a
 * pixel. `regCodeOnly` defaults to false. Returns null when the video has no frame yet or nothing is read.
 */
export function decodeVideoRegion(video: VideoLike, canvas: CanvasLike, region: Rect | null, opts: BarcodeImageOptions & { maxSide?: number } = {}): BarcodeRead | null {
    const vw = video?.videoWidth, vh = video?.videoHeight;
    if (!vw || !vh || !canvas) return null;
    const src = region ?? { x: 0, y: 0, width: vw, height: vh };
    const maxSide = opts.maxSide ?? (region ? 1600 : 1280);
    const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, src.x, src.y, src.width, src.height, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    return decodeBarcodeImage({ data: frame.data, width: w, height: h, channels: 4 }, opts);
}
