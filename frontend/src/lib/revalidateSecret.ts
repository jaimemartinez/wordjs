import fs from "fs";
import path from "path";
import https from "https";

/**
 * The shared secret that authenticates on-demand cache purges (see app/api/revalidate/route.ts).
 *
 * Discovery order — LOCAL config first, backend config second:
 *  1. `<cwd>/wordjs-config.json` — this frontend node's own config. In separate mode it is the ONLY
 *     one that exists: enrollment (scripts/node-join.js) writes the gateway-minted `revalidateSecret`
 *     here, on this machine.
 *  2. `<cwd>/../backend/wordjs-config.json` — a monolith or a single-host split, where the backend's
 *     config file sits next to us on a shared disk and owns the secret.
 *
 * The fallback is per-KEY, not per-FILE, and that is the whole point: a cluster frontend HAS a local
 * config (ports, gateway wiring, mTLS paths), so a file-level "local exists → stop" check found it,
 * saw no `revalidateSecret` in it, and gave up — the route then answered 503 and every cross-machine
 * purge failed even once the backend could deliver one. A local config without the key is not an
 * answer; keep looking.
 *
 * Returns null when no source has it, and the caller must fail CLOSED (503) — never open access.
 */
export function resolveRevalidateSecret(cwd: string = process.cwd()): string | null {
    const candidates = [
        path.resolve(cwd, "wordjs-config.json"),
        path.resolve(cwd, "../backend/wordjs-config.json"),
    ];
    for (const configPath of candidates) {
        try {
            if (!fs.existsSync(configPath)) continue;
            const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            if (cfg && cfg.revalidateSecret) return String(cfg.revalidateSecret);
        } catch {
            // Unreadable or malformed — try the next source rather than failing the whole lookup.
        }
    }
    return null;
}

// =================================================================================================
// SELF-REPAIR: a cluster node that has the identity but not the secret
// =================================================================================================

/**
 * The gateway mints `revalidateSecret` and hands it out at enrollment. That leaves exactly one
 * deployment permanently and silently broken: a cluster whose frontend enrolled BEFORE the secret
 * existed. It has every other piece of cluster identity — certificates, gateway wiring — but no
 * secret, so every purge the gateway delivers is refused with 403 (logged on both sides) and the site
 * falls back to TTL freshness FOREVER. The only documented cure was for an operator to remember to
 * re-enroll the node.
 *
 * A node that already holds a `CN=frontend` cluster certificate can just ask. It uses the same mTLS
 * channel it uses to register, and the certificate is the authorization — precisely as `CN=backend`
 * is the authorization to REQUEST a purge in the first place (gateway/src/purge.js).
 *
 * The whole path fails toward the safe side: if anything is missing, unreachable or malformed the
 * node keeps behaving exactly as it does today (secretless ⇒ 503 ⇒ TTL freshness) and says so.
 */

/** Everything needed to reach the gateway's internal mTLS listener as this node. */
export interface ClusterNodeIdentity {
    gatewayHost: string;
    gatewayInternalPort: number;
    ca: string;
    key: string;
    cert: string;
    /** The node's OWN config file — where a recovered secret is written back. */
    configPath: string;
}

export type SecretRecovery =
    | { status: "already-configured" }
    | { status: "not-a-cluster-node" }
    | { status: "recovered"; secret: string }
    | { status: "failed"; reason: string };

/** Minimal shape of `https.request`, injectable so tests can drive the real logic over plain HTTP. */
export type RequestFn = (options: object, callback: (res: NodeJS.ReadableStream & { statusCode?: number }) => void) => {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    end(): unknown;
    destroy(error?: Error): unknown;
};

const RECOVERY_TIMEOUT_MS = 5000;
// The gateway mints 32 random bytes as hex. Accept any printable, whitespace-free token of sane
// length — enough to refuse an HTML error page or a truncated body, without pinning the format.
const PLAUSIBLE_SECRET = /^[\x21-\x7e]{16,512}$/;

/**
 * Does this node have CLUSTER IDENTITY? Deliberately the same predicate the backend uses to decide a
 * purge must go through the gateway (backend/src/core/frontend-purge.ts `purgeTransport`): an
 * `advertiseHost`, a `gatewayHost`, and mTLS material that is actually present on disk. The two must
 * agree, or one side would route through the gateway while the other did not believe it was in a
 * cluster at all.
 */
