/**
 * Which moderation actions a comment row offers.
 *
 * The API serializes a comment's status as `pending` | `approved` | `spam` | `trash`
 * (backend models/Comment.getStatus), but the screen compared it with the STORED values `'0'`/`'1'`,
 * so Approve and Unapprove never appeared, pending rows were never highlighted and the Spam tab had no
 * action at all. `commentState` accepts both spellings, and the action list is derived from the
 * comment's own state rather than from the tab it happens to be shown in ("All" lists every state).
 */
export type CommentState = "pending" | "approved" | "spam" | "trash";

export function commentState(status: unknown): CommentState {
    const s = String(status ?? "").toLowerCase();
    if (s === "1" || s === "approved" || s === "approve") return "approved";
    if (s === "spam") return "spam";
    if (s === "trash") return "trash";
    return "pending"; // '0', 'hold', 'pending' and anything unknown wait for a moderator
}

export type CommentActionKey = "approve" | "unapprove" | "spam" | "trash" | "notSpam" | "restore" | "deletePermanently";

export function commentActions(status: unknown): CommentActionKey[] {
    switch (commentState(status)) {
        case "pending": return ["approve", "spam", "trash"];
        case "approved": return ["unapprove", "spam", "trash"];
        case "spam": return ["notSpam", "deletePermanently"];
        case "trash": return ["restore", "deletePermanently"];
    }
}
