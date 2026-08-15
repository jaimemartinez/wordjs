"use client";
/**
 * Verso — toolbar de device-viewports del canvas + hook de medición del área.
 *
 * <ViewportControls value onChange/>: tres botones (escritorio 1280 / tableta
 * 768 / móvil 375, ver viewport.ts para el contrato de breakpoints con
 * wordjs-ui.css) con aria-pressed y data-wjs-viewport para tests de navegador.
 *
 * useAreaSize(ref): ancho/alto del área disponible medidos con ResizeObserver
 * (scale-to-fit del encargo); mide también al montar (el RO nativo notifica al
 * observar, pero el fallback sin RO — SSR/tests — queda en 0x0 y el contenedor
 * cae a scale 1 vía fitScale, fail-soft).
 *
 * Toda la aritmética (fitScale/canvasContainerLayout) vive en viewport.ts,
 * pura y testeada en node; aquí solo hay UI y cableado del ResizeObserver.
 */
import React from "react";
import { DEVICE_LABELS, DEVICE_ORDER, DEVICE_WIDTHS, type DeviceKind } from "./viewport";

const BTN_CLS =
    "rounded border px-2 py-1 text-xs disabled:opacity-40";
const BTN_OFF_CLS =
    `${BTN_CLS} border-[var(--ed-outline-variant,#d5d2e0)] text-[var(--ed-on-surface,#1c1b22)] hover:bg-[var(--ed-surface-container,#f0eef6)]`;
const BTN_ON_CLS = `${BTN_CLS} border-[var(--ed-primary,#2563eb)] bg-[var(--ed-primary,#2563eb)] text-white`;

export interface ViewportControlsProps {
    value: DeviceKind;
    onChange: (device: DeviceKind) => void;
}

export default function ViewportControls({ value, onChange }: ViewportControlsProps) {
    return (
        <div role="group" aria-label="Viewport del lienzo" className="flex items-center gap-1">
            {DEVICE_ORDER.map((device) => (
                <button
                    key={device}
                    type="button"
                    aria-pressed={value === device}
                    aria-label={`Viewport ${DEVICE_LABELS[device]}`}
                    data-wjs-viewport={device}
                    className={value === device ? BTN_ON_CLS : BTN_OFF_CLS}
                    onClick={() => onChange(device)}
                >
                    {DEVICE_LABELS[device]}
                </button>
            ))}
        </div>
    );
}

export interface AreaSize {
    width: number;
    height: number;
}

/**
 * Tamaño del content-box del elemento referenciado, vía ResizeObserver.
 * {0,0} hasta la primera medición (el RO notifica al observar) o sin RO.
 */
export function useAreaSize(ref: React.RefObject<HTMLElement | null>): AreaSize {
    const [size, setSize] = React.useState<AreaSize>({ width: 0, height: 0 });
    React.useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver !== "function") return;
        const measure = () => {
            const r = el.getBoundingClientRect();
            setSize((prev) =>
                prev.width === r.width && prev.height === r.height
                    ? prev
                    : { width: r.width, height: r.height },
            );
        };
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        measure();
        return () => ro.disconnect();
    }, [ref]);
    return size;
}

export { DEVICE_WIDTHS, type DeviceKind };
