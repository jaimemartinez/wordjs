/**
 * conference-manager 2.15.1 — every modal and sheet of the plugin on a phone.
 *
 * The report: on an iPhone the «Nueva conferencia» form opened UNDER the admin header (a sticky z-5000
 * bar; the modal was a z-[100] div inside the page), its title and close button out of reach, the dates
 * pushed out of the card, the keyboard popping up over it, and the page behind rubber-banding. What is
 * pinned here:
 *   - `Overlay` is portalled to <body>, in the 6000 band (above the admin chrome, below the toasts),
 *     keeping the old relative order of the plugin's layers;
 *   - it scrolls itself (100dvh, overscroll contained) with the safe-centre layout, and carries the phone
 *     rules (16px inputs, shrinkable date inputs, bottom sheet, compact paddings) in its own <style>;
 *   - it pins the page behind it the way iOS honours (position:fixed at -scrollY, restored), reference
 *     counted for a confirm over a modal;
 *   - inputs only autofocus with a fine pointer;
 *   - in the plugin's sources NO modal backdrop is left outside `Overlay`, and no field autofocuses
 *     unconditionally inside one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

const portals: unknown[] = [];
vi.mock('react-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom')>();
    return { ...actual, createPortal: (node: React.ReactNode, container: unknown) => { portals.push(container); return node; } };
});

import { Overlay } from '../../../../../marketplace/plugins/conference-manager/client/admin/Overlay';
import { OVERLAY_BASE_Z, OVERLAY_CSS, canAutoFocus, lockBodyScroll, overlayZ } from '../../../../../marketplace/plugins/conference-manager/client/lib/overlay';

const ADMIN = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin');

afterEach(() => {
    vi.unstubAllGlobals();
    portals.length = 0;
});

describe('overlayZ: the 6000 band', () => {
    it('above the admin header (5000), sidebar (5002) and its toggle (5003); below the toasts (9999); old order kept', () => {
        const z = [1, 2, 3, 4].map(overlayZ);
        expect(z).toEqual([6010, 6020, 6030, 6040]);
        for (const v of z) { expect(v).toBeGreaterThan(5003); expect(v).toBeLessThan(9999); }
        // The phone scanner sits at the band's base: a plugin modal never hides under it by accident.
        expect(OVERLAY_BASE_Z).toBe(6000);
        expect(overlayZ(0)).toBe(6010);
        expect(overlayZ(99)).toBe(6090);
    });
});

describe('Overlay', () => {
    it('is portalled to <body> when there is one', () => {
        const body = { tag: 'body' };
        vi.stubGlobal('document', { body });
        renderToStaticMarkup(<Overlay layer={3}><div role="dialog">x</div></Overlay>);
        expect(portals).toEqual([body]);
    });
    it('scrolls itself, full dynamic height, contained, at its layer — structure inline', () => {
        const html = renderToStaticMarkup(<Overlay layer={2} backdrop="rgba(0,0,0,0.5)"><div role="dialog">card</div></Overlay>);
        const outer = html.match(/<div[^>]*data-cm-overlay=""[^>]*>/)?.[0] || '';
        expect(outer).toContain('position:fixed');
        expect(outer).toContain('z-index:6020');
        expect(outer).toContain('height:100dvh');
        expect(outer).toContain('overflow-y:auto');
        expect(outer).toContain('overscroll-behavior:contain');
        expect(outer).toContain('background:rgba(0,0,0,0.5)');
        expect(outer).toContain('data-cm-sheet=""');
        // Safe centre: the wrapper is at least as tall as the overlay; on a phone the card sits at the bottom.
        const inner = html.match(/<div[^>]*data-cm-overlay-inner=""[^>]*>/)?.[0] || '';
        expect(inner).toContain('min-height:100%');
        expect(inner).toContain('align-items:flex-end');
        expect(html).toContain('<div role="dialog">card</div>');
    });
    it('a non-sheet overlay (the receipt lightbox) is centred everywhere', () => {
        const html = renderToStaticMarkup(<Overlay sheet={false}><figure>receipt</figure></Overlay>);
        expect(html.match(/<div[^>]*data-cm-overlay=""[^>]*>/)?.[0]).not.toContain('data-cm-sheet');
        expect(html.match(/<div[^>]*data-cm-overlay-inner=""[^>]*>/)?.[0]).toContain('align-items:center');
    });
    it('carries the phone rules in its own <style>', () => {
        const html = renderToStaticMarkup(<Overlay><div /></Overlay>);
        expect(html).toContain('<style>');
        // ≥16px fields below 640px (iOS zooms into anything smaller), shrinkable date inputs, centred from 640px.
        expect(OVERLAY_CSS).toMatch(/@media \(max-width: 639\.98px\)[\s\S]*font-size: 16px/);
        expect(OVERLAY_CSS).toMatch(/\[type="datetime-local"\][\s\S]*min-width: 0;[\s\S]*appearance: none/);
        expect(OVERLAY_CSS).toMatch(/@media \(min-width: 640px\)[\s\S]*align-items: center !important/);
        expect(OVERLAY_CSS).toContain('env(safe-area-inset-bottom');
        expect(html).toContain('font-size: 16px');
    });
});

describe('lockBodyScroll: the page behind stays put on iOS', () => {
    function fakePage(scrollY: number) {
        const body = { style: { position: '', top: '', left: '', right: '', width: '', overflow: 'auto', overscrollBehavior: '' } as Record<string, string> };
        const html = { style: { overscrollBehavior: '' } as Record<string, string> };
        const scrollTo = vi.fn();
        vi.stubGlobal('document', { body, documentElement: html });
        vi.stubGlobal('window', { scrollY, pageYOffset: scrollY, scrollTo });
        return { body, html, scrollTo };
    }
    it('pins the body at -scrollY, and restores everything (scroll position included) on the LAST release', () => {
        const { body, html, scrollTo } = fakePage(240);
        const releaseModal = lockBodyScroll();
        expect(body.style).toMatchObject({ position: 'fixed', top: '-240px', width: '100%', overflow: 'hidden', overscrollBehavior: 'none' });
        expect(html.style.overscrollBehavior).toBe('none');
        const releaseConfirm = lockBodyScroll();   // a confirm over the modal
        releaseModal();                             // released in any order
        expect(body.style.position).toBe('fixed');
        releaseConfirm();
        expect(body.style).toMatchObject({ position: '', top: '', width: '', overflow: 'auto', overscrollBehavior: '' });
        expect(html.style.overscrollBehavior).toBe('');
        expect(scrollTo).toHaveBeenCalledWith(0, 240);
        releaseConfirm();                           // idempotent
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });
    it('outside a browser it is a no-op', () => {
        expect(() => lockBodyScroll()()).not.toThrow();
    });
});

describe('canAutoFocus: no keyboard popping up on a phone', () => {
    it('only with a fine pointer', () => {
        expect(canAutoFocus()).toBe(false);
        vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q === '(pointer: fine)' }) });
        expect(canAutoFocus()).toBe(true);
        vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
        expect(canAutoFocus()).toBe(false);
    });
});

describe('the plugin\'s sources: every modal goes through Overlay', () => {
    const files = fs.readdirSync(ADMIN).filter((f) => f.endsWith('.tsx')).map((f) => ({ f, src: fs.readFileSync(path.join(ADMIN, f), 'utf8') }));

    it('no fixed full-screen backdrop is rendered in place (the scanner and the menu click-catcher aside)', () => {
        const offenders: string[] = [];
        for (const { f, src } of files) {
            src.split(/\r?\n/).forEach((line, i) => {
                if (!/fixed inset-0/.test(line) || /^\s*(\*|\/\/|\/\*)/.test(line)) return; // code, not comments
                if (f === 'MealScanner.tsx' && /data-meal-scanner/.test(line)) return; // portalled, inline styles
                if (/z-\[60\]/.test(line)) return; // a transparent click-catcher closing a dropdown menu, not a modal
                offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
            });
        }
        expect(offenders).toEqual([]);
    });
    it('every dialog file renders through Overlay', () => {
        for (const { f, src } of files) {
            if (!/role="(alert)?dialog"/.test(src) || f === 'MealScanner.tsx' || f === 'Overlay.tsx') continue;
            expect(src, f).toMatch(/<Overlay[\s>]/);
        }
    });
    it('inside an overlay no field autofocuses unconditionally', () => {
        const offenders: string[] = [];
        for (const { f, src } of files) {
            const blocks = [...src.matchAll(/<(Overlay|Modal|ModalShell)\b[\s\S]*?<\/\1>/g)].map((m) => m[0]);
            for (const block of blocks) {
                for (const m of block.matchAll(/\bautoFocus\b(?!=\{(canAutoFocus\(\)|autoFocusSearch)\})/g)) {
                    const tagStart = block.lastIndexOf('<', m.index);
                    const tag = block.slice(tagStart + 1).match(/^\w+/)?.[0] || '';
                    if (tag === 'button') continue; // a button does not open the keyboard
                    // The return note appears after an explicit «Devolver» tap: typing is the next step.
                    if (/setReturnNote/.test(block.slice(tagStart, m.index))) continue;
                    offenders.push(`${f}: <${tag} … ${block.slice(m.index - 60, m.index + 9).replace(/\s+/g, ' ')}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
