/**
 * Media storage quotas on the network screen (admin/network): typed and shown in MB, stored in bytes by
 * the server (backend core/network effectiveUploadQuota). Pure helpers, shared by the page and its test.
 */

export const MB = 1024 * 1024;

/** Bytes -> the MB a field shows ('' for no value). */
export function toMbField(bytes: number | null | undefined): string {
    return bytes === null || bytes === undefined ? "" : String(Math.round((bytes / MB) * 100) / 100);
}

/** A typed MB field -> bytes; null for empty (no limit); undefined when it is not a number of megabytes. */
export function fromMbField(v: string): number | null | undefined {
    const s = v.trim();
    if (!s) return null;
    if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return undefined;
    return Math.round(Number(s) * MB);
}

/** A byte count for people. */
export function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
    return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}
