/**
 * Folders in the media library: organisation only.
 *
 * A folder is a term of the INTERNAL taxonomy `wjs_media_folder` (never registered, like `nav_menu`, so it
 * is not listed by /taxonomies, has no public archive and is not in the sitemap), which gives it a name, a
 * parent and per-site storage on every engine through the existing terms/term_taxonomy tables. A file's
 * folder is the protected post meta `_wjs_media_folder` (the folder's term id; absent = not in a folder).
 *
 * A file's PATH and URL never change when it is moved: content keeps linking to `/uploads/...`. Moving is a
 * meta write; deleting a folder moves what it holds (files and subfolders) into another folder or out of
 * every folder first, so no file is ever left pointing at a folder that does not exist.
 */
const { dbAsync } = require('../config/database');
const Term = require('../models/Term');

const MEDIA_FOLDER_TAXONOMY = 'wjs_media_folder';
const MEDIA_FOLDER_META_KEY = '_wjs_media_folder';
const MAX_FOLDER_NAME = 100;
const MAX_FOLDERS = 2000;

export interface MediaFolder { id: number; name: string; parent: number; count: number }

export class MediaFolderError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** A folder id as the API takes it: a positive integer, or 0/'' for «no folder». Null when malformed. */
function folderIdParam(raw: unknown): number | null {
    if (raw === undefined || raw === null || raw === '' || raw === 0 || raw === '0') return 0;
    const s = String(raw);
    if (!/^[1-9][0-9]{0,9}$/.test(s)) return null;
    return Number(s);
}

function cleanName(raw: unknown): string {
    const name = Term.sanitizeName(typeof raw === 'string' ? raw : '');
    return String(name || '').trim();
}

async function rows(): Promise<Array<{ id: number; name: string; parent: number }>> {
    const list = await dbAsync.all(
        `SELECT t.term_id AS id, t.name AS name, tt.parent AS parent FROM terms t
         JOIN term_taxonomy tt ON t.term_id = tt.term_id
         WHERE tt.taxonomy = ? ORDER BY t.name ASC LIMIT ${MAX_FOLDERS}`,
        [MEDIA_FOLDER_TAXONOMY],
    );
    return list.map((r: any) => ({ id: Number(r.id), name: String(r.name), parent: Number(r.parent) || 0 }));
}

async function exists(id: number): Promise<boolean> {
    if (!id) return true;
    return !!(await Term.findById(id, MEDIA_FOLDER_TAXONOMY));
}

/**
 * Every folder with how many files the caller may see in it (their own private items, every public one;
 * any private one with edit_others_posts), plus how many of those are in no folder.
 */
async function listFolders(viewer: { id: number; canSeeAllPrivate: boolean }): Promise<{ folders: MediaFolder[]; unfiled: number; total: number }> {
    const folders = await rows();
    const privacy = viewer.canSeeAllPrivate ? '' : ' AND (p.post_status <> \'private\' OR p.author_id = ?)';
    const privacyParams = viewer.canSeeAllPrivate ? [] : [viewer.id];
    const counts = await dbAsync.all(
        `SELECT pm.meta_value AS folder, COUNT(*) AS n FROM post_meta pm
         JOIN posts p ON p.id = pm.post_id
         WHERE pm.meta_key = ? AND p.post_type = 'attachment' AND p.post_status <> 'trash'${privacy}
         GROUP BY pm.meta_value`,
        [MEDIA_FOLDER_META_KEY, ...privacyParams],
    );
    const byFolder = new Map<string, number>(counts.map((c: any) => [String(c.folder), Number(c.n) || 0]));
    const totalRow = await dbAsync.get(
        `SELECT COUNT(*) AS n FROM posts p WHERE p.post_type = 'attachment' AND p.post_status <> 'trash'${privacy}`,
        privacyParams,
    );
    const total = Number(totalRow && totalRow.n) || 0;
    // «In no folder» is «has no folder meta», the same rule the list filter applies (Post.buildWhere).
    let filed = 0;
    for (const n of byFolder.values()) filed += n;
    return {
        folders: folders.map((f) => ({ ...f, count: byFolder.get(String(f.id)) || 0 })),
        unfiled: Math.max(0, total - filed),
        total,
    };
}

/** The folder and every folder below it. */
async function subtree(id: number): Promise<Set<number>> {
    const all = await rows();
    const out = new Set<number>([id]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const f of all) if (!out.has(f.id) && out.has(f.parent)) { out.add(f.id); grew = true; }
    }
    return out;
}

async function siblingNameTaken(name: string, parent: number, exceptId = 0): Promise<boolean> {
    const lower = name.toLowerCase();
    return (await rows()).some((f) => f.parent === parent && f.id !== exceptId && f.name.toLowerCase() === lower);
}

