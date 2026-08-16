"use client";
/**
 * Verso — chip de estado de guardado del header (F3). Misma piel y semántica que el
 * SaveStateChip del PuckEditor legacy, ya retirado (wrapper-blueprint §d):
 *  - el <span> permanece SIEMPRE montado (sr-only bajo xl) con aria-live="polite" — una región
 *    que aparece a la vez que su primer mensaje no se anuncia;
 *  - tick de 30s para que "hace Xm" no mienta sin re-render del padre;
 *  - estados/textos byte-exactos vía saveChipModel (puro, testeado).
 */
import React, { useEffect, useState } from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import { saveChipModel } from "./saveChipModel";

export default function SaveStateChip({ saving, hasChanges, savedAt, wasAuto, status }: {
    saving: boolean; hasChanges: boolean; savedAt: Date | null; wasAuto: boolean; status: string;
}) {
    const { language } = useI18n();
    // Reloj en estado (no Date.now() en render — regla de pureza): el efecto lo fija al montar y
    // el tick de 30s lo refresca para que "hace Xm" no quede mintiendo sin re-render del padre.
    const [nowMs, setNowMs] = useState(0);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- sincronización única del reloj (sistema externo) al montar; el render no puede llamar Date.now() (regla de pureza)
        setNowMs(Date.now());
        const t = setInterval(() => setNowMs(Date.now()), 30000);
        return () => clearInterval(t);
    }, []);
    const model = saveChipModel({
        saving,
        hasChanges,
        status,
        savedAtMs: savedAt ? savedAt.getTime() : null,
        wasAuto,
        // nowMs=0 solo el primer frame: mins clampa a 0 → "Guardado", corregido por el efecto.
        nowMs,
    });
    // Traducir PRIMERO (trStr matchea el literal ES entero) e interpolar {m} DESPUÉS — como hoy.
    const text = model.minutes === null
        ? trStr(model.text, language)
        : trStr(model.text, language).replace("{m}", String(model.minutes));
    const icon =
        model.icon === "sync" ? <MSym name="sync" size={16} className="animate-spin" />
        : model.icon === "cloud_upload" ? <MSym name="cloud_upload" size={16} />
        : model.icon === "cloud_done" ? <MSym name="cloud_done" size={16} fill className="text-[var(--ed-primary)]" />
        : null;
    return (
        <span className={`sr-only xl:not-sr-only xl:flex items-center gap-1.5 text-[11px] select-none ${model.cls}`} aria-live="polite">
            {icon}
            {model.text ? text : ""}
        </span>
    );
}
