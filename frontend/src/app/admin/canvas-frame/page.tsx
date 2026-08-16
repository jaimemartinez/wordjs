"use client";
/**
 * Verso — documento MÍNIMO del iframe del canvas (F2).
 *
 * Este documento NO renderiza contenido propio: expone `#verso-canvas-root` y el
 * PADRE (FrameController) portalea el árbol del editor dentro — mismo árbol React,
 * el contexto del EditorHandle fluye a través del portal. Aquí no hay JS de editor.
 *
 * CSS del canvas (WYSIWYG, mismas URLs que el editor legacy retirado — PuckEditor.tsx L507-508
 * y el ThemeLoader público, vía los helpers compartidos de lib/assetVersion):
 * - /public/css/wordjs-ui.css?v=<ASSET_VERSION>  (uiFrameworkHref)
 * - /themes/<slug>/style.css?v=<slug>-<version>-<ASSET_VERSION>  (themeStylesheetHref)
 *   El slug/version activos se resuelven igual que el PuckEditor legacy (retirado): themesApi.list() y
 *   fallback a "default" si la petición falla (nunca quedar sin link).
 * El <link> del tema lleva id="wjs-theme-stylesheet": FrameController.swapThemeCss lo
 * reemplaza esperando el onload del nuevo antes de retirar el viejo (sin FOUC). Tras
 * el primer render este componente ya no re-renderiza el link, así que la retirada
 * imperativa no entra en conflicto con React.
 *
 * CONTRATO DE DOCUMENTO (lección del editor legacy retirado, PuckEditor L446-456): el tema y
 * los globals del admin (html,body{height:100%}) NO pueden secuestrar el modelo de
 * scroll del canvas. :root/:root>body ganan por especificidad a cualquier selector
 * html/body de tema, y html queda como ÚNICO contenedor de scroll con body en
 * height:auto y margin:0.
 *
 * Esta ruta se salta el shell del admin (sidebar/chrome) vía el bypass de
 * DashboardLayoutClient — los gates de auth/MFA sí corren: el iframe comparte la
 * sesión del editor.
 */
import React from "react";
import { themeStylesheetHref, uiFrameworkHref } from "@/lib/assetVersion";
import { themesApi } from "@/lib/api";

/**
 * Id del nodo donde el padre portalea el árbol del editor. NO se exporta: una
 * page del app router solo admite los exports del contrato de Next; el
 * consumidor (FrameController) declara su propia constante CANVAS_ROOT_ID.
 */
const VERSO_CANVAS_ROOT_ID = "verso-canvas-root";

const DOC_CONTRACT_CSS =
    ":root{height:auto!important;overflow-x:hidden!important;overflow-y:auto!important;transform:none!important;filter:none!important;perspective:none!important}" +
    ":root>body{height:auto!important;min-height:100%!important;max-height:none!important;overflow:visible!important;transform:none!important;filter:none!important;perspective:none!important;margin:0!important}";

/**
 * Scrollbar delgada del canvas (W08): el scroll vive DENTRO del iframe, y la barra por defecto
 * (gorda en Windows) desentona con el bisel de teléfono/tableta. MISMO CSS byte-a-byte que el
 * PreviewFrame legacy (PuckEditor.tsx L409-413).
 */
const THIN_SCROLLBAR_CSS =
    "::-webkit-scrollbar{width:9px;height:9px}" +
    "::-webkit-scrollbar-track{background:transparent}" +
    "::-webkit-scrollbar-thumb{background:rgba(100,116,139,.3);border-radius:9px}" +
    "::-webkit-scrollbar-thumb:hover{background:rgba(100,116,139,.55)}" +
    "html{scrollbar-width:thin;scrollbar-color:rgba(100,116,139,.3) transparent}";

interface ActiveTheme {
    slug: string;
    version: string;
}

/** Resuelve el tema activo (mismo criterio y fallback que el PuckEditor legacy (retirado): active → "default"). */
async function resolveActiveTheme(): Promise<ActiveTheme> {
    const list = await themesApi.list();
    const active = list.find((t) => t.active) || list.find((t) => t.slug === "default");
    return { slug: active?.slug || "default", version: active?.version || "" };
}

export default function CanvasFramePage() {
    const [theme, setTheme] = React.useState<ActiveTheme | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        resolveActiveTheme()
            .then((t) => {
                if (!cancelled) setTheme(t);
            })
            .catch(() => {
                // Offline/error: nunca quedar sin hoja de tema (mismo fallback que el PuckEditor legacy (retirado)).
                if (!cancelled) setTheme({ slug: "default", version: "" });
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // W08 (paridad PreviewFrame): re-resuelve el tema activo cada 10s — detecta que OTRA pestaña
    // activó un tema distinto. El cambio se aplica IMPERATIVAMENTE (link nuevo insertado tras el
    // actual → onload → retirar el viejo: sin FOUC y con el ORDEN framework-antes-que-tema
    // intacto), nunca vía estado: React ya no re-renderiza el link tras el primer render y un
    // setState aquí entraría en conflicto con la retirada imperativa (contrato de swapThemeCss).
    React.useEffect(() => {
        if (!theme) return; // hasta que el primer link exista no hay nada que intercambiar
        const tick = async () => {
            let href: string;
            try {
                const next = await resolveActiveTheme();
                href = themeStylesheetHref(next.slug, next.version);
            } catch {
                return; // offline: conservar la hoja actual
            }
            const current = document.getElementById("wjs-theme-stylesheet") as HTMLLinkElement | null;
            if (!current || current.getAttribute("href") === href) return;
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = href;
            link.onload = () => {
                link.onload = null;
                link.onerror = null;
                current.remove();
                link.id = "wjs-theme-stylesheet";
            };
            link.onerror = () => {
                link.onload = null;
                link.onerror = null;
                link.remove(); // hoja rota: el tema actual se queda
            };
            current.after(link);
        };
        const timer = setInterval(() => {
            void tick();
        }, 10_000);
        return () => clearInterval(timer);
    }, [theme]);

    return (
        <>
            <link id="wjs-ui-framework" rel="stylesheet" href={uiFrameworkHref()} />
            {theme && (
                <link
                    id="wjs-theme-stylesheet"
                    rel="stylesheet"
                    href={themeStylesheetHref(theme.slug, theme.version)}
                />
            )}
            <style id="wjs-canvas-doc-contract" dangerouslySetInnerHTML={{ __html: DOC_CONTRACT_CSS }} />
            <style id="wjs-preview-scrollbar" dangerouslySetInnerHTML={{ __html: THIN_SCROLLBAR_CSS }} />
            <div id={VERSO_CANVAS_ROOT_ID} />
        </>
    );
}
