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

    // Surface the TRUE plugin-sandbox hardening state so an admin can see whether isolated plugins actually
    // get the OS backstop (bwrap+seccomp) or silently run with JS guards only — the audit's "no admin-visible
    // signal" gap. The state is populated the first time an isolated plugin activates (the probe runs lazily).
    //
    // WHAT CHANGED WHEN WINDOWS AND macOS GOT KERNEL LAYERS OF THEIR OWN. `hardening` and `netns` are, and
    // remain, bwrap-specific: off Linux they say 'unsupported', which is the honest answer to "is bubblewrap
    // confining this plugin?" but a MISLEADING answer to "is anything confining it at the kernel level?".
    // Those are different questions, so they now get different fields. `kernel` names the mechanism THIS
    // platform has (bwrap / appcontainer / seatbelt / none) alongside its real state, which is what lets an
    // operator distinguish the two situations that used to look identical and that demand opposite actions:
    //   · mechanism 'none'  + state 'unsupported' → this OS has no such layer; stop looking.
    //   · mechanism named   + state 'disabled'    → the layer exists here and nobody turned it on.
    //   · mechanism named   + state 'degraded'    → it was turned ON and it is NOT there. Go fix this.
    static checkSandbox() {
        let hardening = 'unknown';
        let netns = 'unknown';
        let permission = 'unknown';
        let kernel: any = null;
        try {
            const iso = require('./plugin-isolate');
            hardening = iso.getSandboxHardeningState();
            if (typeof iso.getSandboxNetnsState === 'function') netns = iso.getSandboxNetnsState();
            if (typeof iso.getPermissionModelState === 'function') permission = iso.getPermissionModelState();
            if (typeof iso.getSandboxPlatformConfinement === 'function') kernel = iso.getSandboxPlatformConfinement();
        } catch { /* isolate module unavailable */ }
        const requireHardening = !!(config.sandbox && config.sandbox.requireHardening);
        // `status` follows the PLATFORM layer, not bwrap, because it answers "is this host's kernel
        // confinement in force?" — and on a Mac or a Windows box bwrap can never answer that. On Linux the
        // two states are the same value by construction, so this is unchanged there. Falls back to the
        // bwrap state if the isolate module is too old to expose the platform one.
        const effective = (kernel && kernel.state) || hardening;
        const status =
            effective === 'active' ? 'OK' :
            effective === 'degraded' ? (requireHardening ? 'REFUSING' : 'DEGRADED') :
            effective === 'unknown' ? 'UNKNOWN' :
            'NOT_HARDENED'; // no mechanism on this platform, or the operator did not enable it
        // netns is a SEPARATE kernel backstop for NON-network plugins (bwrap --unshare-net): 'active' = they
        // get an empty net namespace; 'degraded' = base hardening active but this host restricts CLONE_NEWNET
        // (non-network plugins keep the JS network neuter only). It never gates plugin launch.
        // `permission` is the only OS-level confinement that is NOT Linux-only, so on Windows/macOS it is
        // the difference between "process separation plus JS guards" and an actual kernel-enforced boundary.
        // Report it next to the Linux-only states rather than folding it into `status`: a host can be
        // NOT_HARDENED (no bwrap) and still have capability confinement, and that distinction is the whole
        // point of having it.
        const out: any = { status, hardening, netns, permission, requireHardening };
        // The per-platform block. `kernel.mechanism` is what this OS HAS; `kernel.state` is what this HOST
        // got; `kernel.note` says what it means and, when there is one, what to do about it. `appliesTo`
        // is stated rather than assumed because it is not the same everywhere: bwrap wraps every isolated
        // child, while AppContainer/Seatbelt are applied only to plugins WITHOUT the `network` grant.
        if (kernel) {
            out.platform = kernel.platform;
            out.kernel = kernel;
            // TRUE only in the "someone turned it on and it is not there" state — the one that needs a
            // human. 'unsupported' and 'disabled' are chosen postures and must never trip an alarm.
            out.kernelDegraded = kernel.state === 'degraded';
        }
        if (permission === 'unsupported') out.permissionNote = 'this Node does not enforce a permission model — isolated plugins rely on process separation + the JS guards for capability confinement (upgrade Node to add an OS-enforced floor)';
        else if (permission === 'disabled') out.permissionNote = 'capability confinement is OFF (sandbox.usePermissionModel=false)';
        if (hardening === 'degraded') out.note = 'kernel hardening is ENABLED but unavailable on this host — isolated plugins run WITHOUT the OS backstop (install bubblewrap + unprivileged userns, or set sandbox.requireHardening=true to fail closed)';
        else if (hardening === 'unknown' && (!kernel || kernel.state === 'unknown')) out.note = 'no isolated plugin has activated yet (the confinement probes run on first load)';
        else if (hardening === 'active' && netns === 'degraded') out.note = 'kernel hardening ACTIVE, but network-namespace isolation (--unshare-net) is unavailable on this host (CLONE_NEWNET restricted or old bwrap) — non-network plugins keep the JS network neuter without the kernel netns backstop';
        else if (kernel && kernel.mechanism !== 'bwrap' && kernel.mechanism !== 'none') {
            // Off Linux, `hardening: 'unsupported'` is the literal truth about bubblewrap and would read
            // as "nothing protects this box". Say plainly which layer this platform actually has and what
            // its state is, so nobody has to infer it from a field named after a different mechanism.
            out.note = `bubblewrap is Linux-only (hardening: '${hardening}' is about bwrap, not about this host's confinement). This platform's kernel layer is ${kernel.mechanism} and it is '${kernel.state}': ${kernel.note}`;
        }
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
