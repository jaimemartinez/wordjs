/**
 * Transparent AVIF/WebP negotiation for /uploads raster images (roadmap: media modernization).
 *
 * When a browser advertises AVIF/WebP support via its `Accept` header, transcode the original JPEG/PNG
 * to that format ON DEMAND with sharp, cache the derivative to disk, and serve it — SAME URL, ~50% fewer
 * bytes, and ZERO frontend markup change (content-body images, featured images, theme logos all benefit).
 * Modern formats (AVIF especially) are dramatically smaller, so this is the single biggest bytes/LCP win
 * for a content site.
 *
 * Fails SAFE: any error / unsupported format / non-raster type / missing sharp → next(), so the original
 * is served by express.static exactly as before. Derivatives are cached under <uploads>/.derivatives and
 * served with `Vary: Accept` (a shared cache MUST key on Accept) + immutable Cache-Control (upload URLs are
 * UUID-unique + never overwritten, so a derivative is permanently stable — a re-upload gets a new URL).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
let sharp: any = null;
try { sharp = require('sharp'); } catch { /* sharp unavailable on this host → middleware is a no-op */ }

// Only transcode true raster photos. SVG (vector), GIF (often animated), and already-modern formats are
// left to express.static untouched.
const RASTER = new Set(['.jpg', '.jpeg', '.png']);

// SECURITY (DoS): on-demand transcoding is reachable by anonymous callers (public /uploads).
// Two guards keep a burst of requests from OOM/CPU-killing the single-process backend:
//   1. limitInputPixels caps decoded pixels per sharp() pipeline (a "pixel bomb" is rejected → original served).
//   2. A global concurrency budget + a per-derivative in-flight lock stop parallel/duplicate transcodes from
//      stacking sharp pipelines. Over budget → fail SAFE by serving the original untouched.
const MAX_INPUT_PIXELS = 40_000_000; // ~40MP, far above any legitimate web image
// limitInputPixels counts PIXELS, but the cost that OOMs a host is the DECODED buffer plus the
// encoder's working set, and an AVIF encode costs far more than the buffer itself. Measured on this
// repo's sharp/libvips, encoding one JPEG straight to AVIF at full resolution:
//     6000x4000 (68.7MB decoded) -> 1120MB peak RSS, 18.3s
//     3464x2309 (22.9MB decoded) ->  521MB peak RSS,  6.4s
//     1920x1280 ( 7.0MB decoded) ->  336MB peak RSS,  2.4s
// So a 24MP original — well under the 40MP pixel cap — cost 1.1GB and 18s of CPU for ONE anonymous
// GET, and the concurrency budget multiplied that by three. Bound the DECODED SIZE instead and skip
// negotiation above it: the original is then served untouched, so every client still gets identical
// bytes and identical dimensions (resizing here instead would silently hand Chrome a different image
// size than Safari for the SAME URL). This costs almost nothing in practice — the F5 width ladder
// means the variants actually referenced by srcset are <=1920 wide, far below this budget; only the
// full-size original skips negotiation.
const MAX_DECODED_BYTES = 24 * 1024 * 1024; // ~8MP RGB
const MAX_CONCURRENT_TRANSCODES = 2;
let activeTranscodes = 0;
// Module-scoped so the budget/lock are shared across ALL requests (and any factory instances).
const inFlight = new Map<string, Promise<void>>(); // cachePath -> ongoing transcode

