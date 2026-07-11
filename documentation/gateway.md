# WordJS Gateway Documentation

The **WordJS Gateway** (`gateway/src/index.js`) is an enterprise-grade entry point for the application. It acts as a high-availability reverse proxy, service registry, and health monitor. It is started by `node gateway/src/index.js` (the root `npm start`/`npm run dev` launch it alongside the backend and frontend via `concurrently`).

> **The gateway runs only in SPLIT mode.** WordJS can run two mutually-exclusive ways from the same codebase (same `backend/wordjs-config.json`, database, uploads/themes/plugins, secrets, and public origin `https://localhost:3000` — no migration to switch). **SPLIT** (default, 3 processes: this gateway on `:3000` + backend `:4000` + frontend `:3001`; root `npm run dev` / `npm start`) gives clustering, health checks, load balancing, the mTLS internal channel, and SSE-aware proxying. **MONOLITH** (1 process, 1 port `:3000`, via the repo-root `monolith.js`; root `npm run dev:mono` / `npm run build:mono` / `npm run start:mono`) has **no separate gateway process** — it mounts the backend Express app (whose isolated plugins each run in a separate OS process via `child_process.fork`) and the Next.js request handler in-process, with no loopback proxy, no Node `cluster`, and no gateway `/register`. The gateway's still-needed cross-cutting concerns are re-implemented as local middleware in `monolith.js`: TLS (one HTTPS port reusing the gateway's certificate, with HTTP fallback), Helmet security headers, compression (skipping SSE), SEO rewrites (`/sitemap.xml` → `/api/v1/seo/sitemap.xml`, `/robots.txt` → `.../robots.txt`), and `X-Forwarded-Host` pinning for CSRF. A loopback-only HTTP listener serves the frontend's SSR API calls. Plugins stay isolated exactly as in split mode. Choose **MONOLITH** for the simplest single-artifact deploy (one VM/container, TLS via its built-in HTTPS or a single front-line reverse proxy); choose **SPLIT** to scale services independently and for the gateway's clustering / health checks / load balancing.
>
> *Internals:* backend `src/index.ts` skips its self-listen and gateway self-register when embedded (`process.env.WORDJS_EMBEDDED='1'`, set by `monolith.js`) and instead exposes `initialize()`; `monolith.js` also sets `WORDJS_MODE='mono'`.

## Key Features

*   **🚀 Cluster Mode:** High-availability multiprocess architecture using Node.js `cluster`. The primary spawns one worker per CPU core, capped at **4 in development** (`nodeEnv === 'development'`) and **16 otherwise**; a worker that dies is automatically respawned.
*   **🛡️ Resiliency (Circuit Breaker):** 
    *   **Health Checks:** The primary polls each registered target's `/health` every **30s** (5s per-probe timeout). Probes run concurrently and a given target URL is fetched only once per sweep even if shared across routes; a 4xx response still counts as "alive".
    *   **Auto-Eviction:** A target is marked `Failing` on error and ejected after **3 consecutive failures**; if a route's last target is evicted, the route itself is removed (no empty target group). Per-target health status (`Healthy`/`Failing`) is persisted to the registry file and broadcast to workers so they stop selecting failing upstreams.
*   **🔌 Intelligent Load Balancing:** Round-robin distribution across multiple instances of the same service. A route whose targets all become unhealthy is removed cleanly (no crash on an empty target group), and health metrics are persisted in the registry file so reloaded workers keep avoiding failing upstreams.
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
*   **Internal port:** The private mTLS control server listens on `gatewayInternalPort` (default = public port **+ 100**, i.e. `3100`). As a defense-in-depth layer on top of the mTLS+CN gating, it binds **`127.0.0.1` by default** (`gatewayInternalBind`) so the cert-upload / config-update / worker-restart control plane is not exposed on every interface; multi-node deploys may set `gatewayInternalBind` to a specific advertise interface, but it **never** defaults to `0.0.0.0`.
*   **Secret:** `gatewaySecret` authenticates the public `/gateway-status` dashboard. It is read **header-only** from `X-Gateway-Secret` (never the query string, which leaks via access logs / Referer / history) and compared in constant time. If no secret is configured, the gateway warns loudly at startup and falls back to a **PUBLIC default** (`secure-your-gateway-secret`); while that default is in effect the management endpoints return **503** ("Gateway management disabled") rather than accepting it, so it must be replaced before production.
*   **SSL:** Optional `ssl` block (`{ enabled, key, cert }`); if `ssl` is on but no key/cert is supplied, the gateway auto-generates a self-signed cert (`ssl-auto.crt` / `ssl-auto.key`). Gateway private keys are written **owner-only** (mode `0600`, with a best-effort `chmod` that is a no-op on Windows): both the auto-generated `ssl-auto.key` and the imported `ssl/live/imported/privkey.pem` from `/cert-upload` (whose dir is created mode `0700`).
*   **mTLS:** The internal cluster certificates are read from fixed files under `gateway/certs/` — `cluster-ca.crt`, `gateway-internal.key`, and `gateway-internal.crt`. They are not configured via a config block; if any of the three is missing the internal mTLS control server does not start and upstream calls fall back to plain HTTP.
*   **ACME HTTP-01 (optional, default OFF):** Setting `acme.http01Port` (e.g. `80`) — in `gateway-config.json`, or, as the source of truth used by the admin UI, in `backend/wordjs-config.json` — makes the **primary** bind one plain-HTTP listener that serves Let's Encrypt challenge tokens from the backend webroot (`acme.webroot`, default `backend/public`) and 301-redirects everything else to HTTPS. Read once at boot, so changing it needs a gateway restart.
*   **Env Vars:** The Gateway loads `.env` via `dotenv`, but operational config (secret, ports, ssl, mtls, acme) lives in the JSON file.

