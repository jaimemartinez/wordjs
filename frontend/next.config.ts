import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  typescript: {
    // The admin UI dynamically imports plugin frontend components that live under
    // ../backend/plugins/*/client. Those files resolve `react` from backend/node_modules,
    // which is NOT installed in an isolated frontend build (e.g. CI), so the build-time
    // type-check fails to resolve their deps even though Turbopack bundles them correctly.
    // Skip the build-time type-check (the frontend's own types are checked via `tsc`/editor).
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
