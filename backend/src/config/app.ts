const fs = require('fs');
const path = require('path');

export interface AppConfig {
    // Server
    port: number;
    host: string;
    // Routable address other nodes (the gateway) use to reach THIS backend. Defaults to 127.0.0.1
    // (single host); set per-node to the node's reachable IP/DNS name for a multi-node deployment.
    advertiseHost: string;
    gatewayPort: number;
    siteUrl: string;
    frontendUrl: string;

    // Database (flat defaults + driver selection)
    dbDriver: string;
    dbPath: string;

    // Secrets
    jwtSecret: string;
    dbPassword?: string;

    // Normalized SSL
    ssl: { enabled: boolean };

    // Normalized DB connection object
    db: {
        host: string;
        port: number;
        user: string;
        password: string;
        name: string;
        ssl: boolean;
    };

    // Uploads
    uploads: {
        dir: string;
        maxFileSize: number;
    };

    // API
    api: {
        prefix: string;
    };

    // Site
    site: {
        url: string;
        name: string;
        description: string;
    };

    // Roles
    roles: Record<string, any>;

    // Environment
    nodeEnv: string;

    // JWT
    jwt: {
        secret: string;
        expiresIn: string;
    };

    // mTLS
    mtls: {
        ca: string;
        key: string;
        cert: string;
    };

    // ACME / Let's Encrypt auto-renewal
    acme: {
        enabled: boolean;
        email: string;
        domains: string[];
        staging: boolean;
        renewBeforeDays: number;
        challengeType: 'http-01' | 'dns-01';
        // Opt-in plain-HTTP port for HTTP-01 validation + HTTPS redirect (e.g. 80). Off when unset.
        http01Port?: number;
    };

    // Prometheus metrics. /metrics is disabled unless `token` is set (avoids public metrics leak).
    metrics: {
        token: string;
    };

    // Redis
    redis: {
        enabled: boolean;
        host: string;
        port: number;
        password: string | undefined;
        db: number;
        prefix: string;
    };

    // Allow any other dynamically-spread fields from wordjs-config.json
    [key: string]: any;
}

// Shape of the raw wordjs-config.json (all optional / dynamic).
interface FileConfig {
    [key: string]: any;
}

// Determine path to wordjs-config.json
const rootDir = path.resolve(__dirname, '../../');
const configPath = path.join(rootDir, 'wordjs-config.json');

// Default backup configuration
const defaultConfig = {
    port: 4000,
    host: '127.0.0.1',
    gatewayPort: 3000,
    siteUrl: 'http://localhost:3000',
    frontendUrl: 'http://localhost:3001',
    dbDriver: 'sqlite-native',
    // dbPath is resolved below in the config literal (driver-aware). A single static default here
    // (was './data/wordjs.db') disagreed with the native driver + the installer (which both use
    // './data/wordjs-native.db'), so on a fresh install the admin could be created in one file and
    // read from the empty twin on the next restart — surfacing as "invalid credentials".
    jwtSecret: 'wordjs-default-secret-change-me',
    ssl: { enabled: false }
};

let fileConfig: FileConfig = {};

const crypto = require('crypto');

// In the HOST: load wordjs-config.json and auto-generate/persist secrets. SKIP entirely inside an
// isolated plugin worker (global.__WORDJS_ISOLATED__) — that file is outside the worker's sandbox
// and the worker never needs these host secrets (it reaches config via the bridge). This avoids
// the noisy (but already-harmless) EACCES blocks config/app would otherwise trigger at worker boot.
if (!(global as any).__WORDJS_ISOLATED__) {
    try {
        if (fs.existsSync(configPath)) {
            const rawData = fs.readFileSync(configPath, 'utf8');
            fileConfig = JSON.parse(rawData);
            console.log('📄 Config loaded from wordjs-config.json');
        } else {
            console.warn('⚠️  wordjs-config.json not found, using defaults.');
        }
    } catch (e) {
        console.error('❌ Failed to load wordjs-config.json:', e.message);
    }

    // 1.5 Secure Auto-Generation — generate secure keys ONLY if config exists but is insecure.
    let configChanged = false;
    if (fs.existsSync(configPath)) {
        if (!fileConfig.jwtSecret || fileConfig.jwtSecret === 'wordjs-default-secret-change-me') {
            fileConfig.jwtSecret = crypto.randomBytes(32).toString('hex');
            configChanged = true;
            console.log('🔐 Generated secure JWT secret for existing config.');
        }

        if (!fileConfig.dbPassword || fileConfig.dbPassword === 'password') {
            fileConfig.dbPassword = crypto.randomBytes(16).toString('hex');
            configChanged = true;
            console.log('🔐 Generated secure Database password for existing config.');
        }

        if (configChanged) {
            try {
                fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2));
                console.log('💾 wordjs-config.json updated with secure credentials.');
            } catch (err) {
                console.error('❌ Failed to persist secure credentials:', err.message);
            }
        }
    }
}

