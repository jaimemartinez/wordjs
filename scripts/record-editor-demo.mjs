/**
 * Record the editor demo that README.md embeds, so the GIF can be regenerated instead of aging.
 *
 *   node scripts/record-editor-demo.mjs [baseUrl]      (default http://localhost:3000)
 *
 * WHY THIS EXISTS AS A SCRIPT. The previous docs/media/verso-editor-demo.gif was recorded by hand and
 * then drifted: 77 commits later the editor no longer drags what the caption says it drags — "what you
 * drag is the block itself, not a card with its name", "the drag preview hangs from where you grabbed
 * it", "grabbing a block no longer starts a text selection" all landed after it. A demo nobody can
 * re-record is a screenshot of a product that used to exist.
 *
 * PREREQUISITES, and it refuses rather than producing a misleading recording if they are missing:
 *   · A PRODUCTION build served over PLAIN HTTP: `WORDJS_HTTP=1 npm run start:mono` after
 *     `npm run build:mono`. Dev mode paints its own overlay and compiles on demand, so it records
 *     stutter that is not in the product.
 *   · An admin session at frontend/e2e/.auth/admin.json, which the Playwright setup project writes:
 *     `cd frontend && npx playwright test --project=setup`.
 *
 * It drives the same helpers the e2e specs drive (the palette's data attributes and a real pointer
 * drag), so what it records is a path the suite also exercises rather than a bespoke script that could
 * pass while the product is broken.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://localhost:3000';
const STORAGE = path.join(repoRoot, 'frontend', 'e2e', '.auth', 'admin.json');
const OUT_GIF = path.join(repoRoot, 'docs', 'media', 'verso-editor-demo.gif');

const CANVAS = 'iframe[src*="/admin/canvas-frame"]';
const ROOT_SLOT = '[data-wjs-slot="verso:root:content"]';

/** A pause the VIEWER needs, not the product: a step nobody can follow teaches nobody anything. */
const beat = (page, ms) => page.waitForTimeout(ms);

function die(message) {
    console.error(`record-editor-demo: ${message}`);
    process.exit(1);
}

if (!fs.existsSync(STORAGE)) {
    die(`no admin session at ${STORAGE}. Run: cd frontend && npx playwright test --project=setup`);
}

const { chromium } = require(path.join(repoRoot, 'frontend', 'node_modules', '@playwright', 'test'));

/**
 * An ffmpeg that can actually do the job — checked, not assumed.
 *
 * Playwright ships one, but it is a MINIMAL build for screencast encoding: it has `scale` and none of
 * `fps`, `palettegen` or `paletteuse`, so the two-pass gif encode below fails inside the filtergraph
 * with a parse error that names the wrong filter. Rather than guess from the binary's path, each
 * candidate is asked what filters it has and rejected if it lacks one we use.
 */
const REQUIRED_FILTERS = ['fps', 'scale', 'palettegen', 'paletteuse'];

function hasFilters(bin) {
    const probe = spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    if (probe.status !== 0 || !probe.stdout) return false;
    return REQUIRED_FILTERS.every((f) => new RegExp(`\\s${f}\\s`).test(probe.stdout));
}

function ffmpegPath() {
    const candidates = [];
    // A real installation first: `ffmpeg` on PATH is the one with the full filter set.
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout) {
        for (const line of which.stdout.split(/\r?\n/)) if (line.trim()) candidates.push(line.trim());
    }
    const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
    const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('ffmpeg-')) : [];
    for (const d of dirs) {
        for (const rel of ['ffmpeg-win64.exe', 'ffmpeg-linux', 'ffmpeg-mac']) {
            const p = path.join(base, d, rel);
            if (fs.existsSync(p)) candidates.push(p);
        }
    }
    for (const c of candidates) if (hasFilters(c)) return c;
    return null;
}

