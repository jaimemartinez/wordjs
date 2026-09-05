/** F0 machine-readable architecture and compatibility contracts. */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const {
    verify,
    collectSnapshot,
    verifyOpenapiCoverage,
    coverageRatio,
    DEFAULT_COVERAGE_FLOOR,
} = require('../../scripts/verify-f0-baseline');
const postTypes = require('../core/post-types');
const routes = require('../routes');
const { errorHandler } = require('../middleware/errorHandler');

const app = express();
app.use(express.json());
app.use('/api/v1', routes);
app.use(errorHandler);

describe('F0 architecture baseline', () => {
    it('matches the committed REST, typing, plugin, test, sandbox and performance snapshot', () => {
        const result = verify();
        assert.deepStrictEqual(result.differences, [], result.differences.join('\n'));
        assert.strictEqual(result.ok, true);
    });

    it('documents every accepted invariant in ADR-0001', () => {
        const adr = fs.readFileSync(
            path.resolve(__dirname, '..', '..', '..', 'documentation', 'adr', '0001-f0-foundation-contract.md'),
            'utf8',
        );
        for (let i = 1; i <= 10; i++) {
            const id = `F0-INV-${String(i).padStart(2, '0')}`;
            assert.match(adr, new RegExp(`^### ${id}\\b`, 'm'), `${id} is absent from ADR-0001`);
        }
        for (const heading of ['REST compatibility policy', 'Plugin and content-type compatibility policy', 'Failure characterization', 'Performance measurement']) {
            assert.match(adr, new RegExp(`^## ${heading}$`, 'm'), `ADR-0001 is missing ${heading}`);
        }
    });
});

/**
 * THE COVERAGE FLOOR.
 *
 * The snapshot above pins `openapi.paths`, `openapi.operations` and the semantic hash, and every one
 * of them moves LEGITIMATELY when routes are added. So the anti-drift gate accepts "ten new endpoints,
 * none documented" as soon as the baseline is re-cut — which is how this API got to roughly 55%
 * documented without a single red run. `verifyOpenapiCoverage` is the rule that ratio has to obey, and
 * these are its own reds: synthetic inputs, so they fail for the reason they name rather than because
 * the tree happens to be short of the floor today.
 */
describe('F0 OpenAPI coverage floor', () => {
    const snapshot = (operations: number, endpointDeclarations: number) => ({
        restSource: { endpointDeclarations },
        openapi: { operations },
    });

    it('fails when coverage is below the committed floor, naming both numbers', () => {
        const problems = verifyOpenapiCoverage({ openapi: { coverageFloor: 0.9 } }, snapshot(100, 200));
        assert.strictEqual(problems.length, 1, problems.join('\n'));
        // The message has to carry the measurement, the two counts it came from and the floor it
        // missed: a gate that only says "coverage too low" sends the reader back to the tool.
        assert.match(problems[0], /openapi\.coverage: 0\.5\b/);
        assert.match(problems[0], /100 of 200 endpoint declarations documented/);
        assert.match(problems[0], /floor 0\.9\b/);
    });

    it('passes at the floor exactly, and above it', () => {
        assert.deepStrictEqual(verifyOpenapiCoverage({ openapi: { coverageFloor: 0.5 } }, snapshot(100, 200)), []);
        assert.deepStrictEqual(verifyOpenapiCoverage({ openapi: { coverageFloor: 0.5 } }, snapshot(180, 200)), []);
    });

    it('still gates when the baseline commits no floor', () => {
        // An ABSENT key must not mean "no gate" — that is how performanceBudget.f0BudgetKey silently
        // switched its own rule off. With no committed floor the default applies, and it still bites.
        assert.strictEqual(DEFAULT_COVERAGE_FLOOR, 0.9);
        const problems = verifyOpenapiCoverage({}, snapshot(100, 200));
        assert.strictEqual(problems.length, 1, problems.join('\n'));
        assert.match(problems[0], /floor 0\.9\b/);
        assert.deepStrictEqual(verifyOpenapiCoverage({}, snapshot(190, 200)), []);
    });

    it('refuses a floor that is not a ratio, rather than coercing it', () => {
        for (const bad of [0, -0.1, 1.5, '0.9', null]) {
            const problems = verifyOpenapiCoverage({ openapi: { coverageFloor: bad } }, snapshot(190, 200));
            assert.strictEqual(problems.length, 1, `floor ${JSON.stringify(bad)} was accepted`);
            assert.match(problems[0], /openapi\.coverageFloor/);
        }
    });

    it('refuses a snapshot with no denominator instead of reporting 0 coverage', () => {
        // coverageRatio answers 0 for an empty denominator, which would read as a total regression
        // when the real fault is that the route inventory found nothing at all.
        assert.strictEqual(coverageRatio(10, 0), 0);
        const problems = verifyOpenapiCoverage({ openapi: { coverageFloor: 0.9 } }, snapshot(10, 0));
        assert.strictEqual(problems.length, 1, problems.join('\n'));
        assert.match(problems[0], /restSource\.endpointDeclarations/);
    });

    it('documents at least the committed share of the REST surface', () => {
        const current = collectSnapshot();
        const { operations, coverage } = current.openapi;
        const declarations = current.restSource.endpointDeclarations;
        console.log(
            `OpenAPI coverage: ${(coverage * 100).toFixed(2)}% — ${operations} operations documented ` +
                `of ${declarations} endpoint declarations.`,
        );
        const problems = verifyOpenapiCoverage(
            JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'f0-baseline.json'), 'utf8')),
            current,
        );
        assert.deepStrictEqual(problems, [], problems.join('\n'));
    });
});

