/**
 * Gateway security headers (helmet options).
 *
 * The gateway used to disable CSP entirely (`helmet({ contentSecurityPolicy: false })`) — documented as
 * pending hardening. This restores a CSP whose shape MIRRORS the backend's (backend/src/index.ts): the
 * gateway fronts the same backend + Next admin, so the policy it imposes on its OWN responses (error
 * pages, /gateway-status, the pre-install bootstrap) must be what the app already tolerates —
 * `unsafe-inline` for the Next bootstrap and CMS themes, images from anywhere, cross-origin resource
 * policy so the frontend can load backend images. Inventing a stricter policy here would break the admin.
 *
 * ONE DELIBERATE DEPARTURE from the mirror: `script-src` does NOT carry `'unsafe-eval'`. It was there for
 * the Puck editor, which is gone; the real production frontend build has no `eval`/`new Function`, and the
 * frontend header (frontend/next.config.ts) dropped it too, so mirroring it here would only re-widen the
 * gateway's own pages. The backend still lists it (backend/src/index.ts) — narrowing that API/uploads
 * policy is a separate item. Test: test/security-headers.test.js asserts the absence, so it stays gone.
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
            scriptSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline for the Next bootstrap + CMS themes; NO unsafe-eval (see header)
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
