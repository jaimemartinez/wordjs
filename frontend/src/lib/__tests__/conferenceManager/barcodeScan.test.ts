/**
 * conference-manager 2.15.1 — the phone scanner's BUILT-IN reader (iPhone Safari has no BarcodeDetector).
 *
 * The user tested the scanner on an iPhone with a product box: nothing at all happened. The built-in
 * reader only knew Code 128 and threw away everything that was not a registration code. What is pinned
 * here, on synthetic camera-like images (bars rendered with sub-pixel ink spread, blur and sensor noise):
 *   - the badge (Code 128 subset B of the registration code, drawn by the plugin's own encoder) still reads;
 *   - EAN-13, EAN-8, UPC-A, UPC-E and Code 39 — what a product box or a shipping label carries — read
 *     WITH their symbology, upside down and held vertically too, and 1/7 and 2/8 (same edge distances)
 *     are told apart with ink spread;
 *   - a wrong check digit, noise and random bars read as nothing;
 *   - the Code 128 entry points keep their old contract (registration codes only by default);
 *   - `aimCrop` maps the on-screen aiming frame to video pixels (object-fit: cover), and
 *     `decodeVideoRegion` decodes that band at FULL resolution instead of downscaling the whole frame.
 *
 * The test encoders below are written from the symbologies' module strings (L/G/R tables, Code 39 bit
 * patterns), not from the reader's width tables, and a few module strings are pinned literally.
 */
import { describe, it, expect } from 'vitest';
import {
    aimCrop,
    BUILTIN_FORMATS,
    decodeBarcodeImage,
    decodeBarcodeRow,
    decodeCode128Image,
    decodeCode128Row,
    decodeVideoRegion,
    formatLabel,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/barcodeScan';
import { code128Widths } from '../../../../../marketplace/plugins/conference-manager/client/lib/barcode';

// ── Test encoders (module strings: '1' = dark module) ───────────────────────────────────────────────

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const flip = (s: string) => s.replace(/[01]/g, (c) => (c === '1' ? '0' : '1'));
const R = L.map(flip);
const G = R.map((s) => [...s].reverse().join(''));
const FIRST = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
const UPCE_NS0 = ['GGGLLL', 'GGLGLL', 'GGLLGL', 'GGLLLG', 'GLGGLL', 'GLLGGL', 'GLLLGG', 'GLGLGL', 'GLGLLG', 'GLLGLG'];

const digitsOf = (s: string) => s.split('').map(Number);
/** GS1 check digit for the given digits (without it). */
const gs1Check = (body: string) => {
    const d = digitsOf(body);
    let sum = 0;
    d.forEach((v, i) => { sum += v * ((d.length - 1 - i) % 2 === 0 ? 3 : 1); });
    return String((10 - (sum % 10)) % 10);
};

function ean13(code: string): string {
    const d = digitsOf(code);
    let s = '101';
    for (let i = 1; i <= 6; i++) s += FIRST[d[0]][i - 1] === 'L' ? L[d[i]] : G[d[i]];
    s += '01010';
    for (let i = 7; i <= 12; i++) s += R[d[i]];
    return s + '101';
}
const upcA = (code: string) => ean13(`0${code}`);
function ean8(code: string): string {
    const d = digitsOf(code);
    return '101' + d.slice(0, 4).map((v) => L[v]).join('') + '01010' + d.slice(4).map((v) => R[v]).join('') + '101';
}
function upcE(code: string): string {
    const d = digitsOf(code);
    const par = d[0] === 0 ? UPCE_NS0[d[7]] : UPCE_NS0[d[7]].replace(/[GL]/g, (c) => (c === 'G' ? 'L' : 'G'));
    return '101' + d.slice(1, 7).map((v, i) => (par[i] === 'L' ? L[v] : G[v])).join('') + '010101';
}
/** Code 39: nine elements per character, bar first, bit set = wide (3 modules), narrow gap between. */
const C39 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
const C39_BITS = [
    0x034, 0x121, 0x061, 0x160, 0x031, 0x130, 0x070, 0x025, 0x124, 0x064, 0x109, 0x049, 0x148, 0x019, 0x118, 0x058,
    0x00d, 0x10c, 0x04c, 0x01c, 0x103, 0x043, 0x142, 0x013, 0x112, 0x052, 0x007, 0x106, 0x046, 0x016, 0x181, 0x0c1,
    0x1c0, 0x091, 0x190, 0x0d0, 0x085, 0x184, 0x0c4, 0x0a8, 0x0a2, 0x08a, 0x02a,
];
function c39Char(ch: string, wide = 3): string {
    const bits = ch === '*' ? 0x094 : C39_BITS[C39.indexOf(ch)];
    let s = '';
    for (let k = 0; k < 9; k++) s += (k % 2 === 0 ? '1' : '0').repeat((bits >> (8 - k)) & 1 ? wide : 1);
    return s;
}
const code39 = (text: string, wide = 3) => [...`*${text}*`].map((c) => c39Char(c, wide)).join('0');
/** Code 128 from the plugin's own encoder (what the badges carry). */
const code128 = (text: string) => code128Widths(text).map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(w)).join('');

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────────

