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
- **Rate Limiting**: Per-IP brute-force protection on login and API endpoints (backend).
- **Per-Account Login Lockout**: A single account is locked for 15 minutes after 10 consecutive failed logins — this throttles a distributed/botnet attack that defeats the per-IP limiter.
- **Helmet Headers**: HSTS, `X-Content-Type-Options`, `X-Frame-Options`, and XSS filtering. (The gateway's helmet CSP is off; the **frontend ships a real Content Security Policy** on every route — see Known Limitations.)
- **IO Guard**: Recursive filesystem locks to prevent unauthorized plugin access outside their directory.
- **Zip Slip Protection**: Every entry in an uploaded plugin or theme archive has its resolved path verified to stay inside the target directory before extraction.
- **Marketplace Install Integrity**: One-click installs from the admin Marketplace tab (`backend/src/routes/marketplace.ts`) fetch catalog zips server-side (https-only, size-capped, strict filename shape), verify them **sha256** against the catalog entry, and hand off to the **same** guarded zip-install pipeline as manual uploads (zip-bomb budget, Zip Slip, slug validation, manifest + AST scan) — the marketplace adds no separate install surface beyond the catalog fetch.
- **SVG Sanitization**: Strips malicious scripts from vector images.
- **Identity Isolation**: mTLS authentication between Gateway, Backend, and Services. The **gateway is the cluster CA** (`gateway/src/cluster-ca.js`); each service holds a per-node certificate (`CN` in `{backend, frontend}`) signed by that CA, and the internal control plane (`POST /register`, health checks) requires a valid client cert. The gatewaySecret is an additional shared-header secret on top of the mTLS channel.
- **Token-Bound Node Enrollment** (separate mode): when the three services run on **different machines**, a new node bootstraps its mTLS identity with a **single-use, role-bound, TTL-limited join token** minted on the gateway (`node scripts/cluster.js token <backend|frontend>`). `node scripts/node-join.js` sends a CSR to a **dedicated token-enrollment listener** (default port `3101`, a separate HTTPS listener that does **not** request a client cert; the strict mTLS `/register` listener is unchanged); the gateway validates the token, **forces `CN` = the token's role** (the CSR subject is ignored), signs the cert, and returns it with the cluster CA. `node-join` verifies the CA fingerprint (`--ca-hash`, a MITM guard) before trusting the response. The token is burned after first use. See [`documentation/separate-mode.md`](documentation/separate-mode.md).
- **One-Time Install Token**: The pre-install setup endpoints (`POST /setup/install`, `POST /setup/test-db`) are gated by a one-time token printed to the server console (and mirrored to a `0600` file in the data dir; overridable via `WORDJS_INSTALL_TOKEN`, ≥16 chars), compared in constant time and cleared once installed — preventing pre-install takeover.
- **Import Identifier Allowlist**: The JSON `custom_tables` import validates every table and column name against a strict simple-identifier regex and refuses core tables + `sqlite_*` reserved tables before any SQL interpolation.

### Authentication & Transport
- **JWT Signing**: The signing secret never falls back to a public constant. When none is configured, a per-process ephemeral random secret is used (issued tokens stop working after a restart). Configure a real secret via setup for production.
- **Algorithm Pinning**: `jwt.verify` is pinned to `HS256`.
- **Stateless-JWT Revocation**: Logout and password change stamp a per-user security epoch (`token_valid_after`); the auth middleware rejects any token whose `iat` predates it. A stolen token no longer stays valid until expiry after logout/password reset.
- **Password Hashing**: bcrypt cost factor of 12.
- **CSRF (Origin pinning)**: State-changing requests are checked against an **exact** allowed-origin match. The gateway pins `X-Forwarded-Host` to the real client `Host` (stripping any client-supplied value), so a remote attacker cannot forge the header to pass the same-origin check. When **both** `Origin` and `Referer` are absent the unsafe request is now **rejected (fail-closed)** unless it carries a real `Bearer` token (server-to-server) — previously it failed open.
- **CORS**: In production, only configured origins (site / frontend / gateway) are allowed, instead of reflecting arbitrary origins with credentials.
- **Gateway Management Auth**: The gateway management secret is accepted **header-only** (never in the query string), compared in constant time, and the shipped public default is rejected (management endpoints return 503 until a real secret is configured).
- **Stored-XSS Hardening**: User-generated HTML is sanitized **isomorphically** — DOMPurify in the browser, `sanitize-html` on the server (SSR), both fail-closed. Built-in shortcode attribute values are escaped (`escAttr`/`escUrl`) before output. The Puck page-tree (`_puck_data`) sanitizer is **value-based**: every non-HTML string leaf is run through a scheme blocker (`javascript:`/`data:`/`vbscript:`/`file:`, incl. control-char obfuscation), so URL props not in any key-name allowlist cannot carry a script URL; `_puck_data` sent as a JSON string is parsed, sanitized, and re-stringified. Shared by `posts.ts` and the WXR importer.
- **Token-Gated Metrics**: The Prometheus endpoint `GET /metrics` is **disabled (returns 404) unless a scrape token is configured** (`config.metrics.token` / `METRICS_TOKEN`); scrapes must present `Authorization: Bearer <token>`, compared in constant time (mismatch → 401). It is never exposed without a token.

### Plugin Sandbox (Isolated-Only)
- **OS-Process Isolation**: Every plugin runs in a **separate OS process** (`child_process.fork`, wrapped in a transport-agnostic Worker-like adapter — `worker_threads` itself is a **blocked** module inside plugins) and reaches core ONLY through the permission-checked `wordjs` capability bridge, RPC'd over IPC — it never touches raw `fs` / `child_process` / `dbAsync` / secrets. A crash, OOM, or heap escape is contained to the child and the host always survives. Bridge dispatch enforces an **exact method allowlist**; registration / mail-provider / notify-transport / route flow only through dedicated trust-gated IPC kinds.
- **No Trust Tier — Per-Capability Grants (default-deny)**: There is **no** trusted tier; every plugin is sandboxed and the admin grants each bridge capability individually in `/admin/plugins` (Android-style, default-deny, persisted server-side and never self-declarable). A plugin gets **nothing** until an operator approves it. First-party plugins are pre-granted only their **declared** capabilities and are not privileged. No plugin bypasses DB scoping, the IO Guard, or these grants.
- **Outbound-Network Confinement**: A plugin has **no** outbound network unless an admin grants the `network` capability. While not granted, `fetch`/`WebSocket` and the raw `net`/`tls`/`http`/`https`/`http2`/`dgram` modules are blocked. When granted, egress is confined to **public destinations only** by a connect-time guard that blocks loopback, link-local (incl. `169.254.169.254` cloud-metadata), RFC1918, CGNAT (`100.64/10`), IPv6 ULA/loopback, IPv4-mapped-v6, `0.0.0.0/8` (this-host), and multicast/reserved ranges; denies IPC / unix-socket paths; fails closed on unresolvable hosts; and re-validates the **actual resolved IP at connect time** (anti DNS-rebinding) and across redirect hops — so a network-granted plugin still cannot SSRF the metadata endpoint or internal services.
- **Secret Scrubbing**: Sandboxed plugins receive `config/app` and `dbAsync` views with credential-like fields stripped and core credential/role/option tables (`users`, `options`, …) refused.
- **Isolated Themes**: A theme's optional server-side `functions.js` runs in the **same OS-isolated sandbox** as plugins (`loadIsolatedPlugin('theme:<slug>')` in `theme-engine.ts`), pre-scanned by the same AST validator and reaching core only through the same permission-checked bridge. Theme code never executes in-process on the host — this closed the former in-process-theme RCE surface.

### Vulnerability Management
- **Deep Static Analysis (SAST)**: AST-based (Acorn) scanning of plugins at install to block Injection, RCE, and Obfuscation. Parse failures are treated as violations (**fail-closed**).
- **Dependency Conflict Check**: Strict SemVer verification to prevent plugin dependency collision.
- **Safe Dependency Install**: Plugin dependencies are installed with `execFile` and an argument array (no shell string), so manifest dependency names cannot inject shell commands.
- **License Gate (CI)**: `license-checker --production` fails the build on `AGPL`/`SSPL` dependencies (WordJS is MIT; see `THIRD-PARTY-NOTICES.md`).

### Known Limitations
- **CSP**: The **frontend** (admin UI + public pages) ships a Content Security Policy on every route via `next.config.ts` (`default-src 'self'`; `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:`; `frame-ancestors 'none'`; `object-src 'none'`; `base-uri 'self'`). `blob:` is required so admin plugin bundles (`import(URL.createObjectURL(blob))`) and their icons render; `'unsafe-inline'`/`'unsafe-eval'` remain for Next.js + Puck (the server-side sanitizer is the XSS control). The **gateway's** helmet CSP is still off (`helmet({ contentSecurityPolicy: false })`); tightening both is a documented follow-up.
- **CSRF**: Protection is **origin/exact-match** based (Origin/Referer + pinned `X-Forwarded-Host`), not per-request CSRF tokens. Token-based CSRF is future work.
- **Sandbox escapes**: Low-level escapes (`Module._load`, `process.binding`/`_linkedBinding`, `process.dlopen`, native `.node` addons, deferred timers/event-emitter listeners) are blocked at runtime for plugin contexts (loading native addons is denied to every plugin — no trust tier unlocks it). The AST scanner does **not** inspect a plugin's `node_modules`, and there are no hard CPU quotas (memory is capped per child in layers — a preventive Windows Job Object cap (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`, default-on, probe-gated, opt-out `config.sandbox.useJobObjectMemoryCap`), an opt-in preventive cgroup v2 cap on Linux (`config.sandbox.useCgroupMemoryCap`), a cross-platform reactive RSS poll, and a loose `RLIMIT_AS` backstop).
- **Opt-in kernel hardening (Linux)**: Beyond the in-process escape blocks, an opt-in layer (`config.sandbox.useKernelHardening`, default-off, Linux-only, probe-gated) runs each isolated child through `bubblewrap` (`bwrap`) — dropped uid (unprivileged `nobody` in a rootless user namespace), all capabilities dropped, `no-new-privs`, PID/IPC/UTS namespaces, read-only fs — plus a seccomp-bpf syscall denylist (pure-JS classic BPF, no native dep). Landlock is intentionally not used. Off by default since `bwrap` presence and rootless-userns support vary by host; any probe failure falls back to the standard isolated launch.
- **No independent audit yet**: see the posture note above.

## 🐛 Reporting a Vulnerability

If you discover a security vulnerability within WordJS, please report it via the **GitHub Security Advisories** tab or contact the maintainer directly.
**Do NOT open a public GitHub issue.**

### Response Time
Our team is committed to addressing security issues promptly.
- **Acknowledge**: 24-48 hours.
- **Fix**: Critical issues are patched within 72 hours.

## 📝 Supported Versions

WordJS is pre-production; only the latest `main` and the current `1.5.x` release line are supported. There is no LTS line yet.

| Version  | Supported | Notes                                             |
| :------- | :-------- | :------------------------------------------------ |
| `main`   | ✅         | Latest development line (the only one patched)    |
| `1.5.x`  | ✅         | Current release line (latest tag `v1.5.4`)        |
| < `1.5`  | ⚠️        | Best-effort; upgrade to `1.5.x` or latest `main`  |
