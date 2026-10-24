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
        // 2.36.7: a HEIC this browser cannot decode says so (not the generic «unreadable»).
        expect(await prepareProof({ type: 'image/heic', size: 100 }, { decode, readAsDataUrl: async () => 'data:image/heic;base64,AAAA' })).toEqual({ ok: false, error: 'heic' });
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

describe('2.36.7 the signed consent sheet takes photos: JPG / PNG / WebP / HEIC, several pages, bigger than a receipt', async () => {
    const mod = await import('../../../../../marketplace/plugins/conference-manager/client/lib/proofImage');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const canvas = () => {
        const c: any = { width: 0, height: 0, getContext: () => ({ drawImage: () => undefined }), toDataURL: (_t: string, q: number) => `data:image/jpeg;base64,${'A'.repeat(Math.round(c.width * c.height * q / 1000))}` };
        return c;
    };
    it('a sheet photo keeps more detail than a receipt: about 2000 px at 0.85 first, within the sheet\'s cap', async () => {
        expect(mod.SHEET_PLAN[0]).toEqual({ side: 2000, quality: 0.85 });
        const decode = async () => ({ width: 4032, height: 3024 });
        const r = await mod.prepareProof({ type: 'image/jpeg', size: 4_000_000, name: 'hoja.jpg' }, { decode, canvas }, 3_000_000, mod.SHEET_PLAN);
        expect(r).toMatchObject({ ok: true, compressed: true, width: 2000, height: 1500 });
        // The receipt path is unchanged (1600 px first).
        const receipt = await mod.prepareProof({ type: 'image/jpeg', size: 4_000_000 }, { decode, canvas });
        expect(receipt).toMatchObject({ ok: true, width: 1600 });
    });
    it('HEIC: by its type, or by its name when the system gives none; decoded where the browser can (it leaves as JPEG), else a clear «heic»', async () => {
        expect(mod.isHeic({ type: 'image/heic' })).toBe(true);
        expect(mod.isHeic({ type: 'image/heif' })).toBe(true);
        expect(mod.isHeic({ type: '', name: 'IMG_0012.HEIC' })).toBe(true);
        expect(mod.isHeic({ type: 'image/jpeg', name: 'x.heic' })).toBe(false);
        // Safari reads HEIC: the photo is drawn and sent as JPEG.
        const ok = await mod.prepareProof({ type: '', size: 2_000_000, name: 'IMG_0012.HEIC' }, { decode: async () => ({ width: 3000, height: 4000 }), canvas }, 3_000_000, mod.SHEET_PLAN);
        expect(ok.ok && ok.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
        // A browser that cannot: «heic», never a silent failure.
        const no = await mod.prepareProof({ type: 'image/heic', size: 2_000_000 }, { decode: async () => { throw new Error('no'); }, readAsDataUrl: async () => 'data:image/heic;base64,AAAA' }, 3_000_000, mod.SHEET_PLAN);
        expect(no).toEqual({ ok: false, error: 'heic' });
        expect(mod.PROOF_ERROR_TEXT.heic.fallback).toMatch(/HEIC/);
    });
    it('the upload: several files, photos or a PDF (by type or by name), the camera offered on a phone without taking the gallery away', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/lib/PaperConsent.tsx'), 'utf8');
        expect(src).toContain('accept="image/*,.heic,.heif,application/pdf" multiple');
        expect(src).toContain('const r = await prepareProof(file, {}, cap, SHEET_PLAN);');
        expect(src).toContain('r.error === "heic" ? "paper.file.heic"');
        expect(src).toContain('(!file.type && /\\.pdf$/i.test(file.name))');
        // The camera: a second input with `capture`, shown on phones; the first one never forces the camera.
        expect(src).toContain('accept="image/*" capture="environment"');
        expect((src.match(/capture=/g) || []).length).toBe(1);
        expect(src).toContain('data-paper-camera={s.code}');
        const t = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/lib/consentI18n.ts'), 'utf8');
        for (const k of ['paper.camera', 'paper.file.heic', 'paper.file.huge']) expect((t.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, k).toBe(3);
    });
});
