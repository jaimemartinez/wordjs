import type { NextConfig } from "next";

const path = require('path');
const localConfigModule = (filename: string) => path.resolve(__dirname, filename);

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

/** The slice of backend/src/core/host-policy.js this file uses (types: host-policy.d.ts). */
interface HostPolicyModule {
  buildPolicy(input: { config?: Record<string, any> | null; env?: Record<string, string | undefined>; nodeEnv?: string }): {
    canonical: { hostname: string } | null;
    aliases: Map<string, unknown>;
    envHosts: Map<string, unknown>;
    devOrigins: Set<string>;
  };
  addressesFromInterfaces(interfaces: unknown): Set<string>;
}

type InterfaceMap = Record<string, Array<{ address: string; family: string | number; internal: boolean }> | null | undefined>;

/**
 * The hosts `next dev` may serve its own resources to (`allowedDevOrigins`). Next 16 answers 403 to the
 * /_next/* chunks and the HMR socket for any Origin that is not localhost, so a page opened at another
 * address never hydrates and the admin hangs on its spinner (the phone-on-the-LAN case).
 *
 * The list is the BACKEND's development host policy, computed by the backend's own module, so an
 * address the API answers on in development is an address the dev server serves its chunks to, and
 * nothing more: this machine's addresses (IPv6 bracketed, the way Next compares an Origin's hostname),
 * the configured main address and aliases, WORDJS_ALLOWED_HOSTS and WORDJS_DEV_ORIGINS. A frontend
 * deployed without the backend tree falls back to the machine's addresses plus WORDJS_DEV_ORIGINS.
 * Only `next dev` reads the result; `next build` and `next start` ignore allowedDevOrigins.
 */
export function resolveAllowedDevOrigins(input: {
  hostPolicy: HostPolicyModule | null;
  config: Record<string, any> | null;
  env: Record<string, string | undefined>;
  interfaces: InterfaceMap;
}): string[] {
  const hosts = new Set<string>();
  const hp = input.hostPolicy;
  if (hp) {
    for (const address of hp.addressesFromInterfaces(input.interfaces)) hosts.add(address);
    const policy = hp.buildPolicy({ config: input.config, env: input.env, nodeEnv: 'development' });
    if (policy.canonical) hosts.add(policy.canonical.hostname);
    for (const name of policy.aliases.keys()) hosts.add(name);
    for (const name of policy.envHosts.keys()) hosts.add(name);
    for (const name of policy.devOrigins) hosts.add(name);
    return [...hosts];
  }
  for (const list of Object.values(input.interfaces)) {
    for (const entry of list || []) {
      if (!entry || entry.internal || typeof entry.address !== 'string') continue;
      const family = entry.family === 'IPv4' || entry.family === 4 ? 4 : entry.family === 'IPv6' || entry.family === 6 ? 6 : 0;
      const address = entry.address.split('%')[0].toLowerCase();
      // Link-local addresses (169.254/16, fe80::/10) are never how a browser reaches this machine.
      if (family === 4 && !address.startsWith('169.254.')) hosts.add(address);
      if (family === 6 && !/^fe[89ab]/.test(address)) hosts.add(`[${address}]`);
    }
  }
  for (const item of String(input.env.WORDJS_DEV_ORIGINS || '').split(',')) {
    const text = item.trim().toLowerCase();
    if (!text) continue;
    try {
      hosts.add(text.includes('://') ? new URL(text).hostname : text.replace(/:\d+$/, ''));
    } catch {
      // Not a URL: the backend ignores it too.
    }
  }
  return [...hosts];
}

/**
 * The inputs of resolveAllowedDevOrigins, read from disk and the OS: the backend's host-policy module
 * beside this frontend (when the backend tree is there), the site config (the distributed copy first,
 * then the monolith's backend config, the same order as rewrites() below) and the network interfaces.
 */
