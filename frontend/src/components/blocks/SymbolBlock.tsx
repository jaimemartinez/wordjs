"use client";

import { useEffect, useState } from "react";
import { symbolsApi, type SymbolSummary } from "@/lib/symbols";
import VersoSymbolRender from "@/components/verso/blocks/VersoSymbolBlock";

/**
 * Symbol block — a reusable, SYNCED group of blocks (Figma/Webflow "components"): pages store a
 * REFERENCE (symbolId); the blocks live once in a `wjs_symbol` post. Edit the symbol and every
 * page that references it changes on its next render — the "editas uno, cambian todos" contract.
 *
 * Rendering paths:
 *  - PUBLIC: the SSR resolver (resolveDynamicBlocks) injects `resolvedSymbolItems`, so the HTML
 *    ships complete with zero client fetches.
 *  - EDITOR canvas: no server pass — the render fetches through symbolsApi (30s cache, shared
 *    across instances) and shows honest picking/loading/deleted/empty states.
 *
 * UNA SOLA IMPLEMENTACIÓN DE SYMBOL (retirement-plan §11). Hasta la retirada del fork existían dos:
 * ésta, que pintaba el subárbol con `<Render>` de @wordjs/puck y un config anidado derivado del mapa
 * VIVO de componentes menos Symbol; y VersoSymbolBlock, que lo pinta con `RenderSubtree` — el MISMO
 * switch compartido de ContentRenderer que usa el sitio público — excluyendo "Symbol" del subárbol
 * (idéntico cap de profundidad 1, por construcción). Borrado el fork, este módulo conserva solo la
 * PARTE DE CAMPOS del bloque (el selector de símbolo) y delega el render en aquélla.
 */

export const symbolBlockDefaults = { symbolId: 0 };

function SymbolPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const [symbols, setSymbols] = useState<SymbolSummary[] | null>(null);
    const [error, setError] = useState(false);
    useEffect(() => {
        let dead = false;
        symbolsApi.list().then(
            (s) => { if (!dead) setSymbols(s); },
            () => { if (!dead) setError(true); }
        );
        return () => { dead = true; };
    }, []);
    if (error) {
        return <p className="text-[11px] text-[var(--ed-error)]">No se pudieron cargar los símbolos.</p>;
    }
    return (
        <div className="space-y-1">
            <select
                value={String(value || 0)}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-full px-2 py-1.5 bg-white border border-[var(--ed-outline-variant)] rounded text-[13px] text-[var(--ed-on-surface)] focus:outline-none focus:border-[var(--ed-primary)] focus:ring-1 focus:ring-[var(--ed-primary)]"
            >
                <option value="0">{symbols ? "— Elige un símbolo —" : "Cargando…"}</option>
                {(symbols || []).map((s) => (
                    <option key={s.id} value={String(s.id)}>{s.name}</option>
                ))}
            </select>
            <p className="text-[10px] text-[var(--ed-outline)]">
                Crea símbolos con «Guardar bloque como símbolo» (⌘K) desde cualquier bloque.
            </p>
        </div>
    );
}

export const symbolBlockFields = {
    symbolId: {
        type: "custom" as const,
        label: "Símbolo",
        render: ({ value, onChange }: any) => <SymbolPicker value={value} onChange={onChange} />,
    },
};

/**
 * Render del bloque — delega en la única implementación (VersoSymbolBlock). El objeto `puck` del
 * contrato legacy se traduce a la prop `isEditing` que ésta espera; el resto de estados (elegir /
 * cargando / eliminado / vacío, y "nada" fuera de edición) son los mismos, porque son los suyos.
 */
export function SymbolRender({ symbolId, resolvedSymbolItems, puck, isEditing }: any) {
    return (
        <VersoSymbolRender
            symbolId={symbolId}
            resolvedSymbolItems={resolvedSymbolItems}
            isEditing={puck?.isEditing ?? isEditing}
        />
    );
}
