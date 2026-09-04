/**
 * Swagger spec is not vacuous, and it does not lie about its version.
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

    // THE VERSION THE SPEC ANNOUNCES IS THE PRODUCT'S, NOT A LITERAL.
    //
    // It was hardcoded '1.0.0' and stayed there while the product reached 2.1.0: /api-docs told every
    // integrator, and every client generated from the spec, a version that had been false since the
    // first release. A hardcoded string cannot drift into being wrong — it is wrong the moment the
    // product is bumped, and nothing compared the two. This is that comparison.
    //
    // Mutation check performed by hand: putting the literal '1.0.0' back into src/config/swagger.ts
    // fails the first assertion below with "2.1.0 !== 1.0.0".
    it('announces the product version, read from the release manifest', () => {
        const rootManifest = require('../../../package.json');

        assert.strictEqual(
            specs.info.version,
            rootManifest.version,
            `swagger spec announces version ${specs.info.version} but the release manifest ` +
                `(package.json) says ${rootManifest.version} — the spec's version is not derived ` +
                `from the product's, so it goes stale at the next release.`,
        );
    });

    it('announces a real semver version (never the 0.0.0 fallback)', () => {
        // resolveProductVersion() in src/config/swagger.ts degrades to '0.0.0' rather than throwing
        // when no manifest can be read. That is the right behaviour for a docs route at request time
        // and the wrong outcome for a checkout, so the fallback must never be what the suite sees:
        // it would mean the manifest lookup is broken in exactly the way this test exists to catch.
        assert.match(
            String(specs.info.version),
            /^\d+\.\d+\.\d+/,
            `swagger spec version ${specs.info.version} is not semver-shaped.`,
        );
        assert.notStrictEqual(
            specs.info.version,
            '0.0.0',
            'swagger spec fell back to 0.0.0 — no package.json could be read from src/config/.',
        );
    });
});
