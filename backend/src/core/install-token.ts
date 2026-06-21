/**
 * One-time INSTALL TOKEN for the pre-install setup endpoints.
 *
 * The POST /setup/install and POST /setup/test-db endpoints run BEFORE the instance is configured,
 * so they are necessarily unauthenticated and exempt from the install guard and CSRF. Without a
 * gate, anyone who can reach the not-yet-installed instance could complete the install themselves
 * (pre-install takeover: create the admin account, point the DB at their server, etc.).
 *
 * Defense: when the instance is NOT yet installed, the boot path generates a random token, holds it
 * ONLY in memory (never persisted to disk), and prints it to the server console. The operator reads
 * it from the logs and supplies it to the installer (header `x-install-token` or body `installToken`).
 * The setup endpoints reject any request whose token is missing or does not match (constant-time).
 *
 * Once the instance is installed the token is irrelevant — the setup endpoints already refuse to run
 * (they early-return when isInstalled()).
 */
const crypto = require('crypto');

// Module-level, in-memory only. Lost on restart (a fresh token is minted on the next boot while the
// instance remains uninstalled), which is the correct behavior for a one-time bootstrap secret.
let installToken: string | null = null;

/**
 * Generate (once) and return the in-memory install token, logging it clearly to the console so the
 * operator can copy it into the installer. Idempotent: repeated calls return the same token for the
 * life of the process (so the printed value stays valid).
 */
function generateInstallToken(): string {
    if (installToken) return installToken;
    const tok: string = crypto.randomBytes(24).toString('hex');
    installToken = tok;
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔑 WordJS install token:');
    console.log(`   ${tok}`);
    console.log('   Paste this into the installer to complete setup.');
    console.log('   (Shown only while WordJS is not yet installed; it is held in memory only.)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    return tok;
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

module.exports = { generateInstallToken, getInstallToken, verifyInstallToken };
