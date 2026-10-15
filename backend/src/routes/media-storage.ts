/**
 * WordJS - Media storage routes (optional S3-compatible offload, core/media-storage)
 * /api/v1/media-storage
 *
 * Administrator-only. The configuration lives in the `mediaStorage` block of wordjs-config.json, next
 * to every other credential the backend holds (the backup offload's `s3` block, the database password),
 * and is written through configManager's atomic writer. Credentials are WRITE-ONLY here: the secret
 * access key and session token are never returned, only whether they are set and their last four
 * characters; an empty secret in a write keeps the stored one. A field set through the environment
 * (WORDJS_MEDIA_*) wins over the file and is reported as such, read-only.
 */

import type { Request, Response } from 'express';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { recordAudit, AUDIT_ACTIONS } = require('../core/audit');
const mediaStorage = require('../core/media-storage');
const migration = require('../core/media-storage-migrate');
const s3offload = require('../core/s3-offload');
const { logSafeError } = require('../core/log-safe');

const TEXT_FIELDS = ['bucket', 'region', 'endpoint', 'prefix', 'publicUrl', 'accessKeyId'] as const;
const MAX_FIELD = 512;

function badRequest(res: Response, message: string, params?: string[]) {
    return res.status(400).json({ code: 'rest_invalid_param', message, data: { status: 400, ...(params ? { params } : {}) } });
}

/**
 * The public pages bake the delivery base into their HTML (core/media-storage's media_public_base), so
 * a change of where media is served from re-renders them: the settings tag and the whole public tree.
 */
function purgeDelivery() {
    try { require('../core/frontend-purge').purgeFrontend(['settings'], ['/']); } catch { /* best effort */ }
}

async function statePayload() {
    return {
        ...mediaStorage.describeForAdmin(),
        state: await migration.getState(),
        migration: await migration.getProgress(),
        running: migration.isRunning(),
    };
}

/**
 * Merge a write request onto the stored block. Returns the new block, or an error message. Only the
 * known fields are taken; strings are trimmed and bounded; the secret is kept when the request leaves
 * it empty, and removed only by `clearCredentials: true`.
 */
function mergeBlock(current: Record<string, any>, body: any): { block?: Record<string, any>; error?: string; params?: string[] } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Expected a JSON object.' };
    const next: Record<string, any> = { ...current };
    const bad: string[] = [];
    if (body.driver !== undefined) {
        if (body.driver !== 'local' && body.driver !== 's3') bad.push('driver');
        else next.driver = body.driver;
    }
    for (const f of TEXT_FIELDS) {
        if (body[f] === undefined) continue;
        if (typeof body[f] !== 'string' || body[f].length > MAX_FIELD) { bad.push(f); continue; }
        const v = body[f].trim();
        if (v) next[f] = v; else delete next[f];
    }
    if (body.keepLocalCopy !== undefined) {
        if (typeof body.keepLocalCopy !== 'boolean') bad.push('keepLocalCopy');
        else next.keepLocalCopy = body.keepLocalCopy;
    }
    for (const secret of ['secretAccessKey', 'sessionToken']) {
        if (body[secret] === undefined || body[secret] === '') continue;
        if (typeof body[secret] !== 'string' || body[secret].length > 4096) { bad.push(secret); continue; }
        next[secret] = body[secret].trim();
    }
    if (body.clearCredentials === true) {
        delete next.accessKeyId;
        delete next.secretAccessKey;
        delete next.sessionToken;
    }
    if (bad.length) return { error: 'Some fields have an unsupported value.', params: bad };
    if (next.publicUrl && !mediaStorage.normalizePublicUrl(next.publicUrl)) {
        return { error: 'The public URL must be an http(s) address without credentials, a query or a fragment.', params: ['publicUrl'] };
    }
    return { block: next };
}

/** A fully resolved store for a candidate block, or why it is not usable. */
function candidateStore(block: Record<string, any>) {
    return mediaStorage.resolveMediaStorage(process.env, { mediaStorage: { ...block, driver: 's3' } });
}

/**
 * @swagger
 * tags:
 *   name: Media storage
 *   description: Optional S3-compatible offload of the media library (administrators)
 */

