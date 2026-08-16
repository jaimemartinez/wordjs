// @ts-nocheck
"use client";

/**
 * Verso block "ContactForms" — renders a form built in Admin → Formularios.
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page, so the form definition arrives via a
 * client-mount fetch against the plugin's PUBLIC endpoint, guarded with res.ok (an inactive
 * plugin 404s — the block degrades to a quiet Spanish placeholder instead of crashing the page).
 *
 * Anti-spam contract with the backend: an off-screen honeypot input (sent as `hp`) plus the
 * milliseconds elapsed since the form rendered (`elapsed` — bots fill instantly).
 */

import React, { useEffect, useRef, useState } from "react";

const STYLES = `
.wjcf-wrap { font-family: var(--wjs-font-family-base, inherit); color: var(--wjs-color-text, #111827); max-width: 100%; }
.wjcf-title { font-size: 1.35rem; font-weight: 700; margin: 0 0 1rem; }
.wjcf-form { position: relative; }
.wjcf-grid { display: grid; grid-template-columns: 1fr; gap: 1rem; }
.wjcf-field { display: flex; flex-direction: column; gap: .35rem; min-width: 0; }
.wjcf-label { font-size: .85rem; font-weight: 600; }
.wjcf-req { color: #dc2626; margin-left: 2px; }
.wjcf-input { width: 100%; box-sizing: border-box; padding: .65rem .8rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: var(--wjs-radius, .5rem); background: var(--wjs-bg-surface, #fff); color: inherit; font: inherit; outline: none; transition: border-color .15s, box-shadow .15s; }
.wjcf-input:focus { border-color: var(--wjs-color-primary, #2563eb); box-shadow: 0 0 0 3px rgba(37, 99, 235, .15); }
textarea.wjcf-input { resize: vertical; min-height: 110px; }
.wjcf-actions { margin-top: 1.25rem; }
.wjcf-btn { display: inline-flex; align-items: center; gap: .5rem; padding: .7rem 1.6rem; border: none; border-radius: var(--wjs-radius, .5rem); background: var(--wjs-color-primary, #111827); color: #fff; font-weight: 700; font-size: .95rem; cursor: pointer; }
.wjcf-btn:hover { opacity: .9; }
.wjcf-btn:disabled { opacity: .6; cursor: default; }
.wjcf-btn-ghost { background: transparent; color: inherit; border: 1px solid var(--wjs-border-subtle, #d1d5db); }
.wjcf-hp { position: absolute; left: -9999px; top: auto; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
.wjcf-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .5rem); font-size: .9rem; }
.wjcf-error { margin-top: 1rem; padding: .75rem 1rem; border-radius: var(--wjs-radius, .5rem); background: #fef2f2; color: #b91c1c; font-size: .9rem; }
.wjcf-success { padding: 2.25rem 1.25rem; text-align: center; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: var(--wjs-radius, .5rem); }
.wjcf-check { width: 52px; height: 52px; margin: 0 auto .9rem; border-radius: 50%; background: #16a34a; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 1.6rem; font-weight: 700; }
.wjcf-success-msg { margin: 0 0 1.1rem; font-weight: 600; color: #14532d; }
@media (min-width: 768px) {
  .wjcf-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wjcf-full { grid-column: 1 / -1; }
}
`;

