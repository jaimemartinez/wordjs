"use client";
/**
 * Verso — ActionBar flotante del bloque seleccionado (F2).
 *
 * Vive en la capa overlay del documento PADRE (pointer-events:none): SOLO este
 * grupo de controles re-habilita pointer-events (clase pointer-events-auto en
 * el contenedor de la barra, nada más en la capa). Toda acción delega en
 * actionBarCommands.ts (lógica pura, testeada); la barra jamás toca el doc.
 * aria-label en todos los botones.
 */
import React from "react";
import MSym from "@/components/editor/MSym";
import { useOptionalI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import type { BlockRect } from "./GeometryStore";
import {
    actionBarModel,
    duplicateSelected,
    editSelectedInline,
    moveSelected,
    removeSelected,
    selectParent,
} from "./actionBarCommands";

const BAR_BTN_CLS =
    "flex h-7 w-7 items-center justify-center rounded-md leading-none text-white/90 hover:bg-white/20 focus-visible:outline-white disabled:opacity-35 disabled:hover:bg-transparent";

export interface ActionBarProps {
    handle: EditorHandle;
    registry: BlockRegistry;
    nodeId: string;
    rect: BlockRect;
}

/**
 * Escala visual del lienzo, leída de la propia capa overlay (hermana del iframe dentro del
 * contenedor transformado): ancho pintado / ancho CSS — la misma derivación que toFramePoint en
 * dnd/driverCore.ts. 1 fuera de un lienzo escalado.
 */
interface BarMetrics {
    scale: number;
    hostWidth: number;
    hostHeight: number;
    barWidth: number;
    barHeight: number;
}

function useCanvasScale(ref: React.RefObject<HTMLDivElement | null>): BarMetrics {
    const [m, setM] = React.useState<BarMetrics>({ scale: 1, hostWidth: 0, hostHeight: 0, barWidth: 0, barHeight: 0 });
    React.useLayoutEffect(() => {
        const bar = ref.current;
        const host = bar?.parentElement;
        if (!bar || !host) return;
        const measure = () => {
            const css = host.offsetWidth;
            const scale = css > 0 ? host.getBoundingClientRect().width / css || 1 : 1;
            const next: BarMetrics = {
                scale,
                hostWidth: css,
                hostHeight: host.offsetHeight,
                barWidth: bar.offsetWidth,
                barHeight: bar.offsetHeight,
            };
            setM((prev) =>
                Math.abs(prev.scale - next.scale) < 1e-3 &&
                prev.hostWidth === next.hostWidth &&
                prev.hostHeight === next.hostHeight &&
                prev.barWidth === next.barWidth &&
                prev.barHeight === next.barHeight
                    ? prev
                    : next,
            );
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(host);
        ro.observe(bar);
        return () => ro.disconnect();
    }, [ref]);
    return m;
}

export default function ActionBar({ handle, registry, nodeId, rect }: ActionBarProps) {
    const barRef = React.useRef<HTMLDivElement | null>(null);
    const { scale, hostWidth, hostHeight, barWidth, barHeight } = useCanvasScale(barRef);
    // Opcional: la barra también vive en el Verso Lab y en el editor de chrome; fuera del provider, ES.
    const language = useOptionalI18n()?.language ?? "es";
    const model = actionBarModel(handle.getDoc(), registry, nodeId);
    if (!model) return null;
    // El overlay vive DENTRO del lienzo escalado (escritorio a 1280 px en un área de ~600 → ×0,45):
    // sin compensar, la barra se encogía con él hasta botones de 12 px. Se contra-escala (1/s) para
    // pintarse a tamaño real; las distancias en coordenadas del lienzo se dividen por s.
    const inv = 1 / scale;
    const tr = (s: string) => trStr(s, language);
    // Botón con su atajo en el tooltip (title) y el nombre de la acción, sin atajo, para el lector.
    const btn = (icon: string, size: number, name: string, tip: string, onClick: () => void, disabled = false) => (
        <button
            type="button"
            className={BAR_BTN_CLS}
            aria-label={tr(name)}
            title={tr(tip)}
            disabled={disabled}
            onClick={onClick}
        >
            <MSym name={icon} size={size} />
        </button>
    );
    // Encima del bloque; si no cabe (borde superior del canvas), dentro del bloque. El alto es el
    // MEDIDO: en pantallas táctiles los botones crecen a 44 px y una constante de 34 montaba la barra
    // sobre el propio bloque.
    const BAR_H = barHeight > 0 ? barHeight : 34;
    // Bloque fuera del lienzo (scroll): sin bloque a la vista, la barra no tiene a qué referirse —
    // se quedaba clavada arriba, sobre la cabecera del sitio, apuntando a nada.
    if (hostHeight > 0 && (rect.y + rect.height <= 0 || rect.y >= hostHeight)) return null;
    const top = rect.y >= (BAR_H + 2) * inv ? rect.y - (BAR_H + 2) * inv : rect.y + 2 * inv;
    // Sin salirse por la derecha del lienzo (la capa recorta): ancho pintado = barWidth en px reales.
    const maxLeft = hostWidth > 0 ? Math.max(0, hostWidth - barWidth * inv) : Infinity;
    const left = Math.min(Math.max(0, rect.x), maxLeft);
    return (
        <div
            ref={barRef}
            data-wjs-actionbar=""
            role="toolbar"
            aria-label={`${trStr("Acciones del bloque", language)}: ${trStr(model.label, language)}`}
            className="pointer-events-auto absolute flex items-center gap-0.5 rounded-lg bg-[var(--ed-primary-solid,var(--ed-primary,#2563eb))] px-1.5 py-1 shadow-lg ring-1 ring-white/15"
            style={{
                left,
                top: Math.max(0, top),
                ...(scale !== 1 ? { transform: `scale(${inv})`, transformOrigin: "0 0" } : {}),
            }}
        >
            {model.parentId &&
                btn("expand_less", 18, "Seleccionar contenedor", "Seleccionar contenedor (Esc)", () => selectParent(handle, nodeId))}
            <span className="max-w-32 truncate px-1 text-[11px] font-medium text-white">{tr(model.label)}</span>
            {btn("arrow_upward", 16, "Subir bloque", "Subir bloque (Ctrl+Shift+↑)", () => moveSelected(handle, nodeId, -1), !model.canMoveUp)}
            {btn("arrow_downward", 16, "Bajar bloque", "Bajar bloque (Ctrl+Shift+↓)", () => moveSelected(handle, nodeId, 1), !model.canMoveDown)}
            {btn("content_copy", 15, "Duplicar bloque", "Duplicar bloque (Ctrl+D)", () => duplicateSelected(handle, nodeId))}
            {model.canEditInline &&
                btn("edit", 16, "Editar texto", "Editar texto (doble clic)", () => editSelectedInline(handle, registry, nodeId))}
            {btn("delete", 16, "Eliminar bloque", "Eliminar bloque (Supr)", () => removeSelected(handle, nodeId))}
        </div>
    );
}
