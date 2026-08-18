"use client";

/**
 * HERRAMIENTAS (/admin/tools) — la mitad de EXPORTACIÓN del contrato de «sin secuestro de datos».
 *
 * La importación ya tenía pantalla (/admin/import); GET /export y GET /export/wxr estaban completos
 * en el backend (backend/src/routes/export.ts, `authenticate + isAdmin`) y no había un solo botón que
 * los alcanzara. Esto es ese botón, con los interruptores que el JSON acepta.
 *
 * La descarga es una NAVEGACIÓN (exportApi.downloadJson/downloadWxr ponen window.location), no un
 * fetch+blob: la cookie de sesión HttpOnly viaja sola en un GET de primer nivel y el navegador
 * guarda el fichero sin que nadie tenga que meterse un sitio entero en memoria. Por eso aquí no hay
 * barra de progreso ni estado de «descargando»: esta página deja de mandar en cuanto navega.
 */

import React, { useState } from "react";
import Link from "next/link";
import { exportApi } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { registerTranslations } from "@/lib/i18n";
import { PageHeader, Card, EmptyState, Button } from "@/components/ui";
import {
    EXPORT_SECTIONS,
    ExportSection,
    defaultExportToggles,
    hasAnySection,
    includedSections,
    toggleSection,
    togglesToExportOptions,
} from "./exportLogic";

registerTranslations({
    es: {
        "tools.title": "Herramientas",
        "tools.subtitle": "Exportar e importar el contenido del sitio",
        "tools.export.title": "Exportar en JSON",
        "tools.export.description": "Un único fichero con el contenido del sitio, para copia de seguridad o para llevártelo a otra instalación de WordJS.",
        "tools.export.include": "Qué incluir",
        "tools.export.summary": "Te llevarás",
        "tools.export.nothing": "Enciende al menos una sección para poder exportar.",
        "tools.export.button": "Descargar wordjs-export.json",
        "tools.export.started": "La descarga del export en JSON ha empezado",
        "tools.wxr.title": "Exportar en WXR (WordPress)",
        "tools.wxr.description": "El formato XML que WordPress entiende (Herramientas → Importar). Sin opciones: incluye entradas, páginas, categorías, etiquetas y autores.",
        "tools.wxr.button": "Descargar wordjs-export.xml",
        "tools.wxr.started": "La descarga del export en WXR ha empezado",
        "tools.import.title": "Importar desde WordPress",
        "tools.import.description": "¿Vienes de WordPress? Sube ahí tu fichero WXR y tráete entradas, páginas, categorías, etiquetas, autores y comentarios.",
        "tools.import.button": "Ir a la importación",
        "tools.section.posts": "Entradas",
        "tools.section.pages": "Páginas",
        "tools.section.media": "Medios",
        "tools.section.menus": "Menús",
        "tools.section.settings": "Ajustes",
        "tools.section.users": "Usuarios",
        "tools.section.usersHint": "Apagado por defecto: un export con filas de usuarios es un fichero delicado.",
        "tools.forbiddenTitle": "Acceso restringido",
        "tools.forbiddenDescription": "Exportar el sitio es exclusivo de administradores.",
    },
    en: {
        "tools.title": "Tools",
        "tools.subtitle": "Export and import the site's content",
        "tools.export.title": "Export as JSON",
        "tools.export.description": "A single file with the site's content, for a backup or to take it to another WordJS install.",
        "tools.export.include": "What to include",
        "tools.export.summary": "You will take",
        "tools.export.nothing": "Turn on at least one section to be able to export.",
        "tools.export.button": "Download wordjs-export.json",
        "tools.export.started": "The JSON export download has started",
        "tools.wxr.title": "Export as WXR (WordPress)",
        "tools.wxr.description": "The XML format WordPress understands (Tools → Import). No options: it includes posts, pages, categories, tags and authors.",
        "tools.wxr.button": "Download wordjs-export.xml",
        "tools.wxr.started": "The WXR export download has started",
        "tools.import.title": "Import from WordPress",
        "tools.import.description": "Coming from WordPress? Upload your WXR file there and bring over posts, pages, categories, tags, authors and comments.",
        "tools.import.button": "Go to the importer",
        "tools.section.posts": "Posts",
        "tools.section.pages": "Pages",
        "tools.section.media": "Media",
        "tools.section.menus": "Menus",
        "tools.section.settings": "Settings",
        "tools.section.users": "Users",
        "tools.section.usersHint": "Off by default: an export carrying user rows is a sensitive file.",
        "tools.forbiddenTitle": "Access restricted",
        "tools.forbiddenDescription": "Exporting the site is administrators-only.",
    },
    pt: {
        "tools.title": "Ferramentas",
        "tools.subtitle": "Exportar e importar o conteúdo do site",
        "tools.export.title": "Exportar em JSON",
        "tools.export.description": "Um único ficheiro com o conteúdo do site, para cópia de segurança ou para levar a outra instalação do WordJS.",
        "tools.export.include": "O que incluir",
        "tools.export.summary": "Você vai levar",
        "tools.export.nothing": "Ative pelo menos uma seção para poder exportar.",
        "tools.export.button": "Baixar wordjs-export.json",
        "tools.export.started": "O download do export em JSON começou",
        "tools.wxr.title": "Exportar em WXR (WordPress)",
        "tools.wxr.description": "O formato XML que o WordPress entende (Ferramentas → Importar). Sem opções: inclui publicações, páginas, categorias, etiquetas e autores.",
        "tools.wxr.button": "Baixar wordjs-export.xml",
        "tools.wxr.started": "O download do export em WXR começou",
        "tools.import.title": "Importar do WordPress",
        "tools.import.description": "Vem do WordPress? Envie lá o seu ficheiro WXR e traga publicações, páginas, categorias, etiquetas, autores e comentários.",
        "tools.import.button": "Ir para a importação",
        "tools.section.posts": "Publicações",
        "tools.section.pages": "Páginas",
        "tools.section.media": "Mídia",
        "tools.section.menus": "Menus",
        "tools.section.settings": "Ajustes",
        "tools.section.users": "Usuários",
        "tools.section.usersHint": "Desligado por padrão: um export com linhas de usuários é um ficheiro delicado.",
        "tools.forbiddenTitle": "Acesso restrito",
        "tools.forbiddenDescription": "Exportar o site é exclusivo de administradores.",
    },
});

