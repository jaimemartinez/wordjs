"use client";

import { useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import { postsApi } from "@/lib/api";
import { Button } from "@/components/ui";

/**
 * Shown INSTEAD of the editor when the entry is in the trash. The server refuses every write to a
 * trashed entry (409 rest_post_trashed) until it is restored, so opening the editor would only lead to
 * a save that fails; this screen says why and offers the one way out: Restore, which puts back the
 * status the entry had before the trash (applying the publish gate), and then the editor loads normally.
 */
export default function EditorTrashedNotice({ postId, onRestored, onBack }: {
    postId: number;
    onRestored: () => void;
    onBack: () => void;
}) {
    const { language } = useI18n();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const restore = async () => {
        setBusy(true);
        setError(null);
        try {
            await postsApi.restore(postId);
            onRestored();
        } catch (e: any) {
            setError(e?.message || trStr("No se pudo restaurar el contenido.", language));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="min-h-screen h-full w-full flex items-center justify-center bg-gray-50 p-6" data-testid="editor-trashed-notice">
            <div className="max-w-md w-full text-center bg-white rounded-2xl border border-gray-200 shadow-xl p-8">
                <div className="w-16 h-16 shrink-0 mx-auto rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mb-4">
                    <i className="fa-solid fa-trash-can text-2xl"></i>
                </div>
                <h3 className="text-lg font-bold text-gray-800 mb-1">
                    {trStr("Este contenido está en la papelera", language)}
                </h3>
                <p className="text-sm text-gray-500 mb-6">
                    {trStr("Restáuralo para poder editarlo. Volverá al estado que tenía antes de enviarlo a la papelera.", language)}
                </p>
                {error && (
                    <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>
                )}
                <div className="flex justify-center gap-2">
                    <Button size="md" icon="fa-trash-arrow-up" onClick={restore} disabled={busy}>
                        {trStr("Restaurar", language)}
                    </Button>
                    <Button size="md" variant="secondary" onClick={onBack} disabled={busy}>
                        {trStr("Volver", language)}
                    </Button>
                </div>
            </div>
        </div>
    );
}
