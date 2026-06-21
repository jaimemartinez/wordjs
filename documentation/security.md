# WordJS Security Architecture 🛡️

WordJS implements a "Defense in Depth" security model for its plugin ecosystem, designed to protect the core system and sensitive data from malicious or poorly written extensions.

> **Status & honesty note.** WordJS is **pre-production** and primarily solo-maintained. The defenses
> documented here are implemented and tested, but the project has **not** had an independent security
> audit — one is **recommended before any production deployment**. `SECURITY.md` (repo root) is the
> disclosure / reporting policy and realistic-posture summary; this document is the deeper defenses
> reference. The plugin sandbox is the project's central thesis (see `POSITIONING.md`).

## 1. The Pillars of Defense

> **OS-process-isolated sandbox — every plugin, no exceptions.** A plugin marked `"isolated": true`
> (mandatory for all plugins) runs in a **separate OS process** (`child_process.fork`,
> `backend/src/core/plugin-isolate.ts` forks `plugin-worker.js`) — its own heap, event loop, and OS
> memory cap, so a crash, OOM, or heap escape is contained to the child and never reaches the host (a
> `worker_threads` Worker, by contrast, shared the host heap/rss; that transport remains only as a legacy
> fallback). The plugin reaches core ONLY through the permission-checked `wordjs` **capability bridge**,
> RPC'd over the IPC channel (structured-clone, `serialization: 'advanced'`) — it never touches the
> host's raw `fs` / `child_process` / `dbAsync` / secrets. The AST scanner (§1.1) and the runtime guards
> (§1.2) run **inside the child** as *belt-and-suspenders* around that boundary. **There is no "trusted"
> plugin tier and no bypass** — every plugin is sandboxed, and capabilities are admin-granted per plugin
> (default-deny). See §8 for the capability-grant model.

### 1.1 AST Static Analysis (Pre-Activation)
Before a plugin is activated, its entire source code is parsed into an **Abstract Syntax Tree (AST)** using Acorn (`backend/src/core/plugins.ts → validatePluginPermissions`).

*   **Logic:** Unlike simple regex checks, the AST scanner "understands" the code structure.
*   **Detection:**
    *   **Obfuscation:** Detects dynamic property access like `global["ev" + "al"]()`.
    *   **Dangerous Functions:** Blocks `eval()`, `execSync()`, `spawn()`, etc.
    *   **Sensitive Globals:** Restricts access to `process` (except `.env`), `global`, `Buffer`, and `module`.
    *   **Module Hijacking:** Blocks `require()` of sensitive Node.js modules like `child_process`, `fs`, `http`/`https`, `net`, `dgram`, `dns`, `cluster`, `async_hooks`, `vm`, `worker_threads`, etc. (the `node:` prefix is normalized first).
*   **Fail-closed:** If a plugin file cannot be parsed, it is treated as a **violation** (never waved through).
*   **Enforcement:** Validation happens on every activation attempt and **on every server boot** (to prevent post-activation code poisoning).

### 1.2 Runtime Context Proxies
WordJS uses `AsyncLocalStorage` to track the execution context of every request.

> **Detached Code is Still Sandboxed:** Plugin code that runs *outside* the `AsyncLocalStorage` wrapper — Express route handlers a plugin registers, synchronous hooks, timers (`setTimeout`/`setInterval`), and module top-level code — used to run with an empty context and was therefore treated as trusted core (a real RCE bypass). The runtime guards now resolve the active plugin via `getEffectivePlugin()`, which uses the `AsyncLocalStorage` context **or**, when absent, the nearest plugin/theme frame on the call stack. Synchronous hooks (`doActionSync`/`applyFiltersSync`) also run their callbacks inside the plugin context. As a result, detached plugin code remains subject to its manifest permissions.

*   **Environment Protection:** Global `process.env` is replaced with a **strict Read-Only Proxy**. 
    *   Plugins CANNOT read sensitive keys from the environment.
    *   Secrets (DB passwords, JWT keys) are loaded directly from `wordjs-config.json` by the core and never exposed to `process.env`.
    *   Plugins attempting to access secrets will receive `undefined`.

