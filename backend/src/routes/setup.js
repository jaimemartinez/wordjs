const express = require('express');
const router = express.Router();
const { getConfig, saveConfig, isInstalled } = require('../core/configManager');
const config = require('../config/app');
const path = require('path');

// Check installation status
router.get('/status', (req, res) => {
    const installed = isInstalled();
    const currentConfig = getConfig();

    // Check for URL mismatch if installed
    let mismatch = false;
    let detectedUrl = '';

    if (installed && currentConfig && currentConfig.siteUrl) {
        // Fix: Trust upstream Gateway protocol
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        // Fix: Use X-Forwarded-Host if available (from Next.js proxy)
        const host = req.get('x-forwarded-host') || req.get('host');
        detectedUrl = `${protocol}://${host}`;

        // Simple normalization for comparison (remove trailing slash)
        // Remove protocol for safer comparison if protocol proxying is tricky
        const storedUrl = currentConfig.siteUrl.replace(/\/$/, '').replace(/^https?:\/\//, '');
        const currentHost = detectedUrl.replace(/^https?:\/\//, '');

        if (storedUrl !== currentHost) {
            mismatch = true;
        }
    }

    res.json({
        installed,
        mismatch,
        configUrl: currentConfig ? currentConfig.siteUrl : null,
        detectedUrl
    });
});

// Install endpoint
router.post('/install', async (req, res) => {
    if (isInstalled()) {
        return res.status(400).json({ error: 'Already installed' });
    }

    const {
        siteName,
        siteDescription,
        adminUser,
        adminEmail,
        adminPassword
    } = req.body;

    // Fix: Trust upstream Gateway protocol
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    const siteUrl = `${protocol}://${host}`;

    // Frontend URL could be inferred or passed. 
    // Ideally frontend sends its own URL.
    // For now we assume typical port + 1 or passed in body?
    // Let's assume passed or same host different port.
    // For zero-config on same domain, it might be same protocol/host/port if serving static?
    // But we are running separate servers.
    // Let's rely on the user/frontend telling us, or default logic.
    const frontendUrl = req.body.frontendUrl || siteUrl.replace(':3000', ':3001');

    // Save config
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');

    // SECURITY: Auto-generate cryptographically secure secrets
    const jwtSecret = crypto.randomBytes(64).toString('hex');
    const gatewaySecret = crypto.randomBytes(32).toString('hex');

    const newConfig = {
        siteUrl,
        frontendUrl,
        port: 4000,
        host: 'localhost',
        gatewaySecret: gatewaySecret,
        jwtSecret: jwtSecret // Store in config for reference
    };

    // Note: We no longer write to .env as per "Never Use Env Vars" policy.
    // Secrets are persisted solely in wordjs-config.json via saveConfig().

    if (saveConfig(newConfig)) {
        try {
            // Initialize DB connection dynamically (since index.js skipped it)
            console.log('📦 Setup: Initializing database...');
            const { init, initializeDatabase } = require('../config/database');
            await init();
            await initializeDatabase();

            // Update options in DB
            const { updateOption } = require('../core/options');
            updateOption('blogname', siteName);
            updateOption('blogdescription', siteDescription);
            updateOption('siteurl', siteUrl);
            updateOption('home', frontendUrl);

            // Initialize Roles & Capabilities (CRITICAL)
            const { loadRoles, syncRoles } = require('../core/roles');
            // We need to load config again or use newConfig to get roles if defined there
            // Usually roles are predefined in core/roles.js if passed empty
            await loadRoles();
            await syncRoles({});

            // Create Default Category
            const Term = require('../models/Term');
            await Term.create({
                name: 'Uncategorized',
                taxonomy: 'category',
                slug: 'uncategorized',
                description: 'Default category'
            });

            // Create Default Theme
            const { createDefaultTheme } = require('../core/themes');
            createDefaultTheme();

            // Create admin user
            const User = require('../models/User');
            // Check if admin exists, if not create
            const adminLink = adminEmail || `${adminUser}@no-email.local`;

            // Try detection by email OR username
            let admin = await User.findByEmail(adminLink);
            if (!admin) {
                admin = await User.findByLogin(adminUser);
            }

            if (!admin) {
                await User.create({
                    username: adminUser,
                    email: adminLink,
                    password: adminPassword,
                    displayName: 'Administrator',
                    role: 'administrator'
                });
            } else {
                // Update existing admin
                await User.update(admin.id, {
                    password: adminPassword,
                    email: adminLink,
                    role: 'administrator'
                });
            }

            // Run CMS core tests to verify system integrity
            const { runCoreTests } = require('../core/plugin-test-runner');
            const testResults = await runCoreTests();

            if (!testResults.success) {
                console.warn(`⚠️ CMS core tests had failures (${testResults.failed}/${testResults.tests})`);
                // We don't block installation, just warn
            }

            res.json({
                success: true,
                tests: {
                    total: testResults.tests,
                    passed: testResults.passed,
                    failed: testResults.failed
                }
            });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: 'Setup failed during DB ops' });
        }
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Migration endpoint
router.post('/migrate', async (req, res) => {
    if (!isInstalled()) {
        return res.status(400).json({ error: 'Not installed' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(401).json({ error: 'Authentication required. Please provide admin credentials.' });
    }

    try {
        const User = require('../models/User');
        const user = await User.authenticate(username, password);

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (user.getRole() !== 'administrator') {
            return res.status(403).json({ error: 'Permission denied. Only administrators can migrate the site.' });
        }

        // Fix: Trust upstream Gateway protocol
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        // Host from proxy
        const host = req.get('x-forwarded-host') || req.get('host');
        const newSiteUrl = `${protocol}://${host}`;

        // Update config
        const currentConfig = getConfig();

        // Infer new frontend URL
        // If current backend is localhost:3000 and frontend is localhost:3001
        // And new backend is ip:3000
        // We assume new frontend is ip:3001

        let newFrontendUrl = currentConfig.frontendUrl;
        try {
            const oldHostname = new URL(currentConfig.siteUrl).hostname;
            const newHostname = new URL(newSiteUrl).hostname;
            newFrontendUrl = currentConfig.frontendUrl.replace(oldHostname, newHostname);
        } catch (e) {
            console.warn('Could not infer new frontend URL, keeping old one');
        }

        const newConfig = {
            ...currentConfig,
            siteUrl: newSiteUrl,
            frontendUrl: newFrontendUrl
        };

        if (saveConfig(newConfig)) {
            // Update DB options
            const { updateOption } = require('../core/options');
            updateOption('siteurl', newConfig.siteUrl);
            updateOption('home', newConfig.frontendUrl);

            res.json({ success: true, newConfig });
        } else {
            res.status(500).json({ error: 'Failed to save new configuration' });
        }
    } catch (e) {
        console.error(e);
        return res.status(401).json({ error: e.message || 'Authentication failed' });
    }
});

module.exports = router;
