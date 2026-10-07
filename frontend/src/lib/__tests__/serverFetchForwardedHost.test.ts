/**
 * GATE — a per-user SSR read tells the backend the address the public listener judged, an EMPTY one
 * included (review R3S-6).
 *
 * The gateway forwards `X-Forwarded-Host: ''` for a request that names no address (and, since review
 * R3S-1, also when a local hop relays an empty one), and the monolith removes the header for a direct
 * client that sent no Host. serverFetch's cookie-forwarding branch used to read
 * `X-Forwarded-Host || Host`: the empty value became Next's own Host — the gateway's changeOrigin target,
 * 127.0.0.1:3001 — so the backend judged a loopback address for a request the edge had judged
 * host-less. Present-but-empty, and absent with no Host, now both reach the backend as an empty
 * X-Forwarded-Host: no address, as the edge judged it.
 *
 * MUTATION PROOF: put `inbound.get('x-forwarded-host') || inbound.get('host')` back, or send nothing
 * when the value is empty — the host-less cases below fail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const inbound = new Map<string, string>();
vi.mock("next/headers", () => ({
    headers: async () => ({ get: (name: string) => (inbound.has(name) ? inbound.get(name)! : null) }),
}));

import { serverFetch } from "@/lib/server-api";

/** What the backend received from one per-user read made with these inbound headers. */
async function forwarded(headers: Record<string, string>): Promise<Record<string, string>> {
    inbound.clear();
    for (const [name, value] of Object.entries(headers)) inbound.set(name, value);
    let sent: Record<string, string> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        sent = init.headers;
        return { ok: true, status: 200, json: async () => ({}) };
    }));
    await serverFetch("/auth/me", { forwardCookies: true });
    return sent;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("serverFetch forwards the address the public listener judged", () => {
    it("an empty X-Forwarded-Host from the gateway stays empty: never Next's own Host", async () => {
        const sent = await forwarded({ "x-forwarded-host": "", host: "127.0.0.1:3001", cookie: "wordjs_token=t" });
        expect(sent["x-forwarded-host"]).toBe("");
        expect(sent.cookie).toBe("wordjs_token=t");
    });

    it("a monolith request with no Host at all is sent with an empty X-Forwarded-Host, not with none", async () => {
        const sent = await forwarded({});
        expect(sent["x-forwarded-host"]).toBe("");
    });

    it("an address is forwarded as before: the gateway's pinned value, else the Host the monolith kept", async () => {
        expect((await forwarded({ "x-forwarded-host": "example.com", host: "127.0.0.1:3001", "x-forwarded-proto": "http" })))
            .toMatchObject({ "x-forwarded-host": "example.com", "x-forwarded-proto": "http" });
        expect((await forwarded({ host: "www.example.com" })))
            .toMatchObject({ "x-forwarded-host": "www.example.com", "x-forwarded-proto": "https" });
    });
});
