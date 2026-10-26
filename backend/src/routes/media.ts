/**
 * WordJS - Media Routes
 * /api/v1/media/*
 */

import type { Request, Response } from 'express';
const express = require('express');
const log = require('../core/module-logger').moduleLogger('routes/media');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Media = require('../models/Media');
const Post = require('../models/Post');
const config = require('../config/app');
// PRIVATE MEDIA — files outside the served /uploads tree, hidden from every public listing.
const privateMedia = require('../core/private-media');
const { recordAudit } = require('../core/audit');
const {
    canViewAttachment, filterVisibleMediaItems, resolveAttachmentParent, attachmentWriteRefusal,
    canReadRecordThroughRest,
} = require('../core/attachment-visibility');
const { canManagePostRecord } = require('../core/post-capabilities');

/**
 * Did the caller ask for a PRIVATE upload / item? Accepted spelling: `visibility=private` (query string
 * or form field). Anything else that is present but not `public`/`private` is a client error; absent
 * means public, which is what every existing caller gets.
 */
function requestedVisibility(value: unknown): 'public' | 'private' | null | 'invalid' {
    if (value === undefined || value === null || value === '') return null;
    if (value === 'public' || value === 'private') return value;
    return 'invalid';
}

/**
 * May this caller change media item `mediaId` (its fields, its visibility, its image)? Null when they may;
 * otherwise the status and body to answer. Shared by PUT /media/:id and the image edit routes.
 */
async function mediaWriteRefusal(req: Request, mediaId: number): Promise<{ status: number; body: any } | null> {
    const refuse = (status: number, code: string, message: string) => ({ status, body: { code, message, data: { status } } });
    const media = await Media.findById(mediaId);
    if (!media) return refuse(404, 'rest_post_invalid_id', 'Invalid media ID.');

    // THE ATTACHMENT RULE FIRST (core/attachment-visibility attachmentWriteRefusal): an item this caller
    // may not even see — an attachment of an entry they may not read, someone else's private item — is the
    // 404 GET /media/:id answers, so a write does not confirm what a read hides; and an item they see but
    // whose entry they may not EDIT is 403. Without it an editor (edit_others_posts) rewrote, made public
    // and deleted the files of entries of a type with its own capability family.
    const attachmentRefusal = await attachmentWriteRefusal(req.user, await Post.findById(mediaId));
    if (attachmentRefusal === 404) return refuse(404, 'rest_post_invalid_id', 'Invalid media ID.');
    if (attachmentRefusal === 403) return refuse(403, 'rest_forbidden', 'You cannot edit this media.');

    // SECURITY: Ownership check (prevents IDOR). The upload_files gate alone let any
    // author/editor modify ANY user's media. Owners need edit_posts; editing another
    // user's media requires the cross-user edit_others_posts capability. Admins ('*') pass.
    const canEdit = media.author === req.user.id
        ? req.user.can('edit_posts')
        : req.user.can('edit_others_posts');
    if (!canEdit) return refuse(403, 'rest_forbidden', 'You cannot edit this media.');
    return null;
}

/**
 * Remove a file multer just wrote, but only from inside one of the two upload roots: multer chose the
 * path, yet the unlink must never be steerable outside the trees uploads are written to.
 */
function discardUploadedFile(filePath: string): void {
    const resolved = path.resolve(filePath);
    const publicRoot = privateMedia.publicUploadsRoot() + path.sep;
    const privateRoot = privateMedia.privateUploadsRoot() + path.sep;
    if (resolved.startsWith(publicRoot)) {
        try { fs.unlinkSync(resolved); } catch { /* best effort */ }
    } else if (resolved.startsWith(privateRoot)) {
        try { fs.unlinkSync(resolved); } catch { /* best effort */ }
    }
}

// The size ladder, the WebP/AVIF derivatives, their pixel cap and their process-wide encode budget live in
// core/media-derivatives, shared with the WordPress importer (core/wxr-media).
const { generateImageDerivatives } = require('../core/media-derivatives');

/**
 * multer is pulled in with require() and tsconfig pins `types` to ["node"], so @types/multer's
 * ambient augmentation of Express.Request is not part of this program: neither the storage/filter
 * callback signatures nor `req.file` are visible to the compiler. These describe exactly the multer
 * surface this file touches, so the handlers below get real checking instead of the parameter being
 * annotated `any` (or cast back to it, which is the same thing wearing a type).
 */

/** What multer hands the diskStorage/fileFilter callbacks, BEFORE the upload reaches disk. */
interface IncomingFile {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
}

/** What multer attaches to `req.file` once the upload has been stored. */
interface StoredFile extends IncomingFile {
    size: number;
    destination: string;
    filename: string;
    path: string;
}

type UploadRequest = Request & { file?: StoredFile };

/**
 * @swagger
 * components:
 *   schemas:
 *     Media:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         title:
 *           type: string
 *         mimeType:
 *           type: string
 *         sourceUrl:
 *           type: string
 *         date:
 *           type: string
 *           format: date-time
 */
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler, UploadRejectedError } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery, requireRouteId, bodyId } = require('../core/query-params');
const { perPageParam, pageOffset } = require('../core/pagination');

// THE ROUTE-ID CONTRACT — see core/query-params. `:id` is an attachment's post id, parsed with a bare
// `parseInt` at all three sites and handed to `Media.findById` → `Post.findById`, the same sink
// routes/posts.ts uses. So this router carried the same two defects: `/media/9999999999` is
// `22003 value out of range for type integer` (a 500) on Postgres, and `/media/12abc` SERVED
// attachment 12, because parseInt stops at the first character it cannot use. GET is optionalAuth, so
// the 500 needed no credentials. The body below is the one all three routes already send for an
// attachment that does not exist, so a malformed id is now indistinguishable from an absent one.
router.param('id', requireRouteId({ code: 'rest_post_invalid_id', message: 'Invalid media ID.' }));

/**
 * The six parameters GET /media reads. The library list is the twin of the categories/tags/users
 * lists, which have refused a repeated scalar since the first round; this one was left behind, and
 * `String()` hid it: `['asc','desc'].includes(String(order).toLowerCase())` cannot throw, it just
 * compares 'asc,desc' against the whitelist, misses, and sorts DESC — the caller is told nothing.
 * `orderByMap[String(orderby)]` misses the same way and silently falls back to post_date.
 */
const MEDIA_LIST_QUERY_FIELDS: readonly string[] = Object.freeze([
    'page', 'per_page', 'search', 'mime_type', 'orderby', 'order', 'visibility', 'folder',
]);

