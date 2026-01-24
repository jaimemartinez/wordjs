const express = require('express');
const router = express.Router();
const certManager = require('../core/cert-manager');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');

// Middleware: Admin Only
router.use(authenticate);
router.use(isAdmin);

/**
 * POST /auto-provision
 * HTTP-01 Automated Flow
 */
router.post('/auto-provision', async (req, res) => {
    try {
        const { domain, email, staging } = req.body;
        if (!domain || !email) return res.status(400).json({ error: 'Domain and Email required' });

        const result = await certManager.provisionAutoHTTP(domain, email, !!staging);
        res.json(result);
    } catch (e) {
        console.error('Provision Error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /dns-start
 * Step 1 of DNS Flow
 */
router.post('/dns-start', async (req, res) => {
    try {
        const { domain, email, staging } = req.body;
        if (!domain || !email) return res.status(400).json({ error: 'Domain and Email required' });

        const data = await certManager.startDNSChallenge(domain, email, !!staging);
        res.json(data);
    } catch (e) {
        console.error('DNS Start Error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /dns-check
 * Verify DNS Propagation (Pre-flight)
 */
router.post('/dns-check', async (req, res) => {
    try {
        const { domain, expectedValue } = req.body;
        const passed = await certManager.checkDNSPropagation(domain, expectedValue);
        res.json({ passed });
    } catch (e) {
        res.json({ passed: false, error: e.message });
    }
});

/**
 * POST /dns-finish
 * Step 2 of DNS Flow
 */
router.post('/dns-finish', async (req, res) => {
    try {
        const { step1Data, email, staging } = req.body;
        await certManager.finishDNSChallenge(step1Data, email, !!staging);
        res.json({ success: true });
    } catch (e) {
        console.error('DNS Finish Error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /upload-custom
 * Upload manual certificate and key
 */
router.post('/upload-custom', async (req, res) => {
    try {
        const { key, cert } = req.body;
        if (!key || !cert) return res.status(400).json({ error: 'Certificate and Key content required' });

        const result = await certManager.installCustomCert(key, cert);
        res.json(result);
    } catch (e) {
        console.error('Custom Upload Error:', e);
        res.status(500).json({ error: e.message });
    }
});
router.get('/config', async (req, res) => {
    try {
        const config = certManager.getConfig();
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /config
 * Update Gateway Config
 */
router.post('/config', async (req, res) => {
    try {
        const { port, sslEnabled } = req.body;
        const result = certManager.updateGatewayConfig(port, sslEnabled);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
