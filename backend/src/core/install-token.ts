/**
 * One-time INSTALL TOKEN for the pre-install setup endpoints.
 *
 * The POST /setup/install and POST /setup/test-db endpoints run BEFORE the instance is configured,
 * so they are necessarily unauthenticated and exempt from the install guard and CSRF. Without a
 * gate, anyone who can reach the not-yet-installed instance could complete the install themselves
 * (pre-install takeover: create the admin account, point the DB at their server, etc.).
 *
 * Defense: when the instance is NOT yet installed, the boot path generates a random token and the
 * operator supplies it to the installer (header `x-install-token` or body `installToken`). The setup
 * endpoints reject any request whose token is missing or does not match (constant-time).
 *
 * WHERE THE OPERATOR GETS IT — and why "from the logs" is only one of three answers. The value is
 * printed in the boot banner ONLY when stdout is a TTY, or when `WORDJS_PRINT_INSTALL_TOKEN=1` says
 * so; see `shouldPrintBootstrapSecret`. Otherwise the banner names the 0600 token file instead. The
 * backend's console output is bridged into structured JSON that operators are told to ship to a log
 * aggregator, and a bootstrap secret printed there is a bootstrap secret indexed there, forever.
 *
 * Headless/Docker support (DEPLOY-03): because stdout is not always readable in non-interactive
 * deploys, the token is ALSO (a) overridable via the WORDJS_INSTALL_TOKEN env var (operator supplies
 * their own out-of-band) and (b) mirrored to a 0600 file in the data dir so it can be read without
 * scraping logs. The file lives in the runtime's own (gitignored, never-shipped) data dir and is
 * removed once the instance is installed.
 *
 * Once the instance is installed the token is irrelevant — the setup endpoints already refuse to run
 * (they early-return when isInstalled()).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Where the token is mirrored to disk for headless/containerized installs (see below). Same data dir
// the rest of the runtime uses (crash-guard.ts / cert-manager.ts resolve it the same way).
const DATA_DIR = path.resolve(__dirname, '../../data');
const TOKEN_FILE = path.join(DATA_DIR, 'install-token');

// Module-level, in-memory only. Lost on restart (a fresh token is minted on the next boot while the
// instance remains uninstalled), which is the correct behavior for a one-time bootstrap secret.
let installToken: string | null = null;

// The value `config/app.ts` ships when nobody has configured anything. It is a PLACEHOLDER, not a
// statement about how this process serves, so it must not win over the env-derived origin below.
const DEFAULT_CONFIG_SITE_URL = 'http://localhost:3000';

/**
 * The origin printed in the install banner — display only; nothing is persisted from it (in setup mode
 * the site's real `siteUrl` is written by `POST /setup/install` from the wizard's own body).
 *
 * The rule, in order:
 *   1. A `siteUrl` the operator ACTUALLY configured wins, verbatim (minus a trailing slash). The
 *      untouched default is literally `http://localhost:3000`, so that exact value counts as "unset" —
 *      otherwise it would mask the dev default in 2.
 *   2. Otherwise derive the origin from how this process is serving, reading the same two variables
 *      `monolith.js` reads (and `core/cert-manager.getMonolithConfig()` mirrors):
 *        · scheme — `monolith.js resolveSSL()` returns null (plain HTTP) when `WORDJS_HTTP === '1'`;
 *          anything else means TLS (gateway sslAuto / the self-signed dev cert), so `https`.
 *        · port — `monolith.js` listens on `Number(process.env.PORT) || 3000`.
 *      The port is omitted when it is the default for the scheme, matching monolith.js's own redirect.
 *
 * WHY (DEPLOY-INSTALLTOKEN-07): the Docker image bakes `WORDJS_HTTP=1`, so a fresh container served
 * plain HTTP while this banner printed a hardcoded `https://localhost:3000/install#token=…` — a URL
 * that cannot connect, in the one place a first-time operator is told to click. The scheme now follows
 * the listener instead of being asserted.
 */
