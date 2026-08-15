"use client";
/**
 * Verso — VersoInline: edición inline declarativa IN SITU con el motor de
 * texto PROPIO (F3.5). CERO imports de Tiptap: el núcleo es VersoTextSurface
 * (contenteditable no controlado + lib/verso/inline-engine); Tiptap queda solo
 * en el editor legacy (InlineTiptap.tsx, intocado).
 *
 * Montaje (fix W34-tipografía): VersoBlock ya NO reemplaza el render del
 * bloque — renderiza el Component real con la prop inline sustituida por el
 * centinela y monta este VersoInline al lado; VersoTextSurface localiza el
 * elemento del centinela y edita el nodo de texto DEL BLOQUE in-place, así el
 * editable hereda la tipografía real (h2/.wp-block-text/…).
 *
 * Contrato de commits (inlineSession.ts — SE CONSERVA sin cambios):
 * - superficie → onContent(raw): commits parciales throttled
 *   (INLINE_COMMIT_THROTTLE_MS, leading+trailing) vía handle.transact(setProps)
 *   con coalesceKey `inline:<nodeId>`.
 * - schema "rich": raw = serialización CANÓNICA del modelo (spec §1), pasada
 *   por la MISMA sanitizeHTML isomórfica antes de setProps (defensa en
 *   profundidad: el output del motor es punto fijo del saneador, así que el
 *   saneado es no-op salvo ataque). "<p></p>" se normaliza a "" (el motor ya
 *   emite "" para el doc vacío; se conserva por si llega el valor legacy).
 * - schema "plain": texto del modelo tal cual (no es HTML; React lo escapa al
 *   render y el servidor sanea los PUCK_HTML_FIELDS al guardar).
 * - Escape o mousedown fuera (del editable Y del bubble) → session.end():
 *   commit final + setInlineEditing(null). handle.commitInline() también hace
 *   flush (la sesión está suscrita a inlineEditingId — ver inlineSession.ts).
 *   Esos listeners viven en VersoTextSurface (conoce host y bubble); aquí solo
 *   se cablea la sesión.
 */
import React from "react";
import { sanitizeHTML } from "@/lib/sanitize";
import { useVersoRenderContext } from "../render/context";
import { createInlineSession, type InlineSession } from "./inlineSession";
import VersoTextSurface from "./VersoTextSurface";

export interface VersoInlineProps {
    /** Clave interna del nodo en edición (== inlineEditingId). */
    nodeId: string;
    /** Prop de destino declarada en BlockDefinition.inline. */
    prop: string;
    schema: "rich" | "plain";
}

/** rich: "" ya viene del motor; "<p></p>" legacy se normaliza igual que antes. */
function richTransform(raw: string): string {
    return sanitizeHTML(raw === "<p></p>" ? "" : raw);
}

/** plain: texto tal cual (no es HTML; ver doc-comment del módulo). */
function plainTransform(raw: string): string {
    return raw;
}

export default function VersoInline({ nodeId, prop, schema }: VersoInlineProps) {
    const { handle } = useVersoRenderContext();

    // Valor inicial UNA vez: la superficie no es controlada; los commits
    // parciales cambian node.props (y la referencia del nodo) sin re-alimentar
    // el editable (el centinela mantiene estable el render del Component).
    const [initialValue] = React.useState<string>(() => {
        const v = handle.getDoc().nodes[nodeId]?.props[prop];
        return typeof v === "string" ? v : "";
    });

    // La sesión se crea en un efecto (no en render: crear una suscripción al
    // store durante el render es un side effect y StrictMode la duplicaría).
    const sessionRef = React.useRef<InlineSession | null>(null);
    React.useEffect(() => {
        const session = createInlineSession({
            handle,
            nodeId,
            prop,
            transform: schema === "rich" ? richTransform : plainTransform,
        });
        sessionRef.current = session;
        return () => {
            sessionRef.current = null;
            // Cleanup de React (desmontaje o cambio de nodo): flush del
            // pendiente SIN tocar inlineEditingId (eso es de end()/el store).
            session.dispose();
        };
    }, [handle, nodeId, prop, schema]);

    return (
        <VersoTextSurface
            nodeId={nodeId}
            schema={schema}
            initialValue={initialValue}
            onContent={(raw) => sessionRef.current?.onContent(raw)}
            onRequestEnd={() => sessionRef.current?.end()}
        />
    );
}
