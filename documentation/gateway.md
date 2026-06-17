# WordJS Gateway Documentation

The **WordJS Gateway** (`gateway/src/index.js`) is an enterprise-grade entry point for the application. It acts as a high-availability reverse proxy, service registry, and health monitor. It is started by `node gateway/src/index.js` (the root `npm start`/`npm run dev` launch it alongside the backend and frontend via `concurrently`).

> **The gateway runs only in SPLIT mode.** WordJS can run two mutually-exclusive ways from the same codebase (same `backend/wordjs-config.json`, database, uploads/themes/plugins, secrets, and public origin `https://localhost:3000` — no migration to switch). **SPLIT** (default, 3 processes: this gateway on `:3000` + backend `:4000` + frontend `:3001`; root `npm run dev` / `npm start`) gives clustering, health checks, load balancing, the mTLS internal channel, and SSE-aware proxying. **MONOLITH** (1 process, 1 port `:3000`, via the repo-root `monolith.js`; root `npm run dev:mono` / `npm run build:mono` / `npm run start:mono`) has **no separate gateway process** — it mounts the backend Express app (with its isolated worker-thread plugins) and the Next.js request handler in-process, with no loopback proxy, no Node `cluster`, and no gateway `/register`. The gateway's still-needed cross-cutting concerns are re-implemented as local middleware in `monolith.js`: TLS (one HTTPS port reusing the gateway's certificate, with HTTP fallback), Helmet security headers, compression (skipping SSE), SEO rewrites (`/sitemap.xml` → `/api/v1/seo/sitemap.xml`, `/robots.txt` → `.../robots.txt`), and `X-Forwarded-Host` pinning for CSRF. A loopback-only HTTP listener serves the frontend's SSR API calls. Plugins stay isolated exactly as in split mode. Choose **MONOLITH** for the simplest single-artifact deploy (one VM/container, TLS via its built-in HTTPS or a single front-line reverse proxy); choose **SPLIT** to scale services independently and for the gateway's clustering / health checks / load balancing.
>
> *Internals:* backend `src/index.ts` skips its self-listen and gateway self-register when embedded (`process.env.WORDJS_EMBEDDED='1'`, set by `monolith.js`) and instead exposes `initialize()`; `monolith.js` also sets `WORDJS_MODE='mono'`.

## Key Features

*   **🚀 Cluster Mode:** High-availability multiprocess architecture using Node.js `cluster`. It spawns workers across all available CPU cores.
*   **🛡️ Resiliency (Circuit Breaker):** 
    *   **Health Checks:** Automatically polls registered services every 15s.
    *   **Auto-Eviction:** Unhealthy services are ejected after 3 consecutive failures.
    *   **Latency Monitoring:** Detects slow targets (>5s) and marks them as `Degraded`.
*   **🔌 Intelligent Load Balancing:** Round-robin distribution across multiple instances of the same service. A route whose targets all become unhealthy is removed cleanly (no crash on an empty target group), and health metrics are persisted in the registry file so reloaded workers keep avoiding failing upstreams.
*   **🌪️ Log Rotation:** Structured JSON logging via **Winston** with daily file rotation (`logs/gateway-*.log`).
*   **🔒 Security & Protection:**
    *   **Helmet:** Secure HTTP headers out of the box.
    *   **Payload Protection:** 10MB limits on all incoming requests.
    *   **Payload Protection:** 10MB limits on all incoming requests.
    *   **Timeout Guard:** Hard 15s cutoffs for HTTP requests (1 Hour for SSE) to prevent socket leakage. SSE is detected when the `Accept` header *contains* `text/event-stream` (not exact-match), so streaming responses are never wrongly compressed or timed out. The proxy error handler is socket-aware and won't crash on WebSocket upgrade errors.
    *   **Private Metrics:** Authenticated `/gateway-status` dashboard.
    *   **mTLS Upstream Verification:** Internal calls to backend/frontend use a mutual-TLS agent with `rejectUnauthorized: true`. The upstream certificate must chain to the cluster CA **and** present an allowed internal CN (`backend`, `frontend`, `gateway`, `gateway-internal`). This adds MITM protection without requiring IP SANs in the internal certs.
*   **📡 Modern Connectivity:** WebSocket proxying support for bidirectional communication.
*   **🧵 Traceability:** Automatic injection of `X-Correlation-ID` for distributed tracing.

## Configuration

The gateway loads configuration from **`gateway/gateway-config.json`** (its own config file, separate from the backend's `wordjs-config.json`). The setup orchestrator (`setup/index.js`) writes the matching secret/ports into both.

*   **Port:** Public port defaults to `3000` (`gatewayPort`).
*   **Internal port:** The private mTLS control server listens on `gatewayInternalPort` (default = public port **+ 100**, i.e. `3100`).
*   **Secret:** `gatewaySecret` authenticates the public `/gateway-status` dashboard. If no secret is configured, the gateway warns loudly at startup and falls back to a **PUBLIC default** (`secure-your-gateway-secret`) that must be replaced before production. The secret is never written to logs, even when passed via query string.
*   **SSL:** Optional `ssl` block (`{ enabled, key, cert }`); if `ssl` is on but no key/cert is supplied, the gateway auto-generates a self-signed cert (`ssl-auto.crt` / `ssl-auto.key`).
*   **mTLS:** Optional `mtls` block (`{ ca, key, cert }`) for the internal cluster certificates.
*   **Env Vars:** The Gateway loads `.env` via `dotenv`, but operational config (secret, ports, ssl, mtls) lives in the JSON file.

## Proxy Module

The proxy and upstream-agent construction live in `gateway/src/proxy-config.js`, imported by both the gateway and its tests:

*   **`createProxyServer()`** — builds the `http-proxy` server with `{ xfwd: true, changeOrigin: true }`. With `changeOrigin`, the upstream receives the target's Host, while the gateway pins the **original client Host** into `X-Forwarded-Host`. The backend's CSRF check reads `X-Forwarded-Host` and requires an **exact origin match** against the configured site URL.
*   **`createUpstreamAgent({ ca, key, cert })`** — builds the mTLS agent described under Security. Both the worker proxy agent and the primary health-check agent use it, so no internal call uses `rejectUnauthorized: false`.

## Service Registration

Services register themselves dynamically on startup over the **internal mTLS control server** (not a public route). The endpoint is mutual-TLS only and gated by the client-certificate CN allow-list:

**Endpoint:** `POST /register` (on `gatewayInternalPort`, default `3100`), requires a client cert with CN `backend` or `frontend`.
**Body:** `{ "name": "service-name", "url": "http://...", "routes": ["/prefix"] }`

A companion `GET /info` (CN `backend`) returns gateway port, SSL status, site URL, and active-certificate metadata. Because registration is mTLS-only, an attacker on the public port cannot inject rogue upstreams.

## Monitoring

Access the real-time status dashboard at:
`http://localhost:3000/gateway-status?secret=<YOUR_SECRET>`

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
