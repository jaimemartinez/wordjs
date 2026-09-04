# WordJS Gateway Documentation

The **WordJS Gateway** (`gateway/src/index.js`) is an enterprise-grade entry point for the application. It acts as a high-availability reverse proxy, service registry, and health monitor. It is started by `node gateway/src/index.js` (the root `npm start`/`npm run dev` launch it alongside the backend and frontend via `concurrently`).

> **The gateway runs only in SPLIT mode.** WordJS can run two mutually-exclusive ways from the same codebase (same `backend/wordjs-config.json`, database, uploads/themes/plugins, secrets, and public origin `https://localhost:3000` — no migration to switch). **SPLIT** (default, 3 processes: this gateway on `:3000` + backend `:4000` + frontend `:3001`; root `npm run dev` / `npm start`) gives clustering, health checks, load balancing, the mTLS internal channel, and SSE-aware proxying. **MONOLITH** (1 process, 1 port `:3000`, via the repo-root `monolith.js`; root `npm run dev:mono` / `npm run build:mono` / `npm run start:mono`) has **no separate gateway process** — it mounts the backend Express app (whose isolated plugins each run in a separate OS process via `child_process.fork`) and the Next.js request handler in-process, with no loopback proxy, no Node `cluster`, and no gateway `/register`. The gateway's still-needed cross-cutting concerns are re-implemented as local middleware in `monolith.js`: TLS (one HTTPS port reusing the gateway's certificate, with HTTP fallback), Helmet security headers, compression (skipping SSE), SEO rewrites (`/sitemap.xml` → `/api/v1/seo/sitemap.xml`, `/robots.txt` → `.../robots.txt`, `/feed` | `/feed.xml` | `/rss.xml` → `.../feed.xml`), and `X-Forwarded-Host` pinning for CSRF. A loopback-only HTTP listener serves the frontend's SSR API calls. Plugins stay isolated exactly as in split mode. Choose **MONOLITH** for the simplest single-artifact deploy (one VM/container, TLS via its built-in HTTPS or a single front-line reverse proxy); choose **SPLIT** to scale services independently and for the gateway's clustering / health checks / load balancing.
>
> *Internals:* backend `src/index.ts` skips its self-listen and gateway self-register when embedded (`process.env.WORDJS_EMBEDDED='1'`, set by `monolith.js`) and instead exposes `initialize()`; `monolith.js` also sets `WORDJS_MODE='mono'`.

## Key Features

*   **🚀 Cluster Mode:** High-availability multiprocess architecture using Node.js `cluster`. The primary spawns one worker per CPU core, capped at **4 in development** (`nodeEnv === 'development'`) and **16 otherwise**; a worker that dies is automatically respawned.
*   **🛡️ Resiliency (Circuit Breaker):** 
    *   **Health Checks:** The primary polls each registered target's `/health` every **30s** (5s per-probe timeout). Probes run concurrently and a given target URL is fetched only once per sweep even if shared across routes; a 4xx response still counts as "alive".
    *   **Auto-Eviction:** A target is marked `Failing` on error and ejected after **3 consecutive failures**; the **route itself stays**, empty. Deleting it is what used to let a restarting backend's `/api` fall through to the frontend's `/` catch-all, so an emptied group now resolves to "no target" (the caller degrades to the loopback bootstrap or a 502) and only a re-registration may change who owns a route. Per-target health status (`Healthy`/`Failing`) is persisted to the registry file and broadcast to workers so they stop selecting failing upstreams.
*   **🔌 Intelligent Load Balancing:** Round-robin distribution across multiple instances of the same service. A route whose targets all become unhealthy resolves to no target rather than leaking to another role's group, and health metrics are persisted in the registry file so reloaded workers keep avoiding failing upstreams.
*   **🌪️ Log Rotation:** Structured JSON logging via **Winston** with daily file rotation (`logs/gateway-*.log`).
*   **🔒 Security & Protection:**
    *   **Helmet:** Secure HTTP headers out of the box.
    *   **Timeout Guard:** Hard 60s cutoffs for HTTP requests (1 Hour for SSE) — applied as both `timeout` and `proxyTimeout` on the proxied request — to prevent socket leakage. SSE is detected when the `Accept` header *contains* `text/event-stream` (not exact-match), so streaming responses are never wrongly compressed or timed out. The proxy error handler is socket-aware and won't crash on WebSocket upgrade errors.
    *   **Authenticated status page:** A minimal `/gateway-status` liveness page behind the secret (see Monitoring).
    *   **Liveness probe:** `/healthz` is answered by the gateway worker itself (returns `{ status, role: 'gateway', pid, timestamp }`), independent of any backend. `/readyz` is intentionally **not** handled at the edge so it proxies through to the backend's deep readiness check.
    *   **mTLS Upstream Verification:** Internal calls to backend/frontend use a mutual-TLS agent with `rejectUnauthorized: true`. The upstream certificate must chain to the cluster CA **and** present an allowed internal CN (`backend`, `frontend`, `gateway`, `gateway-internal`). This adds MITM protection without requiring IP SANs in the internal certs.
