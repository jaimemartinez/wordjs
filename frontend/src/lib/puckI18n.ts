/**
 * Puck editor i18n — reactive localization of the visual-builder config.
 *
 * The Puck block config (`components`, `categories`, field labels) is built once at module load
 * in puckConfig.tsx, so its labels never changed when the admin switched language. This module
 * fixes that: `localizeConfig(config, lang)` returns a copy of the config with every editor-chrome
 * string (category names, block + root field labels/placeholders, select-option labels) translated
 * to `lang` — and it matches on ANY of the three source languages, so it also normalizes the
 * historically-mixed es/en labels. Apply it reactively in the editor via `useMemo([language])`:
 * passing a NEW config object is enough for Puck to re-read the labels on a live language switch —
 * no remount / `key={language}` needed (verified in-browser; a key would needlessly reset editor state).
 *
 * Only `label`/`placeholder` string values (and category display names) are translated; render
 * functions, field keys, values, and — crucially — a block's `defaultProps` (the CONTENT an inserted
 * block starts with) are preserved untouched, so inserted content never picks up the editor's UI
 * language.
 */

import type { Language } from './i18n';

type Tri = { es: string; en: string; pt: string };

// Block + category names (mirrors the editor.block.* / editor.category.* keys in i18n.ts, which the
// config resolves once at load — listed here so localizeConfig can re-translate them reactively).
const BLOCKS_CATEGORIES: Tri[] = [
    { es: 'Diseño', en: 'Layout', pt: 'Layout' },
    { es: 'Contenido', en: 'Content', pt: 'Conteúdo' },
    { es: 'Galería de Tarjetas', en: 'Card Gallery', pt: 'Galeria de Cartões' },
    { es: 'Galería de Videos', en: 'Video Gallery', pt: 'Galeria de Vídeos' },
    { es: 'Carrusel de Fotos', en: 'Photo Carousel', pt: 'Carrossel de Fotos' },
    { es: 'Encabezado', en: 'Heading', pt: 'Cabeçalho' },
    { es: 'Texto', en: 'Text', pt: 'Texto' },
    { es: 'Imagen', en: 'Image', pt: 'Imagem' },
    { es: 'Columnas', en: 'Columns', pt: 'Colunas' },
    { es: 'Tarjeta', en: 'Card', pt: 'Cartão' },
    { es: 'Divisor', en: 'Divider', pt: 'Divisor' },
    { es: 'Botón', en: 'Button', pt: 'Botão' },
    { es: 'Espaciador', en: 'Spacer', pt: 'Espaçador' },
    { es: 'Sección', en: 'Section', pt: 'Seção' },
    { es: 'Cuadrícula', en: 'Grid', pt: 'Grade' },
    { es: 'Fila Flexible', en: 'Flex Row', pt: 'Linha Flexível' },
    { es: 'Acordeón', en: 'Accordion', pt: 'Acordeão' },
    { es: 'Pestañas', en: 'Tabs', pt: 'Abas' },
    { es: 'Video Incrustado', en: 'Video Embed', pt: 'Vídeo Incorporado' },
    { es: 'Reproductor de Audio', en: 'Audio Player', pt: 'Reprodutor de Áudio' },
    { es: 'Tabla de Precios', en: 'Pricing Table', pt: 'Tabela de Preços' },
    { es: 'Testimonio', en: 'Testimonial', pt: 'Depoimento' },
    { es: 'Banner CTA', en: 'CTA Banner', pt: 'Banner CTA' },
    { es: 'Cuadrícula de Publicaciones', en: 'Posts Grid', pt: 'Grade de Publicações' },
    { es: 'Publicaciones por Categoría', en: 'Category Posts', pt: 'Publicações por Categoria' },
    { es: 'Barra de Búsqueda', en: 'Search Bar', pt: 'Barra de Pesquisa' },
];

