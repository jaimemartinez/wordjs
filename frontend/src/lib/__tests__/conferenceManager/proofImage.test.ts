/**
 * conference-manager 2.18.0 — receipts are compressed ON THE PHONE (D-P11): a 4–8 MB camera photo travels as
 * a ≤ 1 MB JPEG data URL. Node has no canvas, so the browser APIs are injected: the ladder (1600 → 1280 →
 * 1024 px, quality 0.82 → 0.7 → 0.6) stops at the first result small enough; the photo's orientation is
 * asked for; what is not an image or is over 15 MB is refused before decoding; a failed decode still sends a
 * small raw image, and says «prueba con una captura» otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    COMPRESSION_PLAN, PROOF_ERROR_TEXT, PROOF_MAX_CHARS, PROOF_MAX_FILE_BYTES, createLru, dataUrlBytes, fitWithin, formatBytes, isImageDataUrl, prepareProof,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/proofImage';

const fakeCanvas = (sizeFor: (w: number, h: number, q: number) => number, calls: any[]) => () => {
    const c: any = { width: 0, height: 0 };
    c.getContext = () => ({ drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => calls.push({ draw: [w, h] }) });
    c.toDataURL = (type: string, q: number) => { calls.push({ type, q, w: c.width, h: c.height }); return 'data:image/jpeg;base64,' + 'A'.repeat(sizeFor(c.width, c.height, q)); };
    return c;
};

describe('prepareProof', () => {
    it('a big photo: longest side 1600 px first, JPEG 0.82; the first result under the cap wins', async () => {
        const calls: any[] = [];
        const decode = vi.fn(async () => ({ width: 4032, height: 3024, close: vi.fn() }));
        const r = await prepareProof({ type: 'image/jpeg', size: 6_000_000 }, { decode, canvas: fakeCanvas(() => 500_000, calls) });
        expect(r).toMatchObject({ ok: true, compressed: true, width: 1600, height: 1200 });
        expect(calls.filter((c) => c.type)).toEqual([{ type: 'image/jpeg', q: 0.82, w: 1600, h: 1200 }]);
    });
    it('too big at 1600 px: lower quality, then 1280 px, then 1024 px', async () => {
        const calls: any[] = [];
        const size = (_w: number, h: number, q: number) => (h === 1024 && q === 0.7 ? 900_000 : 1_200_000);
        const r = await prepareProof({ type: 'image/png', size: 9_000_000 }, { decode: async () => ({ width: 3000, height: 6000 }), canvas: fakeCanvas(size, calls) });
        expect(r.ok).toBe(true);
        expect(calls.filter((c) => c.type).map((c) => [c.h, c.q])).toEqual([[1600, 0.82], [1600, 0.7], [1600, 0.6], [1280, 0.82], [1280, 0.7], [1280, 0.6], [1024, 0.82], [1024, 0.7]]);
        if (r.ok) expect(r.dataUrl.length).toBeLessThanOrEqual(PROOF_MAX_CHARS);
    });
    it('refuses what is not an image, and more than 15 MB, before decoding', async () => {
        const decode = vi.fn();
        expect(await prepareProof({ type: 'application/pdf', size: 1000 }, { decode })).toEqual({ ok: false, error: 'not_image' });
        expect(await prepareProof({ type: 'image/jpeg', size: PROOF_MAX_FILE_BYTES + 1 }, { decode })).toEqual({ ok: false, error: 'too_large' });
        expect(await prepareProof(null, { decode })).toEqual({ ok: false, error: 'not_image' });
        expect(decode).not.toHaveBeenCalled();
    });
    it('the decode failed: a small PNG / JPEG / GIF / WebP goes as it is; anything else asks for a screenshot', async () => {
        const decode = async () => { throw new Error('no decoder'); };
        const small = 'data:image/png;base64,iVBORw0KGgo=';
        expect(await prepareProof({ type: 'image/png', size: 100 }, { decode, readAsDataUrl: async () => small })).toMatchObject({ ok: true, compressed: false, dataUrl: small });
        expect(await prepareProof({ type: 'image/heic', size: 100 }, { decode, readAsDataUrl: async () => 'data:image/heic;base64,AAAA' })).toEqual({ ok: false, error: 'unreadable' });
        expect(await prepareProof({ type: 'image/png', size: 100 }, { decode, readAsDataUrl: async () => 'data:image/png;base64,' + 'A'.repeat(PROOF_MAX_CHARS) })).toEqual({ ok: false, error: 'unreadable' });
        expect(PROOF_ERROR_TEXT.unreadable.fallback).toMatch(/captura de pantalla/);
    });
    it('the plan and the helpers', () => {
        expect(COMPRESSION_PLAN[0]).toEqual({ side: 1600, quality: 0.82 });
        expect(COMPRESSION_PLAN[COMPRESSION_PLAN.length - 1]).toEqual({ side: 1024, quality: 0.6 });
        expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
        expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });   // never enlarged
        expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3);
        expect(formatBytes(312 * 1024)).toBe('312 KB');
        expect(formatBytes(1.25 * 1024 * 1024)).toBe('1,3 MB');
        expect(isImageDataUrl('data:image/jpeg;base64,AAAA')).toBe(true);
        expect(isImageDataUrl('data:text/html;base64,AAAA')).toBe(false);
        expect(isImageDataUrl('javascript:alert(1)')).toBe(false);
    });
    it('the receipts cache keeps the ten most recently used', () => {
        const lru = createLru<string>(10);
        for (let i = 1; i <= 10; i++) lru.set(String(i), `p${i}`);
        lru.get('1');           // touched: survives
        lru.set('11', 'p11');
        expect(lru.size).toBe(10);
        expect(lru.get('2')).toBeUndefined();
        expect(lru.get('1')).toBe('p1');
    });
});
