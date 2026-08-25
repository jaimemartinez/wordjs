<!-- GENERATED from contracts/visual-contract.v1.json; do not edit. -->
# Contrato visual para plugins (v1)

El backend es la autoridad de seguridad. Backend, frontend, Verso y esta documentación se generan desde
`contracts/visual-contract.v1.json`; ningún plugin debe importar módulos internos del backend ni copiar sus límites.

## Templates de tema

Límites: 65536 bytes, 100 bloques y profundidad 4. Debe existir exactamente un `PageContent`.

| Bloque | Slot de hijos | Propiedades |
| --- | --- | --- |
| `PageContent` | — | — |
| `Section` | `items` | background: string<br>padding: string<br>maxWidth: string<br>tag: wrapper-tag<br>className: classlist |
| `Grid` | `items` | columns: number<br>gap: string<br>columnsTablet: number<br>columnsMobile: number<br>tag: wrapper-tag<br>className: classlist |
| `FlexRow` | `items` | gap: string<br>align: enum<br>justify: enum<br>wrap: boolean<br>direction: enum<br>tag: wrapper-tag<br>className: classlist |
| `Columns` | `items` | columns: number<br>gap: string<br>tag: wrapper-tag<br>className: classlist |
| `Spacer` | — | height: string |
| `Divider` | — | color: string<br>width: string<br>length: string<br>gap: string |
| `PostsGrid` | — | count: number<br>columns: number<br>gap: string<br>bg: string<br>borderColor: string<br>radius: string<br>pad: string<br>thumbHeight: string |
| `CategoryPosts` | — | count: number<br>categorySlug: string<br>layout: enum<br>columns: number<br>gap: string<br>bg: string<br>borderColor: string<br>radius: string<br>linkColor: string<br>headingColor: string |
| `SearchBar` | — | placeholder: string<br>buttonText: string<br>align: enum<br>width: string<br>inputBg: string<br>inputBorderColor: string<br>inputRadius: string<br>buttonBg: string<br>buttonColor: string<br>buttonRadius: string |
| `TemplatePart` | — | name: partname (required)<br>area: template-part-area (required) |

## Chrome

Límites: 65536 bytes, 100 bloques y profundidad 3.

| Bloque | Propiedades |
| --- | --- |
| `ChromeLogo` | size: enum |
| `ChromeSiteTitle` | showTagline: boolean |
| `ChromeNav` | location: enum (required)<br>orientation: enum (required) |
| `ChromeSearch` | placeholder: string |
| `ChromeSocials` | source: enum (required) |
| `ChromeText` | text: string (required) |
| `ChromeButton` | label: string (required)<br>href: href (required)<br>variant: enum (required) |
| `ChromeSpacer` | size: enum (required) |
| `ChromeRow` | items: slot (required)<br>align: enum (required)<br>gap: enum (required)<br>wrap: boolean |

## Registro core de Verso

| Tipo serializado/renderizado | Categoría | Slots |
| --- | --- | --- |
| `Heading` | content | — |
| `Text` | content | — |
| `Image` | content | — |
| `Divider` | layout | — |
| `Button` | content | — |
| `Spacer` | layout | — |
| `Section` | layout | `children` |
| `Grid` | layout | `children` |
| `FlexRow` | layout | `children` |
| `Columns` | layout | `col-0`, `col-1`, `col-2` |
| `Card` | content | — |
| `Quote` | content | — |
| `Table` | content | — |
| `IconList` | content | — |
| `SocialLinks` | content | — |
| `Stats` | content | — |
| `HTMLEmbed` | content | — |
| `PricingTable` | content | — |
| `Testimonial` | content | — |
| `CTABanner` | content | — |
| `VideoEmbed` | content | — |
| `Hero` | layout | — |
| `PostsGrid` | content | — |
| `CategoryPosts` | content | — |
| `AudioPlayer` | content | — |
| `Accordion` | layout | — |
| `Tabs` | layout | — |
| `SearchBar` | content | — |
| `Form` | content | — |
| `Symbol` | content | — |
| `ParticleField` | layout | — |
| `NavMenu` | layout | — |
| `SiteLogo` | layout | — |
| `BackToTop` | layout | — |
| `OffCanvas` | layout | `content` |
| `Breadcrumbs` | layout | — |
| `LangSwitcher` | layout | — |
| `TableOfContents` | layout | — |
| `MegaMenu` | layout | `panel0`, `panel1`, `panel2`, `panel3`, `panel4`, `panel5` |

## Reglas de seguridad

- HTML enriquecido: solo las propiedades `content`, `html`, `text`, `title`, `heading`, `description`, `caption`, `body` activan el saneador autoritativo.
- URL: solo esquemas de contenido `http`, `https`, `mailto`, `tel`; navegación estructural limitada a `http`, `https` y rutas del sitio.
- Estilos: 40 propiedades CSS y 2 variables personalizadas están permitidas por nombre; valores con sintaxis de inyección son eliminados.
- Clases estructurales: máximo 3 tokens que casen `^[a-z][a-z0-9-]{0,39}$`, además del filtro contra clases que sacan contenido del flujo.

Para añadir un bloque, cambie la definición canónica, regenere y proporcione su implementación de render. El gate F5 comprueba que el editor y el renderer cubran exactamente el registro generado.