/**
 * @swagger
 * /media-storage:
 *   get:
 *     summary: Media storage configuration, state and migration progress
 *     description: The configuration with credentials masked (the secret key and session token are never returned, only whether they are set and their last four characters), where each field comes from (file, env or default), the effective driver and public base URL, the library state (local, migrating, offloaded, restoring) and the last migration's progress.
 *     tags: [Media storage]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Masked configuration and state
 *       403:
 *         description: Not an administrator
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    res.json(await statePayload());
}));

/**
 * @swagger
 * /media-storage:
 *   put:
 *     summary: Save the media storage configuration
 *     description: Writes the mediaStorage block of wordjs-config.json. An empty or absent secretAccessKey keeps the stored one; clearCredentials removes the stored keys. Switching the driver to s3 sends NEW public uploads to the bucket; the existing library moves with POST /media-storage/migrate. Switching back to local is refused while items are still in the bucket (run a restore first).
 *     tags: [Media storage]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               driver: { type: string, enum: [local, s3] }
 *               bucket: { type: string }
 *               region: { type: string }
 *               endpoint: { type: string }
 *               prefix: { type: string }
 *               publicUrl: { type: string }
 *               accessKeyId: { type: string }
 *               secretAccessKey: { type: string }
 *               sessionToken: { type: string }
 *               keepLocalCopy: { type: boolean }
 *               clearCredentials: { type: boolean }
 *     responses:
 *       200:
 *         description: The saved (masked) configuration and state
 *       400:
 *         description: A field has an unsupported value, or an s3 driver was asked for with an incomplete configuration
 *       409:
 *         description: rest_media_storage_in_use - switching to local while items are still in the bucket
 */
router.put('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const configManager = require('../core/configManager');
    const current = configManager.getConfig() || {};
    const merged = mergeBlock(current.mediaStorage && typeof current.mediaStorage === 'object' ? current.mediaStorage : {}, req.body);
    if (!merged.block) return badRequest(res, merged.error as string, merged.params);
    const block = merged.block;

    if (block.driver === 's3') {
        const store = candidateStore(block);
        if (store.driver !== 's3') {
            return badRequest(res, `The S3 configuration is incomplete or invalid: ${(store.incomplete || []).join(', ')}.`, store.incomplete || []);
        }
    } else {
        const state = await migration.getState();
        const inBucket = await migration.countOffloaded();
        if (state !== 'local' || inBucket > 0 || migration.isRunning()) {
            return res.status(409).json({
                code: 'rest_media_storage_in_use',
                message: 'Media is still served from the bucket. Run a restore (Media storage → Move back to local disk) before switching to local storage.',
                data: { status: 409, state, inBucket }
            });
        }
    }

    const out = configManager.updateConfig((cfg: any) => ({ ...cfg, mediaStorage: block }));
    if (!out.ok) {
        return res.status(500).json({ code: 'rest_config_write_failed', message: 'wordjs-config.json could not be written.', data: { status: 500, reason: out.reason } });
    }
    await recordAudit(req.user && req.user.id, AUDIT_ACTIONS.MEDIA_STORAGE_UPDATE, 'config', 'mediaStorage', {
        driver: block.driver || 'local',
        bucket: block.bucket || '',
        endpoint: block.endpoint || '',
        publicUrl: block.publicUrl || '',
        keysRotated: req.body.secretAccessKey !== undefined && req.body.secretAccessKey !== '' || req.body.clearCredentials === true,
    });
    purgeDelivery();
    res.json(await statePayload());
}));

/**
 * @swagger
 * /media-storage/test:
 *   post:
 *     summary: Test a media storage configuration
 *     description: Two calls. Without `probe`, writes a 1x1 PNG probe object and reads it back, using the posted (unsaved) fields merged over the stored ones (an empty secret uses the stored secret), and answers the probe's name and public URL. The admin's BROWSER then loads that URL as an image - the public check runs from the viewer's network, exactly as visitors will fetch media, and the server never fetches an operator-supplied URL. A second call with `probe` (the name from the first) deletes it. Answers each step's outcome; never the bucket's response bodies.
 *     tags: [Media storage]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               probe: { type: string, description: "The probe name a first call answered; deletes that probe" }
 *     responses:
 *       200:
 *         description: "{ ok, steps: [{ step, ok, detail }], probe?, publicUrl? }"
 *       400:
 *         description: The configuration is incomplete or invalid, or `probe` is not a probe name
 */
router.post('/test', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const configManager = require('../core/configManager');
    const current = configManager.getConfig() || {};
    const body = req.body || {};
    const { probe, ...fields } = body;
    const merged = mergeBlock(current.mediaStorage && typeof current.mediaStorage === 'object' ? current.mediaStorage : {}, fields);
    if (!merged.block) return badRequest(res, merged.error as string, merged.params);
    const store = candidateStore(merged.block);
    if (store.driver !== 's3') {
        return badRequest(res, `The S3 configuration is incomplete or invalid: ${(store.incomplete || []).join(', ')}.`, store.incomplete || []);
    }
    if (probe !== undefined) {
        if (typeof probe !== 'string' || !PROBE_RE.test(probe)) return badRequest(res, 'probe is not a connection-test probe name.', ['probe']);
        return res.json(await removeProbe(store, probe));
    }
    res.json(await testConnection(store, {}, { keepProbe: true }));
}));

/** The only object names the cleanup call may delete: the probes testConnection writes. */
const PROBE_RE = /^\.wordjs-connection-test-[0-9a-f]{12}\.png$/;
/** A 1x1 transparent PNG: small, and loadable by the browser as an <img>, which is what the public check does. */
const PROBE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');

