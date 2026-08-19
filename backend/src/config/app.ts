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
    // Reverse-proxy trust for client-IP derivation (see core/client-ip). null = resolve by deployment
    // mode; otherwise an explicit Express 'trust proxy' value.
    trustProxy: boolean | number | string | string[] | null;

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
        // Optional Postgres pool tuning (safe defaults applied in drivers/postgres.ts)
        poolMax?: number;
        poolIdleMs?: number;
        poolConnectTimeoutMs?: number;
        idleInTxnTimeoutMs?: number;
        statementTimeoutMs?: number;
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

    // Login brute-force throttling. Always well-formed so routes/core read it unconditionally.
    auth: {
        // Per-(IP + account) escalating lockout: after `loginMaxFails` consecutive failures the
        // account+IP is blocked for loginBlockLadderMs[level]; the last entry repeats for further
        // blocks. A successful login wipes the ladder for that IP+account.
        loginMaxFails: number;
        loginBlockLadderMs: number[];
        loginStateTtlMs: number;      // idle time after which per-key state is forgotten (ladder resets)
        loginIpFailPerHour: number;   // per-IP FAILED-login backstop (bounds spraying across many accounts)
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
if (!(globalThis as any).__WORDJS_ISOLATED__) {
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

    // Reverse-proxy trust for client-IP derivation (rate limiting + account lockout). Express
    // 'trust proxy' semantics: false | true | hop-count | subnet(s). UNSET (null) → resolved by
    // deployment mode in core/client-ip: a DIRECT monolith trusts NOTHING and keys on the socket
    // peer (so a client cannot forge X-Forwarded-For to rotate past limits/lockout); behind the
    // gateway exactly one hop is trusted. Set an explicit value here (or WORDJS_TRUST_PROXY) only
    // when fronting the app with YOUR OWN reverse proxy — e.g. a monolith behind nginx needs the
    // hop count that proxy adds, else every visitor collapses onto the proxy's IP.
    trustProxy: (() => {
        const v = fileConfig.trustProxy !== undefined ? fileConfig.trustProxy : process.env.WORDJS_TRUST_PROXY;
        return (v === undefined || v === null || v === '') ? null : v;
    })(),

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
        ssl: fileConfig.dbSsl === true || (fileConfig.db && fileConfig.db.ssl === true) || false,
        // Postgres connection-pool tuning (safe defaults live in drivers/postgres.ts; override per-field via
        // a "db" block in wordjs-config.json). statementTimeoutMs stays OFF unless set — a blanket cap would
        // kill legit long migrations/imports/backups.
        poolMax: fileConfig.db?.poolMax,
        poolIdleMs: fileConfig.db?.poolIdleMs,
        poolConnectTimeoutMs: fileConfig.db?.poolConnectTimeoutMs,
        idleInTxnTimeoutMs: fileConfig.db?.idleInTxnTimeoutMs,
        statementTimeoutMs: fileConfig.db?.statementTimeoutMs
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
    // Login throttling (normalized; set any field under "auth" in wordjs-config.json).
    auth: (() => {
        const a = fileConfig.auth || {};
        const ladderMin = (Array.isArray(a.loginBlockLadderMinutes) ? a.loginBlockLadderMinutes : [])
            .map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0);
        const ladder = (ladderMin.length ? ladderMin : [5, 10, 30, 60]).map((m: number) => m * 60 * 1000);
        return {
            loginMaxFails: Number(a.loginMaxFails) > 0 ? Number(a.loginMaxFails) : 5,
            loginBlockLadderMs: ladder,
            loginStateTtlMs: (Number(a.loginStateTtlMinutes) > 0 ? Number(a.loginStateTtlMinutes) : 120) * 60 * 1000,
            loginIpFailPerHour: Number(a.loginIpFailPerHour) > 0 ? Number(a.loginIpFailPerHour) : 50,
        };
    })(),
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
        // Linux: additionally drop a NON-network plugin (no admin `network` grant) into its OWN empty network
        // namespace via bwrap --unshare-net, so it cannot reach the metadata endpoint / host loopback / the
        // public internet at the KERNEL level — not merely the in-process JS egress-guard. DEFAULT-ON (opt-out),
        // Linux + bwrap only, and separately probe-gated (a second --unshare-net IPC round-trip must pass on this
        // host, else it's skipped and the plugin keeps the JS network neuter). Network-GRANTED plugins are never
        // net-unshared (their sockets must work). Surfaced on admin GET /health/details as sandboxNetnsState.
        unshareNetwork: fileConfig.sandbox?.unshareNetwork !== false,
        // EVERY PLATFORM (this is the only OS-level confinement Windows and macOS get): launch each
        // isolated plugin under Node's own permission model, which is enforced in C++ below JavaScript.
        // Filesystem reads are scoped to the app root and writes to the same zones io-guard permits, and
        // child_process / worker_threads / native addons / WASI are simply never granted. DEFAULT-ON and
        // probe-gated: the flag name moved between Node versions and a build can accept it without
        // enforcing it, so a child must actually be refused a read before it activates. Surfaced on
        // admin GET /health/details as sandboxPermissionState.
        usePermissionModel: fileConfig.sandbox?.usePermissionModel !== false,
        // FAIL-CLOSED switch (opt-in, default off): when true, an isolated plugin REFUSES to launch unless
        // kernel hardening is actually ACTIVE on this host — instead of silently degrading to the JS-guards-
        // only fork where bwrap / unprivileged-userns is missing (the "looks secure but isn't" gap). Off by
        // default so a stock host still runs plugins; turn it ON for hosts that must never run an untrusted
        // plugin without the OS backstop. The true hardening state is surfaced on admin GET /health/details.
        requireHardening: fileConfig.sandbox?.requireHardening === true,
        // Linux: PREVENTIVE resident-memory cap via cgroup v2 (systemd-run --user --scope MemoryMax) so the
        // kernel OOM-kills a runaway plugin instead of the reactive /proc poll. OPT-IN (default off): the fixed
        // 768 MB budget is fine for a COMPILED prod worker but too tight for a ts-node dev/test worker (ts-node
        // compiling the backend inside the child overshoots it → the kernel OOM-kills the plugin at startup, which
        // is exactly what real-systemd CI caught). Default-ON is a follow-up gated on a ts-node-aware / larger
        // budget. Probe-gated regardless → falls back to the /proc poll where systemd --user is unavailable.
        useCgroupMemoryCap: fileConfig.sandbox?.useCgroupMemoryCap === true,
        // Linux: PREVENTIVE per-plugin CPU quota in the SAME cgroup scope as the memory cap (CPUQuota=N% of
        // ONE core — 100 = a full core, 50 = half) so a runaway/malicious plugin can't peg every core
        // (anti-DoS). OPT-IN (default 0 = off) AND only takes effect together with useCgroupMemoryCap: both
        // share one systemd --user scope, and that scope's memory.max is what makes skipping the /proc RSS
        // poll safe (under a scope, child.pid is systemd-run, so the poll can't read the node child). Needs a
        // systemd host whose `cpu` controller is delegated to the user cgroup — TRUE on bare metal + Proxmox
        // LXC (end-to-end validated on real systemd 252: IPC survives the scope, a 25% quota ⇒ ~4x slower, the
        // mem cap OOM-kills at budget), NOT on ephemeral CI runners. The probe validates the EXACT scope
        // (mem+cpu) before activating, so enabling it where cpu isn't delegated falls back to the normal launch.
        cpuQuotaPercent: Number(fileConfig.sandbox?.cpuQuotaPercent) > 0 ? Number(fileConfig.sandbox.cpuQuotaPercent) : 0,
        // Windows: preventive per-plugin memory cap via a Job Object. Probe-gated → falls back to the poll.
        useJobObjectMemoryCap: fileConfig.sandbox?.useJobObjectMemoryCap !== false,
        // Virtual-address-space backstop (MB) via RLIMIT_AS on the non-cgroup Linux path (loose by design —
        // V8's pointer-compression cage forces it high; the precise cap is the cgroup/Job-Object/poll).
        addressSpaceCapMb: Number(fileConfig.sandbox?.addressSpaceCapMb) > 0 ? Number(fileConfig.sandbox.addressSpaceCapMb) : 16384,
        // V8 hard block on RUNTIME code generation (eval / new Function(string)) via
        // --disallow-code-generation-from-strings, layered under the install-time AST scanner (which only
        // sees STATICALLY-visible eval/Function, not code assembled at runtime or inside an unscanned
        // dependency). DEFAULT-ON (opt-out): set sandbox.blockCodeGen:false only for a trusted plugin whose
        // deps genuinely need runtime Function()/eval (e.g. some template engines). Force-disabled under
        // ts-node regardless (dev needs codegen to compile TS), so it only bites a COMPILED prod worker.
        // (Consumed in core/plugin-isolate.ts, whose local default is likewise on; normalizing with `!== false`
        // makes the two agree — an unset config previously collapsed the isolate's default-on back to off.)
        blockCodeGen: fileConfig.sandbox?.blockCodeGen !== false,

        // ── PER-PLATFORM KERNEL CONFINEMENT (the Windows and macOS peers of the bwrap layer) ─────────
        // Everything above that confines a plugin at the KERNEL level is Linux-only, so on Windows and
        // macOS a bypass of a JS guard used to be the whole user account. These two knobs turn on the
        // layer each OS actually has. Both are PROBE-GATED exactly like useKernelHardening: a real child
        // is launched through the real profile and the layer activates only if that child was ACTUALLY
        // refused the network and an out-of-zone read (with a positive control, so a totally broken
        // profile cannot pass). Any failure falls back to the launch that was there before — see
        // core/plugin-isolate.ts, core/sandbox-windows.ts, core/sandbox-macos.ts.
        //
        // WHY THESE TWO ARE OPT-IN WHILE useKernelHardening / unshareNetwork / usePermissionModel ARE
        // OPT-OUT. Those three are default-ON because probing them changes NOTHING on the host: a process
        // is spawned and thrown away. These two are not in that class, and defaulting them ON would mean
        // doing something to the operator's machine that they never asked for:
        //   · Windows — validating AppContainer REGISTERS an AppContainer profile under the user account
        //     and adds DACL entries (`S-1-15-2-…` ACEs) to the app root and the Node runtime directory.
        //     That is persistent state on someone else's machine, created on first plugin load, silently.
        //   · macOS — the Seatbelt profile has never been parsed by a real Sandbox kext (it was written on
        //     a Windows host; see the UNCERTIFIED header of core/sandbox-macos.ts). A green probe proves
        //     `node -e` boots under it, NOT that a real plugin does — so a default-ON flip could break
        //     plugin loading on every Mac, and that flip must follow a MEASUREMENT, not a comment.
        // Flip either default only once a real host of that OS reports 'active' AND real plugins load
        // under it. The live per-platform state is on admin GET /health/details under `sandbox.kernel`.
        //
        // Windows: run each isolated plugin (without the `network` grant) in an AppContainer with ZERO
        // capabilities — no `internetClient`, so the KERNEL refuses every outbound socket (the Win32
        // analogue of bwrap --unshare-net), and the child reaches only objects whose ACL names its package
        // SID. Applied to the COMPILED production child only: the container requires --preserve-symlinks,
        // which changes module identity, and ts-node is the consumer most sensitive to that.
        useAppContainer: fileConfig.sandbox?.useAppContainer === true,
        // The AppContainer profile name registered for this install. Only worth changing when two WordJS
        // installs share one Windows account and must not share one container identity.
        appContainerName: typeof fileConfig.sandbox?.appContainerName === 'string' && fileConfig.sandbox.appContainerName
            ? String(fileConfig.sandbox.appContainerName)
            : undefined,
        // macOS: run each isolated plugin (without the `network` grant) under a deny-by-default Seatbelt
        // profile via /usr/bin/sandbox-exec — writes confined to exactly the io-guard zones, exec confined
        // to the Node binary, `(deny network*)`. UNCERTIFIED: see the paragraph above before enabling.
        useSeatbelt: fileConfig.sandbox?.useSeatbelt === true,
        // Task/process cap for a plugin's own subtree — the fork-bomb bound. On Linux this is the cgroup
        // TasksMax already applied by the systemd scope; on Windows it is the Job Object
        // JOB_OBJECT_LIMIT_ACTIVE_PROCESS applied to the AppContainer child. ONE knob, both kernels, so an
        // operator sets a number rather than learning two vocabularies. Generous by design — no legitimate
        // plugin approaches it. 0 or a negative value means "use the built-in default" (512), never "no cap".
        pidsMax: Number(fileConfig.sandbox?.pidsMax) > 0 ? Number(fileConfig.sandbox.pidsMax) : 512,
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
