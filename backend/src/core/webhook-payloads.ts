/**
 * WordJS - outgoing webhook payload serializers, one per entity.
 *
 * A webhook body leaves the site, so it is built by ALLOWLIST: every function below copies named, known
 * fields onto a fresh object and nothing else. None of them spreads a row, a model instance or a toJSON()
 * result, because those carry whatever the next column or meta key happens to be — a password hash, an
 * MFA seed, a session epoch, a token. A field reaches a receiver only once someone has written it here.
 *
 * What is deliberately never sent, whatever the entity: password hashes and passwords, MFA secrets and
 * backup codes, API/session tokens, signing secrets, user email addresses and commenter email / IP / user
 * agent (personal data a receiver does not need to react to an event), secret-named or protected option
 * names and every option VALUE, and private-media download URLs. The test suite pins this
 * (tests/webhook-events.test.ts, "payload redaction").
 */

/** A bounded string, or null. Keeps a hostile title or name from inflating every queued delivery. */
function str(v: any, max = 500): string | null {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s.length > max ? s.slice(0, max) : s;
}

function int(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Posts and pages (and any custom post type): metadata only — never the body or the post password. */
function postPayload(post: any) {
    return {
        id: post.id,
        type: post.postType,
        status: post.postStatus,
        title: post.postTitle,
        slug: post.postName,
        author: post.authorId,
        date: post.postDate,
        modified: post.postModified
    };
}

// Deliberately EXCLUDES author email + IP (PII) — a webhook payload should not leak commenter contact data.
// The model's id field is `commentId` (`c.id` was always undefined, so the id used to be missing).
function commentPayload(c: any) {
    return {
        id: c.commentId != null ? c.commentId : c.id,
        postId: c.commentPostId,
        author: c.commentAuthor,
        content: c.commentContent,
        approved: c.commentApproved,
        userId: c.userId,
        parent: c.commentParent != null ? c.commentParent : 0,
        date: c.commentDate != null ? String(c.commentDate) : null
    };
}

/** A user account: identity and role. Never the email, the password hash, or any user meta. */
function userPayload(u: any) {
    return {
        id: int(u.id),
        username: str(u.userLogin, 200),
        displayName: str(u.displayName, 200),
        slug: str(u.userNicename, 200),
        role: typeof u.getRole === 'function' ? u.getRole() : str(u.role, 100),
        registered: u.userRegistered != null ? String(u.userRegistered) : null
    };
}

/** A media-library item (the shape Media.findById returns). A private item's URL is never sent. */
function mediaPayload(m: any) {
    const isPrivate = m.visibility === 'private';
    const details = m.mediaDetails || {};
    return {
        id: int(m.id),
        title: str(m.title),
        mimeType: str(m.mimeType, 200),
        visibility: isPrivate ? 'private' : 'public',
        url: isPrivate ? null : str(m.guid, 2000),
        alt: str(m.alt),
        caption: str(m.caption, 2000),
        author: int(m.author),
        parent: int(m.parent) || 0,
        width: int(details.width) || 0,
        height: int(details.height) || 0,
        filesize: int(details.filesize) || 0,
        date: m.date != null ? String(m.date) : null,
        modified: m.modified != null ? String(m.modified) : null
    };
}

/** A taxonomy term (category, tag). */
function termPayload(t: any) {
    return {
        id: int(t.termId != null ? t.termId : t.id),
        name: str(t.name, 200),
        slug: str(t.slug, 200),
        taxonomy: str(t.taxonomy, 64),
        parent: int(t.parent) || 0,
        description: str(t.description, 2000)
    };
}

/** A navigation menu plus what changed in it (`change` and, for item changes, `itemId`). */
function menuPayload(menu: any, detail: any = {}) {
    return {
        id: int(menu && menu.id),
        name: str(menu && menu.name, 200),
        slug: str(menu && menu.slug, 200),
        change: str(detail.change, 32),
        location: detail.location != null ? str(detail.location, 64) : undefined,
        itemId: detail.itemId != null ? int(detail.itemId) : undefined
    };
}

/** A plugin lifecycle change. Only the slug plus, for a marketplace install, its catalogue version. */
function pluginPayload(slug: any, extra: { version?: any; source?: any; via?: any } = {}) {
    const out: Record<string, any> = { slug: str(slug, 200) };
    if (extra.via != null) out.via = str(extra.via, 32);
    if (extra.source != null) out.source = str(extra.source, 200);
    if (extra.version != null) out.version = str(extra.version, 64);
    return out;
}

function themePayload(slug: any, previous: any) {
    return { slug: str(slug, 200), previous: previous == null ? null : str(previous, 200) };
}

// Option names whose existence alone says something about stored secrets. Mirrors the option layer's
// secret-name rule; a matching name is dropped from the list (its value is never sent in any case).
const SECRET_OPTION_NAME_RE = /secret|passw|priv[_-]?key|privatekey|\bkey\b|[_-]key\b|token|jwt|credential|encryption|dkim|\bsalt\b|api[_-]?key|signing|certificate|hash/i;

/** Which settings a save wrote — key NAMES only, never values, never secret-named or protected keys. */
function settingsPayload(keys: any) {
    let isProtected: (k: string) => boolean = () => false;
    try { const api = require('./plugin-api'); isProtected = (k) => api.isProtectedOption(k) === true; } catch { /* */ }
    const list = Array.isArray(keys) ? keys : [];
    return {
        keys: list.map((k) => String(k)).filter((k) => !SECRET_OPTION_NAME_RE.test(k) && !isProtected(k)).slice(0, 100)
    };
}

module.exports = {
    postPayload,
    commentPayload,
    userPayload,
    mediaPayload,
    termPayload,
    menuPayload,
    pluginPayload,
    themePayload,
    settingsPayload
};
