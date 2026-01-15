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

*   **Environment Protection:** Global `process.env` is replaced with a **Security Proxy**. 
    *   When a plugin tries to read sensitive keys (e.g., `JWT_SECRET`, `DB_PASSWORD`), the proxy returns `******** (Protected)`.
    *   Full access is only granted to the core application.
*   **API Sandboxing:** Core functions like `dbAsync` or `updateOption` verify the current plugin's permissions before executing. If a plugin lacks the required "capability" in its manifest, the call is blocked at runtime.

### 1.3 Mandatory Permission Authorization
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

For ultra-high security environments, we recommend auditing third-party plugin dependencies before installation.