// Ensure uploads directory exists (the main site's; another site's root is created with the site and
// on first upload below).
if (!fs.existsSync(config.uploads.dir)) {
    fs.mkdirSync(config.uploads.dir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
    destination: (req: Request, file: IncomingFile, cb: (error: Error | null, destination: string) => void) => {
        // Create year/month subdirectory
        const date = new Date();
        const subDir = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        // A PRIVATE upload is written straight into the private root, so its bytes never exist under
        // the served tree, not even while the image ladder is being encoded. The query string is read
        // here because it is known before the body is streamed; a `visibility` FORM field may arrive
        // after the file part, and is honoured by moving the files before the row is created.
        const root = requestedVisibility(req.query && req.query.visibility) === 'private'
            ? privateMedia.privateUploadsRoot()
            : privateMedia.publicUploadsRoot();
        const uploadPath = path.join(root, subDir);

        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }

        cb(null, uploadPath);
    },
    filename: (req: Request, file: IncomingFile, cb: (error: Error | null, filename: string) => void) => {
        // SECURITY: Derive the STORED extension from the validated MIME->extension allowlist
        // (Media.getExtensionForMime), NOT from the client-supplied originalname. This prevents
        // a malicious filename (e.g. "x.php"/"x.html") from being persisted/served verbatim.
        // fileFilter already rejected MIME types without a safe mapped extension, so resolvedExt
        // is expected to be present here; fall back defensively just in case.
        const resolvedExt = Media.getExtensionForMime(file.mimetype);
        const ext = resolvedExt ? `.${resolvedExt}` : '';
        const name = path.basename(file.originalname, path.extname(file.originalname));
        // ASCII stem for the stored name (core/upload-names); the original name stays the title.
        const safeName = require('../core/upload-names').uploadStem(name);
        const uniqueName = `${safeName}-${uuidv4().substring(0, 8)}${ext}`;
        cb(null, uniqueName);
    }
});

// File filter
const fileFilter = (req: Request, file: IncomingFile, cb: (error: Error | null, acceptFile: boolean) => void) => {
    // SECURITY: Block SVG uploads for non-admins (SVGs can contain JavaScript)
    if (file.mimetype === 'image/svg+xml') {
        if (!req.user || req.user.getRole() !== 'administrator') {
            // An administrator's AI agent reports the synthetic role `agent` (core/agent-capabilities) and
            // is refused here too; telling it "administrators only" when its user IS one left it nothing
            // to ask for.
            const viaAgent = !!req.user && req.user.getRole() === 'agent';
            const message = viaAgent
                ? 'SVG uploads are never accepted from an AI agent connection (SVG can carry scripts) — upload a PNG, JPEG or WebP instead, or ask an administrator to upload the SVG from the panel.'
                : 'SVG uploads are restricted to administrators only.';
            return cb(new UploadRejectedError(403, 'rest_upload_svg_forbidden', message), false);
        }
    }

    // SECURITY: Explicitly reject dangerous extensions in the declared filename regardless of
    // the declared MIME (defense in depth — a benign MIME could carry an active-content name).
    const declaredExt = path.extname(file.originalname);
    if (Media.isDangerousExtension(declaredExt)) {
        return cb(new UploadRejectedError(415, 'rest_upload_invalid_type', `File extension ${declaredExt} is not allowed.`), false);
    }

    if (!Media.isAllowedMimeType(file.mimetype)) {
        return cb(new UploadRejectedError(415, 'rest_upload_invalid_type', `File type ${file.mimetype} is not allowed.`), false);
    }

    // SECURITY: The declared MIME must map to a safe stored extension; otherwise we cannot
    // persist it safely and must reject (getExtensionForMime also returns null for dangerous
    // extensions like .xml that are otherwise in the allowlist).
    if (!Media.getExtensionForMime(file.mimetype)) {
        return cb(new UploadRejectedError(415, 'rest_upload_invalid_type', `File type ${file.mimetype} cannot be stored safely.`), false);
    }

    cb(null, true);
};

// The multer options POST /media uploads with. `fileSize` here is only the boot-time default: each
// request uses the limit set in the panel (core/upload-limit), see singleUpload below.
const UPLOAD_OPTIONS = {
    storage,
    fileFilter,
    // Browsers send the multipart filename as raw UTF-8 with no charset parameter; busboy's default
    // (latin1) turned «ñandú.png» into «Ã±andÃº.png» in the media title.
    defParamCharset: 'utf8',
    limits: {
        fileSize: config.uploads.maxFileSize,
        // SECURITY: Prevent CVE-2025-47935 (memory leak) and CVE-2025-47944 (malformed multipart)
        files: 10,          // Max 10 files per request
        fields: 50,         // Max 50 non-file fields
        parts: 100,         // Max total parts (fields + files)
        headerPairs: 2000   // Limit header pairs to prevent header bomb
    }
};

/**
 * `upload.single('file')` with the CURRENT size limit (Settings → Media → «Maximum upload size»), read
 * per request so a change applies at once, without a restart. A refusal for size carries the limit, so
 * the client can say "the maximum is 10 MB" instead of "Failed to upload file".
 */
