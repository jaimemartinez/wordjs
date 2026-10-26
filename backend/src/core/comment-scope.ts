/**
 * WordJS - Comment moderation scope
 *
 * WHICH COMMENTS A MODERATOR MAY MODERATE. `moderate_comments` / `edit_comments` say that a role
 * moderates; the ENTRY a comment sits on says where. A comment is part of that entry — WordPress maps
 * edit_comment onto edit_post of the parent — so moderating it (reading it with the commenter's email
 * and IP, editing, approving, holding, marking spam, trashing or deleting it) takes the edit gate of the
 * parent entry (core/post-capabilities canEditPostRecord: type family, ownership, published bar). Without
 * it a role holding the comment capabilities read and moderated the discussion of entries it cannot even
 * read: private, password-protected, members-only or of a type it has no capability for.
 *
 * The trash does not change who moderates: a trashed entry is judged by the status it had before
 * (withPreTrashStatus), so an editor can still clear spam from it. A comment whose entry no longer
 * exists hides nothing and stays with whoever holds the capability.
 *
 * Two forms of ONE rule: canModerateCommentOn for a loaded entry, and moderatableCommentCondition — the
 * SQL the comment list and its totals filter with, derived by evaluating the same function for every
 * combination of the facts it depends on (core/attachment-visibility decisionToSql), so the two cannot
 * disagree.
 */

const {
    canEditPostRecord, withPreTrashStatus, isInternalPostType, builtinPostTypeNames,
    withTypePolicyMemo, PUBLISHED_FAMILY_STATUSES,
} = require('./post-capabilities');
const {
    attachmentReadable, attachmentReferenceCondition, decisionToSql,
} = require('./attachment-visibility');

interface SqlFragment { sql: string; params: any[] }

/** May `user` moderate the comments of this entry (loaded Post, or null when it no longer exists)? */
async function canModerateCommentOn(user: any, post: any): Promise<boolean> {
    if (!user || typeof user.can !== 'function') return false;
    if (!post) return true;
    if (isInternalPostType(post.type || post.postType || 'post')) return false;
    if (!canEditPostRecord(user, await withPreTrashStatus(post))) return false;
    return attachmentReadable(user, post);
}

/** Some type name no registry can hold — the probe for "a type nobody registered". */
const UNKNOWN_TYPE_PROBE = '\u0000unregistered';

function exactText(expr: string): string {
    return require('./sql-exact-text').exactTextExpr(expr);
}

/**
 * THE LIST FORM: a WHERE condition over a listing of comments, true exactly for the comments whose entry
 * (named by `postIdExpr`, the listing's own column, never a request value) `user` may moderate.
 */
function moderatableCommentCondition(user: any, postIdExpr: string): SqlFragment {
    const uid = user.id;
    const otherId = uid === -1 ? -2 : -1;
    const published = Array.from(PUBLISHED_FAMILY_STATUSES as Set<string>);
    const status = exactText(`COALESCE(mp.post_status, '')`);
    // The status the entry had before the trash, as withPreTrashStatus reads it: the stored value, or
    // 'publish' when it is missing, empty or itself 'trash'.
    const trashMeta = exactText(`COALESCE((SELECT MIN(mpm.meta_value) FROM post_meta mpm WHERE mpm.post_id = mp.id AND mpm.meta_key = '_wp_trash_meta_status'), '')`);
    const marks = published.map(() => '?').join(', ');
    const publishedSql: SqlFragment = {
        sql: `(${status} IN (${marks}) OR (${status} = ? AND (${trashMeta} IN (${marks}) OR ${trashMeta} = ? OR ${trashMeta} = ?)))`,
        params: [...published, 'trash', ...published, '', 'trash'],
    };
    const dims: SqlFragment[][] = [
        [publishedSql, { sql: `NOT ${publishedSql.sql}`, params: [...publishedSql.params] }],
        [
            { sql: `COALESCE(mp.author_id, 0) = ?`, params: [uid] },
            { sql: `COALESCE(mp.author_id, 0) <> ?`, params: [uid] },
        ],
    ];
    const forType = (type: string) => decisionToSql(dims, (c: number[]) => !isInternalPostType(type) && canEditPostRecord(user, {
        type, postType: type,
        postStatus: c[0] === 0 ? 'publish' : 'draft',
        authorId: c[1] === 0 ? uid : otherId,
    }));

    const { getPostTypes } = require('./post-types');
    const named = [...new Set<string>([
        ...getPostTypes().map((t: any) => String(t && t.name)),
        ...builtinPostTypeNames(),
        'nav_menu_item', 'revision', '',
    ])];
    const typeExpr = exactText(`COALESCE(mp.post_type, '')`);
    const terms: SqlFragment[] = [];
    withTypePolicyMemo(() => {
        const groups = new Map<string, { names: string[]; unknown: boolean; sql: SqlFragment }>();
        const add = (name: string | null) => {
            const sql = forType(name === null ? UNKNOWN_TYPE_PROBE : name);
            const key = `${sql.sql}\u0001${JSON.stringify(sql.params)}`;
            const group: { names: string[]; unknown: boolean; sql: SqlFragment } = groups.get(key) || { names: [], unknown: false, sql };
            if (name === null) group.unknown = true;
            else group.names.push(name);
            groups.set(key, group);
        };
        for (const name of named) add(name);
        add(null);
        for (const group of groups.values()) {
            if (group.sql.sql === '1 = 0') continue;
            let typeSql: SqlFragment | null;
            if (group.unknown) {
                const others = named.filter((n) => !group.names.includes(n));
                typeSql = others.length ? { sql: `${typeExpr} NOT IN (${others.map(() => '?').join(', ')})`, params: others } : null;
            } else {
                typeSql = { sql: `${typeExpr} IN (${group.names.map(() => '?').join(', ')})`, params: group.names };
            }
            const parts = [typeSql, group.sql.sql === '1 = 1' ? null : group.sql].filter(Boolean) as SqlFragment[];
            terms.push(parts.length
                ? { sql: parts.map((p) => `(${p.sql})`).join(' AND '), params: parts.flatMap((p) => p.params) }
                : { sql: '1 = 1', params: [] });
        }
    });
    const entrySql: SqlFragment = terms.length
        ? { sql: terms.map((t) => `(${t.sql})`).join(' OR '), params: terms.flatMap((t) => t.params) }
        : { sql: '1 = 0', params: [] };

    // An attachment's comments also follow the attachment rule (its entry included), as on every read.
    const attachment = attachmentReferenceCondition(user, postIdExpr);
    return {
        sql: `(NOT EXISTS (SELECT 1 FROM posts mp WHERE mp.id = ${postIdExpr})`
            + ` OR EXISTS (SELECT 1 FROM posts mp WHERE mp.id = ${postIdExpr} AND (${entrySql.sql})))`
            + ` AND (${attachment.sql})`,
        params: [...entrySql.params, ...attachment.params],
    };
}

module.exports = { canModerateCommentOn, moderatableCommentCondition };
