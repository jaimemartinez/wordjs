/**
 * conference-manager 2.15.1 — the phone scanner («Modo escáner») as the kitchen sees it on an iPhone.
 *
 * The reported failure, in production: a band of camera over the page with the admin header showing
 * through, a white dot instead of an aiming frame, and NO reaction at all to a product box barcode. What
 * is pinned (node environment, no DOM — server-rendered markup and the pure pieces the component runs):
 *   - the overlay's STRUCTURE is inline (black, fixed, full height, z-6000, bars with a background and
 *     safe-area padding, the 82% / 2.6:1 aiming frame) — it cannot depend on plugin Tailwind classes;
 *   - whatever is read is SHOWN: a value that is not a registration code is routed to the read card
 *     («Código leído: … — no es un código de inscripción», with its symbology), never dropped, and a
 *     product barcode is never turned into a fake 10-character code by normalizeCode();
 *   - a registration code still goes to the server once per sighting (and «Código no encontrado» stays the
 *     server's verdict for an unknown one);
 *   - the heartbeat comes from the decode loop: «Escaneando · N cuadros/s», «En pausa», and «La cámara no
 *     entrega imagen» + Reintentar after 2 s without an analysed frame; a refused video.play() asks for a tap;
 *   - BarcodeDetector is asked for every format it supports; the built-in path decodes the aiming band
 *     with regCodeOnly OFF;
 *   - the audio context unlocked in the opening tap is the one the scanner beeps with.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

// The scanner portals to <body>; on the server there is none — render the portal content in place.
vi.mock('react-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom')>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { I18nProvider } from '@/contexts/I18nContext';
import {
    AimFrame, CameraNotice, MealScanner, ReadCard, ScanPill, SCANNER_ROOT_STYLE, createFeedback, decodeCameraFrame,
    makeTx, pickNativeFormats, primeScannerAudio,
} from '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner';
import { classifyRead, createReadRouter, createScanMeter, isRegCode, normalizeCode } from '../../../../../marketplace/plugins/conference-manager/client/lib/meals';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';

const es = makeTx((k: string) => translations.es[k] ?? k);
const flat = (html: string) => html.replace(/<!-- -->/g, '');

afterEach(() => {
    vi.unstubAllGlobals();
});

// ── What is read, and what is posted ─────────────────────────────────────────────────────────────────

describe('classifyRead: only a real registration code is posted', () => {
    it('a badge (and a badge typed with separators) is a registration code', () => {
        expect(classifyRead('ABCD234XYZ', 'code_128')).toEqual({ kind: 'reg', code: 'ABCD234XYZ', format: 'code_128' });
        expect(classifyRead(' abcd-234x-yz\r', 'code_39')).toEqual({ kind: 'reg', code: 'ABCD234XYZ', format: 'code_39' });
    });
    it('a product barcode is SHOWN as read — even one normalizeCode() would turn into a 10-character "code"', () => {
        // The trap: stripping the 0s and 1s of this EAN-13 leaves exactly 10 characters of the code alphabet.
        expect(isRegCode(normalizeCode('5901234123457'))).toBe(true);
        expect(classifyRead('5901234123457', 'ean_13')).toEqual({ kind: 'other', value: '5901234123457', format: 'ean_13' });
        expect(classifyRead('https://example.org/x', 'qr_code')).toEqual({ kind: 'other', value: 'https://example.org/x', format: 'qr_code' });
        expect(classifyRead('HELLO', 'code_128')?.kind).toBe('other');
    });
    it('nothing read → nothing', () => {
        expect(classifyRead('', 'ean_13')).toBeNull();
        expect(classifyRead('\r\n', '')).toBeNull();
    });
});

describe('createReadRouter: the scanner\'s onCode', () => {
    it('posts a badge once per sighting, never while a request is in flight (and does not mark it seen then)', () => {
        const r = createReadRouter(3000);
        expect(r.route('ABCD234XYZ', 'code_128', true, 0)).toBeNull();
        expect(r.route('ABCD234XYZ', 'code_128', false, 100)).toEqual({ action: 'submit', code: 'ABCD234XYZ' });
        expect(r.route('ABCD234XYZ', 'code_128', false, 200)).toBeNull();      // still in view
        expect(r.route('ABCD234XYZ', 'code_128', false, 2000)).toBeNull();     // still in view
        expect(r.route('ABCD234XYZ', 'code_128', false, 3300)).toBeNull();     // 5 s held under the camera: posted once
        expect(r.route('ABCD234XYZ', 'code_128', false, 6400)).toEqual({ action: 'submit', code: 'ABCD234XYZ' }); // out of view > 3 s
    });
    it('shows anything else — fresh when it comes into view, kept alive while it stays', () => {
        const r = createReadRouter(3000);
        expect(r.route('5901234123457', 'ean_13', false, 0)).toEqual({ action: 'show', value: '5901234123457', format: 'ean_13', fresh: true });
        expect(r.route('5901234123457', 'ean_13', true, 100)).toEqual({ action: 'show', value: '5901234123457', format: 'ean_13', fresh: false });
        expect(r.route('96385074', 'ean_8', false, 200)).toMatchObject({ action: 'show', fresh: true });
        expect(r.route('5901234123457', 'ean_13', false, 4000)).toMatchObject({ action: 'show', fresh: true });
        r.reset();
        expect(r.route('96385074', 'ean_8', false, 4100)).toMatchObject({ fresh: true });
    });
});

describe('createScanMeter: the heartbeat comes from the decode loop', () => {
    it('frames per second, pause, and STALLED after 2 s without an analysed frame', () => {
        const m = createScanMeter(2000);
        m.start(0);
        expect(m.health(100)).toEqual({ state: 'scanning', fps: 0 });
        for (let t = 0; t < 1000; t += 125) m.frame(1000 + t);
        expect(m.health(1999)).toEqual({ state: 'scanning', fps: 8 });
        m.pause(2100);
        expect(m.health(2200)).toEqual({ state: 'paused', fps: 0 });
        m.pause(4000);                              // the loop keeps turning while paused: never "no image"
        expect(m.health(5500).state).toBe('paused');
        expect(m.health(6100)).toEqual({ state: 'stalled', fps: 0 }); // the loop stopped turning
        m.frame(6200);
        expect(m.health(6300)).toEqual({ state: 'scanning', fps: 1 });
        expect(m.health(8300).state).toBe('stalled'); // camera on, no frame for 2 s
    });
    it('a camera that never delivers a frame is stalled 2 s after it turned on', () => {
        const m = createScanMeter(2000);
        m.start(10_000);
        expect(m.health(11_900).state).toBe('scanning');
        expect(m.health(12_100).state).toBe('stalled');
    });
});

describe('BarcodeDetector is asked for every format it supports', () => {
    it('code_128 plus the rest (2.15.0 asked for code_128 only)', () => {
        expect(pickNativeFormats(['code_128', 'ean_13', 'upc_e', 'qr_code', 'unknown'])).toEqual(['code_128', 'ean_13', 'upc_e', 'qr_code']);
        expect(pickNativeFormats(undefined)).toEqual(expect.arrayContaining(['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39']));
        // Without Code 128 it cannot read the badges: the built-in reader is used instead.
        expect(pickNativeFormats(['qr_code', 'ean_13'])).toBeNull();
    });
});

describe('the built-in path decodes the aiming band, nothing filtered', () => {
    it('a product barcode under the aiming frame comes back WITH its symbology', () => {
        // EAN-8 96385074: guard, L-digits 9 6 3 8, centre guard, R-digits 5 0 7 4, guard.
        const bits = '101' + '0001011' + '0101111' + '0111101' + '0110111' + '01010' + '1001110' + '1110010' + '1000100' + '1011100' + '101';
        // A 1280×720 grayscale "camera" with the code in the middle, 3 px per module.
        const W = 1280, H = 720, px = 3;
        const frame = new Uint8ClampedArray(W * H).fill(235);
        const x0 = Math.round((W - bits.length * px) / 2);
        for (let y = 300; y < 420; y++) for (let i = 0; i < bits.length; i++) if (bits[i] === '1') for (let k = 0; k < px; k++) frame[y * W + x0 + i * px + k] = 20;
        let target = new Uint8ClampedArray(0);
        const draws: number[][] = [];
        const canvas = {
            width: 0, height: 0,
            getContext: () => ({
                drawImage: (_v: unknown, sx: number, sy: number, sw: number, sh: number, _dx: number, _dy: number, dw: number, dh: number) => {
                    draws.push([sw, sh, dw, dh]);
                    target = new Uint8ClampedArray(dw * dh * 4);
                    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
                        const v = frame[Math.floor(sy + (y * sh) / dh) * W + Math.floor(sx + (x * sw) / dw)];
                        target.set([v, v, v, 255], (y * dw + x) * 4);
                    }
                },
                getImageData: () => ({ data: target }),
            }),
        };
        // A portrait-ish 640×720 camera area (object-fit: cover → scale 1, the sides cut off); the aiming
        // frame is 82% of its width, 2.6:1, centred — what MealScanner lays out.
        const video = { videoWidth: W, videoHeight: H, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 720 }) };
        const fw = 640 * 0.82, fh = fw / 2.6;
        const aim = { getBoundingClientRect: () => ({ left: (640 - fw) / 2, top: (720 - fh) / 2, width: fw, height: fh }) };
        expect(decodeCameraFrame(video, canvas, aim)).toEqual({ text: '96385074', format: 'ean_8' });
        // Only the band under the frame was drawn, 1:1 (full resolution, nothing downscaled).
        expect(canvas.width).toBeLessThan(W);
        expect(canvas.height).toBeLessThan(H);
        expect(draws[0][0]).toBe(draws[0][2]);
        expect(draws[0][1]).toBe(draws[0][3]);
    });
});

// ── Audio unlocked inside the opening tap ────────────────────────────────────────────────────────────

describe('audio: the context unlocked in the tap is the one the scanner uses', () => {
    it('primeScannerAudio creates + unlocks; the scanner\'s feedback ADOPTS it and closes it', () => {
        const made: any[] = [];
        class FakeCtx {
            state = 'suspended'; currentTime = 0; destination = {};
            resumed = 0; closed = 0; started = 0;
            constructor() { made.push(this); }
            resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); }
            close() { this.closed++; this.state = 'closed'; return Promise.resolve(); }
            createBuffer() { return {}; }
            createBufferSource() { return { connect() { }, start: () => { this.started++; } }; }
            createOscillator() { return { type: '', frequency: { value: 0 }, connect() { }, start() { }, stop() { } }; }
            createGain() { return { gain: { setValueAtTime() { }, exponentialRampToValueAtTime() { } }, connect() { } }; }
        }
        vi.stubGlobal('window', { AudioContext: FakeCtx });
        vi.stubGlobal('navigator', {});
        const primed = primeScannerAudio();
        expect(made).toHaveLength(1);
        expect(primed).toBe(made[0]);
        expect(made[0].resumed).toBe(1);   // resumed inside the gesture…
        expect(made[0].started).toBe(1);   // …and a silent sample played: iOS unlocks the context
        const fb = createFeedback({ adopt: true });
        fb.ok();
        fb.info();
        expect(made).toHaveLength(1);      // no second context: the unlocked one is used
        fb.close();
        expect(made[0].closed).toBe(1);
        fb.bad();
        expect(made).toHaveLength(1);      // nothing after close
    });
});

// ── What the screen shows ────────────────────────────────────────────────────────────────────────────

describe('the scanner pieces render with inline structure', () => {
    it('the aiming frame: 82% wide, 2.6:1, dimmed surroundings, a sweeping line only while scanning', () => {
        const on = renderToStaticMarkup(<AimFrame scanning />);
        expect(on).toContain('width:82%');
        expect(on).toContain('aspect-ratio:2.6 / 1');
        expect(on).toContain('box-shadow:0 0 0 9999px rgba(0,0,0,0.35)');
        expect(on).toContain('border:4px solid rgba(255,255,255,0.9)');
        expect(on).toMatch(/data-scan-line=""[^>]*animation:cm-scan-sweep/);
        expect(renderToStaticMarkup(<AimFrame scanning={false} />)).toMatch(/data-scan-line=""[^>]*animation:none/);
    });
    it('the heartbeat: «Escaneando · N cuadros/s», «En pausa», nothing when stalled', () => {
        expect(flat(renderToStaticMarkup(<ScanPill health={{ state: 'scanning', fps: 7 }} tx={es} />))).toContain('Escaneando · 7 cuadros/s');
        expect(renderToStaticMarkup(<ScanPill health={{ state: 'scanning', fps: 7 }} tx={es} />)).toContain('data-scan-state="scanning"');
        expect(flat(renderToStaticMarkup(<ScanPill health={{ state: 'paused', fps: 0 }} tx={es} />))).toContain('En pausa');
        expect(renderToStaticMarkup(<ScanPill health={{ state: 'stalled', fps: 0 }} tx={es} />)).toBe('');
    });
    it('no image for 2 s → «La cámara no entrega imagen» + Reintentar; a refused play() → «Toca para activar la cámara»', () => {
        const stalled = flat(renderToStaticMarkup(<CameraNotice health={{ state: 'stalled', fps: 0 }} playBlocked={false} tx={es} onRetry={() => { }} onActivate={() => { }} />));
        expect(stalled).toContain('data-camera-notice="stalled"');
        expect(stalled).toContain('La cámara no entrega imagen');
        expect(stalled).toContain('data-camera-retry=""');
        expect(stalled).toContain('Reintentar');
        const blocked = flat(renderToStaticMarkup(<CameraNotice health={{ state: 'stalled', fps: 0 }} playBlocked tx={es} onRetry={() => { }} onActivate={() => { }} />));
        expect(blocked).toContain('data-camera-notice="blocked"');
        expect(blocked).toContain('Toca para activar la cámara');
        expect(renderToStaticMarkup(<CameraNotice health={{ state: 'scanning', fps: 5 }} playBlocked={false} tx={es} />)).toBe('');
    });
    it('the read card: what was read, its symbology, and that it is not a registration code', () => {
        const html = flat(renderToStaticMarkup(<ReadCard read={{ value: '5901234123457', format: 'ean_13', seq: 1 }} tx={es} />));
        expect(html).toContain('data-scan-read="ean_13"');
        expect(html).toContain('EAN-13');
        expect(html).toContain('Código leído: 5901234123457 — no es un código de inscripción');
        expect(html).toContain('background:rgba(17,24,39,0.94)');
        const long = flat(renderToStaticMarkup(<ReadCard read={{ value: 'x'.repeat(500), format: 'qr_code', seq: 2 }} tx={es} />));
        expect(long).toContain(`${'x'.repeat(120)}…`);
        expect(long).not.toContain('x'.repeat(121));
    });
    it('every new message exists in es, en and pt', () => {
        const keys = ['meals.scanner.scanning', 'meals.scanner.paused', 'meals.scanner.focus.hint', 'meals.scanner.read.other', 'meals.scanner.read.symbology', 'meals.camera.tap', 'meals.camera.noframes', 'meals.camera.noframes.hint'];
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of keys) expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
        expect(translations.en['meals.scanner.read.other']).toContain('{value}');
        expect(translations.pt['meals.scanner.scanning']).toContain('{n}');
    });
});

/**
 * WIRING. The component's effects need a browser (camera, timers, a DOM) and this suite runs in node, so
 * the few lines that connect the tested pieces to the component are pinned on the source itself: if one
 * of them is dropped, the piece it connects is tested but dead.
 */
