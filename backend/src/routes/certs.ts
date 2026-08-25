import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const certManager = require('../core/cert-manager');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
// Every catch-all below answers 500 with the caught error. An error nobody recognised is the
// driver's, not ours, so its words go to the log and the caller gets the operation that failed.
// The rule itself lives in middleware/errorHandler — one decision, not one per surface.
const { publicErrorText } = require('../middleware/errorHandler');

// Middleware: Admin Only
router.use(authenticate);
router.use(isAdmin);

/**
 * POST /auto-provision
 * HTTP-01 Automated Flow
 */
router.post('/auto-provision', async (req: Request, res: Response) => {
    try {
        const { domain, email, staging } = req.body;
        if (!domain || !email) return res.status(400).json({ error: 'Domain and Email required' });

        const result = await certManager.provisionAutoHTTP(domain, email, !!staging);
        res.json(result);
    } catch (e) {
        console.error('Provision Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'Certificate provisioning failed.') });
    }
});

/**
 * POST /dns-start
 * Step 1 of DNS Flow
 */
router.post('/dns-start', async (req: Request, res: Response) => {
    try {
        const { domain, email, staging } = req.body;
        if (!domain || !email) return res.status(400).json({ error: 'Domain and Email required' });

        const data = await certManager.startDNSChallenge(domain, email, !!staging);
        res.json(data);
    } catch (e) {
        console.error('DNS Start Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'The DNS challenge could not be started.') });
    }
});

/**
 * POST /dns-check
 * Verify DNS Propagation (Pre-flight)
 */
router.post('/dns-check', async (req: Request, res: Response) => {
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
router.post('/dns-finish', async (req: Request, res: Response) => {
    try {
        const { step1Data, email, staging } = req.body;
        await certManager.finishDNSChallenge(step1Data, email, !!staging);
        res.json({ success: true });
    } catch (e) {
        console.error('DNS Finish Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'The DNS challenge could not be completed.') });
    }
});

/**
 * POST /upload-custom
 * Upload manual certificate and key
 */
router.post('/upload-custom', async (req: Request, res: Response) => {
    try {
        const { key, cert } = req.body;
        if (!key || !cert) return res.status(400).json({ error: 'Certificate and Key content required' });

        const result = await certManager.installCustomCert(key, cert);
        res.json(result);
    } catch (e) {
        console.error('Custom Upload Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'The certificate could not be installed.') });
    }
});
router.get('/config', async (req: Request, res: Response) => {
    try {
        const config = await certManager.getConfig();
        res.json(config);
    } catch (e) {
        console.error('Gateway Config Read Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'The gateway configuration could not be read.') });
    }
});

/**
 * POST /check
 * Ensure certificate exists (Generate Self-Signed if missing)
 */
router.post('/check', async (req: Request, res: Response) => {
    try {
        const result = await certManager.ensureGatewayCert();
        res.json(result);
    } catch (e) {
        console.error('Gateway Cert Check Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'The gateway certificate could not be ensured.') });
    }
});

/**
 * POST /config
 * Update Gateway Config
 */
router.post('/config', async (req: Request, res: Response) => {
    try {
        const { port, sslEnabled } = req.body;
        const result = await certManager.updateGatewayConfig(port, sslEnabled);

        // If SSL is being enabled, automatically ensure a certificate exists
        if (sslEnabled) {
            await certManager.ensureGatewayCert();
        }

        res.json(result);
    } catch (e) {
        console.error('Gateway Config Write Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'The gateway configuration could not be updated.') });
    }
});

/**
 * GET /acme-config
 * Current auto-renewal settings (no secrets) + last renewal outcome + next scheduled run.
 */
router.get('/acme-config', async (req: Request, res: Response) => {
    try {
        const config = require('../config/app');
        const { getOption } = require('../core/options');
        const { nextScheduled } = require('../core/cron');
        const acme = config.acme || {};
        const lastRenewal = await getOption('acme_last_renewal', null);
        let nextRun: string | null = null;
        try { const ts = await nextScheduled('wordjs_cert_renewal'); nextRun = ts ? new Date(ts).toISOString() : null; } catch { /* ignore */ }
        res.json({
            enabled: !!acme.enabled,
            email: acme.email || '',
            domains: acme.domains || [],
            staging: !!acme.staging,
            renewBeforeDays: acme.renewBeforeDays || 30,
            challengeType: acme.challengeType || 'http-01',
            http01Port: acme.http01Port || null,
            lastRenewal,
            nextRun
        });
    } catch (e) {
        console.error('ACME Config Read Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'The auto-renewal settings could not be read.') });
    }
});

/**
 * POST /acme-config
 * Persist auto-renewal settings to wordjs-config.json and reflect them into the live config.
 */
router.post('/acme-config', async (req: Request, res: Response) => {
    try {
        const { enabled, email, domains, staging, renewBeforeDays, challengeType, http01Port } = req.body || {};

        const domList: string[] = Array.isArray(domains)
            ? domains.map((d: any) => String(d).trim()).filter(Boolean)
            : [];

        // Validate only when enabling — disabling should always succeed.
        if (enabled) {
            const acmeEmail = String(email || '');  // single var so the length cap is the regex's barrier
            if (!email || acmeEmail.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(acmeEmail)) {
                return res.status(400).json({ error: 'A valid ACME account email is required to enable auto-renewal.' });
            }
            if (domList.length === 0) {
                return res.status(400).json({ error: 'At least one domain is required to enable auto-renewal.' });
            }
        }

        const newAcme: any = {
            enabled: !!enabled,
            email: email ? String(email).trim() : '',
            domains: domList,
            staging: !!staging,
            renewBeforeDays: Number(renewBeforeDays) > 0 ? Number(renewBeforeDays) : 30,
            challengeType: challengeType === 'dns-01' ? 'dns-01' : 'http-01'
        };
        if (http01Port) newAcme.http01Port = Number(http01Port);

        const { saveConfig } = require('../core/configManager');
        if (!saveConfig({ acme: newAcme })) {
            return res.status(500).json({ error: 'Failed to write configuration.' });
        }
        // Reflect into the live singleton so the renewal job sees the change immediately.
        const config = require('../config/app');
        config.acme = newAcme;

        // If enabling, kick a renewal check in the background (don't block the response).
        if (newAcme.enabled) {
            const certManager = require('../core/cert-manager');
            setImmediate(() => certManager.renewIfDue().catch(() => { }));
        }

        res.json({ success: true, acme: newAcme });
    } catch (e) {
        console.error('ACME Config Write Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'The auto-renewal settings could not be saved.') });
    }
});

/**
 * POST /renew-now
 * Force an immediate renewal attempt (bypasses the not-due/disabled gates).
 */
router.post('/renew-now', async (req: Request, res: Response) => {
    try {
        const result = await certManager.renewIfDue({ force: true });
        res.json(result);
    } catch (e) {
        console.error('Renew Now Error:', e);
        res.status(500).json({ error: publicErrorText(e, 'The renewal attempt failed.') });
    }
});

module.exports = router;
