/**
 * No outage page in the route cache (FALLOS 120).
 *
 * `next build` runs with no backend, so the homepage prerendered as "Service Temporarily Unavailable"
 * and every release shipped it as `.next/server/app/index.html`: after an install or an upgrade the
 * site served it (stale-while-revalidate) for minutes. A backend blip during a background revalidation
 * cached it over the good page the same way.
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { BackendUnavailableError, OUTAGE_ATTR, isBuildPhase, refuseOutageRender } from "../outageRender";

const require = createRequire(import.meta.url);
const FRONTEND = path.resolve(__dirname, "../../..");
const { dropOutagePrerenders, routeOf, OUTAGE_ATTR: SCRIPT_ATTR, OUTAGE_TEXT, DROPPED_FILE } =
    require(path.join(FRONTEND, "scripts/drop-outage-prerenders.js"));

const BUILD = { NEXT_PHASE: "phase-production-build" } as unknown as NodeJS.ProcessEnv;
const RUNTIME = {} as unknown as NodeJS.ProcessEnv;

describe("an outage render is never cached", () => {
    it("at runtime the route throws (Next keeps the last good page and caches nothing)", () => {
        expect(isBuildPhase(RUNTIME)).toBe(false);
        expect(() => refuseOutageRender("/", RUNTIME)).toThrow(BackendUnavailableError);
    });

    it("during `next build` it returns, so the build does not fail; the page renders tagged markup", () => {
        expect(isBuildPhase(BUILD)).toBe(true);
        expect(() => refuseOutageRender("/", BUILD)).not.toThrow();
        expect(SCRIPT_ATTR).toBe(OUTAGE_ATTR);
    });

    it("every app route that renders the outage text refuses to cache it and tags it", () => {
        const app = path.join(FRONTEND, "src/app");
        const sources: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name !== "__tests__") walk(p); }
                else if (/\.tsx?$/.test(e.name)) sources.push(p);
            }
        };
        walk(app);
        const rendering = sources.filter((f) => fs.readFileSync(f, "utf8").includes(OUTAGE_TEXT));
        expect(rendering.length).toBeGreaterThan(0);
        for (const file of rendering) {
            const src = fs.readFileSync(file, "utf8");
            expect(src, file).toContain("refuseOutageRender(");
            expect(src, file).toContain("[OUTAGE_ATTR]");
        }
    });

    it("the build runs the post-build step", () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, "package.json"), "utf8"));
        expect(pkg.scripts.postbuild).toBe("node scripts/drop-outage-prerenders.js");
    });
});

describe("the post-build step drops tagged prerenders and fails on untagged ones", () => {
    const temps: string[] = [];
    afterEach(() => { while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true }); });

    function build(files: Record<string, string>): string {
        const next = fs.mkdtempSync(path.join(os.tmpdir(), "wjs-outage-"));
        temps.push(next);
        for (const [rel, body] of Object.entries(files)) {
            const p = path.join(next, "server", "app", rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, body);
        }
        return next;
    }
    const exists = (next: string, rel: string) => fs.existsSync(path.join(next, "server", "app", rel));

    it("removes the page's html, rsc, meta and segment prefetches, keeps every other prerender, and lists the route", () => {
        const next = build({
            "index.html": `<div ${OUTAGE_ATTR}=""><h1>${OUTAGE_TEXT}</h1></div>`,
            "index.rsc": "x",
            "index.meta": "{}",
            "index.segments/_full.segment.rsc": "x",
            "_not-found.html": "<h1>Page not found</h1>",
            "install.html": "<h1>Install</h1>",
        });
        const { dropped, leftovers } = dropOutagePrerenders(next);
        expect(dropped).toEqual(["index.html"]);
        expect(leftovers).toEqual([]);
        for (const rel of ["index.html", "index.rsc", "index.meta", "index.segments"]) expect(exists(next, rel), rel).toBe(false);
        expect(exists(next, "_not-found.html")).toBe(true);
        expect(exists(next, "install.html")).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(next, DROPPED_FILE), "utf8"))).toEqual({ routes: ["/"] });
    });

    it("reports an outage page nobody tagged (it would ship)", () => {
        const next = build({ "pages/about.html": `<h1>${OUTAGE_TEXT}</h1>` });
        expect(dropOutagePrerenders(next)).toEqual({ dropped: [], leftovers: ["pages/about.html"] });
    });

    it("a build that reached its backend drops nothing", () => {
        const next = build({ "index.html": "<h1>My site</h1>" });
        expect(dropOutagePrerenders(next)).toEqual({ dropped: [], leftovers: [] });
        expect(exists(next, "index.html")).toBe(true);
    });

    it("maps prerender files to routes", () => {
        expect(routeOf("index.html")).toBe("/");
        expect(routeOf("pages/about.html")).toBe("/pages/about");
    });
});
