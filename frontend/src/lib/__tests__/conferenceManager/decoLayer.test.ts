/**
 * conference-manager: a card never scrolls its own content out of sight (lib/phoneLayout.ts DECO_LAYER_CLASS).
 *
 * Live finding (iPhone SE, 375x667): the «Campos» builder card showed its content shifted up inside itself —
 * «Constructor» and the top of the wand icon cut off under the card's rounded top edge, an empty band at the
 * bottom. The card is `overflow-hidden`, and its decorative blob `absolute -left-20 -bottom-20 w-64 h-64` hung
 * 80 px below it: hidden overflow is still a scroll container, so the card had 80 px of its own to scroll, and
 * bringing its «no puedes publicar» notice into view (scrollIntoView, a focus, find-in-page) scrolled the CARD.
 * Nothing on screen can scroll it back.
 *
 * Pinned: every decorative blob of the plugin's screens (`absolute -right-/-bottom-/-left-/-top-N … rounded-full`)
 * sits inside a `data-cm-deco` layer — absolutely positioned at inset 0, clipping the blobs itself, not
 * interactive — so the card around it has no overflow to scroll; and the four cards that had loose blobs
 * («Campos», the «Localidades» public-link card, each location card, the form simulator's header) use it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DECO_LAYER_CLASS, HERO_HEAD_CLASS } from '../../../../../marketplace/plugins/conference-manager/client/lib/phoneLayout';

const ADMIN = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin');
const SOURCES = fs.readdirSync(ADMIN).filter((f) => f.endsWith('.tsx')).map((f) => ({ file: f, src: fs.readFileSync(path.join(ADMIN, f), 'utf8') }));

/** [start, end) of each `data-cm-deco` element: from its opening <div to the </div> that closes it. */
function decoLayers(src: string): [number, number][] {
    const out: [number, number][] = [];
    let at = 0;
    while ((at = src.indexOf('data-cm-deco=""', at)) !== -1) {
        const open = src.lastIndexOf('<div', at);
        const re = /<div\b|<\/div>/g;
        re.lastIndex = open;
        let depth = 0, m: RegExpExecArray | null, end = -1;
        while ((m = re.exec(src))) {
            depth += m[0] === '</div>' ? -1 : 1;
            if (depth === 0) { end = re.lastIndex; break; }
        }
        expect(end, 'a closed data-cm-deco layer').toBeGreaterThan(open);
        out.push([open, end]);
        at = end;
    }
    return out;
}

/** Positions of the decorative blobs: a rounded-full element offset outside its box. */
function blobs(src: string): number[] {
    const out: number[] = [];
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] ?? m[2] ?? '';
        if (/(?:^|\s)absolute(?:\s|$)/.test(cls) && /(?:^|\s)-(?:right|bottom|left|top)-\d/.test(cls) && /rounded-full/.test(cls)) out.push(m.index ?? 0);
    }
    return out;
}

describe('decorative blobs live in a clipped layer of their own', () => {
    it('the layer covers its card exactly, clips the blobs itself and takes no pointer events', () => {
        expect(DECO_LAYER_CLASS.split(/\s+/)).toEqual(expect.arrayContaining(['absolute', 'inset-0', 'overflow-hidden', 'pointer-events-none']));
    });

    it('every blob of every conference-manager screen is inside a data-cm-deco layer', () => {
        const loose: string[] = [];
        let total = 0;
        for (const { file, src } of SOURCES) {
            const layers = decoLayers(src);
            for (const at of blobs(src)) {
                total++;
                if (!layers.some(([a, b]) => at > a && at < b)) loose.push(`${file}:${src.slice(0, at).split('\n').length}`);
            }
        }
        expect(total).toBeGreaterThanOrEqual(7);
        expect(loose).toEqual([]);
    });

    it('«Campos», the public-link card, the location cards and the simulator header use it, aria-hidden', () => {
        const page = SOURCES.find((s) => s.file === 'page.tsx')!.src;
        const layers = page.match(/<div aria-hidden="true" className=\{DECO_LAYER_CLASS\} data-cm-deco="">/g) || [];
        expect(layers).toHaveLength(4);
        // The «Campos» card: its layer comes right after the card's opening tag, before the content.
        const fields = page.slice(page.indexOf('{/* Premium Publisher Card */}'), page.indexOf("{t('visual.form.builder')"));
        expect(fields).toMatch(/\}`\}>\s*\{\/\*[^*]*\*\/\}\s*<div aria-hidden="true" className=\{DECO_LAYER_CLASS\} data-cm-deco="">/);
    });
});

describe('the cards\' icon + title row on a narrow phone (HERO_HEAD_CLASS)', () => {
    it('below 640 px the icon goes above the title, which gets the card\'s whole width', () => {
        const tokens = HERO_HEAD_CLASS.split(/\s+/);
        expect(tokens).toEqual(expect.arrayContaining(['flex', 'items-center', 'max-sm:flex-col', 'max-sm:items-start']));
        expect(tokens.some((k) => /^(?:sm|md|lg):flex-col$/.test(k))).toBe(false); // the desktop row is unchanged
    });
    it('«Campos» and the public-link card use it, the title column may shrink, and the title never splits a word', () => {
        const page = SOURCES.find((s) => s.file === 'page.tsx')!.src;
        const heads = [...page.matchAll(/<div className=\{HERO_HEAD_CLASS\} data-cm-hero-head="">([\s\S]*?)<\/h3>/g)];
        expect(heads).toHaveLength(2);
        for (const [, body] of heads) {
            expect(body).toMatch(/w-14 h-14 shrink-0/);
            expect(body).toContain('<div className="min-w-0">');
            expect(body).not.toMatch(/<h3 className=\{?`?[^>]*break-(?:all|words)/);
        }
        expect(page).not.toContain('<div className="flex items-center gap-4 mb-5">');
    });
});