*   **Module Interception (`secure-require.ts`):** WordJS patches both `Module.prototype.require` **and** the lower-level `Module._load` (so obfuscation paths like `require('module').constructor._load(...)` are caught too), returning secured replacements for sensitive modules:
    *   **`fs` Proxy + io-guard:** Filesystem operations require `filesystem:read` / `filesystem:write` permission. Plugins may access their own directory freely; link/symlink creation is denied outright (TOCTOU + escape vector); any `fs` function not classified as read or write is **deny-by-default**. `io-guard.ts` additionally confines plugin fs to the plugin dir and **blocks** secret/config files (`.env*`, `wordjs-config.json`) and the live database files (`*.db`/`*.sqlite*` and the configured `dbPath`), which hold every credential, session token, and secret.
    *   **`child_process` Proxy:** Shell execution is **blocked for every plugin** — there is no capability or tier that unlocks it. (The `system:admin` shell escape was removed along with the trust tier.)
    *   **Network Trap (data-exfil / SSRF):** A separate OS process still has full Node net access, so raw `net`/`tls`/`http`/`https`/`http2`/`dns`/`dgram` modules are **blocked by default** and opened only when a plugin has been granted the **`network`** capability (admin opt-in, with an exfiltration warning — e.g. mail-server's SMTP/MX delivery). The binding-backed globals `fetch`/`WebSocket`/`EventSource` are not reachable through the module loader, so they are trapped directly on `globalThis` for plugins without the `network` grant as well. ESM `import()` is also gated (the CommonJS `require` proxy doesn't cover it): a module-resolution hook rejects the same sensitive builtins, and the worker **fails closed** (refuses to run) if no hook API is available (Node ≥ 18.19 required to run plugins).
    *   **Native-binding lockdown:** `process.binding`/`_linkedBinding` throw for plugin contexts and `.node` addons are refused (`process.dlopen` is intentionally left open for legitimate native addons).
    *   **Obfuscation-Immune:** Because enforcement happens at runtime (not just static analysis), even obfuscated code like `fs["read" + "FileSync"]()` is blocked.

*   **Secret & Core-Module Scrubbing:** A plugin that `require()`s a core module could capture the real `fs`/secrets it closed over. So plugins are **denied** sensitive core modules; `config/app` is handed back as a read-only Proxy with credential-like fields (`*secret*`, `*password*`, `*key*`, `*token*`, …) stripped; and the `config/database` `dbAsync` is replaced with a **table-scoped** view. That scoping is **default-deny by prefix and applies to every plugin** (`backend/src/core/plugin-api.ts`): every table a query touches must be one the plugin OWNS under its `wjp_<slug>_` prefix, so it can't read another plugin's tables or any core table — backed by an explicit denylist of core tables (`users`, `user_meta`, `options`, `roles`, `sessions`, …) and rejection of `ATTACH`/`DETACH`/`PRAGMA`, schema catalogs (`sqlite_master`/`information_schema`), stacked statements, comma cross-joins, Postgres `USING`, and `RETURNING`. There is no "unscoped DB" capability for any plugin. Plugins that need user or site data use the **safe bridges** `wordjs.users.*` (a projection that never includes `user_pass`, gated on `users:read`) and `wordjs.site.*` (gated on `settings:read`) instead.

*   **API Sandboxing (capability bridge):** The `wordjs` object passed to a plugin's `init(api)` (`backend/src/core/plugin-api.ts`) is the *only* sanctioned path to core, and inside an isolated plugin those calls are RPC'd to the host over IPC. The host dispatcher (`callApi` in `plugin-isolate.ts`) enforces an **exact method allowlist** — a malicious child cannot walk an arbitrary dotted path on the api object — and registration / mail-provider / notify-transport / route all flow only through their own dedicated IPC kinds (default-deny). Every method then enforces the plugin's capability grant (`verifyPermission` = manifest-declared **AND** admin-granted, default-deny) **and** constrains arguments host-side: option-key allowlists, SQL table-scoping, and path confinement to the plugin's own dir + uploads. **No plugin skips the option/table scoping** — these constraints are unconditional now that the trusted tier is gone.

*   **DoS containment (host-side):** Beyond the layered memory caps (§4), the host bounds a misbehaving child: a per-child bridge-call **token-bucket rate limit** + concurrency cap, a global **IPC message-rate cap**, inbound/outbound RPC **payload size caps**, an `fs.write` size limit + per-plugin disk quota, an admin-menu cap, hook/route/shortcode **registration caps** (incl. per-hook-name), and a 30s **RPC timeout** that recycles a wedged child. Repeated abuse `SIGKILL`s and tears the child down.

### 1.3 CrashGuard v2.0 (Anti-Boot Loop)
WordJS includes a sophisticated system to prevent a single buggy or malicious plugin from taking down the entire server.

