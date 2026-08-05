/**
 * Capture each catalog theme's `screenshot.png` from the REAL running site.
 *
 *   node scripts/capture-theme-previews.mjs [slug…] [--url http://localhost:3000] [--keep]
 *
 * The admin theme picker and the marketplace card show `screenshot.png` when a theme ships one, and a
 * generic placeholder when it doesn't. A stale screenshot is worse than no screenshot: it shows a
 * design that no longer exists and the user picks a theme they will never get. That is exactly what
 * happened when twenty themes were rebuilt from Stitch and their year-old previews stayed behind.
 *
 * So the previews are captured, not drawn: install the theme, activate it over the admin API, load
 * the public home page in headless Chrome, save the viewport. What ships in the zip is what the theme
 * actually renders — composed chrome, self-hosted type, block tokens and all.
 *
 * It restores the theme that was active when it started, and (unless --keep) uninstalls the themes it
 * installed, so a capture run leaves the dev site as it found it.
 *
 * Requires: the dev site running, admin credentials, and Chrome. 1280x960 is the 4:3 the admin card
 * crops to (`aspect-[4/3] object-cover`).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const urlIdx = argv.indexOf("--url");
const BASE = urlIdx >= 0 ? argv[urlIdx + 1] : "http://localhost:3000";
const KEEP = argv.includes("--keep");
const asked = argv.filter((a, i) => !a.startsWith("--") && !(urlIdx >= 0 && i === urlIdx + 1));

const USER = process.env.WORDJS_ADMIN_USER || "admin";
const PASS = process.env.WORDJS_ADMIN_PASS || "admin123";
const SRC = path.resolve("marketplace/themes");
const DEST = path.resolve("backend/themes");

const CHROME = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error("Chrome not found — needed to capture previews");

// --------------------------------------------------------------------- api
let cookie = "";
async function api(method, route, body) {
    const res = await fetch(`${BASE}/api/v1${route}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            // The CSRF guard wants a positive same-origin signal, not a token.
            Origin: BASE,
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Install every theme at once by copying it into themes/, then wait for the server to notice.
 *
 * NOT through POST /themes/upload: that route is rate-limited to 50 uploads/hour per IP (correctly —
 * it is a file-upload endpoint), and a catalog capture run burns 20 of them, so a second run inside
 * the hour gets 429s all the way down. Copying is the "out-of-band disk edit" case core/themes.ts
 * documents: the memoized scan has a 60s TTL precisely as the backstop for it, so the themes appear
 * on their own. Polling for them is what makes the wait exactly as long as it needs to be.
 */
async function installAll(slugs) {
    for (const slug of slugs) {
        fs.cpSync(path.join(SRC, slug), path.join(DEST, slug), { recursive: true, force: true });
    }
    const want = new Set(slugs);
    const deadline = Date.now() + 90_000;
    process.stdout.write("waiting for the theme scan to expire (≤60s)…");
    for (;;) {
        const res = await api("GET", "/themes");
        const have = new Set((res.themes || res).map((t) => t.slug));
        if ([...want].every((s) => have.has(s))) break;
        if (Date.now() > deadline) throw new Error("themes never became visible to the API");
        process.stdout.write(".");
        await sleep(3000);
    }
    console.log(" ok");
}

function capture(slug, dest) {
    const tmp = path.join(process.env.TEMP || "/tmp", `wjs-shot-${slug}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    execFileSync(CHROME, [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--window-size=1280,960",
        // Long enough for the self-hosted @font-face files and the hero image to settle; the page is
        // server-rendered, so this is about paint, not about waiting for data.
        "--virtual-time-budget=8000",
        `--user-data-dir=${tmp}`,
        `--screenshot=${dest}`,
        `${BASE}/?preview-capture=1`,
    ], { stdio: "pipe" });
    fs.rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------- main
const slugs = asked.length
    ? asked
    : fs.readdirSync(SRC, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(SRC, e.name, ".design/stitch.json")))
        .map((e) => e.name).sort();

await api("POST", "/auth/login", { username: USER, password: PASS });
const before = (await api("GET", "/themes"));
const list = before.themes || before;
const original = (list.find((t) => t.active) || {}).slug || "default";
// slug → was it the active one, for the delete-before-reupload dance below.
const preinstalled = new Map(list.map((t) => [t.slug, !!t.active]));
console.log(`site: ${BASE} | active before: ${original}`);

const installed = slugs.filter((s) => !preinstalled.has(s));
await installAll(slugs);

let ok = 0;
for (const slug of slugs) {
    const src = path.join(SRC, slug);
    try {
        await api("POST", `/themes/${slug}/activate`);
        // switchTheme purges the 'settings' tag; give the public route a beat to re-render with it.
        await sleep(1200);
        capture(slug, path.join(src, "screenshot.png"));
        const kb = (fs.statSync(path.join(src, "screenshot.png")).size / 1024).toFixed(0);
        console.log(`  ✓ ${slug} — ${kb}KB`);
        ok++;
    } catch (e) {
        console.error(`  ✗ ${slug}: ${e.message}`);
        process.exitCode = 1;
    }
}

await api("POST", `/themes/${original}/activate`);
if (!KEEP) for (const slug of installed) fs.rmSync(path.join(DEST, slug), { recursive: true, force: true });
console.log(`\n${ok}/${slugs.length} captured. Restored ${original}${KEEP ? "" : `, uninstalled ${installed.length} theme(s)`}.`);
