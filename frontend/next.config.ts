import type { NextConfig } from "next";

const path = require('path');
const localConfigModule = (filename: string) => path.resolve(__dirname, filename);

// THE hosts a video embed may come from — the SAME module `src/lib/sanitize.ts` reads, so the CSP and
// the sanitizer can no longer disagree. See embed-hosts.js for what the hand-written list broke.
//
// Next 16 transpiles this TypeScript file into an in-memory `next.config.compiled.js`. On Node 22/24,
// that virtual CommonJS module has no physical parent from which `require('./embed-hosts.js')` can
// resolve, even though the helper exists beside this source file. Resolve local config helpers against
// the real frontend directory explicitly; package/builtin requires are unaffected.
const { ALLOWED_EMBED_HOSTS } = require(localConfigModule('embed-hosts.js')) as { ALLOWED_EMBED_HOSTS: string[] };

// Real app version exposed to the client (editor chrome, about panels). Read from the ROOT
// package.json — release bumps touch that one; frontend/package.json is pinned at 0.1.0 and never
// versioned. fs+JSON.parse (not a JSON import) so it compiles cleanly under next.config.ts.
let wordjsVersion = '';
try {
  const fs = require('fs');
  const path = require('path');
  wordjsVersion = String(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version || ''
  );
} catch (e: any) {
  console.warn('[NextConfig] Failed to read root package.json version:', e.message);
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_WORDJS_VERSION: wordjsVersion,
  },
  // Don't advertise the framework: Next.js emits `X-Powered-By: Next.js` by default, which the gateway
  // proxies straight through (helmet on the gateway only strips its OWN Express header). Removing it at
  // the source drops the version-fingerprint header in every deploy mode (audit F-09).
  poweredByHeader: false,
  turbopack: {
    // We must include the parent directory as root because we import from ../plugins
    root: require('path').resolve(__dirname, '..'),
  },
  async headers() {
    // SECURITY: baseline security headers for every route. The KEY anti-clickjacking control is
    // `frame-ancestors 'self'` (plus the legacy X-Frame-Options: SAMEORIGIN); object-src 'none' +
    // base-uri 'self' close common injection vectors. Those are the real value here.
    //
    // frame-ancestors is 'self' (NOT 'none') on purpose: WordJS frames its OWN pages same-origin —
    // the theme Customizer (/admin/themes/customize) previews the live site in an <iframe src="/">,
    // and other admin surfaces embed same-origin content. 'self' still fully blocks CROSS-origin
    // framing (an attacker's site can't frame WordJS → no clickjacking); 'none' additionally blocked
    // the app's own same-origin preview, which broke the Customizer (blank/errored iframe). This is
    // the same relaxation WordPress uses for its Customizer preview.
    //
    // script-src: 'unsafe-eval' is GONE. It was here for the Puck visual editor, which no longer exists.
    // Evidence for the removal: the real production client build (.next, 91 chunks) contains zero `eval(`
    // and zero `new Function(`; the only two `Function("` occurrences are core-js's and decimal.js's
    // global-object fallbacks, which short-circuit on globalThis/self and are unreachable in a browser.
    // No WebAssembly in client chunks, and every shipped plugin admin bundle (marketplace/plugins/*/dist)
    // is clean too. Test: src/lib/__tests__/embedHostsCsp.test.ts asserts script-src never regains it.
    //
    // What DOES stay in script-src, because removing it breaks the app (a regression):
    //   • blob: — the admin loads each plugin's frontend bundle via `import(URL.createObjectURL(blob))`
    //     (lib/pluginBundleLoader.ts). Without script-src blob:, every plugin admin UI + its icons fail
    //     to render. (This was the cause of the "no icons" regression.)
    //   • 'unsafe-inline' — Next.js App Router emits inline bootstrap/hydration <script> tags; a full
    //     per-request nonce migration is out of scope. (So script-src isn't an XSS backstop today — the
    //     server-side sanitizer in lib/sanitize.ts is the real XSS defense.)
    // worker-src blob: — libs that spawn workers from a blob URL. font-src allows the Google Fonts CDN.
    // frame-src is DERIVED from ALLOWED_EMBED_HOSTS (embed-hosts.js) — the list the VideoEmbed block
    // actually resolves URLs against. It used to be written out by hand, next to a comment claiming it
    // covered "the sanitizer's permitted embeds" while naming a DIFFERENT list: youtube-nocookie.com
    // was accepted by the block and blocked by this header, so a privacy-enhanced YouTube embed became
    // an empty hole with no "Unsupported video URL" marker. Deriving it means a new provider can only
    // be added in one place. Test: src/lib/__tests__/embedHostsCsp.test.ts.
    // Resource directives (script/style/font/img) allow https: — the app loads its OWN theme assets
    // (fonts under /uploads/fonts, theme CSS/JS, images) over https.
    //
    // The old justification here — "the Puck editor renders the theme inside an about:srcdoc iframe,
    // where the CSP keyword 'self' does NOT resolve to the page origin" — is DEAD: Puck is gone, there
    // is no srcdoc iframe anywhere in frontend/src, and Verso's canvas is an ordinary same-origin route
    // (<iframe src="/admin/canvas-frame">), where 'self' resolves normally.
    //
    // The TRUE reason https: remains in script-src is the bundled analytics-tag plugin: its public
    // loader (marketplace/plugins/analytics-tag/public/loader.js) injects <script> elements pointing at
    // https://www.googletagmanager.com/gtag/js, https://plausible.io/js/script.js, and — the blocker for
    // a static allow-list — an ADMIN-ENTERED Matomo origin (validated only as https, different per site).
    // This header is baked at BUILD time and cannot know that per-site origin, so no explicit origin list
    // can be written here today. To narrow it later: proxy the admin-entered Matomo origin same-origin
    // (or render it into a per-request header), then replace https: with an explicit origin allow-list —
    // googletagmanager.com + plausible.io + the proxied Matomo path. Dropping https: outright without
    // that is a product decision (it disables third-party analytics tags), not a cleanup.
    //
    // These resource directives are NOT the XSS line of defense anyway (script-src still carries
    // 'unsafe-inline' for the Next.js bootstrap; the server-side sanitizer is the XSS control). The REAL
    // value kept here is the structural set: frame-ancestors 'self' (cross-origin clickjacking),
    // object-src 'none', base-uri 'self'.
    // 'unsafe-eval' is DEVELOPMENT-ONLY. React's development build calls eval() for its debugging
    // features (reconstructing component stacks across environments) and, served the strict header,
    // logs "eval() is not supported in this environment … React requires eval() in development mode"
    // on every page — the app still works, but a dev console painted red on load hides real errors.
    // React never uses eval() in production, the shipped chunks contain none (measured), and Vitest runs
    // with NODE_ENV=test, so the strict production shape is what the tests pin and what `next start`
    // serves. Keyed on === 'development' precisely so no other environment inherits the allowance.
    const scriptSrc = process.env.NODE_ENV === 'development'
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:"
      : "script-src 'self' 'unsafe-inline' blob: https:";
    const csp = [
      "default-src 'self'",
      scriptSrc,
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https:",
      "connect-src 'self' https: http: ws: wss:",
      ["frame-src 'self'", ...ALLOWED_EMBED_HOSTS.map((h) => `https://${h}`)].join(' '),
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Deny powerful device features WordJS core never uses + opt out of the Topics API (audit F-09).
          // It deliberately does NOT list `payment` at all, which leaves the Payment Request API at its
          // browser default. NOTE the old comment here was wrong: it claimed the online-store plugin uses
          // Stripe Elements / the Payment Request API for Apple/Google Pay. It does not — the plugin
          // creates a Checkout Session server-side (api.stripe.com, secret key never leaves the server)
          // and the browser leaves by TOP-LEVEL NAVIGATION to Stripe's own hosted page, which this header
          // does not govern. So nothing bundled depends on `payment` being unrestricted; the directive is
          // left as-is here on purpose (comment-only correction — changing it is a separate decision).
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
        ],
      },
      {
        // Self-hosted font files are content-addressed by filename and never change in place —
        // cache them hard so the editor/admin doesn't re-fetch fonts on every navigation.
        source: '/fonts/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
  async rewrites() {
    // Monolith mode: the single-process server dispatches /api and /uploads to the backend in-process
    // before Next sees them, so no proxy rewrite is needed (and there's no gateway port to target).
    if (process.env.WORDJS_MODE === 'mono') return [];

    // WHERE /api AND /uploads GO. Resolution + precedence + validation live in one shared module
    // (./backend-proxy-target.js) because `server.js` has to reach the same answer: Next bakes these
    // rewrites into .next/routes-manifest.json at BUILD time and `next start` never re-reads this
    // function, so on the pre-compiled release the runtime proxy in server.js — not this rewrite —
    // is what honours WORDJS_BACKEND_URL. See that module's header.
    const { resolveBackendProxyTarget, BACKEND_URL_ENV, rewriteSources } = require(localConfigModule('backend-proxy-target.js'));
    let gatewayPort: unknown;
    try {
      const fs = require('fs');
      const path = require('path');

      // Distributed First
      let configPath = path.resolve(__dirname, 'wordjs-config.json');
      if (!fs.existsSync(configPath)) {
        configPath = path.resolve(__dirname, '../backend/wordjs-config.json');
      }

      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        gatewayPort = config.gatewayPort;
      }
    } catch (e: any) {
      console.warn('[NextConfig] Failed to load wordjs-config.json for rewrites:', e.message);
    }

    // A malformed WORDJS_BACKEND_URL throws here on purpose — building a frontend whose API proxy
    // silently points somewhere else is worse than not building it.
    const { target: backendUrl, source } = resolveBackendProxyTarget({
      env: process.env[BACKEND_URL_ENV],
      gatewayPort,
    });
    if (source === 'env') {
      console.log(`[NextConfig] backend prefixes → ${backendUrl} (from ${BACKEND_URL_ENV})`);
    }

    // Every prefix the backend owns, not just /api and /uploads — see PROXIED_PREFIXES. The list is
    // shared with server.js so the build-time and runtime paths forward exactly the same things.
    return rewriteSources().map((source: string) => ({
      source,
      destination: `${backendUrl}${source}`,
    }));
  },
  reactStrictMode: false,
};

export default nextConfig;