function resolveInstallBaseUrl(
    configuredSiteUrl?: unknown,
    env: Record<string, string | undefined> = process.env
): string {
    const configured = String(configuredSiteUrl || '').trim().replace(/\/+$/, '');
    if (configured && configured !== DEFAULT_CONFIG_SITE_URL) return configured;
    const scheme = env.WORDJS_HTTP === '1' ? 'http' : 'https';
    const port = Number(env.PORT) || 3000;
    const isDefaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
    return `${scheme}://localhost${isDefaultPort ? '' : `:${port}`}`;
}

/**
 * Should a bootstrap secret — this token, or the generated admin password in `index.ts` — be printed
 * to stdout at all?
 *
 * THE PROBLEM WITH "PRINT IT TO THE CONSOLE": a console is not what stdout is in most deployments. The
 * backend's console output is now bridged into structured JSON on stdout, which is exactly what
 * `documentation/observability.md` tells operators to ship to Loki/ELK/Datadog — so a printed token
 * stops being a line that scrolls past in a terminal and becomes a durable, indexed, searchable
 * credential in a log store, readable by everyone who can read logs. Message-level scrubbing in
 * `core/logger.ts` is a backstop for lines nobody audited; it is not a reason to print a secret we
 * control.
 *
 * THE RULE: print the value only when stdout is a TTY — an operator is genuinely watching a terminal,
 * which is the case the banner was written for — or when `WORDJS_PRINT_INSTALL_TOKEN=1` says the
 * operator has decided their log sink is trustworthy. Otherwise print WHERE to read it. Nothing is
 * lost in the headless case: the same token is in the 0600 file and can be supplied out-of-band
 * through `WORDJS_INSTALL_TOKEN`, which is how Docker, Compose, Helm and the E2E suite already do it.
 */
function shouldPrintBootstrapSecret(
    env: Record<string, string | undefined> = process.env,
    stream: any = process.stdout
): boolean {
    if (String(env.WORDJS_PRINT_INSTALL_TOKEN || '').trim() === '1') return true;
    return Boolean(stream && stream.isTTY);
}

/**
 * Generate (once) and return the install token, printing either the token or the way to read it —
 * see `shouldPrintBootstrapSecret`. Idempotent: repeated calls return the same token for the life of
 * the process (so anything already printed stays valid).
 *
 * Headless/Docker support (DEPLOY-03): in non-interactive deploys stdout may not be readable in time,
 * so in ADDITION to the console print we
 *   1. honor an operator-provided token via the WORDJS_INSTALL_TOKEN env var (so automation can supply
 *      it out-of-band, e.g. a Docker secret), instead of randomizing; and
 *   2. mirror the active token to a 0600 file in the data dir (TOKEN_FILE) so an operator can read it
 *      with `cat`/a mounted volume without scraping logs.
 * The security property (no pre-install takeover — the token is required and only obtainable by the
 * operator) is preserved: the file is the runtime's own data dir, written 0600.
 */
