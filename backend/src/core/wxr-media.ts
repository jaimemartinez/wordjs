/**
 * WordJS — WXR media import: the attachment half of core/wxr-import.ts.
 *
 * WHY A MODULE OF ITS OWN. Importing an attachment is not "one more item type": it is a host-side
 * NETWORK FETCH of a third party's URL followed by a WRITE into the uploads directory. Both halves have
 * their own guards — the egress/SSRF discipline core/webhooks.ts and routes/marketplace.ts already
 * share, and the containment proof core/safe-path.ts owns — and neither belongs inline in the item loop.
 * wxr-import.ts requires THIS module; this module never requires it back (a cycle here would be the
 * io-guard footgun again).
 *
 * WHAT THE DOWNLOAD REUSES, VERBATIM. `egress.assertUrlAllowed` (resolve, then reject loopback /
 * private / CGNAT / ULA / link-local / metadata, failing CLOSED on a resolution error) and
 * `egress.validatingLookup` (pin the validated IP at connect time, so a hostname cannot rebind between
 * the check and the socket). Redirects are followed MANUALLY with the FULL guard re-run on every hop, so
 * a public https URL cannot 302 into 169.254.169.254. This is the same shape routes/marketplace.ts'
 * fetchRemote uses — deliberately, because that is the one host-side download in this codebase that has
 * already been audited, and a second, subtly weaker copy is how SSRF comes back.
 *
 * WHAT THE WRITE REUSES. The attachment ROW, its `_wp_attached_file` / `_wp_attachment_metadata` and its
 * alt text are created by models/Media.create() — the same function the upload route calls — so an
 * imported attachment is indistinguishable from an uploaded one to every reader. Only the BYTES are
 * written here, because the code that writes an upload's bytes lives inside routes/media.ts (multer's
 * diskStorage callbacks plus the sharp ladder) and is not callable from outside that file. What that
 * costs an import, and what would have to be extracted to change it, is in
 * documentation/wordpress-import.md.
 *
 * WHAT IS REFUSED, AND WHY IT IS REFUSED HERE. The uploads directory is served by express.static, so a
 * stored `.html`/`.js`/`.php` is stored XSS/RCE on the migrated site — the WXR names both the path and
 * the MIME type and both come from a third party. So the extension must be on models/Media's own
 * allowlist, the resolved path must prove containment under the uploads root, and a bounded magic-byte
 * check must not contradict the declared type. `image/svg+xml` is refused outright: the upload route
 * sanitizes SVG with an explicit sanitize-html allowlist that is inlined in routes/media.ts, and storing
 * an UNSANITIZED SVG would be strictly worse than not importing it.
 *
 * CONTAINMENT IS NOT UNIQUENESS — the other half of "where do the bytes go". The upload route makes a
 * collision IMPOSSIBLE by construction (multer appends a uuid slice to every stored name, which is what
 * lets index.ts serve `/uploads` as `immutable`); an import that PRESERVES the WXR's own path gives that
 * property up, and proving containment does not give it back. So a path a third party names is CLAIMED
 * here before it is written: if anything already holds it — a row in the media library, a file on disk,
 * or an earlier item in this same run — the stem is disambiguated (`photo-1.jpg`, as WordPress itself
 * does) and the NEW path is what the row and the in-content URL rewrite both use. Without that, a WXR
 * naming an existing upload silently overwrites someone else's bytes, two items share one file (so
 * deleting either strands the other), and — because a dot-leading segment is a legal plain segment —
 * `.derivatives/<xx>/<sha>.webp` lands inside the image-negotiation cache that is served as immutable.
 * A dot-leading segment is therefore refused outright for an imported path; nothing a WordPress export
 * legitimately carries starts with one.
 */

import type { IncomingMessage } from 'http';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Media = require('../models/Media');
const Post = require('../models/Post');
const config = require('../config/app');
const egress = require('./egress-guard');
const { runContentMutation } = require('./content-outbox');
// isPlainSegment is the FORM gate a path segment must pass before it can become a path, and
// resolveWithin is the containment proof at the sink — the two halves core/safe-path keeps together.
const { isPlainSegment, resolveWithin } = require('./safe-path');

// ---------------------------------------------------------------------------
// Stored-path validation (shared with the postmeta writer in wxr-import.ts)
// ---------------------------------------------------------------------------

/** The longest attachment path the importer will accept (post_meta.meta_value is TEXT; be modest). */
const MAX_ATTACHED_FILE_LENGTH = 255;
/** A sane ceiling on directory depth — WordPress writes `YYYY/MM/name.ext`. */
const MAX_ATTACHED_FILE_DEPTH = 6;

/**
 * Normalize an imported `_wp_attached_file` value, or null when its SHAPE is not resolvable.
 * Returns the path with forward slashes, which is what Media.formatAttachment expects.
 */
