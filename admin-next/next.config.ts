import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // We must include the parent directory as root because we import from ../plugins
    root: require('path').resolve(__dirname, '..'),
  },
  async rewrites() {
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
    } catch (e) { }

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
