/**
 * One-time INSTALL TOKEN for the pre-install setup endpoints.
 *
 * The POST /setup/install and POST /setup/test-db endpoints run BEFORE the instance is configured,
 * so they are necessarily unauthenticated and exempt from the install guard and CSRF. Without a
 * gate, anyone who can reach the not-yet-installed instance could complete the install themselves
 * (pre-install takeover: create the admin account, point the DB at their server, etc.).
 *
 * Defense: when the instance is NOT yet installed, the boot path generates a random token and prints
 * it to the server console. The operator reads it from the logs and supplies it to the installer
 * (header `x-install-token` or body `installToken`). The setup endpoints reject any request whose
 * token is missing or does not match (constant-time).
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

/**
 * Generate (once) and return the install token, logging it clearly to the console so the operator can
 * copy it into the installer. Idempotent: repeated calls return the same token for the life of the
 * process (so the printed value stays valid).
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
    // page reads ?token= and prefills it (then scrubs it from the address bar).
    // Default dev serves HTTPS on :3000 (gateway sslAuto / monolith resolveSSL), but the config's
    // untouched default says http:// — so only trust siteUrl when the operator actually set it.
    let siteUrl = 'https://localhost:3000';
    try {
        const cfgUrl = require('../config/app').siteUrl;
        if (cfgUrl && cfgUrl !== 'http://localhost:3000') siteUrl = cfgUrl;
    } catch { /* pre-config boot — dev default above is right */ }
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔑 WordJS is not installed yet — finish setup in your browser:');
    console.log('');
    console.log(`   → ${siteUrl.replace(/\/$/, '')}/install?token=${tok}`);
    console.log('');
    console.log(`   Install token (if you prefer to paste it): ${tok}`);
    console.log(`   (Also written to ${TOKEN_FILE} (0600) for headless installs;`);
    console.log('    or set WORDJS_INSTALL_TOKEN to supply your own. Held in memory; removed once installed.)');
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

module.exports = { generateInstallToken, getInstallToken, verifyInstallToken, clearInstallTokenFile };