function safeAttachedFile(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (value.length === 0 || value.length > MAX_ATTACHED_FILE_LENGTH) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null; // an absolute URL is not a stored path
    // AN ABSOLUTE PATH IS REFUSED, NOT MADE RELATIVE. Splitting on separators and dropping the empty
    // leading segment would silently turn `/etc/passwd` into `etc/passwd` — a value that then passes
    // every remaining check. Repairing an input is how a checked representation and a stored one come
    // apart; the only safe answer to "this is not the shape" is to drop it.
    if (/^[/\\]/.test(value)) return null;
    const segments = value.split(/[/\\]+/).filter((s: string) => s.length > 0);
    if (segments.length === 0 || segments.length > MAX_ATTACHED_FILE_DEPTH) return null;
    if (!segments.every((s: string) => isPlainSegment(s))) return null;
    // A DOT-LEADING SEGMENT IS NOT A WORDPRESS UPLOAD PATH. isPlainSegment refuses `.` and `..` but
    // allows `.derivatives` — and that particular name is the image-negotiation cache under the same
    // uploads root (middleware/image-negotiation.ts), served with `Cache-Control: immutable`. An
    // imported `.derivatives/<xx>/<sha256>.webp` would therefore hand every WebP-capable client an
    // attacker's image at a legitimate URL, indefinitely. index.ts also serves `/uploads` with
    // `dotfiles: 'deny'`, so such a path could never be fetched back under its own name anyway: it is
    // only ever a way to write somewhere the importer does not own. Refused for every dot-directory,
    // not just that one, because the next such cache would inherit the same hole.
    if (segments.some((s: string) => s.startsWith('.'))) return null;
    return segments.join('/');
}

/**
 * Normalize an imported `_wp_attachment_metadata` value, or null when it is not usable.
 *
 * WXR carries this key PHP-serialized in the general case, which we cannot (and need not) read: those
 * values are dropped, exactly as they were while the key was banned. A JSON object — what WordJS's own
 * exporter emits, so a WordJS->WordJS round trip keeps its thumbnails — is accepted only when every
 * file name inside it passes the same shape gate as the main path, because `sizes[*].file` is the
 * OTHER unlink target Media._deletableFiles builds.
 */
