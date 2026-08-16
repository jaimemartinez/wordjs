"use client";

import React, { useId, useState } from "react";

/* ============================================================
 * Bloque "Formulario" para el editor visual.
 *
 * Este archivo solo exporta las piezas; el integrador las
 * registra en versoConfig.tsx:
 *   - FormBlockProps      → tipo de props del bloque
 *   - formBlockFields     → definición de campos del editor
 *   - formBlockDefaults   → defaultProps
 *   - FormBlockRender     → render del bloque
 *
 * El envío hace POST a /api/v1/forms/submit con
 * { formName, pageId?, fields: { [label]: value }, _hp }.
 * Los estilos los poseen los temas vía clases wjs-form* en
 * wordjs-ui.css — TAMBIÉN la estructura (display/gap): un estilo
 * inline aquí ganaría a la hoja y mataría --wjs-form-gap /
 * --wjs-form-field-gap para todos los temas (el candado que
 * quitó WAVE 2). El único inline restante es el honeypot, que
 * es ocultación funcional, no apariencia tematizable.
 * ============================================================ */

export type FormBlockFieldType = "text" | "email" | "tel" | "textarea" | "select" | "checkbox";

export type FormBlockFieldDef = {
    type: FormBlockFieldType;
    label: string;
    required?: boolean;
    /** Solo para type "select": opciones separadas por comas. */
    options?: string;
    placeholder?: string;
};

export type FormBlockProps = {
    formName: string;
    fields: FormBlockFieldDef[];
    submitLabel: string;
    successMessage: string;
    errorMessage: string;
    id?: string;
};

export const formBlockFields = {
    formName: { type: "text", label: "Nombre del formulario" },
    fields: {
        type: "array",
        label: "Campos",
        getItemSummary: (item: any, index?: number) => item?.label || `Campo ${(index ?? 0) + 1}`,
        defaultItemProps: { type: "text", label: "Campo", required: false, options: "", placeholder: "" },
        arrayFields: {
            type: {
                type: "select",
                label: "Tipo",
                options: [
                    { label: "Texto", value: "text" },
                    { label: "Email", value: "email" },
                    { label: "Teléfono", value: "tel" },
                    { label: "Área de texto", value: "textarea" },
                    { label: "Desplegable", value: "select" },
                    { label: "Casilla", value: "checkbox" },
                ]
            },
            label: { type: "text", label: "Etiqueta" },
            required: {
                type: "radio",
                label: "Obligatorio",
                options: [{ label: "Sí", value: true }, { label: "No", value: false }]
            },
            options: { type: "text", label: "Opciones (desplegable, separadas por comas)" },
            placeholder: { type: "text", label: "Placeholder" }
        }
    },
    submitLabel: { type: "text", label: "Texto del botón" },
    successMessage: { type: "text", label: "Mensaje de éxito" },
    errorMessage: { type: "text", label: "Mensaje de error" }
};

export const formBlockDefaults: Omit<FormBlockProps, "id"> = {
    formName: "Contacto",
    fields: [
        { type: "text", label: "Nombre", required: true, options: "", placeholder: "Tu nombre" },
        { type: "email", label: "Email", required: true, options: "", placeholder: "tu@email.com" },
        { type: "textarea", label: "Mensaje", required: false, options: "", placeholder: "¿En qué podemos ayudarte?" },
    ],
    submitLabel: "Enviar",
    successMessage: "¡Gracias! Hemos recibido tu mensaje.",
    errorMessage: "No se pudo enviar el formulario. Inténtalo de nuevo.",
};

type SubmitStatus = "idle" | "sending" | "success" | "error";

const isRequired = (f: FormBlockFieldDef): boolean =>
    f.required === true || (f.required as unknown) === "true";

const selectOptions = (f: FormBlockFieldDef): string[] =>
    (f.options || "").split(",").map((s) => s.trim()).filter(Boolean);

