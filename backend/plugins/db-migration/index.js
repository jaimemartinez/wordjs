exports.init = function () {
    const express = require('express');
    const router = express.Router();
    const routerPath = '/api/v1/db-migration';
    const { getApp } = require('../../src/core/appRegistry');
    const { registerAdminMenu } = require('../../src/core/adminMenu');
    const migration = require('./core/migration');

    // API Routes
    router.get('/status', migration.getStatus);
    router.post('/migrate', migration.runMigration);

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
