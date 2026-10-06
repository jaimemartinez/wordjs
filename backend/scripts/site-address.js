#!/usr/bin/env node
'use strict';
/**
 * `npm run site -- <command>` — manage the site's addresses from the server itself.
 *
 *   list                                   show the main address, the other addresses and the IP policy
 *   add <url> [--expires 24h|7d|<date>|never] [--label <text>] [--http-signin|--no-signin]
 *             [--redirect] [--confirm-local]
 *                                          add (or update) another address the site answers on
 *   remove <host|url> [--force]            stop answering on an address
 *   canonical <url> [--keep-old|--redirect-old|--drop-old] [--force]
 *                                          change the main address (the base of every link and email)
 *   ip-literals any|own|none               which IP addresses the site answers on
 *   ip-signin on|off                       whether sessions may be started on IP addresses (production)
 *   check <host>                           would the site answer on this Host, and why (not)?
 *
 *   --dir <path>                           the installation's backend directory (default: this one)
 *
 * WHY A CLI. It is the way back in when the admin screen cannot be reached — the main address points at
 * a domain that no longer resolves, a proxy sends the wrong Host. Server control is the authority here:
 * whoever can run this can already edit wordjs-config.json, so it asks for no password.
 *
 * WHAT IT WRITES: the config file only, through the same planners the admin API uses (core/site-address)
 * and the same atomic, compare-and-swap writer (core/configManager): an unreadable file is never
 * rewritten, and a change that raced another writer is refused rather than merged. The revision goes up
 * and `lastChange.via` says 'cli'; a running backend notices within seconds and applies the rest (database
 * mirrors, gateway, caches, audit, a notice to every administrator), a stopped one at its next start.
 *
 * Mirrors server.js / scripts/migrate.js: compiled dist/ when present, ts-node on src/ otherwise.
 */
const path = require('path');
const fs = require('fs');

const BACKEND = path.resolve(__dirname, '..');

const USAGE = [
    'Usage: npm run site -- <command> [options]',
    '',
    '  list                                       show the site\'s addresses',
    '  add <url> [--expires 24h|7d|<date>|never] [--label <text>] [--http-signin|--no-signin] [--redirect] [--confirm-local]',
    '  remove <host|url> [--force]',
    '  canonical <url> [--keep-old|--redirect-old|--drop-old] [--force]',
    '  ip-literals any|own|none',
    '  ip-signin on|off                           allow signing in on IP addresses (production; off by default)',
    '  check <host>',
    '',
    '  --dir <path>   the installation\'s backend directory (default: the one this script belongs to)',
].join('\n');

const BOOLEAN_FLAGS = new Set(['http-signin', 'no-signin', 'redirect', 'confirm-local', 'force', 'keep-old', 'redirect-old', 'drop-old', 'help']);
const VALUE_FLAGS = new Set(['dir', 'expires', 'label']);

class UsageError extends Error {}

function parseArgs(argv) {
    const positionals = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h') { flags.help = true; continue; }
        if (!arg.startsWith('--')) { positionals.push(arg); continue; }
        const eq = arg.indexOf('=');
        const name = arg.slice(2, eq === -1 ? undefined : eq);
        if (BOOLEAN_FLAGS.has(name)) {
            if (eq !== -1) throw new UsageError(`--${name} takes no value`);
            flags[name] = true;
        } else if (VALUE_FLAGS.has(name)) {
            const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
            // `--expires --force` is a forgotten value, not an expiry called "--force".
            if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
            flags[name] = value;
        } else {
            throw new UsageError(`unknown option --${name}`);
        }
    }
    return { command: positionals.shift(), positionals, flags };
}

/** The backend modules this needs: compiled when present (a release), ts-node on src/ otherwise. */
function loadModules() {
    const dist = path.join(BACKEND, 'dist', 'core');
    if (fs.existsSync(path.join(dist, 'site-address.js'))) {
        return {
            siteAddress: require(path.join(dist, 'site-address.js')),
            configManager: require(path.join(dist, 'configManager.js')),
            hostPolicy: require(path.join(dist, 'host-policy.js')),
        };
    }
    // The project file is named explicitly: the cwd is the installation (--dir), not this backend, so
    // ts-node would otherwise look for a tsconfig there and compile with the wrong options.
    require(require.resolve('ts-node', { paths: [BACKEND] })).register({ project: path.join(BACKEND, 'tsconfig.json'), transpileOnly: true });
    const src = path.join(BACKEND, 'src', 'core');
    return {
        siteAddress: require(path.join(src, 'site-address')),
        configManager: require(path.join(src, 'configManager')),
        hostPolicy: require(path.join(src, 'host-policy.js')),
    };
}