type Render = { module?: number; quiet?: number; height?: number; spread?: number; blur?: number; noise?: number; seed?: number; padTop?: number };

function prng(seed: number) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

/**
 * A grayscale image of the module string: bars dark (20) on light (235), each bar widened by `spread`
 * pixels on BOTH sides (ink spread, anti-aliased), then a horizontal box blur and uniform noise.
 */
function render(bits: string, o: Render = {}) {
    const px = o.module ?? 3, quiet = o.quiet ?? 12, height = o.height ?? 40, spread = o.spread ?? 0;
    const padTop = o.padTop ?? 0;
    const width = Math.round((bits.length + 2 * quiet) * px);
    const bars: [number, number][] = [];
    for (let i = 0; i < bits.length;) {
        if (bits[i] === '1') {
            let j = i;
            while (j < bits.length && bits[j] === '1') j++;
            bars.push([(quiet + i) * px - spread, (quiet + j) * px + spread]);
            i = j;
        } else i++;
    }
    let row = new Float64Array(width);
    for (let x = 0; x < width; x++) {
        let cover = 0;
        for (const [a, b] of bars) cover += Math.max(0, Math.min(x + 1, b) - Math.max(x, a));
        row[x] = 235 - 215 * Math.min(1, cover);
    }
    for (let pass = 0; pass < (o.blur ?? 0); pass++) {
        const next = new Float64Array(width);
        for (let x = 0; x < width; x++) next[x] = (row[Math.max(0, x - 1)] + row[x] + row[Math.min(width - 1, x + 1)]) / 3;
        row = next;
    }
    const rnd = prng(o.seed ?? 7);
    const h = height + 2 * padTop;
    const data = new Uint8ClampedArray(width * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < width; x++) {
            const base = y < padTop || y >= padTop + height ? 235 : row[x];
            data[y * width + x] = base + ((o.noise ?? 0) ? (rnd() - 0.5) * 2 * (o.noise ?? 0) : 0);
        }
    }
    return { data, width, height: h, channels: 1 as const };
}
const mirror = (img: ReturnType<typeof render>) => {
    const out = new Uint8ClampedArray(img.data.length);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) out[y * img.width + x] = img.data[y * img.width + (img.width - 1 - x)];
    return { ...img, data: out };
};
const transpose = (img: ReturnType<typeof render>) => {
    const out = new Uint8ClampedArray(img.data.length);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) out[x * img.height + y] = img.data[y * img.width + x];
    return { data: out, width: img.height, height: img.width, channels: 1 as const };
};
const rowOf = (img: ReturnType<typeof render>, y = Math.floor(img.height / 2)) => Array.from(img.data.subarray(y * img.width, (y + 1) * img.width));

// ── The encoders themselves, pinned against published module strings ───────────────────────────────

describe('test encoders match the published symbologies', () => {
    it('Code 39 characters', () => {
        expect(c39Char('*')).toBe('100010111011101');
        // Published 12-module (2:1) strings, the wide elements written as two modules.
        const two = (ch: string) => c39Char(ch, 2);
        expect(two('*')).toBe('100101101101');
        expect(two('0')).toBe('101001101101');
        expect(two('A')).toBe('110101001011');
        expect(two('Z')).toBe('100110110101');
        expect(two('-')).toBe('100101011011');
    });
    it('EAN digit sets and the EAN-13 layout', () => {
        expect(G[0]).toBe('0100111');
        expect(R[0]).toBe('1110010');
        expect(ean13('4006381333931')).toHaveLength(95);
        expect(ean8('96385074')).toHaveLength(67);
        expect(upcE('04252614')).toHaveLength(51);
        expect(gs1Check('400638133393')).toBe('1');
        expect(gs1Check('03600029145')).toBe('2');
    });
});

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────

