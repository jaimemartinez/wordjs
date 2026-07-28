"use client";

import React, { useEffect, useState } from "react";
import { Render } from "@wordjs/puck";
import { symbolsApi, SYMBOL_BLOCK_TYPE, type SymbolSummary } from "@/lib/symbols";

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
 * The nested tree renders through Puck's own <Render> with a config built from the LIVE component
 * map minus Symbol itself, so a symbol referencing a symbol cannot recurse (depth capped at 1 by
 * construction). The map arrives via a GETTER with late binding: at module time puckConfig hasn't
 * been wrapped by withSharedBlockFields yet, but by first render it has — so symbol content gets
 * the full appearance/animation treatment. (Plugin runtime blocks merged after boot are not in
 * that map; a symbol built from one renders empty in that edge — core blocks always work.)
 */

const noticeStyle: React.CSSProperties = {
    border: "1px dashed rgba(119, 117, 132, 0.5)",
    borderRadius: 8,
    padding: "14px 16px",
    fontSize: 13,
    color: "#464553",
    background: "rgba(240, 236, 246, 0.5)",
};

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
 * Build the block's render bound to the live component map. `getComponents` is called at RENDER
 * time (late binding — see the header) and the derived nested config is cached per component-map
 * identity, shared by every Symbol instance on the page.
 */
export function makeSymbolRender(getComponents: () => Record<string, any>) {
    let cachedFor: Record<string, any> | null = null;
    let cachedConfig: any = null;
    const nestedConfig = () => {
        const comps = getComponents();
        if (comps !== cachedFor) {
            const { [SYMBOL_BLOCK_TYPE]: _omit, ...rest } = comps;
            cachedFor = comps;
            cachedConfig = {
                components: rest,
                root: { render: ({ children }: any) => <>{children}</> },
            };
        }
        return cachedConfig;
    };

    return function SymbolRender({ symbolId, resolvedSymbolItems, puck }: any) {
        const editing = !!puck?.isEditing;
        const id = Number(symbolId) || 0;
        const injected = Array.isArray(resolvedSymbolItems) ? resolvedSymbolItems : null;
        const [fetched, setFetched] = useState<{ id: number; items: unknown[] | null } | null>(null);

        useEffect(() => {
            if (injected || !editing || !id) return;
            let dead = false;
            symbolsApi.get(id).then(
                (sym) => { if (!dead) setFetched({ id, items: sym ? sym.items : null }); },
                () => { /* network error — stay in the loading state */ }
            );
            return () => { dead = true; };
        }, [id, editing, injected !== null]);

        const items = injected ?? (fetched && fetched.id === id ? fetched.items : undefined);

        // Editor-only notices; the public site renders nothing for a broken/empty reference.
        if (!id) return editing ? <div style={noticeStyle}>Elige un símbolo en el panel de propiedades.</div> : null;
        if (items === undefined) return editing ? <div style={noticeStyle}>Cargando símbolo…</div> : null;
        if (items === null) return editing ? <div style={noticeStyle}>Este símbolo fue eliminado — elige otro.</div> : null;
        if (!items.length) return editing ? <div style={noticeStyle}>El símbolo está vacío.</div> : null;

        return <Render config={nestedConfig()} data={{ content: items, root: {} } as any} />;
    };
}
