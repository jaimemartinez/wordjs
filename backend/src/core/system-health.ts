const fs = require('fs');
const path = require('path');
const { db, dbAsync } = require('../config/database');
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
            contentOutbox: await this.checkContentOutbox(),
            timestamp: new Date().toISOString()
        };
    }

    /** Durable F3 event delivery must never fail invisibly. */
    static async checkContentOutbox() {
        try {
            const { databaseNowSeconds } = require('./content-outbox');
            const now = await databaseNowSeconds();
            const row = await dbAsync.get(
                `SELECT
                   SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                   SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
                   SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
                   MIN(CASE
                       WHEN status = 'pending' THEN available_at
                       WHEN status = 'processing' THEN claimed_until
                       ELSE NULL
                   END) AS oldest_due
                 FROM content_outbox`
            );
            const pending = Number(row?.pending || 0);
            const processing = Number(row?.processing || 0);
            const dead = Number(row?.dead || 0);
            const oldestDue = row?.oldest_due == null ? null : Number(row.oldest_due);
            const delayedSeconds = oldestDue == null ? 0 : Math.max(0, now - oldestDue);
            const status = dead > 0 ? 'ERROR' : delayedSeconds > 300 ? 'DEGRADED' : 'OK';
            return {
                status,
                pending,
                processing,
                dead,
                oldestDue,
                delayedSeconds,
                ...(dead ? { note: 'One or more committed content events exhausted retries; inspect content_outbox.last_error.' } : {}),
            };
        } catch (error: any) {
            return { status: 'UNKNOWN', pending: 0, processing: 0, dead: 0, note: `content outbox state unavailable: ${error?.message || error}` };
        }
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

    /**
     * REPORT THE OUTCOME, NOT THE RULE. Pure, so every combination can be exercised.
     *
     * This used to be inline and read `… : requireHardening ? 'REFUSING' : …`, which is the POLICY.
     * Whether a launch is actually refused is a DECISION the launcher takes, and it exempts the
     * source-only Windows ts-node worker — so on that host this surface reported **REFUSING** while
     * isolated plugins were starting with no AppContainer at all. A monitoring surface that states
     * the rule instead of the outcome is worse than silence, because an operator believes it.
     *
     * It is a separate pure function for a reason found the hard way: while it was inline, the only
     * available test was "ask this host", and this host happens to be exempt — so BOTH the `wouldRefuse`
     * branch and the exempt branch produced a correct answer, each masking the absence of the other.
     * A drill that removed one and stayed green is what exposed that. Every row of the matrix is now
     * reachable from a test on any platform.
     */
    static sandboxStatusFor(o: { effective: string; posture: any; requireHardening: boolean }): { status: string; hardeningExempt: boolean } {
        const { effective, posture, requireHardening } = o;
        if (effective === 'active') return { status: 'OK', hardeningExempt: false };
        if (effective === 'unknown') return { status: 'UNKNOWN', hardeningExempt: false };

        // The launcher's own answer when we have it; the policy only as a last resort, and then
        // conservatively (claiming refusal we cannot confirm is the failure mode being removed, so
        // without a posture we still prefer the policy over nothing — but say so via postureNote).
        const refusing = posture ? !!posture.wouldRefuse : requireHardening;
        if (refusing) return { status: 'REFUSING', hardeningExempt: false };

        // Policy demands hardening, the host is not hardened, and plugins start anyway because this
        // platform/worker is exempt. An operator must never have to infer this one.
        if (posture && posture.exempt && !posture.confined) {
            return { status: 'NOT_HARDENED_EXEMPT', hardeningExempt: true };
        }
        if (effective === 'degraded') return { status: 'DEGRADED', hardeningExempt: false };
        return { status: 'NOT_HARDENED', hardeningExempt: false };
    }

    // Surface the native sandbox using one vocabulary on Linux, Windows and macOS.
    static checkSandbox() {
        let hardening = 'unknown';
        let permission = 'unknown';
        let kernel: any = null;
        let posture: any = null;
        try {
            const iso = require('./plugin-isolate');
            hardening = iso.getSandboxHardeningState();
            if (typeof iso.getPermissionModelState === 'function') permission = iso.getPermissionModelState();
            if (typeof iso.getSandboxPlatformConfinement === 'function') kernel = iso.getSandboxPlatformConfinement();
            if (typeof iso.isolatedLaunchPosture === 'function') posture = iso.isolatedLaunchPosture();
        } catch { /* isolate module unavailable */ }

        const requireHardening = posture ? posture.requireHardening : !!(config.sandbox && config.sandbox.requireHardening);
        const effective = (kernel && kernel.state) || hardening;
        const verdict = SystemHealth.sandboxStatusFor({ effective, posture, requireHardening });
        const out: any = { status: verdict.status, hardening, permission, requireHardening };
        if (posture) {
            out.confined = posture.confined;
            out.launchesRefused = posture.wouldRefuse;
            out.postureNote = posture.reason;
            if (verdict.hardeningExempt) out.hardeningExempt = true;
        }
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
