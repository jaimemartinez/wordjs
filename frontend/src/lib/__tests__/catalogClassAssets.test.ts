/**
 * THE HOST COMPILES THE CATALOG'S CLASSES, SO NO CATALOG CLASS MAY LOAD A THIRD-PARTY ASSET.
 *
 * globals.css scans the first-party catalog sources (`@source "../../../marketplace/plugins/**…"`) so a
 * marketplace plugin installed at runtime finds its Tailwind classes on a live site. Everything those
 * sources spell becomes a real rule in the stylesheet every page loads — including an arbitrary
 * `bg-[url('https://…')]`, fetched wherever an element carries the class. conference-manager had one (a decorative noise texture on the «Crear
 * conferencia» card): once compiled, every admin who opened the conference list sent a request to
 * grainy-gradients.vercel.app, which answers 402, so it never even painted. A third-party fetch from the
 * admin leaks the admin's address and the page it is on to a host the site does not control.
 *
 * The population is DERIVED from globals.css: each `@source` glob under marketplace/plugins is walked,
 * so a new plugin (or a new glob) is covered without editing this file.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(__dirname, '../../app');
const REPO = path.resolve(__dirname, '../../../..');
const THIRD_PARTY_URL = /url\(\s*['"]?(?:https?:)?\/\//i;

/** The catalog roots and extensions the host stylesheet scans, read from its `@source` lines. */
function catalogSources(): { root: string; exts: string[] }[] {
    // Line-anchored, no comment stripping: the glob's own `/**/` would read as a CSS comment.
    const css = fs.readFileSync(path.join(APP, 'globals.css'), 'utf8');
    const out: { root: string; exts: string[] }[] = [];
    for (const m of css.matchAll(/^@source\s+"([^"]+)"\s*;/gm)) {
        const glob = m[1];
        if (!glob.includes('marketplace/plugins')) continue;
        const root = path.resolve(APP, glob.slice(0, glob.indexOf('/**')));
        const exts = (/\{([^}]+)\}$/.exec(glob)?.[1] || '').split(',').map((e) => `.${e.trim()}`);
        out.push({ root, exts });
    }
    return out;
}

function walk(dir: string, exts: string[], files: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, exts, files);
        else if (exts.includes(path.extname(e.name))) files.push(p);
    }
    return files;
}

describe('the catalog sources the host stylesheet compiles', () => {
    const scans = catalogSources();

    it('globals.css scans the first-party catalog (the population is real)', () => {
        expect(scans.length).toBeGreaterThan(0);
        const files = scans.flatMap((s) => walk(s.root, s.exts));
        expect(files.length).toBeGreaterThan(20);
        expect(files.some((f) => f.includes(`conference-manager${path.sep}client`))).toBe(true);
    });

    it('spell no url() to another host', () => {
        const offenders: string[] = [];
        for (const { root, exts } of scans) {
            for (const file of walk(root, exts)) {
                fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
                    if (THIRD_PARTY_URL.test(line)) offenders.push(`${path.relative(REPO, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
                });
            }
        }
        expect(offenders).toEqual([]);
    });
});
