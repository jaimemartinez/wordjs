// @ts-nocheck
"use client";

// The Image Lightbox admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // header
    'app.title': 'Lightbox de imágenes',
    'app.subtitle': 'Clic para ampliar las imágenes del contenido en todo el sitio',
    'status.on': 'Activado',
    'status.off': 'Desactivado',
    // settings
    'enabled.label': 'Activar el lightbox',
    'enabled.help': 'Al hacer clic en una imagen del contenido se abre ampliada sobre un fondo oscuro, con flechas y teclado (← → Esc).',
    'captions.label': 'Mostrar leyendas',
    'captions.help': 'Usa el texto alternativo (alt) de la imagen como leyenda debajo de la vista ampliada.',
    'scope.label': 'Selector de ámbito (CSS)',
    'scope.help1': 'Solo las imágenes dentro de elementos que coincidan con este selector abren el lightbox (se admiten varios selectores separados por comas). El tema envuelve el contenido público en ',
    'scope.help2': ', el valor por defecto. Si el selector no coincide con nada en la página, el script usa ',
    'scope.help3': ' como respaldo. Se ignoran las imágenes pequeñas (<100px), las de la cabecera/menú/pie y las que enlazan a otras páginas.',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    // client-side validation and save results
    'error.scopeEmpty': 'Error: el selector de ámbito no puede estar vacío.',
    'error.scopeTooLong': 'Error: el selector de ámbito no puede superar los {max} caracteres.',
    'error.scopeLt': 'Error: el selector de ámbito no puede contener el carácter "<".',
    'error.save': 'Error al guardar: {msg}',
    'saved': 'Guardado — los cambios se aplican en la próxima carga de las páginas públicas.',
    // demo
    'demo.title': 'Demostración',
    'demo.help': 'Haz clic en una miniatura para ver el efecto tal y como se comporta en el sitio público (flechas, teclado ← → Esc, clic en el fondo para cerrar).',
    'demo.coast': 'Costa al atardecer',
    'demo.mountains': 'Montañas al amanecer',
    'demo.alt': '{label} — imagen de demostración',
    'viewer.label': 'Visor de imagen (demostración)',
    'viewer.prev': 'Imagen anterior',
    'viewer.next': 'Imagen siguiente',
    'viewer.close': 'Cerrar',
};

const en = {
    // header
    'app.title': 'Image lightbox',
    'app.subtitle': 'Click to enlarge content images across the whole site',
    'status.on': 'Enabled',
    'status.off': 'Disabled',
    // settings
    'enabled.label': 'Enable the lightbox',
    'enabled.help': 'Clicking an image in the content opens it enlarged over a dark backdrop, with arrows and keyboard support (← → Esc).',
    'captions.label': 'Show captions',
    'captions.help': "Uses the image's alternative text (alt) as a caption below the enlarged view.",
    'scope.label': 'Scope selector (CSS)',
    'scope.help1': 'Only images inside elements matching this selector open the lightbox (several comma-separated selectors are allowed). The theme wraps public content in ',
    'scope.help2': ', the default value. If the selector matches nothing on the page, the script falls back to ',
    'scope.help3': '. Small images (<100px), images in the header/menu/footer and images that link to other pages are ignored.',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    // client-side validation and save results
    'error.scopeEmpty': 'Error: the scope selector cannot be empty.',
    'error.scopeTooLong': 'Error: the scope selector cannot be longer than {max} characters.',
    'error.scopeLt': 'Error: the scope selector cannot contain the "<" character.',
    'error.save': 'Error saving: {msg}',
    'saved': 'Saved — changes apply the next time public pages load.',
    // demo
    'demo.title': 'Demo',
    'demo.help': 'Click a thumbnail to see the effect exactly as it behaves on the public site (arrows, keyboard ← → Esc, click the backdrop to close).',
    'demo.coast': 'Coast at sunset',
    'demo.mountains': 'Mountains at sunrise',
    'demo.alt': '{label} — demo image',
    'viewer.label': 'Image viewer (demo)',
    'viewer.prev': 'Previous image',
    'viewer.next': 'Next image',
    'viewer.close': 'Close',
};

const pt = {
    // header
    'app.title': 'Lightbox de imagens',
    'app.subtitle': 'Clique para ampliar as imagens do conteúdo em todo o site',
    'status.on': 'Ativado',
    'status.off': 'Desativado',
    // settings
    'enabled.label': 'Ativar o lightbox',
    'enabled.help': 'Ao clicar em uma imagem do conteúdo, ela se abre ampliada sobre um fundo escuro, com setas e teclado (← → Esc).',
    'captions.label': 'Mostrar legendas',
    'captions.help': 'Usa o texto alternativo (alt) da imagem como legenda abaixo da visualização ampliada.',
    'scope.label': 'Seletor de escopo (CSS)',
    'scope.help1': 'Somente as imagens dentro de elementos que correspondam a este seletor abrem o lightbox (é possível usar vários seletores separados por vírgulas). O tema envolve o conteúdo público em ',
    'scope.help2': ', o valor padrão. Se o seletor não corresponder a nada na página, o script usa ',
    'scope.help3': ' como alternativa. São ignoradas as imagens pequenas (<100px), as do cabeçalho/menu/rodapé e as que apontam para outras páginas.',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    // client-side validation and save results
    'error.scopeEmpty': 'Erro: o seletor de escopo não pode ficar vazio.',
    'error.scopeTooLong': 'Erro: o seletor de escopo não pode ter mais de {max} caracteres.',
    'error.scopeLt': 'Erro: o seletor de escopo não pode conter o caractere "<".',
    'error.save': 'Erro ao salvar: {msg}',
    'saved': 'Salvo — as alterações são aplicadas no próximo carregamento das páginas públicas.',
    // demo
    'demo.title': 'Demonstração',
    'demo.help': 'Clique em uma miniatura para ver o efeito exatamente como se comporta no site público (setas, teclado ← → Esc, clique no fundo para fechar).',
    'demo.coast': 'Costa ao entardecer',
    'demo.mountains': 'Montanhas ao amanhecer',
    'demo.alt': '{label} — imagem de demonstração',
    'viewer.label': 'Visualizador de imagem (demonstração)',
    'viewer.prev': 'Imagem anterior',
    'viewer.next': 'Próxima imagem',
    'viewer.close': 'Fechar',
};

const TABLES = { es, en, pt };
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' };

export function translate(lang, key, vars) {
    const table = TABLES[lang] || es;
    let s = table[key] ?? en[key] ?? key;
    if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
    return s;
}

/** The current admin language and a `t(key, vars)` bound to it. */
export function useT() {
    const ctx = useOptionalI18n ? useOptionalI18n() : null;
    let lang = ctx?.language;
    if (!lang && typeof document !== 'undefined') lang = document.documentElement.lang || '';
    lang = String(lang || '').slice(0, 2).toLowerCase();
    if (lang !== 'es' && lang !== 'en' && lang !== 'pt') lang = 'es';
    const t = (key, vars) => translate(lang, key, vars);
    return { t, lang, locale: LOCALES[lang] };
}
