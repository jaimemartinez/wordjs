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

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'WordJS REST API',
            version: '1.0.0',
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

module.exports = specs;
