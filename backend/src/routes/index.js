/**
 * WordJS - Routes Index
 * Combines all API routes
 */

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
const exportRoutes = require('./export');
const setupRoutes = require('./setup');
const rolesRoutes = require('./roles');
const notificationsRoutes = require('./notifications');
const certsRoutes = require('./certs');
const seoRoutes = require('./seo');
const healthRoutes = require('./health');

// API Info endpoint
router.get('/', (req, res) => {
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
            export: '/api/v1/export',
            import: '/api/v1/import',
            roles: '/api/v1/roles',
            notifications: '/api/v1/notifications'
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
router.use('/themes', themesRoutes);
router.use('/menus', menusRoutes);
router.use('/widgets', widgetsRoutes);
router.use('/revisions', revisionsRoutes);
router.use('/types', postTypesRoutes);
router.use('/setup', setupRoutes);
router.use('/roles', rolesRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/fonts', require('./fonts'));
router.use('/system/certs', certsRoutes);
router.use('/health', healthRoutes);
router.use('/seo', seoRoutes);
router.use('/', exportRoutes);

// Pages endpoint (alias for posts with type=page)
router.get('/pages', (req, res, next) => {
    req.query.type = 'page';
    postsRoutes.handle(req, res, next);
});

// Documentation
const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('../config/swagger');
const swaggerTheme = require('../config/swagger-theme');

router.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs, {
    customCss: swaggerTheme,
    customSiteTitle: "WordJS API Documentation"
}));

module.exports = router;