function safeAttachmentMetadata(raw: string): string | null {
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.file !== undefined && (typeof parsed.file !== 'string' || !safeAttachedFile(parsed.file))) return null;
    const sizes = parsed.sizes;
    if (sizes !== undefined) {
        if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) return null;
        for (const size of Object.values(sizes)) {
            const file = (size as any)?.file;
            if (file === undefined) continue;
            if (typeof file !== 'string' || !safeAttachedFile(file)) return null;
        }
    }
    try { return JSON.stringify(parsed); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Extension / MIME policy — derived from models/Media, never re-listed here
// ---------------------------------------------------------------------------

/**
 * Extension -> MIME, built from models/Media.getAllowedMimeTypes() so this module can never drift from
 * the policy the upload route enforces. Keys there are alternation groups ('jpg|jpeg|jpe'), so each
 * spelling gets its own entry: unlike an upload, an import must PRESERVE the original file name (that
 * is what makes the in-content URL rewrite a pure prefix swap), so `.jpeg` has to stay `.jpeg`.
 */
let extensionMimes: Map<string, string> | null = null;
function extensionMimeMap(): Map<string, string> {
    if (extensionMimes) return extensionMimes;
    const map = new Map<string, string>();
    for (const [group, mime] of Object.entries(Media.getAllowedMimeTypes() as Record<string, string>)) {
        for (const ext of group.split('|')) map.set(ext.toLowerCase(), mime);
    }
    extensionMimes = map;
    return map;
}

/**
 * SVG is on the upload allowlist but reaches disk only after routes/media.ts runs it through an explicit
 * sanitize-html tag/attribute allowlist. That sanitizer is inlined in the route, so an importer cannot
 * call it — and an unsanitized SVG under a statically-served uploads directory is stored XSS. Refused.
 */
const REFUSED_IMPORT_MIMES: Set<string> = new Set(['image/svg+xml']);

/** Types whose binary signature must be confirmable (mirrors the upload route's `requiresSignature`). */
function requiresSignature(mime: string): boolean {
    return (mime.startsWith('image/') && mime !== 'image/svg+xml') || mime === 'application/pdf';
}

// ---------------------------------------------------------------------------
// Download — SSRF-guarded, bounded, redirect-revalidating
// ---------------------------------------------------------------------------

/** Default per-file ceiling. Overridable per import; the option is documented. */
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Default ceiling for the whole run, so one WXR cannot fill the disk. */
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
/** Enough for every signature file-type recognises; also bounds what its parser can iterate over. */
const MAGIC_BYTES = 4100;
/** ASF/WMV/WMA header GUID — see routes/media.ts for why this parser path is skipped, not parsed. */
const ASF_GUID = Buffer.from([
    0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11,
    0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
]);

export type MediaMode = 'download' | 'skip' | 'link';

interface MediaSettings {
    mode: MediaMode;
    /** Opt-in to `http://` sources. Off by default: a migration source that is not https is a downgrade. */
    allowHttp: boolean;
    maxFileBytes: number;
    maxTotalBytes: number;
    timeoutMs: number;
}

/**
 * Is this the explicit DEV loopback exception — the same seam routes/marketplace.ts carries, and the
 * only way a test can serve fixtures from its own http.createServer without a live network?
 *
 * All three conditions are required, and the http opt-in is one of them: with `allowHttp` off (the
 * default) an `http://127.0.0.1/...` attachment is refused on the SCHEME before the egress guard is
 * even consulted, and an `https://` host that RESOLVES to a private address is refused by the guard.
 * `nodeEnv` is read at call time, never captured, so it cannot be frozen at require order.
 */
function isDevLoopback(u: URL, allowHttp: boolean): boolean {
    if (!allowHttp || u.protocol !== 'http:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return false;
    return (config.nodeEnv || process.env.NODE_ENV || 'production') !== 'production';
}

/** Parse + scheme-check an attachment URL. Throws with a reportable reason. */
function assertSaneAttachmentUrl(rawUrl: string, allowHttp: boolean): URL {
    let u: URL;
    try { u = new URL(String(rawUrl)); } catch { throw new Error('attachment URL is not a valid absolute URL'); }
    if (u.protocol === 'https:') return u;
    if (u.protocol === 'http:') {
        if (!allowHttp) throw new Error('refused: http:// source (enable the http opt-in to allow it)');
        return u;
    }
    throw new Error(`refused: unsupported URL scheme ${u.protocol}`);
}

/**
 * The RUN's download budget, mutated as bytes arrive.
 *
 * WHY IT IS A LIVE COUNTER AND NOT A PRE-CHECK. `maxTotalBytes` is documented as bounding the whole run
 * with the stream aborted "the moment either cap is exceeded". Checked once per item against the bytes
 * already STORED, it bounded neither: bytes downloaded and then refused by the magic-byte check, or lost
 * to a failed record write, were never counted at all — so a WXR of files that all fail verification
 * downloaded without limit — and even in the success path a pre-check can overshoot by a whole
 * `maxFileBytes`. `fetched` therefore counts EVERY byte read off the socket, including refused items and
 * redirect hops, and the per-chunk handler destroys the response the moment it crosses `limit`.
 */
interface DownloadBudget {
    fetched: number;
    limit: number;
}

/**
 * Fetch one attachment. Rejects on an SSRF-blocked target, a non-2xx status, a body over `maxFileBytes`,
 * the run's total byte budget, a redirect loop, or a timeout — every one of which the caller records per
 * item and continues past.
 */
async function fetchAttachment(
    rawUrl: string, settings: MediaSettings, budget: DownloadBudget, hops = 0,
): Promise<Buffer> {
    const u = assertSaneAttachmentUrl(rawUrl, settings.allowHttp);
    const devLoopback = isDevLoopback(u, settings.allowHttp);
    if (!devLoopback) await egress.assertUrlAllowed(u.href); // throws on an internal/blocked target
    const lib = u.protocol === 'https:' ? https : http;
    return await new Promise<Buffer>((resolve, reject) => {
        const opts: any = {
            method: 'GET',
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: (u.pathname || '/') + (u.search || ''),
            timeout: settings.timeoutMs,
            headers: { 'user-agent': 'WordJS-Importer' },
        };
        if (!devLoopback) opts.lookup = egress.validatingLookup; // pin the validated IP (no DNS rebinding)
        const req = lib.request(opts, (res: IncomingMessage) => {
            const status = res.statusCode || 0;
            // Redirects are followed MANUALLY so the next hop re-runs the FULL guard (scheme + resolved
            // IP) BEFORE we connect to it — a public host cannot 302 into a private range.
            if (status >= 300 && status < 400 && res.headers.location) {
                res.destroy();
                if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
                let next: string;
                try { next = new URL(String(res.headers.location), u).href; } catch { return reject(new Error('invalid redirect target')); }
                resolve(fetchAttachment(next, settings, budget, hops + 1));
                return;
            }
            if (status < 200 || status >= 300) { res.destroy(); return reject(new Error(`HTTP ${status}`)); }
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (c: Buffer) => {
                total += c.length;
                // Count it BEFORE deciding: a byte that arrived is a byte this run pulled, whether or not
                // the item it belongs to ends up stored.
                budget.fetched += c.length;
                if (total > settings.maxFileBytes) {
                    res.destroy();
                    reject(new Error(`file exceeds the ${settings.maxFileBytes}-byte per-file cap`));
                    return;
                }
                if (budget.fetched > budget.limit) {
                    res.destroy();
                    reject(new Error(`import reached the ${budget.limit}-byte total cap`));
                    return;
                }
                chunks.push(c);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('download timed out')));
        req.end();
    });
}

/**
 * Bounded magic-byte check over the downloaded head. Returns a reason to REFUSE, or null.
 *
 * Same three bounds routes/media.ts applies (head-only buffer, ASF skipped rather than parsed, detection
 * raced against a timeout), for the same GHSA-5v7r-6r5c-r473 reason.
 */
/** The MIME file-type recognises in `head`, or null when it recognises nothing (never throws). */
async function detectHeadMime(head: Buffer): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
        const fileType = require('file-type');
        const timeout = new Promise<null>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('detect timeout')), 3000);
        });
        const result: any = await Promise.race([fileType.fromBuffer(head), timeout]);
        return result && typeof result.mime === 'string' ? result.mime : null;
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function magicByteProblem(body: Buffer, mimeType: string): Promise<string | null> {
    const head = body.subarray(0, MAGIC_BYTES);
    const unverified = requiresSignature(mimeType)
        ? `content signature could not be verified for ${mimeType}`
        : null;
    if (head.length >= ASF_GUID.length && head.subarray(0, ASF_GUID.length).equals(ASF_GUID)) return unverified;
    const detected = await detectHeadMime(head);
    if (!detected) return unverified;
    if (!Media.isAllowedMimeType(detected)) return `content type ${detected} is not allowed`;
    if (requiresSignature(mimeType) && detected !== mimeType) {
        return `content type ${detected} does not match the declared ${mimeType}`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// In-content URL rewriting
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every prefix an old site could have used for its uploads directory, longest first.
 *
 * Built from the attachment URLs the WXR actually carries plus the exported site URL, and widened with
 * the protocol twins and the protocol-relative form, because a single WordPress install routinely
 * emits all three across its content (an http-era post, an https-era post, and a `//host/...` embed).
 */
function collectUploadBases(attachmentUrls: string[], siteBaseUrl: string): string[] {
    const bases = new Set<string>();
    const add = (raw: string) => {
        if (!raw) return;
        let u: URL;
        try { u = new URL(raw); } catch { return; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        const marker = u.pathname.toLowerCase().indexOf('/wp-content/uploads');
        const prefix = marker >= 0
            ? u.pathname.slice(0, marker + '/wp-content/uploads'.length)
            : null;
        if (prefix === null) return;
        const authority = `${u.host}${prefix}`;
        bases.add(`https://${authority}`);
        bases.add(`http://${authority}`);
        bases.add(`//${authority}`);
    };
    for (const url of attachmentUrls) add(url);
    if (siteBaseUrl) add(`${String(siteBaseUrl).replace(/\/+$/, '')}/wp-content/uploads`);
    // Longest first so `https://host/...` is consumed before the `//host/...` form that is its suffix.
    return [...bases].sort((a, b) => b.length - a.length);
}

/** Swap every old upload base for this install's `/uploads`, leaving everything else untouched. */
function rewriteUploadUrls(content: string, bases: string[]): string {
    if (!content || bases.length === 0) return content;
    let out = content;
    for (const base of bases) out = out.replace(new RegExp(escapeRegExp(base), 'g'), '/uploads');
    return out;
}

// ---------------------------------------------------------------------------
// The importer
// ---------------------------------------------------------------------------

/**
 * The meta key that makes an attachment import idempotent across re-runs.
 *
 * SERVER-OWNED: it is in core/protected-meta's PROTECTED_POST_META, so neither a route's generic meta
 * bag nor a third party's `wp:postmeta` can author it. It has to be, because the NEXT run treats a hit
 * on this key as "already imported" and points its id map at the row that carries it.
 */
const SOURCE_URL_META_KEY = '_wxr_source_url';

/**
 * Where a `link`-mode attachment's bytes actually live — on the ORIGIN site.
 *
 * WHY THE GUID IS NOT ENOUGH. `link` mode stores the remote URL in `posts.guid`, but every reader goes
 * through Media.formatAttachment, which normalises ANY absolute guid containing `/uploads/` down to a
 * local `/uploads/...` path — and a stock WordPress URL (`https://old/wp-content/uploads/…`) contains
 * exactly that. So `sourceUrl` pointed at a local file the mode had deliberately never downloaded: a
 * 404 for every attachment on the standard layout, counted as a `linked` success. The remote URL now
 * gets a key of its own that formatAttachment PREFERS, and the guid keeps the value WordPress exports.
 */
const REMOTE_URL_META_KEY = '_wxr_remote_url';

/**
 * How many `-1`, `-2`, … stems to try before giving up on placing a file (WordPress's own de-duplication
 * has no bound; a bound here means a pathological WXR cannot spin on `existsSync`).
 */
const MAX_PATH_DISAMBIGUATION = 100;

/** One attachment item, already flattened out of the XML by wxr-import.ts (which owns the accessors). */
export interface WxrAttachment {
    sourceId: string;
    slug: string;
    title: string;
    description: string;
    caption: string;
    alt: string;
    attachmentUrl: string;
    attachedFile: string;
    mimeType: string;
    authorId: number;
}

export interface MediaImportOutcome {
    postId: number | null;
    /** `created` covers both a downloaded file and a `link`-mode record; `reason` says which. */
    outcome: 'downloaded' | 'linked' | 'skipped' | 'failed';
    reason?: string;
    /** True when Media.create() owns `_wp_attached_file` — the WXR's own value must not overwrite it. */
    ownsPathMeta: boolean;
}

export interface MediaStats {
    mode: MediaMode;
    downloaded: number;
    linked: number;
    skipped: number;
    failed: number;
    /** Bytes that actually LANDED in the media library (the successful ones). */
    bytes: number;
    /**
     * Bytes pulled off the network, INCLUDING the ones a refused or failed item downloaded before it was
     * rejected. This — not `bytes` — is what `maxTotalBytes` bounds, which is the only way the cap can
     * bound a run whose every file fails verification.
     */
    fetchedBytes: number;
    failures: { url: string; reason: string }[];
}

/** Where one attachment's bytes are going, once the path has been CLAIMED (see claimRelativePath). */
interface PlacedPath {
    /** The path the row records and the file is written to — disambiguated if it had to be. */
    relativePath: string;
    absolutePath: string;
    mimeType: string;
    /**
     * The uploads-relative path the attachment's own URL names, i.e. what the in-content prefix swap
     * produces for it. Differs from `relativePath` exactly when the placement had to move the file, and
     * that difference is what core/wxr-import's rewrite has to apply on top of the base swap.
     */
    urlRelative: string | null;
}

function normalizeSettings(options: any): MediaSettings {
    const mode: MediaMode =
        options?.media === 'skip' || options?.media === 'link' || options?.media === 'download'
            ? options.media
            // Back-compat with the legacy boolean routes/import.ts still sends: an EXPLICIT false means
            // "do not bring attachments over" and stays a skip; anything else (including it being absent)
            // gets the new default, which is a real download.
            : (options?.importAttachments === false ? 'skip' : 'download');
    const positive = (v: any, fallback: number) =>
        (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.floor(v) : fallback;
    return {
        mode,
        allowHttp: options?.allowHttp === true,
        maxFileBytes: positive(options?.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
        maxTotalBytes: positive(options?.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
        timeoutMs: positive(options?.timeoutMs, DEFAULT_TIMEOUT_MS),
    };
}

class MediaImporter {
    readonly settings: MediaSettings;
    readonly stats: MediaStats;
    /** source URL -> existing attachment post id, loaded once so a re-run costs one query, not N. */
    private bySourceUrl: Map<string, number> = new Map();
    /**
     * Every uploads-relative path already spoken for — by an attachment row, by a file on disk, or by an
     * earlier item in THIS run. Lower-cased, because a case-insensitive filesystem (Windows, macOS)
     * treats `Photo.JPG` and `photo.jpg` as one file and this set must be a superset of what the disk
     * will collide on, never a subset.
     */
    private claimedPaths: Set<string> = new Set();
    /** source URL -> the placement decided up front (see planPlacements), or the reason to refuse it. */
    private plans: Map<string, PlacedPath | string> = new Map();
    /** url-relative path -> stored relative path, for the files placement had to move. */
    private renames: Map<string, string> = new Map();
    /** The run-wide download budget the per-chunk handler enforces. */
    private budget: DownloadBudget;
    /** Distinguishes the temp names of two files being placed in the same directory. */
    private tempSeq = 0;

    constructor(options: any) {
        this.settings = normalizeSettings(options);
        this.stats = {
            mode: this.settings.mode,
            downloaded: 0, linked: 0, skipped: 0, failed: 0, bytes: 0, fetchedBytes: 0, failures: [],
        };
        this.budget = { fetched: 0, limit: this.settings.maxTotalBytes };
    }

    get mode(): MediaMode { return this.settings.mode; }

    /**
     * Index the attachments a previous run already imported, and the paths this install already holds.
     *
     * THE dedupe key is the source URL, not the slug: WordPress slugifies an attachment from its file
     * name, so two uploads a year apart can share one (`logo`, `logo-1` … only within a single install),
     * while the URL is what the WXR is actually pointing this run at.
     *
     * BOTH QUERIES ARE SCOPED TO `post_type = 'attachment'`. Unscoped, they answered from ANY post's
     * meta — and `_wxr_source_url` used to be writable through the routes' generic meta bag and
     * copyable verbatim out of a third party's XML, so a planted row made the importer declare a real
     * attachment "already imported", download nothing, and point `oldToNewPost` (hence every
     * `wp:post_parent` / `_thumbnail_id` reference) at the planted post. The key is now in
     * PROTECTED_POST_META as well: the scope and the ban are two halves of the same fix, because a row
     * written before the ban existed is still in the table.
     */
    async prepare(dbAsync: any): Promise<void> {
        const rows = await dbAsync.all(
            `SELECT pm.post_id AS post_id, pm.meta_value AS meta_value
               FROM post_meta pm
               JOIN posts p ON p.id = pm.post_id
              WHERE pm.meta_key = ? AND p.post_type = ?`,
            [SOURCE_URL_META_KEY, 'attachment']
        );
        for (const row of rows || []) {
            if (typeof row.meta_value === 'string' && row.meta_value) {
                this.bySourceUrl.set(row.meta_value, Number(row.post_id));
            }
        }
        const held = await dbAsync.all(
            `SELECT pm.meta_value AS meta_value
               FROM post_meta pm
               JOIN posts p ON p.id = pm.post_id
              WHERE pm.meta_key = ? AND p.post_type = ?`,
            ['_wp_attached_file', 'attachment']
        );
        for (const row of held || []) {
            if (typeof row.meta_value === 'string' && row.meta_value) {
                this.claimedPaths.add(row.meta_value.replace(/\\/g, '/').toLowerCase());
            }
        }
    }

    /** The already-imported id for this source URL, or null. */
    existingIdFor(url: string): number | null {
        const id = this.bySourceUrl.get(url);
        return id === undefined ? null : id;
    }

    /**
     * Decide where every attachment's bytes will go BEFORE the item loop writes a single post body.
     *
     * WHY UP FRONT. A placement that had to disambiguate (`photo.jpg` -> `photo-1.jpg`) changes the URL
     * the in-content rewrite must produce — and a WXR routinely lists a post BEFORE the attachment it
     * embeds, so a rename discovered while importing the attachment would arrive after the bodies that
     * reference it were already written. Planning is pure (no network, no disk writes) and costs one
     * `existsSync` per file.
     *
     * Attachments a previous run already stored are skipped: their path is theirs, and reserving a
     * second one for them would rewrite live content to a file that does not exist.
     */
    planPlacements(items: { attachmentUrl: string; attachedFile: string; mimeType: string }[]): void {
        if (this.settings.mode !== 'download') return;
        for (const item of items) {
            const url = String(item.attachmentUrl || '').trim();
            if (!url || this.plans.has(url) || this.existingIdFor(url) !== null) continue;
            const placed = this.resolveStoredPath(item, url);
            this.plans.set(url, placed);
            if (typeof placed !== 'string' && placed.urlRelative && placed.urlRelative !== placed.relativePath) {
                this.renames.set(placed.urlRelative, placed.relativePath);
            }
        }
    }

    /**
     * The files whose stored path is not the one their own URL names, as `url path -> stored path`.
     * core/wxr-import applies these on top of the base swap so a moved file's in-content URL follows it.
     */
    pathRenames(): Map<string, string> { return this.renames; }

    private fail(url: string, reason: string): MediaImportOutcome {
        this.stats.failed++;
        if (this.stats.failures.length < 100) this.stats.failures.push({ url, reason });
        return { postId: null, outcome: 'failed', reason, ownsPathMeta: false };
    }

    /**
     * Import one attachment. NEVER throws for a per-item problem: a failed download is recorded and the
     * caller moves on, which is what makes a big migration resumable rather than all-or-nothing.
     */
    async importAttachment(att: WxrAttachment): Promise<MediaImportOutcome> {
        const url = String(att.attachmentUrl || '').trim();

        if (this.settings.mode === 'skip') {
            this.stats.skipped++;
            return { postId: null, outcome: 'skipped', reason: 'media mode is "skip"', ownsPathMeta: false };
        }

        // Idempotency, checked BEFORE any network call: a re-run must cost nothing per already-imported
        // file, which is the whole point of making a 10k-attachment migration resumable.
        if (url) {
            const existing = this.existingIdFor(url);
            if (existing !== null) {
                this.stats.skipped++;
                return { postId: existing, outcome: 'skipped', reason: 'already imported', ownsPathMeta: false };
            }
        }

        if (this.settings.mode === 'link') {
            const created = await this.createRecord(att, null, url);
            if (typeof created === 'string') return this.fail(url || att.slug, created);
            this.stats.linked++;
            return { postId: created, outcome: 'linked', ownsPathMeta: false };
        }

        if (!url) return this.fail(att.slug || String(att.sourceId), 'no wp:attachment_url in the WXR item');
        if (this.budget.fetched >= this.settings.maxTotalBytes) {
            return this.fail(url, `import already reached the ${this.settings.maxTotalBytes}-byte total cap`);
        }

        // The placement is decided BEFORE the download (planPlacements), because the in-content rewrite
        // needs to know about a moved file before any body is written. Fall back to resolving it now for
        // a caller that drives importAttachment directly.
        const planned = this.plans.get(url);
        this.plans.delete(url); // a claim is consumed once; a second look must not reserve a second path
        const placed = planned === undefined ? this.resolveStoredPath(att, url) : planned;
        if (typeof placed === 'string') return this.fail(url, placed);

        let body: Buffer;
        try {
            body = await fetchAttachment(url, this.settings, this.budget);
        } catch (e: any) {
            return this.fail(url, e?.message || String(e));
        } finally {
            this.stats.fetchedBytes = this.budget.fetched;
        }

        const problem = await magicByteProblem(body, placed.mimeType);
        if (problem) return this.fail(url, problem);

        // PUBLISH ATOMICALLY, INTO A PATH NOTHING ELSE HOLDS. The path was claimed above, so this write
        // can never land on another attachment's bytes; the temp name (dot-leading, which index.ts'
        // `dotfiles: 'deny'` refuses to serve) means express.static can never hand a client a
        // half-written file either.
        const directory = path.dirname(placed.absolutePath);
        const tempPath = path.join(directory, `.wxr-part-${process.pid}-${this.tempSeq++}`);
        try {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(tempPath, body);
            fs.renameSync(tempPath, placed.absolutePath);
        } catch (e: any) {
            try { fs.unlinkSync(tempPath); } catch { /* nothing was left behind */ }
            return this.fail(url, `could not write ${placed.relativePath}: ${e?.message || e}`);
        }

        const created = await this.createRecord(att, { ...placed, body }, url);
        if (typeof created === 'string') {
            // A ROW IS THE ONLY THING THAT CAN EVER DELETE A FILE. Media._deletableFiles walks rows, so
            // bytes left under `uploads/` by a failed record write are unreachable forever — publicly
            // served by express.static, and re-created by every retry (a failure stamps no
            // `_wxr_source_url`, which is exactly what makes the run resumable).
            try { fs.unlinkSync(placed.absolutePath); } catch { /* best effort */ }
            // The claim is NOT released: the in-content rewrite may already point at this path, and
            // handing it to a different attachment would put the wrong image behind a live URL. The
            // next run re-plans from the DB and the disk, where nothing holds it any more.
            return this.fail(url, created);
        }

        this.stats.downloaded++;
        this.stats.bytes += body.length;
        return { postId: created, outcome: 'downloaded', ownsPathMeta: true };
    }

    /**
     * Decide where the bytes go, or return a reason to refuse — and CLAIM the path so nothing else in
     * this run can take it.
     *
     * The ORIGINAL relative path is preserved whenever it is a usable shape AND FREE, because that is
     * what makes the in-content rewrite a pure prefix swap: `https://old/wp-content/uploads/2025/01/a.jpg`
     * becomes `/uploads/2025/01/a.jpg` and the file is at exactly that path. Only when the WXR gives us
     * nothing usable do we fall back to the URL's own path, and then to its basename; only when the path
     * is TAKEN does the stem get a `-1` suffix, and then `urlRelative` records what the rewrite has to
     * follow.
     */
    private resolveStoredPath(
        att: { attachedFile: string; mimeType: string }, url: string,
    ): string | PlacedPath {
        const urlRelative = (() => {
            let pathname: string;
            try { pathname = decodeURIComponent(new URL(url).pathname); } catch { return null; }
            const marker = pathname.toLowerCase().indexOf('/wp-content/uploads/');
            const tail = marker >= 0 ? pathname.slice(marker + '/wp-content/uploads/'.length) : path.basename(pathname);
            return safeAttachedFile(tail);
        })();
        const relative = safeAttachedFile(att.attachedFile) || urlRelative;
        if (!relative) return 'attachment path could not be resolved to a safe relative path';

        const extension = path.extname(relative).replace(/^\./, '').toLowerCase();
        if (!extension) return `attachment "${relative}" has no file extension`;
        if (Media.isDangerousExtension(extension)) return `refused: .${extension} is an active-content extension`;
        const byExtension = extensionMimeMap().get(extension);
        if (!byExtension) return `refused: .${extension} is not an allowed upload extension`;

        const declared = String(att.mimeType || '').trim().toLowerCase();
        const mimeType = declared && Media.isAllowedMimeType(declared) ? declared : byExtension;
        if (REFUSED_IMPORT_MIMES.has(mimeType)) {
            return `refused: ${mimeType} cannot be imported (its sanitizer lives in the upload route)`;
        }

        const claimed = this.claimRelativePath(relative);
        if (typeof claimed === 'string') return claimed;
        return { ...claimed, mimeType, urlRelative };
    }

    /**
     * Take exclusive ownership of a path under the uploads root, disambiguating the stem until one is
     * free — `photo.jpg`, `photo-1.jpg`, `photo-2.jpg`, the same shape WordPress uses.
     *
     * THREE THINGS COUNT AS TAKEN, and all three are real: a row in the media library (an upload, or an
     * attachment a previous run imported), a file already on disk (an upload whose row is gone, or an
     * orphan), and a path an earlier item of THIS run already claimed. Containment under the uploads
     * root is re-proved for the disambiguated name too — a `-1` on a claimed name cannot escape, but the
     * proof belongs at the sink, not in an argument about the input.
     */
    private claimRelativePath(relative: string): string | { relativePath: string; absolutePath: string } {
        const uploadsDir = path.resolve(config.uploads.dir);
        const slash = relative.lastIndexOf('/');
        const directory = slash >= 0 ? relative.slice(0, slash + 1) : '';
        const base = slash >= 0 ? relative.slice(slash + 1) : relative;
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const extension = dot > 0 ? base.slice(dot) : '';

        for (let n = 0; n <= MAX_PATH_DISAMBIGUATION; n++) {
            const candidate = n === 0 ? relative : `${directory}${stem}-${n}${extension}`;
            if (candidate.length > MAX_ATTACHED_FILE_LENGTH) {
                return `attachment path "${relative}" cannot be disambiguated within ${MAX_ATTACHED_FILE_LENGTH} characters`;
            }
            const absolutePath = resolveWithin(uploadsDir, ...candidate.split('/'));
            if (!absolutePath) return `attachment path "${candidate}" escapes the uploads directory`;
            if (this.claimedPaths.has(candidate.toLowerCase())) continue;
            if (fs.existsSync(absolutePath)) {
                // Remember it, so the NEXT item does not pay the same stat() over again.
                this.claimedPaths.add(candidate.toLowerCase());
                continue;
            }
            this.claimedPaths.add(candidate.toLowerCase());
            return { relativePath: candidate, absolutePath };
        }
        return `attachment path "${relative}" is taken and ${MAX_PATH_DISAMBIGUATION} alternatives are too`;
    }

    /**
     * Create the attachment ROW through models/Media.create — the same call the upload route makes — and
     * stamp the source URL that makes the next run skip this file. Returns the new id, or a reason string.
     */
    private async createRecord(
        att: WxrAttachment,
        placed: { relativePath: string; absolutePath: string; mimeType: string; body: Buffer } | null,
        url: string,
    ): Promise<number | string> {
        try {
            let width = 0;
            let height = 0;
            if (placed && placed.mimeType.startsWith('image/')) {
                // Best effort, and deliberately not fatal: a media library entry with 0x0 is still a
                // working file, while a sharp that cannot decode one exotic image must not fail an import.
                try {
                    const sharp = require('sharp');
                    const meta = await sharp(placed.body, { limitInputPixels: 40_000_000 }).metadata();
                    const transposed = (meta.orientation || 1) >= 5;
                    width = (transposed ? meta.height : meta.width) || 0;
                    height = (transposed ? meta.width : meta.height) || 0;
                } catch { /* dimensions stay 0 */ }
            }

            const relative = placed ? placed.relativePath : (safeAttachedFile(att.attachedFile) || '');
            // ONE mutation for the row, its metadata and the source stamp. Media.create() opens its own
            // when none is active, which would leave the `_wxr_source_url` write — the key the NEXT run
            // dedupes on — outside the committed unit, so an interrupted run could re-download a file it
            // had already stored. Opening it here makes Media.create join this one instead.
            const id = await runContentMutation(async () => {
                const media = await Media.create({
                    authorId: att.authorId,
                    title: att.title || path.basename(relative || url) || att.slug,
                    filename: relative,
                    mimeType: placed ? placed.mimeType : (att.mimeType || 'application/octet-stream'),
                    filePath: relative,
                    fileSize: placed ? placed.body.length : 0,
                    width,
                    height,
                    sizes: {},
                    sources: {},
                    description: att.description,
                    caption: att.caption,
                    alt: att.alt,
                });
                if (!media || !media.id) throw new Error('Media.create returned no attachment');
                // NO PATH IS NOT AN EMPTY PATH. Media.create() always writes the two path keys because
                // an upload always has a file; a `link`-mode record whose WXR path did not survive the
                // shape gate has none, and storing `''` would contradict what that gate promises (the
                // key is absent, never present-but-unusable). Drop them so the row is exactly what it
                // was before Media.create became the writer.
                if (!relative) {
                    await Post.deleteMeta(media.id, '_wp_attached_file');
                    await Post.deleteMeta(media.id, '_wp_attachment_metadata');
                }
                if (url) {
                    await Post.updateMeta(media.id, SOURCE_URL_META_KEY, url);
                    // In `link` mode nothing was fetched, so the file still lives on the OLD host. The
                    // guid keeps the remote URL (the same value WordPress itself exports), but the guid
                    // alone is not where a reader looks: Media.formatAttachment normalises any absolute
                    // guid containing `/uploads/` down to a LOCAL path, and a stock WordPress URL
                    // contains exactly that — so every linked attachment resolved to a local file this
                    // mode had deliberately never downloaded. The remote URL therefore gets a key of its
                    // own, which formatAttachment prefers; see REMOTE_URL_META_KEY.
                    if (!placed) {
                        await Post.updateMeta(media.id, REMOTE_URL_META_KEY, url);
                        const { dbAsync } = require('../config/database');
                        await dbAsync.run('UPDATE posts SET guid = ? WHERE id = ?', [url, media.id]);
                    }
                }
                return media.id as number;
            });
            if (url) this.bySourceUrl.set(url, id);
            return id;
        } catch (e: any) {
            return e?.message || String(e);
        }
    }
}

function createMediaImporter(options: any): MediaImporter {
    return new MediaImporter(options);
}

module.exports = {
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_TOTAL_BYTES,
    DEFAULT_TIMEOUT_MS,
    SOURCE_URL_META_KEY,
    REMOTE_URL_META_KEY,
    MAX_PATH_DISAMBIGUATION,
    MAX_ATTACHED_FILE_LENGTH,
    MAX_ATTACHED_FILE_DEPTH,
    safeAttachedFile,
    safeAttachmentMetadata,
    collectUploadBases,
    rewriteUploadUrls,
    createMediaImporter,
};