function singleUpload(req: Request, res: Response, next: (err?: unknown) => void) {
    require('../core/upload-limit').maxUploadBytes().then((limit: number) => {
        multer({ ...UPLOAD_OPTIONS, limits: { ...UPLOAD_OPTIONS.limits, fileSize: limit } }).single('file')(req, res, (err: any) => {
            if (err && err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE') err.limitBytes = limit;
            next(err);
        });
    }, next);
}

/**
 * @swagger
 * /media:
 *   get:
 *     summary: Retrieve media library
 *     description: Lists only the items this caller could read through GET /media/{id} - the same rule, including the parent-entry rule. The rule is applied in the query itself, so X-WP-Total and X-WP-TotalPages count exactly the items this caller may see, on every page and for every search - an attachment of an entry this caller may not read is neither listed nor counted on any page of this list (nor of GET /posts?type=attachment, which applies the same condition).
 *     tags: [Media]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: mime_type
 *         description: Filter by MIME type. A full type filters exactly (`image/png`); a bare family filters the whole family (`image` or `image/`).
 *         schema:
 *           type: string
 *       - in: query
 *         name: visibility
 *         description: Which items to list - `all` (default), `public` or `private`. Private items (stored outside the public uploads tree) are only ever listed to a caller holding upload_files, and only those the caller may edit (their own, or any with edit_others_posts). For everyone else the list is the public library whatever is asked, and `private` answers an empty list.
 *         schema:
 *           type: string
 *           enum: [all, public, private]
 *       - in: query
 *         name: folder
 *         description: A media folder's id (its files only, not its subfolders'), 0 for the files in no folder, or absent / `all` for the whole library.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of media files
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Media'
 */
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    // Refuse a repeated scalar before anything reads it, so every comparison below is a string
    // comparison and the library the caller sees is the one they asked for.
    requireScalarQuery(req.query, MEDIA_LIST_QUERY_FIELDS);

    const {
        page = 1,
        per_page = 20,
        search,
        mime_type,
        orderby = 'date',
        order = 'desc',
        visibility: rawVisibility,
        folder: rawFolder
    } = req.query;

    // MEDIA FOLDERS: absent = the whole library (as always); 0 = the files in no folder; N = folder N's files.
    let mediaFolder: number | undefined;
    if (rawFolder !== undefined && rawFolder !== '' && rawFolder !== 'all') {
        const parsed = require('../core/media-folders').folderIdParam(rawFolder);
        if (parsed === null) {
            return res.status(400).json({ code: 'rest_invalid_param', message: 'folder must be a folder id, 0 or all.', data: { status: 400 } });
        }
        mediaFolder = parsed;
    }

    // PRIVATE MEDIA. Only a caller who may upload can ever be shown a private item, and then only the
    // ones they could edit (their own, or anyone's with edit_others_posts) — filtered below. Everybody
    // else gets exactly the public library this route always returned, whatever they ask for: a private
    // row is not counted, not listed, and its existence is not hinted at by the pager.
    const requested = rawVisibility === undefined || rawVisibility === '' ? 'all' : String(rawVisibility);
    if (!['all', 'public', 'private'].includes(requested)) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'visibility must be one of: all, public, private.',
            data: { status: 400 }
        });
    }
    const mayListPrivate = !!(req.user && req.user.can('upload_files'));
    const visibility = mayListPrivate ? requested : 'public';
    if (!mayListPrivate && requested === 'private') {
        res.set('X-WP-Total', '0');
        res.set('X-WP-TotalPages', '0');
        return res.json([]);
    }

    // String() before parseInt() only spells out the coercion parseInt has always performed on these
    // values: a query parameter is `string | string[] | ParsedQs | ...`, and parseInt's first step is
    // ToString on whatever it is given. `?per_page[]=5` still parses as 5, `?per_page=a&per_page=b`
    // still stringifies to 'a,b' and falls back to the default — identical to the untyped path.
    const limit = perPageParam(per_page, 20);
    const offset = pageOffset(page, limit);

    // Same pair of request-value defects as routes/comments.ts (see the note there):
    //  · Object.create(null) so `?orderby=constructor` finds no inherited key and `|| 'post_date'` fires.
    //  · String() before .toLowerCase(), so `?order[]=asc` is a normal query and not a 500 for an
    //    anonymous caller — the shape routes/categories.ts and routes/tags.ts already use.
    const orderByMap: Record<string, string> = Object.assign(Object.create(null), {
        date: 'post_date',
        modified: 'post_modified',
        title: 'post_title',
        id: 'id'
    });

    // `mime_type` se desestructuraba desde SIEMPRE y no se pasaba a ninguna consulta: el filtro estaba
    // INERTE (la biblioteca devolvía todo, pidieras lo que pidieras). Va a las DOS consultas — filtrar
    // sólo las filas dejaría el total contando la biblioteca entera y el paginador ofreciendo páginas
    // vacías. Post.buildWhere valida la forma y decide exacto vs. familia.
    //
    // SECURITY (BOLA / metadata leak): the media LIST applies EXACTLY the rule GET /media/:id applies,
    // because it asks the same module (core/attachment-visibility). An attachment inherits its parent's
    // visibility, so one hanging off an entry this caller may not READ — unpublished, of a non-public
    // type (even when published), internal, or password protected and not theirs to manage — must not
    // leak its metadata (guid/file URL, author, title) here. Unattached uploads and dangling parents stay
    // visible; someone else's private item is dropped.
    //
    // THE RULE IS PART OF THE QUERY (`attachmentViewer`), for the rows AND for the count. It used to be
    // applied to the fetched page only, with the items hidden on THAT page subtracted from a total that
    // counted everything — so every other page, a page past the end and every `?search=` still counted
    // the hidden items: `?search=<prefix>` walked a hidden file's title (its upload's filename, by
    // default, and so its /uploads URL) one character at a time, and the count said how many there were.
    const attachmentViewer = { user: req.user || null };
    const media = await Media.findAll({
        search,
        mimeType: mime_type,
        visibility,
        attachmentViewer,
        mediaFolder,
        limit,
        offset,
        orderBy: orderByMap[String(orderby)] || 'post_date',
        // SECURITY: Whitelist order direction
        order: ['asc', 'desc'].includes(String(order).toLowerCase()) ? String(order).toUpperCase() : 'DESC'
    });

    // Defense in depth: the same rule item for item over the page (one query for every parent). It can only
    // ever drop a row the query let through; the total is NOT adjusted by it — subtracting per page is
    // exactly the oracle described above, and the query already counted the visible set.
    const visibleMedia = await filterVisibleMediaItems(req.user, media);

    const total = await Media.count({ search, mimeType: mime_type, visibility, attachmentViewer, mediaFolder });
    const totalPages = Math.ceil(total / limit);

    // String() is what res.set() already did to these numbers internally; spelling it out satisfies
    // the typed signature (string | string[]) and emits byte-identical headers.
    res.set('X-WP-Total', String(total));
    res.set('X-WP-TotalPages', String(totalPages));

    res.json(visibleMedia);
}));

// ── Folders (core/media-folders): organisation only — a file's path and URL never change ─────────────

const mediaFolders = () => require('../core/media-folders');

/** Answer a MediaFolderError as its status and code; anything else goes to the error handler. */
function folderErrorAnswer(res: Response, err: any): boolean {
    if (err instanceof mediaFolders().MediaFolderError) {
        res.status(err.status).json({ code: err.code, message: err.message, data: { status: err.status } });
        return true;
    }
    return false;
}

/** A folder id from the path: a positive integer. */
function folderPathId(req: Request): number | null {
    const id = mediaFolders().folderIdParam(req.params.folderId);
    return id ? id : null;
}

/**
 * May this caller move media item `mediaId`? Exactly the rule of PUT /media/:id (mediaWriteRefusal): the
 * refusal's code, or null when they may.
 */
async function mediaMoveRefusal(req: Request, mediaId: number): Promise<string | null> {
    const refusal = await mediaWriteRefusal(req, mediaId);
    return refusal ? String(refusal.body.code) : null;
}

/**
 * @swagger
 * /media/folders:
 *   get:
 *     summary: The media library's folders
 *     description: >-
 *       Every folder with its parent and how many files this caller may see in it (public files, their own
 *       private ones, and any private one with edit_others_posts), plus how many of those files are in no
 *       folder. Folders are organisation only - moving a file never changes its path or URL. Needs upload_files.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ folders: [{ id, name, parent, count }], unfiled, total }"
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Missing upload_files
 *   post:
 *     summary: Create a folder
 *     description: Needs upload_files. The name is unique among the folders that share the parent (ignoring case).
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               parent:
 *                 type: integer
 *                 description: The folder it goes in; 0 or absent for the top level.
 *     responses:
 *       201:
 *         description: "{ id, name, parent, count }"
 *       400:
 *         description: An invalid name or parent (rest_invalid_param, rest_media_folder_invalid, rest_media_folder_limit)
 *       409:
 *         description: A folder with that name is already there (rest_media_folder_exists)
 */
router.get('/folders', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const result = await mediaFolders().listFolders({ id: req.user.id, canSeeAllPrivate: req.user.can('edit_others_posts') });
    res.set('Cache-Control', 'no-store');
    res.json(result);
}));

