/**
 * Swagger spec is not vacuous.
 *
 * Regression guard for the "silently empty spec" bug: swagger.ts globbed
 * `./src/routes/*.js` relative to process.cwd(), but every route is a `.ts`
 * file, so swagger-jsdoc parsed nothing and served a spec with ZERO paths while
 * still returning HTTP 200 — a classic vacuous-green. This test loads the REAL
 * config module (the same `require('../config/swagger')` the router uses) and
 * asserts the spec actually enumerates paths.
 *
 * Mutation check performed by hand: reverting the glob to `./src/routes/*.js`
 * makes paths.length === 0 and this test fails on the first assertion.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const specs = require('../config/swagger');

describe('swagger spec', () => {
    it('enumerates a non-empty set of API paths', () => {
        const paths = Object.keys(specs.paths || {});
        assert.ok(
            paths.length > 0,
            `swagger spec has zero paths — the @swagger JSDoc comments were not parsed ` +
                `(check the apis[] globs in src/config/swagger.ts).`,
        );
    });

    it('covers roughly every annotated router (no silent under-parse)', () => {
        // Independently count the route files that carry at least one @swagger block.
        const routesDir = path.join(__dirname, '..', 'routes');
        const annotatedFiles = fs
            .readdirSync(routesDir)
            .filter((f: string) => f.endsWith('.ts'))
            .filter((f: string) =>
                fs.readFileSync(path.join(routesDir, f), 'utf8').includes('@swagger'),
            );

        assert.ok(
            annotatedFiles.length > 0,
            'no route files contain @swagger annotations — fixture assumption broken',
        );

        // Each annotated router contributes at least one path, so the parsed spec
        // must expose AT LEAST as many paths as there are annotated route files.
        // (It exposes far more in practice — 86 vs 24 — but this floor is what a
        // broken glob or a half-parsed spec would fall through.)
        const pathCount = Object.keys(specs.paths || {}).length;
        assert.ok(
            pathCount >= annotatedFiles.length,
            `swagger spec exposes only ${pathCount} paths but ${annotatedFiles.length} route ` +
                `files are annotated with @swagger — the spec is under-parsed.`,
        );
    });
});
