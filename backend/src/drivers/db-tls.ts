/**
 * WordJS — TLS options for the Postgres and MySQL connections.
 *
 * One builder for every place that opens a server database connection (the two drivers, the MySQL
 * per-plugin pools and the installer's connection test), so they cannot disagree about what `ssl`
 * means.
 *
 * With `ssl` on, the server certificate is VERIFIED (chain + host name) by default. Before, every
 * connection hard-coded `rejectUnauthorized: false`: the traffic was encrypted but anyone on the path
 * could present any certificate and read or rewrite it. Two settings cover the cases verification
 * needs help with:
 *
 *   dbSslCa                  (or db.sslCa)  the CA that signed the server certificate — a PEM string
 *                                           or a path to a PEM file (relative paths resolve against
 *                                           the backend directory). Typical for managed databases and
 *                                           private CAs.
 *   dbSslRejectUnauthorized  (or db.sslRejectUnauthorized)  `false` restores the old unverified
 *                                           behaviour. An explicit opt-out, logged at every connect.
 */

const fs = require('fs');
const path = require('path');

export interface DbTlsConfig {
    ssl?: boolean;
    sslCa?: string;
    sslRejectUnauthorized?: boolean;
}

export interface DbTlsOptions {
    rejectUnauthorized: boolean;
    ca?: string;
}

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

/** The CA PEM for `value`: inline PEM as is, otherwise the contents of the file it names. */
export function resolveCa(value: string, baseDir: string = BACKEND_ROOT): string {
    const v = String(value);
    if (v.includes('-----BEGIN')) return v;
    return fs.readFileSync(path.resolve(baseDir, v), 'utf8');
}

/**
 * The `ssl` option for pg / mysql2, or `undefined` when TLS is off. Throws when `sslCa` names a file
 * that cannot be read — a configured CA that silently went missing must not degrade to "no CA".
 */
export function dbTlsOptions(db: DbTlsConfig | null | undefined): DbTlsOptions | undefined {
    if (!db || !db.ssl) return undefined;
    const opts: DbTlsOptions = { rejectUnauthorized: db.sslRejectUnauthorized !== false };
    if (db.sslCa) opts.ca = resolveCa(db.sslCa);
    return opts;
}

/** Node/OpenSSL error codes that mean "the server's certificate could not be verified". */
const CERT_ERROR_CODES = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'CERT_UNTRUSTED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'HOSTNAME_MISMATCH',
]);

export function isCertificateError(err: any): boolean {
    return !!err && (CERT_ERROR_CODES.has(err.code) || /self[- ]signed certificate|unable to verify|certificate has expired|Hostname\/IP does not match/i.test(String(err.message || '')));
}

/** The operator-facing explanation for a certificate failure (no secrets, no connection details). */
export const DB_TLS_VERIFY_HINT =
    'The database server\'s TLS certificate could not be verified. Database TLS is verified by default: ' +
    'set "dbSslCa" in wordjs-config.json to the CA certificate (PEM file path or contents) that signed the ' +
    'server certificate, or — only if you accept an unverified connection — set "dbSslRejectUnauthorized": false.';

export const DB_TLS_UNVERIFIED_WARNING =
    'Database TLS certificate verification is DISABLED (dbSslRejectUnauthorized: false): the connection is ' +
    'encrypted but the server is not authenticated. Set "dbSslCa" and remove the opt-out to verify it.';