router.post('/folders', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    try {
        const folder = await mediaFolders().createFolder(b.name, b.parent);
        await recordAudit(req.user.id, 'media.folder.create', 'media_folder', folder.id, { parent: folder.parent });
        res.status(201).json(folder);
    } catch (err: any) {
        if (!folderErrorAnswer(res, err)) throw err;
    }
}));

/**
 * @swagger
 * /media/folders/move:
 *   post:
 *     summary: Move media items into a folder (or out of every folder)
 *     description: >-
 *       Each item is moved only if the caller may edit it (the rule of PUT /media/{id}); the others are listed
 *       in `refused` and left where they are. The files themselves are not touched, so their URLs stay the same.
 *       At most 500 items per request.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *               folder:
 *                 type: integer
 *                 description: The folder; 0 or absent takes the items out of every folder.
 *     responses:
 *       200:
 *         description: "{ moved: [id], refused: [{ id, code }], folder }"
 *       400:
 *         description: Invalid ids or folder (rest_invalid_param, rest_media_folder_invalid)
 */
router.post('/folders/move', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    const folder = mediaFolders().folderIdParam(b.folder);
    if (folder === null || !(await mediaFolders().exists(folder))) {
        return res.status(400).json({ code: 'rest_media_folder_invalid', message: 'No such folder.', data: { status: 400 } });
    }
    const ids = Array.isArray(b.ids) ? b.ids : null;
    if (!ids || !ids.length || ids.length > 500 || !ids.every((v: unknown) => bodyId(v) !== null)) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'ids is a list of 1 to 500 media ids.', data: { status: 400, params: ['ids'] } });
    }
    const moved: number[] = [];
    const refused: Array<{ id: number; code: string }> = [];
    for (const id of [...new Set(ids.map((v: unknown) => bodyId(v)))] as number[]) {
        const refusal = await mediaMoveRefusal(req, id);
        if (refusal) { refused.push({ id, code: refusal }); continue; }
        await mediaFolders().setFolder(id, folder);
        moved.push(id);
    }
    if (moved.length) await recordAudit(req.user.id, 'media.move', 'media_folder', folder, { count: moved.length });
    res.json({ moved, refused, folder });
}));

/**
 * @swagger
 * /media/folders/{folderId}:
 *   put:
 *     summary: Rename a folder or move it inside another one
 *     description: Needs upload_files and edit_others_posts (folders are shared by everyone who uploads). A folder cannot go inside itself or one of its own folders.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: folderId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               parent:
 *                 type: integer
 *     responses:
 *       200:
 *         description: "{ id, name, parent }"
 *       400:
 *         description: An invalid name or parent (rest_invalid_param, rest_media_folder_invalid, rest_media_folder_cycle)
 *       403:
 *         description: Missing upload_files or edit_others_posts
 *       404:
 *         description: No such folder (rest_media_folder_not_found)
 *       409:
 *         description: A folder with that name is already there (rest_media_folder_exists)
 *   delete:
 *     summary: Delete a folder, moving what it holds
 *     description: >-
 *       Its files and subfolders go into `moveTo` first (a folder, or 0 for no folder; the deleted folder's
 *       parent when absent), which may not be the folder itself or one below it. No file is deleted and none is
 *       left in a folder that no longer exists. Needs upload_files and edit_others_posts.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: folderId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: moveTo
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: "{ deleted: true, movedFiles, movedFolders, moveTo }"
 *       400:
 *         description: An invalid destination (rest_media_folder_invalid, rest_media_folder_cycle)
 *       403:
 *         description: Missing upload_files or edit_others_posts
 *       404:
 *         description: No such folder (rest_media_folder_not_found)
 */
router.put('/folders/:folderId', authenticate, can('upload_files'), can('edit_others_posts'), asyncHandler(async (req: Request, res: Response) => {
    const id = folderPathId(req);
    if (!id) return res.status(404).json({ code: 'rest_media_folder_not_found', message: 'No such folder.', data: { status: 404 } });
    const b = req.body || {};
    try {
        const folder = await mediaFolders().updateFolder(id, { name: b.name, parent: b.parent });
        await recordAudit(req.user.id, 'media.folder.update', 'media_folder', id, { renamed: b.name !== undefined, parent: b.parent !== undefined ? folder.parent : undefined });
        res.json(folder);
    } catch (err: any) {
        if (!folderErrorAnswer(res, err)) throw err;
    }
}));

router.delete('/folders/:folderId', authenticate, can('upload_files'), can('edit_others_posts'), asyncHandler(async (req: Request, res: Response) => {
    const id = folderPathId(req);
    if (!id) return res.status(404).json({ code: 'rest_media_folder_not_found', message: 'No such folder.', data: { status: 404 } });
    requireScalarQuery(req.query, ['moveTo']);
    try {
        const result = await mediaFolders().deleteFolder(id, req.query.moveTo === undefined ? undefined : req.query.moveTo);
        await recordAudit(req.user.id, 'media.folder.delete', 'media_folder', id, { moveTo: result.moveTo, movedFiles: result.movedFiles, movedFolders: result.movedFolders });
        res.json({ deleted: true, ...result });
    } catch (err: any) {
        if (!folderErrorAnswer(res, err)) throw err;
    }
}));

/**
 * GET /media/:id
 * Get single media
 */
/**
 * @swagger
 * /media/{id}:
 *   get:
 *     summary: Read one media item
 *     description: An attachment inherits its visibility from its parent entry - it is visible only to a caller who may READ that entry under its type's read policy, exactly as GET /posts/{id} decides. A parent that is unpublished, or a published entry of a non-public type, hides the item from anyone who is neither the entry's author nor a holder of that type's edit_others / read_private capability; an internal parent (a menu item, a revision) never makes it public; a password-protected or members-only parent shows it only to a caller who manages that entry (its author, or edit_others for its type). The answer is 404 rather than 403, so a hidden attachment does not reveal that it exists. An unattached attachment has no parent to inherit from and stays public. A PRIVATE item (visibility private) is likewise 404 to anyone who may not edit it, and its sourceUrl is the authenticated /media/{id}/file route, never a public /uploads path. An attachment row in any other status (for example a draft created through POST /posts) is read like that unpublished post - 404 to anyone who may not read it. The featuredMedia of every post applies this same rule for its reader.
 *     tags: [Media]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: The media item
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Media'
 *       404:
 *         description: No such media item, or it is hidden from this caller (rest_post_invalid_id)
 */
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    // Express 5 types a route param as `string | string[]` (repeatable patterns like `/:id+`); this
    // route declares a single `/:id`, so the value is always a string at runtime. String() spells out
    // the ToString parseInt already applied, so the parse is unchanged for every possible input.
    const row = await Post.findById(parseInt(String(req.params.id), 10));

    // WHO MAY SEE IT is core/attachment-visibility's answer — the same one the media list and the
    // featured-image projection of every post ask, so the surfaces cannot disagree again. In short: a
    // PRIVATE item is visible only to someone who may edit it; an attachment is visible only to a caller
    // who may READ its PARENT entry (that type's read policy: a published entry of a non-public type
    // hides it as surely as a draft does; an internal parent is never public; a password-protected or
    // members-only parent shows it only to who manages that entry; unattached or dangling hides nothing); and an
    // attachment row in any other status (a draft created through the generic /posts surface, a trashed
    // one) is read like the unpublished post it is. Every refusal is the 404 of "no such item"
    // (mirroring GET /posts/:id), so a hidden attachment's existence is not revealed.
    const parent = await resolveAttachmentParent(row);
    if (!row || !canViewAttachment(req.user, row, parent)) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid media ID.',
            data: { status: 404 }
        });
    }

    res.json(await Media.formatAttachment(row));
}));

