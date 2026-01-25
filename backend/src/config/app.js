const fs = require('fs');
const path = require('path');

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
    ssl: { enabled: false }
};

let fileConfig = {};

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

const config = {
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
        secret: fileConfig.jwtSecret || 'wordjs-default-secret',
        expiresIn: '2h'
    },
    // mTLS Paths
    mtls: {
        ca: fileConfig.mtls?.ca || './certs/cluster-ca.crt',
        key: fileConfig.mtls?.key || './certs/backend.key',
        cert: fileConfig.mtls?.cert || './certs/backend.crt'
    }
};

module.exports = config;