// Field labels, placeholders and option labels (filled by the i18n translation pass). Kept in one
// place so translations stay consistent and the config file stays free of scattered t() calls.
const FIELD_STRINGS: Tri[] = [
    { es: "2 Columnas", en: "2 Columns", pt: "2 Colunas" },
    { es: "3 Columnas", en: "3 Columns", pt: "3 Colunas" },
    { es: "4 Columnas", en: "4 Columns", pt: "4 Colunas" },
    { es: "5 Columnas", en: "5 Columns", pt: "5 Colunas" },
    { es: "6 Columnas", en: "6 Columns", pt: "6 Colunas" },
    { es: "Acento", en: "Accent", pt: "Destaque" },
    { es: "Elementos del acordeón", en: "Accordion Items", pt: "Itens do acordeão" },
    { es: "Alinear elementos", en: "Align Items", pt: "Alinhar itens" },
    { es: "Alineación", en: "Alignment", pt: "Alinhamento" },
    { es: "Permitir comentarios", en: "Allow Comments", pt: "Permitir comentários" },
    { es: "Altura", en: "Height", pt: "Altura" },
    { es: "Relación de aspecto", en: "Aspect Ratio", pt: "Proporção" },
    { es: "URL de audio", en: "Audio URL", pt: "URL do áudio" },
    { es: "Nombre del autor", en: "Author Name", pt: "Nome do autor" },
    { es: "Autor / fuente", en: "Author / source", pt: "Autor / fonte" },
    { es: "URL del avatar", en: "Avatar URL", pt: "URL do avatar" },
    { es: "Barra lateral", en: "Sidebar", pt: "Barra lateral" },
    { es: "Botones", en: "Buttons", pt: "Botões" },
    { es: "Enlace del botón", en: "Button Link", pt: "Link do botão" },
    { es: "Texto del botón", en: "Button Text", pt: "Texto do botão" },
    { es: "Texto del botón (déjalo vacío para solo icono)", en: "Button Text (leave empty for icon only)", pt: "Texto do botão (deixe vazio para apenas ícone)" },
    { es: "Cabecera (columnas separadas por | )", en: "Header (columns separated by | )", pt: "Cabeçalho (colunas separadas por | )" },
    { es: "Categoría", en: "Category", pt: "Categoria" },
    { es: "Slug de categoría", en: "Category Slug", pt: "Slug da categoria" },
    { es: "Celdas (separadas por | )", en: "Cells (separated by | )", pt: "Células (separadas por | )" },
    { es: "Centro", en: "Center", pt: "Centro" },
    { es: "Cifras", en: "Figures", pt: "Números" },
    { es: "Cita", en: "Quote", pt: "Citação" },
    { es: "Haz clic", en: "Click Me", pt: "Clique aqui" },
    { es: "Clientes", en: "Clients", pt: "Clientes" },
    { es: "Columnas", en: "Columns", pt: "Colunas" },
    { es: "Compacto (40vh)", en: "Compact (40vh)", pt: "Compacto (40vh)" },
    { es: "Contorno", en: "Outline", pt: "Contorno" },
    { es: "Código HTML", en: "HTML Code", pt: "Código HTML" },
    { es: "Oscuro", en: "Dark", pt: "Escuro" },
    { es: "Discontinuo", en: "Dashed", pt: "Tracejado" },
    { es: "Derecha", en: "Right", pt: "Direita" },
    { es: "Descripción", en: "Description", pt: "Descrição" },
    { es: "Distribución de columnas", en: "Column Distribution", pt: "Distribuição de colunas" },
    { es: "Elementos", en: "Items", pt: "Itens" },
    { es: "Fin", en: "End", pt: "Fim" },
    { es: "Enlace", en: "Link", pt: "Link" },
    { es: "Estilo", en: "Style", pt: "Estilo" },
    { es: "Estilos CSS", en: "CSS Styles", pt: "Estilos CSS" },
    { es: "Estilos de columnas", en: "Column Styles", pt: "Estilos de colunas" },
    { es: "Etiqueta", en: "Label", pt: "Rótulo" },
    { es: "Filas", en: "Rows", pt: "Linhas" },
    { es: "Filas alternas", en: "Alternating Rows", pt: "Linhas alternadas" },
    { es: "Icono FontAwesome (p. ej. fa-star)", en: "FontAwesome Icon (e.g. fa-star)", pt: "Ícone FontAwesome (ex. fa-star)" },
    { es: "Fuerte (70%)", en: "Strong (70%)", pt: "Forte (70%)" },
    { es: "Completo", en: "Full", pt: "Completo" },
    { es: "Ancho completo", en: "Full Width", pt: "Largura total" },
    { es: "Espaciado (p. ej. 16px)", en: "Gap (e.g. 16px)", pt: "Espaçamento (ex. 16px)" },
    { es: "Espaciado (p. ej. 20px)", en: "Gap (e.g. 20px)", pt: "Espaçamento (ex. 20px)" },
    { es: "Gradiente", en: "Gradient", pt: "Gradiente" },
    { es: "Grande (80vh)", en: "Large (80vh)", pt: "Grande (80vh)" },
    { es: "Grande centrada", en: "Large Centered", pt: "Grande centralizada" },
    { es: "ID / Ancla (opcional)", en: "ID / Anchor (optional)", pt: "ID / Âncora (opcional)" },
    { es: "Icono FontAwesome (fa-check)", en: "FontAwesome Icon (fa-check)", pt: "Ícone FontAwesome (fa-check)" },
    { es: "Imagen de fondo", en: "Background Image", pt: "Imagem de fundo" },
    { es: "Izquierda", en: "Left", pt: "Esquerda" },
    { es: "Justificar contenido", en: "Justify Content", pt: "Justificar conteúdo" },
    { es: "Grande (1280px)", en: "Large (1280px)", pt: "Grande (1280px)" },
    { es: "Grande (700px)", en: "Large (700px)", pt: "Grande (700px)" },
    { es: "Claro", en: "Light", pt: "Claro" },
    { es: "Lista", en: "List", pt: "Lista" },
    { es: "Lista con iconos", en: "List with Icons", pt: "Lista com ícones" },
    { es: "Ancho máximo", en: "Max Width", pt: "Largura máxima" },
    { es: "Media (50%)", en: "Medium (50%)", pt: "Médio (50%)" },
    { es: "Medio (60vh)", en: "Medium (60vh)", pt: "Médio (60vh)" },
    { es: "Medio (1024px)", en: "Medium (1024px)", pt: "Médio (1024px)" },
    { es: "Medio (500px)", en: "Medium (500px)", pt: "Médio (500px)" },
    { es: "No", en: "No", pt: "Não" },
    { es: "No (Indexable)", en: "No (Indexable)", pt: "Não (Indexável)" },
    { es: "Número de entradas", en: "Number of Posts", pt: "Número de posts" },
    { es: "Oscurecer fondo", en: "Darken Background", pt: "Escurecer fundo" },
    { es: "Pantalla completa", en: "Full Screen", pt: "Tela cheia" },
    { es: "Texto de marcador de posición", en: "Placeholder Text", pt: "Texto de espaço reservado" },
    { es: "Planes", en: "Plans", pt: "Planos" },
    { es: "Primario", en: "Primary", pt: "Primário" },
    { es: "Red", en: "Network", pt: "Rede" },
    { es: "Redes", en: "Networks", pt: "Redes" },
    { es: "Redes sociales", en: "Social Networks", pt: "Redes sociais" },
    { es: "Cargo / Empresa", en: "Role / Company", pt: "Cargo / Empresa" },
    { es: "Satisfacción", en: "Satisfaction", pt: "Satisfação" },
    { es: "URL de la página de resultados de búsqueda", en: "Search Results Page URL", pt: "URL da página de resultados de pesquisa" },
    { es: "Buscar...", en: "Search...", pt: "Pesquisar..." },
    { es: "Secundario", en: "Secondary", pt: "Secundário" },
    { es: "Seleccionar categoría", en: "Select Category", pt: "Selecionar categoria" },
    { es: "Sin capa", en: "No Overlay", pt: "Sem camada" },
    { es: "Slug (Enlace permanente)", en: "Slug (Permalink)", pt: "Slug (Link permanente)" },
    { es: "Pequeño (300px)", en: "Small (300px)", pt: "Pequeno (300px)" },
    { es: "Pequeño (768px)", en: "Small (768px)", pt: "Pequeno (768px)" },
    { es: "Sólido", en: "Solid", pt: "Sólido" },
    { es: "Soporte", en: "Support", pt: "Suporte" },
    { es: "Espacio alrededor", en: "Space Around", pt: "Espaço ao redor" },
    { es: "Espacio entre", en: "Space Between", pt: "Espaço entre" },
    { es: "Inicio", en: "Start", pt: "Início" },
    { es: "Estirar", en: "Stretch", pt: "Esticar" },
    { es: "Suave (30%)", en: "Soft (30%)", pt: "Suave (30%)" },
    { es: "Subtítulo", en: "Subtitle", pt: "Subtítulo" },
    { es: "Sí", en: "Yes", pt: "Sim" },
    { es: "Tabla", en: "Table", pt: "Tabela" },
    { es: "Texto", en: "Text", pt: "Texto" },
    { es: "Texto alternativo (SEO / accesibilidad)", en: "Alt text (SEO / accessibility)", pt: "Texto alternativo (SEO / acessibilidade)" },
    { es: "Título", en: "Title", pt: "Título" },
    { es: "Título de la pista", en: "Track Title", pt: "Título da faixa" },
    { es: "URL del perfil", en: "Profile URL", pt: "URL do perfil" },
    { es: "Valor (ej. 1.200+)", en: "Value (e.g. 1,200+)", pt: "Valor (ex. 1.200+)" },
    { es: "URL del video (YouTube, Vimeo o directo)", en: "Video URL (YouTube, Vimeo, or direct)", pt: "URL do vídeo (YouTube, Vimeo ou direto)" },
    { es: "Ancho", en: "Width", pt: "Largura" },
    { es: "Ajustar", en: "Wrap", pt: "Quebrar" },
    { es: "Sí (Oculto)", en: "Yes (Hidden)", pt: "Sim (Oculto)" },
    { es: "🔍 Ocultar de los motores de búsqueda", en: "🔍 Hide from Search Engines", pt: "🔍 Ocultar dos mecanismos de busca" },
    { es: "🔍 Meta descripción (160 caracteres máx)", en: "🔍 Meta Description (160 chars max)", pt: "🔍 Meta descrição (160 caracteres máx)" },
    { es: "🔍 Título SEO (60 caracteres máx)", en: "🔍 SEO Title (60 chars max)", pt: "🔍 Título SEO (60 caracteres máx)" },
    { es: "🔍 URL de imagen social", en: "🔍 Social Image URL", pt: "🔍 URL da imagem social" },
];