/**
 * @swagger
 * /media/{id}/file:
 *   get:
 *     summary: Download the file of a private media item
 *     description: The ONLY way a person reaches a private item's bytes - private files are stored outside the public /uploads tree, which serves them to nobody (a plugin route holding the media:private_read grant can also deliver them, under that plugin's own rule). Requires a logged-in caller who may edit the item (its uploader with upload_files, or anyone with edit_others_posts) AND who may read the entry it is attached to - the same rule GET /media/{id} applies, so the bytes are never reachable where the metadata is hidden. Served as a download (Content-Disposition attachment, nosniff, no-store). A public item, or one this caller may not read this way, answers 404.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: The file bytes
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       404:
 *         description: No such private item, or this caller may not read it (rest_post_invalid_id)
 */
router.get('/:id/file', authenticate, asyncHandler(async (req: Request, res: Response) => {
    // THE BYTES TAKE THE SAME RULE AS THE METADATA — canViewAttachment, parent entry included. This route
    // used to ask only canAccessPrivateMedia ("may edit the item": its uploader, or any edit_others_posts
    // holder), so an editor downloaded the private file of a published entry of a type with its own
    // capability family while GET /media/:id — the item's metadata — answered 404 to the same editor.
    const row = await Post.findById(parseInt(String(req.params.id), 10));
    const parent = await resolveAttachmentParent(row);
    if (!row || row.postStatus !== privateMedia.PRIVATE_ATTACHMENT_STATUS || !canViewAttachment(req.user, row, parent)) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid media ID.',
            data: { status: 404 }
        });
    }
    const media = await Media.formatAttachment(row);
    await privateMedia.streamPrivateMedia(res, media.id, { filename: path.basename(String(media.mediaDetails?.file || '')) });
}));

/**
 * @swagger
 * /media:
 *   post:
 *     summary: Upload a new media file
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               title:
 *                 type: string
 *               caption:
 *                 type: string
 *               visibility:
 *                 type: string
 *                 enum: [public, private]
 *                 description: '`private` stores the file outside the public uploads tree and hides the item from every public listing. May also be sent as the `visibility` query parameter, which is preferred (it is known before the file is streamed to disk).'
 *               folder:
 *                 type: integer
 *                 description: The media folder the item goes in (organisation only - the path is the same). May also be sent as the `folder` query parameter.
 *     responses:
 *       201:
 *         description: Media uploaded
 *       400:
 *         description: Invalid file
 *       403:
 *         description: "`rest_upload_svg_forbidden` — SVG uploads are restricted to administrators."
 *       413:
 *         description: "`rest_upload_too_large` — the file exceeds the configured upload size limit."
 *       415:
 *         description: "`rest_upload_invalid_type` — a file type or extension the media library does not accept."
 */
