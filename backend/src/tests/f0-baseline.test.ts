/** F0 machine-readable architecture and compatibility contracts. */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { verify } = require('../../scripts/verify-f0-baseline');
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