// Editor chrome + block palette copy (BlockInserter descriptions/groups/tabs, PuckEditor toolbar &
// empty state, built-in pattern names/descriptions). Kept alongside the config strings so a single
// dictionary drives the whole visual builder. Only DISPLAY labels live here — never block content
// (a pattern's inserted text stays in the site's content language).
const CHROME_STRINGS: Tri[] = [
    // Block descriptions (subtitles under each palette item)
    { es: "Cabecera a pantalla con imagen y botones", en: "Full-screen header with image and buttons", pt: "Cabeçalho em tela cheia com imagem e botões" },
    { es: "Sección a todo el ancho", en: "Full-width section", pt: "Seção de largura total" },
    { es: "Cuadrícula responsive", en: "Responsive grid", pt: "Grade responsiva" },
    { es: "Fila flexible", en: "Flexible row", pt: "Linha flexível" },
    { es: "Espaciado vertical", en: "Vertical spacing", pt: "Espaçamento vertical" },
    { es: "Línea divisoria", en: "Divider line", pt: "Linha divisória" },
    { es: "Párrafo de texto enriquecido", en: "Rich text paragraph", pt: "Parágrafo de texto formatado" },
    { es: "Botón / llamada a la acción", en: "Button / call to action", pt: "Botão / chamada para ação" },
    { es: "Tarjeta con imagen y texto", en: "Card with image and text", pt: "Cartão com imagem e texto" },
    { es: "Acordeón / FAQ", en: "Accordion / FAQ", pt: "Acordeão / FAQ" },
    { es: "Cita destacada", en: "Featured quote", pt: "Citação em destaque" },
    { es: "Tabla de datos", en: "Data table", pt: "Tabela de dados" },
    { es: "Lista de ventajas con iconos", en: "Feature list with icons", pt: "Lista de vantagens com ícones" },
    { es: "HTML personalizado (limpio)", en: "Custom HTML (sanitized)", pt: "HTML personalizado (limpo)" },
    { es: "Video incrustado", en: "Embedded video", pt: "Vídeo incorporado" },
    { es: "Reproductor de audio", en: "Audio player", pt: "Reprodutor de áudio" },
    { es: "Galería de tarjetas", en: "Card gallery", pt: "Galeria de cartões" },
    { es: "Carrusel de fotos", en: "Photo carousel", pt: "Carrossel de fotos" },
    { es: "Galería de videos", en: "Video gallery", pt: "Galeria de vídeos" },
    { es: "Tabla de precios", en: "Pricing table", pt: "Tabela de preços" },
    { es: "Banner de conversión", en: "Conversion banner", pt: "Banner de conversão" },
    { es: "Cifras destacadas", en: "Featured figures", pt: "Números em destaque" },
    { es: "Iconos de redes sociales", en: "Social media icons", pt: "Ícones de redes sociais" },
    { es: "Cuadrícula de entradas", en: "Posts grid", pt: "Grade de publicações" },
    { es: "Entradas por categoría", en: "Posts by category", pt: "Publicações por categoria" },
    { es: "Barra de búsqueda", en: "Search bar", pt: "Barra de pesquisa" },
    // Palette group headers (Diseño/Contenido already covered by BLOCKS_CATEGORIES). "Marketing" is
    // identical across es/en/pt but listed so trStr resolves it explicitly rather than passing through.
    { es: "Medios", en: "Media", pt: "Mídia" },
    { es: "Marketing", en: "Marketing", pt: "Marketing" },
    { es: "Dinámicos", en: "Dynamic", pt: "Dinâmicos" },
    { es: "Más", en: "More", pt: "Mais" },
    // Inserter chrome
    { es: "Bloques", en: "Blocks", pt: "Blocos" },
    { es: "Plantillas", en: "Templates", pt: "Modelos" },
    { es: "Buscar bloque…", en: "Search block…", pt: "Buscar bloco…" },
    { es: "Buscar bloque", en: "Search block", pt: "Buscar bloco" },
    { es: "Limpiar", en: "Clear", pt: "Limpar" },
    { es: "Guardar como plantilla", en: "Save as template", pt: "Salvar como modelo" },
    { es: "Guardar", en: "Save", pt: "Salvar" },
    { es: "Nombre (ej. Landing base)", en: "Name (e.g. Base landing)", pt: "Nome (ex. Landing base)" },
    { es: "Captura la página actual completa para reutilizarla en otras páginas.", en: "Capture the entire current page to reuse it on other pages.", pt: "Capture a página atual completa para reutilizá-la em outras páginas." },
    { es: "Mis plantillas", en: "My templates", pt: "Meus modelos" },
    { es: "Insertar al final de la página", en: "Insert at end of page", pt: "Inserir no final da página" },
    { es: "Se añaden al final de la página. Luego puedes editarlas.", en: "They're added at the end of the page. You can edit them afterwards.", pt: "São adicionadas no final da página. Depois você pode editá-las." },
    { es: "Eliminar plantilla", en: "Delete template", pt: "Excluir modelo" },
    { es: "La página está vacía: añade bloques antes de guardarla como plantilla.", en: "The page is empty: add blocks before saving it as a template.", pt: "A página está vazia: adicione blocos antes de salvá-la como modelo." },
    { es: "Sin resultados para", en: "No results for", pt: "Sem resultados para" },
    { es: "Guardada", en: "Saved", pt: "Salva" },
    { es: "bloque", en: "block", pt: "bloco" },
    { es: "bloques", en: "blocks", pt: "blocos" },
    // PuckEditor toolbar & empty state
    { es: "Selecciona una opción", en: "Select an option", pt: "Selecione uma opção" },
    { es: "Vista previa", en: "Preview", pt: "Pré-visualização" },
    { es: "Vista previa en el sitio real (los borradores solo los ves tú)", en: "Preview on the live site (drafts stay private to you)", pt: "Pré-visualizar no site real (os rascunhos ficam privados para você)" },
    { es: "Deshacer (Ctrl+Z)", en: "Undo (Ctrl+Z)", pt: "Desfazer (Ctrl+Z)" },
    { es: "Rehacer (Ctrl+Shift+Z)", en: "Redo (Ctrl+Shift+Z)", pt: "Refazer (Ctrl+Shift+Z)" },
    { es: "Sin guardar · autoguardado activo", en: "Unsaved · autosave on", pt: "Não salvo · salvamento automático ativo" },
    { es: "Cambios sin publicar", en: "Unpublished changes", pt: "Alterações não publicadas" },
    { es: "Empieza tu página", en: "Start your page", pt: "Comece sua página" },
    { es: "Arrastra un bloque desde la izquierda, o inserta una plantilla para arrancar rápido.", en: "Drag a block from the left, or insert a template to get started fast.", pt: "Arraste um bloco da esquerda ou insira um modelo para começar rápido." },
    // Built-in pattern names (Hero stays; Cifras covered by FIELD_STRINGS)
    { es: "Introducción", en: "Introduction", pt: "Introdução" },
    { es: "Ventajas", en: "Advantages", pt: "Vantagens" },
    { es: "Servicios", en: "Services", pt: "Serviços" },
    { es: "Precios", en: "Pricing", pt: "Preços" },
    { es: "Testimonios", en: "Testimonials", pt: "Depoimentos" },
    { es: "Preguntas frecuentes", en: "FAQ", pt: "Perguntas frequentes" },
    { es: "Llamada a la acción", en: "Call to action", pt: "Chamada para ação" },
    // Built-in pattern descriptions
    { es: "Cabecera de impacto con botones", en: "Impactful header with buttons", pt: "Cabeçalho de impacto com botões" },
    { es: "Título, descripción y botón", en: "Title, description and button", pt: "Título, descrição e botão" },
    { es: "Encabezado + lista de ventajas con iconos", en: "Heading + feature list with icons", pt: "Cabeçalho + lista de vantagens com ícones" },
    { es: "Encabezado + 3 tarjetas", en: "Heading + 3 cards", pt: "Cabeçalho + 3 cartões" },
    { es: "Números que generan confianza", en: "Numbers that build trust", pt: "Números que geram confiança" },
    { es: "Encabezado + tabla de precios", en: "Heading + pricing table", pt: "Cabeçalho + tabela de preços" },
    { es: "Encabezado + testimonio", en: "Heading + testimonial", pt: "Cabeçalho + depoimento" },
    { es: "Encabezado + acordeón", en: "Heading + accordion", pt: "Cabeçalho + acordeão" },
    { es: "Separador + banner de conversión", en: "Divider + conversion banner", pt: "Divisor + banner de conversão" },
];

