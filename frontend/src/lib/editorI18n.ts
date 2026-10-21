/**
 * Visual-editor i18n — reactive localization of the block config.
 *
 * The block config (`components`, `categories`, field labels) is built once at module load
 * in versoConfig.tsx, so its labels never changed when the admin switched language. This module
 * fixes that: `localizeConfig(config, lang)` returns a copy of the config with every editor-chrome
 * string (category names, block + root field labels/placeholders, select-option labels) translated
 * to `lang` — and it matches on ANY of the three source languages, so it also normalizes the
 * historically-mixed es/en labels. Apply it reactively in the editor via `useMemo([language])`:
 * passing a NEW config object is enough for the editor to re-read the labels on a live language switch —
 * no remount / `key={language}` needed (verified in-browser; a key would needlessly reset editor state).
 *
 * Only `label`/`placeholder` string values (and category display names) are translated; render
 * functions, field keys, values, and — crucially — a block's `defaultProps` (the CONTENT an inserted
 * block starts with) are preserved untouched, so inserted content never picks up the editor's UI
 * language.
 */

import type { Language } from './i18n';
import { VERSO_CHROME_STRINGS } from './editorI18nVerso';

export type Tri = { es: string; en: string; pt: string };

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
    // Core block inspector (coreBlocks.tsx + sharedFields.tsx): style knobs, options and hints.
    // "Media" is a font weight here; it sits before CHROME_STRINGS' "Medios"/"Media" so it wins the lookup.
    { es: "Media", en: "Medium", pt: "Média" },
    { es: "Nivel", en: "Level", pt: "Nível" },
    { es: "Tipo", en: "Type", pt: "Tipo" },
    { es: "Grosor", en: "Weight", pt: "Peso" },
    { es: "Del tema", en: "From theme", pt: "Do tema" },
    { es: "Del tema (1)", en: "From theme (1)", pt: "Do tema (1)" },
    { es: "Del tema (2)", en: "From theme (2)", pt: "Do tema (2)" },
    { es: "Del tema (cursiva)", en: "From theme (italic)", pt: "Do tema (itálico)" },
    { es: "Seminegrita", en: "Semibold", pt: "Seminegrito" },
    { es: "Negrita", en: "Bold", pt: "Negrito" },
    { es: "Extranegrita", en: "Extra bold", pt: "Extranegrito" },
    { es: "Cursiva", en: "Italic", pt: "Itálico" },
    { es: "MAYÚSCULAS", en: "UPPERCASE", pt: "MAIÚSCULAS" },
    { es: "Visibilidad por dispositivo", en: "Device visibility", pt: "Visibilidade por dispositivo" },
    { es: "Animación de entrada", en: "Entrance animation", pt: "Animação de entrada" },
    { es: "Apariencia", en: "Appearance", pt: "Aparência" },
    { es: "Color del título (vacío = tema)", en: "Title color (empty = theme)", pt: "Cor do título (vazio = tema)" },
    { es: "Color del texto (vacío = tema)", en: "Text color (empty = theme)", pt: "Cor do texto (vazio = tema)" },
    { es: "Color del texto (vacío = blanco)", en: "Text color (empty = white)", pt: "Cor do texto (vazio = branco)" },
    { es: "Color (vacío = tema)", en: "Color (empty = theme)", pt: "Cor (vazio = tema)" },
    { es: "Color (vacío = color primario del tema)", en: "Color (empty = theme primary color)", pt: "Cor (vazio = cor primária do tema)" },
    { es: "Color de la capa (vacío = negro)", en: "Overlay color (empty = black)", pt: "Cor da camada (vazio = preto)" },
    { es: "Fondo (vacío = tema)", en: "Background (empty = theme)", pt: "Fundo (vazio = tema)" },
    { es: "Fondo o degradado (vacío = variante)", en: "Background or gradient (empty = variant)", pt: "Fundo ou gradiente (vazio = variante)" },
    { es: "Fondo mientras carga (vacío = tema)", en: "Background while loading (empty = theme)", pt: "Fundo durante o carregamento (vazio = tema)" },
    { es: "Fondo de las tarjetas (vacío = tema)", en: "Card background (empty = theme)", pt: "Fundo dos cartões (vazio = tema)" },
    { es: "Fondo del campo (vacío = tema)", en: "Field background (empty = theme)", pt: "Fundo do campo (vazio = tema)" },
    { es: "Color de las pestañas (vacío = tema)", en: "Tab color (empty = theme)", pt: "Cor das abas (vazio = tema)" },
    { es: "Sombra CSS", en: "CSS shadow", pt: "Sombra CSS" },
    { es: "Sombra CSS (vacío = tema)", en: "CSS shadow (empty = theme)", pt: "Sombra CSS (vazio = tema)" },
    { es: "Tamaño (p. ej. 48 o 3rem)", en: "Size (e.g. 48 or 3rem)", pt: "Tamanho (ex. 48 ou 3rem)" },
    { es: "Tamaño (p. ej. 18 o 1.125rem)", en: "Size (e.g. 18 or 1.125rem)", pt: "Tamanho (ex. 18 ou 1.125rem)" },
    { es: "Tamaño (px, p. ej. 52)", en: "Size (px, e.g. 52)", pt: "Tamanho (px, ex. 52)" },
    { es: "Tamaño de letra (px, p. ej. 15)", en: "Font size (px, e.g. 15)", pt: "Tamanho da fonte (px, ex. 15)" },
    { es: "Tamaño del texto (px, p. ej. 24)", en: "Text size (px, e.g. 24)", pt: "Tamanho do texto (px, ex. 24)" },
    { es: "Tamaño del título (px, p. ej. 28)", en: "Title size (px, e.g. 28)", pt: "Tamanho do título (px, ex. 28)" },
    { es: "Tamaño del título (px, p. ej. 48)", en: "Title size (px, e.g. 48)", pt: "Tamanho do título (px, ex. 48)" },
    { es: "Tamaño del titular (px, p. ej. 72)", en: "Headline size (px, e.g. 72)", pt: "Tamanho da manchete (px, ex. 72)" },
    { es: "Tamaño del subtítulo (px, p. ej. 22)", en: "Subtitle size (px, e.g. 22)", pt: "Tamanho do subtítulo (px, ex. 22)" },
    { es: "Tamaño del icono (px, p. ej. 48)", en: "Icon size (px, e.g. 48)", pt: "Tamanho do ícone (px, ex. 48)" },
    { es: "Tamaño del icono (px, p. ej. 56)", en: "Icon size (px, e.g. 56)", pt: "Tamanho do ícone (px, ex. 56)" },
    { es: "Tamaño del icono (px, p. ej. 64)", en: "Icon size (px, e.g. 64)", pt: "Tamanho do ícone (px, ex. 64)" },
    { es: "Tamaño del precio (px, p. ej. 56)", en: "Price size (px, e.g. 56)", pt: "Tamanho do preço (px, ex. 56)" },
    { es: "Tamaño de la cita (px, p. ej. 24)", en: "Quote size (px, e.g. 24)", pt: "Tamanho da citação (px, ex. 24)" },
    { es: "Tamaño del avatar (px, p. ej. 72)", en: "Avatar size (px, e.g. 72)", pt: "Tamanho do avatar (px, ex. 72)" },
    { es: "Tamaño de la cifra (px, p. ej. 56)", en: "Figure size (px, e.g. 56)", pt: "Tamanho do número (px, ex. 56)" },
    { es: "Grosor (px, p. ej. 2)", en: "Thickness (px, e.g. 2)", pt: "Espessura (px, ex. 2)" },
    { es: "Grosor del título", en: "Title weight", pt: "Peso do título" },
    { es: "Grosor del titular", en: "Headline weight", pt: "Peso da manchete" },
    { es: "Grosor de la línea (px, p. ej. 2)", en: "Line thickness (px, e.g. 2)", pt: "Espessura da linha (px, ex. 2)" },
    { es: "Espaciado entre letras (p. ej. -1)", en: "Letter spacing (e.g. -1)", pt: "Espaçamento entre letras (ex. -1)" },
    { es: "Espaciado del titular (p. ej. -2)", en: "Headline letter spacing (e.g. -2)", pt: "Espaçamento entre letras da manchete (ex. -2)" },
    { es: "Interlineado (p. ej. 1.8)", en: "Line height (e.g. 1.8)", pt: "Altura da linha (ex. 1.8)" },
    { es: "Ancho de línea máx. (px, p. ej. 680)", en: "Max line width (px, e.g. 680)", pt: "Largura máx. da linha (px, ex. 680)" },
    { es: "Ancho (p. ej. 480 o 60%)", en: "Width (e.g. 480 or 60%)", pt: "Largura (ex. 480 ou 60%)" },
    { es: "Ancho (p. ej. 120 o 40%)", en: "Width (e.g. 120 or 40%)", pt: "Largura (ex. 120 ou 40%)" },
    { es: "Ancho del contenido (px, p. ej. 900)", en: "Content width (px, e.g. 900)", pt: "Largura do conteúdo (px, ex. 900)" },
    { es: "Altura (p. ej. 48 o 4rem)", en: "Height (e.g. 48 or 4rem)", pt: "Altura (ex. 48 ou 4rem)" },
    { es: "Altura mínima (px, p. ej. 320)", en: "Min height (px, e.g. 320)", pt: "Altura mínima (px, ex. 320)" },
    { es: "Alto de la miniatura (px, p. ej. 160)", en: "Thumbnail height (px, e.g. 160)", pt: "Altura da miniatura (px, ex. 160)" },
    { es: "Redondeo (px, p. ej. 12)", en: "Corner radius (px, e.g. 12)", pt: "Arredondamento (px, ex. 12)" },
    { es: "Redondeo (px, p. ej. 16)", en: "Corner radius (px, e.g. 16)", pt: "Arredondamento (px, ex. 16)" },
    { es: "Redondeo (px, p. ej. 24)", en: "Corner radius (px, e.g. 24)", pt: "Arredondamento (px, ex. 24)" },
    { es: "Redondeo (px, p. ej. 32)", en: "Corner radius (px, e.g. 32)", pt: "Arredondamento (px, ex. 32)" },
    { es: "Redondeo (p. ej. 999 para píldora)", en: "Corner radius (e.g. 999 for a pill)", pt: "Arredondamento (ex. 999 para pílula)" },
    { es: "Redondeo (p. ej. 12; vacío = círculo)", en: "Corner radius (e.g. 12; empty = circle)", pt: "Arredondamento (ex. 12; vazio = círculo)" },
    { es: "Redondeo del panel (px, p. ej. 12)", en: "Panel corner radius (px, e.g. 12)", pt: "Arredondamento do painel (px, ex. 12)" },
    { es: "Redondeo del campo (px, p. ej. 8)", en: "Field corner radius (px, e.g. 8)", pt: "Arredondamento do campo (px, ex. 8)" },
    { es: "Redondeo del botón (px, p. ej. 8)", en: "Button corner radius (px, e.g. 8)", pt: "Arredondamento do botão (px, ex. 8)" },
    { es: "Relleno (px, p. ej. 24)", en: "Padding (px, e.g. 24)", pt: "Preenchimento (px, ex. 24)" },
    { es: "Relleno (px, p. ej. 40)", en: "Padding (px, e.g. 40)", pt: "Preenchimento (px, ex. 40)" },
    { es: "Relleno (px, p. ej. 48)", en: "Padding (px, e.g. 48)", pt: "Preenchimento (px, ex. 48)" },
    { es: "Relleno (p. ej. 80px 40px)", en: "Padding (e.g. 80px 40px)", pt: "Preenchimento (ex. 80px 40px)" },
    { es: "Relleno (p. ej. 96 o 96px 24px)", en: "Padding (e.g. 96 or 96px 24px)", pt: "Preenchimento (ex. 96 ou 96px 24px)" },
    { es: "Relleno vertical (px, p. ej. 14)", en: "Vertical padding (px, e.g. 14)", pt: "Preenchimento vertical (px, ex. 14)" },
    { es: "Relleno horizontal (px, p. ej. 32)", en: "Horizontal padding (px, e.g. 32)", pt: "Preenchimento horizontal (px, ex. 32)" },
    { es: "Relleno de la cabecera (p. ej. 16px 20px)", en: "Header padding (e.g. 16px 20px)", pt: "Preenchimento do cabeçalho (ex. 16px 20px)" },
    { es: "Relleno de la pestaña (p. ej. 12px 24px)", en: "Tab padding (e.g. 12px 24px)", pt: "Preenchimento da aba (ex. 12px 24px)" },
    { es: "Relleno del panel (px, p. ej. 24)", en: "Panel padding (px, e.g. 24)", pt: "Preenchimento do painel (px, ex. 24)" },
    { es: "Separación (px, p. ej. 16)", en: "Gap (px, e.g. 16)", pt: "Espaçamento (px, ex. 16)" },
    { es: "Separación (px, p. ej. 20)", en: "Gap (px, e.g. 20)", pt: "Espaçamento (px, ex. 20)" },
    { es: "Separación (px, p. ej. 24)", en: "Gap (px, e.g. 24)", pt: "Espaçamento (px, ex. 24)" },
    { es: "Separación (px, p. ej. 32)", en: "Gap (px, e.g. 32)", pt: "Espaçamento (px, ex. 32)" },
    { es: "Separación (px, p. ej. 40)", en: "Gap (px, e.g. 40)", pt: "Espaçamento (px, ex. 40)" },
    { es: "Separación vertical (px, p. ej. 64)", en: "Vertical spacing (px, e.g. 64)", pt: "Espaçamento vertical (px, ex. 64)" },
    { es: "Ajuste", en: "Fit", pt: "Ajuste" },
    { es: "Cubrir", en: "Cover", pt: "Cobrir" },
    { es: "Contener", en: "Contain", pt: "Conter" },
    { es: "Color del borde", en: "Border color", pt: "Cor da borda" },
    { es: "Color del borde del campo", en: "Field border color", pt: "Cor da borda do campo" },
    { es: "Fondo del icono", en: "Icon background", pt: "Fundo do ícone" },
    { es: "Color del icono", en: "Icon color", pt: "Cor do ícone" },
    { es: "Título en mayúsculas", en: "Uppercase title", pt: "Título em maiúsculas" },
    { es: "Escena fija (el contenido se queda mientras haces scroll)", en: "Pinned scene (content stays in place while you scroll)", pt: "Cena fixa (o conteúdo fica parado enquanto você rola)" },
    { es: "Corta (2 pantallas)", en: "Short (2 screens)", pt: "Curta (2 telas)" },
    { es: "Media (3 pantallas)", en: "Medium (3 screens)", pt: "Média (3 telas)" },
    { es: "Larga (4 pantallas)", en: "Long (4 screens)", pt: "Longa (4 telas)" },
    { es: "Columnas en tablet", en: "Columns on tablet", pt: "Colunas no tablet" },
    { es: "Columnas en móvil", en: "Columns on mobile", pt: "Colunas no celular" },
    { es: "Columnas (rejilla)", en: "Columns (grid)", pt: "Colunas (grade)" },
    { es: "Dirección", en: "Direction", pt: "Direção" },
    { es: "Fila", en: "Row", pt: "Linha" },
    { es: "Fila invertida", en: "Row reverse", pt: "Linha invertida" },
    { es: "Columna", en: "Column", pt: "Coluna" },
    { es: "Columna invertida", en: "Column reverse", pt: "Coluna invertida" },
    { es: "Fondo de la cabecera", en: "Header background", pt: "Fundo do cabeçalho" },
    { es: "Color de la cabecera", en: "Header color", pt: "Cor do cabeçalho" },
    { es: "Color al abrir", en: "Color when open", pt: "Cor ao abrir" },
    { es: "Fondo del contenido", en: "Content background", pt: "Fundo do conteúdo" },
    { es: "Color del contenido", en: "Content color", pt: "Cor do conteúdo" },
    { es: "Color de la pestaña activa", en: "Active tab color", pt: "Cor da aba ativa" },
    { es: "Color de la línea", en: "Line color", pt: "Cor da linha" },
    { es: "Fondo del panel", en: "Panel background", pt: "Fundo do painel" },
    { es: "Video URL (YouTube, Vimeo, o un archivo propio: /public/media/x.mp4)", en: "Video URL (YouTube, Vimeo, or your own file: /public/media/x.mp4)", pt: "URL do vídeo (YouTube, Vimeo ou um arquivo próprio: /public/media/x.mp4)" },
    { es: "Póster (solo archivos propios)", en: "Poster (own files only)", pt: "Pôster (somente arquivos próprios)" },
    { es: "Color de acento (plan destacado)", en: "Accent color (featured plan)", pt: "Cor de destaque (plano em destaque)" },
    { es: "Color de acento (comillas y avatar)", en: "Accent color (quote marks and avatar)", pt: "Cor de destaque (aspas e avatar)" },
    { es: "Color de acento (barra / comillas)", en: "Accent color (bar / quote marks)", pt: "Cor de destaque (barra / aspas)" },
    { es: "Fondo de los planes", en: "Plan background", pt: "Fundo dos planos" },
    { es: "Escala del destacado (p. ej. 1.08; 1 = sin escalar)", en: "Featured plan scale (e.g. 1.08; 1 = no scaling)", pt: "Escala do destaque (ex. 1.08; 1 = sem escala)" },
    { es: "Color del texto", en: "Text color", pt: "Cor do texto" },
    { es: "Color del título", en: "Title color", pt: "Cor do título" },
    { es: "Fondo del botón", en: "Button background", pt: "Fundo do botão" },
    { es: "Color del botón", en: "Button color", pt: "Cor do botão" },
    { es: "Color de las líneas", en: "Divider color", pt: "Cor das linhas" },
    { es: "Color de los enlaces", en: "Link color", pt: "Cor dos links" },
    { es: "Color de las filas alternas", en: "Alternating row color", pt: "Cor das linhas alternadas" },
    { es: "Nombre del formulario", en: "Form name", pt: "Nome do formulário" },
    { es: "Campos", en: "Fields", pt: "Campos" },
    { es: "Campo", en: "Field", pt: "Campo" },
    { es: "Correo electrónico", en: "Email", pt: "E-mail" },
    { es: "Teléfono", en: "Phone", pt: "Telefone" },
    { es: "Área de texto", en: "Text area", pt: "Área de texto" },
    { es: "Desplegable", en: "Dropdown", pt: "Lista suspensa" },
    { es: "Casilla", en: "Checkbox", pt: "Caixa de seleção" },
    { es: "Obligatorio", en: "Required", pt: "Obrigatório" },
    { es: "Opciones (desplegable, separadas por comas)", en: "Options (dropdown, comma-separated)", pt: "Opções (lista suspensa, separadas por vírgulas)" },
    { es: "Texto de ejemplo", en: "Placeholder", pt: "Texto de exemplo" },
    { es: "Mensaje de éxito", en: "Success message", pt: "Mensagem de sucesso" },
    { es: "Mensaje de error", en: "Error message", pt: "Mensagem de erro" },
    { es: "Símbolo", en: "Symbol", pt: "Símbolo" },
    { es: "Degradado — desde (sin imagen)", en: "Gradient — from (no image)", pt: "Gradiente — de (sem imagem)" },
    { es: "Degradado — hasta", en: "Gradient — to", pt: "Gradiente — até" },
    { es: "Degradado — ángulo (grados, p. ej. 135)", en: "Gradient — angle (degrees, e.g. 135)", pt: "Gradiente — ângulo (graus, ex. 135)" },
    { es: "Fondo al pasar el ratón", en: "Hover background", pt: "Fundo ao passar o mouse" },
    { es: "Color de la cifra", en: "Figure color", pt: "Cor do número" },
    { es: "Color de la etiqueta", en: "Label color", pt: "Cor do rótulo" },
    { es: "Etiqueta en mayúsculas", en: "Uppercase label", pt: "Rótulo em maiúsculas" },
    { es: "Número de partículas", en: "Particle count", pt: "Número de partículas" },
    { es: "Velocidad", en: "Speed", pt: "Velocidade" },
    { es: "Lenta", en: "Slow", pt: "Lenta" },
    { es: "Rápida", en: "Fast", pt: "Rápida" },
    { es: "Conectar con líneas (constelación)", en: "Connect with lines (constellation)", pt: "Conectar com linhas (constelação)" },
    { es: "Distancia máx. de las líneas (px)", en: "Max line distance (px)", pt: "Distância máx. das linhas (px)" },
    { es: "Reaccionar al puntero", en: "React to pointer", pt: "Reagir ao ponteiro" },
    { es: "Origen", en: "Source", pt: "Origem" },
    { es: "Ubicación", en: "Location", pt: "Local" },
    { es: "Menú", en: "Menu", pt: "Menu" },
    { es: "Ubicación del menú", en: "Menu location", pt: "Local do menu" },
    { es: "Menú (si el origen es Menú)", en: "Menu (if the source is Menu)", pt: "Menu (se a origem for Menu)" },
    { es: "Elementos del menú", en: "Menu items", pt: "Itens do menu" },
    { es: "Orientación", en: "Orientation", pt: "Orientação" },
    { es: "Profundidad de submenús (1–3)", en: "Submenu depth (1–3)", pt: "Profundidade dos submenus (1–3)" },
    { es: "Apertura de submenús", en: "Open submenus on", pt: "Abrir submenus ao" },
    { es: "Apertura del panel", en: "Open panel on", pt: "Abrir painel ao" },
    { es: "Al pasar el ratón", en: "Hover", pt: "Passar o mouse" },
    { es: "Clic", en: "Click", pt: "Clicar" },
    { es: "En móvil", en: "On mobile", pt: "No celular" },
    { es: "Colapsar", en: "Collapse", pt: "Recolher" },
    { es: "Cajón", en: "Drawer", pt: "Gaveta" },
    { es: "Ninguno", en: "None", pt: "Nenhum" },
    { es: "Panel a todo el ancho", en: "Full-width panel", pt: "Painel de largura total" },
    { es: "Mostrar", en: "Show", pt: "Mostrar" },
    { es: "Logotipo", en: "Logo", pt: "Logotipo" },
    { es: "Ambos", en: "Both", pt: "Ambos" },
    { es: "Enlazar al inicio", en: "Link to home page", pt: "Link para a página inicial" },
    { es: "Altura máx. del logo (px)", en: "Max logo height (px)", pt: "Altura máx. do logo (px)" },
    { es: "Texto alternativo (opcional)", en: "Alt text (optional)", pt: "Texto alternativo (opcional)" },
    { es: "Aparece tras (px)", en: "Appears after (px)", pt: "Aparece após (px)" },
    { es: "Posición", en: "Position", pt: "Posição" },
    { es: "Abajo derecha", en: "Bottom right", pt: "Inferior direito" },
    { es: "Abajo izquierda", en: "Bottom left", pt: "Inferior esquerdo" },
    { es: "Desplazamiento suave", en: "Smooth scrolling", pt: "Rolagem suave" },
    { es: "Etiqueta accesible", en: "Accessible label", pt: "Rótulo acessível" },
    { es: "Icono (Font Awesome, p. ej. fa-arrow-up)", en: "Icon (Font Awesome, e.g. fa-arrow-up)", pt: "Ícone (Font Awesome, ex. fa-arrow-up)" },
    { es: "Icono del botón (Font Awesome)", en: "Button icon (Font Awesome)", pt: "Ícone do botão (Font Awesome)" },
    { es: "Lado", en: "Side", pt: "Lado" },
    { es: "Mostrar como cajón", en: "Show as drawer", pt: "Mostrar como gaveta" },
    { es: "Siempre", en: "Always", pt: "Sempre" },
    { es: "Solo en móvil (< md)", en: "Mobile only (< md)", pt: "Somente no celular (< md)" },
    { es: "Móvil y tablet (< lg)", en: "Mobile and tablet (< lg)", pt: "Celular e tablet (< lg)" },
    { es: "Cerrar con Escape", en: "Close with Escape", pt: "Fechar com Escape" },
    { es: "Bloquear scroll al abrir", en: "Lock scrolling while open", pt: "Bloquear rolagem ao abrir" },
    { es: "Separador", en: "Separator", pt: "Separador" },
    { es: "Mostrar «Inicio»", en: "Show “Home”", pt: "Mostrar “Início”" },
    { es: "Etiqueta de inicio", en: "Home label", pt: "Rótulo do início" },
    { es: "Ocultar en la portada", en: "Hide on the home page", pt: "Ocultar na página inicial" },
    { es: "En línea", en: "Inline", pt: "Em linha" },
    { es: "Nativo", en: "Native", pt: "Nativo" },
    { es: "Código", en: "Code", pt: "Código" },
    { es: "Mostrar el idioma actual", en: "Show the current language", pt: "Mostrar o idioma atual" },
    { es: "Nivel mínimo", en: "Minimum level", pt: "Nível mínimo" },
    { es: "Nivel máximo", en: "Maximum level", pt: "Nível máximo" },
    { es: "Numerada", en: "Numbered", pt: "Numerada" },
    { es: "Resaltar al desplazar", en: "Highlight on scroll", pt: "Destacar ao rolar" },
    // Root fields the editor adds on top of the registry (editorRootFields.ts).
    { es: "Imagen destacada", en: "Featured image", pt: "Imagem destacada" },
    { es: "Sin imagen destacada", en: "No featured image", pt: "Sem imagem destacada" },
    { es: "Extracto", en: "Excerpt", pt: "Resumo" },
    { es: "Resumen breve (listados y descripción SEO)", en: "Short summary (listings and SEO description)", pt: "Resumo breve (listagens e descrição SEO)" },
    { es: "Sin categoría", en: "Uncategorized", pt: "Sem categoria" },
    { es: "Etiquetas", en: "Tags", pt: "Tags" },
    { es: "Elige una etiqueta", en: "Choose a tag", pt: "Escolha uma tag" },
    { es: "🔍 Título SEO (máx. 60 caracteres)", en: "🔍 SEO title (60 characters max)", pt: "🔍 Título SEO (máx. 60 caracteres)" },
    { es: "🔍 Meta descripción (máx. 160 caracteres)", en: "🔍 Meta description (160 characters max)", pt: "🔍 Meta descrição (máx. 160 caracteres)" },
    { es: "🔍 URL de la imagen social", en: "🔍 Social image URL", pt: "🔍 URL da imagem social" },
    { es: "🔍 Ocultar a los buscadores", en: "🔍 Hide from search engines", pt: "🔍 Ocultar dos mecanismos de busca" },
    { es: "No (indexable)", en: "No (indexable)", pt: "Não (indexável)" },
    { es: "Sí (oculta)", en: "Yes (hidden)", pt: "Sim (oculta)" },
];

