"use client";

import React, { useEffect, useState } from "react";

const STUCK_AFTER_MS = 15000;

/**
 * Esqueleto estructural del arranque del editor: reproduce la forma del shell de Verso (cabecera
 * h-20, panel izquierdo de 360px, lienzo centrado) para que el usuario vea la SILUETA del editor en
 * vez de un parpadeo en blanco mientras la ruta resuelve sus datos. Presentación pura: no toca datos.
 *
 * Vivía en components/PuckEditorSkeleton.tsx (borrado con el editor legacy); se movió aquí, su único
 * consumidor, sin cambiar una sola clase.
 */
export function EditorSkeleton() {
    return (
        <div
            className="h-full w-full overflow-hidden flex flex-col bg-gray-50"
            aria-busy="true"
            aria-label="Loading editor"
        >
            {/* Header */}
            <div className="h-20 flex-shrink-0 border-b border-gray-200 bg-white/80 backdrop-blur-sm flex items-center justify-between px-6">
                <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-2xl bg-gray-200 animate-pulse" />
                    <div className="space-y-2">
                        <div className="h-3 w-28 rounded bg-gray-200 animate-pulse" />
                        <div className="h-2 w-16 rounded bg-gray-100 animate-pulse" />
                    </div>
                </div>
                <div className="hidden lg:flex items-center gap-2">
                    <div className="h-9 w-36 rounded-full bg-gray-200 animate-pulse" />
                </div>
                <div className="flex items-center gap-3">
                    <div className="h-9 w-24 rounded-lg bg-gray-200 animate-pulse" />
                    <div className="h-9 w-9 rounded-lg bg-gray-200 animate-pulse" />
                    <div className="h-9 w-28 rounded-lg bg-gray-300 animate-pulse" />
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 flex min-h-0">
                {/* Left sidebar (palette + outline) */}
                <div className="w-[360px] flex-shrink-0 border-r border-gray-200 bg-white p-6 space-y-3 hidden md:block">
                    <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-4" />
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-12 rounded-xl bg-gray-100 animate-pulse" />
                    ))}
                </div>

                {/* Canvas */}
                <div className="flex-1 bg-gray-100/50 flex items-start justify-center p-6 md:p-10">
                    <div className="w-full max-w-3xl rounded-2xl bg-white border border-gray-200 shadow-xl p-8 md:p-10 space-y-5">
                        <div className="h-9 w-2/3 rounded-lg bg-gray-200 animate-pulse" />
                        <div className="h-4 w-full rounded bg-gray-100 animate-pulse" />
                        <div className="h-4 w-11/12 rounded bg-gray-100 animate-pulse" />
                        <div className="h-4 w-4/5 rounded bg-gray-100 animate-pulse" />
                        <div className="h-48 w-full rounded-xl bg-gray-100 animate-pulse" />
                        <div className="h-4 w-3/4 rounded bg-gray-100 animate-pulse" />
                        <div className="h-4 w-2/3 rounded bg-gray-100 animate-pulse" />
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * Skeleton de arranque del editor con SALIDA: si tras 15s seguimos aquí
 * (dev server recompilando, chunk perdido, red), ofrece recargar en vez de
 * un «rendering» eterno — un cuelgue silencioso es exactamente la clase de
 * estado que este editor no se permite. Presentación pura: no toca datos.
 */
export default function EditorBootFallback() {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="relative h-full w-full">
      <EditorSkeleton />
      {stuck && (
        <div className="absolute inset-x-0 bottom-6 flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-4 py-2 shadow-xl">
            <span className="text-[13px] text-[var(--ed-on-surface-variant)]">
              El editor está tardando más de lo normal.
            </span>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="text-[13px] font-semibold text-[var(--ed-primary)] hover:underline"
            >
              Recargar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
