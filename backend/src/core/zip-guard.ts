/**
 * WordJS — ZIP extraction guard (decompression-bomb / resource DoS defense).
 *
 * multer caps the COMPRESSED upload (10MB), but a small DEFLATE stream can expand to many GB
 * (ratios ~1000:1 are trivial), filling the host disk and taking the whole CMS down before any
 * per-entry zip-slip check even runs. Call assertZipWithinBudget() on the adm-zip entries BEFORE
 * extractAllTo()/getData() on every extraction path (plugin upload, theme upload, backup restore).
 *
 * adm-zip exposes each entry's declared uncompressed size at entry.header.size — we sum it and
 * cap the total + the entry count. The declared size can lie, but adm-zip allocates buffers from
 * it, so an inflated declaration is itself rejected here (fail-closed) and a deflated one still
 * can't exceed the cap in practice for the archive sizes we accept.
 */

export interface ZipBudget {
    maxTotalBytes?: number;
    maxEntries?: number;
    /** label used in the thrown message, e.g. 'plugin' / 'theme' / 'backup' */
    kind?: string;
}

const DEFAULTS = { maxTotalBytes: 200 * 1024 * 1024, maxEntries: 5000 };

function fmtMB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Throws an Error (with .code = 'ZIP_BUDGET_EXCEEDED') if the archive's declared uncompressed
 * footprint exceeds the budget. Safe to call with adm-zip's getEntries() result.
 */
export function assertZipWithinBudget(entries: any[], opts: ZipBudget = {}): void {
    const maxTotal = opts.maxTotalBytes ?? DEFAULTS.maxTotalBytes;
    const maxEntries = opts.maxEntries ?? DEFAULTS.maxEntries;
    const kind = opts.kind || 'archive';

    if (!Array.isArray(entries)) return;

    if (entries.length > maxEntries) {
        const err: any = new Error(`This ${kind} archive has ${entries.length} entries, over the ${maxEntries} limit. Refusing to extract (possible zip bomb).`);
        err.code = 'ZIP_BUDGET_EXCEEDED';
        throw err;
    }

    let total = 0;
    for (const e of entries) {
        // header.size is the declared uncompressed size; missing → treat as 0 (dirs, etc.)
        const size = (e && e.header && typeof e.header.size === 'number') ? e.header.size : 0;
        const compressed = (e && e.header && typeof e.header.compressedSize === 'number') ? e.header.compressedSize : 0;
        const isDir = !!(e && (e.isDirectory || (typeof e.entryName === 'string' && e.entryName.endsWith('/'))));
        if (size < 0) continue;
        // A NON-directory entry that carries real compressed bytes but DECLARES uncompressed size 0 is
        // lying to disable BOTH this budget sum AND adm-zip's maxOutputLength cap (which it derives from
        // the declared size) — the classic size-0 decompression bomb. Refuse it (audit LOW).
        if (!isDir && size === 0 && compressed > 64) {
            const err: any = new Error(`This ${kind} archive has an entry declaring a bogus zero uncompressed size (possible decompression bomb). Refusing to extract.`);
            err.code = 'ZIP_BUDGET_EXCEEDED';
            throw err;
        }
        total += size;
        if (total > maxTotal) {
            const err: any = new Error(`This ${kind} archive expands to over ${fmtMB(maxTotal)} uncompressed. Refusing to extract (possible decompression bomb).`);
            err.code = 'ZIP_BUDGET_EXCEEDED';
            throw err;
        }
    }
}

module.exports = { assertZipWithinBudget };
