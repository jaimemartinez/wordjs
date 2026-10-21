"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { inter } from "./fonts";

const EN = {
    title: "Something went wrong",
    body: "We ran into an unexpected error. You can try reloading the page.",
    retry: "Try again",
    home: "Go to the home page",
};

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        // Log the error using your preferred logging service
        console.error("Global Error Boundary caught error:", error);
    }, [error]);
    // It was fixed Spanish on every site. The admin speaks the admin's language, any other page the
    // site's (<html lang>). Resolved after mount (a server render sees neither), and the catalogue is
    // imported lazily: this boundary is part of every page's bundle and must not carry it.
    const [text, setText] = useState(EN);
    useEffect(() => {
        let live = true;
        import("@/lib/i18n").then(({ t, getStoredLanguage }) => {
            const base = (document.documentElement.lang || "").toLowerCase().split(/[-_]/)[0];
            const lang = window.location.pathname.startsWith("/admin")
                ? getStoredLanguage()
                : (base === "es" || base === "pt" ? base : "en");
            if (live) setText({ title: t("public.error.title", lang), body: t("public.error.body", lang), retry: t("public.error.retry", lang), home: t("public.error.home", lang) });
        }).catch(() => { /* keep English */ });
        return () => { live = false; };
    }, []);

    return (
        // Root error boundary renders outside the (public) tree (no wordjs-ui.css) and outside
        // admin — re-apply Inter here since the root <body> now carries only inter.variable.
        <div className={`${inter.className} min-h-screen w-full flex flex-col items-center justify-center bg-gray-50 text-gray-900 relative overflow-hidden`}>
            {/* Background Decorations */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-red-500/5 rounded-full blur-3xl translate-x-1/2 -translate-y-1/2" />
            <div className="absolute bottom-0 left-0 w-96 h-96 bg-brand-blue/10 rounded-full blur-3xl -translate-x-1/2 translate-y-1/2" />

            <div className="z-10 text-center px-4 animate-in fade-in zoom-in duration-500">
                <div className="text-8xl md:text-9xl mb-4 text-gray-200">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                </div>

                <h1 className="text-4xl md:text-6xl font-oswald font-bold text-gray-900 mb-4">
                    {text.title}
                </h1>

                <p className="text-lg text-gray-600 max-w-lg mx-auto mb-8 leading-relaxed">
                    {text.body}
                </p>

                <div className="flex flex-col md:flex-row gap-4 justify-center items-center">
                    <button
                        onClick={() => reset()}
                        className="inline-flex items-center gap-2 px-8 py-3 bg-brand-blue hover:bg-brand-cyan text-white text-lg font-medium rounded-full shadow-lg shadow-brand-blue/20 hover:shadow-brand-cyan/30 transform hover:-translate-y-1 transition-all duration-300 cursor-pointer"
                    >
                        <i className="fa-solid fa-rotate-right"></i>
                        <span className="font-oswald tracking-wide uppercase">{text.retry}</span>
                    </button>

                    <Link
                        href="/"
                        className="inline-flex items-center gap-2 px-8 py-3 bg-white hover:bg-gray-50 text-gray-700 hover:text-brand-blue border border-gray-200 text-lg font-medium rounded-full shadow-sm hover:shadow-md transition-all duration-300"
                    >
                        <span className="font-oswald tracking-wide uppercase">{text.home}</span>
                    </Link>
                </div>

                {error.digest && (
                    <div className="mt-12 p-4 bg-gray-100 rounded-lg max-w-md mx-auto text-left">
                        <p className="text-xs text-gray-500 font-mono">Error ID: {error.digest}</p>
                        <p className="text-xs text-gray-400 font-mono break-all mt-1">{error.message}</p>
                    </div>
                )}
            </div>
        </div>
    );
}
