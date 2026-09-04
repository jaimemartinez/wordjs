const swaggerJsdoc = require('swagger-jsdoc');
const path = require('path');

// swagger-jsdoc scans SOURCE files for @swagger JSDoc comments. The globs must
// resolve against THIS module's own directory (not process.cwd(), which varies
// by how the server was launched) and must carry the right extension for the
// tier we are running from: `.ts` when loaded via ts-node from src/, `.js` when
// loaded from the compiled dist/ (tsc keeps the comments, verified). A single
// `{ts,js}` brace pattern covers both. Paths are forced to forward slashes:
// the underlying glob library treats a backslash as an escape character, so a
// native Windows absolute path silently matches nothing (this was half the bug
// — the other half was the extension: the old glob was `*.js` relative to cwd,
// which matched zero .ts source files and produced a spec with zero paths).
const asGlob = (p: string): string =>
    path.resolve(__dirname, p).split(path.sep).join('/');

// THE PUBLISHED API VERSION WAS A CONSTANT, AND CONSTANTS GO STALE SILENTLY.
//
// `version` here was hardcoded '1.0.0' while the product shipped 2.1.0 — so /api-docs, the spec
// every integrator reads and every generated client stamps into its own metadata, had been
// announcing a version that stopped being true at the first release. Nothing could catch it: a
// literal cannot drift, it is simply wrong, and no test compared it to anything.
//
// Derive it instead. The root package.json is the manifest the release tag bumps (backend's is
// bumped in lockstep), and both sit at a FIXED depth from this module in either tier — `src/config`
// and `dist/config` are both two levels under `backend/`, so `../../../package.json` is the repo (or
// extracted bundle) root from either.
//
// Never throw. This module is required by the docs router at request time; a missing or unreadable
// manifest must degrade the version string, not take the API documentation endpoint down with it —
// which is exactly what an uncaught require() of an absent file would do.
const resolveProductVersion = (): string => {
    const candidates = [
        path.resolve(__dirname, '../../../package.json'), // repo / extracted-bundle root: the release manifest
        path.resolve(__dirname, '../../package.json'), // backend/package.json: bumped in lockstep
    ];
    for (const manifest of candidates) {
        try {
            const version = require(manifest).version;
            if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) {
                return version;
            }
        } catch {
            // Unreadable or absent — try the next candidate.
        }
    }
    console.warn(
        `[swagger] could not read a product version from ${candidates.join(' or ')} — ` +
            `serving 0.0.0 in the OpenAPI spec.`,
    );
    return '0.0.0';
};

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'WordJS REST API',
            version: resolveProductVersion(),
            description: 'API documentation for WordJS, a Node.js CMS.',
            license: {
                name: 'MIT',
                url: 'https://opensource.org/licenses/MIT',
            },
            contact: {
                name: 'WordJS Support',
                url: 'https://wordjs.org',
            },
        },
        servers: [
            {
                url: '/api/v1',
                description: 'V1 API',
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
        security: [
            {
                bearerAuth: [],
            },
        ],
    },
    apis: [asGlob('../routes/*.{ts,js}'), asGlob('../models/*.{ts,js}')], // Path to the API docs
};

const specs = swaggerJsdoc(options);

// F2: request DTOs for the generic content routes are projected from the same F1 declarations used
// by runtime validation and authorization. The docs module is loaded lazily, after normal server
// startup has registered custom schemas; isolated spec tests fall back to the pure core declarations.
const { buildContentOpenApiComponents } = require('../core/content-contract');
const { getContentTypeSchemas } = require('../core/post-types');
const { getBuiltinContentSchemas } = require('../core/content-schemas-builtins');
const registeredSchemas = getContentTypeSchemas({ showInRest: true });
const contentSchemas = registeredSchemas.length ? registeredSchemas : getBuiltinContentSchemas();
specs.components = specs.components || {};
specs.components.schemas = {
    ...(specs.components.schemas || {}),
    ...buildContentOpenApiComponents(contentSchemas),
};

const jsonBody = (schemaName: string) => ({
    required: true,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});
if (specs.paths?.['/posts']?.post) {
    specs.paths['/posts'].post.requestBody = jsonBody('ContentCreateInput');
    specs.paths['/posts'].post.responses = specs.paths['/posts'].post.responses || {};
    specs.paths['/posts'].post.responses['400'] = {
        description: 'Content contract validation failed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ContentValidationError' } } },
    };
}
if (specs.paths?.['/posts/{id}']?.put) {
    specs.paths['/posts/{id}'].put.requestBody = jsonBody('ContentUpdateInput');
    specs.paths['/posts/{id}'].put.responses = specs.paths['/posts/{id}'].put.responses || {};
    specs.paths['/posts/{id}'].put.responses['400'] = {
        description: 'Content contract validation failed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ContentValidationError' } } },
    };
}

module.exports = specs;