function generateInstallToken(): string {
    if (installToken) return installToken;
    // Operator override (e.g. headless/CI). Trimmed; ignored if blank so we fall back to a random token.
    // Entropy floor (DEPLOY-INSTALLTOKEN-06): a short/guessable operator value (e.g. "1", "test") would
    // reduce the pre-install takeover gate to a brute-forceable secret. Require >= 16 chars; otherwise
    // ignore the env value and fall back to the random token, warning the operator.
    const MIN_ENV_TOKEN_LEN = 16;
    const envTok = String(process.env.WORDJS_INSTALL_TOKEN || '').trim();
    if (envTok && envTok.length < MIN_ENV_TOKEN_LEN) {
        console.warn(`[install-token] WORDJS_INSTALL_TOKEN is too short (< ${MIN_ENV_TOKEN_LEN} chars); ignoring it and generating a random token instead.`);
    }
    const tok: string = (envTok.length >= MIN_ENV_TOKEN_LEN ? envTok : crypto.randomBytes(24).toString('hex'));
    installToken = tok;

    // Mirror to a 0600 file in the data dir for headless retrieval. Best-effort: a failure here must
    // never block boot — the console print + env override still provide the token. writeFileSync's
    // `mode` is ignored when the file already exists, so we chmod after the write to guarantee 0600 on
    // every platform/path (matching cert-manager.ts).
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(TOKEN_FILE, tok, { mode: 0o600 });
        try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* chmod is a no-op on some filesystems (e.g. Windows) */ }
    } catch (e: any) {
        console.warn('[install-token] could not write token file:', e && e.message);
    }

    // One clickable URL beats hunting a 48-char token in interleaved service logs: the installer
    // page reads the token out of the URL FRAGMENT (#token=) and prefills it (then scrubs it from
    // the address bar).
    // SECURITY: the fragment — not a ?token= query string. A query string is sent to the server on
    // every request, so it lands in access/proxy logs and in the `Referer` of any sub-resource the
    // page loads; the fragment is never transmitted and is stripped from Referer by the URL spec.
    // Both still end up in the browser's own history, which is why the page scrubs the address bar.
    // The origin is derived from how THIS process is actually serving — see resolveInstallBaseUrl.
    const cfgSiteUrl = (() => {
        try {
            return require('../config/app').siteUrl;
        } catch {
            return null; // pre-config boot — the env-derived default is right
        }
    })();
    const siteUrl = resolveInstallBaseUrl(cfgSiteUrl);
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔑 WordJS is not installed yet — finish setup in your browser:');
    console.log('');
    if (shouldPrintBootstrapSecret()) {
        console.log(`   → ${siteUrl}/install#token=${tok}`);
        console.log('');
        console.log(`   Install token (if you prefer to paste it): ${tok}`);
        console.log(`   (Also written to ${TOKEN_FILE} (0600) for headless installs;`);
        console.log('    or set WORDJS_INSTALL_TOKEN to supply your own. Held in memory; removed once installed.)');
    } else {
        // NOTE: the URL is printed WITHOUT the fragment. `#token=` keeps the value out of access and
        // proxy logs, which is a different problem from the one here — this line is itself the log.
        console.log(`   → ${siteUrl}/install`);
        console.log('');
        console.log('   The install token is NOT printed: stdout is not a terminal, so this line would be');
        console.log('   shipped to whatever aggregates these logs. Read it from the file instead:');
        console.log('');
        console.log(`      cat ${TOKEN_FILE}`);
        console.log('');
        console.log('   (0600, this host only. Or set WORDJS_INSTALL_TOKEN to supply your own token,');
        console.log('    or WORDJS_PRINT_INSTALL_TOKEN=1 to print it here anyway. Held in memory;');
        console.log('    removed once installed.)');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    return tok;
}

/**
 * Remove the on-disk token mirror. Called once the instance is installed (the token is irrelevant
 * thereafter — the setup endpoints already refuse to run) so the bootstrap secret does not linger on
 * disk. Best-effort and idempotent: a missing file or unlink failure is ignored.
 */
function clearInstallTokenFile(): void {
    try { fs.unlinkSync(TOKEN_FILE); } catch { /* already gone / not writable — ignore */ }
}

/** The current in-memory token (or null if not generated yet). */
function getInstallToken(): string | null {
    return installToken;
}

/**
 * Constant-time check of an operator-provided token against the in-memory token. Returns false when
 * no token has been generated (fail-closed) or the provided value is empty / mismatched.
 */
function verifyInstallToken(provided: unknown): boolean {
    if (!installToken) return false;
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(installToken);
    // timingSafeEqual throws on length mismatch — guard first so a wrong-length token returns false
    // instead of throwing.
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

module.exports = {
    generateInstallToken,
    getInstallToken,
    verifyInstallToken,
    clearInstallTokenFile,
    resolveInstallBaseUrl,
    shouldPrintBootstrapSecret,
    INSTALL_TOKEN_FILE: TOKEN_FILE,
};
