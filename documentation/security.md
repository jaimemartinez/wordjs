# WordJS Security Architecture 🛡️

WordJS implements a unique "Defense in Depth" security model for its plugin ecosystem, designed to protect the core system and sensitive data from malicious or poorly written extensions.

## 1. The Three Pillars of Defense

### 1.1 AST Static Analysis (Pre-Activation)
Before a plugin is activated, its entire source code is parsed into an **Abstract Syntax Tree (AST)** using Acorn.

*   **Logic:** Unlike simple regex checks, the AST scanner "understands" the code structure.
*   **Detection:**
    *   **Obfuscation:** Detects dynamic property access like `global["ev" + "al"]()`.
    *   **Dangerous Functions:** Blocks `eval()`, `execSync()`, `spawn()`, etc.
    *   **Sensitive Globals:** Restricts access to `process` (except `.env`), `global`, `Buffer`, and `module`.
    *   **Module Hijacking:** Blocks `require()` of sensitive Node.js modules like `child_process`, `net`, `http`, `vm`, etc.
*   **Enforcement:** Validation happens on every activation attempt and **on every server boot** (to prevent post-activation code poisoning).

### 1.2 Runtime Context Proxies
WordJS uses `AsyncLocalStorage` to track the execution context of every request.

> **Detached Code is Still Sandboxed:** Plugin code that runs *outside* the `AsyncLocalStorage` wrapper — Express route handlers a plugin registers, synchronous hooks, timers (`setTimeout`/`setInterval`), and module top-level code — used to run with an empty context and was therefore treated as trusted core (a real RCE bypass). The runtime guards now resolve the active plugin via `getEffectivePlugin()`, which uses the `AsyncLocalStorage` context **or**, when absent, the nearest plugin/theme frame on the call stack. Synchronous hooks (`doActionSync`/`applyFiltersSync`) also run their callbacks inside the plugin context. As a result, detached plugin code remains subject to its manifest permissions.

*   **Environment Protection:** Global `process.env` is replaced with a **strict Read-Only Proxy**. 
    *   Plugins CANNOT read sensitive keys from the environment.
    *   Secrets (DB passwords, JWT keys) are loaded directly from `wordjs-config.json` by the core and never exposed to `process.env`.
    *   Plugins attempting to access secrets will receive `undefined`.

*   **Module Interception (Enterprise-Level):** WordJS intercepts `require()` calls at runtime using a secure module wrapper:
    *   **`fs` Proxy:** All filesystem operations require `filesystem:read` or `filesystem:write` permissions. Plugins can freely access their own directory.
    *   **`child_process` Proxy:** Shell execution is **ALWAYS blocked** for plugins. Any attempt to use `exec`, `spawn`, or `fork` is intercepted at the module level.
    *   **Obfuscation-Immune:** Because enforcement happens at runtime (not just static analysis), even obfuscated code like `fs["read" + "FileSync"]()` is blocked.

*   **API Sandboxing:** Core functions like `dbAsync` or `updateOption` verify the current plugin's permissions before executing. If a plugin lacks the required "capability" in its manifest, the call is blocked at runtime.

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

WordJS provides a high level of isolation, but it is not a virtual machine.
*   **Vulnerability Scoping:** The AST scanner currently focuses on the plugin's source code, not its `node_modules`. 
*   **Resource Limits:** The system does not currently enforce strict CPU or RAM quotas for plugins (DoS protection).
*   **Runtime Escapes:** Low-level escapes are now blocked at runtime — `Module._load` is intercepted like `Module.prototype.require`, and `process.binding`/`_linkedBinding` throw for plugin contexts. (`process.dlopen` is intentionally left open for legitimate native addons.)
*   **CSRF:** Cross-site request protection is currently based on Origin/Referer header heuristics, not on per-request CSRF tokens. Token-based CSRF is future work.

For ultra-high security environments, we recommend auditing third-party plugin dependencies before installation.

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
| **`network`**       | `admin` | allows `require('http')`, `require('net')`, outbound calls. |
| **`email`**         | `admin` | allows `nodemailer`, sending via SMTP.                      |
| **`notifications`** | `send`  | Allows sending alerts to users via `notificationService`.   |
| **`system`**        | `admin` | **DANGEROUS**: Allows `child_process`. The AST scan is skipped **only** for trusted first-party plugins (see note below). |

> **`system:admin` is not self-granting.** Declaring `system:admin` in a manifest is **not** enough to skip the AST scanner — otherwise any uploaded plugin could self-declare it. The skip requires the plugin's slug to be listed in `config.trustedSystemPlugins`, which defaults to the first-party bundled plugins (`db-migration`, `conference-manager`). An uploaded third-party plugin that declares `system:admin` falls through to the full AST scan, so its `child_process`/`eval` usage is still caught.

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

### Configuration (No Env Vars)

WordJS does **not** use `.env` files. All security settings are in `wordjs-config.json`.

| Setting         | Required | Description                          |
| --------------- | -------- | ------------------------------------ |
| `jwtSecret`     | ✅ Yes    | Token signing key (64+ random bytes) |
| `nodeEnv`       | ✅ Yes    | Set to `production`                  |
| `gatewaySecret` | ✅ Yes    | Gateway authentication               |
| `db.password`   | If PG    | Database password                    |

### XSS Protection

All user-generated content is sanitized using **DOMPurify** before rendering:

```typescript
import { sanitizeHTML } from '@/lib/sanitize';

// Safe rendering
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
4. **Backups**: Configure automatic database backups
5. **Updates**: Keep Node.js and dependencies updated

---

## 7. Security Headers

WordJS uses **Helmet.js** for security headers:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security` (when behind HTTPS)

