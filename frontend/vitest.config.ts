import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Lean unit-test config for the frontend. Default node environment (the tests here cover pure logic
// / the SSR sanitizer path — no DOM needed). Add `environment: 'jsdom'` per-file when a test needs it.
export default defineConfig({
  // Vitest does NOT read tsconfig `paths`, so any module under test that imports a sibling as `@/…`
  // (e.g. pluginBundleLoader's host-module set) fails to resolve without this mirror of that alias.
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
