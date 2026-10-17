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

// The published version is the product's (config/product-version): /api-docs and GET /api/v1/ share it.
const { resolveProductVersion } = require('./product-version');

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
    // THE APP ENTRY IS A SOURCE OF OPERATIONS TOO, and leaving it out of this list made four of them
    // invisible. /healthz, /readyz, /metrics and /api are declared with app.get() in src/index.ts, at the
    // server ROOT rather than under the /api/v1 prefix; each carries its own `servers` block saying so, so
    // documenting them here states where they really live instead of implying a prefix they do not have.
    // src/tests/swagger-spec.test.ts re-runs THESE globs strictly and indexes the same files for source
    // locations - it READS them off the export below rather than restating them, so the three lists
    // cannot come apart.
    apis: [asGlob('../routes/*.{ts,js}'), asGlob('../models/*.{ts,js}'), asGlob('../index.{ts,js}')], // Path to the API docs
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

/**
 * THE GLOBS SWAGGER-JSDOC REALLY SCANNED, exposed so no second copy of them can exist.
 *
 * src/tests/swagger-spec.test.ts re-runs the same sources with `failOnErrors: true` (the strict pass
 * this module deliberately does NOT do, because /api-docs must keep serving) and indexes the same
 * files to turn a JSON pointer into a `file:line`. It used to retype the list as a literal, so a glob
 * added or dropped here left the strict gate and the source index silently checking a DIFFERENT set of
 * files — a comment saying "keep the three lists in step" is not a gate, which is this batch's own
 * stated philosophy applied to itself.
 *
 * NON-ENUMERABLE ON PURPOSE. `module.exports` IS the OpenAPI document: it is serialised to /api-docs,
 * meta-schema-validated by @apidevtools/swagger-parser, and hashed into the F0 baseline. OpenAPI 3.0
 * forbids unknown root fields that do not start with `x-`, so an ordinary property would make the
 * document invalid and move the baseline hash. Hidden from Object.keys and JSON.stringify, this is
 * reachable from a require() and invisible to every consumer that walks the document.
 */
Object.defineProperty(module.exports, '__apis', {
    value: Object.freeze([...options.apis]),
    enumerable: false,
    writable: false,
    configurable: false,
});
