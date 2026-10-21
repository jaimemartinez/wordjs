/**
 * "Failed to save …" plus the server's reason.
 *
 * Screens answered every refusal with their own generic line, hiding the one sentence that explained it
 * (for instance "Accounts … can only be changed from a session started at the main address", or "Password
 * must be at least 8 characters."). The API's `message` is written for people, so it is shown under the
 * generic line; a bare transport error ("HTTP 500", "Failed to fetch") adds nothing and is left out.
 */
export function withServerReason(fallback: string, error: unknown): string {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const reason = String(message || "").trim();
    if (!reason || /^HTTP \d{3}$/i.test(reason) || /^(failed to fetch|network error|load failed)$/i.test(reason) || reason === fallback) return fallback;
    return `${fallback}\n\n${reason}`;
}