router.post('/', authenticate, can('upload_files'), singleUpload, asyncHandler(async (req: UploadRequest, res: Response) => {
    // Bound once into a const so the "an upload actually arrived" guard below still holds inside the
    // per-size callbacks further down; narrowing a property access does not survive a closure.
    const uploaded = req.file;
    if (!uploaded) {
        return res.status(400).json({
            code: 'rest_upload_no_file',
            message: 'No file was uploaded.',
            data: { status: 400 }
        });
    }

    // MULTISITE STORAGE QUOTA (core/site-upload-quota): a site other than site 1 may be capped by the
    // network administrator. Checked before any processing, against the bytes that arrived; a refused
    // upload leaves nothing behind. No quota (site 1, a single site, none set) costs no query.
    // MEDIA FOLDERS: the folder it goes in (query or form field), checked before anything is kept.
    const mediaFolders = require('../core/media-folders');
    const rawFolder = req.query && req.query.folder !== undefined ? req.query.folder : (req.body && req.body.folder);
    const uploadFolder = mediaFolders.folderIdParam(Array.isArray(rawFolder) ? null : rawFolder);
    if (uploadFolder === null || !(await mediaFolders.exists(uploadFolder))) {
        discardUploadedFile(uploaded.path);
        return res.status(400).json({ code: 'rest_media_folder_invalid', message: 'No such folder.', data: { status: 400 } });
    }

    const quotaCheck = await require('../core/site-upload-quota').checkUploadFits(uploaded.size);
    if (!quotaCheck.ok) {
        discardUploadedFile(uploaded.path);
        return res.status(413).json(require('../core/site-upload-quota').quotaExceededBody(quotaCheck));
    }

    // --- SECURITY CHECK: Magic Numbers & SVG Sanitization ---
    const { fileTypeFromBuffer } = require('../core/file-type-detect');
    const { sanitizeSvg } = require('../core/svg-sanitize');

    // SECURITY: Types whose binary signature MUST be confirmable. For these, a missing/unknown
    // magic-byte result is treated as a forgery attempt (fail-closed) rather than waved through.
    // SVG is text-based XML (no fixed signature) and is handled by the sanitization path below,
    // so it is intentionally excluded from this requirement.
    const declaredMime = uploaded.mimetype || '';
    const requiresSignature =
        (declaredMime.startsWith('image/') && declaredMime !== 'image/svg+xml') ||
        declaredMime === 'application/pdf';

    try {
        // SECURITY (GHSA-5v7r-6r5c-r473): file-type before 21.3.1 has an ASF parser that can spin in an
        // infinite loop on a malformed ASF object (zero-size sub-header), hanging the single-process
        // event loop (DoS). The installed release is fixed; the bounds below stay as defence in depth
        // against the next parser bug of that kind. Magic-byte detection is bounded three ways:
        //   1. Read only the first MAGIC_BYTES of the file — all signatures we care about live in the
        //      header, and a bounded buffer caps how much the parser can iterate.
        //   2. Skip the ASF code path outright: an ASF file is identified by its leading GUID; no ASF
        //      MIME is on the upload allowlist (isAllowedMimeType), so detecting it could only ever
        //      lead to rejection. We treat an ASF magic prefix as "undetected" (fail-closed for types
        //      that require a signature; a disguised ASF is a forgery anyway).
        //   3. Race detection against a timeout so any other pathological parse cannot hang the loop.
        const MAGIC_BYTES = 4100; // sufficient for every signature file-type recognises
        // ASF/WMV/WMA header GUID (little-endian): 30 26 B2 75 8E 66 CF 11 A6 D9 00 AA 00 62 CE 6C
        const ASF_GUID = Buffer.from([
            0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11,
            0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C
        ]);

        const fd = fs.openSync(uploaded.path, 'r');
        let head: Buffer;
        try {
            const buf = Buffer.alloc(MAGIC_BYTES);
            const bytesRead = fs.readSync(fd, buf, 0, MAGIC_BYTES, 0);
            head = buf.subarray(0, bytesRead);
        } finally {
            fs.closeSync(fd);
        }

        let result;
        if (head.length >= ASF_GUID.length && head.subarray(0, ASF_GUID.length).equals(ASF_GUID)) {
            // ASF container — skip the vulnerable parser and treat as undetected.
            result = undefined;
        } else {
            const DETECT_TIMEOUT_MS = 3000;
            let timer: NodeJS.Timeout;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('file-type detection timed out')), DETECT_TIMEOUT_MS);
            });
            try {
                result = await Promise.race([fileTypeFromBuffer(head), timeout]);
            } finally {
                clearTimeout(timer!);
            }
        }

        // If file-type detected something, verify it matches the extension/mimetype
        if (result) {
            const allowed = Media.isAllowedMimeType(result.mime);
            if (!allowed) {
                fs.unlinkSync(uploaded.path);
                return res.status(400).json({
                    code: 'rest_upload_invalid_file_type',
                    message: `File content (${result.mime}) does not match allowed types.`,
                    data: { status: 400 }
                });
            }
            // For binary types that must carry a signature, the confirmed signature must also
            // agree with the declared MIME (e.g. declared image/png whose bytes are application/pdf
            // would be a mismatch). This blocks polyglot/extension-confusion uploads.
            if (requiresSignature && result.mime !== declaredMime) {
                fs.unlinkSync(uploaded.path);
                return res.status(400).json({
                    code: 'rest_upload_invalid_file_type',
                    message: `File content (${result.mime}) does not match the declared type (${declaredMime}).`,
                    data: { status: 400 }
                });
            }
        } else if (requiresSignature) {
            // FAIL-CLOSED: a type that must have a signature but file-type could not confirm one
            // (e.g. an HTML/text payload renamed to .png/.pdf) is rejected.
            fs.unlinkSync(uploaded.path);
            return res.status(400).json({
                code: 'rest_upload_invalid_file_type',
                message: `File content could not be verified for declared type ${declaredMime}.`,
                data: { status: 400 }
            });
        }

        // SVG Sanitization (Defense in Depth)
        if (uploaded.mimetype === 'image/svg+xml') {
            const rawSvg = fs.readFileSync(uploaded.path, 'utf8');
            // An explicit allowlist (core/svg-sanitize), shared with the WordPress importer.
            const cleanSvg = sanitizeSvg(rawSvg);
            fs.writeFileSync(uploaded.path, cleanSvg);
        }

    } catch (err) {
        log.error({ err }, 'Security check failed');
        // FAIL-CLOSED: if the magic-byte/sanitization step threw for a type that MUST carry a
        // verifiable signature, do not let the unverified file through.
        if (requiresSignature) {
            try { if (fs.existsSync(uploaded.path)) fs.unlinkSync(uploaded.path); } catch (_) { /* best effort */ }
            return res.status(400).json({
                code: 'rest_upload_invalid_file_type',
                message: `File content could not be verified for declared type ${declaredMime}.`,
                data: { status: 400 }
            });
        }
    }
    // -------------------------------------
    const { title, description, caption, alt } = req.body;

    // Where the file was written (multer's destination) and where it must END UP. They differ only when
    // `visibility=private` arrived as a form field AFTER the file part; that file is moved (with all its
    // derivatives) into the private root before the row exists, so no public URL is ever recorded.
    const queryVisibility = requestedVisibility(req.query && req.query.visibility);
    const bodyVisibility = requestedVisibility(req.body && req.body.visibility);
    if (queryVisibility === 'invalid' || bodyVisibility === 'invalid') {
        discardUploadedFile(uploaded.path);
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'visibility must be public or private.',
            data: { status: 400 }
        });
    }
    const storedPrivate = queryVisibility === 'private';
    const wantPrivate = storedPrivate || bodyVisibility === 'private';
    const storedRoot = storedPrivate ? privateMedia.privateUploadsRoot() : privateMedia.publicUploadsRoot();

    // Get relative path from uploads dir
    const relativePath = path.relative(storedRoot, uploaded.path).replace(/\\/g, '/');

    // Image processing: the size ladder and its WebP/AVIF derivatives, written beside the file
    // (core/media-derivatives — the same call the WordPress importer makes). Never throws.
    const { width, height, sizes, sources } = await generateImageDerivatives(uploaded.path, uploaded.mimetype);

    if (wantPrivate && !storedPrivate) {
        const fromFiles = Media._deletableFiles(relativePath, sizes, sources, storedRoot);
        const toFiles = Media._deletableFiles(relativePath, sizes, sources, privateMedia.privateUploadsRoot());
        if (!fromFiles.length || fromFiles.length !== toFiles.length) {
            for (const f of fromFiles) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
            return res.status(400).json({
                code: 'rest_upload_invalid_file_type',
                message: 'The uploaded file could not be stored privately.',
                data: { status: 400 }
            });
        }
        privateMedia.moveAttachmentFiles(fromFiles.map((f: string, i: number) => [f, toFiles[i]]));
    }

    // MEDIA OFFLOAD (core/media-storage). With an s3 store configured, a PUBLIC upload — the original and
    // every derivative written above — goes to the bucket BEFORE the row exists, verified by size, so no
    // row is ever told its files are somewhere that does not hold them. The row keeps the same relative
    // /uploads path as always; only the `_wjs_media_storage` marker says where the bytes are. A bucket
    // that refuses the write fails the upload (and removes what it wrote): keeping the file only on this
    // node's disk would hand every other node a broken image.
    let offloaded = false;
    const mediaStorage = require('../core/media-storage');
    const store = wantPrivate ? null : mediaStorage.resolveMediaStorage();
    if (store && store.driver === 's3') {
        const files = Media._deletableFiles(relativePath, sizes, sources, storedRoot);
        try {
            await mediaStorage.pushFiles(mediaStorage.getMediaStorage(store), storedRoot, files);
            offloaded = true;
        } catch (err: any) {
            log.error(`Media upload: the media bucket refused the upload: ${require('../core/log-safe').logSafeError(err)}`);
            for (const f of files) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
            return res.status(502).json({
                code: 'rest_media_storage_unavailable',
                message: 'The media storage bucket could not store this file. Nothing was saved; try again or check Settings → Media storage.',
                data: { status: 502 }
            });
        }
        if (!store.keepLocalCopy) {
            for (const f of files) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
        }
    }

    const media = await Media.create({
        offloaded,
        isPrivate: wantPrivate,
        authorId: req.user.id,
        title: title || uploaded.originalname,
        filename: relativePath,
        mimeType: uploaded.mimetype,
        filePath: relativePath,
        fileSize: uploaded.size,
        width,
        height,
        sizes,
        sources,
        description,
        caption,
        alt
    });

    if (uploadFolder && media && media.id) {
        await mediaFolders.setFolder(media.id, uploadFolder);
        media.folder = uploadFolder;
    }

    require('../core/site-upload-quota').invalidateUsage();
    await recordAudit(req.user.id, 'media.upload', 'media', media && media.id, {
        mimeType: uploaded.mimetype, size: uploaded.size, visibility: wantPrivate ? 'private' : 'public'
    });
    res.status(201).json(media);
}));

