/**
 * The character an avatar bubble shows for a name: its first LETTER or DIGIT, upper-cased. A display
 * name like "[X2] sub" showed "[". Falls back to the second candidate (the login), then to "?".
 */
export function avatarInitial(...candidates: Array<string | null | undefined>): string {
    for (const c of candidates) {
        const m = String(c ?? "").match(/[\p{L}\p{N}]/u);
        if (m) return m[0].toLocaleUpperCase();
    }
    return "?";
}
