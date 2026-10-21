import fs from "fs";
import https from "https";
import { readClusterIdentity, type ClusterNodeIdentity, type RequestFn } from "@/lib/revalidateSecret";

/**
 * A frontend node on ANOTHER machine keeps its own copy of the edge wiring in wordjs-config.json:
 * `siteUrl` (the public host it names on SSR reads), `gatewaySsl` and `gatewayPort`, and `internalApiUrl`
 * (where SSR reads go — by default the gateway's own address, written by scripts/node-join.js). Nothing
 * updated that copy: changing the site's main address or the gateway's TLS switch from the panel left the
 * node dialling `https://` into a gateway that now spoke HTTP, and every public page answered 500 until
 * someone edited the file on that machine and restarted it (QA X3-04, X2-15; documentation/separate-mode.md
 * even told the operator to). This keeps it current instead.
 *
 * The gateway is the authority — the backend pushes the address to it, and its workers report the
 * protocol they actually serve — and it answers `GET /edge-info` to a CN=frontend certificate over the same
 * mTLS channel the node registers on. The readers (lib/server-api.ts, lib/api.ts) take the file at every
 * request, so a rewrite here applies to the next render without a restart.
 */

export interface EdgeInfo {
    siteUrl: string | null;
    gatewayPort: number;
    sslEnabled?: boolean;
    /** What the gateway's workers serve: 'https' | 'http' | 'mixed' (reloading) | null (not reported yet). */
    serving: "https" | "http" | "mixed" | null;
}

export type EdgeSync =
    | { status: "not-a-cluster-node" }
    | { status: "unchanged" }
    | { status: "updated"; changes: string[] }
    | { status: "failed"; reason: string };

const TIMEOUT_MS = 5000;

/** An http(s) origin with nothing else, or null. */
function originOf(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
        const u = new URL(value);
        if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
        return u.origin;
    } catch {
        return null;
    }
}

function effectivePort(u: URL): number {
    return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
}

/**
 * The node's config brought in line with what the gateway says, or null when nothing changes. Pure.
 *
 * `internalApiUrl` is rewritten only when it is the gateway's own address — the value node-join derives —
 * never when an operator pointed it somewhere else:
 *  · its host is the configured `gatewayHost` (the gateway dialled directly, the usual case): the scheme
 *    follows what the workers serve and the port follows the gateway's public port;
 *  · its origin is the previous `siteUrl` (enrolment wrote `${siteUrl}/api/v1`): it follows the new address.
 * While the workers are reloading (`serving` mixed or null) the protocol is left as it is.
 */
export function reconcileEdgeConfig(cfg: Record<string, any>, edge: EdgeInfo): { next: Record<string, any>; changes: string[] } | null {
    const next: Record<string, any> = { ...cfg };
    const changes: string[] = [];
    const https = edge.serving === "https" ? true : edge.serving === "http" ? false : null;
    const oldPort = Number(cfg.gatewayPort) || 3000;
    const newPort = Number.isInteger(edge.gatewayPort) && edge.gatewayPort > 0 && edge.gatewayPort < 65536 ? edge.gatewayPort : oldPort;
    const oldSite = originOf(cfg.siteUrl);
    const newSite = originOf(edge.siteUrl);

    if (newPort !== oldPort || (cfg.gatewayPort === undefined && newPort !== 3000)) {
        next.gatewayPort = newPort;
        changes.push(`gatewayPort ${oldPort} → ${newPort}`);
    }
    if (https !== null && !!(cfg.gatewaySsl && cfg.gatewaySsl.enabled) !== https) {
        next.gatewaySsl = { ...(cfg.gatewaySsl || {}), enabled: https };
        changes.push(`gatewaySsl.enabled → ${https}`);
    }
    if (newSite && newSite !== oldSite) {
        next.siteUrl = newSite;
        changes.push(`siteUrl → ${newSite}`);
    }

    if (typeof cfg.internalApiUrl === "string" && cfg.internalApiUrl) {
        let api: URL | null = null;
        try { api = new URL(cfg.internalApiUrl); } catch { api = null; }
        if (api && (api.protocol === "http:" || api.protocol === "https:")) {
            const path = api.pathname.replace(/\/+$/, "") || "/api/v1";
            const gatewayHost = String(cfg.gatewayHost || "").toLowerCase().replace(/^\[|\]$/g, "");
            const apiHost = api.hostname.toLowerCase().replace(/^\[|\]$/g, "");
            let rewritten: string | null = null;
            if (gatewayHost && apiHost === gatewayHost) {
                const u = new URL(api.toString());
                if (https !== null) u.protocol = https ? "https:" : "http:";
                if (effectivePort(api) === oldPort) {
                    const standard = (u.protocol === "http:" && newPort === 80) || (u.protocol === "https:" && newPort === 443);
                    u.port = standard ? "" : String(newPort);
                }
                rewritten = `${u.origin}${path}`;
            } else if (oldSite && newSite && api.origin === oldSite && newSite !== oldSite) {
                rewritten = `${newSite}${path}`;
            }
            if (rewritten && rewritten !== cfg.internalApiUrl.replace(/\/+$/, "")) {
                next.internalApiUrl = rewritten;
                changes.push(`internalApiUrl → ${rewritten}`);
            }
        }
    }

    return changes.length ? { next, changes } : null;
}