// Editor chrome + block palette copy (BlockInserter descriptions/groups/tabs, editor toolbar &
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
    { es: "Plantilla del tema", en: "Theme template", pt: "Modelo do tema" },
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
    // VersoEditor (F3) — placeholders documentados de superficies que llegan en olas posteriores.
    // (Los de plantillas y paleta ⌘K se retiraron en la ola 3, al llegar las superficies reales.)
    { es: "Guardada", en: "Saved", pt: "Salva" },
    { es: "bloque", en: "block", pt: "bloco" },
    { es: "bloques", en: "blocks", pt: "blocos" },
    // Editor toolbar & empty state
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
    // Editor redesign chrome (top bar, breadcrumb, save states, panels, device toolbar, empty state).
    // es values must match the code literals BYTE-FOR-BYTE — trStr keys on the exact string.
    { es: "Páginas", en: "Pages", pt: "Páginas" },
    { es: "Saltar al lienzo", en: "Skip to canvas", pt: "Pular para a tela" },
    { es: "Entradas", en: "Posts", pt: "Posts" },
    { es: "Sin título", en: "Untitled", pt: "Sem título" },
    { es: "Publicar", en: "Publish", pt: "Publicar" },
    { es: "Guardando…", en: "Saving…", pt: "Salvando…" },
    { es: "Guardado", en: "Saved", pt: "Salvo" },
    { es: "hace", en: "ago", pt: "há" },
    { es: "Sin guardar", en: "Unsaved", pt: "Não salvo" },
    { es: "Autoguardado", en: "Autosaved", pt: "Salvamento automático" },
    // Relative-time templates — the {m} placeholder is substituted by the caller AFTER translation,
    // so it must survive literally in all three languages.
    { es: "Guardado hace {m}m", en: "Saved {m}m ago", pt: "Salvo há {m}m" },
    { es: "Autoguardado hace {m}m", en: "Autosaved {m}m ago", pt: "Salvamento automático há {m}m" },
    { es: "Panel bloqueado", en: "Panel locked", pt: "Painel bloqueado" },
    { es: "Suelta el bloque en el lienzo para editar sus propiedades.", en: "Drop the block on the canvas to edit its properties.", pt: "Solte o bloco na tela para editar suas propriedades." },
    { es: "Arrastra a una zona iluminada para añadir el bloque", en: "Drag to a highlighted zone to add the block", pt: "Arraste para uma zona destacada para adicionar o bloco" },
    { es: "Comienza tu diseño", en: "Start your design", pt: "Comece seu design" },
    { es: "Tu lienzo está listo. Añade el primer bloque para empezar a construir tu visión.", en: "Your canvas is ready. Add the first block to start building your vision.", pt: "Sua tela está pronta. Adicione o primeiro bloco para começar a construir sua visão." },
    { es: "Añadir primer bloque", en: "Add first block", pt: "Adicionar primeiro bloco" },
    { es: "Historial", en: "History", pt: "Histórico" },
    { es: "Ajustes", en: "Settings", pt: "Configurações" },
    { es: "Ajustes de página", en: "Page settings", pt: "Configurações da página" },
    { es: "Recursos", en: "Assets", pt: "Recursos" },
    { es: "Biblioteca de medios", en: "Media library", pt: "Biblioteca de mídia" },
    { es: "Estructura", en: "Structure", pt: "Estrutura" },
    { es: "Capas", en: "Layers", pt: "Camadas" },
    { es: "Propiedades", en: "Properties", pt: "Propriedades" },
    { es: "Insertar", en: "Insert", pt: "Inserir" },
    { es: "Insertar bloque (Ctrl/⌘ + K)", en: "Insert block (Ctrl/⌘ + K)", pt: "Inserir bloco (Ctrl/⌘ + K)" },
    { es: "Reproducir las animaciones de entrada", en: "Play the entrance animations", pt: "Reproduzir as animações de entrada" },
    { es: "¡Cambios guardados con éxito!", en: "Changes saved successfully!", pt: "Alterações salvas com sucesso!" },
    { es: "Todos", en: "All", pt: "Todos" },
    { es: "Usa ↑↓ para navegar · ↵ para insertar", en: "Use ↑↓ to navigate · ↵ to insert", pt: "Use ↑↓ para navegar · ↵ para inserir" },
    { es: "Buscar un bloque para insertar…", en: "Search for a block to insert…", pt: "Buscar um bloco para inserir…" },
    { es: "Buscar un bloque para insertar", en: "Search for a block to insert", pt: "Buscar um bloco para inserir" },
    { es: "Página", en: "Page", pt: "Página" },
    { es: "Entrada", en: "Post", pt: "Post" },
    // Capitalized variant used by the toolbar (lowercase "Vista previa" already exists above).
    { es: "Vista Previa", en: "Preview", pt: "Pré-visualização" },
    { es: "Programar", en: "Schedule", pt: "Agendar" },
    { es: "Fecha y hora de publicación programada", en: "Scheduled publish date and time", pt: "Data e hora da publicação agendada" },
    { es: "Elige fecha y hora para programar la publicación.", en: "Pick a date and time to schedule publishing.", pt: "Escolha data e hora para agendar a publicação." },
    { es: "Restablecer estilos", en: "Reset styles", pt: "Redefinir estilos" },
    { es: "Avanzado", en: "Advanced", pt: "Avançado" },
    { es: "Escritorio", en: "Desktop", pt: "Desktop" },
    { es: "Tableta", en: "Tablet", pt: "Tablet" },
    { es: "Móvil", en: "Mobile", pt: "Celular" },
    { es: "Subir", en: "Move up", pt: "Subir" },
    { es: "Bajar", en: "Move down", pt: "Descer" },
    // Command-palette actions
    { es: "Acciones", en: "Actions", pt: "Ações" },
    { es: "Exportar página (JSON)", en: "Export page (JSON)", pt: "Exportar página (JSON)" },
    { es: "Importar página (JSON)", en: "Import page (JSON)", pt: "Importar página (JSON)" },
    { es: "Copiar estilos del bloque", en: "Copy block styles", pt: "Copiar estilos do bloco" },
    { es: "Pegar estilos en el bloque", en: "Paste styles into the block", pt: "Colar estilos no bloco" },
    { es: "Duplicar bloque", en: "Duplicate block", pt: "Duplicar bloco" },
    { es: "Eliminar bloque", en: "Delete block", pt: "Excluir bloco" },
    // Filas nuevas de la paleta Verso (F3 ola 3): mover selección y navegar a la Estructura.
    { es: "Subir bloque", en: "Move block up", pt: "Subir bloco" },
    { es: "Bajar bloque", en: "Move block down", pt: "Descer bloco" },
    { es: "Ver estructura", en: "View structure", pt: "Ver estrutura" },
    { es: "Estilos copiados", en: "Styles copied", pt: "Estilos copiados" },
    { es: "Página importada", en: "Page imported", pt: "Página importada" },
    { es: "El archivo no es una página válida", en: "The file is not a valid page", pt: "O arquivo não é uma página válida" },
    { es: "¿Reemplazar todo el contenido de la página con el archivo importado?", en: "Replace the entire page content with the imported file?", pt: "Substituir todo o conteúdo da página pelo arquivo importado?" },
    { es: "Importar", en: "Import", pt: "Importar" },
    { es: "Historial de revisiones", en: "Revision history", pt: "Histórico de revisões" },
    { es: "Control de versiones", en: "Version control", pt: "Controle de versões" },
    { es: "Cerrar historial de revisiones", en: "Close revision history", pt: "Fechar histórico de revisões" },
    { es: "Cargando revisiones", en: "Loading revisions", pt: "Carregando revisões" },
    { es: "Restaurando revisión", en: "Restoring revision", pt: "Restaurando revisão" },
    { es: "No se pudieron cargar las revisiones", en: "Revisions could not be loaded", pt: "Não foi possível carregar as revisões" },
    { es: "Todas las revisiones", en: "All revisions", pt: "Todas as revisões" },
    { es: "Comparando", en: "Comparing", pt: "Comparando" },
    { es: "Título", en: "Title", pt: "Título" },
    { es: "Contenido", en: "Content", pt: "Conteúdo" },
    { es: "Sin cambios de texto; la diferencia puede estar en las imágenes o el diseño.", en: "No text changes; the difference may be in images or layout.", pt: "Sem alterações de texto; a diferença pode estar nas imagens ou no layout." },
    { es: "Las versiones difieren demasiado para compararlas aquí; restáurala para inspeccionarla.", en: "Versions differ too much to compare here; restore it to inspect.", pt: "As versões diferem demais para comparar aqui; restaure-a para inspecionar." },
    { es: "Restaurar esta versión", en: "Restore this version", pt: "Restaurar esta versão" },
    { es: "Comprueba la conexión y vuelve a intentarlo.", en: "Check the connection and try again.", pt: "Verifique a conexão e tente novamente." },
    { es: "Aún no hay revisiones", en: "No revisions yet", pt: "Ainda não há revisões" },
    { es: "Guarda la página para crear su primera versión recuperable.", en: "Save the page to create its first recoverable version.", pt: "Salve a página para criar sua primeira versão recuperável." },
    { es: "Última", en: "Latest", pt: "Mais recente" },
    { es: "Autor", en: "Author", pt: "Autor" },
    { es: "Restaurar", en: "Restore", pt: "Restaurar" },
    { es: "Antes del cambio de un agente de IA", en: "Before an AI agent's change", pt: "Antes da alteração de um agente de IA" },
    { es: "Restaura esta versión para deshacer lo que cambió el agente {name}.", en: "Restore this version to undo what the agent {name} changed.", pt: "Restaure esta versão para desfazer o que o agente {name} alterou." },
    { es: "Cambios", en: "Changes", pt: "Alterações" },
    { es: "Restaurar reemplaza el contenido actual y conserva una revisión de su estado presente.", en: "Restoring replaces the current content and preserves a revision of its present state.", pt: "Restaurar substitui o conteúdo atual e preserva uma revisão do seu estado presente." },
    // Symbols (save-block-as-symbol action + toasts)
    { es: "Guardar bloque como símbolo", en: "Save block as symbol", pt: "Salvar bloco como símbolo" },
    { es: "Símbolo guardado", en: "Symbol saved", pt: "Símbolo salvo" },
    { es: "No se pudo guardar el símbolo", en: "Could not save the symbol", pt: "Não foi possível salvar o símbolo" },
    // Editor panels / rail (review comments, a11y audit, guides, notes)
    { es: "Comentarios de revisión", en: "Review comments", pt: "Comentários de revisão" },
    { es: "Auditoría de accesibilidad", en: "Accessibility audit", pt: "Auditoria de acessibilidade" },
    { es: "Guías y contornos", en: "Guides and outlines", pt: "Guias e contornos" },
    { es: "Notas", en: "Notes", pt: "Notas" },
    { es: "Accesibilidad", en: "Accessibility", pt: "Acessibilidade" },
    // Presence (rendered after the co-editor name(s), singular/plural)
    { es: "también está editando", en: "is also editing", pt: "também está editando" },
    { es: "también están editando", en: "are also editing", pt: "também estão editando" },
    // Editor load-error screen (blocking guard when content fails to load)
    { es: "No se pudo cargar el contenido", en: "Could not load the content", pt: "Não foi possível carregar o conteúdo" },
    { es: "No pudimos cargar esta publicación. Para no sobrescribir su contenido, el editor no se abrirá. Reintenta cuando tengas conexión.", en: "We couldn't load this post. To avoid overwriting its content, the editor won't open. Retry when you're back online.", pt: "Não foi possível carregar esta publicação. Para não sobrescrever seu conteúdo, o editor não será aberto. Tente novamente quando tiver conexão." },
    { es: "Reintentar", en: "Retry", pt: "Tentar novamente" },
    { es: "Volver", en: "Go back", pt: "Voltar" },
    { es: "No se pudo cargar el contenido; el guardado está deshabilitado para no sobrescribir la página.", en: "Could not load the content; saving is disabled to avoid overwriting the page.", pt: "Não foi possível carregar o conteúdo; o salvamento está desativado para não sobrescrever a página." },
    { es: "No se pudo cargar el contenido; el guardado está deshabilitado para no sobrescribir la publicación.", en: "Could not load the content; saving is disabled to avoid overwriting the post.", pt: "Não foi possível carregar o conteúdo; o salvamento está desativado para não sobrescrever a publicação." },
    // A11y audit panel chrome
    { es: "Volver a analizar", en: "Re-analyze", pt: "Analisar novamente" },
    { es: "Analizando la página…", en: "Analyzing the page…", pt: "Analisando a página…" },
    { es: "Sin problemas detectados", en: "No issues detected", pt: "Nenhum problema detectado" },
    { es: "Seleccionar el bloque", en: "Select the block", pt: "Selecionar o bloco" },
    // A11y audit rule group headers (RULE_LABEL values — reach trStr via RULE_LABEL[rule])
    { es: "Imágenes sin alt", en: "Images without alt", pt: "Imagens sem alt" },
    { es: "Jerarquía de encabezados", en: "Heading hierarchy", pt: "Hierarquia de cabeçalhos" },
    { es: "Varios h1", en: "Multiple h1", pt: "Vários h1" },
    { es: "Sin nombre accesible", en: "No accessible name", pt: "Sem nome acessível" },
    { es: "Campos sin etiqueta", en: "Fields without label", pt: "Campos sem rótulo" },
    { es: "Contraste insuficiente", en: "Insufficient contrast", pt: "Contraste insuficiente" },
    { es: "Iframes sin título", en: "Iframes without title", pt: "Iframes sem título" },
    { es: "Tabindex positivo", en: "Positive tabindex", pt: "Tabindex positivo" },
    // A11y audit issue messages (reach trStr via issue.message)
    { es: "La imagen no tiene texto alternativo (alt)", en: "The image has no alt text", pt: "A imagem não tem texto alternativo (alt)" },
    { es: "Hay más de un h1 en la página", en: "There is more than one h1 on the page", pt: "Há mais de um h1 na página" },
    { es: "Salto en la jerarquía de encabezados", en: "Skipped heading level", pt: "Salto na hierarquia de cabeçalhos" },
    { es: "Enlace o botón sin texto accesible", en: "Link or button without accessible text", pt: "Link ou botão sem texto acessível" },
    { es: "Campo de formulario sin etiqueta asociada", en: "Form field without an associated label", pt: "Campo de formulário sem rótulo associado" },
    { es: "Contraste de texto insuficiente", en: "Insufficient text contrast", pt: "Contraste de texto insuficiente" },
    { es: "El iframe no tiene título", en: "The iframe has no title", pt: "O iframe não tem título" },
    { es: "Evita tabindex mayor que 0", en: "Avoid tabindex greater than 0", pt: "Evite tabindex maior que 0" },
    // Review comments panel. Relative-time templates: {n} is substituted by the caller AFTER
    // translation, so it must survive literally in all three languages.
    { es: "Ahora mismo", en: "Just now", pt: "Agora mesmo" },
    { es: "hace {n} min", en: "{n} min ago", pt: "há {n} min" },
    { es: "hace {n} h", en: "{n} h ago", pt: "há {n} h" },
    { es: "hace {n} d", en: "{n} d ago", pt: "há {n} d" },
    { es: "Comentario añadido", en: "Comment added", pt: "Comentário adicionado" },
    { es: "No se pudo añadir el comentario", en: "Could not add the comment", pt: "Não foi possível adicionar o comentário" },
    { es: "No se pudo actualizar el comentario", en: "Could not update the comment", pt: "Não foi possível atualizar o comentário" },
    { es: "¿Eliminar este comentario? Esta acción no se puede deshacer.", en: "Delete this comment? This action cannot be undone.", pt: "Excluir este comentário? Esta ação não pode ser desfeita." },
    { es: "Eliminar comentario", en: "Delete comment", pt: "Excluir comentário" },
    { es: "Comentario eliminado", en: "Comment deleted", pt: "Comentário excluído" },
    { es: "No se pudo eliminar el comentario", en: "Could not delete the comment", pt: "Não foi possível excluir o comentário" },
    { es: "Solo visible para el equipo", en: "Only visible to the team", pt: "Visível apenas para a equipe" },
    { es: "{n} abiertos", en: "{n} open", pt: "{n} abertos" },
    { es: "Actualizar", en: "Refresh", pt: "Atualizar" },
    { es: "Cerrar", en: "Close", pt: "Fechar" },
    { es: "Cargando comentarios…", en: "Loading comments…", pt: "Carregando comentários…" },
    { es: "No se pudieron cargar los comentarios", en: "Could not load the comments", pt: "Não foi possível carregar os comentários" },
    { es: "Sin comentarios. Escribe el primero.", en: "No comments. Write the first one.", pt: "Sem comentários. Escreva o primeiro." },
    { es: "Resuelto", en: "Resolved", pt: "Resolvido" },
    { es: "Reabrir", en: "Reopen", pt: "Reabrir" },
    { es: "Marcar como resuelto", en: "Mark as resolved", pt: "Marcar como resolvido" },
    { es: "Escribe un comentario…", en: "Write a comment…", pt: "Escreva um comentário…" },
    { es: "Añadir comentario", en: "Add comment", pt: "Adicionar comentário" },
    // Fallback labels for block fields that declare none (humanizeFieldKey) — keyed by prop name.
    { es: "Tema", en: "Theme", pt: "Tema" },
    { es: "Icono", en: "Icon", pt: "Ícone" },
    { es: "Color", en: "Color", pt: "Cor" },
    { es: "Fondo", en: "Background", pt: "Fundo" },
    { es: "Tamaño", en: "Size", pt: "Tamanho" },
    { es: "Variante", en: "Variant", pt: "Variante" },
    { es: "Texto alternativo", en: "Alt text", pt: "Texto alternativo" },
    { es: "Autor", en: "Author", pt: "Autor" },
    { es: "Cargo", en: "Role", pt: "Cargo" },
    { es: "Precio", en: "Price", pt: "Preço" },
    { es: "Nombre", en: "Name", pt: "Nome" },
    { es: "Cita", en: "Quote", pt: "Citação" },
    { es: "Destino del enlace", en: "Link target", pt: "Destino do link" },
    // Selection breadcrumb, action bar and keyboard shortcuts.
    { es: "Ruta de la selección", en: "Selection path", pt: "Caminho da seleção" },
    { es: "Seleccionar contenedor", en: "Select parent", pt: "Selecionar contêiner" },
    { es: "Editar texto", en: "Edit text", pt: "Editar texto" },
    { es: "Seleccionar contenedor (Esc)", en: "Select parent (Esc)", pt: "Selecionar contêiner (Esc)" },
    { es: "Subir bloque (Ctrl+Shift+↑)", en: "Move block up (Ctrl+Shift+↑)", pt: "Mover bloco para cima (Ctrl+Shift+↑)" },
    { es: "Bajar bloque (Ctrl+Shift+↓)", en: "Move block down (Ctrl+Shift+↓)", pt: "Mover bloco para baixo (Ctrl+Shift+↓)" },
    { es: "Duplicar bloque (Ctrl+D)", en: "Duplicate block (Ctrl+D)", pt: "Duplicar bloco (Ctrl+D)" },
    { es: "Editar texto (doble clic)", en: "Edit text (double-click)", pt: "Editar texto (clique duplo)" },
    { es: "Eliminar bloque (Supr)", en: "Delete block (Del)", pt: "Excluir bloco (Del)" },
    { es: "Acciones del bloque", en: "Block actions", pt: "Ações do bloco" },
    { es: "Deshacer", en: "Undo", pt: "Desfazer" },
    { es: "Rehacer", en: "Redo", pt: "Refazer" },
    { es: "Supr", en: "Del", pt: "Del" },
    { es: "Atajos de teclado", en: "Keyboard shortcuts", pt: "Atalhos de teclado" },
    { es: "Atajos de teclado (?)", en: "Keyboard shortcuts (?)", pt: "Atalhos de teclado (?)" },
    { es: "General", en: "General", pt: "Geral" },
    { es: "Bloque seleccionado", en: "Selected block", pt: "Bloco selecionado" },
    { es: "Guardar o publicar", en: "Save or publish", pt: "Salvar ou publicar" },
    { es: "Buscar bloques y acciones", en: "Search blocks and actions", pt: "Buscar blocos e ações" },
    { es: "Mostrar esta ayuda", en: "Show this help", pt: "Mostrar esta ajuda" },
    { es: "Copiar / pegar bloque", en: "Copy / paste block", pt: "Copiar / colar bloco" },
    { es: "Mover con las flechas (modo mover)", en: "Move with the arrow keys (move mode)", pt: "Mover com as setas (modo mover)" },
    { es: "Seleccionar el contenedor; otra vez, deseleccionar", en: "Select the parent; again, deselect", pt: "Selecionar o contêiner; de novo, desmarcar" },
    { es: "Editar el texto del bloque", en: "Edit the block's text", pt: "Editar o texto do bloco" },
    { es: "Doble clic", en: "Double-click", pt: "Clique duplo" },
    { es: "Buscar bloques o acciones…", en: "Search blocks or actions…", pt: "Buscar blocos ou ações…" },
    { es: "Usa ↑↓ para navegar · ↵ para ejecutar", en: "Use ↑↓ to navigate · ↵ to run", pt: "Use ↑↓ para navegar · ↵ para executar" },
    { es: "Contraer", en: "Collapse", pt: "Recolher" },
    { es: "Expandir", en: "Expand", pt: "Expandir" },
    { es: "Tienes cambios sin guardar. ¿Salir del editor sin guardarlos?", en: "You have unsaved changes. Leave the editor without saving them?", pt: "Você tem alterações não salvas. Sair do editor sem salvá-las?" },
    { es: "Salir sin guardar", en: "Leave without saving", pt: "Sair sem salvar" },
    { es: "Arrastra bloques dentro de este contenedor en el lienzo, o tócalos en la biblioteca con el contenedor seleccionado.", en: "Drag blocks into this container on the canvas, or tap them in the library while the container is selected.", pt: "Arraste blocos para dentro deste contêiner na tela, ou toque neles na biblioteca com o contêiner selecionado." },
    // Motion dock (IxDock / IxDockParts).
    { es: "Movimiento", en: "Motion", pt: "Movimento" },
    { es: "Movimiento del bloque", en: "Block motion", pt: "Movimento do bloco" },
    { es: "Plegar el panel de movimiento", en: "Collapse the motion panel", pt: "Recolher o painel de movimento" },
    { es: "Desplegar el panel de movimiento", en: "Expand the motion panel", pt: "Expandir o painel de movimento" },
    { es: "Cambiar la altura del panel de movimiento", en: "Resize the motion panel", pt: "Redimensionar o painel de movimento" },
    { es: "Arrastra para cambiar la altura", en: "Drag to resize", pt: "Arraste para redimensionar" },
    { es: "Selecciona un bloque para editar su animación de entrada y sus interacciones.", en: "Select a block to edit its entrance animation and interactions.", pt: "Selecione um bloco para editar sua animação de entrada e suas interações." },
    { es: "Suelta el bloque en el lienzo para editar su movimiento.", en: "Drop the block on the canvas to edit its motion.", pt: "Solte o bloco na tela para editar seu movimento." },
    { es: "Animación de entrada", en: "Entrance animation", pt: "Animação de entrada" },
    { es: "Un efecto rápido al aparecer el bloque. Para algo más elaborado, usa la interacción.", en: "A quick effect when the block appears. For something more elaborate, use the interaction.", pt: "Um efeito rápido quando o bloco aparece. Para algo mais elaborado, use a interação." },
    { es: "Línea de tiempo", en: "Timeline", pt: "Linha do tempo" },
    { es: "Probar", en: "Play", pt: "Testar" },
    { es: "Probar todo", en: "Play all", pt: "Testar tudo" },
    { es: "Reproducir la interacción de este bloque en el lienzo", en: "Play this block's interaction on the canvas", pt: "Reproduzir a interação deste bloco na tela" },
    { es: "Reproducir todas las interacciones de la página en el lienzo", en: "Play every interaction on the page on the canvas", pt: "Reproduzir todas as interações da página na tela" },
    { es: "Clips", en: "Clips", pt: "Clipes" },
    { es: "Arrastra a la línea de tiempo, o pulsa para aplicar", en: "Drag onto the timeline, or click to apply", pt: "Arraste para a linha do tempo ou clique para aplicar" },
    { es: "Arrastra un clip de la paleta (o elige un preajuste en el inspector) para encender la línea de tiempo.", en: "Drag a clip from the palette (or pick a preset in the inspector) to start the timeline.", pt: "Arraste um clipe da paleta (ou escolha uma predefinição no inspetor) para ativar a linha do tempo." },
    { es: "Guardar como preajuste", en: "Save as preset", pt: "Salvar como predefinição" },
    { es: "Guardado como preajuste", en: "Saved as preset", pt: "Salvo como predefinição" },
    { es: "No se pudo guardar el preajuste", en: "Could not save the preset", pt: "Não foi possível salvar a predefinição" },
    { es: "Nombre del preajuste", en: "Preset name", pt: "Nome da predefinição" },
    { es: "Usa el preajuste", en: "Uses the preset", pt: "Usa a predefinição" },
    { es: "Cambiarlo en Ajustes cambia todos los bloques que lo usan.", en: "Changing it in Settings changes every block that uses it.", pt: "Alterá-la em Configurações altera todos os blocos que a usam." },
    { es: "¿Te gusta este movimiento? Guárdalo como preajuste y reutilízalo en otros bloques.", en: "Like this motion? Save it as a preset and reuse it on other blocks.", pt: "Gostou deste movimento? Salve-o como predefinição e reutilize-o em outros blocos." },
    { es: "Los preajustes son movimientos guardados del sitio: elige uno abajo, o crea el tuyo y guárdalo aquí.", en: "Presets are the site's saved motions: pick one below, or build your own and save it here.", pt: "Predefinições são movimentos salvos do site: escolha uma abaixo ou crie a sua e salve-a aqui." },
    { es: "Editar en Ajustes", en: "Edit in Settings", pt: "Editar em Configurações" },
    { es: "Gestionar preajustes", en: "Manage presets", pt: "Gerenciar predefinições" },
    { es: "Cancelar", en: "Cancel", pt: "Cancelar" },
    { es: "Estado de publicación", en: "Publication status", pt: "Status de publicação" },
    { es: "Más opciones", en: "More options", pt: "Mais opções" },
    { es: "Buscar acciones y bloques", en: "Search actions and blocks", pt: "Buscar ações e blocos" },
];