export function readClusterIdentity(
    cwd: string = process.cwd(),
    exists: (p: string) => boolean = fs.existsSync,
): ClusterNodeIdentity | null {
    const configPath = path.resolve(cwd, "wordjs-config.json");
    try {
        if (!exists(configPath)) return null;
        const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const mtls = cfg && cfg.mtls;
        if (!cfg || !cfg.advertiseHost || !cfg.gatewayHost || !mtls || !mtls.ca || !mtls.key || !mtls.cert) return null;
        const ca = path.resolve(cwd, String(mtls.ca));
        const key = path.resolve(cwd, String(mtls.key));
        const cert = path.resolve(cwd, String(mtls.cert));
        if (!exists(ca) || !exists(key) || !exists(cert)) return null;
        return {
            gatewayHost: String(cfg.gatewayHost),
            gatewayInternalPort: Number(cfg.gatewayInternalPort) || 3100,
            ca, key, cert, configPath,
        };
    } catch {
        return null;
    }
}

/**
 * The mTLS request options for `GET /revalidate-secret`.
 *
 * Identical in shape and strictness to the backend's own gateway leg (`gatewayPurgeOptions`): the
 * cluster CA verifies the gateway, this node's `CN=frontend` certificate proves who is asking, and
 * `rejectUnauthorized` stays TRUE — the gateway's internal cert carries the advertise host in its
 * SANs, so ordinary hostname verification is enough and nothing has to be relaxed.
 *
 * Exported so a test can assert the material really comes from the configured mTLS paths.
 */
export function clusterSecretRequestOptions(id: ClusterNodeIdentity): Record<string, unknown> {
    return {
        protocol: "https:",
        method: "GET",
        hostname: id.gatewayHost,
        port: id.gatewayInternalPort,
        path: "/revalidate-secret",
        timeout: RECOVERY_TIMEOUT_MS,
        ca: fs.readFileSync(id.ca),
        key: fs.readFileSync(id.key),
        cert: fs.readFileSync(id.cert),
        rejectUnauthorized: true,
    };
}

/**
 * Merge the secret into the node's own config, atomically (tmp + rename) — a torn write here would
 * take out the gateway wiring and the mTLS paths along with it. Every other key is preserved.
 */
function persistRevalidateSecret(configPath: string, secret: string): void {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    cfg.revalidateSecret = secret;
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, configPath);
}

/**
 * Fetch the secret from the gateway. Resolves — never rejects — so the caller degrades instead of
 * throwing on a boot path.
 */
function fetchClusterSecret(id: ClusterNodeIdentity, request: RequestFn): Promise<{ secret: string } | { error: string }> {
    return new Promise((resolve) => {
        let options: Record<string, unknown>;
        try {
            options = clusterSecretRequestOptions(id);
        } catch (e) {
            return resolve({ error: `mTLS material unreadable (${(e as Error).message})` });
        }
        let settled = false;
        const done = (r: { secret: string } | { error: string }) => { if (!settled) { settled = true; resolve(r); } };
        try {
            const req = request(options, (res) => {
                let text = "";
                res.setEncoding?.("utf8");
                res.on("data", (c: string | Buffer) => { if (text.length < 4096) text += c; });
                res.on("end", () => {
                    if (res.statusCode !== 200) return done({ error: `gateway answered ${res.statusCode}` });
                    try {
                        const secret = String(JSON.parse(text).revalidateSecret || "");
                        if (!PLAUSIBLE_SECRET.test(secret)) return done({ error: "gateway returned no usable secret" });
                        done({ secret });
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

/**
 * Bring this node's `revalidateSecret` up to date if it can, and say what happened either way.
 *
 * Order matters: an EXISTING secret is never overwritten (that would let a reachable-but-wrong
 * gateway rewrite working config), and a node with no cluster identity never touches the network or
 * the disk — that is the monolith / single-host split, where the secret legitimately lives in the
 * backend's config next door.
 */
export async function recoverRevalidateSecret(
    cwd: string = process.cwd(),
    deps: { request?: RequestFn; log?: (message: string) => void } = {},
): Promise<SecretRecovery> {
    const log = deps.log || ((m: string) => console.warn(m));
    const request = deps.request || (https.request as unknown as RequestFn);

    if (resolveRevalidateSecret(cwd)) return { status: "already-configured" };

    const id = readClusterIdentity(cwd);
    if (!id) return { status: "not-a-cluster-node" };

    const out = await fetchClusterSecret(id, request);
    if ("error" in out) {
        log(`[Purge] this node has cluster identity but no revalidateSecret, and the gateway at ${id.gatewayHost}:${id.gatewayInternalPort} could not supply one: ${out.error} — cache purges will be REFUSED (403) and content stays TTL-fresh`);
        return { status: "failed", reason: out.error };
    }
    try {
        persistRevalidateSecret(id.configPath, out.secret);
    } catch (e) {
        log(`[Purge] recovered the revalidateSecret from the gateway but could not write it to ${id.configPath}: ${(e as Error).message} — cache purges stay refused until this is fixed`);
        return { status: "failed", reason: "persist failed" };
    }
    log(`[Purge] recovered the missing revalidateSecret from the gateway over mTLS and wrote it to ${id.configPath} — cross-machine cache purges are active`);
    return { status: "recovered", secret: out.secret };
}
