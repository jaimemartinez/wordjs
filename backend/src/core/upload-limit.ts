/**
 * The largest file an upload may carry, set from the admin panel (Settings → Media → «Maximum upload
 * size»), ZERO CONFIG: it used to exist only as `uploads.maxFileSize` in wordjs-config.json, so raising it
 * meant editing a file on the server and restarting. The option is in whole megabytes (1–2048); empty
 * means the configured default (10 MB unless the config file says otherwise).
 */
const { getOption } = require('./options');
const appConfig = require('../config/app');

const UPLOAD_LIMIT_OPTION = 'upload_max_size_mb';
const MAX_UPLOAD_MB = 2048;
const MIB = 1024 * 1024;

function defaultUploadBytes(): number {
    const configured = Number(appConfig.uploads && appConfig.uploads.maxFileSize);
    return Number.isFinite(configured) && configured > 0 ? configured : 10 * MIB;
}

/** The option's value as whole megabytes, or null when it is empty / not a valid size. */
function parseUploadLimitMb(value: unknown): number | null {
    const s = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : '');
    if (!/^[0-9]{1,4}$/.test(s)) return null;
    const n = Number(s);
    return n >= 1 && n <= MAX_UPLOAD_MB ? n : null;
}

/** Why a value cannot be saved, or null ('' clears the option back to the default). */
function uploadLimitProblem(value: unknown): string | null {
    if (value === '' || value === null || value === undefined) return null;
    return parseUploadLimitMb(value) === null ? `${UPLOAD_LIMIT_OPTION} must be a whole number of megabytes from 1 to ${MAX_UPLOAD_MB}, or empty for the default.` : null;
}

/** The effective limit in bytes: the panel's value, else the configured default. */
async function maxUploadBytes(): Promise<number> {
    const mb = parseUploadLimitMb(await getOption(UPLOAD_LIMIT_OPTION, ''));
    return mb ? mb * MIB : defaultUploadBytes();
}

/** "10 MB" for messages. */
function formatUploadLimit(bytes: number): string {
    const mb = bytes / MIB;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

module.exports = { UPLOAD_LIMIT_OPTION, MAX_UPLOAD_MB, maxUploadBytes, defaultUploadBytes, parseUploadLimitMb, uploadLimitProblem, formatUploadLimit };
