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
    // COVERAGE IS A RATCHET, NOT A TARGET.
    //
    // There were ~170 frontend test files and no coverage number anywhere in the repo, which means
    // nobody could say whether a refactor deleted the only test of a module. `thresholds.lines` below
    // is deliberately set two points UNDER the number measured when it was introduced: its job is to
    // fail a run that DROPS coverage, not to nag anyone towards a percentage. Raise it when the
    // measured number rises; the one thing never to do is lower it to make a red run green.
    //
    // `npm run test:coverage` passes `--testTimeout=30000`, and that is NOT a way of hiding a slow
    // test. `classAttributeChannel.test.tsx` walks the frontend source tree from inside a test; it
    // finishes in ~1.6s uninstrumented and blows the 5s default under v8 coverage, because every module
    // the walk touches is transformed and instrumented on the way. The plain `npm run test` keeps the
    // 5s default, so a test that genuinely became slow still fails there — the longer clock applies only
    // to the run that pays for instrumentation, where a 5s ceiling would make the ratchet look flaky.
    //
    // `include` below is the whole point of the number. Vitest 4 has no `coverage.all` flag any more:
    // `coverage.include` IS the universe, and every file matching it is reported whether or not a test
    // ever loaded it. So a component with no test at all counts as uncovered instead of being absent
    // from the denominator — which is exactly what a "% of the files we happened to load" number hides.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // `reportOnFailure` because CI uploads this report with `if: always()`, and without it that upload
      // finds nothing on exactly the runs it was written for. Vitest defaults it to FALSE while
      // `coverage.clean` defaults to true: on a run with a FAILING TEST the coverage directory is wiped
      // at start and no report is ever written, so the `if-no-files-found: warn` upload swallows it in
      // silence. (A THRESHOLD failure does still write the report — that path was already covered. It is
      // the test-failure path, the one where someone wants to see which module lost its only test, that
      // lost its artifact.)
      reportOnFailure: true,
      // SOURCE ONLY. `coverage.include` is the denominator's universe, so a bare `src/**` puts every file
      // extension in it — 4 CSS files and 3 JSON fixtures today, pulled in through Vite's transform. Their
      // contribution is tiny (4 lines of 21,156), but the shape is wrong: it makes the ratchet sensitive
      // to changes that are not code, and the obvious reading of the red run one big stylesheet would
      // cause is "lower the floor", which the note below correctly says is the one move never to make.
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        // The tests themselves.
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/__tests__/**',
        // GENERATED code. Committed or not, none of it is written by hand, so a coverage number over
        // it measures the generator's output volume rather than anything a reviewer can act on:
        // src/generated/** and src/lib/generated/** are emitted by the F2/F5 contract generators,
        // and *.generated.ts covers assetVersion.generated.ts and its siblings wherever they land.
        'src/generated/**',
        'src/lib/generated/**',
        'src/**/*.generated.ts',
        // REGISTRIES generated per-machine from the plugins that happen to be installed. These are the
        // three paths .gitignore names, written by the frontend `prebuild`/`predev` scripts; they differ
        // between a developer's checkout and CI's, so including them would make the coverage number
        // depend on which plugins are on disk. (`src/app/admin/plugin/**` holds exactly one file, the
        // generated `[slug]/page.tsx` — spelled as the directory because a literal `[slug]` in a glob
        // would be read as a character class.)
        'src/lib/pluginRegistry.ts',
        'src/lib/versoPluginRegistry.ts',
        'src/app/admin/plugin/**',
        // Type-only declaration files carry no executable line.
        'src/**/*.d.ts',
        // NOTHING ELSE. src/lib/plugins-registry.ts and src/instrumentation.ts were both candidates —
        // one is named like a generated file and is not, the other is a framework entry point no unit
        // test loads — and both are hand-written product code. Excluding code because it is untested is
        // how a coverage number becomes decorative, so they stay in the denominator, uncovered.
      ],
      thresholds: {
        // Measured 2026-09-04 over all 173 files / 3,683 tests: lines 42.45% (8,981/21,156),
        // statements 41.43%, branches 39.85%, functions 30.93%. The floor is LINES only, and sits a
        // little over two points under the measurement — enough slack that it cannot flap, tight
        // enough that losing a module's only test turns it red. Tighten it as the number rises.
        //
        // That measurement was taken with `include: ['src/**']`. Narrowing it to .ts/.tsx above removes
        // the 4 CSS + 3 JSON files, whose measured contribution was 4 lines of the 21,156 — so the
        // number moves to 8,981/21,152, still 42.4%, and the floor is untouched. Re-record the exact
        // figures here from CI's first reported run rather than carrying this arithmetic forever.
        lines: 40,
      },
    },
  },
});
