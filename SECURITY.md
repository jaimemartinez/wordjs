# Security Policy

## 🛡️ Security Features

WordJS is built with a "Security First" architecture.

### Active Defenses
- **Rate Limiting**: Brute-force protection on Login and API endpoints.
- **Helmet Headers**: Strict Content Security Policy (CSP), HSTS, and XSS filtering.
- **IO Guard**: Recursive filesystem locks to prevent unauthorized plugin access outside their directory.
- **Zip Slip Protection**: Automated scanning of uploaded archives.
- **SVG Sanitization**: Strips malicious scripts from vector images.
- **Identity Isolation**: mTLS authentication between Gateway, Backend, and Services.

### Vulnerability Management
- **Dependency Scanning**: Automated `npm audit` checks.
- **Deep Static Analysis (SAST)**: Regular scans for Injection, RCE, and Secrets.

## 🐛 Reporting a Vulnerability

If you discover a security vulnerability within WordJS, please report it via email to `security@wordjs.com`. 
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
