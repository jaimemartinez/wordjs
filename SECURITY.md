# Security Policy

> **Posture (be realistic).** WordJS is **pre-production** and primarily solo-maintained. The defenses
> below are real and tested, but the project has **not** had an independent security audit — one is
> **recommended before any production deployment**. Operators **must** complete the hardening steps in
> the checklist (rotate `jwtSecret` / `gatewaySecret` / `db.password`, set a strong `gatewaySecret`)
> before exposing an instance to the internet. See [`documentation/security.md`](documentation/security.md)
> for the deeper defenses reference.
>
> **Rotate if you cloned early.** A config backup file (`backend/wordjs-config.backup.json`) that contained
> real secrets was previously committed. It has since been **purged from the entire git history**
> (`git-filter-repo`) and is no longer present in any commit. However, anyone who cloned or forked the repo
> **before** the purge still has those secrets in their local history — those operators **must** rotate
> `jwtSecret`, `gatewaySecret`, and `db.password`.

## 🛡️ Security Features

WordJS is built with a "Security First" architecture.

### Active Defenses
- **Rate Limiting**: Per-IP brute-force protection on login and API endpoints (gateway + backend).
- **Per-Account Login Lockout**: A single account is locked for 15 minutes after 10 consecutive failed logins — this throttles a distributed/botnet attack that defeats the per-IP limiter.
- **Helmet Headers**: HSTS, `X-Content-Type-Options`, `X-Frame-Options`, and XSS filtering. (A strict Content Security Policy is currently **disabled** — see Known Limitations.)
- **IO Guard**: Recursive filesystem locks to prevent unauthorized plugin access outside their directory.
- **Zip Slip Protection**: Every entry in an uploaded plugin or theme archive has its resolved path verified to stay inside the target directory before extraction.
- **SVG Sanitization**: Strips malicious scripts from vector images.
- **Identity Isolation**: mTLS authentication between Gateway, Backend, and Services.

### Authentication & Transport
- **JWT Signing**: The signing secret never falls back to a public constant. When none is configured, a per-process ephemeral random secret is used (issued tokens stop working after a restart). Configure a real secret via setup for production.
- **Algorithm Pinning**: `jwt.verify` is pinned to `HS256`.
- **Stateless-JWT Revocation**: Logout and password change stamp a per-user security epoch (`token_valid_after`); the auth middleware rejects any token whose `iat` predates it. A stolen token no longer stays valid until expiry after logout/password reset.
- **Password Hashing**: bcrypt cost factor of 12.
- **CSRF (Origin pinning)**: State-changing requests are checked against an **exact** allowed-origin match. The gateway pins `X-Forwarded-Host` to the real client `Host` (stripping any client-supplied value), so a remote attacker cannot forge the header to pass the same-origin check.
- **CORS**: In production, only configured origins (site / frontend / gateway) are allowed, instead of reflecting arbitrary origins with credentials.
- **Gateway Management Auth**: The gateway management secret is accepted **header-only** (never in the query string), compared in constant time, and the shipped public default is rejected (management endpoints return 503 until a real secret is configured).
- **Stored-XSS Hardening**: User-generated HTML is sanitized **isomorphically** — DOMPurify in the browser, `sanitize-html` on the server (SSR), both fail-closed. Built-in shortcode attribute values are escaped (`escAttr`/`escUrl`) before output.
- **Token-Gated Metrics**: The Prometheus endpoint `GET /metrics` is **disabled (returns 404) unless a scrape token is configured** (`config.metrics.token` / `METRICS_TOKEN`); scrapes must present `Authorization: Bearer <token>`, compared in constant time (mismatch → 401). It is never exposed without a token.

### Plugin Sandbox (Isolated-Only)
- **OS-Process Isolation**: Every plugin runs in a **separate OS process** (`child_process.fork`; a `worker_threads` transport remains as a fallback) and reaches core ONLY through the permission-checked `wordjs` capability bridge, RPC'd over IPC — it never touches raw `fs` / `child_process` / `dbAsync` / secrets. A crash, OOM, or heap escape is contained to the child and the host always survives. Bridge dispatch enforces an **exact method allowlist**; registration / mail-provider / notify-transport / route flow only through dedicated trust-gated IPC kinds.
- **Two Trust Tiers (server-side, never self-declarable)**: *untrusted* (sandboxed: own DB tables, non-secret options, namespaced routes, **no outbound network**) vs *operator-trusted* (privileged: unscoped DB, secret options, absolute routes, mail provider, raw sockets). Trust comes from shipped defaults (`config.trustedSystemPlugins`) or an admin toggle (persisted in the `trusted_plugins` option) — a plugin can never grant itself trust.
- **Outbound-Network Trap**: For untrusted plugins, `fetch`/`WebSocket`/`EventSource` are trapped and raw `net`/`tls`/`http`/`https`/`http2`/`dns`/`dgram` modules are blocked, so an uploaded plugin cannot exfiltrate data or perform SSRF.
- **Secret Scrubbing**: Untrusted plugins receive `config/app` and `dbAsync` views with credential-like fields stripped and core credential/role/option tables (`users`, `options`, …) refused.

### Vulnerability Management
- **Deep Static Analysis (SAST)**: AST-based (Acorn) scanning of plugins at install to block Injection, RCE, and Obfuscation. Parse failures are treated as violations (**fail-closed**).
- **Dependency Conflict Check**: Strict SemVer verification to prevent plugin dependency collision.
- **Safe Dependency Install**: Plugin dependencies are installed with `execFile` and an argument array (no shell string), so manifest dependency names cannot inject shell commands.
- **License Gate (CI)**: `license-checker --production` fails the build on `AGPL`/`SSPL` dependencies (WordJS is MIT; see `THIRD-PARTY-NOTICES.md`).

### Known Limitations
- **CSP**: A strict Content Security Policy is **disabled** at the gateway (`helmet({ contentSecurityPolicy: false })`). Enabling it without breaking the admin UI is a documented follow-up.
- **CSRF**: Protection is **origin/exact-match** based (Origin/Referer + pinned `X-Forwarded-Host`), not per-request CSRF tokens. Token-based CSRF is future work.
- **Sandbox escapes**: Low-level escapes (`Module._load`, `process.binding`/`_linkedBinding`, native `.node` addons, deferred timers/event-emitter listeners) are blocked at runtime for plugin contexts (`process.dlopen` left open for native addons). The AST scanner does **not** inspect a plugin's `node_modules`, and there are no hard CPU quotas (memory is capped per child in layers — an opt-in preventive cgroup v2 cap on Linux, a cross-platform reactive RSS poll, and a loose `RLIMIT_AS` backstop).
- **No independent audit yet**: see the posture note above.

## 🐛 Reporting a Vulnerability

If you discover a security vulnerability within WordJS, please report it via the **GitHub Security Advisories** tab or contact the maintainer directly.
**Do NOT open a public GitHub issue.**

### Response Time
Our team is committed to addressing security issues promptly.
- **Acknowledge**: 24-48 hours.
- **Fix**: Critical issues are patched within 72 hours.

## 📝 Supported Versions

WordJS is pre-production; only the latest `main` is supported. There is no LTS line yet.

| Version  | Supported | Notes                                          |
| :------- | :-------- | :--------------------------------------------- |
| `main`   | ✅         | Latest development line (the only one patched) |
| tagged   | ⚠️        | Best-effort; upgrade to latest `main` first    |