export function FormBlockRender(props: FormBlockProps & { puck?: any }) {
    const { formName, fields, submitLabel, successMessage, errorMessage, puck } = props;
    const uid = useId();
    const [status, setStatus] = useState<SubmitStatus>("idle");
    const [invalid, setInvalid] = useState<Record<number, boolean>>({});

    const markInvalid = (index: number) =>
        setInvalid((prev) => (prev[index] ? prev : { ...prev, [index]: true }));

    const clearInvalid = (index: number) =>
        setInvalid((prev) => {
            if (!prev[index]) return prev;
            const next = { ...prev };
            delete next[index];
            return next;
        });

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.currentTarget;

        // En el editor: previsualizar el mensaje de éxito sin tocar la red.
        if (puck?.isEditing) {
            setStatus("success");
            return;
        }

        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }

        const fd = new FormData(form);
        const values: Record<string, string> = {};
        (fields || []).forEach((f, i) => {
            const raw = fd.get(`f${i}`);
            values[f.label] = f.type === "checkbox"
                ? (raw != null ? "Sí" : "No")
                : String(raw ?? "");
        });

        // The backend reads the honeypot as fields._hp (validated then dropped from storage) —
        // top-level would silently disarm the trap.
        const hp = String(fd.get("_hp") ?? "");
        if (hp) values._hp = hp;
        const body: Record<string, unknown> = {
            formName,
            fields: values,
        };
        const pageId = typeof window !== "undefined" ? (window as any).__WJS_PAGE_ID : undefined;
        if (pageId !== undefined && pageId !== null && pageId !== "") {
            body.pageId = pageId;
        }

        setStatus("sending");
        try {
            const res = await fetch("/api/v1/forms/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => null);
            if (res.ok && (!data || data.success !== false)) {
                setStatus("success");
                form.reset();
                setInvalid({});
            } else {
                setStatus("error");
            }
        } catch {
            setStatus("error");
        }
    };

    return (
        <form
            className="wjs-form"
            data-form-name={formName}
            onSubmit={handleSubmit}
        >
            {(fields || []).map((f, i) => {
                const fieldId = `${uid}-f${i}`;
                const name = `f${i}`;
                const required = isRequired(f);
                const commonProps = {
                    id: fieldId,
                    name,
                    required,
                    "aria-required": required || undefined,
                    "aria-invalid": invalid[i] || undefined,
                    onInvalid: () => markInvalid(i),
                    onChange: () => clearInvalid(i),
                } as const;
                const labelNode = (
                    <label htmlFor={fieldId} className="wjs-form-label">
                        {f.label}
                        {required && <span className="wjs-form-required" aria-hidden="true"> *</span>}
                    </label>
                );

                if (f.type === "checkbox") {
                    return (
                        <div
                            key={i}
                            className="wjs-form-field wjs-form-field--checkbox"
                        >
                            <input type="checkbox" className="wjs-form-checkbox" {...commonProps} />
                            {labelNode}
                        </div>
                    );
                }

                return (
                    <div key={i} className="wjs-form-field">
                        {labelNode}
                        {f.type === "textarea" ? (
                            <textarea
                                className="wjs-form-textarea"
                                rows={5}
                                placeholder={f.placeholder || undefined}
                                {...commonProps}
                            />
                        ) : f.type === "select" ? (
                            <select className="wjs-form-select" defaultValue="" {...commonProps}>
                                <option value="" disabled={required}>
                                    {f.placeholder || "Selecciona una opción"}
                                </option>
                                {selectOptions(f).map((opt, j) => (
                                    <option key={j} value={opt}>{opt}</option>
                                ))}
                            </select>
                        ) : (
                            <input
                                type={f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text"}
                                className="wjs-form-input"
                                placeholder={f.placeholder || undefined}
                                {...commonProps}
                            />
                        )}
                    </div>
                );
            })}

            {/* Honeypot anti-spam: oculto para humanos y lectores de pantalla. */}
            <div
                className="wjs-form-hp"
                aria-hidden="true"
                style={{
                    position: "absolute",
                    left: "-9999px",
                    top: "auto",
                    width: "1px",
                    height: "1px",
                    overflow: "hidden",
                }}
            >
                <label htmlFor={`${uid}-hp`}>No rellenes este campo</label>
                <input
                    id={`${uid}-hp`}
                    type="text"
                    name="_hp"
                    tabIndex={-1}
                    autoComplete="off"
                    defaultValue=""
                />
            </div>

            <button
                type="submit"
                className="wjs-form-submit"
                disabled={status === "sending"}
            >
                {status === "sending" ? "Enviando…" : submitLabel}
            </button>

            <p className="wjs-form-status" role="status" aria-live="polite" data-status={status}>
                {status === "success"
                    ? successMessage
                    : status === "error"
                        ? errorMessage
                        : status === "sending"
                            ? "Enviando…"
                            : ""}
            </p>
        </form>
    );
}
