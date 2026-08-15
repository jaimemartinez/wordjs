"use client";
/**
 * Verso — documento MÍNIMO del iframe del canvas (F2).
 *
 * Este documento NO renderiza contenido propio: expone `#verso-canvas-root` y el
 * PADRE (FrameController) portalea el árbol del editor dentro — mismo árbol React,
 * el contexto del EditorHandle fluye a través del portal. Aquí no hay JS de editor.
 *
 * CSS del canvas (WYSIWYG, mismas URLs que el editor actual — PuckEditor.tsx L507-508
 * y el ThemeLoader público, vía los helpers compartidos de lib/assetVersion):
 * - /public/css/wordjs-ui.css?v=<ASSET_VERSION>  (uiFrameworkHref)
 * - /themes/<slug>/style.css?v=<slug>-<version>-<ASSET_VERSION>  (themeStylesheetHref)
 *   El slug/version activos se resuelven igual que PuckEditor: themesApi.list() y
 *   fallback a "default" si la petición falla (nunca quedar sin link).
 * El <link> del tema lleva id="wjs-theme-stylesheet": FrameController.swapThemeCss lo
 * reemplaza esperando el onload del nuevo antes de retirar el viejo (sin FOUC). Tras
 * el primer render este componente ya no re-renderiza el link, así que la retirada
 * imperativa no entra en conflicto con React.
 *
 * CONTRATO DE DOCUMENTO (lección del editor actual, PuckEditor L446-456): el tema y
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

interface ActiveTheme {
    slug: string;
    version: string;
}

export default function CanvasFramePage() {
    const [theme, setTheme] = React.useState<ActiveTheme | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        themesApi
            .list()
            .then((list) => {
                if (cancelled) return;
                const active = list.find((t) => t.active) || list.find((t) => t.slug === "default");
                setTheme({ slug: active?.slug || "default", version: active?.version || "" });
            })
            .catch(() => {
                // Offline/error: nunca quedar sin hoja de tema (mismo fallback que PuckEditor).
                if (!cancelled) setTheme({ slug: "default", version: "" });
            });
        return () => {
            cancelled = true;
        };
    }, []);

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
            <div id={VERSO_CANVAS_ROOT_ID} />
        </>
    );
}
