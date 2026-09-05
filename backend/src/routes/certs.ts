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
 * @swagger
 * tags:
 *   name: Certificates
 *   description: >-
 *     TLS certificate provisioning (ACME HTTP-01 and DNS-01), custom certificate upload, and the gateway
 *     TLS configuration. Every route here requires an administrator. These endpoints answer with a bare
 *     error envelope on failure, not the rest_* one.
 */
/**
 * POST /auto-provision
 * HTTP-01 Automated Flow
 */
/**
 * @swagger
 * /system/certs/auto-provision:
 *   post:
 *     summary: Provision a certificate over ACME HTTP-01
 *     description: Runs the whole HTTP-01 flow and installs the result on the gateway. Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [domain, email]
 *             properties:
 *               domain:
 *                 type: string
 *               email:
 *                 type: string
 *                 description: The ACME account email.
 *               staging:
 *                 type: boolean
 *                 description: Use the CA's staging directory instead of production.
 *     responses:
 *       200:
 *         description: Certificate provisioned and installed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Domain or email missing.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: Certificate provisioning failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
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
/**
 * @swagger
 * /system/certs/dns-start:
 *   post:
 *     summary: Begin an ACME DNS-01 challenge
 *     description: >-
 *       Step 1 of two. Returns the TXT record to publish, plus the order state that step 2 must be given
 *       back verbatim — it carries the ACME directory URL, so the second half cannot land on a different
 *       CA than the one that minted the challenge. Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [domain, email]
 *             properties:
 *               domain:
 *                 type: string
 *               email:
 *                 type: string
 *               staging:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: >-
 *           The challenge state. When `alreadyValid` is true the CA still holds a valid authorization,
 *           `txtValue` is null and there is nothing to publish — go straight to /dns-finish.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 domain:
 *                   type: string
 *                 alreadyValid:
 *                   type: boolean
 *                 txtRecord:
 *                   type: string
 *                 txtValue:
 *                   type: string
 *                   nullable: true
 *                   description: The final RFC 8555 TXT value. Publish it verbatim; never hash it again.
 *                 orderUrl:
 *                   type: string
 *                 authzUrl:
 *                   type: string
 *                 challenge:
 *                   type: object
 *                   nullable: true
 *                 keyAuthorization:
 *                   type: string
 *                   nullable: true
 *                 directoryUrl:
 *                   type: string
 *       400:
 *         description: Domain or email missing.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: The DNS challenge could not be started.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
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
/**
 * @swagger
 * /system/certs/dns-check:
 *   post:
 *     summary: Has the TXT record propagated yet?
 *     description: >-
 *       Pre-flight probe before /dns-finish. A lookup failure is reported as 200 with passed=false and an
 *       `error` string, not as a 5xx. Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               domain:
 *                 type: string
 *               expectedValue:
 *                 type: string
 *                 description: The txtValue returned by /dns-start.
 *     responses:
 *       200:
 *         description: The probe ran
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 passed:
 *                   type: boolean
 *                 error:
 *                   type: string
 *                   description: Present only when the lookup itself failed.
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
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
/**
 * @swagger
 * /system/certs/dns-finish:
 *   post:
 *     summary: Complete an ACME DNS-01 challenge
 *     description: >-
 *       Step 2 of two. `step1Data` must be the object /dns-start returned, unmodified. On success the
 *       certificate is installed and pushed to the gateway. Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [step1Data]
 *             properties:
 *               step1Data:
 *                 type: object
 *                 description: The response body of POST /system/certs/dns-start, passed back verbatim.
 *               email:
 *                 type: string
 *               staging:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Certificate issued and installed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: The DNS challenge could not be completed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
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
/**
 * @swagger
 * /system/certs/upload-custom:
 *   post:
 *     summary: Install an operator-supplied certificate
 *     description: PEM key and certificate chain, pasted as text. Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key, cert]
 *             properties:
 *               key:
 *                 type: string
 *                 description: PEM private key.
 *               cert:
 *                 type: string
 *                 description: PEM certificate, full chain.
 *     responses:
 *       200:
 *         description: Certificate installed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 path:
 *                   type: string
 *       400:
 *         description: Certificate or key content missing.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: The certificate could not be installed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
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
/**
 * @swagger
 * /system/certs/config:
 *   get:
 *     summary: Read the gateway's TLS configuration
 *     description: >-
 *       Probed over mTLS from the backend. When the gateway cannot be reached — or in monolith mode,
 *       where there is no separate gateway process — the fallback view is returned with `source` saying
 *       which, and an `error` string when the probe failed. Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The gateway TLS configuration as this node can see it
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 gatewayPort:
 *                   type: integer
 *                 sslEnabled:
 *                   type: boolean
 *                 certInfo:
 *                   type: object
 *                   nullable: true
 *                 siteUrl:
 *                   type: string
 *                   nullable: true
 *                 source:
 *                   type: string
 *                   description: Where the answer came from — e.g. the live gateway, monolith state, or the fallback.
 *                 error:
 *                   type: string
 *                   description: Present when the gateway could not be probed.
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "rest_forbidden (not an administrator) or mfa_enrollment_required."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: The gateway configuration could not be read.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 */
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
/**
 * @swagger
 * /system/certs/check:
 *   post:
 *     summary: Ensure the gateway has a certificate
 *     description: >-
 *       Generates and pushes a self-signed certificate when the gateway has none; a no-op when one is
 *       already installed. Takes no body. Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     responses:
 *       200:
 *         description: >-
 *           The outcome. A FAILURE is reported here as success=false with an `error` string, not as a
 *           5xx — the 500 below is for an unexpected throw.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 error:
 *                   type: string
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: The gateway certificate could not be ensured.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
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
/**
 * @swagger
 * /system/certs/config:
 *   post:
 *     summary: Update the gateway's port and TLS switch
 *     description: >-
 *       Pushed to the gateway over mTLS. Turning SSL on additionally ensures a certificate exists,
 *       generating a self-signed one if necessary. Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               port:
 *                 type: integer
 *               sslEnabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: The gateway's answer to the configuration push
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: The gateway configuration could not be updated.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
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
/**
 * @swagger
 * /system/certs/acme-config:
 *   get:
 *     summary: Read the auto-renewal settings
 *     description: >-
 *       Settings plus the last renewal outcome and the next scheduled run. No secrets are returned.
 *       Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Auto-renewal settings and status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 email:
 *                   type: string
 *                 domains:
 *                   type: array
 *                   items:
 *                     type: string
 *                 staging:
 *                   type: boolean
 *                 renewBeforeDays:
 *                   type: integer
 *                 challengeType:
 *                   type: string
 *                   enum: [http-01, dns-01]
 *                 http01Port:
 *                   type: integer
 *                   nullable: true
 *                 lastRenewal:
 *                   type: object
 *                   nullable: true
 *                   description: The recorded outcome of the last renewal attempt.
 *                 nextRun:
 *                   type: string
 *                   nullable: true
 *                   description: ISO-8601 timestamp of the next scheduled renewal check.
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "rest_forbidden (not an administrator) or mfa_enrollment_required."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: The auto-renewal settings could not be read.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
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
/**
 * @swagger
 * /system/certs/acme-config:
 *   post:
 *     summary: Save the auto-renewal settings
 *     description: >-
 *       FULL REPLACE, persisted to the config file and reflected into the live singleton so the renewal
 *       job sees the change immediately. Validation only runs when ENABLING — disabling always succeeds.
 *       Enabling also kicks a renewal check in the background without blocking the response.
 *       Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *               email:
 *                 type: string
 *                 description: ACME account email. Required, and at most 254 characters, when enabling.
 *               domains:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: At least one entry is required when enabling.
 *               staging:
 *                 type: boolean
 *               renewBeforeDays:
 *                 type: integer
 *                 default: 30
 *                 description: Anything not greater than zero falls back to 30.
 *               challengeType:
 *                 type: string
 *                 default: http-01
 *                 description: Any value other than dns-01 is stored as http-01.
 *                 enum: [http-01, dns-01]
 *               http01Port:
 *                 type: integer
 *     responses:
 *       200:
 *         description: The stored settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 acme:
 *                   type: object
 *       400:
 *         description: Enabling without a valid ACME account email, or without at least one domain.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: The configuration could not be written, or the settings could not be saved.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
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
/**
 * @swagger
 * /system/certs/renew-now:
 *   post:
 *     summary: Force a renewal attempt now
 *     description: >-
 *       Bypasses the not-due and disabled gates. Takes no body. Administrator only.
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     responses:
 *       200:
 *         description: >-
 *           The renewal record. A run that did nothing reports `skipped` with a `reason` (for example
 *           already_in_progress or recent_failure_backoff); an attempt reports `ok` with the domain, and
 *           on failure an `error`.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 skipped:
 *                   type: boolean
 *                 reason:
 *                   type: string
 *                 domain:
 *                   type: string
 *                 validTo:
 *                   type: string
 *                   nullable: true
 *                 error:
 *                   type: string
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid, or
 *           mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: The renewal attempt failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
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
