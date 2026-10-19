/**
 * WordJS — per-site upload quota (multisite).
 *
 * A network administrator can cap how many bytes of media a site other than site 1 holds
 * (core/network effectiveUploadQuota: the site's own value, else the network default). The usage is
 * the size of every attachment the site has — public and private, the original and each stored
 * derivative — as recorded in its `_wp_attachment_metadata` (filesize of the original, of each entry
 * of `sizes` and of each modern-format `sources` sibling). It is counted from the database, not the
 * disk, so it is the same whether the bytes are on this node, in the private root or in the bucket.
 *
 * Site 1 and a single-site install have no quota: nothing here runs a query for them.
 */

const siteContext = require('./site-context');

/** Usage is recomputed at most this often per site; every upload or delete through this module drops it. */
const USAGE_TTL_MS = 30_000;
const usageCache = new Map<number, { bytes: number; at: number }>();

function n(v: unknown): number {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
}

/** Bytes one attachment's metadata accounts for (original + derivatives). */
function metadataBytes(md: any): number {
    if (!md || typeof md !== 'object') return 0;
    let total = n(md.filesize);
    for (const group of [md.sizes, md.sources]) {
        if (!group || typeof group !== 'object') continue;
        for (const entry of Object.values(group) as any[]) {
            if (!entry || typeof entry !== 'object') continue;
            total += n(entry.filesize);
            // A size can carry its own modern-format siblings.
            if (entry.sources && typeof entry.sources === 'object') {
                for (const s of Object.values(entry.sources) as any[]) total += n(s && s.filesize);
            }
        }
    }
    return total;
}

/** The current site's media usage in bytes. */
async function siteUploadUsage(): Promise<number> {
    const siteId = siteContext.currentSiteId();
    const hit = usageCache.get(siteId);
    if (hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.bytes;
    const { dbAsync } = require('../config/database');
    const rows = await dbAsync.all(
        `SELECT pm.meta_value AS v FROM post_meta pm JOIN posts p ON p.id = pm.post_id
         WHERE pm.meta_key = '_wp_attachment_metadata' AND p.post_type = 'attachment'`
    );
    let bytes = 0;
    for (const row of rows) {
        let md: any = row.v;
        if (typeof md === 'string') { try { md = JSON.parse(md); } catch { md = null; } }
        bytes += metadataBytes(md);
    }
    usageCache.set(siteId, { bytes, at: Date.now() });
    return bytes;
}

/** The quota in effect for the current site, or null (no limit). */
function currentQuota(): number | null {
    if (!siteContext.multisiteEnabled()) return null;
    const siteId = siteContext.currentSiteId();
    if (siteId === siteContext.PRIMARY_SITE_ID) return null;
    return require('./network').effectiveUploadQuota(siteId);
}

/**
 * Would `incomingBytes` more fit in the current site's quota? Resolves with the figures; `ok` is true
 * when there is no quota. Never throws for a site without one.
 */
async function checkUploadFits(incomingBytes: number): Promise<{ ok: boolean; quota: number | null; used: number; incoming: number }> {
    const quota = currentQuota();
    const incoming = n(incomingBytes);
    if (quota === null) return { ok: true, quota: null, used: 0, incoming };
    const used = await siteUploadUsage();
    return { ok: used + incoming <= quota, quota, used, incoming };
}

/** Drop the current site's cached usage (after an upload or a delete changed it). */
function invalidateUsage(siteId: number | null = siteContext.currentSiteIdOrNull()): void {
    if (siteId !== null) usageCache.delete(siteId);
}

/** The REST error body for a refused upload. */
function quotaExceededBody(r: { quota: number | null; used: number }) {
    return {
        code: 'rest_upload_quota_exceeded',
        message: 'This site has used its storage quota for media. Delete media you no longer need, or ask the network administrator for more space.',
        data: { status: 413, quota: r.quota, used: r.used },
    };
}

module.exports = { siteUploadUsage, checkUploadFits, invalidateUsage, quotaExceededBody, metadataBytes, currentQuota, USAGE_TTL_MS };