*   **The 3-Strike Rule:** To avoid "false positives" (like a power outage during plugin load), CrashGuard uses a strike system.
    1.  **Strike 1 & 2:** If the server crashes during plugin initialization, CrashGuard logs a warning and retries on next boot.
    2.  **Strike 3:** If the plugin consistently crashes the server 3 times, it is **automatically disabled**, and a critical alert is sent to the admin panel.
*   **Runtime Blame System:** If an asynchronous error (like an unhandled promise rejection or a `setTimeout` crash) occurs outside of a request, CrashGuard analyzes the stack trace. If the error originated from a plugin, that plugin is identified ("blamed") and disabled on the next restart to prevent a crash loop.

### 1.4 Mandatory Permission Authorization
Plugins must explicitly declare their requirements in `manifest.json`.

*   **Transparency:** Administrators are presented with a clear "Authorization Modal" before activation.
*   **Least Privilege:** Plugins only get what they ask for (and what the admin approves).

---

## 2. Forbidden Patterns & Developer Rules

To pass the AST scanner, your plugin code must follow these rules:

1.  **No Dynamic Requires:** Use `require('name')` with string literals only. `require(path.join(...))` is blocked.
2.  **No Global Pollution:** Accessing or modifying `global` properties is prohibited.
3.  **Use core APIs:** Instead of `fs.writeFile`, use the WordJS APIs or declare `filesystem` permissions.
4.  **No Shell Execution:** `child_process` is strictly forbidden to prevent RCE (Remote Code Execution).

---

## 3. Dealing with Security Blocks

If your plugin fails validation, you will receive a detailed error:
`🛡️ Security Block: Plugin 'name' failed validation: Blocked dangerous calls detected: eval, Direct 'global' access...`

To fix this:
1.  Check the `manifest.json` permissions.
2.  Remove any obfuscated or prohibited code patterns.
3.  Use official WordJS hooks/filters instead of direct global manipulation.

---

## 4. Current Limitations (Threat Model)

WordJS provides a high level of isolation, but it is not a virtual machine, and it has **not** had an independent security audit.
*   **Vulnerability Scoping:** The AST scanner focuses on the plugin's own source code, not its `node_modules`.
*   **Resource Limits (memory, layered):** Because each plugin is a *separate OS process*, its memory is the child's own rss — bounded in layers rather than by a single Worker `resourceLimits`: (a) an **opt-in preventive cgroup v2** `memory.max` via `systemd-run --user --scope` (`config.sandbox.useCgroupMemoryCap=true`, probe-gated, no root) that has the kernel OOM-kill only the offending child at the resident budget (768 MB); (b) a **reactive host-side RSS poll** on every platform (Linux `/proc`, Windows `tasklist`, macOS `ps`) that `SIGKILL`s the child over 768 MB; (c) a **loose `RLIMIT_AS` virtual backstop** (`ulimit -v`, `config.sandbox.addressSpaceCapMb`, default 16384 MB — kept generous because V8's pointer-compression cage reserves ~4 GB virtual) plus `--max-old-space-size=256` for the JS heap. There is still **no hard CPU quota** — a plugin can burn CPU (DoS).
*   **Runtime Escapes:** Low-level escapes are blocked at runtime *inside the child* — `Module._load` is intercepted like `Module.prototype.require`, `process.binding`/`_linkedBinding` throw, `.node` native addons are refused, ESM `import()` of sensitive builtins is rejected (fail-closed), and deferred plugin code (`setTimeout`/`setInterval`, EventEmitter listeners, top-level/detached callbacks) is re-anchored to the plugin context via `getEffectivePlugin()` so it cannot shed its sandbox. (`process.dlopen` is intentionally left open for legitimate native addons.)
*   **Syscall surface:** The sandbox is **not yet capability-minimal at the kernel level** — `seccomp` / `landlock` syscall filtering and a dropped (unprivileged) uid for the child are **roadmap**, not yet built. A *preventive* memory cap on Windows needs a Job Object (native, not built); on Windows the reactive `tasklist` RSS poll is the only resident cap.
*   **CSP disabled:** A strict Content Security Policy is **not** yet enabled at the gateway (`helmet({ contentSecurityPolicy: false })`); enabling it without breaking the admin UI is a documented follow-up.
*   **CSRF:** Protection is **origin-based with exact matching** (Origin/Referer + a gateway-pinned `X-Forwarded-Host`, see §9), not per-request CSRF tokens. Token-based CSRF is future work.