// SECURITY: ephemeral fallback secret for when none is configured (see jwt.secret below).
const EPHEMERAL_JWT_SECRET: string = crypto.randomBytes(32).toString('hex');
if (!fileConfig.jwtSecret) {
    console.warn('⚠️  No JWT secret configured — using an ephemeral random secret (tokens reset on restart). Complete setup to persist one.');
}

const config: AppConfig = {
    ...defaultConfig,
    ...fileConfig,

    // Database file path. The native (better-sqlite3) and legacy (sql.js) drivers deliberately use
    // DIFFERENT default filenames so switching drivers never silently clobbers the other's data
    // (native→wordjs-native.db, legacy→wordjs.db) — and, critically, so the path used to CREATE the
    // admin on first boot matches the path read on every later restart. If the file config doesn't
    // pin dbPath, derive it from the chosen driver (the installer pins it explicitly anyway). A
    // single static default used to land here and diverge from the native driver/installer.
    dbPath:
        fileConfig.dbPath ||
        ((fileConfig.dbDriver || defaultConfig.dbDriver) === 'sqlite-legacy'
            ? './data/wordjs.db'
            : './data/wordjs-native.db'),

    // Routable address the gateway uses to reach this backend node (multi-node). Single-host default.
    advertiseHost: fileConfig.advertiseHost || '127.0.0.1',

    // Normalized SSL check
    ssl: {
        enabled: fileConfig.ssl?.enabled || fileConfig.siteUrl?.startsWith('https:') || false
    },

    // Database Connection Object (Normalized)
    db: {
        host: fileConfig.dbHost || (fileConfig.db && fileConfig.db.host) || 'localhost',
        port: fileConfig.dbPort || (fileConfig.db && fileConfig.db.port) || 5432,
        user: fileConfig.dbUser || (fileConfig.db && fileConfig.db.user) || 'postgres',
        password: fileConfig.dbPassword || (fileConfig.db && fileConfig.db.password) || 'password',
        name: fileConfig.dbName || (fileConfig.db && fileConfig.db.name) || 'wordjs',
        ssl: fileConfig.dbSsl === true || (fileConfig.db && fileConfig.db.ssl === true) || false
    },

    // Uploads Configuration
    uploads: {
        dir: fileConfig.uploadDir || './uploads',
        maxFileSize: fileConfig.maxFileSize || 10 * 1024 * 1024 // 10MB
    },

    // API Configuration
    api: {
        prefix: '/api/v1'
    },

    // Site Configuration structure expected by core/options.js
    site: {
        url: fileConfig.siteUrl || 'http://localhost:3000',
        name: fileConfig.siteName || 'WordJS',
        description: fileConfig.siteDescription || 'A WordPress-like CMS'
    },

    // Roles placeholder (if managed via config)
    roles: {},

    // Environment — fail safe to 'production' (the hardened default). process.env.NODE_ENV wins so
    // dev tooling (monolith.js dev, the dev scripts) can opt into development; the file value is a
    // fallback. Only an EXPLICIT 'development' relaxes CORS / enables verbose logging.
    nodeEnv: process.env.NODE_ENV || fileConfig.nodeEnv || 'production',

    // Security options
    jwt: {
        // SECURITY: never fall back to a hardcoded/public constant — that would let
        // anyone forge admin tokens. When no secret is configured (e.g. pre-install,
        // missing wordjs-config.json) use a per-process random secret so issued tokens
        // are unforgeable. Such tokens simply don't survive a restart, which is the
        // correct behavior for a not-yet-configured instance.
        secret: fileConfig.jwtSecret || EPHEMERAL_JWT_SECRET,
        expiresIn: '2h'
    },
    // mTLS Paths
    mtls: {
        ca: fileConfig.mtls?.ca || './certs/cluster-ca.crt',
        key: fileConfig.mtls?.key || './certs/backend.key',
        cert: fileConfig.mtls?.cert || './certs/backend.crt'
    },
    // ACME auto-renewal (normalized; set any field under "acme" in wordjs-config.json).
    // Always a well-formed object so the renewal job + routes can read it unconditionally.
    acme: {
        enabled: fileConfig.acme?.enabled === true,
        email: fileConfig.acme?.email || '',
        domains: Array.isArray(fileConfig.acme?.domains) ? fileConfig.acme.domains : [],
        staging: fileConfig.acme?.staging === true,
        renewBeforeDays: Number(fileConfig.acme?.renewBeforeDays) > 0 ? Number(fileConfig.acme.renewBeforeDays) : 30,
        challengeType: fileConfig.acme?.challengeType === 'dns-01' ? 'dns-01' : 'http-01',
        ...(fileConfig.acme?.http01Port ? { http01Port: Number(fileConfig.acme.http01Port) } : {})
    },
    // Prometheus metrics scrape token (empty = /metrics disabled / returns 404).
    metrics: {
        token: fileConfig.metrics?.token || process.env.METRICS_TOKEN || ''
    },
    // Redis Configuration
    redis: {
        enabled: fileConfig.redis?.enabled !== undefined ? fileConfig.redis.enabled : (process.env.REDIS_ENABLED === 'true'),
        host: fileConfig.redis?.host || process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(fileConfig.redis?.port || process.env.REDIS_PORT || '6379', 10),
        password: fileConfig.redis?.password || process.env.REDIS_PASSWORD || undefined,
        db: parseInt(fileConfig.redis?.db || process.env.REDIS_DB || '0', 10),
        prefix: fileConfig.redis?.prefix || 'wordjs:'
    },
    // Plugin sandbox hardening (see core/plugin-isolate.ts). Isolated plugins already run in a separate
    // child_process; these fields control the KERNEL-level confinement layered on top. Defaults are
    // HARDENED where the host supports it — every field is PROBE-VALIDATED at runtime and falls back to
    // plain process isolation if the kernel feature is missing, so turning them on cannot break a host that
    // lacks bwrap / unprivileged user-namespaces / cgroup-v2. Operators opt OUT per field via a "sandbox"
    // block in wordjs-config.json. (Previously these had no config surface at all, so the whole OS-isolation
    // layer was unreachable/dead-code on every stock install; default-ON activates it where it actually works.)
    sandbox: {
        // Linux: run each isolated plugin under bwrap — uid 65534, dropped caps, no-new-privs, PID/IPC/UTS +
        // user namespaces, read-only root fs, and a seccomp syscall denylist. Probe-gated: bwrap + rootless
        // userns + the IPC round-trip must all work on THIS host, else it falls back to the standard fork launch.
        useKernelHardening: fileConfig.sandbox?.useKernelHardening !== false,
        // Linux: PREVENTIVE per-plugin resource caps via cgroup v2 (systemd-run --user --scope). DEFAULT-ON,
        // probe-validated → falls back to the /proc RSS poll where systemd --user is unavailable. Applies a
        // kernel MemoryMax (so a runaway plugin is OOM-killed instead of racing the reactive poll) AND a
        // CPUQuota (so a busy-loop plugin can't monopolize the cores — the DoS the poll can't stop). The
        // MemoryMax is applied ONLY to a COMPILED prod worker: a ts-node dev/test/CI worker compiles the
        // backend inside the child and transiently overshoots the 768 MB budget → the kernel would OOM-kill it
        // at startup (real-systemd CI caught this), so under ts-node the scope carries the CPUQuota but NOT the
        // memory cap (the poll stays the dev backstop). See core/plugin-isolate.ts cgroupScopeProps().
        useCgroupMemoryCap: fileConfig.sandbox?.useCgroupMemoryCap !== false,
        // CPU quota per isolated plugin as a % of ONE core, enforced by the cgroup scope above (0 = no CPU cap).
        // 100 = one full core per plugin: generous for a Node web plugin, but stops a busy loop from starving
        // co-tenant plugins + the host. Raise it for a legitimately CPU-heavy plugin.
        cpuQuotaPercent: fileConfig.sandbox?.cpuQuotaPercent !== undefined ? Math.max(0, Number(fileConfig.sandbox.cpuQuotaPercent) || 0) : 100,
        // Windows: preventive per-plugin memory cap via a Job Object. Probe-gated → falls back to the poll.
        useJobObjectMemoryCap: fileConfig.sandbox?.useJobObjectMemoryCap !== false,
        // Virtual-address-space backstop (MB) via RLIMIT_AS on the non-cgroup Linux path (loose by design —
        // V8's pointer-compression cage forces it high; the precise cap is the cgroup/Job-Object/poll).
        addressSpaceCapMb: Number(fileConfig.sandbox?.addressSpaceCapMb) > 0 ? Number(fileConfig.sandbox.addressSpaceCapMb) : 16384,
    }
};

// Refresh the request-time runtime fields from wordjs-config.json WITHOUT a process restart. Called after
// the config is persisted (setup install, settings save) so a just-set siteUrl is honored immediately by
// CSRF / CORS / the allowed-origins list. Without this, config.site.url keeps its boot-time value and every
// POST from the freshly-configured origin is CSRF-blocked ("rest_csrf_invalid") until the process restarts.
function reloadFromFile() {
    try {
        const fresh = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (fresh.siteUrl) { config.site.url = fresh.siteUrl; (config as any).siteUrl = fresh.siteUrl; }
        if (fresh.frontendUrl) (config as any).frontendUrl = fresh.frontendUrl;
        if (fresh.siteName) config.site.name = fresh.siteName;
        if (fresh.siteDescription) config.site.description = fresh.siteDescription;
        return true;
    } catch (e) {
        return false;
    }
}
(config as any).reloadFromFile = reloadFromFile;

module.exports = config;
