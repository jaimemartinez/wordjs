import type { NextConfig } from "next";

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
    // script-src DELIBERATELY keeps 'unsafe-inline' 'unsafe-eval' AND adds blob: — removing them BREAKS
    // the app (a regression), so they stay:
    //   • blob: — the admin loads each plugin's frontend bundle via `import(URL.createObjectURL(blob))`
    //     (lib/pluginBundleLoader.ts). Without script-src blob:, every plugin admin UI + its icons fail
    //     to render. (This was the cause of the "no icons" regression.)
    //   • 'unsafe-eval' — the Puck visual editor and some bundled libs use Function()/eval at runtime.
    //   • 'unsafe-inline' — Next.js App Router emits inline bootstrap/hydration <script> tags; a full
    //     per-request nonce migration is out of scope. (So script-src isn't an XSS backstop today — the
    //     server-side sanitizer in lib/sanitize.ts is the real XSS defense.)
    // worker-src blob: — libs that spawn workers from a blob URL. font-src allows the Google Fonts CDN.
    // frame-src allows the sanitizer's permitted youtube/vimeo embeds (else legitimate VideoEmbed breaks).
    // Resource directives (script/style/font/img) allow https: — the app loads its OWN theme assets
    // (fonts under /uploads/fonts, theme CSS/JS, images) and, crucially, the Puck editor renders the
    // theme inside an `about:srcdoc` iframe where the CSP keyword 'self' does NOT resolve to the page
    // origin, so same-origin https assets are blocked unless https: is allowed. These directories are
    // NOT the XSS line of defense anyway (script-src already has 'unsafe-inline'/'unsafe-eval' for
    // Next.js + Puck; the server-side sanitizer is the XSS control). The REAL value kept here is the
    // structural set: frame-ancestors 'self' (cross-origin clickjacking), object-src 'none', base-uri 'self'.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https:",
      "connect-src 'self' https: http: ws: wss:",
      "frame-src 'self' https://www.youtube.com https://player.vimeo.com",
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
          // Deliberately does NOT restrict `payment` (Stripe Elements in the online-store plugin uses the
          // Payment Request API for Apple/Google Pay) so this stays regression-free for bundled plugins.
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
    let backendUrl = 'http://localhost:3000';
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
        if (config.gatewayPort) {
          backendUrl = `https://localhost:${config.gatewayPort}`;
        }
      }
    } catch (e: any) {
      console.warn('[NextConfig] Failed to load wordjs-config.json for rewrites:', e.message);
    }

    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: '/uploads/:path*',
        destination: `${backendUrl}/uploads/:path*`,
      },
    ];
  },
  reactStrictMode: false,
};

export default nextConfig;