/**
 * PUT /media/:id
 * Update media
 */
/**
 * @swagger
 * /media/{id}:
 *   put:
 *     summary: Update the metadata of a media item
 *     description: upload_files alone is not enough. Editing your own item needs edit_posts; editing someone else item needs the cross-user edit_others_posts. An item attached to an entry also needs the right to EDIT that entry (its type's edit gate), and an item this caller may not read through GET /media/{id} answers 404. Only the four descriptive fields and the visibility can be changed here - the stored file is never replaced.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               caption:
 *                 type: string
 *               alt:
 *                 type: string
 *               visibility:
 *                 type: string
 *                 enum: [public, private]
 *                 description: Make the item private (its files move out of the public uploads tree and it disappears from every public listing) or public again. A previously public URL may still be held by browsers or caches that fetched it before.
 *     responses:
 *       200:
 *         description: The updated media item
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Media'
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: You cannot edit this media (rest_forbidden)
 *       404:
 *         description: No such media item, or one this caller may not read (rest_post_invalid_id)
 */
router.put('/:id', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const mediaId = parseInt(String(req.params.id), 10);
    const refusal = await mediaWriteRefusal(req, mediaId);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const { title, description, caption, alt } = req.body;

    const visibility = requestedVisibility(req.body && req.body.visibility);
    if (visibility === 'invalid') {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'visibility must be public or private.',
            data: { status: 400 }
        });
    }
    if (visibility) {
        try {
            await Media.setVisibility(mediaId, visibility === 'private');
        } catch (e: any) {
            if (e && (e.code === 'media_remote_linked' || e.code === 'media_file_missing')) {
                return res.status(409).json({ code: 'rest_media_visibility', message: e.message, data: { status: 409 } });
            }
            throw e;
        }
    }

    const updated = await Media.update(mediaId, {
        title,
        description,
        caption,
        alt
    });

    // Field NAMES only (the values are in the media row itself) — see core/audit's "small" contract.
    const fields = Object.entries({ title, description, caption, alt, visibility })
        .filter(([, v]) => v !== undefined && v !== null).map(([k]) => k);
    await recordAudit(req.user.id, 'media.update', 'media', mediaId, { fields });
    res.json(updated);
}));

/**
 * DELETE /media/:id
 * Delete media
 */
/**
 * @swagger
 * /media/{id}:
 *   delete:
 *     summary: Delete a media item and its file
 *     description: upload_files alone is not enough. Deleting your own item needs delete_posts; deleting someone else item needs the cross-user delete_others_posts. An item attached to an entry also needs the right to EDIT that entry (its type's edit gate), and an item this caller may not read through GET /media/{id} answers 404. The stored file is always removed with the row - there is no orphan-leaving mode.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Media deleted. The body carries the deleted item as previous.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted:
 *                   type: boolean
 *                 previous:
 *                   $ref: '#/components/schemas/Media'
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: You cannot delete this media (rest_forbidden)
 *       404:
 *         description: No such media item, or one this caller may not read (rest_post_invalid_id)
 */

/**
 * The image an edit route may work on: the item's current file on this node's disk, or why it cannot be
 * edited. Items in the media bucket and items linked to another site have no local file to re-encode.
 */
async function editableImage(mediaId: number): Promise<{ media: any; root: string; file: string } | { status: number; code: string; message: string }> {
    const media = await Media.findById(mediaId);
    if (media.storage === 's3') {
        return { status: 409, code: 'rest_media_edit_unavailable', message: 'This image is stored in the media bucket; images there cannot be edited yet.' };
    }
    if (await Media._isRemotelyLinked(mediaId)) {
        return { status: 409, code: 'rest_media_edit_unavailable', message: 'This image is linked to a file on another site; there is no local file to edit.' };
    }
    const root = privateMedia.uploadsRootFor(media.visibility === 'private');
    const file = Media._deletableFiles(media.mediaDetails && media.mediaDetails.file, {}, {}, root)[0];
    if (!file || !fs.existsSync(file)) {
        return { status: 409, code: 'media_file_missing', message: 'The stored file for this image could not be found.' };
    }
    return { media, root, file };
}

/** After the item's image changed: the pages that show it as their featured image are rebuilt now. */
async function afterImageChange(mediaId: number): Promise<void> {
    require('../core/site-upload-quota').invalidateUsage();
    const purge = require('../core/frontend-purge');
    for (const postId of await Media.featuredUsers(mediaId)) await purge.purgeForPost(postId);
}

/**
 * @swagger
 * /media/{id}/edit:
 *   post:
 *     summary: Rotate, flip, crop or scale down an image
 *     description: >-
 *       Same permission as PUT /media/{id}. The edited image is written under a new file name with its own
 *       sizes, and the item points at it; the earlier files stay, so pages that already show them keep
 *       working, and POST /media/{id}/restore-original brings the uploaded file back. The operations run in
 *       this order - rotate, flip, crop, scale. JPEG, PNG and WebP images on this server's disk only.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               rotate:
 *                 type: integer
 *                 description: Clockwise turn, a multiple of 90 degrees.
 *               flipH:
 *                 type: boolean
 *                 description: Mirror left to right.
 *               flipV:
 *                 type: boolean
 *                 description: Mirror top to bottom.
 *               crop:
 *                 type: object
 *                 description: The area to keep, as fractions (0-1) of the rotated and flipped image.
 *                 properties:
 *                   x: { type: number }
 *                   y: { type: number }
 *                   width: { type: number }
 *                   height: { type: number }
 *               width:
 *                 type: integer
 *                 description: Scale down to this width in pixels, keeping the proportions (never enlarges).
 *     responses:
 *       200:
 *         description: The updated media item
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Media'
 *       400:
 *         description: Not an editable image type, or invalid operations (rest_invalid_param)
 *       403:
 *         description: You cannot edit this media (rest_forbidden)
 *       404:
 *         description: No such media item, or one this caller may not read (rest_post_invalid_id)
 *       409:
 *         description: The image has no local file to edit (rest_media_edit_unavailable, media_file_missing)
 *       413:
 *         description: The site's storage quota has no room for the edited image
 */
