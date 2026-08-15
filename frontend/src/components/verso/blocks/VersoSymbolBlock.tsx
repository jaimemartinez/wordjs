"use client";
/**
 * Verso — variante del bloque Symbol para el canvas del editor Verso.
 *
 * AUDITORÍA (encargo F3.3, verificada): el render actual del Symbol
 * (frontend/src/components/puck/SymbolBlock.tsx, makeSymbolRender) depende de `<Render>` de
 * @wordjs/puck (import en su L4, uso en su L123) con un config anidado derivado del mapa VIVO de
 * componentes de puckConfig menos el propio Symbol. Verso no puede montar ese camino (prohibido
 * acoplarse al fork), así que esta variante renderiza el subárbol con `RenderSubtree` — el MISMO
 * switch compartido de ContentRenderer.tsx que usa el sitio público — con `exclude={Symbol}`:
 * un símbolo que referencie otro símbolo NO recursa (cap de profundidad 1, la misma garantía que
 * el mecanismo actual de exclusión del config anidado). El SymbolBlock público/Puck queda intacto.
 *
 * Estados y flujo de datos: mismos que SymbolRender —
 *  - `resolvedSymbolItems` inyectado (resolver SSR) gana siempre;
 *  - en edición, fetch vía symbolsApi (caché de 30s compartida) con avisos honestos de
 *    elegir/cargando/eliminado/vacío; fuera de edición un símbolo roto no pinta nada.
 *
 * DIVERGENCIA DOCUMENTADA: el subárbol se pinta con los componentes compartidos "públicos"
 * (ContentRenderer), no con los renders del editor — los bloques dinámicos (PostsGrid/
 * CategoryPosts) dentro de un símbolo no hacen fetch de posts en el canvas (muestran su estado
 * vacío), igual que la limitación ya existente con bloques de plugin dentro de símbolos.
 */
import React, { useEffect, useState } from "react";
import { RenderSubtree } from "@/components/content/ContentRenderer";
import { symbolsApi, SYMBOL_BLOCK_TYPE } from "@/lib/symbols";

/** Cap de profundidad 1: Symbol jamás se renderiza dentro del subárbol de un Symbol. */
const SYMBOL_SUBTREE_EXCLUDE: ReadonlySet<string> = new Set([SYMBOL_BLOCK_TYPE]);

const noticeStyle: React.CSSProperties = {
    border: "1px dashed rgba(119, 117, 132, 0.5)",
    borderRadius: 8,
    padding: "14px 16px",
    fontSize: 13,
    color: "#464553",
    background: "rgba(240, 236, 246, 0.5)",
};

export default function VersoSymbolRender({ symbolId, resolvedSymbolItems, isEditing }: {
    symbolId?: unknown;
    resolvedSymbolItems?: unknown;
    isEditing?: unknown;
}) {
    const editing = !!isEditing;
    const id = Number(symbolId) || 0;
    const injected = Array.isArray(resolvedSymbolItems) ? resolvedSymbolItems : null;
    const [fetched, setFetched] = useState<{ id: number; items: unknown[] | null } | null>(null);

    useEffect(() => {
        if (injected || !editing || !id) return;
        let dead = false;
        symbolsApi.get(id).then(
            (sym) => { if (!dead) setFetched({ id, items: sym ? sym.items : null }); },
            () => { /* error de red — se queda en el estado de carga */ },
        );
        return () => { dead = true; };
    }, [id, editing, injected]);

    const items = injected ?? (fetched && fetched.id === id ? fetched.items : undefined);

    // Avisos solo en edición; el render público de un símbolo roto/vacío no pinta nada.
    if (!id) return editing ? <div style={noticeStyle}>Elige un símbolo en el panel de propiedades.</div> : null;
    if (items === undefined) return editing ? <div style={noticeStyle}>Cargando símbolo…</div> : null;
    if (items === null) return editing ? <div style={noticeStyle}>Este símbolo fue eliminado — elige otro.</div> : null;
    if (!items.length) return editing ? <div style={noticeStyle}>El símbolo está vacío.</div> : null;

    return <RenderSubtree items={items} exclude={SYMBOL_SUBTREE_EXCLUDE} />;
}
