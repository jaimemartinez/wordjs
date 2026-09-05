/**
 * WordJS - Routes Index
 * Combines all API routes
 */

import type { Request, Response, NextFunction } from 'express';

const express = require('express');
const router = express.Router();

// Import route modules
const authRoutes = require('./auth');
const postsRoutes = require('./posts');
const usersRoutes = require('./users');
const categoriesRoutes = require('./categories');
const tagsRoutes = require('./tags');
const commentsRoutes = require('./comments');
const mediaRoutes = require('./media');
const settingsRoutes = require('./settings');
const pluginsRoutes = require('./plugins');
const themesRoutes = require('./themes');
const menusRoutes = require('./menus');
const widgetsRoutes = require('./widgets');
const revisionsRoutes = require('./revisions');
const postTypesRoutes = require('./post-types');
const taxonomiesRoutes = require('./taxonomies');
const exportRoutes = require('./export');
const setupRoutes = require('./setup');
const rolesRoutes = require('./roles');
const notificationsRoutes = require('./notifications');
const certsRoutes = require('./certs');
const seoRoutes = require('./seo');
const healthRoutes = require('./health');
const hooksRoutes = require('./hooks');

// API Info endpoint
/**
 * @swagger
 * /:
 *   get:
 *     summary: REST API index
 *     description: The versioned API's own entry point - a map from area name to mounted path, so a client can discover the surface without reading the router. Unauthenticated, though it still sits behind the install guard like everything else under the prefix.
 *     tags: [System]
 *     security: []
 *     responses:
 *       200:
 *         description: The API banner and its route map
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 description:
 *                   type: string
 *                 version:
 *                   type: string
 *                 routes:
 *                   type: object
 *                   description: Area name to mounted absolute path.
 *                   additionalProperties:
 *                     type: string
 */
router.get('/', (req: Request, res: Response) => {
    res.json({
        name: 'WordJS REST API',
        description: 'WordPress-like CMS REST API',
        version: '1.0.0',
        routes: {
            authentication: '/api/v1/auth',
            posts: '/api/v1/posts',
            users: '/api/v1/users',
            categories: '/api/v1/categories',
            tags: '/api/v1/tags',
            comments: '/api/v1/comments',
            media: '/api/v1/media',
            settings: '/api/v1/settings',
            plugins: '/api/v1/plugins',
            themes: '/api/v1/themes',
            menus: '/api/v1/menus',
            widgets: '/api/v1/widgets',
            revisions: '/api/v1/revisions',
            types: '/api/v1/types',
            taxonomies: '/api/v1/taxonomies',
            export: '/api/v1/export',
            import: '/api/v1/import',
            roles: '/api/v1/roles',
            notifications: '/api/v1/notifications',
            notices: '/api/v1/notices',
            hooks: '/api/v1/hooks',
            forms: '/api/v1/forms',
            chrome: '/api/v1/chrome'
        }
    });
});

// Mount routes
router.use('/auth', authRoutes);
router.use('/posts', postsRoutes);
router.use('/users', usersRoutes);
router.use('/categories', categoriesRoutes);
router.use('/tags', tagsRoutes);
router.use('/comments', commentsRoutes);
router.use('/media', mediaRoutes);
router.use('/settings', settingsRoutes);
router.use('/plugins', pluginsRoutes);
router.use('/marketplace', require('./marketplace'));
router.use('/themes', themesRoutes);
router.use('/chrome', require('./chrome'));
router.use('/menus', menusRoutes);
router.use('/widgets', widgetsRoutes);
router.use('/revisions', revisionsRoutes);
router.use('/types', postTypesRoutes);
router.use('/taxonomies', taxonomiesRoutes);
router.use('/setup', setupRoutes);
router.use('/roles', rolesRoutes);
router.use('/notifications', notificationsRoutes);
// Admin notices get their OWN namespace (audit #30): they are not a setting, and living under
// /settings is what let `GET /settings/:key` shadow them into a permanent 403. /settings/notices
// still answers — routes/settings.ts mounts this very router there — but this is the canonical path
// and the one the /admin/notices screen calls.
router.use('/notices', require('./notices'));
router.use('/fonts', require('./fonts'));
router.use('/system/certs', certsRoutes);
router.use('/health', healthRoutes);
router.use('/seo', seoRoutes);
router.use('/hooks', hooksRoutes);
router.use('/webhooks', require('./webhooks'));
router.use('/audit', require('./audit'));
router.use('/forms', require('./forms'));
router.use('/presence', require('./presence'));
// Colaboración en tiempo real de Verso (SSE de bajada + POST de subida). Distinta de `/presence`,
// que es un aviso de "alguien más tiene esto abierto"; esta es la edición simultánea real.
router.use('/collab', require('./collab'));
router.use('/import', require('./import'));
router.use('/', exportRoutes);

