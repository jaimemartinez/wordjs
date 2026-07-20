"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

/**
 * One-time secret reveal. Shows a generated secret (API token / webhook signing secret) exactly once,
 * with a copy button and a clear "won't be shown again" warning. Rendered only when `secret` is set.
 */
export default function SecretRevealModal({
    secret,
    title,
    description,
    onClose,
}: {
    secret: string | null;
    title: string;
    description?: string;
    onClose: () => void;
}) {
    const [copied, setCopied] = useState(false);
    if (!secret) return null;

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard blocked — the user can still select the text manually */
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full p-8 animate-in zoom-in-95 duration-200">
                <div className="flex items-center gap-4 mb-6">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 flex items-center justify-center text-amber-600">
                        <i className="fa-solid fa-key text-lg"></i>
                    </div>
                    <div>
                        <h2 className="text-xl font-black italic tracking-tighter text-gray-800">{title}</h2>
                        <p className="text-xs font-bold uppercase tracking-widest text-amber-600">Shown only once</p>
                    </div>
                </div>

                {description && <p className="text-sm text-gray-500 mb-4 leading-relaxed">{description}</p>}

                <div className="relative">
                    <code className="block w-full break-all bg-gray-900 text-emerald-300 rounded-2xl px-5 py-4 pr-14 font-mono text-sm select-all">
                        {secret}
                    </code>
                    <button
                        onClick={copy}
                        title="Copy to clipboard"
                        className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl bg-white/10 text-white hover:bg-white/20 flex items-center justify-center transition-all"
                    >
                        <i className={`fa-solid ${copied ? "fa-check text-emerald-400" : "fa-copy"} text-sm`}></i>
                    </button>
                </div>

                <div className="mt-4 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded-xl px-4 py-3">
                    <i className="fa-solid fa-triangle-exclamation mt-0.5"></i>
                    <span>Store this now — for your security it cannot be retrieved again. If you lose it, revoke and create a new one.</span>
                </div>

                <div className="mt-6 flex justify-end gap-3">
                    <Button variant="secondary" onClick={copy} icon={copied ? "fa-check" : "fa-copy"}>
                        {copied ? "Copied" : "Copy"}
                    </Button>
                    <Button variant="primary" onClick={onClose} icon="fa-check">
                        Done
                    </Button>
                </div>
            </div>
        </div>
    );
}
