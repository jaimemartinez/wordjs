# WordJS Security Architecture 🛡️

WordJS implements a "Defense in Depth" security model for its plugin ecosystem, designed to protect the core system and sensitive data from malicious or poorly written extensions.

> **Status & honesty note.** WordJS is **pre-production** and primarily solo-maintained. The defenses
> documented here are implemented and tested, but the project has **not** had an independent security
> audit — one is **recommended before any production deployment**. `SECURITY.md` (repo root) is the
> disclosure / reporting policy and realistic-posture summary; this document is the deeper defenses
> reference. The plugin sandbox is the project's central thesis (see `POSITIONING.md`).

## 1. The Pillars of Defense

> **Isolated-only sandbox.** Every plugin now runs in a `worker_threads` **isolate** (separate V8 heap)
> and reaches core ONLY through the permission-checked `wordjs` **capability bridge** — it never touches
> the host's raw `fs` / `child_process` / `dbAsync` / secrets. The AST scanner (§1.1) and the runtime
> guards (§1.2) are the *belt-and-suspenders* around that boundary, and they also protect the host
> process itself and any first-party code that still runs in-process. See §8 for the trust model.

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
    *   **`fs` Proxy:** Filesystem operations require `filesystem:read` / `filesystem:write` permission. Plugins may access their own directory freely; link/symlink creation is denied outright (TOCTOU + escape vector); any `fs` function not classified as read or write is **deny-by-default**.
    *   **`child_process` Proxy:** Shell execution is **blocked** for plugins — allowed only for an operator-trusted plugin that also declares `system:admin`.
    *   **Network Trap (data-exfil / SSRF):** Inside an isolate the worker has full Node net access, so raw `net`/`tls`/`http`/`https`/`http2`/`dns`/`dgram` modules are **blocked for untrusted plugins** and allowed only for operator-trusted ones (e.g. mail-server's SMTP/MX delivery). The frontend-facing `fetch`/`WebSocket`/`EventSource` are trapped for untrusted plugins as well.
    *   **Native-binding lockdown:** `process.binding`/`_linkedBinding` throw for plugin contexts and `.node` addons are refused (`process.dlopen` is intentionally left open for legitimate native addons).
    *   **Obfuscation-Immune:** Because enforcement happens at runtime (not just static analysis), even obfuscated code like `fs["read" + "FileSync"]()` is blocked.

*   **Secret & Core-Module Scrubbing:** A plugin that `require()`s a core module could capture the real `fs`/secrets it closed over. So untrusted plugins are **denied** sensitive core modules; `config/app` is handed back as a read-only Proxy with credential-like fields (`*secret*`, `*password*`, `*key*`, `*token*`, …) stripped; and the `config/database` `dbAsync` is replaced with a **table-scoped** view that refuses raw SQL touching core credential/role/option tables (`users`, `user_meta`, `options`, `roles`, `sessions`, …).

*   **API Sandboxing (capability bridge):** The `wordjs` object passed to a plugin's `init(api)` (`backend/src/core/plugin-api.ts`) is the *only* sanctioned path to core. Every method enforces the plugin's manifest permissions (`verifyPermission`) **and** constrains arguments host-side: option-key allowlists, SQL table-scoping, and path confinement to the plugin's own dir + uploads. Operator-trusted plugins skip the option/table scoping (but still go through the bridge).

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
*   **Resource Limits:** Each isolate's memory is capped (`maxOldGenerationSizeMb: 256`), but there is **no hard CPU quota** — a plugin can still burn CPU (DoS).
*   **Runtime Escapes:** Low-level escapes are blocked at runtime — `Module._load` is intercepted like `Module.prototype.require`, `process.binding`/`_linkedBinding` throw, `.node` native addons are refused, and deferred plugin code (`setTimeout`/`setInterval`, EventEmitter listeners) is re-anchored to the plugin context so it cannot shed its sandbox. (`process.dlopen` is intentionally left open for legitimate native addons.)
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
| **`network`**       | `admin` | Outbound HTTP/sockets. **Untrusted plugins are blocked regardless of this manifest claim** (raw `net`/`http`/… and `fetch`/`WebSocket` are trapped); only operator-trusted plugins get real outbound network. |
| **`email`**         | `admin` | Allows `wordjs.mail` / registering a mail provider. Sending via SMTP / raw sockets is reserved for operator-trusted plugins. |
| **`notifications`** | `send`  | Allows sending alerts to users via `wordjs.notify`.         |
| **`system`**        | `admin` | **DANGEROUS**: gates `child_process`, but only takes effect for an **operator-trusted** plugin (see note below). |

> **Manifest permissions are necessary, not sufficient, for privileged actions.** A manifest is
> **self-declared by the plugin**, so it can never be the sole basis for a privileged capability.
> The truly dangerous tiers — unscoped DB (core tables), secret options, raw sockets, `child_process`,
> mail provider, absolute routes — additionally require the plugin to be **operator-trusted**:
> its slug must be in `config.trustedSystemPlugins` (shipped defaults: `conference-manager`,
> `mail-server`) **or** an admin must have flipped its trust toggle in the Plugins UI (persisted in the
> `trusted_plugins` option). See §8. An uploaded third-party plugin that declares `system:admin`
> still falls through to the full AST scan and is still denied `child_process` at runtime.

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

## 8. Plugin Trust Model

Trust is the dividing line between the sandboxed and the privileged tier. It is **server-side and never self-declarable** (`backend/src/core/plugin-trust.ts`).

| | **Untrusted** (default) | **Operator-Trusted** |
| :-- | :-- | :-- |
| DB | own tables only; raw SQL on core tables refused | unscoped (incl. core tables) |
| Options | non-secret keys only | secret-named keys allowed |
| Routes | namespaced under `/api/v1/plugin/<slug>` | absolute paths |
| Outbound network | **blocked** (`fetch`/sockets trapped) | raw sockets allowed |
| Mail / `child_process` | denied | allowed (`system:admin` still required for shell) |

**How a plugin becomes trusted (either path):**
1. **Shipped default** — its slug is in `config.trustedSystemPlugins` (currently `conference-manager`, `mail-server`). These are always trusted and cannot be toggled off in the UI.
2. **Admin toggle** — an authenticated admin flips the trust toggle in the Plugins UI (`POST /plugins/:slug/trust`). The grant is persisted in the `trusted_plugins` **option**, mirrored in memory so the bridge gates read it synchronously.

**Hot-reload semantics:** toggling trust **reloads the plugin's worker** so its routes re-mount under the new tier and the host-capability gates re-evaluate — no server restart needed. Unload/reload performs a full teardown. A plugin can **never** declare its own trust; the toggle is admin-only, and an upload that squats the slug of a trusted system plugin is refused (409).

> **Note:** `db-migration` is **no longer a plugin** — its functionality moved into core at
> `backend/src/core/db-admin/`, so it is not in the trusted list. Any older doc referencing
> `db-migration` as a trusted system plugin is stale.

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