describe('the badge: Code 128 registration codes', () => {
    it('reads the plugin\'s own badge, reported as code_128', () => {
        const img = render(code128('ABCD234XYZ'), { module: 2, spread: 0.4, blur: 1, noise: 6 });
        expect(decodeBarcodeImage(img)).toEqual({ text: 'ABCD234XYZ', format: 'code_128' });
        expect(decodeCode128Image(img)).toBe('ABCD234XYZ');
    });
    it('reads any other Code 128 text now (the old default threw it away)', () => {
        const img = render(code128('PEDIDO-2024/77'), { module: 2, blur: 1 });
        expect(decodeBarcodeImage(img)).toEqual({ text: 'PEDIDO-2024/77', format: 'code_128' });
        // The Code 128 entry points keep their contract: registration codes only, unless asked.
        expect(decodeCode128Image(img)).toBeNull();
        expect(decodeCode128Image(img, { regCodeOnly: false })).toBe('PEDIDO-2024/77');
        expect(decodeCode128Row(rowOf(img))).toBeNull();
    });
});

describe('product barcodes: EAN-13, EAN-8, UPC-A, UPC-E', () => {
    it('EAN-13 (a box from Europe / Latin America)', () => {
        for (const code of ['4006381333931', '5901234123457', '7702004003508']) {
            const img = render(ean13(code), { module: 3, spread: 0.5, blur: 1, noise: 8, seed: Number(code.slice(-4)) });
            expect(decodeBarcodeImage(img), code).toEqual({ text: code, format: 'ean_13' });
        }
    });
    it('UPC-A (an EAN-13 whose first digit is 0) is reported as UPC-A with its 12 digits', () => {
        const img = render(upcA('036000291452'), { module: 3, spread: 0.4, blur: 1, noise: 6 });
        expect(decodeBarcodeImage(img)).toEqual({ text: '036000291452', format: 'upc_a' });
    });
    it('EAN-8', () => {
        const img = render(ean8('96385074'), { module: 3, spread: 0.4, blur: 1, noise: 6 });
        expect(decodeBarcodeImage(img)).toEqual({ text: '96385074', format: 'ean_8' });
    });
    it('UPC-E, number system 0', () => {
        for (const code of ['04252614', '01234565']) {
            const img = render(upcE(code), { module: 3, spread: 0.4, blur: 1, noise: 6 });
            expect(decodeBarcodeImage(img), code).toEqual({ text: code, format: 'upc_e' });
        }
    });
    it('an EAN-13 whose right half is lost is NOT read as a (wrong) UPC-E', () => {
        // A number-system-1 UPC-E is bar for bar the left half of an EAN-13 (+ its centre guard and the first
        // bar of the right half), check digit = the EAN-13's first digit. Before, a box held half out of the
        // aiming band, or with glare over its right half, showed a WRONG number roughly once in ten.
        const glare = (bits: string, from: number) => bits.slice(0, from) + '0'.repeat(bits.length - from);
        const cut = (img: ReturnType<typeof render>, modules: number, quiet = 12, px = 3) => {
            const width = (quiet + modules) * px;
            const data = new Uint8ClampedArray(width * img.height);
            for (let y = 0; y < img.height; y++) data.set(img.data.subarray(y * img.width, y * img.width + width), y * width);
            return { ...img, data, width };
        };
        // Glare from module 51 (the right half washed out): was read as upc_e 10439593.
        expect(decodeBarcodeImage(render(glare(ean13('3043959823297'), 51), { module: 3, spread: 0.3 }))).toBeNull();
        // Cut by the edge of the aiming band at module 55: was read as upc_e 14547441.
        expect(decodeBarcodeImage(cut(render(ean13('1454744300305'), { module: 3, spread: 0.3 }), 55))).toBeNull();
        // The symbol itself: number system 1 reads as nothing (a native BarcodeDetector still reports it).
        const ns1 = `1123456${gs1Check('11234500006')}`; // UPC-E 1·123456·c expands to 1 12345 0000 6
        expect(decodeBarcodeImage(render(upcE(ns1), { module: 3, spread: 0.3 }))).toBeNull();
        // The whole EAN-13 still reads, of course.
        expect(decodeBarcodeImage(render(ean13('3043959823297'), { module: 3, spread: 0.3 }))).toEqual({ text: '3043959823297', format: 'ean_13' });
        expect(decodeBarcodeImage(render(ean13('1454744300305'), { module: 3, spread: 0.3 }))).toEqual({ text: '1454744300305', format: 'ean_13' });
    });
    it('tells 1 from 7 and 2 from 8 (same edge distances) under heavy ink spread', () => {
        const body = '717282817271';
        const code = body + gs1Check(body);
        for (const spread of [-0.6, 0, 0.6, 0.9]) {
            const img = render(ean13(code), { module: 3, spread, blur: 1 });
            expect(decodeBarcodeImage(img)?.text, `spread ${spread}px`).toBe(code);
        }
    });
    it('reads them upside down and held vertically', () => {
        const img = render(ean13('5901234123457'), { module: 3, spread: 0.3, blur: 1, height: 60 });
        expect(decodeBarcodeImage(mirror(img))).toEqual({ text: '5901234123457', format: 'ean_13' });
        expect(decodeBarcodeImage(transpose(img))).toEqual({ text: '5901234123457', format: 'ean_13' });
    });
    it('a wrong check digit reads as nothing (not as a different product)', () => {
        const img = render(ean13('4006381333932'), { module: 3 });
        expect(decodeBarcodeImage(img)).toBeNull();
        expect(decodeBarcodeRow(rowOf(img))).toBeNull();
    });
    it('a scanline reads with its symbology', () => {
        expect(decodeBarcodeRow(rowOf(render(ean8('96385074'), { module: 2 })))).toEqual({ text: '96385074', format: 'ean_8' });
    });
});

