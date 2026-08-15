"use client";

import React, { useEffect, useState } from "react";
import PuckEditorSkeleton from "@/components/PuckEditorSkeleton";

const STUCK_AFTER_MS = 15000;

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
      <PuckEditorSkeleton />
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
