# Security Policy

## 🛡️ Security Features

WordJS is built with a "Security First" architecture.

### Active Defenses
- **Rate Limiting**: Brute-force protection on Login and API endpoints.
- **Helmet Headers**: Strict Content Security Policy (CSP), HSTS, and XSS filtering.
- **IO Guard**: Recursive filesystem locks to prevent unauthorized plugin access outside their directory.
- **Zip Slip Protection**: Every entry in an uploaded plugin or theme archive has its resolved path verified to stay inside the target directory before extraction.
- **SVG Sanitization**: Strips malicious scripts from vector images.
- **Identity Isolation**: mTLS authentication between Gateway, Backend, and Services.

### Authentication & Transport
- **JWT Signing**: The signing secret never falls back to a public constant. When none is configured, a per-process ephemeral random secret is used (issued tokens stop working after a restart). Configure a real secret via setup for production.
- **Algorithm Pinning**: `jwt.verify` is pinned to `HS256`.
- **Password Hashing**: bcrypt cost factor of 12.
- **CORS**: In production, only configured origins (site / frontend / gateway) are allowed, instead of reflecting arbitrary origins with credentials.
- **Stored-XSS Hardening**: Built-in shortcode attribute values are escaped (`escAttr`/`escUrl`) before output.

### Vulnerability Management
- **Deep Static Analysis (SAST)**: AST-based scanning of plugins to block Injection, RCE, and Obfuscation.
- **Dependency Conflict Check**: Strict SemVer verification to prevent plugin dependency collision.
- **Safe Dependency Install**: Plugin dependencies are installed with `execFile` and an argument array (no shell string), so manifest dependency names cannot inject shell commands.

### Known Limitations
- **CSRF**: Protection is currently Origin/Referer header heuristic based, not token based. Token-based CSRF is future work.
- **Sandbox escapes**: `process.binding` / `Module._load` style escapes are flagged by the AST scanner but not yet blocked at runtime.

## 🐛 Reporting a Vulnerability

If you discover a security vulnerability within WordJS, please report it via the **GitHub Security Advisories** tab or contact the maintainer directly.
**Do NOT open a public GitHub issue.**

### Response Time
Our team is committed to addressing security issues promptly.
- **Acknowledge**: 24-48 hours.
- **Fix**: Critical issues are patched within 72 hours.

## 📝 Supported Versions

| Version | Supported | Notes                  |
| :------ | :-------- | :--------------------- |
| 1.x     | ✅         | Current stable release |
| < 1.0   | ❌         | End of Life            |