describe('wiring (source): the tested pieces are the ones the scanner runs', () => {
    const ADMIN = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin');
    const scanner = fs.readFileSync(path.join(ADMIN, 'MealScanner.tsx'), 'utf8');
    const page = fs.readFileSync(path.join(ADMIN, 'MealsPage.tsx'), 'utf8');
    const body = scanner.slice(scanner.indexOf('export function MealScanner('));

    it('the decode loop feeds the heartbeat and decodes the aiming band with the built-in reader', () => {
        expect(body).toMatch(/if \(inFlight\.current \|\| sheetRef\.current \|\| armedRef\.current\) meter\.current\.pause\(\);/);
        expect(body).toMatch(/const hit = decodeCameraFrame\(video, canvas, aimRef\.current\);\s+meter\.current\.frame\(\);\s+if \(hit\) onCodeRef\.current\(hit\.text, hit\.format\);/);
        expect(body).toMatch(/meter\.current\.frame\(\);\s+for \(const c of codes \|\| \[\]\) onCodeRef\.current\(String\(c\.rawValue \|\| ''\), String\(c\.format \|\| ''\)\);/);
        expect(body).toMatch(/setCam\('on'\);\s+meter\.current\.start\(\);/);
        expect(body).toMatch(/<AimFrame frameRef=\{aimRef\}/);
    });
    it('onCode routes every read: a badge is posted, anything else lands on the read card', () => {
        expect(body).toMatch(/const r = router\.current\.route\(raw, format, inFlight\.current\);/);
        expect(body).toMatch(/if \(r\.action === 'submit'\) \{ submit\(\{ code: r\.code \}\); return; \}/);
        expect(body).toMatch(/if \(r\.fresh\) \{ setRead\(\{ value: r\.value, format: r\.format, seq: Date\.now\(\) \}\); feedback\.current\.info\(\); \}/);
        expect(body).toMatch(/<ReadCard read=\{read\}/);
    });
    it('a refused play() asks for a tap; 1920×1080 is requested; the page behind is pinned; presses unlock the audio', () => {
        expect(body).toMatch(/err\?\.name !== 'AbortError'\) setPlayBlocked\(true\)/);
        expect(body).toMatch(/<CameraNotice health=\{health\} playBlocked=\{playBlocked\}/);
        expect(body.match(/width: \{ ideal: 1920 \}, height: \{ ideal: 1080 \}/g)).toHaveLength(2);
        expect(body).toMatch(/const releaseScroll = lockBodyScroll\(\);/);
        expect(body).toMatch(/releaseScroll\(\);/);
        expect(body).not.toMatch(/document\.body\.style\.overflow/);
        expect(body).toMatch(/onPointerDown=\{\(\) => feedback\.current\.prime\(\)\}/);
        expect(body).toMatch(/const feedback = useRef\(createFeedback\(\{ adopt: true \}\)\);/);
    });
    it('both buttons that open the scanner prime the audio synchronously inside the tap', () => {
        expect(page).toMatch(/const openScanner = \(\) => \{ primeScannerAudio\(\); setScanner\(true\); \};/);
        expect(page.match(/setScanner\(true\)/g)).toHaveLength(1);
        expect(page.match(/=\{openScanner\}/g)).toHaveLength(2);
    });
});

