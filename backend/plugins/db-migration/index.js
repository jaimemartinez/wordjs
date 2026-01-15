exports.init = function () {
    const express = require('express');
    const router = express.Router();
    const routerPath = '/api/v1/db-migration';
    const { getApp } = require('../../src/core/appRegistry');
    const { registerAdminMenu } = require('../../src/core/adminMenu');
    const migration = require('./core/migration');
    const embedded = require('./core/embedded');

    const { authenticate } = require('../../src/middleware/auth');
    const { can } = require('../../src/middleware/permissions');

    // Secure all routes in this router
    router.use(authenticate);
    router.use(can('manage_options'));

    // API Routes
    router.get('/status', migration.getStatus);
    router.post('/migrate', migration.runMigration);
    router.post('/cleanup', migration.cleanup);

    // Embedded Server Routes
    router.get('/embedded/status', embedded.getStatus);
    router.post('/embedded/install', embedded.install);
    router.post('/embedded/start', embedded.start);
    router.post('/embedded/stop', embedded.stop);

    // Register API
    getApp().use(routerPath, router);

    // Register Menu
    registerAdminMenu('db-migration', {
        href: '/admin/plugin/db-migration',
        label: 'DB Migration',
        icon: 'fa-exchange',
        order: 999,
        cap: 'manage_options'
    });

    console.log('✅ DB Migration Plugin loaded.');
};
