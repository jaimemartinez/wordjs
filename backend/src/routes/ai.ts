/**
 * WordJS — AI provider settings and editor suggestions.
 *
 *   GET  /ai/status    any signed-in user: is AI available, and which suggestion tasks.
 *   GET  /ai/settings  administrator, interactive session: provider, model, base URL, `hasKey` — never the key.
 *   PUT  /ai/settings  administrator, interactive session: save them (audited as `ai.settings.update`).
 *   POST /ai/test      administrator, interactive session: one tiny round trip to the provider.
 *   POST /ai/suggest   a user who may edit the content (or the image): a SUGGESTION, never a write.
 *
 * The key never leaves the server (core/ai-provider). Suggestions are rate-limited per user, and the
 * alt-text task reads the image itself on the server, behind the same rule as editing that image.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const path = require('path');
const { authenticate, sessionOnly } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { recordAudit } = require('../core/audit');
const { routeIdOrNull } = require('../core/query-params');
const ai = require('../core/ai-provider');
const { TASKS, suggestFromText, suggestAltText } = require('../core/ai-suggest');

const SUGGESTIONS_PER_MINUTE = 20;
const windows = new Map<number, number[]>();
function overUserLimit(userId: number): boolean {
    const now = Date.now();
    const recent = (windows.get(userId) || []).filter((t) => now - t < 60_000);
    if (recent.length >= SUGGESTIONS_PER_MINUTE) { windows.set(userId, recent); return true; }
    recent.push(now);
    windows.set(userId, recent);
    return false;
}

function sendAiError(res: Response, e: any) {
    if (e instanceof ai.AiError || (e && typeof e.status === 'number' && typeof e.code === 'string')) {
        return res.status(e.status).json({ code: e.code, message: e.message, data: { status: e.status } });
    }
    throw e;
}

/**
 * @swagger
 * /ai/status:
 *   get:
 *     summary: Whether AI suggestions are available
 *     description: For any signed-in user. Says whether an AI provider is configured and which suggestion tasks exist; nothing about the provider's credentials.
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ enabled, tasks }"
 */
router.get('/status', authenticate, asyncHandler(async (_req: Request, res: Response) => {
    res.json({ enabled: await ai.isConfigured(), tasks: TASKS });
}));

/**
 * @swagger
 * /ai/settings:
 *   get:
 *     summary: Read the AI provider settings (administrators, interactive session)
 *     description: Returns provider, model and base URL, plus `hasKey` and a four-character `keyHint`. The API key itself is never returned.
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The settings without the key.
 *   put:
 *     summary: Save the AI provider settings (administrators, interactive session)
 *     description: >-
 *       `provider` is `anthropic`, `openai-compatible` or empty (off). An empty `apiKey` keeps the stored
 *       key; `clearKey: true` removes it. An OpenAI-compatible `baseUrl` must be https unless it is loopback.
 *       Audited as `ai.settings.update` (never with the key).
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               provider: { type: string, enum: ['', anthropic, openai-compatible] }
 *               model: { type: string }
 *               baseUrl: { type: string }
 *               apiKey: { type: string }
 *               clearKey: { type: boolean }
 *     responses:
 *       200:
 *         description: The saved settings without the key.
 *       400:
 *         description: Invalid provider, model or base URL.
 */
router.get('/settings', authenticate, sessionOnly, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    res.json(await ai.getPublicSettings());
}));

router.put('/settings', authenticate, sessionOnly, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    let changed;
    try {
        changed = await ai.saveSettings(req.body || {});
    } catch (e) {
        return sendAiError(res, e);
    }
    await recordAudit(req.user.id, 'ai.settings.update', 'settings', ai.SETTINGS_OPTION, changed);
    res.json(await ai.getPublicSettings());
}));

/**
 * @swagger
 * /ai/test:
 *   post:
 *     summary: Test the AI provider connection (administrators, interactive session)
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ ok: true, provider, model, ms }"
 *       409:
 *         description: No provider configured.
 *       502:
 *         description: The provider refused or could not be reached (the message never contains the key).
 */
router.post('/test', authenticate, sessionOnly, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    const started = Date.now();
    try {
        const out = await ai.complete({ system: 'Answer with the single word OK.', prompt: 'Connection test.', maxTokens: 256 });
        res.json({ ok: true, provider: out.provider, model: out.model, ms: Date.now() - started });
    } catch (e) {
        return sendAiError(res, e);
    }
}));

