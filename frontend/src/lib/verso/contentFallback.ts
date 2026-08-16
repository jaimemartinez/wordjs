/**
 * Verso — regeneración del `content` HTML de fallback a partir de los bloques (F3).
 *
 * Réplica EXACTA (byte a byte, whitespace del template literal incluido) del switch inline del
 * onChange de admin/pages/[id]/page.tsx — la fuente canónica: pages soporta los 7 tipos
 * Heading/Text/Image/Button/Card/Divider/HTMLEmbed con las clases de bloque.
 *
 * Las clases salen de `bc()` (el punto único de emisión), así que este HTML de fallback lleva la
 * identidad propia y el alias histórico igual que el render de bloques: `wjs-block-heading
 * wp-block-heading`. Los tests de este módulo fijan la cadena exacta a propósito.
 *
 * DECISIÓN RATIFICADA (F3, checklist W47): la divergencia documentada entre pages y posts (posts
 * solo serializaba Heading/Text/Image/HTMLEmbed, y SIN las clases wp-block-*) era drift accidental,
 * no diseño — se resuelve hacia el lado COMPLETO de pages. Ambos editores Verso (páginas y
 * entradas) usan este único módulo; el editor legacy conserva sus switches inline intactos
 * (mandato: la rama legacy queda byte-idéntica a hoy).
 *
 * El HTML emitido es un FALLBACK para el campo legacy `content` (lectores sin _puck_data, RSS,
 * excerpts); se sanea una vez en el servidor al guardar, igual que hoy. Tipos no listados se
 * omiten — exactamente el comportamiento del switch actual.
 */

import { bc } from "@/components/blocks/blockVars";

/** Forma mínima de un item de contenido (compatible con VersoItem y con el Data de Puck). */
export interface FallbackContentItem {
    type: string;
    props: Record<string, unknown>;
}

/**
 * Serializa los bloques de primer nivel al HTML plano del campo `content`.
 * Salida byte-idéntica al switch de admin/pages/[id]/page.tsx para los 7 tipos soportados.
 */
export function serializeContentFallback(content: FallbackContentItem[]): string {
    let html = "";
    content.forEach((item) => {
        const props = item.props as any;
        if (item.type === 'Heading') {
            html += `<${props.level} class="${bc('heading')} font-bold my-4">${props.title}</${props.level}>`;
        } else if (item.type === 'Text') {
            html += `<div class="${bc('text')} prose">${props.content}</div>`;
        } else if (item.type === 'Image') {
            html += `<img src="${props.src}" alt="${props.alt}" class="${bc('image')} max-w-full my-4 rounded shadow-sm"/>`;
        } else if (item.type === 'Button') {
            const alignClass = props.align === 'center' ? 'text-center' : props.align === 'right' ? 'text-right' : 'text-left';
            html += `<div class="${bc('button')} my-6 ${alignClass}"><a href="${props.href}" class="wp-button button-${props.variant}">${props.label}</a></div>`;
        } else if (item.type === 'Card') {
            // OJO: el whitespace interior (saltos de línea + 32/36 espacios) es parte del contrato
            // byte-a-byte con el switch original de pages/[id] — no "arreglar" la indentación.
            html += `
                                <div class="${bc('card')} card-theme-${props.theme} p-8 rounded-3xl border my-6">
                                    ${props.icon ? `<i class="fa-solid ${props.icon} text-2xl mb-4"></i>` : ''}
                                    <h3 class="text-xl font-bold mb-2">${props.title}</h3>
                                    <p class="opacity-80">${props.description}</p>
                                </div>`;
        } else if (item.type === 'Divider') {
            html += `<hr class="${bc('divider')} divider-${props.type} my-10 border-gray-100" />`;
        } else if (item.type === 'HTMLEmbed') {
            // Legacy/custom HTML block: emit its raw HTML verbatim so a legacy page's body
            // round-trips into `content` unchanged (sanitized once on save, server-side).
            html += props.html || '';
        }
    });
    return html;
}