describe('Code 39 (shipping labels, asset tags)', () => {
    it('reads text and digits, 3:1 and 2:1', () => {
        const img = render(code39('WJS-2026 A'), { module: 2, spread: 0.3, blur: 1, noise: 6 });
        expect(decodeBarcodeImage(img)).toEqual({ text: 'WJS-2026 A', format: 'code_39' });
        const narrow = render(code39('SHIP42', 2), { module: 3, spread: 0.3, blur: 1 });
        expect(decodeBarcodeImage(narrow)).toEqual({ text: 'SHIP42', format: 'code_39' });
    });
    it('a registration code printed as Code 39 is still a registration code', () => {
        const img = render(code39('ABCD234XYZ'), { module: 2 });
        expect(decodeBarcodeImage(img, { regCodeOnly: true })).toEqual({ text: 'ABCD234XYZ', format: 'code_39' });
    });
});

describe('formats, noise and options', () => {
    it('reads all the built-in symbologies by default, and only the asked ones otherwise', () => {
        expect([...BUILTIN_FORMATS].sort()).toEqual(['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e']);
        const box = render(ean13('5901234123457'), { module: 3 });
        expect(decodeBarcodeImage(box, { formats: ['code_128'] })).toBeNull();
        expect(decodeBarcodeImage(box, { formats: ['ean_13'] })?.format).toBe('ean_13');
        // UPC-A is read by the EAN-13 reader but reported only when asked for.
        const upc = render(upcA('036000291452'), { module: 3 });
        expect(decodeBarcodeImage(upc, { formats: ['ean_13'] })).toBeNull();
        expect(decodeBarcodeImage(upc, { formats: ['upc_a'] })?.text).toBe('036000291452');
        // regCodeOnly: a product barcode is never a registration code.
        expect(decodeBarcodeImage(box, { regCodeOnly: true })).toBeNull();
    });
    it('noise, a blank frame and random bars read as nothing', () => {
        const rnd = prng(99);
        const w = 640, h = 240;
        const noise = new Uint8ClampedArray(w * h).map(() => rnd() * 255);
        expect(decodeBarcodeImage({ data: noise, width: w, height: h, channels: 1 })).toBeNull();
        expect(decodeBarcodeImage({ data: new Uint8ClampedArray(w * h).fill(200), width: w, height: h, channels: 1 })).toBeNull();
        for (let seed = 1; seed <= 40; seed++) {
            const r = prng(seed * 7919);
            let bits = '';
            for (let i = 0; i < 120; i++) bits += (r() < 0.5 ? '1' : '0').repeat(1 + Math.floor(r() * 4));
            expect(decodeBarcodeImage(render(bits, { module: 2, seed })), `seed ${seed}`).toBeNull();
        }
    });
    it('names the symbologies for the operator', () => {
        expect(formatLabel('ean_13')).toBe('EAN-13');
        expect(formatLabel('upc_e')).toBe('UPC-E');
        expect(formatLabel('code_39')).toBe('Code 39');
        expect(formatLabel('qr_code')).toBe('QR');
        expect(formatLabel('some_new_format')).toBe('SOME NEW FORMAT');
    });
});