const TRIPLES: Tri[] = [...BLOCKS_CATEGORIES, ...FIELD_STRINGS, ...CHROME_STRINGS, ...VERSO_CHROME_STRINGS];

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

/**
 * trStr for a Spanish source TEMPLATE with `{name}` placeholders: the template is translated whole
 * (the dictionary holds it with the placeholders in place) and the values are substituted after,
 * so a number or a block name never has to be part of a dictionary key.
 */
export function trFmt(s: string, lang: Language, vars: Record<string, string | number>): string {
    return trStr(s, lang).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Every dictionary entry containing `s` in any language (tests: coverage and conflicting duplicates). */
export function editorStringMatches(s: string): Tri[] {
    return TRIPLES.filter((t) => t.es === s || t.en === s || t.pt === s);
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

/** Copy of ONE field definition with its label/placeholder/option labels translated (same rules as walk). */
export function localizeField<T>(field: T, lang: Language): T {
    return walk(field, lang);
}

// Spanish source label for the prop names blocks most often leave unlabelled. trStr then renders it
// in the UI language; a key not listed here is split on camelCase/_/- and capitalised instead, so the
// inspector never shows a raw `titleSize` or `description`.
const FIELD_KEY_LABELS: Record<string, string> = {
    title: "Título",
    subtitle: "Subtítulo",
    description: "Descripción",
    text: "Texto",
    content: "Contenido",
    label: "Etiqueta",
    theme: "Tema",
    icon: "Icono",
    color: "Color",
    bg: "Fondo",
    background: "Fondo",
    size: "Tamaño",
    variant: "Variante",
    align: "Alineación",
    alignment: "Alineación",
    href: "Enlace",
    link: "Enlace",
    url: "URL",
    src: "Imagen",
    image: "Imagen",
    alt: "Texto alternativo",
    items: "Elementos",
    author: "Autor",
    role: "Cargo",
    price: "Precio",
    name: "Nombre",
    quote: "Cita",
    level: "Nivel",
    type: "Tipo",
    target: "Destino del enlace",
};

/** Readable label for a field that declares none — never the raw prop key. */
export function humanizeFieldKey(key: string, lang: Language): string {
    const known = FIELD_KEY_LABELS[key];
    if (known) return trStr(known, lang);
    const words = key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/** Return a copy of a block config with all editor-chrome strings translated to `lang`. */
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