/** `24h`, `7d`, `90m` → an instant from now; `never` → no expiry; anything else must be a date. */
function parseExpires(value, now) {
    if (value === undefined) return undefined;
    if (value === 'never') return null;
    const m = /^(\d{1,4})([mhd])$/.exec(value);
    if (m) {
        const unit = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
        return new Date(now + Number(m[1]) * unit).toISOString();
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new UsageError(`--expires ${JSON.stringify(value)} is not 24h, 7d, a date, or never`);
    return new Date(ms).toISOString();
}

/** What a hostname/URL argument names: `www.example.com`, `www.example.com:8443` or a full site URL. */
function hostnameArg(hostPolicy, value) {
    if (typeof value !== 'string') return null;
    const site = value.includes('://') ? hostPolicy.parseSiteUrl(value) : null;
    if (site) return site.hostname;
    const parsed = hostPolicy.parseHost(value);
    return parsed ? parsed.hostname : null;
}

/**
 * The stored alias entries the server actually answers on, as planner input. Entries it already ignores
 * (unparseable, naming the main address, or a second entry for one name) are reported and left out —
 * exactly the entries core/host-policy skips with a warning.
 */
function storedAliasInput(hostPolicy, cfg, err) {
    const list = Array.isArray(cfg.siteAliases) ? cfg.siteAliases : [];
    const canonical = hostPolicy.parseSiteUrl(cfg.siteUrl);
    const seen = new Set();
    const kept = [];
    let dropped = 0;
    for (const raw of list) {
        const entry = raw && typeof raw === 'object' ? raw : { url: raw };
        const site = hostPolicy.parseSiteUrl(entry.url);
        if (!site || (canonical && site.hostname === canonical.hostname) || seen.has(site.hostname)) {
            dropped++;
            continue;
        }
        seen.add(site.hostname);
        kept.push(entry);
    }
    if (dropped) err(`note: ${dropped} entr${dropped === 1 ? 'y' : 'ies'} in siteAliases the server already ignores will be removed.`);
    return kept;
}

/**
 * The IP-address mode the config FILE holds, for a write that must leave it as it is (ip-signin). Never
 * the effective mode: WORDJS_IP_HOSTS overrides it at run time, and copying that override into the file
 * would outlive the variable. A missing or invalid value reads as 'any', which is what the server
 * applies to it.
 */
function storedIpLiterals(cfg) {
    const stored = cfg.hostPolicy && typeof cfg.hostPolicy === 'object' && !Array.isArray(cfg.hostPolicy) ? cfg.hostPolicy.ipLiterals : undefined;
    return stored === 'any' || stored === 'own' || stored === 'none' ? stored : 'any';
}

/** What the IP sign-in switch does not decide on its own, told where the operator reads the result. */
function ipSignInNotes(policy, ipSignIn) {
    const notes = [];
    if (policy.dev) notes.push('note: this installation runs in development, where signing in is allowed on every address; the setting applies in production.');
    if (ipSignIn && policy.canonical && policy.canonical.scheme === 'https') {
        notes.push('note: the main address uses https, so signing in over plain http on an IP address is still refused (the session cookie would cross the network in clear text). To accept that on one address: npm run site -- add http://<ip>:<port> --http-signin');
    }
    return notes;
}

function describeAlias(entry, now) {
    const parts = [entry.origin, entry.mode];
    parts.push(`sign-in ${entry.signIn ? 'yes' : 'no'}${entry.signInExplicit ? '' : ' (default)'}`);
    if (entry.expiresAt !== null) parts.push(now >= entry.expiresAt ? `EXPIRED ${new Date(entry.expiresAt).toISOString()}` : `expires ${new Date(entry.expiresAt).toISOString()}`);
    parts.push(`source ${entry.source}`);
    if (entry.label) parts.push(JSON.stringify(entry.label));
    return parts.join('  ');
}

async function run(argv, io = {}) {
    const out = io.stdout || ((s) => process.stdout.write(s + '\n'));
    const err = io.stderr || ((s) => process.stderr.write(s + '\n'));
    const env = io.env || process.env;
    const now = typeof io.now === 'function' ? io.now() : Date.now();

    let args;
    try {
        args = parseArgs(argv);
    } catch (e) {
        err(`${e.message}\n\n${USAGE}`);
        return 2;
    }
    const { command, positionals, flags } = args;
    if (!command || flags.help || command === 'help') {
        out(USAGE);
        return command || flags.help ? 0 : 2;
    }

    // configManager resolves wordjs-config.json from the cwd when it is first loaded, exactly as at boot.
    const dir = path.resolve(flags.dir || BACKEND);
    try {
        process.chdir(dir);
    } catch {
        err(`No such directory: ${dir}`);
        return 1;
    }
    const { siteAddress, configManager, hostPolicy } = io.modules || loadModules();
    if (path.resolve(configManager.CONFIG_FILE) !== path.join(dir, 'wordjs-config.json')) {
        err(`This process already reads ${configManager.CONFIG_FILE}; run the command again with that installation's directory.`);
        return 1;
    }

    const fresh = configManager.readConfigFresh();
    if (!fresh.exists) {
        err(`There is no wordjs-config.json in ${dir}. Install the site first (the setup wizard writes it).`);
        return 1;
    }
    if (fresh.parseError) {
        err(`${configManager.CONFIG_FILE} cannot be read as JSON right now. Nothing was changed; fix the file (or retry if another program is writing it).`);
        return 1;
    }
    const cfg = fresh.parsed;
    const nodeEnv = env.NODE_ENV || cfg.nodeEnv || 'production';
    const policy = hostPolicy.buildPolicy({ config: cfg, env, nodeEnv });

    if (command === 'list') {
        out(`Main address: ${policy.canonical ? policy.canonical.origin : `(${policy.canonicalError}: ${JSON.stringify(cfg.siteUrl === undefined ? null : cfg.siteUrl)})`}`);
        const change = cfg.siteAddress && cfg.siteAddress.lastChange;
        out(`Revision: ${configManager.siteAddressRev(cfg)}${change ? ` (last change: ${change.kind} via ${change.via} at ${change.at})` : ''}`);
        out('Other addresses:');
        if (policy.aliases.size === 0) out('  (none)');
        for (const entry of policy.aliases.values()) out(`  ${describeAlias(entry, now)}`);
        out(`IP addresses: ${policy.ipLiterals} (${policy.ipLiteralsSource}); sign-in on IP addresses: ${policy.ipSignIn ? 'on' : 'off'}`);
        if (policy.envHosts.size) out(`From WORDJS_ALLOWED_HOSTS: ${[...policy.envHosts.values()].map((e) => e.origin || hostPolicy.serialize(e)).join(', ')}`);
        if (policy.dev && policy.devOrigins.size) out(`Development origins (WORDJS_DEV_ORIGINS): ${[...policy.devOrigins].join(', ')}`);
        for (const warning of policy.warnings) out(`warning: ${warning}`);
        return 0;
    }

    if (command === 'check') {
        const raw = positionals[0];
        if (!raw) { err(`check needs a host.\n\n${USAGE}`); return 2; }
        const parsed = hostPolicy.parseHost(raw);
        if (!parsed) {
            out(`${JSON.stringify(raw)}: malformed — the server answers 400 rest_invalid_host.`);
            return 1;
        }
        const verdict = hostPolicy.classify(parsed, policy, { proxied: false, now });
        const host = hostPolicy.serialize(parsed);
        if (verdict.cls === 'unknown') {
            const hint = hostPolicy.refusalHint(parsed, policy, verdict.reason);
            out(`${host}: refused (421) — ${verdict.reason}${hint ? `; ${hostPolicy.REFUSAL_HINTS[hint]}` : '; add it with: npm run site -- add <url>'}`);
            return 1;
        }
        out(`${host}: answered as ${verdict.cls} (${verdict.reason})`);
        if (verdict.cls === 'ip') out('  (for a direct request; behind a proxy that does not forward Host, an IP address is refused)');
        return 0;
    }

    let plan;
    let notes = [];
    try {
        if (command === 'add') {
            const url = positionals[0];
            if (!url) throw new UsageError('add needs an address, e.g. https://www.example.com');
            const site = hostPolicy.parseSiteUrl(url);
            if (!site) throw new siteAddress.SiteAddressError(400, 'rest_invalid_site_address', `${JSON.stringify(url)} is not a site address: use http(s)://host[:port].`);
            if (flags['http-signin'] && flags['no-signin']) throw new UsageError('--http-signin and --no-signin contradict each other');
            const entry = {
                url: site.origin,
                mode: flags.redirect ? 'redirect' : 'serve',
                ...(flags.label !== undefined ? { label: flags.label } : {}),
                ...(flags['http-signin'] ? { signIn: true } : flags['no-signin'] ? { signIn: false } : {}),
            };
            const expires = parseExpires(flags.expires, now);
            if (expires !== undefined) entry.expiresAt = expires;
            const list = storedAliasInput(hostPolicy, cfg, err);
            const at = list.findIndex((a) => hostPolicy.parseSiteUrl(a.url).hostname === site.hostname);
            if (at === -1) list.push(entry);
            else list[at] = { ...list[at], ...entry, ...(expires === undefined ? {} : { expiresAt: expires }) };
            plan = siteAddress.planAliases(cfg, { aliases: list, confirmLocal: flags['confirm-local'] === true, actorId: null, via: 'cli', now });
        } else if (command === 'remove') {
            const hostname = hostnameArg(hostPolicy, positionals[0]);
            if (!hostname) throw new UsageError('remove needs a host name or address, e.g. www.example.com');
            if (policy.canonical && policy.canonical.hostname === hostname) {
                throw new UsageError(`${hostname} is the main address; change it with: npm run site -- canonical <url> --drop-old`);
            }
            const list = storedAliasInput(hostPolicy, cfg, err);
            const remaining = list.filter((a) => hostPolicy.parseSiteUrl(a.url).hostname !== hostname);
            if (remaining.length === list.length) throw new UsageError(`${hostname} is not one of the site's other addresses (see: npm run site -- list)`);
            plan = siteAddress.planAliases(cfg, { aliases: remaining, confirmLocal: true, actorId: null, via: 'cli', now });
        } else if (command === 'canonical') {
            const url = positionals[0];
            if (!url) throw new UsageError('canonical needs an address, e.g. https://example.com');
            const choices = ['keep-old', 'redirect-old', 'drop-old'].filter((f) => flags[f]);
            if (choices.length > 1) throw new UsageError('choose one of --keep-old, --redirect-old, --drop-old');
            const oldAddress = choices[0] === 'drop-old' ? 'drop' : choices[0] === 'redirect-old' ? 'redirect' : 'keep';
            plan = siteAddress.planCanonical(cfg, { url, oldAddress, actorId: null, via: 'cli', now });
        } else if (command === 'ip-literals') {
            plan = siteAddress.planPolicy(cfg, { ipLiterals: positionals[0] });
        } else if (command === 'ip-signin') {
            const value = positionals[0];
            if (value !== 'on' && value !== 'off') throw new UsageError('ip-signin needs on or off');
            const ipSignIn = value === 'on';
            notes = ipSignInNotes(policy, ipSignIn);
            // Already in force: nothing to write (a write would also pin a default ipLiterals into the file).
            plan = policy.ipSignIn === ipSignIn
                ? { unchanged: true }
                : siteAddress.planPolicy(cfg, { ipLiterals: storedIpLiterals(cfg), ipSignIn });
        } else {
            throw new UsageError(`unknown command ${JSON.stringify(command)}`);
        }
    } catch (e) {
        if (e instanceof UsageError) { err(`${e.message}\n\n${USAGE}`); return 2; }
        if (e && e.name === 'SiteAddressError') { err(e.message); return 1; }
        throw e;
    }

    if (plan.unchanged) {
        out('Nothing to change.');
        for (const note of notes) out(note);
        return 0;
    }

    // The interlock, as far as the server's files can tell: the gateway and frontend URLs. Recent use is
    // only known to the running server, which applies the same check to changes made in the admin screen.
    const rev = configManager.siteAddressRev(cfg);
    const next = siteAddress.applyPlan(cfg, plan, { via: 'cli', actorId: null, now });
    const dependents = siteAddress.interlock(next, plan.removedHosts, { now, lastSeen: { get: () => null } })
        .filter((d) => d.kind !== 'recent-use');
    if (dependents.length && !flags.force) {
        err('Refused: something still uses this address:');
        for (const d of dependents) err(`  ${d.kind} → ${d.detail}`);
        err('Change those first, or run the command again with --force.');
        return 1;
    }

    const written = configManager.updateConfig((current) => siteAddress.applyPlan(current, plan, { via: 'cli', actorId: null, now }), { expectRev: rev, reload: false });
    if (!written.ok) {
        err(written.reason === 'stale'
            ? 'The site address changed while this command ran (the admin screen or another command). Nothing was written; run it again.'
            : written.reason === 'unreadable'
                ? `${configManager.CONFIG_FILE} became unreadable; nothing was written.`
                : `${configManager.CONFIG_FILE} could not be written.`);
        return 1;
    }
    out(`Saved (revision ${rev + 1}): ${describePlan(plan)}`);
    if (dependents.length) out(`Forced past: ${dependents.map((d) => `${d.kind} ${d.detail}`).join(', ')}`);
    out('A running server applies it within a few seconds; a stopped one at its next start.');
    for (const note of notes) out(note);
    return 0;
}

function describePlan(plan) {
    const s = plan.summary;
    const list = (v) => (Array.isArray(v) && v.length ? v.join(', ') : 'none');
    if (plan.kind === 'canonical') return `main address ${s.from || '(none)'} → ${s.to} (old address: ${s.oldAddress})${s.rewritten && s.rewritten.length ? `; also updated ${s.rewritten.join(', ')}` : ''}`;
    if (plan.kind === 'aliases') return `added ${list(s.added)}; removed ${list(s.removed)}; changed ${list(s.changed)}`;
    return `IP addresses ${s.from} → ${s.to}; sign-in on IP addresses ${s.ipSignIn ? 'on' : 'off'}`;
}

module.exports = { run, parseArgs, parseExpires, USAGE };

if (require.main === module) {
    run(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
        console.error(e && e.stack ? e.stack : e);
        process.exit(1);
    });
}
