/**
 * WordJS — NO OUTAGE PAGE BAKED INTO A BUILD (postbuild; FALLOS 120).
 *
 * `next build` prerenders the public pages it can, and nothing serves the backend while it runs: a
 * release build always found it unreachable. The homepage prerendered as "Service Temporarily
 * Unavailable", the release shipped that as `.next/server/app/index.html`, and after an install or an
 * upgrade the site answered it from the route cache (stale-while-revalidate) for minutes.
 *
 * A page that finds no backend at build time renders its outage markup tagged `data-wjs-outage`
 * (lib/outageRender.ts; at runtime it throws instead and caches nothing). This step deletes every
 * prerender that carries the tag — the page's .html, .rsc, .meta and its segment prefetches — and
 * leaves the route in the prerender manifest, so it stays ISR: the first request renders it with the
 * backend that is now running, and that render is what gets cached.
 *
 * Then it fails the build if any prerendered HTML still contains the outage text: an outage render
 * that a route forgot to tag would otherwise ship unnoticed.
 *
 * Usage: node scripts/drop-outage-prerenders.js [path/to/.next]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUTAGE_ATTR = 'data-wjs-outage';
const OUTAGE_TEXT = 'Service Temporarily Unavailable';
/** The routes dropped, written beside the build: the release check expects no HTML for exactly these. */
const DROPPED_FILE = 'wjs-dropped-prerenders.json';

/** `index.html` → `/`, `a/b.html` → `/a/b`. */
function routeOf(relHtml) {
    const rel = relHtml.slice(0, -'.html'.length);
    return rel === 'index' ? '/' : `/${rel}`;
}

function htmlFiles(dir) {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...htmlFiles(p));
        else if (e.name.endsWith('.html')) out.push(p);
    }
    return out;
}

/** Every file Next writes for the prerender whose HTML is `htmlPath`. */
function prerenderFiles(htmlPath) {
    const base = htmlPath.slice(0, -'.html'.length);
    return [htmlPath, `${base}.rsc`, `${base}.meta`, `${base}.segments`, `${base}.prefetch.rsc`]
        .filter((p) => fs.existsSync(p));
}

/**
 * Removes the tagged prerenders under `<nextDir>/server/app`, then checks no prerendered HTML is left
 * with the outage text. Returns { dropped, leftovers } (paths relative to server/app).
 */
function dropOutagePrerenders(nextDir) {
    const appDir = path.join(nextDir, 'server', 'app');
    const dropped = [];
    for (const file of htmlFiles(appDir)) {
        if (!fs.readFileSync(file, 'utf8').includes(OUTAGE_ATTR)) continue;
        for (const p of prerenderFiles(file)) fs.rmSync(p, { recursive: true, force: true });
        dropped.push(path.relative(appDir, file).split(path.sep).join('/'));
    }
    const leftovers = htmlFiles(appDir)
        .filter((file) => fs.readFileSync(file, 'utf8').includes(OUTAGE_TEXT))
        .map((file) => path.relative(appDir, file).split(path.sep).join('/'));
    fs.writeFileSync(path.join(nextDir, DROPPED_FILE), `${JSON.stringify({ routes: dropped.map(routeOf) }, null, 2)}\n`);
    return { dropped, leftovers };
}

module.exports = { dropOutagePrerenders, routeOf, OUTAGE_ATTR, OUTAGE_TEXT, DROPPED_FILE };

if (require.main === module) {
    const nextDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '.next'));
    const { dropped, leftovers } = dropOutagePrerenders(nextDir);
    if (dropped.length) {
        console.log(`   No backend during the build: ${dropped.length} prerender(s) rendered the outage page and were dropped (they render on the first request): ${dropped.join(', ')}`);
    }
    if (leftovers.length) {
        console.error(`✖ Prerendered HTML still carries "${OUTAGE_TEXT}": ${leftovers.join(', ')}`);
        console.error(`  A public page cached an outage render. Tag it with ${OUTAGE_ATTR} (lib/outageRender.ts) so it is never cached.`);
        process.exit(1);
    }
}