## Proxy Module

The proxy and upstream-agent construction live in `gateway/src/proxy-config.js`, imported by both the gateway and its tests:

*   **`createProxyServer()`** — builds the `http-proxy` server with `{ xfwd: true, changeOrigin: true }`. With `changeOrigin`, the upstream receives the target's Host, while the gateway pins the **original client Host** into `X-Forwarded-Host`. The backend's CSRF check reads `X-Forwarded-Host` and requires an **exact origin match** against the configured site URL.
*   **`createUpstreamAgent({ ca, key, cert })`** — builds the mTLS agent described under Security. Both the worker proxy agent and the primary health-check agent use it, so no internal call uses `rejectUnauthorized: false`.

## Service Registration

Services register themselves dynamically on startup over the **internal mTLS control server** (not a public route). The endpoint is mutual-TLS only and gated by the client-certificate CN allow-list:

**Endpoint:** `POST /register` (on `gatewayInternalPort`, default `3100`), requires a client cert with CN `backend` or `frontend`.
**Body:** `{ "name": "service-name", "url": "http://...", "routes": ["/prefix"] }`

A companion `GET /info` (CN `backend`) returns gateway port, SSL status, site URL, and active-certificate metadata (CN, issuer, validity, fingerprint, serial, and a detected type of `self-signed` / `custom` / `letsencrypt`). Two further mTLS-only endpoints, both CN `backend`, let the backend admin UI manage TLS at runtime: `POST /cert-upload` (writes `key`/`cert` to `ssl/live/imported/` — the dir created mode `0700` and the private key mode `0600`, best-effort on Windows — updates `gateway-config.json`, and restarts workers) and `POST /config-update` (updates `gatewayPort` / `ssl.enabled` / `siteUrl`, persists the config, and restarts workers). Because all of these are mTLS-only, an attacker on the public port cannot inject rogue upstreams or change config.

## Monitoring

Access the authenticated status page at `/gateway-status` (e.g. `https://localhost:3000/gateway-status`) — a minimal liveness page behind the secret, not a metrics dashboard. The secret must be sent in the **`X-Gateway-Secret`** request header — it is no longer accepted as a `?secret=` query parameter:

```bash
curl -k -H "X-Gateway-Secret: <YOUR_SECRET>" https://localhost:3000/gateway-status
```

The gateway worker also serves `/healthz` (unauthenticated liveness) as described under Security.

## Architecture
The Primary process manages the global registry, health checks, atomic persistence (`gateway/gateway-registry.json`), and the internal mTLS control server, while Worker processes (one per CPU core) handle the heavy lifting of proxying and WebSocket upgrades.

> **Known follow-up:** a strict Content-Security-Policy is currently **disabled** in the gateway's Helmet config and is a documented hardening item. Operators must also set a strong `gatewaySecret` and provide real cluster/mTLS certificates before production.

## Testing

An integration test lives at `gateway/test/proxy.integration.test.js` (using `node:test`). It covers Host forwarding (`changeOrigin` rewrite + `X-Forwarded-Host` preservation), mTLS accept with the correct CA, MITM reject with a rogue CA, and wrong-CN reject. Run it from the gateway directory:

```bash
cd gateway
npm test
```

`node-forge` is a gateway devDependency used to generate test certificates.
