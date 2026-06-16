# WordJS Gateway Documentation

The **WordJS Gateway** (`gateway.js`) is an enterprise-grade entry point for the application. It acts as a high-availability reverse proxy, service registry, and health monitor.

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

The gateway loads configuration from `backend/wordjs-config.json`.

*   **Port:** Defaults to `3000` (configurable via `gatewayPort` in config).
*   **Secret:** Uses `gatewaySecret` from `wordjs-config.json` for service authentication. If no secret is configured, the gateway warns loudly at startup and falls back to a **PUBLIC default** that must be replaced before production. The secret is never written to logs, even when passed via query string.
*   **Env Vars:** The Gateway does **not** read `.env` files. Configuration must be in the JSON file.

## Proxy Module

The proxy and upstream-agent construction live in `gateway/src/proxy-config.js`, imported by both the gateway and its tests:

*   **`createProxyServer()`** — builds the `http-proxy` server with `{ xfwd: true, changeOrigin: true }`. With `changeOrigin`, the upstream receives the target's Host, while the original client Host is preserved as `X-Forwarded-Host` (which the backend's migration guard reads first).
*   **`createUpstreamAgent({ ca, key, cert })`** — builds the mTLS agent described under Security. Both the worker proxy agent and the primary health-check agent use it, so no internal call uses `rejectUnauthorized: false`.

## Service Registration

Services register themselves dynamically on startup.

**Endpoint:** `POST /register`
**Body:** `{ "name": "service-name", "url": "http://...", "routes": ["/prefix"] }`

## Monitoring

Access the real-time status dashboard at:
`http://localhost:3000/gateway-status?secret=<YOUR_SECRET>`

## Architecture
The Primary process manages the global registry, health checks, and atomic persistence (`gateway-registry.json`), while Worker processes handle the heavy lifting of proxying and WebSocket upgrades.

## Testing

An integration test lives at `gateway/test/proxy.integration.test.js` (using `node:test`). It covers Host forwarding (`changeOrigin` rewrite + `X-Forwarded-Host` preservation), mTLS accept with the correct CA, MITM reject with a rogue CA, and wrong-CN reject. Run it from the gateway directory:

```bash
cd gateway
npm test
```

`node-forge` is a gateway devDependency used to generate test certificates.
