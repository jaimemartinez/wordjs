"use client";

import { Fragment } from "react";

/**
 * An identifier shown in the plugin screens — a role slug (`conference_manager_team`), a permission token
 * (`roles:declare`), a capability, a plugin slug — that wraps only BETWEEN its parts.
 *
 * They were `break-all`: on a phone the browser broke them at any letter, «conference_manage|r_team»,
 * «conferenc|e_manager_team», «conference_manager_acce|ss». Now:
 *   - TOKEN_WRAP_CLASS keeps the identifier whole on its own line when it fits there (an inline-block moves
 *     to the next line as one piece instead of starting at the end of a line);
 *   - only when it is longer than the whole line does it wrap, and then after a `_`, `:`, `.`, `/` or `,`
 *     (a <wbr> after each), the last resort `overflow-wrap: break-word` only for a part longer than a line.
 */
export const TOKEN_WRAP_CLASS = "inline-block max-w-full break-words";

/** The pieces of `token`, each ending at a separator it can wrap after. */
export function tokenParts(token: string): string[] {
    // A match per piece, not a lookbehind split: an older iOS Safari rejects lookbehind at parse time.
    return String(token).match(/[^_:./,]*[_:./,]|[^_:./,]+/g) ?? [];
}

export default function BreakableToken({ text }: { text: string }) {
    const parts = tokenParts(text);
    return (
        <>
            {parts.map((part, i) => (
                <Fragment key={i}>{part}{i < parts.length - 1 && <wbr />}</Fragment>
            ))}
        </>
    );
}