// ── The aiming band ──────────────────────────────────────────────────────────────────────────────────

describe('aimCrop: the aiming frame in video pixels (object-fit: cover)', () => {
    it('a portrait phone: 1080×1920 video in a 390×560 view, frame 82% wide', () => {
        const view = { width: 390, height: 560 };
        const fw = 390 * 0.82, fh = fw / 2.6;
        const frame = { x: (390 - fw) / 2, y: (560 - fh) / 2, width: fw, height: fh };
        const c = aimCrop(1080, 1920, view, frame, 0, 0)!;
        // cover scale = max(390/1080, 560/1920) = 0.3611: the frame spans 82% of the video's width…
        expect(c.width / 1080).toBeCloseTo(0.82, 2);
        // …centred vertically, at FULL resolution (no downscale).
        expect(c.x + c.width / 2).toBeCloseTo(540, 0);
        expect(c.y + c.height / 2).toBeCloseTo(960, 0);
        expect(c.height).toBeCloseTo(fh / (390 / 1080), -1);
    });
    it('a landscape view crops the sides it does not show, and the padding stays inside the video', () => {
        const c = aimCrop(1920, 1080, { width: 400, height: 600 }, { x: 0, y: 250, width: 400, height: 100 }, 0.5, 0.5)!;
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.x + c.width).toBeLessThanOrEqual(1920);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.y + c.height).toBeLessThanOrEqual(1080);
        // cover scale = 600/1080: the view shows video x 240…1680; the frame ±50% spans exactly that.
        expect(Math.abs(c.x - 240)).toBeLessThanOrEqual(1);
        expect(Math.abs(c.x + c.width - 1680)).toBeLessThanOrEqual(1);
    });
    it('no usable geometry → null (the caller decodes the whole frame)', () => {
        expect(aimCrop(0, 0, { width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
        expect(aimCrop(1920, 1080, { width: 0, height: 0 }, { x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    });
});

describe('decodeVideoRegion: the band is decoded at full resolution', () => {
    /** A fake 2D canvas whose "video" is a big grayscale frame; drawImage samples it (nearest pixel). */
    function fakeCamera(frame: ReturnType<typeof render>) {
        const calls: number[][] = [];
        let target: Uint8ClampedArray = new Uint8ClampedArray(0);
        const canvas = {
            width: 0,
            height: 0,
            getContext: () => ({
                drawImage: (_src: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
                    calls.push([sx, sy, sw, sh, dx, dy, dw, dh]);
                    target = new Uint8ClampedArray(dw * dh * 4);
                    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
                        const fx = Math.min(frame.width - 1, Math.floor(sx + ((x + 0.5) * sw) / dw));
                        const fy = Math.min(frame.height - 1, Math.floor(sy + ((y + 0.5) * sh) / dh));
                        const v = frame.data[fy * frame.width + fx];
                        target.set([v, v, v, 255], (y * dw + x) * 4);
                    }
                },
                getImageData: () => ({ data: target }),
            }),
        };
        return { canvas, calls, video: { videoWidth: frame.width, videoHeight: frame.height } };
    }

    it('a product barcode with 1.5 px modules in a 2400 px wide frame: the band reads, the downscaled frame does not', () => {
        // A 2400×700 frame whose middle holds an EAN-13 drawn with 1.5 px per module.
        const ean = render(ean13('7702004003508'), { module: 1.5, quiet: 600, height: 120, padTop: 290 });
        const cam = fakeCamera(ean);
        const band = { x: 500, y: 250, width: ean.width - 1000, height: 200 };
        expect(decodeVideoRegion(cam.video, cam.canvas, band)).toEqual({ text: '7702004003508', format: 'ean_13' });
        // drawn 1:1 — the band was not downscaled.
        expect(cam.calls[0].slice(0, 4)).toEqual([band.x, band.y, band.width, band.height]);
        expect(cam.calls[0].slice(6)).toEqual([band.width, band.height]);
        // What 2.15.0 did: the whole frame squeezed to 960 px wide — the bars fall under a pixel.
        const whole = fakeCamera(ean);
        expect(decodeVideoRegion(whole.video, whole.canvas, null, { maxSide: 960 })).toBeNull();
    });
    it('no frame yet → null', () => {
        const cam = fakeCamera(render(ean8('96385074')));
        expect(decodeVideoRegion({ videoWidth: 0, videoHeight: 0 }, cam.canvas, null)).toBeNull();
    });
});
