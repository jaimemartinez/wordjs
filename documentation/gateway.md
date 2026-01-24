# WordJS Gateway Documentation

The **WordJS Gateway** (`gateway.js`) is an enterprise-grade entry point for the application. It acts as a high-availability reverse proxy, service registry, and health monitor.

## Key Features

*   **🚀 Cluster Mode:** High-availability multiprocess architecture using Node.js `cluster`. It spawns workers across all available CPU cores.
*   **🛡️ Resiliency (Circuit Breaker):** 
    *   **Health Checks:** Automatically polls registered services every 15s.
    *   **Auto-Eviction:** Unhealthy services are ejected after 3 consecutive failures.
    *   **Latency Monitoring:** Detects slow targets (>5s) and marks them as `Degraded`.
*   **🔌 Intelligent Load Balancing:** Round-robin distribution across multiple instances of the same service.
*   **🌪️ Log Rotation:** Structured JSON logging via **Winston** with daily file rotation (`logs/gateway-*.log`).
*   **🔒 Security & Protection:**
    *   **Helmet:** Secure HTTP headers out of the box.
    *   **Payload Protection:** 10MB limits on all incoming requests.
    *   **Timeout Guard:** Hard 15s cutoffs for upstream requests to prevent socket leakage.
    *   **Private Metrics:** Authenticated `/gateway-status` dashboard.
*   **📡 Modern Connectivity:** WebSocket proxying support for bidirectional communication.
*   **🧵 Traceability:** Automatic injection of `X-Correlation-ID` for distributed tracing.

## Configuration

The gateway loads configuration from `backend/wordjs-config.json`.

*   **Port:** Defaults to `3000` (configurable via `gatewayPort` in config).
*   **Secret:** Uses `gatewaySecret` from `wordjs-config.json` for service authentication.
*   **Env Vars:** The Gateway does **not** read `.env` files. Configuration must be in the JSON file.

## Service Registration

Services register themselves dynamically on startup.

**Endpoint:** `POST /register`
**Body:** `{ "name": "service-name", "url": "http://...", "routes": ["/prefix"] }`

## Monitoring

Access the real-time status dashboard at:
`http://localhost:3000/gateway-status?secret=<YOUR_SECRET>`

## Architecture
The Primary process manages the global registry, health checks, and atomic persistence (`gateway-registry.json`), while Worker processes handle the heavy lifting of proxying and WebSocket upgrades.
