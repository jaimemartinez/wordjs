"use client";

import { useEffect } from "react";
import Link from "next/link";

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

    return (
        <div className="min-h-screen w-full flex flex-col items-center justify-center bg-gray-50 text-gray-900 relative overflow-hidden">
            {/* Background Decorations */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-red-500/5 rounded-full blur-3xl translate-x-1/2 -translate-y-1/2" />
            <div className="absolute bottom-0 left-0 w-96 h-96 bg-brand-blue/10 rounded-full blur-3xl -translate-x-1/2 translate-y-1/2" />

            <div className="z-10 text-center px-4 animate-in fade-in zoom-in duration-500">
                <div className="text-8xl md:text-9xl mb-4 text-gray-200">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                </div>

                <h1 className="text-4xl md:text-6xl font-oswald font-bold text-gray-900 mb-4">
                    Algo salió mal
                </h1>

                <p className="text-lg text-gray-600 max-w-lg mx-auto mb-8 leading-relaxed">
                    Hemos encontrado un error inesperado. Nuestro equipo ha sido notificado, pero puedes intentar recargar la página.
                </p>

                <div className="flex flex-col md:flex-row gap-4 justify-center items-center">
                    <button
                        onClick={() => reset()}
                        className="inline-flex items-center gap-2 px-8 py-3 bg-brand-blue hover:bg-brand-cyan text-white text-lg font-medium rounded-full shadow-lg shadow-brand-blue/20 hover:shadow-brand-cyan/30 transform hover:-translate-y-1 transition-all duration-300 cursor-pointer"
                    >
                        <i className="fa-solid fa-rotate-right"></i>
                        <span className="font-oswald tracking-wide">INTENTAR DE NUEVO</span>
                    </button>

                    <Link
                        href="/"
                        className="inline-flex items-center gap-2 px-8 py-3 bg-white hover:bg-gray-50 text-gray-700 hover:text-brand-blue border border-gray-200 text-lg font-medium rounded-full shadow-sm hover:shadow-md transition-all duration-300"
                    >
                        <span className="font-oswald tracking-wide">IR AL INICIO</span>
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