function probeKey(store: any, rel: string): string {
    return store.s3.prefix ? `${store.s3.prefix}/${rel}` : rel;
}

const short = (e: any) => String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200);

/** Delete one probe object. */
async function removeProbe(store: any, rel: string, deps: any = {}) {
    const request = deps.s3Request || s3offload.s3Request;
    try {
        const del = await request('DELETE', probeKey(store, rel), store.s3, {}, deps);
        const ok = (del.status >= 200 && del.status < 300) || del.status === 404;
        return { ok, steps: [{ step: 'delete', ok, detail: `HTTP ${del.status}` }] };
    } catch (e) {
        return { ok: false, steps: [{ step: 'delete', ok: false, detail: short(e) }] };
    }
}

/**
 * The server half of the probe: PUT → HEAD of one small object, then DELETE unless `keepProbe` (the
 * admin screen keeps it until the browser has loaded it from the public URL). Exported for the CLI and
 * tests. It never fetches the public URL itself: that URL is operator input, and whether it serves the
 * object is a question about the VIEWER's network, which the browser answers.
 */
async function testConnection(store: any, deps: any = {}, opts: { keepProbe?: boolean } = {}) {
    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
    const rel = `.wordjs-connection-test-${crypto.randomBytes(6).toString('hex')}.png`;
    const key = probeKey(store, rel);
    const request = deps.s3Request || s3offload.s3Request;

    let wrote = false;
    try {
        const put = await request('PUT', key, store.s3, { body: PROBE_PNG, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } }, deps);
        wrote = put.status >= 200 && put.status < 300;
        steps.push({ step: 'write', ok: wrote, detail: `HTTP ${put.status}` });
    } catch (e) {
        steps.push({ step: 'write', ok: false, detail: short(e) });
    }
    if (!wrote) return { ok: false, steps };
    try {
        const head = await request('HEAD', key, store.s3, {}, deps);
        const ok = head.status >= 200 && head.status < 300 && Number(head.headers['content-length']) === PROBE_PNG.length;
        steps.push({ step: 'read', ok, detail: `HTTP ${head.status}` });
    } catch (e) {
        steps.push({ step: 'read', ok: false, detail: short(e) });
    }
    if (opts.keepProbe) {
        return { ok: steps.every((s) => s.ok), steps, probe: rel, publicUrl: `${store.publicBase}/${rel}` };
    }
    const del = await removeProbe(store, rel, deps);
    steps.push(...del.steps);
    return { ok: steps.every((s) => s.ok), steps };
}

/**
 * @swagger
 * /media-storage/migrate:
 *   post:
 *     summary: Move the existing media library to the bucket, or back to local disk
 *     description: Starts (or resumes) a migration in the background and answers at once with the progress record; poll GET /media-storage. offload copies every public attachment's files to the bucket (deleteLocal also removes the local copies once each object verified); restore copies them back to local disk and never deletes from the bucket. Both are idempotent and resumable, and only one runs at a time across the cluster.
 *     tags: [Media storage]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [direction]
 *             properties:
 *               direction: { type: string, enum: [offload, restore] }
 *               deleteLocal: { type: boolean }
 *               restart: { type: boolean }
 *     responses:
 *       202:
 *         description: Started; the body is the current state
 *       400:
 *         description: Bad direction, or no complete s3 configuration
 *       409:
 *         description: rest_media_storage_busy - a migration is already running
 */
router.post('/migrate', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (body.direction !== 'offload' && body.direction !== 'restore') return badRequest(res, 'direction must be offload or restore.', ['direction']);
    if (mediaStorage.resolveMediaStorage().driver !== 's3') return badRequest(res, 'Save a complete S3 configuration first.');
    if (migration.isRunning()) {
        return res.status(409).json({ code: 'rest_media_storage_busy', message: 'A media storage migration is already running.', data: { status: 409 } });
    }
    await recordAudit(req.user && req.user.id, AUDIT_ACTIONS.MEDIA_STORAGE_MIGRATE, 'config', 'mediaStorage', {
        direction: body.direction, deleteLocal: body.deleteLocal === true, restart: body.restart === true,
    });
    // Background: the request answers now; progress is the media_storage_migration option.
    migration.runMigration(body.direction, { deleteLocal: body.deleteLocal === true, restart: body.restart === true })
        .then(() => { purgeDelivery(); })
        .catch((e: any) => console.warn(`media storage migration did not run: ${logSafeError(e)}`));
    res.status(202).json(await statePayload());
}));

module.exports = router;
module.exports.testConnection = testConnection;
module.exports.removeProbe = removeProbe;
module.exports.PROBE_RE = PROBE_RE;
module.exports.mergeBlock = mergeBlock;