For ultra-high security environments, audit third-party plugin dependencies before installation, run an independent security review, and complete the §7 production checklist (rotate all secrets, set a strong `gatewaySecret`).

---

## 5. Permission Reference 📚

These are the valid scopes and access levels you can declare in `manifest.json`.

| Scope               | Access  | Description                                                 |
| :------------------ | :------ | :---------------------------------------------------------- |
| **`database`**      | `read`  | Allows reading from custom tables using `dbAsync`.          |
|                     | `write` | Allows INSERT/UPDATE/DELETE operations.                     |
|                     | `admin` | Full control (DROP/CREATE tables).                          |
| **`settings`**      | `read`  | Can read site options via `getOption()`.                    |
|                     | `write` | Can modify site options via `updateOption()`.               |
| **`filesystem`**    | `read`  | Read files (e.g., templates, assets) using `fs` or `path`.  |
|                     | `write` | Write files to disk (Use cautiously).                       |
| **`network`**       | (grant) | Outbound HTTP/sockets. **Blocked by default** (raw `net`/`http`/… and `fetch`/`WebSocket` are trapped); opened only when an admin **grants** the `network` capability (with an exfiltration warning). |
| **`email`**         | `provider` | Allows `wordjs.mail` and (with the `email:provider` grant) registering the host-wide mail provider. Still sandboxed — raw SMTP requires the `network` grant. |
| **`notifications`** | `send` / `provider` | `send` allows dispatching alerts via `wordjs.notify`; the `notifications:provider` grant allows registering a notification transport. |
| **`users`**         | `read`  | Allows the safe-projection user bridges (`wordjs.users.findByEmail/findByLogin/findById/search`). Never exposes `user_pass` or core tables. |

> **Capabilities are admin-granted per plugin (default-deny).** A manifest only **requests** a
> capability; it can never be the sole basis for one. A bridge call works only if the capability is
> BOTH declared in the manifest AND **granted by an admin** in `/admin/plugins`
> (`backend/src/core/plugin-permissions.ts`, persisted in the `plugin_grants` option). See §8. There is
> **no "trusted" tier and no bypass** — every plugin (first-party included) goes through the full AST
> scan and the same grant checks. The genuinely dangerous raw capabilities — shell/`child_process`,
> native addons, unscoped/core-table DB, secret-named options, raw cookie/header control, raw-HTML
> hooks — were **removed entirely**: no plugin can be granted them, by any means.

### Example Manifest declaration:

```json
"permissions": [
    { "scope": "database", "access": "write", "reason": "Storing poll results" },
    { "scope": "notifications", "access": "send", "reason": "Alerting admin on new votes" }
]
```

---

---

## 6. Internal Cluster Security (mTLS) 🔒

WordJS uses a **Mutual TLS (mTLS)** architecture to secure communication between internal components (Gateway, Backend, Frontend).

### 6.1 Gateway as Certificate Authority
The Gateway acts as the master of the mTLS infrastructure:
*   **Location:** The master certificates, including the **Cluster Root CA key**, are stored in `gateway/certs/`.
*   **Isolation:** The private key of the CA NEVER leaves the Gateway folder.
*   **Identity Provisioning:** During setup, the Orchestrator generates unique identities for the Backend and Frontend, firming them with the CA stored in the Gateway.

### 6.2 Selective Distribution (Least Privilege)
To prevent lateral movement if a service is compromised, certificates are distributed selectively:
*   **Backend:** Receives `backend.crt`, `backend.key`, and `cluster-ca.crt`.
*   **Frontend:** Receives `frontend.crt`, `frontend.key`, and `cluster-ca.crt`.
*   **Gateway:** Receives ALL files (as it is the master) but only uses `gateway-internal` for identity.

