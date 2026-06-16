const fs = require('fs');
const path = require('path');

export interface AppConfig {
    // Server
    port: number;
    host: string;
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
    dbPath: './data/wordjs.db',
    jwtSecret: 'wordjs-default-secret-change-me',
    ssl: { enabled: false },
    // SECURITY: only these (first-party, bundled) plugins may skip the AST scanner via a
    // system:admin manifest declaration. Uploaded third-party plugins cannot self-grant it.
    trustedSystemPlugins: ['db-migration', 'conference-manager']
};

let fileConfig: FileConfig = {};

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

// 1.5 Secure Auto-Generation
const crypto = require('crypto');
let configChanged = false;

// Generate secure keys if they are default or missing
// Generate secure keys ONLY if config exists but is insecure
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

// SECURITY: ephemeral fallback secret for when none is configured (see jwt.secret below).
const EPHEMERAL_JWT_SECRET: string = crypto.randomBytes(32).toString('hex');
if (!fileConfig.jwtSecret) {
    console.warn('⚠️  No JWT secret configured — using an ephemeral random secret (tokens reset on restart). Complete setup to persist one.');
}

const config: AppConfig = {
    ...defaultConfig,
    ...fileConfig,

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

    // Environment
    nodeEnv: fileConfig.nodeEnv || 'development',

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
    // Redis Configuration
    redis: {
        enabled: fileConfig.redis?.enabled !== undefined ? fileConfig.redis.enabled : (process.env.REDIS_ENABLED === 'true'),
        host: fileConfig.redis?.host || process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(fileConfig.redis?.port || process.env.REDIS_PORT || '6379', 10),
        password: fileConfig.redis?.password || process.env.REDIS_PASSWORD || undefined,
        db: parseInt(fileConfig.redis?.db || process.env.REDIS_DB || '0', 10),
        prefix: fileConfig.redis?.prefix || 'wordjs:'
    }
};

module.exports = config;