const TRIPLES: Tri[] = [...BLOCKS_CATEGORIES, ...FIELD_STRINGS, ...CHROME_STRINGS];

let LOOKUP: Map<string, Tri> | null = null;
function lookup(): Map<string, Tri> {
    if (LOOKUP) return LOOKUP;
    LOOKUP = new Map();
    for (const t of TRIPLES) for (const v of [t.es, t.en, t.pt]) if (v && !LOOKUP!.has(v)) LOOKUP!.set(v, t);
    return LOOKUP;
}

/** Translate a single known editor string to `lang` (returns the input unchanged if unknown). */
export function trStr(s: string, lang: Language): string {
    const hit = lookup().get(s);
    return hit ? (hit[lang] || s) : s;
}

// Recursively translate `label`/`placeholder` string values; preserve functions, React elements,
// field keys, values and any other data untouched. `defaultProps` is skipped WHOLESALE: it holds the
// CONTENT a freshly-inserted block starts with (e.g. Button.defaultProps.label = "Click Me"), which
// must stay in the site's content language — never the editor's UI language — even though some of
// those defaults coincide with translatable field labels.
function walk(node: any, lang: Language): any {
    if (Array.isArray(node)) return node.map((x) => walk(x, lang));
    if (node && typeof node === 'object') {
        if ((node as any).$$typeof) return node; // React element — never clone
        const out: any = {};
        for (const k of Object.keys(node)) {
            const v = (node as any)[k];
            if (k === 'defaultProps') out[k] = v; // inserted-block CONTENT — never translate
            else if ((k === 'label' || k === 'placeholder') && typeof v === 'string') out[k] = trStr(v, lang);
            else if (v && typeof v === 'object') out[k] = walk(v, lang);
            else out[k] = v;
        }
        return out;
    }
    return node;
}

/** Return a copy of a Puck config with all editor-chrome strings translated to `lang`. */
export function localizeConfig<T extends { categories?: any; components?: any }>(config: T, lang: Language): T {
    if (!config) return config;
    const out: any = { ...config };

    if (config.categories && typeof config.categories === 'object') {
        const cats: any = {};
        for (const k of Object.keys(config.categories)) {
            const c = (config.categories as any)[k];
            if (typeof c === 'string') cats[k] = trStr(c, lang);
            else if (c && typeof c === 'object') {
                cats[k] = { ...c };
                if (typeof c.title === 'string') cats[k].title = trStr(c.title, lang);
            } else cats[k] = c;
        }
        out.categories = cats;
    }

    if (config.components && typeof config.components === 'object') {
        const comps: any = {};
        for (const name of Object.keys(config.components)) comps[name] = walk((config.components as any)[name], lang);
        out.components = comps;
    }

    // Root/page-settings fields (Title, Slug, SEO labels, Yes/No options) live under config.root.fields;
    // walk translates their labels while defaultProps/render are preserved by walk's own rules.
    if ((config as any).root && typeof (config as any).root === 'object') {
        out.root = walk((config as any).root, lang);
    }

    return out;
}
