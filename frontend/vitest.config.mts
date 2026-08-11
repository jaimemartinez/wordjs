import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Lean unit-test config for the frontend. Default node environment (the tests here cover pure logic
// / the SSR sanitizer path — no DOM needed). Add `environment: 'jsdom'` per-file when a test needs it.
export default defineConfig({
  // Vitest does NOT read tsconfig `paths`, so any module under test that imports a sibling as `@/…`
  // (e.g. pluginBundleLoader's host-module set) fails to resolve without this mirror of that alias.
  resolve: {
    // import.meta.dirname, not __dirname: this file is .mts, so Vite's native (ESM) config loader —
    // which is planned to become the default — has no CommonJS __dirname to give it.
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