export function loadAllowedDevOrigins(frontendDir: string, env: Record<string, string | undefined>): string[] {
  const fs = require('fs');
  const os = require('os');
  let hostPolicy: HostPolicyModule | null = null;
  try {
    hostPolicy = require(path.resolve(frontendDir, '../backend/src/core/host-policy.js'));
  } catch {
    // A frontend deployed on its own machine has no backend tree: use the fallback.
  }
  let config: Record<string, any> | null = null;
  try {
    const configPath = [path.resolve(frontendDir, 'wordjs-config.json'), path.resolve(frontendDir, '../backend/wordjs-config.json')]
      .find((candidate: string) => fs.existsSync(candidate));
    if (configPath) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e: any) {
    console.warn('[NextConfig] Failed to read wordjs-config.json for allowedDevOrigins:', e.message);
  }
  let interfaces: InterfaceMap = {};
  try {
    interfaces = os.networkInterfaces();
  } catch {
    // Some sandboxes refuse interface enumeration: localhost only, which is Next's default.
  }
  return resolveAllowedDevOrigins({ hostPolicy, config, env, interfaces });
}

// Only `next dev` consults the list (the `next` CLI and the monolith set NODE_ENV before this file
// loads), so builds and production starts neither read the site config here nor enumerate interfaces.
const allowedDevOrigins = process.env.NODE_ENV === 'development' ? loadAllowedDevOrigins(__dirname, process.env) : [];

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_WORDJS_VERSION: wordjsVersion,
  },
  allowedDevOrigins,
  // Don't advertise the framework: Next.js emits `X-Powered-By: Next.js` by default, which the gateway
  // proxies straight through (helmet on the gateway only strips its OWN Express header). Removing it at
  // the source drops the version-fingerprint header in every deploy mode (audit F-09).
  poweredByHeader: false,
  experimental: {
    // Rewrites (and headers) match the path EXACTLY as the gateway and the monolith route it. Next's
    // default compares them case-insensitively, so `/API/v1/settings` — which both dispatchers hand to
    // Next, since it is not `/api` — matched the `/api/:path*` rewrite below and came back into the
    // public listener from loopback as /api/v1/settings: an anonymous visitor could make the backend
    // see "a local proxy rewriting Host" (its proxy-collapse notice). The edge refuses the other spelling
    // that did this, dot segments (gateway/src/host-edge.js).
    caseSensitiveRoutes: true,
    // There is no app/layout.tsx: every top-level tree has its own root layout, so a multisite network's
    // other sites get a document of their own (src/app/_root/RootDocument.tsx). A URL no route matches
    // then has no single layout to render a 404 inside, and app/global-not-found.tsx is that page.
    globalNotFound: true,
  },
  turbopack: {
    // We must include the parent directory as root because we import from ../plugins
    root: require('path').resolve(__dirname, '..'),
  },
  async headers() {
    // SECURITY: baseline security headers for every route. The Content-Security-Policy is NOT here: it is
    // written per request by src/proxy.ts (lib/contentSecurityPolicy.ts), because the documents that render
    // per request get a fresh script nonce and the cached public pages get the script origins their active
    // plugins declare — neither of which a header fixed at build time can carry. The anti-clickjacking
    // X-Frame-Options: SAMEORIGIN stays here next to the policy's frame-ancestors 'self' (the theme
    // Customizer frames the site same-origin, so 'none' would break it).
    return [
      {
        source: '/:path*',
        headers: [
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
          //
          // camera=(self), not camera=(): the conference-manager meal scanner (a plugin admin screen) opens
          // the phone camera. With camera=() every Chromium browser (Android Chrome, desktop Chrome/Edge)
          // refused getUserMedia without asking, and the scanner told the operator to grant a permission
          // no setting could grant. Safari does not enforce this header, which is why iPhones still got a
          // picture. `self` keeps every embedded third-party frame out, and the browser still asks the
          // user. ONE value for every route on purpose: a document keeps the policy it was LOADED with,
          // and the admin is usually reached by a client-side navigation (/login → /admin), so an
          // /admin-only value would not apply until the next full reload.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), browsing-topics=()' },
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
    // MULTISITE: another site of the network is served from the internal `wjs-site/[siteHost]` route
    // tree. src/proxy.ts sets `x-wordjs-site-route` (the site's validated main hostname) on that site's
    // public page requests only — never from a client's own header, which it removes — and these rules do
    // the rewrite. Declared here they are always INTERNAL: a rewrite returned by the proxy function is
    // internal only when its URL's origin matches the one Next built for the request, which is not the
    // case behind the gateway's mTLS hop. `beforeFiles`, because `/` and the feed and sitemap routes are
    // static routes the filesystem would otherwise answer first. Inert without the header (every
    // single-site request, and every main-site request).
    const SITE_ROUTE_HAS = [{ type: 'header' as const, key: 'x-wordjs-site-route', value: '(?<siteHost>[a-z0-9_][a-z0-9_.-]{0,252})' }];
    // ORDER MATTERS: Next applies matching beforeFiles rules one after another, so with '/' first its
    // result (/wjs-site/<host>) was rewritten again by '/:path+' into a path that does not exist. With
    // '/:path+' first, neither rule matches what the other produced.
    //
    // Next's own assets (`/_next/...`) and `/favicon.ico` are never a site's page: src/proxy.ts does not
    // run there (its matcher leaves them out), so it cannot remove a client's copy of the header on those
    // paths, and the rule must not match them either — an asset request would otherwise be answered with
    // a page. The gateway and the monolith drop a client's header too (gateway/src/host-edge.js).
    const multisiteRewrites = [
      { source: '/:path((?!_next/|favicon\\.ico$).+)', has: SITE_ROUTE_HAS, destination: '/wjs-site/:siteHost/:path' },
      { source: '/', has: SITE_ROUTE_HAS, destination: '/wjs-site/:siteHost' },
    ];

    // RELEASE BUILD: the rewrite is baked into the shipped .next/routes-manifest.json, so it must be
    // the compiled-in default a clean CI build produces — never this machine's gatewayPort,
    // WORDJS_BACKEND_URL or WORDJS_MODE. Operators repoint a release at runtime (server.js honours
    // WORDJS_BACKEND_URL), not by inheriting the packager's setup. See hermetic-build.js.
    const { isHermeticBuild } = require(localConfigModule('hermetic-build.js'));
    const hermetic = isHermeticBuild();

    // Monolith mode: the single-process server dispatches /api and /uploads to the backend in-process
    // before Next sees them, so no proxy rewrite is needed (and there's no gateway port to target).
    if (process.env.WORDJS_MODE === 'mono' && !hermetic) return { beforeFiles: multisiteRewrites, afterFiles: [] };

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

      if (!hermetic && fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        gatewayPort = config.gatewayPort;
      }
    } catch (e: any) {
      console.warn('[NextConfig] Failed to load wordjs-config.json for rewrites:', e.message);
    }

    // A malformed WORDJS_BACKEND_URL throws here on purpose — building a frontend whose API proxy
    // silently points somewhere else is worse than not building it.
    const { target: backendUrl, source } = resolveBackendProxyTarget({
      env: hermetic ? undefined : process.env[BACKEND_URL_ENV],
      gatewayPort,
    });
    if (source === 'env') {
      console.log(`[NextConfig] backend prefixes → ${backendUrl} (from ${BACKEND_URL_ENV})`);
    } else if (hermetic) {
      console.log(`[NextConfig] hermetic release build — backend prefixes → ${backendUrl} (compiled-in default)`);
    }

    // Every prefix the backend owns, not just /api and /uploads — see PROXIED_PREFIXES. The list is
    // shared with server.js so the build-time and runtime paths forward exactly the same things.
    return {
      beforeFiles: multisiteRewrites,
      afterFiles: rewriteSources().map((source: string) => ({
        source,
        destination: `${backendUrl}${source}`,
      })),
    };
  },
  reactStrictMode: false,
};

export default nextConfig;
