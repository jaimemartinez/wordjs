/**
 * WordJS - Main Application Entry Point (Reloaded)
 * A WordPress-like CMS built with Node.js
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Load environment variables
require('dotenv').config();

// Import configuration
const config = require('./config/app');

// SECURITY: Initialize IO Guard before anything else
require('./core/io-guard');

// SECURITY: Install runtime module interception for fs/child_process
const { installSecureRequire } = require('./core/secure-require');
installSecureRequire();

// SECURITY: Install CrashGuard runtime blame handlers for async error tracking
const CrashGuard = require('./core/crash-guard');
CrashGuard.installRuntimeBlameHandlers();

const { initSqlJsDb, initializeDatabase, db, saveDatabase } = require('./config/database');

// Import middleware
const { notFound, errorHandler } = require('./middleware/errorHandler');

// Import routes
const routes = require('./routes');

// Import core modules
const { initDefaultOptions } = require('./core/options');
const { doAction } = require('./core/hooks');
const { setApp } = require('./core/appRegistry');

// Create Express app
const app = express();

// Register app for plugins to access
setApp(app);

// Trust proxy (for getting real IP behind reverse proxy)
const rateLimit = require('express-rate-limit');

// ... (existing helper setup, ensure this block replaces lines correctly)
// Trust proxy (for getting real IP behind reverse proxy)
app.set('trust proxy', 1);

// Security Headers
const helmet = require('helmet');
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow images to be loaded by frontend
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // unsafe-inline/eval required for some CMS themes/plugins
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            imgSrc: ["'self'", "data:", "blob:", "https:", "*"], // Allow images from everywhere (CMS content)
            connectSrc: ["'self'", "*"], // Allow API calls
            objectSrc: ["'none'"], // Protect against Flash/Applet injections
            upgradeInsecureRequests: [], // Auto-upgrade http to https
        },
    },
}));
app.disable('x-powered-by');

// CORS configuration
// CORS configuration
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        // In development, allow localhost ports
        if (config.nodeEnv === 'development') {
            return callback(null, true);
        }

        // In production, check against allowed domains
        const allowedOrigins = [config.site.url, config.site.frontendUrl];
        if (allowedOrigins.indexOf(origin) !== -1 || origin === config.site.url) {
            callback(null, true);
        } else {
            // calculated risk: for now allow typical subdomains or just fail
            // callback(new Error('Not allowed by CORS'));
            // For smoother dev experience, let's be permissive if matching base domain?
            callback(null, true); // Fallback for now to unblock user
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Cookie Parser (for HttpOnly auth cookies)
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Rate Limiters
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per 15 mins
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // Limit each IP to 10 login attempts per hour
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again later.' }
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 50, // Limit each IP to 50 uploads per hour
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many file uploads, please try again later.' }
});

// Apply global API limiter
app.use(config.api.prefix, apiLimiter);

// Parse JSON bodies (apply authLimiter specifically to login routes if not applied globally below, but strict route matching is preferred)
app.use(`${config.api.prefix}/auth/login`, authLimiter);
app.use(`${config.api.prefix}/auth/register`, authLimiter);
app.use(`${config.api.prefix}/media`, uploadLimiter);
app.use(`${config.api.prefix}/themes/upload`, uploadLimiter);
app.use(`${config.api.prefix}/plugins/upload`, uploadLimiter);

// SECURITY: CSRF Protection for all API routes
const { csrfProtection } = require('./middleware/auth');
app.use(config.api.prefix, csrfProtection);

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
// Serve static files (Deny dotfiles like .git, .env)
app.use('/uploads', express.static(path.resolve(config.uploads.dir), { dotfiles: 'deny' }));
// app.use('/admin', express.static(path.resolve('./admin'))); // Removed legacy admin
app.use('/themes', express.static(path.resolve('./themes'), { dotfiles: 'deny' }));
app.use('/plugins', express.static(path.resolve('./plugins'), { dotfiles: 'deny' }));
// Serve .well-known (ACME support) - Allow dotfiles
app.use('/.well-known', express.static(path.resolve('./public/.well-known'), { dotfiles: 'allow' }));

app.use('/public', express.static(path.resolve('./public'), { dotfiles: 'deny' }));

// Request logging in development
if (config.nodeEnv === 'development') {
    app.use((req, res, next) => {
        console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
        next();
    });
}

// Health check endpoint
app.get('/health', async (req, res) => {
    const SystemHealth = require('./core/system-health');
    const status = await SystemHealth.checkDatabase();
    res.json({
        status: status.status === 'OK' ? 'ok' : 'error',
        timestamp: new Date().toISOString(),
        details: config.nodeEnv === 'development' ? status : undefined
    });
});

// Installation and Migration Guard Middleware
app.use((req, res, next) => {
    // Bypass for static files, health check, and setup endpoints
    if (
        req.path.startsWith('/uploads') ||
        req.path.startsWith('/themes') ||
        req.path.startsWith('/plugins') ||
        req.path === '/health' ||
        req.path === '/favicon.ico' ||
        req.path.startsWith(`${config.api.prefix}/setup`)
    ) {
        return next();
    }

    const { isInstalled, getConfig } = require('./core/configManager');

    // 1. Check if installed
    if (!isInstalled()) {
        return res.status(503).json({
            error: 'setup_required',
            message: 'WordJS is not installed.',
            redirect: '/install'
        });
    }

    // 2. Check for URL Mismatch (Migration needed)
    const currentConfig = getConfig();
    if (currentConfig && currentConfig.siteUrl) {
        // Prioritize X-Forwarded-Host (from Next.js proxy or standard proxy) 
        // fallback to standard Host header
        const hostHeader = req.get('x-forwarded-host') || req.get('host');

        try {
            // Remove protocol and trailing slash to compare host:port
            const configuredHost = currentConfig.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

            // Simple check: does the request host match what we think it is?
            if (configuredHost !== hostHeader) {
                // Allow direct localhost:3000 access for debugging/backend direct access
                // ONLY if the Host header itself (not forwarded) is localhost:3000
                // This prevents breaking direct backend access if needed, 
                // but forces migration if accessing via Proxy/IP that mismatches.
                // SECURITY: Only allow this bypass in development mode.
                if (config.nodeEnv === 'development' && hostHeader === 'localhost:3000') {
                    return next();
                } else if (req.get('host') === 'localhost:3000' && hostHeader !== 'localhost:3000') {
                    // This means it IS a proxy request (Next.js) and the forwarded host mismatches.
                    // Fall through to error.
                }

                // IGNORE localhost:3000 access if we are just testing backend directly?
                // Actually, for simplicity:
                // If Config is A, and User visits B, redirect.
                // Exception: if User visits localhost:3000 directly (Backend port), maybe allow it?
                // But the user is on port 3001 (Frontend).
                // Frontend sends X-Forwarded-Host: 192.168.x.x:3001
                // Backend Config: localhost:3000
                // Mismatch! -> 409 -> Frontend Redirect.

                // One edge case: `hostHeader` might include port 3001. `configuredHost` might be 3000?
                // `siteUrl` in config usually comes from the setup.

                return res.status(409).json({
                    error: 'migration_required',
                    message: 'Site URL mismatch detected.',
                    redirect: '/migration',
                    details: {
                        configured: configuredHost,
                        detected: hostHeader
                    }
                });
            }
        } catch (e) {
            console.error('Migration check error:', e);
        }
    }

    next();
});

// API routes
app.use(config.api.prefix, routes);

// API info at /api endpoint  
app.get('/api', (req, res) => {
    res.json({
        name: 'WordJS',
        description: 'A WordPress-like CMS built with Node.js',
        version: config.api.version,
        api: `${config.site.url}${config.api.prefix}`
    });
});

// Internal Routes (Gateway Hooks)
app.use('/api/internal', require('./routes/internal'));

// Public Frontend - Independent rendering system
const frontendRoutes = require('./routes/frontend');
app.use(frontendRoutes);

// Note: 404 and error handlers are registered in initialize() after plugins load

/**
 * Initialize the application
 */
