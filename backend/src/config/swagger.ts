const swaggerJsdoc = require('swagger-jsdoc');

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
    apis: ['./src/routes/*.js', './src/models/*.js'], // Path to the API docs
};

const specs = swaggerJsdoc(options);

module.exports = specs;