export const versoComponentDef = {
    category: "Formularios",
    fields: {
        formId: { type: "number", label: "ID del formulario" },
        title: { type: "text", label: "Título (opcional)" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        formId: 0,
        title: "",
        elementId: "",
    },
};

export default function ContactFormsVerso({ formId, title, elementId }) {
    const id = Math.max(0, parseInt(formId, 10) || 0);
    // form: null = loading, false = not found / unconfigured, object = ready.
    const [form, setForm] = useState(null);
    const [values, setValues] = useState({});
    const [hp, setHp] = useState(""); // honeypot — humans never see or fill it
    const [status, setStatus] = useState("idle"); // idle | sending | success | error
    const [errorMsg, setErrorMsg] = useState("");
    const mountTimeRef = useRef(Date.now());

    useEffect(() => {
        let alive = true;
        setForm(null);
        setValues({});
        setHp("");
        setStatus("idle");
        setErrorMsg("");
        if (!id) {
            setForm(false);
            return;
        }
        fetch(`/api/v1/plugin/contact-forms/public/form?id=${id}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive) return;
                setForm(data && Array.isArray(data.fields) ? data : false);
                mountTimeRef.current = Date.now();
            })
            .catch(() => {
                if (alive) setForm(false);
            });
        return () => {
            alive = false;
        };
    }, [id]);

    const setValue = (name, v) => setValues((prev) => ({ ...prev, [name]: v }));

    const reset = () => {
        setValues({});
        setHp("");
        setStatus("idle");
        setErrorMsg("");
        mountTimeRef.current = Date.now();
    };

    const onSubmit = async (e) => {
        e.preventDefault();
        if (!form || status === "sending") return;
        // Client-side required check mirrors the server (which is authoritative).
        for (const f of form.fields) {
            const v = values[f.name] == null ? "" : String(values[f.name]);
            if (f.required && !v.trim()) {
                setStatus("error");
                setErrorMsg(`El campo "${f.label}" es obligatorio.`);
                return;
            }
        }
        setStatus("sending");
        setErrorMsg("");
        try {
            const res = await fetch("/api/v1/plugin/contact-forms/public/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    form_id: form.id,
                    data: values,
                    hp,
                    elapsed: Date.now() - mountTimeRef.current,
                    page_url: typeof window !== "undefined" ? String(window.location.href).slice(0, 500) : "",
                }),
            });
            let out = null;
            try {
                out = await res.json();
            } catch {
                out = null;
            }
            if (res.ok && out && out.success) {
                setStatus("success");
            } else {
                setStatus("error");
                setErrorMsg((out && out.error) || "No se pudo enviar el mensaje. Intenta de nuevo.");
            }
        } catch {
            setStatus("error");
            setErrorMsg("No se pudo enviar el mensaje. Revisa tu conexión.");
        }
    };

    const renderField = (f) => {
        const v = values[f.name] == null ? "" : values[f.name];
        const common = {
            id: `wjcf-${id}-${f.name}`,
            className: "wjcf-input",
            value: v,
            required: !!f.required,
            onChange: (e) => setValue(f.name, e.target.value),
        };
        let control;
        if (f.type === "textarea") {
            control = <textarea rows={4} {...common} />;
        } else if (f.type === "select") {
            const opts = String(f.options || "").split(",").map((s) => s.trim()).filter(Boolean);
            control = (
                <select {...common}>
                    <option value="">Selecciona…</option>
                    {opts.map((o) => (
                        <option key={o} value={o}>{o}</option>
                    ))}
                </select>
            );
        } else {
            control = <input type={f.type} {...common} />;
        }
        return (
            <div key={f.name} className={`wjcf-field${Number(f.width) === 50 ? "" : " wjcf-full"}`}>
                <label className="wjcf-label" htmlFor={`wjcf-${id}-${f.name}`}>
                    {f.label}
                    {f.required ? <span className="wjcf-req" aria-hidden="true">*</span> : null}
                </label>
                {control}
            </div>
        );
    };

    return (
        <div id={elementId || undefined} className="wjcf-wrap">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {form === null ? (
                <div className="wjcf-empty">Cargando formulario…</div>
            ) : form === false ? (
                <div className="wjcf-empty">
                    Configura el ID del formulario en el panel del bloque (Admin → Formularios).
                </div>
            ) : status === "success" ? (
                <div className="wjcf-success">
                    <div className="wjcf-check" aria-hidden="true">✓</div>
                    <p className="wjcf-success-msg">{form.success_message || "¡Mensaje enviado!"}</p>
                    <button type="button" className="wjcf-btn wjcf-btn-ghost" onClick={reset}>
                        Enviar otro
                    </button>
                </div>
            ) : (
                <form className="wjcf-form" onSubmit={onSubmit} noValidate>
                    {title ? <h3 className="wjcf-title">{title}</h3> : null}
                    <div className="wjcf-grid">{form.fields.map(renderField)}</div>
                    {/* Honeypot: off-screen, skipped by keyboard, ignored by humans, filled by bots. */}
                    <input
                        type="text"
                        name="website"
                        className="wjcf-hp"
                        value={hp}
                        onChange={(e) => setHp(e.target.value)}
                        tabIndex={-1}
                        autoComplete="off"
                        aria-hidden="true"
                    />
                    <div className="wjcf-actions">
                        <button type="submit" className="wjcf-btn" disabled={status === "sending"}>
                            {status === "sending" ? "Enviando…" : "Enviar"}
                        </button>
                    </div>
                    {status === "error" && errorMsg ? <div className="wjcf-error">{errorMsg}</div> : null}
                </form>
            )}
        </div>
    );
}