describe('MealScanner: the overlay is black, full screen and above the admin chrome by itself', () => {
    it('root and bars carry their structure inline', () => {
        vi.stubGlobal('document', { body: {} });
        const html = renderToStaticMarkup(
            <I18nProvider>
                <MealScanner conferenceId={1} services={[]} serviceId={null} onServiceChange={() => { }} onClose={() => { }} />
            </I18nProvider>,
        );
        const root = html.match(/<div[^>]*data-meal-scanner=""[^>]*>/)?.[0] || '';
        expect(root).toContain('position:fixed');
        expect(root).toContain('z-index:6000');
        expect(root).toContain('background:#000');
        expect(root).toContain('height:100dvh');
        expect(SCANNER_ROOT_STYLE).toMatchObject({ position: 'fixed', top: 0, bottom: 0, left: 0, right: 0, zIndex: 6000, background: '#000' });
        // The bars are opaque (they used to be transparent over the admin header) and clear the notch / home bar.
        expect(html).toContain('padding-top:max(env(safe-area-inset-top), 12px)');
        expect(html).toContain('padding-bottom:max(env(safe-area-inset-bottom), 12px)');
        expect((html.match(/background:rgba\(0,0,0,0.8\)/g) || []).length).toBeGreaterThanOrEqual(3);
        // The camera area takes the rest and swallows touch gestures (no page panning behind it).
        expect(html).toMatch(/data-camera-area=""[^>]*touch-action:none/);
        // Keyframes for the scan line ship with the scanner.
        expect(html).toContain('@keyframes cm-scan-sweep');
    });
});
