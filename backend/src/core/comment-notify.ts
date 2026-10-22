/**
 * WordJS - Comment notifications by email (WordPress parity: wp_notify_postauthor / wp_notify_moderator)
 *
 * Settings → Discussion has always stored `comments_notify` ("email me whenever anyone posts a comment")
 * and `moderation_notify` ("email me whenever a comment is held for moderation"), both on by default,
 * but nothing read them: no comment ever produced an email. This module is the reader.
 *
 *   · A comment HELD for moderation (pending) → the site's administration address (`admin_email`),
 *     when `moderation_notify` is on.
 *   · An APPROVED comment → the author of the entry, when `comments_notify` is on — unless the author
 *     wrote it themself.
 *   · Spam and trash produce nothing.
 *
 * It listens on the `wp_insert_comment` action (the same hook the outgoing webhooks use), so the comment
 * routes are untouched, and it sends through whatever mail PROVIDER plugin the site has (core/mail-provider).
 * With no provider it does nothing. It never throws into the comment save, and the send is not awaited.
 *
 * Privacy: the message names the entry and the commenter's display name, quotes a plain-text excerpt
 * (escaped) and links to the moderation screen on the site's main address. It never carries the
 * commenter's email or IP — the moderation screen shows those to whoever may see them.
 */
const { addAction, removeAction } = require('./hooks');
const { getOption } = require('./options');
const { escHtml } = require('./formatting');
const log = require('./module-logger').moduleLogger('core/comment-notify');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** An option that is on: stored as 1/'1'/true; off as 0/'0'/''/false. (Options come back as numbers OR strings.) */
function isOn(v: any): boolean {
    if (v === undefined || v === null) return false;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    return s !== '' && s !== '0' && s !== 'false' && s !== 'off';
}

/** The comment's plain text, collapsed and capped — never its HTML. */
function excerptOf(content: any, max = 500): string {
    const text = String(content || '')
        .replace(/<[^>]*>/g, ' ')
        // Stored content is sanitized HTML: decode the references it holds back to plain text (the
        // html part escapes it again).
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

interface Notice { to: string; subject: string; text: string; html: string }

/**
 * What to send for a just-inserted comment: zero, one or two messages. Pure apart from its reads, so the
 * rules can be tested without a mail provider.
 */
async function noticesFor(commentId: number): Promise<Notice[]> {
    const Comment = require('../models/Comment');
    const comment = await Comment.findById(commentId);
    if (!comment) return [];
    const status = String(comment.commentApproved);
    if (status !== '0' && status !== '1') return []; // spam / trash: nothing to tell anyone
    if (String(comment.commentType || 'comment') !== 'comment') return []; // pingbacks etc. are not people

    const Post = require('../models/Post');
    const post = await Post.findById(comment.commentPostId);
    if (!post) return [];

    const siteName = String((await getOption('blogname', 'WordJS')) || 'WordJS');
    const title = String(post.postTitle || '').trim() || `#${post.id}`;
    const who = String(comment.commentAuthor || '').trim() || 'Someone';
    const excerpt = excerptOf(comment.commentContent);
    let base: string;
    try { base = String(await require('./site-address').linkBase()).replace(/\/+$/, ''); } catch { base = ''; }
    const reviewUrl = base ? `${base}/admin/comments` : '';

    const build = (subject: string, lead: string): Omit<Notice, 'to'> => {
        const text = [lead, excerpt ? `“${excerpt}”` : '', reviewUrl ? `Review it: ${reviewUrl}` : '']
            .filter(Boolean).join('\n\n');
        const html =
            `<p>${escHtml(lead)}</p>` +
            (excerpt ? `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #ccc;color:#333">${escHtml(excerpt)}</blockquote>` : '') +
            (reviewUrl ? `<p><a href="${escHtml(reviewUrl)}">Review it in the admin</a></p>` : '');
        return { subject, text, html };
    };

    const out: Notice[] = [];
    if (status === '0') {
        if (!isOn(await getOption('moderation_notify', 1))) return [];
        const to = String((await getOption('admin_email', '')) || '').trim();
        if (EMAIL_RE.test(to)) {
            out.push({ to, ...build(`[${siteName}] Please moderate: “${title}”`, `A new comment by ${who} on “${title}” is waiting for your approval.`) });
        }
        return out;
    }

    // Approved.
    if (!isOn(await getOption('comments_notify', 1))) return [];
    const User = require('../models/User');
    const author = post.authorId ? await User.findById(Number(post.authorId)) : null;
    const to = String((author && author.userEmail) || '').trim();
    if (!EMAIL_RE.test(to)) return [];
    const ownComment = (Number(comment.userId) > 0 && Number(comment.userId) === Number(post.authorId)) ||
        String(comment.commentAuthorEmail || '').trim().toLowerCase() === to.toLowerCase();
    if (ownComment) return [];
    out.push({ to, ...build(`[${siteName}] Comment: “${title}”`, `${who} commented on your entry “${title}”.`) });
    return out;
}

async function onCommentInsert(commentId: number): Promise<void> {
    try {
        const send = require('./mail-provider').sendMailFn();
        if (typeof send !== 'function') return; // no mail provider on this site
        const notices = await noticesFor(Number(commentId));
        for (const n of notices) {
            Promise.resolve(send(n)).catch((e: any) => log.warn({ err: e }, 'a comment notification was not sent'));
        }
    } catch (e: any) {
        try { log.warn({ err: e }, 'comment notification skipped'); } catch { /* */ }
    }
}

let registered = false;
function initCommentNotify(): void {
    if (registered) return;
    registered = true;
    addAction('wp_insert_comment', onCommentInsert);
}
function stopCommentNotify(): void {
    if (!registered) return;
    registered = false;
    removeAction('wp_insert_comment', onCommentInsert);
}

module.exports = { initCommentNotify, stopCommentNotify, noticesFor, onCommentInsert, isOn, excerptOf };