*   **📡 Modern Connectivity:** WebSocket proxying support for bidirectional communication.

## Configuration

The gateway loads configuration from **`gateway/gateway-config.json`** (its own config file, separate from the backend's `wordjs-config.json`). The setup orchestrator (`setup/index.js`) writes the matching secret/ports into both.

*   **Port:** Public port defaults to `3000` (`gatewayPort`).
*   **Internal port:** The private mTLS control server listens on `gatewayInternalPort` (default = public port **+ 100**, i.e. `3100`). As a defense-in-depth layer on top of the mTLS+CN gating, it binds **`127.0.0.1` by default** (`gatewayInternalBind`) so the cert-upload / config-update / worker-restart control plane is not exposed on every interface; multi-node (SEPARATE) deploys may set `gatewayInternalBind` to a specific advertise interface, but it **never** defaults to `0.0.0.0`.
*   **Enroll port:** For **SEPARATE** (multi-machine) mode the gateway also runs a **token-enrollment** listener on `gatewayEnrollPort` (default = `gatewayInternalPort` **+ 1**, i.e. `3101`) — a **separate** HTTPS listener that does **not** request a client cert (a brand-new node has none). It binds the same `gatewayInternalBind` interface as the internal server (default `127.0.0.1`, so a multi-machine gateway must set it — `cluster.js init` does). It bootstraps a node's mTLS identity from a single-use join token; the strict mTLS `/register` server above is unchanged. See **Service Registration** and **[separate-mode.md](separate-mode.md)**.
*   **Secret:** `gatewaySecret` authenticates the public `/gateway-status` dashboard. It is read **header-only** from `X-Gateway-Secret` (never the query string, which leaks via access logs / Referer / history) and compared in constant time. If no secret is configured, the gateway warns loudly at startup and falls back to a **PUBLIC default** (`secure-your-gateway-secret`); while that default is in effect the management endpoints return **503** ("Gateway management disabled") rather than accepting it, so it must be replaced before production.
*   **SSL:** Optional `ssl` block (`{ enabled, key, cert }`); if `ssl` is on but no key/cert is supplied, the gateway auto-generates a self-signed cert (`ssl-auto.crt` / `ssl-auto.key`). Gateway private keys are written **owner-only** (mode `0600`, with a best-effort `chmod` that is a no-op on Windows): both the auto-generated `ssl-auto.key` and the imported `ssl/live/imported/privkey.pem` from `/cert-upload` (whose dir is created mode `0700`).
*   **mTLS:** The internal cluster certificates are read from fixed filenames — `cluster-ca.crt`, `gateway-internal.key`, and `gateway-internal.crt` — in `gateway/certs/`, falling back to `backend/certs/` when `gateway/certs/gateway-internal.crt` is absent (the single-host install writes the cluster certs to `backend/certs/`; only `cluster.js init` populates `gateway/certs/`). The directory is resolved **once at boot**. They are not configured via a config block; while the three files are missing the primary does not start the internal mTLS control server — it **polls for them every 3 s and starts the control plane as soon as they appear** (giving up after 30 min), which is what lets a never-installed split instance issue its certs through the wizard and then form the cluster without a manual restart. Workers that boot without the certs have no mTLS agent, so upstream calls go out over plain HTTP. On a **single host** the certs are generated by the setup orchestrator (`setup/index.js`); for **SEPARATE** (multi-machine) mode they are minted by `node scripts/cluster.js init`, which additionally writes `cluster-ca.key` (kept `0600` on the gateway — it is the cluster CA the enroll listener signs node certs with).
*   **ACME HTTP-01 (optional, default OFF):** Setting `acme.http01Port` (e.g. `80`) — in `gateway-config.json`, or, as the source of truth used by the admin UI, in `backend/wordjs-config.json` — makes the **primary** bind one plain-HTTP listener that serves Let's Encrypt challenge tokens from the backend webroot (`acme.webroot`, default `backend/public`) and 301-redirects everything else to HTTPS. Read once at boot, so changing it needs a gateway restart.
*   **Env Vars:** The Gateway loads `.env` via `dotenv`, but operational config (secret, ports, ssl, mtls, acme) lives in the JSON file.

## Proxy Module

The proxy and upstream-agent construction live in `gateway/src/proxy-config.js`, imported by both the gateway and its tests:

*   **`createProxyServer()`** — builds the `http-proxy` server with `{ xfwd: true, changeOrigin: true }`. With `changeOrigin`, the upstream receives the target's Host, while the gateway pins the **original client Host** into `X-Forwarded-Host`. The backend's CSRF check reads `X-Forwarded-Host` and requires an **exact origin match** against the configured site URL.
*   **`createUpstreamAgent({ ca, key, cert })`** — builds the mTLS agent described under Security. Both the worker proxy agent and the primary health-check agent use it, so no internal call uses `rejectUnauthorized: false`.

### SEO Rewrites

The SPLIT-mode gateway worker maps root-level SEO paths onto the backend's `/api/v1/seo/*` endpoints before proxying: `/sitemap.xml` → `/api/v1/seo/sitemap.xml`, `/robots.txt` → `/api/v1/seo/robots.txt`, and `/feed` | `/feed.xml` | `/rss.xml` → `/api/v1/seo/feed.xml`. (MONOLITH re-implements all three rewrites — sitemap, robots, and feed — as local middleware in `monolith.js`.)

## Service Registration

Services register themselves dynamically on startup over the **internal mTLS control server** (not a public route). The endpoint is mutual-TLS only and gated by the client-certificate CN allow-list:

**Endpoint:** `POST /register` (on `gatewayInternalPort`, default `3100`), requires a client cert with CN `backend` or `frontend`.
**Body:** `{ "name": "service-name", "url": "http://...", "routes": ["/prefix"] }`

mTLS proves *who* the peer is; four further checks constrain *what* it may claim, and a registration failing any of them is refused (400/403) rather than applied:

*   **At least one route** — a routes-less registration would only ever evict, so it is rejected as an eviction primitive.
*   **Routes must belong to the CN's role.** `backend` may claim `/api`, `/uploads`, `/themes`, `/plugins`, `/public`, `/.well-known`, `/healthz`, `/readyz`, `/metrics`; `frontend` may claim `/`, `/admin`, `/login`, `/install`, `/migration`, `/portal`, `/_next`. (Without this a compromised `frontend` could register `/api/v1/auth` and win the longest-prefix match for every login.)
*   **The target URL's host must be covered by the peer's own certificate** (a SAN entry, its CN, or loopback), so a peer cannot point a route at another box.
*   **Ownership** — a target URL may only be (re)registered by the identity that first registered it. Owners are persisted in the registry file, so this survives a primary restart.

A companion `GET /info` (CN `backend`) returns gateway port, SSL status, site URL, and active-certificate metadata (CN, issuer, validity, fingerprint, serial, and a detected type of `self-signed` / `custom` / `letsencrypt`). Two further mTLS-only endpoints, both CN `backend`, let the backend admin UI manage TLS at runtime: `POST /cert-upload` (writes `key`/`cert` to `ssl/live/imported/` — the dir created mode `0700` and the private key mode `0600`, best-effort on Windows — updates `gateway-config.json`, and restarts workers) and `POST /config-update` (updates `gatewayPort` / `ssl.enabled` / `siteUrl`, persists the config, and restarts workers). Because all of these are mTLS-only, an attacker on the public port cannot inject rogue upstreams or change config.

A fourth mTLS-only endpoint, `POST /purge` (CN `backend`), delivers **cross-machine cache purges**. The backend sends `{ tags, paths }` and the gateway fans one `POST /api/revalidate` out to **every** frontend target in its registry (deduplicated across route prefixes — the same node registers `/`, `/admin`, `/_next`, …), presenting the cluster's `revalidateSecret`. This exists because a backend on another machine cannot reach the frontends itself: its `frontendUrl` is the gateway's public origin, whose `/api` prefix routes straight back to the backend, and a cluster may run N frontend replicas — the registry here is the only authority on where they are. The request can **only invalidate** caches, never inject content, the payload is re-sanitized gateway-side (≤100 tags/paths, ≤200 chars each), and delivery is best-effort: the response reports `{ targets, delivered, failed }` and an unreachable replica just keeps serving TTL-fresh content (logged as `[Gateway] [Purge] …`). See **[separate-mode.md](separate-mode.md)**.

### Bootstrapping trust for a remote node (SEPARATE mode)

A brand-new backend/frontend on **another machine** has no client cert yet, so it cannot use the strict mTLS `/register` path above. It first enrolls over the **token-enrollment listener** (`startEnrollServer()`, on `gatewayEnrollPort`, default `3101`; a separate HTTPS server that does **not** request a client cert):

**Endpoint:** `POST /enroll` with body `{ "role": "backend"|"frontend", "token": "<join-token>", "advertiseHost": "<node-ip>", "csr": "<PEM CSR>" }`.

The gateway consumes the **single-use, role-bound, TTL** token (minted by `node scripts/cluster.js token <role>`), **forces `CN=<role>`** from the token (the CSR subject is ignored so a node cannot request a different identity), signs the cert against the cluster CA, and returns `{ cert, ca, config }` where `config` carries the shared `gatewaySecret`, `gatewayPort`, `gatewayInternalPort`, `siteUrl`, and `revalidateSecret` (the cache-purge secret — it travels here precisely so a frontend node can authenticate purges from its **own** config instead of a backend config file on a disk it does not share; the gateway mints it in `cluster.js init`, or lazily on first enrollment for clusters created before it existed). The issued cert's **SAN is not attacker-controlled**: if the token pinned a host (`cluster.js token <role> --host <ip>`) the request's `advertiseHost` must equal it; if the token pinned none, the only accepted `advertiseHost` is the address the node is connecting *from*. The node writes the cert + CA and thereafter uses the strict mTLS `/register` path like any co-located node. A modest rate limit (30/min) caps token brute-force, and `GET /enroll/health` answers `{ ok: true, role: 'gateway-enroll' }` so you can confirm the listener is reachable. Run `node scripts/node-join.js` on the node to drive this end to end — see **[separate-mode.md](separate-mode.md)**.

### Pre-install bootstrap route (SPLIT, one host)

On a box that has never been set up there is no cluster identity, so neither service can register and the registry is empty — which would 404 the very install wizard needed to issue those certificates. To break that deadlock, a request whose path matches no registered route falls back to `127.0.0.1` on **this** host: `config.backendPort` (default `4000`) for the backend's own prefixes (`/api`, `/uploads`, `/themes`, `/plugins`, `/public`, `/.well-known`, `/readyz`, `/metrics`) and `config.frontendPort` (default `3001`) for everything else. It classifies with the same `routing.js` map the proxy uses rather than a second hand-kept list, so `/api/revalidate` — a Next App Router route — still goes to the frontend. (`/healthz` never reaches it — the worker answers that one itself.) The fallback engages **only while the service owning that route has never registered**, so on a healthy cluster — including a separate-mode gateway whose peers are on other machines — an unknown path still 404s. Whether each peer is dialled over HTTPS or plain HTTP is decided once at gateway startup from whether its identity cert is on disk, and flipped automatically on the first connection-level protocol mismatch.

## Monitoring

Access the authenticated status page at `/gateway-status` (e.g. `https://localhost:3000/gateway-status`) — a minimal liveness page behind the secret, not a metrics dashboard. The secret must be sent in the **`X-Gateway-Secret`** request header — it is no longer accepted as a `?secret=` query parameter:

```bash
curl -k -H "X-Gateway-Secret: <YOUR_SECRET>" https://localhost:3000/gateway-status
```

The gateway worker also serves `/healthz` (unauthenticated liveness) as described under Security.

## Architecture
The Primary process manages the global registry, health checks, atomic persistence (`gateway/gateway-registry.json`), the internal mTLS control server, and (when a cluster CA is present) the token-enrollment listener, while Worker processes (one per CPU core) handle the heavy lifting of proxying and WebSocket upgrades.

> **SEPARATE mode:** the gateway is the same process; it just proxies to backend/frontend on **other machines** whose mTLS identities were bootstrapped via join-token enrollment. The gateway is the cluster CA (`node scripts/cluster.js init`) and the single owner of the registry + certs. See **[separate-mode.md](separate-mode.md)** for the end-to-end walkthrough.

> **Known follow-up:** the gateway's Helmet config now sets a Content-Security-Policy (`gateway/src/security-headers.js`), but still a permissive one: it mirrors the backend's policy shape, so `script-src` keeps `'unsafe-inline'` (for the Next bootstrap) and `img-src`/`connect-src` stay open. It departs from the mirror in one place on purpose — **`'unsafe-eval'` was removed** (the retired Puck editor was its only reason; `gateway/test/security-headers.test.js` pins the absence). It also governs only the responses the gateway generates itself (error pages, `/gateway-status`, the pre-install bootstrap) — a proxied upstream writes its headers last, so its own CSP wins. Tightening it is the remaining hardening item. Operators must also set a strong `gatewaySecret` and provide real cluster/mTLS certificates before production.

## Testing

`npm test` runs `node --test test/*.test.js` over the whole `gateway/test/` suite. The proxy/mTLS integration test in it is `gateway/test/proxy.integration.test.js` (using `node:test`); it covers Host forwarding (`changeOrigin` rewrite + `X-Forwarded-Host` preservation), mTLS accept with the correct CA, MITM reject with a rogue CA, and wrong-CN reject. Run it from the gateway directory:

```bash
cd gateway
npm test
```

`node-forge` is a gateway **dependency** (not dev-only): it is used at boot by `gateway/src/cluster-ca.js` to mint the cluster CA and sign join-token enrollment certs, and by this integration test to generate test certificates.