### 6.3 Secure Control Plane
The Backend manages the Gateway via a dedicated **Internal API** (Port 3100). This API:
*   Requires a valid `backend` mTLS certificate to connect.
*   Allows the Backend to push new public SSL certificates (from Let's Encrypt) to the Gateway without direct filesystem access.
*   Allows remote configuration of the Gateway without restarting the main OS process.

---

## 7. Production Security Checklist ✅

Before deploying WordJS to production, ensure the following:

### JWT Secret (CRITICAL)

The installer automatically generates cryptographically secure secrets in `wordjs-config.json`.
You can verify them by checking the file:

```json
"jwtSecret": "a4f... (long random string)"
"gatewaySecret": "b9c... (long random string)"
```

The signing secret **never** falls back to a hardcoded/public constant. If no secret is configured (e.g. before setup completes), the backend uses a per-process ephemeral random secret so issued tokens cannot be forged — but those tokens reset on every restart. Complete setup so a persistent secret is written to `wordjs-config.json` for production. `jwt.verify` is also pinned to the `HS256` algorithm, and passwords are hashed with bcrypt at cost factor 12.

**Session revocation & login throttling** (stateless JWT, so these add the server-side state JWTs lack):
*   **Revocation:** Logout and password change stamp a per-user `token_valid_after` epoch; the auth middleware rejects any token whose `iat` predates it (including in `optionalAuth`, which treats a revoked token as anonymous). A stolen token stops working after logout / password reset rather than living until expiry.
*   **Per-account lockout:** After **10** consecutive failed logins, an account is locked for **15 minutes** — this throttles a distributed/botnet attack that the per-IP rate limiter alone does not stop.

### Configuration (No Env Vars)

WordJS does **not** use `.env` files. All security settings are in `wordjs-config.json`.

| Setting         | Required | Description                                                        |
| --------------- | -------- | ------------------------------------------------------------------ |
| `jwtSecret`     | ✅ Yes    | Token signing key (64+ random bytes). **Rotate before production.** |
| `nodeEnv`       | ✅ Yes    | Set to `production`                                                 |
| `gatewaySecret` | ✅ Yes    | Gateway management auth. **Must be strong and rotated** — the shipped public default is rejected, so management endpoints return 503 until you set a real one. |
| `db.password`   | If PG    | Database password. **Rotate before production.**                   |

> **Operator action (required):** rotate `jwtSecret`, `gatewaySecret`, and `db.password` away from any
> value that was ever committed or shared, and set a strong `gatewaySecret`. The installer generates
> fresh secrets, but if you cloned/seeded a config you must rotate them yourself.

### XSS Protection (isomorphic)

User-generated HTML is sanitized via a single `sanitizeHTML()` that works on **both** sides of the render (`frontend/src/lib/sanitize.ts`):

*   **Browser:** DOMPurify with a strict tag/attribute allowlist (`on*` handlers and `<script>`/`<object>`/etc. are dropped).
*   **Server (SSR):** `sanitize-html` with a mirrored allowlist, so the **initial** server-rendered HTML is already safe *before* hydration (returning raw HTML there used to be an XSS window). Both paths **fail closed** (strip all tags) if the sanitizer is unavailable.

```typescript
import { sanitizeHTML } from '@/lib/sanitize';

// Safe rendering — same call works in SSR and in the browser.
<div dangerouslySetInnerHTML={{ __html: sanitizeHTML(content) }} />
```

### Path Traversal Prevention

All plugin and theme slugs are validated before filesystem operations:

```javascript
function validateSlug(slug) {
    // Only alphanumeric, dashes, underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return false;
    
    // Ensure path stays within allowed directory
    const safePath = path.resolve(PLUGINS_DIR, slug);
    return safePath.startsWith(path.resolve(PLUGINS_DIR));
}
```

### Command Injection Prevention

All shell commands use `execFile` instead of `exec`:

```javascript
// ❌ Vulnerable
exec(`node "${scriptPath}"`);

// ✅ Safe
execFile('node', [scriptPath]);
```

In particular, plugin dependency installation passes package names to `execFile` as an argument array (not a shell string), so a malicious manifest dependency name cannot inject shell commands.

> **CORS:** In production, the backend allows only the configured origins (site / frontend / gateway) rather than reflecting arbitrary origins with credentials.

### Additional Recommendations

1. **HTTPS**: Always use SSL/TLS in production (via Nginx or Caddy)
2. **Rate Limiting**: The Gateway includes rate limiting by default
3. **Firewall**: Only expose port 3000 (or 80/443)
4. **Backups**: Configure automatic backups. Backups are stored **on-host** in `backend/backups/` and are **retention-pruned** after each run — only the newest N are kept (the `backup_retention` option, default `7`; set `0` to keep all), so scheduled backups can't fill the disk. Off-host / S3 storage is roadmap, so copy backups off the box for disaster recovery.
5. **Metrics endpoint**: The Prometheus `GET /metrics` endpoint is **disabled by default** and returns `404` unless you set a scrape token (`config.metrics.token` or the `METRICS_TOKEN` env var). When enabled, scrape it only over a trusted network with `Authorization: Bearer <token>`; never expose it without a token.
6. **Updates**: Keep Node.js and dependencies updated

---

## 8. Plugin Capability Model (Android-style grants — no trust tier)

There is **one** plugin model: every plugin is sandboxed, and each capability is **admin-granted per plugin** with **default-deny** (`backend/src/core/plugin-permissions.ts`). The old binary trusted/untrusted split — and all of its bypass machinery (`plugin-trust.ts`, `config.trustedSystemPlugins`, the `__WORDJS_PLUGIN_TRUSTED__` child flag, the `system:admin` scan-skip, and the admin trust toggle) — has been **removed**. No plugin is privileged; first-party plugins are merely **pre-granted** the capabilities they declare, and they run under the exact same sandbox and grant checks as anything uploaded.

**How it works:** a plugin's `manifest.json` **requests** capabilities; an admin **grants** each one per plugin via toggles in `/admin/plugins` (`POST /plugins/:slug/permissions`, persisted in the `plugin_grants` option, mirrored in memory so the bridge gates read it synchronously). A bridge call succeeds only if the capability is BOTH declared in the manifest AND granted (`verifyPermission`); `:admin` access implies read+write.

**These constraints apply to every plugin, unconditionally:**

| Surface | Rule (all plugins) |
| :-- | :-- |
| DB | own `wjp_<slug>_` tables only; raw SQL on core tables refused. No unscoped tier exists. |
| User / site data | via the safe bridges `wordjs.users.*` (`users:read`; projection only, never `user_pass`) and `wordjs.site.*` (`settings:read`). |
| Options | non-secret keys only; secret-named options are never exposed. |
| Routes | always namespaced under `/api/v1/plugin/<slug>`. Absolute paths were removed. |
| Route I/O | host auth cookie `wordjs_token` (+ csrf/session) stripped from the forwarded request; `Set-Cookie`/`CSP`/`HSTS`/`Location` stripped from the reply; plugin-set cookies namespaced + path-confined + lifetime-clamped. Verbatim header control was removed. |
| Raw-HTML hooks | `wordjs_head`/`wordjs_footer` (SSR-injected, unescaped) **denied** for everyone (stored-XSS). |
| Outbound network | **blocked** unless the `network` capability is granted (admin opt-in, exfiltration warning). |
| Mail / notifications | `wordjs.mail` / `wordjs.notify` via grants; registering a host-wide provider needs `email:provider` / `notifications:provider`. Still sandboxed. |
| Shell / native | `child_process` and native addons (`dlopen`) are **blocked for all plugins** — removed, not gated. |

**Hot-reload semantics:** changing a plugin's grants **reloads its isolated child process** so the host-capability gates re-evaluate and a `network` change takes effect — no server restart needed. Unload/reload performs a full teardown.

> **Note:** `db-migration` is **no longer a plugin** — its functionality moved into core at
> `backend/src/core/db-admin/`. Any older doc referencing it (or a "trusted system plugin" list) is stale.

---

## 9. CSRF & Host Trust (X-Forwarded-Host)

State-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`) are guarded by `csrfProtection` (`backend/src/middleware/auth.ts`):

*   The check compares the request **Origin** (or Referer-derived origin) against an allowlist using **exact origin matching** via `URL` parsing — never `startsWith` (a prefix match would let `https://victim.com.evil.com` satisfy an allowed `https://victim.com`).
*   Behind the gateway, `req.get('Host')` is the internal upstream (`127.0.0.1:PORT`), so the backend instead honors **`X-Forwarded-Host`**. The gateway **pins** that header to the real client-facing `Host` and strips any client-supplied value (`gateway/src/index.js`), so a remote attacker cannot forge it to satisfy the same-origin check.
*   `/api/v1/setup/*` is exempt (origin not yet configured); pure API clients with no Origin/Referer are allowed (they must still present a valid JWT).

This is origin-based protection, **not** per-request CSRF tokens — see §4.

---

## 10. Security Headers

WordJS uses **Helmet.js** for security headers:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security` (when behind HTTPS)

> **CSP is currently disabled.** The gateway runs `helmet({ contentSecurityPolicy: false })`, so there
> is **no** strict Content-Security-Policy yet. Enabling a useful CSP without breaking the admin UI is a
> documented follow-up (see §4). Until then, treat CSP as not-in-place for your threat model.