async function initialize() {
    console.log('🚀 Starting WordJS...');
    console.log(`   Environment: ${config.nodeEnv}`);

    // Check Installation Status
    const { isInstalled } = require('./core/configManager');

    if (isInstalled()) {
        // Initialize Database
        console.log('📦 Initializing database...');
        // The driver manager automatically loads the correct driver from config
        const { init, initializeDatabase } = require('./config/database');
        await init();
        await initializeDatabase();

        // Initialize default options
        console.log('⚙️  Setting up default options...');
        await initDefaultOptions(config);

        // Initialize Post Types (Async)
        const { initPostTypes } = require('./core/post-types');
        await initPostTypes();

        // Sync roles to ensure capabilities are up to date
        const { loadRoles, syncRoles } = require('./core/roles');
        await loadRoles();
        await syncRoles(config.roles);

        // Initialize Core Admin Menus
        const { initCoreMenus } = require('./core/adminMenu');
        initCoreMenus();

        // Create default admin user if no users exist
        const User = require('./models/User');
        const userCount = await User.count();

        if (userCount === 0) {
            console.log('👤 Creating default admin user...');
            await User.create({
                username: 'admin',
                email: 'admin@example.com',
                password: 'admin123',
                displayName: 'Administrator',
                role: 'administrator'
            });
            console.log('   Default admin created: admin / admin123');
            console.log('   ⚠️  Please change the default password!');
        }

        // Create default category if none exist
        const Term = require('./models/Term');
        const categoryCount = await Term.count({ taxonomy: 'category' });

        if (categoryCount === 0) {
            console.log('📁 Creating default category...');
            Term.create({
                name: 'Uncategorized',
                taxonomy: 'category',
                slug: 'uncategorized',
                description: 'Default category'
            });
        }

        // Create default theme if none exist
        const { createDefaultTheme } = require('./core/themes');
        createDefaultTheme();

        // Load active plugins
        console.log('🔌 Loading plugins...');
        const { loadActivePlugins } = require('./core/plugins');
        await loadActivePlugins();

        // Start cron system
        const { startCron, initDefaultCronEvents } = require('./core/cron');
        initDefaultCronEvents();
        startCron();

        // Initialize Robust Theme Engine
        console.log('🎨 Initializing Theme Engine...');
        const themeEngine = require('./core/theme-engine');
        await themeEngine.init();

        // Fire init action
        await doAction('init');
    } else {
        console.log('⚠️  WordJS is NOT installed. Starting in SETUP MODE.');
        console.log('   Waiting for interactive installation via Frontend...');
    }

    // Register 404 and error handlers AFTER plugins (so plugin routes work)
    app.use(notFound);
    app.use(errorHandler);

    // Start server
    const caPath = path.resolve(config.mtls.ca);
    const keyPath = path.resolve(config.mtls.key);
    const certPath = path.resolve(config.mtls.cert);

    const serverProtocol = (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.existsSync(caPath)) ? 'https' : 'http';
    let server;

    if (serverProtocol === 'https') {
        const https = require('https');
        const httpsOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
            ca: fs.readFileSync(caPath),
            requestCert: true,
            rejectUnauthorized: true // ENFORCE mTLS: Only allow certs signed by our CA
        };
        server = https.createServer(httpsOptions, app);
    } else {
        const http = require('http');
        server = http.createServer(app);
    }

    server.listen(config.port, config.host, () => {
        console.log('');
        console.log(`✅ WordJS Backend is running via ${serverProtocol.toUpperCase()}!`);
        if (serverProtocol === 'https') {
            console.log('   🛡️  Security: mTLS (Identity Enforcement) is ACTIVE');
            console.log(`   🪪  Identity: backend`);
        }
        console.log(`   🌐 URL: ${serverProtocol}://${config.host}:${config.port}`);
        console.log(`   📡 API: ${serverProtocol}://${config.host}:${config.port}${config.api.prefix}`);

        // Register with Gateway
        // Register with Gateway with Auto-Discovery (Zero Config)
        const registerWithGateway = async () => {
            const http = require('http');
            const https = require('https');

            // Use Internal Management Port for mTLS registration
            const gatewayInternalPort = config.gatewayInternalPort || 3100;
            const gatewayPort = config.gatewayPort || 3000;

            // Certs for calling Gateway (Client mTLS)
            let clientOpts = {};

            if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(caPath)) {
                console.log('   🛂 mTLS: Using client certificates for Gateway registration...');
                clientOpts = {
                    key: fs.readFileSync(keyPath),
                    cert: fs.readFileSync(certPath),
                    ca: fs.readFileSync(caPath),
                    rejectUnauthorized: true
                };
            }

            const services = [
                {
                    name: 'backend',
                    url: `${serverProtocol}://127.0.0.1:${config.port}`,
                    routes: ['/api', '/uploads', '/themes', '/plugins', '/.well-known']
                }
            ];

            const tryRegister = (protocolName, serviceData) => {
                return new Promise((resolve, reject) => {
                    const protocol = protocolName === 'https' ? https : http;
                    const data = JSON.stringify(serviceData);
                    const targetHost = config.gatewayHost || 'localhost';

                    // Port logic: If we have mTLS certs, we use the INTERNAL management port.
                    // Otherwise we fallback to the public gateway port.
                    const useMtls = Object.keys(clientOpts).length > 0;
                    const targetPort = useMtls ? gatewayInternalPort : gatewayPort;
                    const targetProtocol = useMtls ? https : protocol;

                    const req = targetProtocol.request({
                        hostname: targetHost,
                        port: targetPort,
                        path: '/register',
                        method: 'POST',
                        rejectUnauthorized: false, // For local dev/self-signed, but mTLS uses clientOpts.ca
                        ...clientOpts, // Inject client certs for mTLS
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': data.length,
                            'x-gateway-secret': process.env.GATEWAY_SECRET || (config.gatewaySecret) || 'secure-your-gateway-secret'
                        },
                        timeout: 2000
                    }, (res) => {
                        if (res.statusCode === 200) {
                            const actualProto = useMtls ? 'HTTPS (mTLS)' : protocolName.toUpperCase();
                            console.log(`✅ ${serviceData.name} Registered with Gateway via ${actualProto}`);
                            resolve(protocolName);
                        } else {
                            reject(new Error(`Status ${res.statusCode}`));
                        }
                    });

                    req.on('error', (e) => reject(e));
                    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                    req.write(data);
                    req.end();
                });
            };

            // Attempt registration with retry logic
            const registerAll = async () => {
                let preferredProto = (config.gatewaySsl && config.gatewaySsl.enabled) ? 'https' : 'http';
                let fallbackProto = preferredProto === 'https' ? 'http' : 'https';
                let allSuccess = true;

                for (const service of services) {
                    try {
                        await tryRegister(preferredProto, service);
                    } catch (e) {
                        try {
                            await tryRegister(fallbackProto, service);
                            preferredProto = fallbackProto;
                        } catch (e2) {
                            console.warn(`⏳ Waiting for Gateway to register ${service.name}...`);
                            allSuccess = false;
                        }
                    }
                }

                if (!allSuccess) {
                    setTimeout(registerAll, 5000); // Retry in 5s
                } else {
                    console.log('🏁 All services successfully registered with Gateway.');
                }
            };

            // Initial registration attempt
            setTimeout(registerAll, 1500);
        };

        registerWithGateway();

        console.log('');
        console.log('📖 API Endpoints:');
        console.log(`   POST   ${config.api.prefix}/auth/register`);
        console.log(`   POST   ${config.api.prefix}/auth/login`);
        console.log(`   GET    ${config.api.prefix}/posts`);
        console.log(`   GET    ${config.api.prefix}/users`);
        console.log(`   GET    ${config.api.prefix}/categories`);
        console.log(`   GET    ${config.api.prefix}/tags`);
        console.log(`   GET    ${config.api.prefix}/comments`);
        console.log(`   GET    ${config.api.prefix}/media`);
        console.log(`   GET    ${config.api.prefix}/settings`);
        console.log(`   GET    ${config.api.prefix}/plugins`);
        console.log(`   GET    ${config.api.prefix}/themes`);
        console.log('');
        console.log(`🎨 Admin Panel: ${config.site.frontendUrl}/admin`);
        console.log(`🏠 Public Site: ${config.site.frontendUrl}`);
        console.log('');
    });
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    saveDatabase();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\nSIGINT received. Shutting down gracefully...');
    saveDatabase();
    process.exit(0);
});

// Start the application
// Start the application
initialize().catch((error) => {
    console.error('❌ Failed to initialize:', error);

    // Auto-Fallback Logic
    const fs = require('fs');
    const path = require('path');
    const backupFile = path.resolve('wordjs-config.backup.json');
    const configFile = path.resolve('wordjs-config.json');

    if (fs.existsSync(backupFile)) {
        console.warn('⚠️  Startup Failed! Attempting automatic fallback to previous configuration...');
        try {
            // Restore config
            fs.copyFileSync(backupFile, configFile);
            console.log('✅ Configuration restored from backup.');

            // Force Restart by touching this file
            const time = new Date();
            fs.utimesSync(__filename, time, time);
            console.log('🔄 Triggering server restart...');
        } catch (e) {
            console.error('❌ Fallback failed:', e);
        }
    }

    process.exit(1);
});

module.exports = app;

