/**
 * `allowedDevOrigins` (next.config.ts) — the hosts `next dev` serves its own chunks and HMR socket to.
 *
 * Next 16 answers 403 to /_next/* for any Origin that is not localhost, so a page opened from a phone at
 * the dev machine's LAN address never hydrates (the admin hangs on its spinner). The list must be the
 * backend's DEVELOPMENT host policy — computed by the backend's own module, so the two cannot drift —
 * and nothing more: an address the API refuses gains nothing from the dev server either.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as hostPolicy from "../../../../backend/src/core/host-policy.js";
import { loadAllowedDevOrigins, resolveAllowedDevOrigins } from "../../../next.config";

const VECTORS = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../../../../contracts/host-policy-vectors.v1.json"), "utf8"),
) as { ownAddresses: { interfaces: Record<string, Array<{ address: string; family: string | number; internal: boolean }>> } };

const interfaces = {
    "Wi-Fi": [
        { address: "192.168.1.11", family: "IPv4", internal: false },
        { address: "2001:DB8::11", family: "IPv6", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
    ],
    Loopback: [
        { address: "127.0.0.1", family: "IPv4", internal: true },
        { address: "::1", family: "IPv6", internal: true },
    ],
};

describe("with the backend's module (monolith and local split)", () => {
    it("is this machine's addresses plus every name the backend accepts in development", () => {
        const origins = resolveAllowedDevOrigins({
            hostPolicy,
            config: {
                siteUrl: "https://example.com",
                siteAliases: [{ url: "https://www.example.com" }, { url: "http://192.168.1.50:3000" }],
            },
            env: { WORDJS_ALLOWED_HOSTS: "ingress.example.net", WORDJS_DEV_ORIGINS: "DevBox.lan, https://tunnel.example.org" },
            interfaces,
        });
        expect(origins.sort()).toEqual([
            "192.168.1.11",
            "192.168.1.50",
            "[2001:db8::11]",
            "devbox.lan",
            "example.com",
            "ingress.example.net",
            "tunnel.example.org",
            "www.example.com",
        ].sort());
    });

    it("brackets IPv6 the way Next compares an Origin's hostname, and leaves out loopback and link-local", () => {
        const origins = resolveAllowedDevOrigins({ hostPolicy, config: null, env: {}, interfaces });
        expect(origins).toContain("[2001:db8::11]");
        for (const absent of ["127.0.0.1", "[::1]", "::1", "[fe80::1]", "fe80::1"]) expect(origins).not.toContain(absent);
    });

    it("ignores what the backend ignores (an unparseable alias, a wildcard)", () => {
        const origins = resolveAllowedDevOrigins({
            hostPolicy,
            config: { siteUrl: "https://example.com", siteAliases: [{ url: "https://*.example.com" }, { url: "javascript:x" }] },
            env: { WORDJS_DEV_ORIGINS: "*.example.org" },
            interfaces: {},
        });
        expect(origins).toEqual(["example.com"]);
    });
});

describe("without it (a frontend deployed on its own)", () => {
    it("reads the same machine addresses as the backend's own enumeration", () => {
        const fallback = resolveAllowedDevOrigins({ hostPolicy: null, config: null, env: {}, interfaces: VECTORS.ownAddresses.interfaces });
        expect(fallback.sort()).toEqual([...hostPolicy.addressesFromInterfaces(VECTORS.ownAddresses.interfaces)].sort());
    });

    it("adds WORDJS_DEV_ORIGINS hostnames", () => {
        const fallback = resolveAllowedDevOrigins({ hostPolicy: null, config: null, env: { WORDJS_DEV_ORIGINS: " DevBox.lan:3000 , https://x.example.org " }, interfaces: {} });
        expect(fallback).toEqual(["devbox.lan", "x.example.org"]);
    });
});

describe("loadAllowedDevOrigins — the inputs as next dev reads them", () => {
    const frontendDir = path.resolve(import.meta.dirname, "../../..");

    it("beside the backend tree: the backend's view of this machine plus WORDJS_DEV_ORIGINS", () => {
        const origins = loadAllowedDevOrigins(frontendDir, { WORDJS_DEV_ORIGINS: "phone-test.example" });
        expect(origins).toContain("phone-test.example");
        for (const own of hostPolicy.ownAddresses()) expect(origins).toContain(own);
    });

    /** A throwaway checkout: <tmp>/frontend beside <tmp>/backend carrying the real host-policy module. */
    function checkout(files: Record<string, string>, withBackend = true): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "wjs-dev-origins-"));
        fs.mkdirSync(path.join(root, "frontend"));
        if (withBackend) {
            fs.mkdirSync(path.join(root, "backend/src/core"), { recursive: true });
            fs.copyFileSync(path.resolve(frontendDir, "../backend/src/core/host-policy.js"), path.join(root, "backend/src/core/host-policy.js"));
        }
        for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
        return root;
    }

    it("takes the main address and aliases from the site config, the frontend's own copy first", () => {
        const root = checkout({
            "frontend/wordjs-config.json": JSON.stringify({ siteUrl: "https://example.com", siteAliases: [{ url: "https://www.example.com" }] }),
            "backend/wordjs-config.json": JSON.stringify({ siteUrl: "https://stale.example", siteAliases: [{ url: "https://old.example" }] }),
        });
        try {
            const origins = loadAllowedDevOrigins(path.join(root, "frontend"), {});
            expect(origins).toContain("example.com");
            expect(origins).toContain("www.example.com");
            expect(origins).not.toContain("old.example");
            expect(origins).not.toContain("stale.example");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("falls back to the monolith's backend config", () => {
        const root = checkout({ "backend/wordjs-config.json": JSON.stringify({ siteUrl: "http://box.lan:3000" }) });
        try {
            expect(loadAllowedDevOrigins(path.join(root, "frontend"), {})).toContain("box.lan");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("without the backend tree beside it: this machine and WORDJS_DEV_ORIGINS only", () => {
        const root = checkout({ "frontend/wordjs-config.json": JSON.stringify({ siteUrl: "https://example.com" }) }, false);
        try {
            const origins = loadAllowedDevOrigins(path.join(root, "frontend"), { WORDJS_DEV_ORIGINS: "a.example" });
            expect(origins).toContain("a.example");
            expect(origins).not.toContain("example.com");
            for (const own of hostPolicy.ownAddresses()) expect(origins).toContain(own);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