describe('F0 live REST characterization', () => {
    it('keeps the API index response shape and version stable', async () => {
        const response = await request(app).get('/api/v1');
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(
            { name: response.body.name, version: response.body.version, routeKeys: Object.keys(response.body.routes || {}).sort() },
            {
                name: 'WordJS REST API',
                version: '1.0.0',
                routeKeys: [
                    'authentication', 'categories', 'chrome', 'comments', 'export', 'forms', 'hooks', 'import', 'media',
                    'menus', 'notices', 'notifications', 'plugins', 'posts', 'revisions', 'roles', 'settings',
                    'tags', 'taxonomies', 'themes', 'types', 'users', 'widgets',
                ].sort(),
            },
        );
    });

    it('keeps the unauthenticated content-write error contract stable', async () => {
        const response = await request(app).post('/api/v1/posts').send({ title: 'not written' });
        assert.strictEqual(response.status, 401);
        assert.deepStrictEqual(response.body, {
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 },
        });
    });
});

describe('F0 legacy content-type compatibility', () => {
    const slug = 'f0_legacy_probe';
    after(() => { postTypes.unregisterPostType(slug); });

    it('preserves defaults, labels and unknown extension keys', () => {
        const extension = { provider: 'legacy-plugin', version: 1 };
        const registered = postTypes.registerPostType(slug, {
            label: 'Legacy Probe',
            showInRest: false,
            supports: ['title', 'editor'],
            capability_type: 'probe',
            extension,
        });
        assert.strictEqual(registered.name, slug);
        assert.strictEqual(registered.label, 'Legacy Probe');
        assert.strictEqual(registered.labels.singular, 'Legacy Probe');
        assert.strictEqual(registered.labels.plural, 'Legacy Probe');
        assert.strictEqual(registered.showInRest, false);
        assert.strictEqual(registered.public, true);
        assert.strictEqual(registered.capability_type, 'probe');
        assert.deepStrictEqual(registered.supports, ['title', 'editor']);
        assert.strictEqual(registered.extension, extension, 'unknown plugin-owned keys must survive the F1 adapter');
        assert.strictEqual(postTypes.getPostType(slug), registered);
    });

    it('does not allow built-in types to be unregistered', () => {
        for (const type of ['post', 'page', 'attachment', 'revision', 'nav_menu_item']) {
            assert.strictEqual(postTypes.unregisterPostType(type), false, `${type} lost its built-in protection`);
        }
    });
});
