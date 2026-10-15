/**
 * WordJS - GraphQL endpoint (read-only, phase 1)
 *
 * Mounted at /api/v1/graphql by routes/index, i.e. behind every app-level control the REST API has: host
 * gate, CORS, the API rate limiter, CSRF (a cookie-authenticated POST needs X-CSRF-Token exactly like any
 * REST write; GET is a safe method), the install funnel and the MFA compliance gate. It works unchanged in
 * monolith, split and separate modes because the gateway routes every /api/* path to the backend.
 *
 * Transport: graphql-http (the GraphQL-over-HTTP reference implementation) — GET for queries, POST with
 * application/json. Only `query` operations exist in the schema; a mutation or subscription is refused
 * by validation because the schema has no root type for it.
 *
 * Authorization lives in the resolvers' REST sub-requests (core/graphql/dispatch) — nothing here decides
 * who may see what.
 */

import type { Request, Response, NextFunction } from 'express';

const express = require('express');
const { createHandler } = require('graphql-http/lib/use/express');
const { specifiedRules, GraphQLError } = require('graphql');
const graphql = require('../core/graphql');

const router = express.Router();

const handler = createHandler({
    schema: () => graphql.getSchema(),
    parse: graphql.parseWithLimits,
    validationRules: async () => [...specifiedRules, ...(await graphql.extraValidationRules())],
    context: (req: { raw: Request }) => ({
        req: req.raw,
        rest: graphql.createRestClient(req.raw),
        maxPageSize: graphql.MAX_PAGE_SIZE,
    }),
    formatError: (err: any) => {
        // A resolver crash is a bug, not a contract: do not hand its message (or stack) to the client.
        // GraphQLErrors raised on purpose (REST refusals, bad input, limits) keep their message/extensions.
        if (err && err.originalError && !(err.originalError instanceof GraphQLError)) {
            console.error('[graphql] resolver error:', err.originalError);
            return new GraphQLError('Internal server error.', {
                nodes: err.nodes, path: err.path, extensions: { code: 'INTERNAL_SERVER_ERROR' },
            });
        }
        return err;
    },
});

/**
 * @swagger
 * /graphql:
 *   get:
 *     summary: GraphQL (read-only) — query over GET
 *     description: Executes a GraphQL query passed as the `query` parameter (plus optional `variables` JSON and `operationName`). Every field is resolved through the corresponding REST read for the SAME caller, so visibility is identical to the REST API. Depth, cost, token and page-size limits apply; introspection is off in production unless the graphql_introspection setting enables it. See documentation/graphql.md.
 *     tags: [GraphQL]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     parameters:
 *       - in: query
 *         name: query
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: variables
 *         schema:
 *           type: string
 *       - in: query
 *         name: operationName
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A GraphQL response ({ data, errors })
 *       400:
 *         description: Malformed request, or a document refused by validation (including the depth/cost limits)
 *   post:
 *     summary: GraphQL (read-only) — query over POST
 *     description: Same as GET, with a JSON body { query, variables, operationName }. A cookie-authenticated POST needs the X-CSRF-Token header, as every REST write does.
 *     tags: [GraphQL]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *               variables:
 *                 type: object
 *               operationName:
 *                 type: string
 *     responses:
 *       200:
 *         description: A GraphQL response ({ data, errors })
 *       400:
 *         description: Malformed request, or a document refused by validation (including the depth/cost limits)
 */
router.all('/', (req: Request, res: Response, next: NextFunction) => {
    // Responses depend on the caller's identity and are never shared-cacheable.
    res.setHeader('Cache-Control', 'no-store');
    Promise.resolve(handler(req, res)).catch(next);
});

module.exports = router;
