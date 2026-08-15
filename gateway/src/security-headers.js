/**
 * Gateway security headers (helmet options).
 *
 * The gateway used to disable CSP entirely (`helmet({ contentSecurityPolicy: false })`) — documented as
 * pending hardening. This restores a CSP whose shape MIRRORS the backend's (backend/src/index.ts): the
 * gateway fronts the same backend + Next/Puck admin, so the policy it imposes on its OWN responses (error
 * pages, /gateway-status, the pre-install bootstrap) must be exactly what the app already tolerates —
 * `unsafe-inline`/`unsafe-eval` for Next/Puck/CMS themes, images from anywhere, cross-origin resource
 * policy so the frontend can load backend images. Inventing a stricter policy here would break the admin.
 *
 * Note on precedence: for PROXIED responses the upstream (backend/frontend) writes its own headers last,
 * so its CSP wins and is passed through unchanged; this policy governs responses the gateway generates
 * itself (and any upstream — e.g. Next — that sets none), where the previous `false` left them bare.
 *
 * Kept in a module (not inlined) so the exact object is unit-testable and mutation-provable.
 */
const helmetOptions = {
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // let the frontend load backend images
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // unsafe-inline/eval required for some CMS themes/plugins
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:', '*'], // Allow images from everywhere (CMS content)
            connectSrc: ["'self'", '*'], // Allow API calls
            objectSrc: ["'none'"], // Protect against Flash/Applet injections
            upgradeInsecureRequests: [], // Auto-upgrade http to https
        },
    },
};

module.exports = { helmetOptions };