export function imageNegotiation(uploadsDir: string) {
    const root = path.resolve(uploadsDir);
    const cacheRoot = path.join(root, '.derivatives');

    return function imageNegotiationMw(req: any, res: any, next: any): void {
        if (!sharp || req.method !== 'GET') return next();
        const ext = path.extname(req.path).toLowerCase();
        if (!RASTER.has(ext)) return next();

        // Pick the best format the client accepts; if it wants none of them, serve the original as-is.
        const accept = String(req.headers['accept'] || '');
        const fmt: 'avif' | 'webp' | null =
            accept.includes('image/avif') ? 'avif' : accept.includes('image/webp') ? 'webp' : null;
        if (!fmt) return next();

        // Sanitize the mount-relative path (req.path is already stripped of the /uploads mount). Restrict to
        // a strict filename charset AND reject any '..' segment — a recognized path-injection barrier that
        // genuinely prevents escaping the uploads root; anything else falls through to serve the original.
        let rel: string;
        try { rel = decodeURIComponent(req.path).replace(/\\/g, '/').replace(/^\/+/, ''); } catch { return next(); }
        // CANONICALIZE before anything derives from it. path.join below collapses duplicate slashes but
        // the cache key did not, so '/a/b.jpg', '/a//b.jpg' and '/a///b.jpg' resolved to the SAME file on
        // disk under DIFFERENT keys: every one was a cache MISS that started a fresh full-resolution
        // transcode. The slash count is unbounded, so a single publicly-linked image was an unlimited
        // supply of cache misses for an anonymous client — the amplifier that turned the per-request cost
        // measured above into a sustained one, and grew .derivatives without limit as a side effect.
        // Normalizing here keys the cache on the same identity path.join resolves.
        rel = path.posix.normalize(rel).replace(/^\/+/, '');
        if (rel.includes('..')) return next(); // reject traversal — the CodeQL-recognized path-injection barrier
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rel)) return next(); // strict filename charset (defense-in-depth)
        const srcPath = path.join(root, rel);
        if (!srcPath.startsWith(root)) return next(); // path.join keeps a clean rel inside root; assert it anyway
        try { if (!fs.statSync(srcPath).isFile()) return next(); } catch { return next(); }

        // The cache key is a HASH of the (already-sanitized) rel + format, so the derivative path carries NO
        // user-controlled data into any filesystem call — only hex. Sharded by the first byte to keep dirs small.
        const key = crypto.createHash('sha256').update(rel + '|' + fmt).digest('hex');
        const cachePath = path.join(cacheRoot, key.slice(0, 2), key + '.' + fmt);

        const serveDerivative = (): void => {
            res.setHeader('Content-Type', 'image/' + fmt);
            res.setHeader('Vary', 'Accept'); // REQUIRED: same URL serves different bytes per Accept
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            const s = fs.createReadStream(cachePath);
            s.on('error', () => { if (!res.headersSent) next(); });
            s.pipe(res);
        };

        // Serve the cached derivative if present.
        try { if (fs.statSync(cachePath).isFile()) return serveDerivative(); } catch { /* not cached yet */ }

        // Not cached yet. If an identical derivative is already being produced, DON'T start a second
        // sharp pipeline — wait for that one, then serve its result (or the original if it failed).
        const pending = inFlight.get(cachePath);
        if (pending) {
            pending.then(
                () => { try { if (fs.statSync(cachePath).isFile()) return serveDerivative(); } catch { /* failed */ } if (!res.headersSent) next(); },
                () => { if (!res.headersSent) next(); }
            );
            return;
        }

        // SECURITY (DoS): over the concurrency budget → fail SAFE, serve the original untouched rather
        // than queueing another CPU/memory-heavy transcode.
        if (activeTranscodes >= MAX_CONCURRENT_TRANSCODES) return next();

        // Transcode once, publish atomically, then serve. On failure/limit, fall through to the original.
        activeTranscodes++;
        const work = (async () => {
            try {
                fs.mkdirSync(path.dirname(cachePath), { recursive: true });
                const tmp = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
                const pipeline = sharp(srcPath, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS });
                // Bound the DECODED size before committing to an encode (see MAX_DECODED_BYTES). metadata()
                // only parses the header, so this costs nothing next to the encode it may avoid. Over
                // budget → throw, which the caller already handles by serving the original untouched.
                const meta = await pipeline.metadata();
                const decodedBytes = (meta.width || 0) * (meta.height || 0) * (meta.channels || 3)
                    * (meta.depth === 'ushort' ? 2 : 1);
                if (!meta.width || !meta.height || decodedBytes > MAX_DECODED_BYTES) {
                    throw new Error(`image-negotiation: source too large to transcode (${decodedBytes} decoded bytes)`);
                }
                if (fmt === 'avif') await pipeline.avif({ quality: 50, effort: 4 }).toFile(tmp);
                else await pipeline.webp({ quality: 78 }).toFile(tmp);
                fs.renameSync(tmp, cachePath); // atomic publish (same fs)
            } finally {
                activeTranscodes--;
                inFlight.delete(cachePath);
            }
        })();
        inFlight.set(cachePath, work);
        work.then(
            () => { serveDerivative(); },
            () => { if (!res.headersSent) next(); } // transcode failed/limit exceeded → serve the original
        );
    };
}