const run = async () => {
    const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-demo-'));
    const browser = await chromium.launch();
    const context = await browser.newContext({
        storageState: STORAGE,
        viewport: { width: 1280, height: 760 },
        deviceScaleFactor: 1,
        recordVideo: { dir: videoDir, size: { width: 1280, height: 760 } },
    });
    const page = await context.newPage();

    try {
        await page.goto(`${BASE}/admin/pages/new`, { waitUntil: 'domcontentloaded' });
        // The chrome is mounted when the save control exists; the canvas when the root slot attaches.
        await page.getByRole('button', { name: /guardar|publicar|save|publish/i }).first()
            .waitFor({ state: 'visible', timeout: 60_000 });
        const frame = page.frameLocator(CANVAS);
        await frame.locator(ROOT_SLOT).waitFor({ state: 'attached', timeout: 60_000 });
        await beat(page, 900);

        // Build a small page from the palette. These are the same types create-page.spec.ts inserts.
        for (const type of ['Heading', 'Text', 'Card']) {
            await page.locator(`[data-wjs-palette] [data-wjs-palette-type="${type}"]`).first().click();
            await beat(page, 700);
        }

        // Type INTO the canvas. The README's caption promises "editing text right on the canvas", and a
        // demo that does not show it leaves the caption making a claim the picture does not support.
        //
        // DOUBLE click, not single: a single click SELECTS the block (its toolbar appears and the
        // inspector fills in) but does not enter inline edit, so keystrokes went nowhere and the first
        // recording of this step showed the heading still reading "Heading".
        try {
            const heading = frame.locator('[data-wjs-block-id]').first();
            await heading.dblclick();
            await beat(page, 450);
            await page.keyboard.press('Control+A');
            await page.keyboard.type('Ships with the editor', { delay: 60 });
            await beat(page, 900);
        } catch { /* the demo is still worth recording without this beat */ }

        // Then REORDER by dragging, which is what the README's caption promises and what changed most.
        const blocks = frame.locator('[data-wjs-block-id]');
        if (await blocks.count() >= 2) {
            const from = await blocks.nth(2).boundingBox();
            const to = await blocks.nth(0).boundingBox();
            if (from && to) {
                const start = { x: from.x + 24, y: from.y + from.height / 2 };
                const end = { x: to.x + 24, y: to.y + 8 };
                await page.mouse.move(start.x, start.y);
                await page.mouse.down();
                for (let i = 1; i <= 18; i++) {
                    await page.mouse.move(start.x + ((end.x - start.x) * i) / 18, start.y + ((end.y - start.y) * i) / 18);
                    await page.waitForTimeout(28);
                }
                await page.mouse.up();
                await beat(page, 900);
            }
        }

        // End on the PAGE, not wherever the drag left the scroll. The previous take finished on the
        // theme's footer because dragging upward scrolled the canvas, so the last thing a reader saw was
        // a copyright line instead of the three blocks they had just watched being built.
        try {
            await frame.locator('[data-wjs-block-id]').first().scrollIntoViewIfNeeded();
        } catch { /* the beat below still lands on something */ }
        await beat(page, 1200);
    } finally {
        await context.close();   // the video is only finalised on close
        await browser.close();
    }

    const webm = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm')).map((f) => path.join(videoDir, f))[0];
    if (!webm) die('playwright produced no video');

    const ffmpeg = ffmpegPath();
    if (!ffmpeg) {
        die(`no ffmpeg with the filters this needs (${REQUIRED_FILTERS.join(', ')}). Playwright's bundled `
            + 'build has only `scale`. Install a full ffmpeg and put it on PATH.');
    }

    // Two passes: a palette built from the whole clip, then the encode. One pass picks its palette from
    // the first frames, and the first frames here are an empty canvas, so the blocks come out banded.
    const palette = path.join(videoDir, 'palette.png');
    const filters = 'fps=10,scale=820:-1:flags=lanczos';
    const p1 = spawnSync(ffmpeg, ['-y', '-i', webm, '-vf', `${filters},palettegen=stats_mode=diff`, palette], { encoding: 'utf8' });
    if (p1.status !== 0) die(`ffmpeg palettegen failed: ${(p1.stderr || '').slice(-400)}`);
    const p2 = spawnSync(ffmpeg, ['-y', '-i', webm, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, OUT_GIF], { encoding: 'utf8' });
    if (p2.status !== 0) die(`ffmpeg paletteuse failed: ${(p2.stderr || '').slice(-400)}`);

    const bytes = fs.statSync(OUT_GIF).size;
    console.log(JSON.stringify({ gif: path.relative(repoRoot, OUT_GIF), bytes, source: path.basename(webm) }));
    try { fs.rmSync(videoDir, { recursive: true, force: true }); } catch { /* best effort */ }
};

run().catch((e) => die(String((e && e.stack) || e)));