/** Icono por sección. Mapa CERRADO sobre el tipo, no una cadena libre. */
const SECTION_ICON: Record<ExportSection, string> = {
    posts: "fa-pen-to-square",
    pages: "fa-file-lines",
    media: "fa-images",
    menus: "fa-bars",
    settings: "fa-gear",
    users: "fa-users",
};

export default function ToolsPage() {
    const { user } = useAuth();
    const { addToast } = useToast();
    const { t } = useI18n();

    const [toggles, setToggles] = useState(defaultExportToggles());

    // Mismo gate que el backend: middleware/permissions.isAdmin mira el ROL. Mientras `user` es null
    // aún estamos cargando la sesión y no se decide nada.
    const forbidden = !!user && user.role !== "administrator";

    const canExport = hasAnySection(toggles);
    const chosen = includedSections(toggles);

    const downloadJson = () => {
        if (!canExport) return;
        exportApi.downloadJson(togglesToExportOptions(toggles));
        addToast(t("tools.export.started"), "info");
    };

    const downloadWxr = () => {
        exportApi.downloadWxr();
        addToast(t("tools.wxr.started"), "info");
    };

    if (forbidden) {
        return (
            <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
                <PageHeader title={t("tools.title")} subtitle={t("tools.subtitle")} icon="fa-screwdriver-wrench" />
                <Card variant="default" padding="none">
                    <EmptyState icon="fa-lock" title={t("tools.forbiddenTitle")} description={t("tools.forbiddenDescription")} />
                </Card>
            </div>
        );
    }

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader title={t("tools.title")} subtitle={t("tools.subtitle")} icon="fa-screwdriver-wrench" />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Export JSON, con sus interruptores */}
                <Card variant="default" padding="lg" className="lg:col-span-2">
                    <div className="flex items-start gap-4 mb-6">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 text-blue-600 flex items-center justify-center text-xl shrink-0">
                            <i className="fa-solid fa-file-arrow-down"></i>
                        </div>
                        <div>
                            <h2 className="text-lg font-black text-gray-800 tracking-tight">{t("tools.export.title")}</h2>
                            <p className="text-sm text-gray-500 mt-1 leading-relaxed">{t("tools.export.description")}</p>
                        </div>
                    </div>

                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4">{t("tools.export.include")}</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                        {EXPORT_SECTIONS.map((section) => {
                            const on = toggles[section];
                            return (
                                <label
                                    key={section}
                                    className={`flex items-start gap-3 px-4 py-3.5 rounded-2xl border-2 cursor-pointer transition-all ${
                                        on ? "border-blue-500 bg-blue-50/40" : "border-gray-100 bg-gray-50/50 hover:border-blue-200"
                                    }`}
                                >
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={() => setToggles((prev) => toggleSection(prev, section))}
                                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    <span className="min-w-0">
                                        <span className="flex items-center gap-2 text-sm font-bold text-gray-700">
                                            <i className={`fa-solid ${SECTION_ICON[section]} text-gray-300`}></i>
                                            {t(`tools.section.${section}`)}
                                        </span>
                                        {section === "users" && (
                                            <span className="block text-[11px] text-gray-400 mt-1 leading-snug">{t("tools.section.usersHint")}</span>
                                        )}
                                    </span>
                                </label>
                            );
                        })}
                    </div>

                    {canExport ? (
                        <p className="text-xs text-gray-400 mb-6">
                            <span className="font-bold uppercase tracking-widest text-[10px] text-gray-400">{t("tools.export.summary")}:</span>{" "}
                            {chosen.map((section) => t(`tools.section.${section}`)).join(" · ")}
                        </p>
                    ) : (
                        <p className="text-xs text-amber-600 mb-6 flex items-center gap-2">
                            <i className="fa-solid fa-triangle-exclamation"></i>
                            {t("tools.export.nothing")}
                        </p>
                    )}

                    <Button icon="fa-download" onClick={downloadJson} disabled={!canExport}>
                        {t("tools.export.button")}
                    </Button>
                </Card>

                <div className="space-y-8">
                    {/* Export WXR */}
                    <Card variant="default" padding="lg">
                        <div className="flex items-start gap-4 mb-5">
                            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-50 to-blue-50 text-indigo-600 flex items-center justify-center text-xl shrink-0">
                                <i className="fa-brands fa-wordpress"></i>
                            </div>
                            <div>
                                <h2 className="text-lg font-black text-gray-800 tracking-tight">{t("tools.wxr.title")}</h2>
                                <p className="text-sm text-gray-500 mt-1 leading-relaxed">{t("tools.wxr.description")}</p>
                            </div>
                        </div>
                        <Button variant="secondary" icon="fa-download" onClick={downloadWxr} className="w-full">
                            {t("tools.wxr.button")}
                        </Button>
                    </Card>

                    {/* La otra mitad, que ya existía */}
                    <Card variant="default" padding="lg">
                        <div className="flex items-start gap-4 mb-5">
                            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-gray-50 to-gray-100 text-gray-500 flex items-center justify-center text-xl shrink-0">
                                <i className="fa-solid fa-file-import"></i>
                            </div>
                            <div>
                                <h2 className="text-lg font-black text-gray-800 tracking-tight">{t("tools.import.title")}</h2>
                                <p className="text-sm text-gray-500 mt-1 leading-relaxed">{t("tools.import.description")}</p>
                            </div>
                        </div>
                        <Link
                            href="/admin/import"
                            className="inline-flex items-center justify-center gap-2 w-full px-6 py-3 rounded-xl bg-white border-2 border-gray-100 text-gray-600 hover:border-blue-500 hover:text-blue-600 shadow-sm font-black uppercase tracking-widest text-[10px] transition-all"
                        >
                            <i className="fa-solid fa-arrow-right"></i>
                            {t("tools.import.button")}
                        </Link>
                    </Card>
                </div>
            </div>
        </div>
    );
}