router.post('/:id/edit', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const mediaId = parseInt(String(req.params.id), 10);
    const refusal = await mediaWriteRefusal(req, mediaId);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const mediaEdit = require('../core/media-edit');
    const parsed = mediaEdit.parseImageEdit(req.body);
    if (parsed.error) return res.status(400).json({ code: 'rest_invalid_param', message: parsed.error, data: { status: 400 } });

    const target = await editableImage(mediaId);
    if ('status' in target) return res.status(target.status).json({ code: target.code, message: target.message, data: { status: target.status } });
    const mimeType = String(target.media.mimeType || '');
    if (!mediaEdit.EDITABLE_IMAGE_TYPES.includes(mimeType)) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'Only JPEG, PNG and WebP images can be edited.', data: { status: 400 } });
    }

    const dest = mediaEdit.editedFilePath(target.file);
    let written: { width: number; height: number; filesize: number };
    try {
        written = await mediaEdit.writeEditedImage(target.file, mimeType, parsed.ops, dest);
    } catch (err: any) {
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* best effort */ }
        log.warn(`Media edit: attachment ${mediaId} could not be re-encoded: ${require('../core/log-safe').logSafeError(err)}`);
        return res.status(400).json({ code: 'rest_invalid_param', message: 'This image could not be read to edit it.', data: { status: 400 } });
    }
    const quota = require('../core/site-upload-quota');
    const quotaCheck = await quota.checkUploadFits(written.filesize);
    if (!quotaCheck.ok) {
        try { fs.unlinkSync(dest); } catch { /* best effort */ }
        return res.status(413).json(quota.quotaExceededBody(quotaCheck));
    }

    const { sizes, sources } = await generateImageDerivatives(dest, mimeType);
    const updated = await Media.replaceImage(mediaId, {
        file: path.relative(target.root, dest).replace(/\\/g, '/'),
        width: written.width, height: written.height, filesize: written.filesize, sizes, sources,
    });
    await afterImageChange(mediaId);
    await recordAudit(req.user.id, 'media.edit', 'media', mediaId, {
        rotate: parsed.ops.rotate, flipH: parsed.ops.flipH, flipV: parsed.ops.flipV, crop: !!parsed.ops.crop, width: parsed.ops.width,
    });
    res.json(updated);
}));

/**
 * @swagger
 * /media/{id}/restore-original:
 *   post:
 *     summary: Bring back the uploaded file of an edited image
 *     description: Same permission as PUT /media/{id}. The edited file stays among the item's earlier files.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: The updated media item
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Media'
 *       403:
 *         description: You cannot edit this media (rest_forbidden)
 *       404:
 *         description: No such media item, or one this caller may not read (rest_post_invalid_id)
 *       409:
 *         description: The image was never edited, or has no local file (rest_media_not_edited, rest_media_edit_unavailable)
 */
router.post('/:id/restore-original', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const mediaId = parseInt(String(req.params.id), 10);
    const refusal = await mediaWriteRefusal(req, mediaId);
    if (refusal) return res.status(refusal.status).json(refusal.body);
    const target = await editableImage(mediaId);
    if ('status' in target) return res.status(target.status).json({ code: target.code, message: target.message, data: { status: target.status } });
    if (!target.media.edited) {
        return res.status(409).json({ code: 'rest_media_not_edited', message: 'This image has not been edited.', data: { status: 409 } });
    }
    const updated = await Media.restoreOriginalImage(mediaId);
    await afterImageChange(mediaId);
    await recordAudit(req.user.id, 'media.restore_original', 'media', mediaId, {});
    res.json(updated);
}));

/**
 * @swagger
 * /media/{id}/usage:
 *   get:
 *     summary: Entries that use this media item as their featured image
 *     description: >-
 *       Asked before a delete, so the admin can say what the item is still used by. Deleting it removes
 *       those featured-image references. Only entries the caller may read are counted, and only those they
 *       work on (author with the type's edit capability, or edit_others for the type) are listed by title.
 *     tags: [Media]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: "{ featuredIn: number, entries: [{ id, title, type }] }"
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Missing upload_files
 *       404:
 *         description: No such media item, or one this caller may not see (rest_post_invalid_id)
 */
router.get('/:id/usage', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const mediaId = Number(req.params.id);
    // The item itself takes GET /media/:id's rule (canViewAttachment, parent entry included): a hidden
    // item answers the same 404 as a missing one.
    const row = await Post.findById(mediaId);
    const media = row && row.postType === 'attachment' ? await Media.findById(mediaId) : null;
    if (!media || !canViewAttachment(req.user, row, await resolveAttachmentParent(row))) {
        return res.status(404).json({ code: 'rest_post_invalid_id', message: 'Invalid media ID.', data: { status: 404 } });
    }
    // Each entry is judged on its own record: COUNTED when the caller may read it (canReadRecordThroughRest),
    // LISTED by title when they also work on it (canManagePostRecord — its type's family and ownership).
    // A draft or private entry of someone else is neither, so this does not reveal that it exists.
    const ids = await Media.featuredUsers(mediaId);
    const entries: Array<{ id: number; title: string; type: string }> = [];
    let featuredIn = 0;
    for (const id of ids) {
        const post = await Post.findById(id);
        if (!post || !(await canReadRecordThroughRest(req.user, post))) continue;
        featuredIn++;
        if (entries.length < 20 && canManagePostRecord(req.user, post)) {
            entries.push({ id, title: String(post.postTitle || ''), type: String(post.postType || 'post') });
        }
    }
    res.set('Cache-Control', 'no-store');
    res.json({ featuredIn, entries });
}));

router.delete('/:id', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const mediaId = parseInt(String(req.params.id), 10);
    const media = await Media.findById(mediaId);

    if (!media) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid media ID.',
            data: { status: 404 }
        });
    }

    // The attachment rule first, exactly as PUT /media/:id (see there): hidden is 404, an entry this caller
    // may not edit is 403 — deleting a file changes the entry that shows it.
    const attachmentRefusal = await attachmentWriteRefusal(req.user, await Post.findById(mediaId));
    if (attachmentRefusal === 404) {
        return res.status(404).json({ code: 'rest_post_invalid_id', message: 'Invalid media ID.', data: { status: 404 } });
    }
    if (attachmentRefusal === 403) {
        return res.status(403).json({ code: 'rest_forbidden', message: 'You cannot delete this media.', data: { status: 403 } });
    }

    // SECURITY: Ownership check (prevents IDOR). The upload_files gate alone let any
    // author/editor delete ANY user's media. Owners need delete_posts; deleting another
    // user's media requires the cross-user delete_others_posts capability. Admins ('*') pass.
    const canDelete = media.author === req.user.id
        ? req.user.can('delete_posts')
        : req.user.can('delete_others_posts');

    if (!canDelete) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot delete this media.',
            data: { status: 403 }
        });
    }

    // Always delete the file when deleting media
    // The force parameter was causing files to be orphaned since the frontend doesn't send it
    await Media.delete(mediaId, true);

    await recordAudit(req.user.id, 'media.delete', 'media', mediaId, {
        title: media.title, mimeType: media.mimeType, visibility: media.visibility
    });
    res.json({ deleted: true, previous: media });
}));

module.exports = router;
