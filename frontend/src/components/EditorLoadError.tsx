"use client";

import React from "react";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";

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
                <div className="w-16 h-16 mx-auto rounded-2xl bg-red-50 text-red-500 flex items-center justify-center mb-4">
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
                    <button
                        type="button"
                        onClick={onRetry}
                        className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold transition-colors flex items-center gap-2"
                    >
                        <i className="fa-solid fa-rotate-right text-xs"></i>
                        {trStr("Reintentar", language)}
                    </button>
                    <button
                        type="button"
                        onClick={onBack}
                        className="px-5 py-2.5 rounded-xl border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-semibold transition-colors"
                    >
                        {trStr("Volver", language)}
                    </button>
                </div>
            </div>
        </div>
    );
}
