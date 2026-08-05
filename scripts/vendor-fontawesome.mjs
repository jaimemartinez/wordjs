/**
 * Vendor Font Awesome Free into backend/public/vendor/fontawesome (perf F3: zero external origins).
 *
 *   node scripts/vendor-fontawesome.mjs [version]        default: the pinned VERSION below
 *
 * WHY vendor the FULL set instead of subsetting the ~10 glyphs the chrome uses: block content is
 * AUTHOR-CONTROLLED — Card/IconList take a free-text `fa-*` name and SocialLinks builds
 * `fa-brands fa-<network>` — so a subset silently breaks icons real pages already use. Self-hosting
 * removes the third-party origin (DNS+TLS on the critical path, a SPOF, and a privacy leak) while
 * every glyph keeps working.
 *
 * WOFF2 ONLY: browsers take the FIRST supported format in a src list, so the .ttf entries are dead
 * weight for anything newer than ~2016 (and nothing that old runs the app's client bundle). The
 * .ttf sources are stripped from the CSS so a missing file can never 404.
 *
 * The output is COMMITTED: an install must not need the network to render icons.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";

const VERSION = process.argv[2] || "6.7.2"; // 6.x: v7 renames icons that existing content uses
const OUT = path.resolve("backend/public/vendor/fontawesome");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wjs-fa-"));
try {
    console.log(`⬇️  npm pack @fortawesome/fontawesome-free@${VERSION}`);
    // Do NOT parse npm's stdout for the filename: it interleaves `npm notice` lines with the
    // tarball name. The directory is ours and empty, so globbing it is unambiguous.
    execFileSync("npm", ["pack", `@fortawesome/fontawesome-free@${VERSION}`, "--pack-destination", tmp], {
        encoding: "utf8", shell: process.platform === "win32", stdio: "ignore",
    });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack produced no tarball");
    // Relative filename + cwd, never an absolute path: GNU tar reads `C:\...` as a REMOTE host spec
    // ("Cannot connect to C:"), and --force-local doesn't exist on BSD tar (macOS).
    execFileSync("tar", ["-xzf", tgz], { cwd: tmp });

    const pkg = path.join(tmp, "package");
    const css = fs.readFileSync(path.join(pkg, "css", "all.min.css"), "utf8");

    // Drop the truetype half of every src list: `url(x.woff2) format("woff2"),url(x.ttf) format("truetype")`
    const stripped = css.replace(/,url\([^)]*\.ttf\)\s*format\(\s*(["'])truetype\1\s*\)/g, "");
    if (/\.ttf/.test(stripped)) throw new Error("a .ttf reference survived the strip — refusing to ship a 404");
    const faces = (stripped.match(/@font-face/g) || []).length;
    if (faces < 3) throw new Error(`expected >=3 @font-face blocks, found ${faces}`);
    let depth = 0;
    for (const ch of stripped) { if (ch === "{") depth++; else if (ch === "}") depth--; }
    if (depth !== 0) throw new Error("unbalanced braces after the strip — the CSS would be corrupt");

    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, "css"), { recursive: true });
    fs.mkdirSync(path.join(OUT, "webfonts"), { recursive: true });
    fs.writeFileSync(path.join(OUT, "css", "all.min.css"), stripped);

    let bytes = stripped.length;
    for (const f of fs.readdirSync(path.join(pkg, "webfonts"))) {
        if (!f.endsWith(".woff2")) continue;
        const buf = fs.readFileSync(path.join(pkg, "webfonts", f));
        fs.writeFileSync(path.join(OUT, "webfonts", f), buf);
        bytes += buf.length;
    }
    fs.writeFileSync(path.join(OUT, "VERSION"), `${VERSION}\n`);

    console.log(`✅ vendored Font Awesome ${VERSION} → ${path.relative(process.cwd(), OUT)} (${(bytes / 1024).toFixed(0)}KB, ${faces} @font-face, woff2 only)`);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