async function createFolder(rawName: unknown, rawParent: unknown): Promise<MediaFolder> {
    const name = cleanName(rawName);
    if (!name || name.length > MAX_FOLDER_NAME) throw new MediaFolderError(400, 'rest_invalid_param', `A folder name is text of 1 to ${MAX_FOLDER_NAME} characters.`);
    const parent = folderIdParam(rawParent);
    if (parent === null || !(await exists(parent))) throw new MediaFolderError(400, 'rest_media_folder_invalid', 'The parent folder does not exist.');
    if ((await rows()).length >= MAX_FOLDERS) throw new MediaFolderError(400, 'rest_media_folder_limit', `A library holds at most ${MAX_FOLDERS} folders.`);
    if (await siblingNameTaken(name, parent)) throw new MediaFolderError(409, 'rest_media_folder_exists', 'A folder with that name is already there.');
    const term = await Term.create({ taxonomy: MEDIA_FOLDER_TAXONOMY, name, parent });
    return { id: Number(term.termId), name: String(term.name), parent: Number(term.parent) || 0, count: 0 };
}

/** Rename and/or move a folder under another one (never under itself or below itself). */
async function updateFolder(id: number, data: { name?: unknown; parent?: unknown }): Promise<MediaFolder> {
    const term = await Term.findById(id, MEDIA_FOLDER_TAXONOMY);
    if (!term) throw new MediaFolderError(404, 'rest_media_folder_not_found', 'No such folder.');
    let parent = Number(term.parent) || 0;
    if (data.parent !== undefined) {
        const next = folderIdParam(data.parent);
        if (next === null || !(await exists(next))) throw new MediaFolderError(400, 'rest_media_folder_invalid', 'The parent folder does not exist.');
        if ((await subtree(id)).has(next)) throw new MediaFolderError(400, 'rest_media_folder_cycle', 'A folder cannot go inside itself or one of its own folders.');
        parent = next;
    }
    let name = String(term.name);
    if (data.name !== undefined) {
        name = cleanName(data.name);
        if (!name || name.length > MAX_FOLDER_NAME) throw new MediaFolderError(400, 'rest_invalid_param', `A folder name is text of 1 to ${MAX_FOLDER_NAME} characters.`);
    }
    if (await siblingNameTaken(name, parent, id)) throw new MediaFolderError(409, 'rest_media_folder_exists', 'A folder with that name is already there.');
    const updated = await Term.update(id, MEDIA_FOLDER_TAXONOMY, { name, parent });
    return { id, name: String(updated.name), parent: Number(updated.parent) || 0, count: 0 };
}

/** The ids of the files in a folder (any status but trash). */
async function filesIn(id: number): Promise<number[]> {
    const list = await dbAsync.all(
        `SELECT pm.post_id AS id FROM post_meta pm JOIN posts p ON p.id = pm.post_id
         WHERE pm.meta_key = ? AND pm.meta_value = ? AND p.post_type = 'attachment'`,
        [MEDIA_FOLDER_META_KEY, String(id)],
    );
    return list.map((r: any) => Number(r.id));
}

/** Put a file in a folder (0 = in no folder). The file itself is not touched. */
async function setFolder(mediaId: number, folder: number): Promise<void> {
    const Post = require('../models/Post');
    if (folder) await Post.updateMeta(mediaId, MEDIA_FOLDER_META_KEY, String(folder));
    else await Post.deleteMeta(mediaId, MEDIA_FOLDER_META_KEY);
}

/**
 * Delete a folder. What it holds — its files and its subfolders — goes to `moveTo` first (another folder,
 * or 0 for «no folder»), which may not be the folder itself or one below it. Returns how much moved.
 */
async function deleteFolder(id: number, rawMoveTo: unknown): Promise<{ movedFiles: number; movedFolders: number; moveTo: number }> {
    const term = await Term.findById(id, MEDIA_FOLDER_TAXONOMY);
    if (!term) throw new MediaFolderError(404, 'rest_media_folder_not_found', 'No such folder.');
    const moveTo = rawMoveTo === undefined ? (Number(term.parent) || 0) : folderIdParam(rawMoveTo);
    if (moveTo === null || !(await exists(moveTo))) throw new MediaFolderError(400, 'rest_media_folder_invalid', 'The folder to move the contents into does not exist.');
    if (moveTo && (await subtree(id)).has(moveTo)) throw new MediaFolderError(400, 'rest_media_folder_cycle', 'The contents cannot go into the folder being deleted or one of its own folders.');
    return await dbAsync.transaction(async () => {
        const files = await filesIn(id);
        for (const fileId of files) await setFolder(fileId, moveTo);
        const children = (await rows()).filter((f) => f.parent === id);
        for (const child of children) {
            // A subfolder whose name is already taken where it lands keeps its place by a suffix.
            let name = child.name;
            for (let n = 2; await siblingNameTaken(name, moveTo, child.id); n++) name = `${child.name} (${n})`.slice(0, MAX_FOLDER_NAME);
            await Term.update(child.id, MEDIA_FOLDER_TAXONOMY, { name, parent: moveTo });
        }
        await Term.delete(id, MEDIA_FOLDER_TAXONOMY);
        return { movedFiles: files.length, movedFolders: children.length, moveTo };
    });
}

module.exports = {
    MEDIA_FOLDER_TAXONOMY, MEDIA_FOLDER_META_KEY, MAX_FOLDER_NAME, MediaFolderError,
    folderIdParam, exists, listFolders, createFolder, updateFolder, deleteFolder, setFolder, filesIn, subtree,
};
