"use client";

/**
 * Deleting an account, said plainly.
 *
 * The old confirmation read "Are you sure you want to delete this user?" — it did not say WHO, nor what
 * happens to what they wrote: their entries stayed, credited to an account that no longer exists (the
 * byline went blank and their author archive 404'd). This dialog names the account, counts its entries
 * and lets the administrator attribute them to another user (DELETE /users/:id?reassign=), which is the
 * default; "keep them unattributed" stays possible. Nothing is deleted besides the account itself.
 */
import { useEffect, useId, useRef, useState } from "react";
import DialogLayer from "@/components/DialogLayer";
import { apiGetPaged, usersApi, type User } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { runEach } from "@/lib/bulkRun";

interface DeleteUserDialogProps {
    /** One account, or several (the bulk action on the users list). */
    user?: User;
    users?: User[];
    /** The signed-in administrator — the default recipient of the content. */
    currentUserId?: number;
    onClose: () => void;
    onDeleted: () => void;
}

/** Entries of every status the user authored, of the two core types the admin lists. */
async function countAuthoredEntries(userId: number): Promise<number> {
    const totals = await Promise.all(["post", "page"].map((type) =>
        apiGetPaged<unknown[]>(`/posts?type=${type}&status=any&author=${userId}&per_page=1`).then((r) => r.total).catch(() => 0),
    ));
    return totals.reduce((a, b) => a + b, 0);
}

export default function DeleteUserDialog({ user: single, users: many, currentUserId, onClose, onDeleted }: DeleteUserDialogProps) {
    const targets = many && many.length ? many : (single ? [single] : []);
    const user = targets[0];
    const bulk = targets.length > 1;
    const targetKey = targets.map((u) => u.id).join(",");
    const { t } = useI18n();
    const titleId = useId();
    const cancelRef = useRef<HTMLButtonElement>(null);
    const [entries, setEntries] = useState<number | null>(null);
    const [candidates, setCandidates] = useState<User[]>([]);
    const [reassignTo, setReassignTo] = useState<string>(currentUserId ? String(currentUserId) : "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        const ids = new Set(targetKey.split(",").map(Number));
        Promise.all([...ids].map((id) => countAuthoredEntries(id)))
            .then((counts) => { if (!cancelled) setEntries(counts.reduce((a, b) => a + b, 0)); });
        // Team accounts (anyone but subscribers) can carry a byline; the first page is enough to choose from.
        usersApi.listPaged({ excludeRole: "subscriber", perPage: 100 })
            .then((r) => { if (!cancelled) setCandidates(r.data.filter((u) => !ids.has(u.id))); })
            .catch(() => { /* the "keep unattributed" choice still works */ });
        return () => { cancelled = true; };
    }, [targetKey]);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) { e.preventDefault(); onClose(); } };
        document.addEventListener("keydown", onKeyDown);
        const focus = setTimeout(() => cancelRef.current?.focus(), 20);
        return () => { document.removeEventListener("keydown", onKeyDown); clearTimeout(focus); };
    }, [busy, onClose]);

    if (!user) return null;
    const name = bulk ? t("users.bulk.count").replace("{n}", String(targets.length)) : (user.displayName || user.username);
    const confirm = async () => {
        setBusy(true);
        setError("");
        const reassign = entries ? (reassignTo ? Number(reassignTo) : undefined) : undefined;
        const result = await runEach(targets.map((u) => u.id), (id) => usersApi.delete(id, reassign));
        if (result.done.length) onDeleted();
        if (!result.failed.length) { onClose(); return; }
        setError(bulk
            ? `${t("users.bulk.deleteFailed").replace("{n}", String(result.failed.length))} ${result.failed[0].reason}`
            : (result.failed[0].reason || t("users.delete.failed")));
        setBusy(false);
    };

    return (
        <DialogLayer layer="dialogOver" data-wjs-host-ui="" className="flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => { if (!busy) onClose(); }}>
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="delete-user-dialog"
                className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
                <div className="p-6 space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center bg-red-100 text-red-600">
                            <i className="fa-solid fa-triangle-exclamation text-lg" aria-hidden="true"></i>
                        </div>
                        <h3 id={titleId} className="text-xl font-bold text-gray-900 break-words">{t("users.delete.titleNamed").replace("{name}", name)}</h3>
                    </div>
                    {bulk ? (
                        <p className="text-gray-600 leading-relaxed break-words">
                            {t("users.bulk.deleteBody")} {targets.slice(0, 8).map((u) => u.displayName || u.username).join(", ")}{targets.length > 8 ? "…" : ""}
                        </p>
                    ) : (
                        <p className="text-gray-600 leading-relaxed break-words">
                            {t("users.delete.body").replace("{name}", name).replace("{login}", user.username)}
                        </p>
                    )}
                    {entries === null ? (
                        <p className="text-sm text-gray-400">{t("loading")}</p>
                    ) : entries > 0 ? (
                        <div className="space-y-2">
                            <label htmlFor={`${titleId}-reassign`} className="block text-sm font-semibold text-gray-700">
                                {t("users.delete.content").replace("{n}", String(entries))}
                            </label>
                            <select id={`${titleId}-reassign`} value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}
                                className="w-full min-h-11 px-3 rounded-lg border border-gray-300 bg-white text-sm">
                                {candidates.map((c) => (
                                    <option key={c.id} value={String(c.id)}>{t("users.delete.attributeTo").replace("{name}", c.displayName || c.username)}</option>
                                ))}
                                <option value="">{t("users.delete.keepUnattributed")}</option>
                            </select>
                        </div>
                    ) : (
                        <p className="text-sm text-gray-500">{t("users.delete.noContent")}</p>
                    )}
                    {error && <p role="alert" className="text-sm text-red-600 break-words">{error}</p>}
                    <div className="flex justify-end gap-3 pt-2">
                        <button ref={cancelRef} type="button" onClick={onClose} disabled={busy}
                            className="min-h-11 px-5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50">
                            {t("dialog.cancel")}
                        </button>
                        <button type="button" onClick={confirm} disabled={busy || entries === null}
                            className="min-h-11 px-5 rounded-lg text-white font-medium bg-red-600 hover:bg-red-700 disabled:opacity-50">
                            {t("users.delete.confirmNamed")}
                        </button>
                    </div>
                </div>
            </div>
        </DialogLayer>
    );
}
