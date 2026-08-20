const fs = require('fs');
const path = require('path');
const { db } = require('../config/database');
const config = require('../config/app');
const forge = require('node-forge');

class SystemHealth {
    static async getFullStatus() {
        return {
            database: await this.checkDatabase(),
            mtls: await this.checkMtls(),
            filesystem: await this.checkFilesystem(),
            sandbox: this.checkSandbox(),
            purge: this.checkPurge(),
            timestamp: new Date().toISOString()
        };
    }

    /**
     * On-demand cache invalidation: is it actually working, or has it been dead since boot?
     *
     * WHY THIS IS HERE (audit 2026-08-18 #27). In split mode the direct transport used to build its
     * TLS options half-way — it loaded the cluster CA but attached neither `key` nor `cert` — so every
     * purge died in the handshake against a frontend that starts with `requestCert: true` as soon as
     * the installer's certificates exist. The only trace was a once-an-hour `warnOnce` line, shared
     * with "the frontend happens to be down", and an operator therefore experienced a PERMANENT
     * misconfiguration as "the site is slow to update" — content stayed stale until the ISR window
     * expired (30s posts, 60s settings/menus, 120s plugin assets, 300s fonts).
     *
     * That distinction is the whole point of this field: `purgeFailureState()` only ever contains
     * failures that will repeat identically forever (a refused handshake, unreadable cluster
     * material). A transient outage never lands here, so a non-empty `broken` is always something a
     * human must go fix, and its emptiness is the positive signal that the channel is live.
     *
     * NEVER let this throw: /health/details is the page an operator opens when things are already
     * wrong, and a health check that 500s because a helper module failed to load is worse than one
     * that says "unknown".
     */
    static checkPurge() {
        try {
            const purge = require('./frontend-purge');
            const broken: string[] = typeof purge.purgeFailureState === 'function' ? purge.purgeFailureState() : [];
            const out: any = { status: broken.length ? 'BROKEN' : 'OK', broken };
            // Name the channel: "which transport is dead" is the first question after "is it dead".
            // Read the SITE config (wordjs-config.json), which is the exact object the purge flush
            // itself passes to purgeTransport — config/app is a different object with different
            // defaults, and answering from it would let this field disagree with reality.
            try {
                const siteConfig = require('./configManager').getConfig();
                if (siteConfig) {
                    const t = purge.purgeTransport(siteConfig);
                    out.transport = t.mode;
                    out.target = t.mode === 'gateway' ? `${t.host}:${t.port}` : t.origin;
                }
            } catch { /* transport is diagnostic only — never fail the check over it */ }
            if (broken.length) {
                out.note = 'on-demand cache invalidation is DEAD: published changes stay stale until the ISR window expires. This is a configuration fault, not an outage — it will not recover on its own.';
            }
            return out;
        } catch (e: any) {
            return { status: 'UNKNOWN', broken: [], note: `purge state unavailable: ${e && e.message}` };
        }
    }

    // Surface the native sandbox using one vocabulary on Linux, Windows and macOS.
    static checkSandbox() {
        let hardening = 'unknown';
        let permission = 'unknown';
        let kernel: any = null;
        try {
            const iso = require('./plugin-isolate');
            hardening = iso.getSandboxHardeningState();
            if (typeof iso.getPermissionModelState === 'function') permission = iso.getPermissionModelState();
            if (typeof iso.getSandboxPlatformConfinement === 'function') kernel = iso.getSandboxPlatformConfinement();
        } catch { /* isolate module unavailable */ }
        const requireHardening = !!(config.sandbox && config.sandbox.requireHardening);
        const effective = (kernel && kernel.state) || hardening;
        const status =
            effective === 'active' ? 'OK' :
            effective === 'unknown' ? 'UNKNOWN' :
            requireHardening ? 'REFUSING' :
            effective === 'degraded' ? 'DEGRADED' :
            'NOT_HARDENED';
        const out: any = { status, hardening, permission, requireHardening };
        if (kernel) {
            out.platform = kernel.platform;
            out.kernel = kernel;
            out.network = kernel.network && kernel.network.state;
            out.kernelDegraded = kernel.state === 'degraded';
        }
        if (permission === 'unsupported') out.permissionNote = 'this Node does not enforce a permission model — isolated plugins rely on process separation + the JS guards for capability confinement (upgrade Node to add an OS-enforced floor)';
        else if (permission === 'disabled') out.permissionNote = 'capability confinement is OFF (sandbox.usePermissionModel=false)';
        if (hardening === 'degraded') out.note = `the native ${kernel && kernel.mechanism || 'sandbox'} probe did not certify this host; isolated plugins run without that OS backstop${requireHardening ? ' and are refused' : ''}`;
        else if (hardening === 'unknown' && (!kernel || kernel.state === 'unknown')) out.note = 'no isolated plugin has activated yet (the confinement probes run on first load)';
        else if (kernel) out.note = `${kernel.mechanism} is '${kernel.state}': ${kernel.note}`;
        return out;
    }

    static async checkDatabase() {
        try {
            // Check connection by getting user count
            const User = require('../models/User');
            await User.count();
            return { status: 'OK', driver: config.dbDriver };
        } catch (err) {
            return { status: 'ERROR', message: err.message };
        }
    }

    static async checkMtls() {
        const certPath = path.resolve(config.mtls.cert);
        const caPath = path.resolve(config.mtls.ca);

        const status: any = {
            enabled: fs.existsSync(certPath) && fs.existsSync(caPath),
            cert: 'NOT_FOUND',
            ca: 'NOT_FOUND',
            expiry: null
        };

        if (fs.existsSync(certPath)) {
            status.cert = 'FOUND';
            try {
                const certPem = fs.readFileSync(certPath, 'utf8');
                const cert = forge.pki.certificateFromPem(certPem);
                status.expiry = cert.validity.notAfter;
                const now = new Date();
                status.status = (status.expiry > now) ? 'OK' : 'EXPIRED';
            } catch (e) {
                status.status = 'INVALID_FORMAT';
            }
        } else {
            status.status = 'NOT_CONFIGURED';
        }

        if (fs.existsSync(caPath)) status.ca = 'FOUND';

        return status;
    }

    static async checkFilesystem() {
        const dirs = [
            config.uploads.dir,
            './data',
            './plugins',
            './themes'
        ];

        const results: Record<string, string> = {};
        for (const dir of dirs) {
            const fullPath = path.resolve(dir);
            try {
                fs.accessSync(fullPath, fs.constants.W_OK);
                results[dir] = 'WRITABLE';
            } catch (e) {
                results[dir] = 'READ_ONLY_OR_MISSING';
            }
        }
        return results;
    }
}

module.exports = SystemHealth;