/** Load an image the caller may EDIT, downscaled and re-encoded as JPEG for the provider. */
async function imageForAltText(req: Request, res: Response, mediaId: number): Promise<{ image: any; title: string } | null> {
    const Post = require('../models/Post');
    const Media = require('../models/Media');
    const config = require('../config/app');
    const { resolveWithin } = require('../core/safe-path');
    const { attachmentWriteRefusal } = require('../core/attachment-visibility');
    const privateMedia = require('../core/private-media');
    const row = await Post.findById(mediaId);
    const refusal = row && row.postType === 'attachment' ? await attachmentWriteRefusal(req.user, row) : 404;
    if (refusal === 404 || !row) {
        res.status(404).json({ code: 'rest_post_invalid_id', message: 'Invalid media ID.', data: { status: 404 } });
        return null;
    }
    if (refusal === 403) {
        res.status(403).json({ code: 'rest_forbidden', message: 'You cannot edit this media.', data: { status: 403 } });
        return null;
    }
    const mime = String(row.postMimeType || '');
    if (!/^image\/(png|jpe?g|webp|gif|avif)$/i.test(mime) || row.postStatus === privateMedia.PRIVATE_ATTACHMENT_STATUS) {
        res.status(400).json({ code: 'ai_unsupported_media', message: 'Alt text can be suggested for public PNG, JPEG, WebP, GIF or AVIF images.', data: { status: 400 } });
        return null;
    }
    const media = await Media.formatAttachment(row);
    const rel = String(media.relativePath || '').replace(/^\/uploads\//, '');
    const file = rel ? resolveWithin(path.resolve(config.uploads.dir), ...rel.split('/')) : null;
    if (!file) {
        res.status(404).json({ code: 'rest_post_invalid_id', message: 'The image file is not available.', data: { status: 404 } });
        return null;
    }
    const sharp = require('sharp');
    let buf: Buffer;
    try {
        buf = await sharp(file, { limitInputPixels: 64_000_000 })
            .rotate()
            .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
    } catch {
        res.status(400).json({ code: 'ai_unsupported_media', message: 'The image could not be read.', data: { status: 400 } });
        return null;
    }
    return { image: { mediaType: 'image/jpeg', data: buf.toString('base64') }, title: String(row.postTitle || '') };
}

/**
 * @swagger
 * /ai/suggest:
 *   post:
 *     summary: Suggest an excerpt, a meta description or an image's alt text
 *     description: >-
 *       Returns a suggestion only — nothing is saved. `excerpt` and `seo_description` take the draft's
 *       `title` and `content` (HTML or editor JSON) and need edit_posts or edit_pages; `alt_text` takes a
 *       `mediaId` and needs the right to edit that image. 20 suggestions per minute per user.
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [task]
 *             properties:
 *               task: { type: string, enum: [excerpt, seo_description, alt_text] }
 *               title: { type: string }
 *               content: { type: string }
 *               mediaId: { type: integer }
 *               language: { type: string }
 *     responses:
 *       200:
 *         description: "{ suggestion, model }"
 *       409:
 *         description: No AI provider is configured.
 *       429:
 *         description: Too many suggestions.
 */
router.post('/suggest', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const { task, title, content, mediaId, language } = req.body || {};
    if (!TASKS.includes(task)) {
        return res.status(400).json({ code: 'rest_invalid_param', message: `task must be one of: ${TASKS.join(', ')}.`, data: { status: 400 } });
    }
    if (task === 'alt_text' ? !req.user.can('upload_files') : !(req.user.can('edit_posts') || req.user.can('edit_pages'))) {
        return res.status(403).json({ code: 'rest_forbidden', message: 'You cannot request this suggestion.', data: { status: 403 } });
    }
    if ((title !== undefined && typeof title !== 'string') || (content !== undefined && typeof content !== 'string')) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'title and content must be strings.', data: { status: 400 } });
    }
    if (overUserLimit(req.user.id)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ code: 'ai_rate_limited', message: 'Too many AI suggestions. Wait a minute and try again.', data: { status: 429 } });
    }
    try {
        if (task === 'alt_text') {
            const id = routeIdOrNull(mediaId == null ? '' : String(mediaId));
            if (id === null) return res.status(400).json({ code: 'rest_invalid_param', message: 'mediaId is required.', data: { status: 400 } });
            const loaded = await imageForAltText(req, res, id);
            if (!loaded) return;
            return res.json(await suggestAltText(loaded.image, { title: loaded.title, language: typeof language === 'string' ? language : undefined }));
        }
        return res.json(await suggestFromText(task, title, content));
    } catch (e) {
        return sendAiError(res, e);
    }
}));

module.exports = router;
module.exports._resetAiSuggestLimits = () => windows.clear();
