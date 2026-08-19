import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const analytics = require('../models/Analytics');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');

/**
 * @swagger
 * /api/v1/analytics/stats:
 *   get:
 *     summary: Get aggregated analytics stats
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 */
router.get('/stats', authenticate, isAdmin, async (req: Request, res: Response) => {
    try {
        const { period } = req.query; // 'weekly' or 'monthly'
        const data = await analytics.getStats(period || 'weekly');
        res.json(data);
    } catch (error) {
        console.error('Analytics Error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

/**
 * Public Endpoint for tracking (Pixel/Beacon)
 * Called by frontend on page load
 *
 * (#21) This is an ANONYMOUS PUBLIC WRITE surface — the same class as POST /forms/submit — and it was
 * being treated as an internal helper: no auth, no validation, `metadata` handed straight to
 * JSON.stringify, and the only ceilings generic (express.json's 10mb body cap and the global
 * apiLimiter, which bound TRAFFIC, not stored bytes). One IP could persist ~40 GB/hour of rows that
 * nothing ever deleted, and in monolith mode a full disk takes down backend, frontend and DB at once.
 * The DDL's VARCHAR(50)/VARCHAR(255) are decoration: SQLite does not enforce them, MySQL keeps
 * `metadata` in LONG_TEXT_COLUMNS and Postgres TEXT is unbounded, so all three engines accepted the
 * 10 MB row. The bar is the one routes/forms.ts already sets for this exact class, so the bounds
 * below mirror its shape (allowlist + per-field caps + a total-bytes cap), enforced IN CODE.
 *
 * The other two halves live outside this file: the per-IP analyticsLimiter (index.ts, mounted on the
 * exact route) and the retention prune (core/analytics-retention.ts). A table anyone may write to and
 * nobody ever prunes is a full disk with a date on it, not an "if".
 */

// `type` chooses a row's meaning (getStats buckets 'page_view' as traffic and everything else as
// engagement), so it is an allowlist, not a length check — an attacker must not be able to invent
// unbounded distinct values and make the dashboard's grouping their storage.
const TRACK_TYPES = new Set(['page_view', 'engagement', 'click', 'search', 'conversion', 'comment', 'login', 'api_call']);
const MAX_RESOURCE_LEN = 255;      // the DDL's VARCHAR(255) — enforced here because the engines do not
const MAX_META_KEYS = 20;
const MAX_META_KEY_LEN = 60;
const MAX_META_VALUE_LEN = 200;
const MAX_META_BYTES = 2 * 1024;   // serialized ceiling for the whole metadata blob

function badRequest(res: Response, message: string) {
    return res.status(400).json({ code: 'rest_invalid_param', message, data: { status: 400 } });
}

/**
 * A flat, small, JSON-safe object — or null if the caller sent anything else. Deliberately does NOT
 * recurse: nesting is what turns a size check into a traversal with a depth an attacker chooses.
 */
function boundedMetadata(raw: any): Record<string, string | number | boolean> | null {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const keys = Object.keys(raw);
    if (keys.length > MAX_META_KEYS) return null;
    const out: Record<string, string | number | boolean> = {};
    for (const k of keys) {
        if (k.length > MAX_META_KEY_LEN) return null;
        const v = (raw as any)[k];
        if (typeof v === 'number') { if (!Number.isFinite(v)) return null; out[k] = v; continue; }
        if (typeof v === 'boolean') { out[k] = v; continue; }
        if (typeof v !== 'string') return null;      // objects/arrays/functions → rejected, not coerced
        if (v.length > MAX_META_VALUE_LEN) return null;
        out[k] = v;
    }
    if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_META_BYTES) return null;
    return out;
}

router.post('/track', async (req: any, res: Response) => {
    const { type, resource, metadata } = req.body || {};

    // Bounds are checked BEFORE any DB work and answered with a real 400 — the old handler even
    // returned 200 from its catch, so abuse and breakage were invisible in the error rate.
    const evType = type === undefined || type === null || type === '' ? 'page_view' : type;
    if (typeof evType !== 'string' || !TRACK_TYPES.has(evType)) {
        return badRequest(res, 'Invalid event type.');
    }
    // `resource` is TRUNCATED, not rejected. It does not choose the row's meaning (that is `type`) and
    // it is not the volume lever (`metadata` is), so a length check on it buys nothing — while
    // refusing it silently deletes real traffic: the only producer is the beacon in
    // frontend/src/components/AnalyticsTracker.tsx, which sends `${pathname}?${searchParams}`, and one
    // ordinary campaign link (utm_source/medium/campaign/content plus an fbclid or gclid of ~100
    // characters) sails past 255. Those requests got a 400, the beacon ignores the outcome, and the
    // operator lost exactly the paid/campaign visits with no trace anywhere. The cap still exists —
    // MySQL in STRICT mode would refuse the row — it is just applied where it costs nothing.
    if (resource !== undefined && resource !== null && typeof resource !== 'string') {
        return badRequest(res, '"resource" must be a string.');
    }
    const rawResource = resource === undefined || resource === null || resource === '' ? '/' : resource;
    const evResource = rawResource.slice(0, MAX_RESOURCE_LEN);
    const evMetadata = boundedMetadata(metadata);
    if (evMetadata === null) {
        return badRequest(res, `"metadata" must be a flat object of at most ${MAX_META_KEYS} string/number/boolean values (${MAX_META_BYTES} bytes serialized).`);
    }

    try {
        await analytics.track({
            type: evType,
            resource: evResource,
            ip: req.ip, // Express IP — model param is `ip`; it salts+hashes it (was `visitor_ip`, ignored, so every row stored 0.0.0.0)
            user_id: req.user ? req.user.id : null, // If auth middleware ran (optional)
            metadata: evMetadata
        });

        res.status(200).send({ success: true });
    } catch (error) {
        // A storage failure is a SERVER failure and must show up as one: answering 200 here meant a
        // broken (or disk-full) analytics table looked exactly like a healthy one. The beacon on the
        // frontend already ignores the outcome, so an honest status costs nothing.
        console.error('Tracking Error:', error);
        res.status(500).json({ code: 'analytics_track_failed', message: 'Failed to record event.', data: { status: 500 } });
    }
});

module.exports = router;
