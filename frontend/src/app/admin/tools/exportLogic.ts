/**
 * Lógica PURA de /admin/tools (exportación del sitio).
 *
 * Traduce los interruptores de la pantalla al `ExportOptions` que `buildExportQuery` (lib/api.ts)
 * sabe convertir en query string. Ese mapeo NO es trivial y por eso vive aquí, probado en node:
 *
 *   - El backend (backend/src/routes/export.ts) incluye POR DEFECTO media/posts/pages/settings/menus
 *     (`req.query.X !== 'false'`), así que solo se manda lo que el admin quiere DEJAR FUERA.
 *   - `users` es lo contrario: opt-IN (`req.query.users === 'true'`), porque un export con filas de
 *     usuarios es otro tipo de fichero. Arranca APAGADO.
 *
 * Aquí no se construye ninguna URL: quien navega es exportApi.downloadJson/downloadWxr.
 */

import type { ExportOptions } from "@/lib/api";

/** Las secciones que el export JSON sabe incluir o dejar fuera. */
export const EXPORT_SECTIONS = ["posts", "pages", "media", "menus", "settings", "users"] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

/** El estado de los interruptores tal cual se ve en pantalla. */
export type ExportToggles = Record<ExportSection, boolean>;

/**
 * El estado inicial: exactamente los valores por defecto del backend. Que la pantalla arranque
 * mostrando otra cosa sería mentirle al admin sobre lo que va a descargar si no toca nada.
 */
export function defaultExportToggles(): ExportToggles {
    return { posts: true, pages: true, media: true, menus: true, settings: true, users: false };
}

/**
 * Interruptores → `ExportOptions`. Se manda el estado COMPLETO y explícito: `buildExportQuery` ya se
 * encarga de emitir solo lo que difiere del defecto del servidor, y así este módulo no tiene que
 * conocer dos veces la misma regla.
 */
export function togglesToExportOptions(toggles: ExportToggles): ExportOptions {
    return {
        posts: !!toggles.posts,
        pages: !!toggles.pages,
        media: !!toggles.media,
        menus: !!toggles.menus,
        settings: !!toggles.settings,
        users: !!toggles.users,
    };
}

/**
 * ¿Tiene sentido descargar esto? Un export con TODO apagado es un fichero con la cabecera y nada
 * dentro: se bloquea el botón en vez de dejar que el admin se lleve un envoltorio vacío.
 */
export function hasAnySection(toggles: ExportToggles): boolean {
    return EXPORT_SECTIONS.some((section) => toggles[section]);
}

/**
 * Las secciones ENCENDIDAS, en el orden declarado — el resumen que la pantalla enseña antes de
 * descargar ("vas a llevarte: entradas, páginas…").
 */
export function includedSections(toggles: ExportToggles): ExportSection[] {
    return EXPORT_SECTIONS.filter((section) => toggles[section]);
}

/** Alterna una sección devolviendo un objeto NUEVO (el estado de React nunca se muta en sitio). */
export function toggleSection(toggles: ExportToggles, section: ExportSection): ExportToggles {
    return { ...toggles, [section]: !toggles[section] };
}
