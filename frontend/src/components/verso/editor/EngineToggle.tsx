"use client";

import React from "react";
import { EDITOR_ENGINE_QUERY_PARAM, type EditorEngine } from "@/lib/editorEngine";

/**
 * Conmutador de motor (SOLO dev) — F3.
 *
 * Cambiar de motor exige un remontaje completo del editor; la vía fiable es una
 * NAVEGACIÓN DURA con el query param (location.assign), nunca una navegación
 * suave de Next (el defecto reportado: «al cambiar de editor se queda en
 * rendering»). Este control existe para alternar sin editar URLs a mano.
 * En producción no se renderiza: el flag sigue siendo query/localStorage/env.
 */
export default function EngineToggle({ current }: { current: EditorEngine | null }) {
  if (process.env.NODE_ENV === "production") return null;

  const goTo = (engine: EditorEngine) => {
    if (engine === current) return;
    const url = new URL(window.location.href);
    if (engine === "legacy") url.searchParams.delete(EDITOR_ENGINE_QUERY_PARAM);
    else url.searchParams.set(EDITOR_ENGINE_QUERY_PARAM, engine);
    // Navegación DURA a propósito: remonta la página entera con el motor nuevo.
    window.location.assign(url.toString());
  };

  const btn = (engine: EditorEngine, label: string) => (
    <button
      type="button"
      onClick={() => goTo(engine)}
      aria-pressed={current === engine}
      className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
        current === engine
          ? "bg-[var(--ed-primary)] text-[var(--ed-on-primary)]"
          : "text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-on-surface)]"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      data-verso-engine-toggle
      className="fixed bottom-3 left-3 z-[9999] flex items-center gap-1 rounded-full border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-2 py-1 shadow-lg"
      title="Motor del editor (solo dev)"
    >
      <span className="text-[10px] uppercase tracking-wide text-[var(--ed-outline)] pr-1">Motor</span>
      {btn("legacy", "Legacy")}
      {btn("verso", "Verso")}
    </div>
  );
}
