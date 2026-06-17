import { defineConfig } from 'vitest/config';

// Lean unit-test config for the frontend. Default node environment (the tests here cover pure logic
// / the SSR sanitizer path — no DOM needed). Add `environment: 'jsdom'` per-file when a test needs it.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