/** The mTLS request options for `GET /edge-info` — same channel and strictness as the purge-secret repair. */
export function edgeInfoRequestOptions(id: ClusterNodeIdentity): Record<string, unknown> {
    return {
        protocol: "https:",
        method: "GET",
        hostname: id.gatewayHost,
        port: id.gatewayInternalPort,
        path: "/edge-info",
        timeout: TIMEOUT_MS,
        ca: fs.readFileSync(id.ca),
        key: fs.readFileSync(id.key),
        cert: fs.readFileSync(id.cert),
        rejectUnauthorized: true,
    };
}

function fetchEdgeInfo(id: ClusterNodeIdentity, request: RequestFn): Promise<{ edge: EdgeInfo } | { error: string }> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r: { edge: EdgeInfo } | { error: string }) => { if (!settled) { settled = true; resolve(r); } };
        let options: Record<string, unknown>;
        try {
            options = edgeInfoRequestOptions(id);
        } catch (e) {
            return resolve({ error: `mTLS material unreadable (${(e as Error).message})` });
        }
        try {
            const req = request(options, (res) => {
                let text = "";
                res.setEncoding?.("utf8");
                res.on("data", (c: string | Buffer) => { if (text.length < 8192) text += c; });
                res.on("end", () => {
                    // 404: a gateway from before /edge-info. Nothing to follow, and nothing wrong.
                    if (res.statusCode !== 200) return done({ error: `gateway answered ${res.statusCode}` });
                    try {
                        const body = JSON.parse(text);
                        const serving = body.serving === "https" || body.serving === "http" || body.serving === "mixed" ? body.serving : null;
                        done({ edge: { siteUrl: typeof body.siteUrl === "string" ? body.siteUrl : null, gatewayPort: Number(body.gatewayPort), sslEnabled: body.sslEnabled === true, serving } });
                    } catch {
                        done({ error: "gateway reply was not JSON" });
                    }
                });
            });
            req.on("timeout", () => req.destroy(new Error("timeout")));
            req.on("error", (e: unknown) => done({ error: String((e as Error)?.message || e) }));
            req.end();
        } catch (e) {
            done({ error: String((e as Error)?.message || e) });
        }
    });
}

/** Merge into the node's own config atomically (tmp + rename), re-reading it so no other key is lost. */
function persist(configPath: string, apply: (cfg: Record<string, any>) => Record<string, any> | null): boolean {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const out = apply(cfg);
    if (!out) return false;
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, configPath);
    return true;
}

/**
 * Bring this node's edge wiring up to date with the gateway. Never throws. A node without cluster identity
 * (a monolith, a single-host split, whose frontend reads the backend's config next door) does nothing.
 */
export async function syncEdgeConfig(
    cwd: string = process.cwd(),
    deps: { request?: RequestFn; log?: (message: string) => void } = {},
): Promise<EdgeSync> {
    const log = deps.log || ((m: string) => console.log(m));
    const request = deps.request || (https.request as unknown as RequestFn);

    const id = readClusterIdentity(cwd);
    if (!id) return { status: "not-a-cluster-node" };

    const out = await fetchEdgeInfo(id, request);
    if ("error" in out) return { status: "failed", reason: out.error };

    try {
        let changes: string[] = [];
        const written = persist(id.configPath, (cfg) => {
            const r = reconcileEdgeConfig(cfg, out.edge);
            if (!r) return null;
            changes = r.changes;
            return { ...r.next, updatedAt: new Date().toISOString() };
        });
        if (!written) return { status: "unchanged" };
        log(`[Edge] followed the gateway: ${changes.join(", ")}`);
        return { status: "updated", changes };
    } catch (e) {
        return { status: "failed", reason: String((e as Error)?.message || e) };
    }
}
