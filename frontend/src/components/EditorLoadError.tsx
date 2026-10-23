"use client";

import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import { Button } from "@/components/ui";

/**
 * Blocking error state shown when an existing post/page FAILS to load. It replaces the editor entirely
 * so the user can never edit — and thus never overwrite — an empty stand-in of a record whose real
 * content couldn't be fetched. Offers Retry (re-run the load) and Back.
 */
export default function EditorLoadError({ onRetry, onBack }: { onRetry: () => void; onBack: () => void }) {
    const { language } = useI18n();
    return (
        <div className="h-full w-full flex items-center justify-center bg-gray-50 p-6">
            <div className="max-w-md w-full text-center bg-white rounded-2xl border border-gray-200 shadow-xl p-8">
                <div className="w-16 h-16 shrink-0 mx-auto rounded-2xl bg-red-50 text-red-500 flex items-center justify-center mb-4">
                    <i className="fa-solid fa-triangle-exclamation text-2xl"></i>
                </div>
                <h3 className="text-lg font-bold text-gray-800 mb-1">
                    {trStr("No se pudo cargar el contenido", language)}
                </h3>
                <p className="text-sm text-gray-500 mb-6">
                    {trStr(
                        "No pudimos cargar esta publicación. Para no sobrescribir su contenido, el editor no se abrirá. Reintenta cuando tengas conexión.",
                        language
                    )}
                </p>
                <div className="flex justify-center gap-2">
                    <Button size="md" icon="fa-rotate-right" onClick={onRetry}>
                        {trStr("Reintentar", language)}
                    </Button>
                    <Button size="md" variant="secondary" onClick={onBack}>
                        {trStr("Volver", language)}
                    </Button>
                </div>
            </div>
        </div>
    );
}
