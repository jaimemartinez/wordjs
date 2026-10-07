/**
 * The teaser a post card shows on the public home, archive and search pages — always PLAIN TEXT.
 *
 * One function for the three surfaces, so the password-protected notice and the tag stripping cannot
 * drift apart between them (they were three copies of the same inline expression).
 */

/** What a card shows for a password-protected entry whose content the reader may not see. */
export const PROTECTED_EXCERPT = "This content is password protected.";

/**
 * Remove every tag, repeating until nothing changes. A single pass over `<scr<script>ipt>` removes the
 * inner tag and splices a new one together; each pass here removes at least one `<`, so the loop is
 * bounded by the input length. The card renders the result as React TEXT, so this is about what the
 * reader sees, not the only line of defence.
 */
export function stripTags(html: string): string {
    let text = html;
    let previous: string;
    do {
        previous = text;
        text = text.replace(/<[^<>]*>?/g, "");
    } while (text !== previous);
    return text;
}

type CardPost = { protected?: boolean; excerpt?: string | null; content?: string | null };

/** The card teaser: the protected notice, else the stored excerpt, else the first `max` characters of content as text. */
export function postCardExcerpt(post: CardPost, max = 200): string {
    if (post.protected && !post.content) return PROTECTED_EXCERPT;
    if (post.excerpt) return post.excerpt;
    return `${stripTags(String(post.content || "").substring(0, max))}...`;
}
