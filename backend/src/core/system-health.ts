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
            timestamp: new Date().toISOString()
        };
    }

    // Surface the TRUE plugin-sandbox hardening state so an admin can see whether isolated plugins actually
    // get the OS backstop (bwrap+seccomp) or silently run with JS guards only — the audit's "no admin-visible
    // signal" gap. The state is populated the first time an isolated plugin activates (the probe runs lazily).
    static checkSandbox() {
        let hardening = 'unknown';
        try { hardening = require('./plugin-isolate').getSandboxHardeningState(); } catch { /* isolate module unavailable */ }
        const requireHardening = !!(config.sandbox && config.sandbox.requireHardening);
        const status =
            hardening === 'active' ? 'OK' :
            hardening === 'degraded' ? (requireHardening ? 'REFUSING' : 'DEGRADED') :
            hardening === 'unknown' ? 'UNKNOWN' :
            'NOT_HARDENED'; // 'unsupported' (non-Linux) or 'disabled'
        const out: any = { status, hardening, requireHardening };
        if (hardening === 'degraded') out.note = 'kernel hardening is ENABLED but unavailable on this host — isolated plugins run WITHOUT the OS backstop (install bubblewrap + unprivileged userns, or set sandbox.requireHardening=true to fail closed)';
        else if (hardening === 'unknown') out.note = 'no isolated plugin has activated yet (the hardening probe runs on first load)';
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
