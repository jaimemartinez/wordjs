import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // We must include the parent directory as root because we import from ../plugins
    root: require('path').resolve(__dirname, '..'),
  },
  async rewrites() {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000';
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
