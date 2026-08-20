"use client";

import React, { useEffect, useState } from "react";
import "@/components/editor-theme.css";

const STUCK_AFTER_MS = 15000;

/**
 * Esqueleto estructural del arranque del editor: reproduce la forma del shell de Verso (cabecera
 * h-16, rail + panel adaptativos y lienzo centrado) para que el usuario vea la SILUETA del editor en
 * vez de un parpadeo en blanco mientras la ruta resuelve sus datos. Presentación pura: no toca datos.
 *
 * Vivía en components/PuckEditorSkeleton.tsx (borrado con el editor legacy); se movió aquí, su único
 * consumidor, sin cambiar una sola clase.
 */
export function EditorSkeleton() {
    return (
        <div
            className="verso-container h-full min-h-[100dvh] w-full overflow-hidden flex flex-col bg-[var(--ed-surface-container-low)]"
            aria-busy="true"
            aria-label="Cargando editor"
        >
            {/* Header */}
            <div className="verso-header h-14 xl:h-16 flex-shrink-0 border-b border-[var(--ed-outline-variant)] flex items-center justify-between px-3 xl:px-5">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-[var(--ed-primary-container)] animate-pulse" />
                    <div className="space-y-2">
                        <div className="h-3 w-28 rounded bg-[var(--ed-surface-container-highest)] animate-pulse" />
                        <div className="h-2 w-16 rounded bg-[var(--ed-surface-container)] animate-pulse" />
                    </div>
                </div>
                <div className="hidden xl:flex items-center gap-2">
                    <div className="h-9 w-36 rounded-full bg-[var(--ed-surface-container-highest)] animate-pulse" />
                </div>
                <div className="flex items-center gap-3">
                    <div className="h-9 w-24 rounded-lg bg-[var(--ed-surface-container-highest)] animate-pulse" />
                    <div className="h-9 w-9 rounded-lg bg-[var(--ed-surface-container-highest)] animate-pulse" />
                    <div className="h-9 w-28 rounded-lg bg-[var(--ed-primary-container)] animate-pulse" />
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 flex min-h-0">
                <div className="w-[72px] flex-shrink-0 border-r border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] p-3 space-y-2 hidden xl:block">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="h-12 rounded-xl bg-[var(--ed-surface-container)] animate-pulse" />
                    ))}
                </div>

                {/* Left sidebar (palette + outline) */}
                <div className="w-[296px] flex-shrink-0 border-r border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] p-4 space-y-3 hidden xl:block">
                    <div className="h-3 w-24 rounded bg-[var(--ed-surface-container-highest)] animate-pulse mb-4" />
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-12 rounded-xl bg-[var(--ed-surface-container)] animate-pulse" />
                    ))}
                </div>

                {/* Canvas */}
                <div className="verso-canvas-area flex-1 flex items-start justify-center p-3 sm:p-6 xl:p-8">
                    <div className="w-full max-w-4xl rounded-2xl bg-[var(--ed-surface-container-lowest)] border border-[var(--ed-outline-variant)] shadow-xl p-6 sm:p-8 xl:p-10 space-y-5">
                        <div className="h-9 w-2/3 rounded-lg bg-[var(--ed-surface-container-highest)] animate-pulse" />
                        <div className="h-4 w-full rounded bg-[var(--ed-surface-container)] animate-pulse" />
                        <div className="h-4 w-11/12 rounded bg-[var(--ed-surface-container)] animate-pulse" />
                        <div className="h-4 w-4/5 rounded bg-[var(--ed-surface-container)] animate-pulse" />
                        <div className="h-48 w-full rounded-xl bg-[var(--ed-surface-container)] animate-pulse" />
                        <div className="h-4 w-3/4 rounded bg-[var(--ed-surface-container)] animate-pulse" />
                        <div className="h-4 w-2/3 rounded bg-[var(--ed-surface-container)] animate-pulse" />
                    </div>
                </div>
            </div>

            <div className="verso-mobile-nav xl:hidden h-16 shrink-0 border-t border-[var(--ed-outline-variant)] flex items-center justify-around px-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-8 w-12 rounded-lg bg-[var(--ed-surface-container)] animate-pulse" />
                ))}
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
        <div className="absolute inset-x-0 bottom-[calc(var(--ed-mobile-nav-height)+16px)] xl:bottom-6 px-3 flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-4 py-2 shadow-xl">
            <span className="text-[13px] text-[var(--ed-on-surface-variant)]">
              El editor está tardando más de lo normal.
            </span>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-11 px-2 text-[13px] font-semibold text-[var(--ed-primary)] hover:underline"
            >
              Recargar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