// Pages endpoint (alias for posts with type=page)
/**
 * @swagger
 * /pages:
 *   get:
 *     summary: List pages - an alias for GET /posts with type=page
 *     description: The request is handed to the posts router with type forced to page, so every filter, header, authorization rule and response shape of GET /posts applies unchanged, including the X-WP-Total and X-WP-TotalPages headers and the refusal of a repeated scalar query parameter. A type sent by the caller is OVERWRITTEN, not merged - this endpoint cannot be used to list anything else.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: per_page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: orderby
 *         schema:
 *           type: string
 *           enum: [date, modified, title, id, menu_order]
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - in: query
 *         name: author
 *         description: Comma-separated author IDs and/or slugs, exactly as on GET /posts.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A list of pages
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Post'
 *       400:
 *         description: A malformed, unsupported or repeated scalar query parameter (rest_invalid_param)
 */
router.get('/pages', (req: Request, res: Response, next: NextFunction) => {
    req.query.type = 'page';
    postsRoutes.handle(req, res, next);
});

const { authenticate, CSRF_COOKIE, CSRF_HEADER } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');

// THE CSRF TOKEN, FOR "TRY IT OUT". swagger-ui calls the API with `credentials: 'same-origin'`, so a
// mutating request from the docs page arrives carrying the session cookie and NO `X-CSRF-Token` —
// precisely the shape `csrfTokenGate` refuses with `403 rest_csrf_token`. The fix is a
// `requestInterceptor`, but it runs in the BROWSER: swagger-ui-express@5 serialises any function found
// in `swaggerOptions` into the `swagger-ui-init.js` it generates (its `stringify()` swaps the value for
// a placeholder inside JSON.stringify and then substitutes the function's SOURCE back in — see
// `stringify` in node_modules/swagger-ui-express/index.js), so the function below is emitted as TEXT
// and must close over nothing on this side. The two names are therefore written out as literals and
// asserted at require time against the middleware's own exports, so they cannot drift from the gate
// that enforces them — without building the function from a string in the host process.
const CSRF_COOKIE_IN_DOCS_PAGE = 'wjs_csrf';
const CSRF_HEADER_IN_DOCS_PAGE = 'X-CSRF-Token';
if (CSRF_COOKIE_IN_DOCS_PAGE !== CSRF_COOKIE || CSRF_HEADER_IN_DOCS_PAGE !== CSRF_HEADER) {
    throw new Error(`API docs: the CSRF names baked into the Swagger page (${CSRF_COOKIE_IN_DOCS_PAGE}, ` +
        `${CSRF_HEADER_IN_DOCS_PAGE}) no longer match the middleware (${CSRF_COOKIE}, ${CSRF_HEADER})`);
}
// Self-contained on purpose (see above): browser globals only, no reference to anything in this module.
function csrfRequestInterceptor(request: any) {
    const COOKIE = 'wjs_csrf';
    const HEADER = 'X-CSRF-Token';
    const headers = request.headers || (request.headers = {});

    // Never touch a request that already carries the header: the Authorize button's Bearer flow needs
    // no token at all, and a header somebody set by hand is theirs, not ours.
    for (const name in headers) {
        if (name.toLowerCase() === HEADER.toLowerCase()) return request;
    }

    // The cookie is deliberately not HttpOnly — reading it here is the whole point of double-submit.
    const jar = String((globalThis as any).document.cookie || '').split(';');
    for (let i = 0; i < jar.length; i++) {
        const pair = jar[i].trim();
        const eq = pair.indexOf('=');
        if (eq <= 0 || pair.slice(0, eq) !== COOKIE) continue;
        let value = pair.slice(eq + 1);
        try { value = decodeURIComponent(value); } catch { /* not percent-encoded — send it raw */ }
        if (value) headers[HEADER] = value;
        break;
    }
    return request;
}

// Documentation — built LAZILY on the first /docs request. swaggerJsdoc parses every route and
// model file to produce the spec, which every boot paid for a page only admins ever open. The
// handler chain (authenticate → isAdmin) is unchanged and still runs before anything is built.
let swaggerHandlers: any[] | null = null;
function buildSwagger(): any[] {
    if (swaggerHandlers) return swaggerHandlers;
    const swaggerUi = require('swagger-ui-express');
    const swaggerSpecs = require('../config/swagger');
    const swaggerTheme = require('../config/swagger-theme');
    swaggerHandlers = [
        ...(Array.isArray(swaggerUi.serve) ? swaggerUi.serve : [swaggerUi.serve]),
        swaggerUi.setup(swaggerSpecs, {
            customCss: swaggerTheme,
            customSiteTitle: "WordJS API Documentation",
            swaggerOptions: {
                requestInterceptor: csrfRequestInterceptor,
            },
        }),
    ];
    return swaggerHandlers;
}

router.use('/docs', authenticate, isAdmin, (req: Request, res: Response, next: NextFunction) => {
    const chain = buildSwagger();
    let i = 0;
    const run = (err?: any): void => {
        if (err) return next(err);
        const h = chain[i++];
        if (!h) return next();
        try { h(req, res, run); } catch (e) { next(e); }
    };
    run();
});

module.exports = router;
