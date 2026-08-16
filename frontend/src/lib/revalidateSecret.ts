import fs from "fs";
import path from "path";

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
