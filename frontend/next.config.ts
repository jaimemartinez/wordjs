import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // We must include the parent directory as root because we import from ../plugins
    root: require('path').resolve(__dirname, '..'),
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
