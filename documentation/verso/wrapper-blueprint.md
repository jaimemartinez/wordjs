# Blueprint del wrapper actual — piel exacta a replicar en `VersoEditor` (F3)

> Objetivo de este documento: que quien construya el wrapper `VersoEditor` (F3) NO necesite volver
> a abrir `PuckEditor.tsx` para saber cómo se ve el editor de hoy. Todo lo que sigue es inventario,
> no diseño nuevo — cero código de producción, cero decisiones. Restricción del usuario: *"el editor
> nuevo debe verse igual que el diseño que habíamos hecho para nuestro custom puck"*.

**Fuentes leídas completas (no por muestreo):**

| Fichero | LOC | Rol |
|---|---|---|
| `frontend/src/components/PuckEditor.tsx` | 2202 | Chrome monolítico: header, rail, panel izq/der, canvas, drawers, hotkeys, autosave |
| `frontend/src/components/BlockInserter.tsx` | 439 | Tarjetas de bloque + tab Plantillas, dentro del panel izquierdo |
| `frontend/src/components/CommandPalette.tsx` | 236 | ⌘K — acciones + inserción de bloque, portal a `<body>` |
| `frontend/src/components/puck-theme.css` | 362 | Retinte de las clases del fork + los tokens `--ed-*` (única fuente) |
| `frontend/src/components/editor/MSym.tsx` | 31 | Wrapper del glifo ligature-based |
| `frontend/src/lib/blockCatalog.ts` | 106 | `BLOCK_META` (icono/grupo/desc por bloque), `GROUP_MS_ICON` |
| `frontend/src/lib/puckI18n.ts` | 463 | `TRIPLES` es/en/pt — `trStr()` resuelve por **igualdad byte-a-byte** del string ES |
| `frontend/public/fonts/material-symbols-outlined-subset.woff2` | — | Subset de 161 glifos, inspeccionado con `fontTools` (método abajo) |
| `frontend/src/app/admin/layout.tsx`, `frontend/src/app/fonts.ts` | — | Cómo llega Inter al editor |
| `frontend/packages/puck/components/DraggableComponent/index.tsx` (líneas 680-720) | — | Los 3 botones NATIVOS del ActionBar del fork (Edit/Duplicate/Delete) — no son código de la app pero SÍ son parte visible de la piel |

---

## 0. Un hallazgo que ahorra trabajo: `overrides.headerActions` / `overrides.button` están MUERTOS

`PuckEditor.tsx` líneas 1265-1346 declaran `overrides.headerActions` y `overrides.button` (un
header "de repuesto" con botones Tailwind azules genéricos, `fa-clock-rotate-left`, `fa-eye`,
`fa-floppy-disk`…). **Nunca se renderizan.** `<Puck>` recibe `children` (la composición manual con
`<Puck.Preview/>`, `<Puck.Fields/>`, etc. — línea 1675 en adelante), y el propio fork solo usa
`overrides.headerActions`/`<Header/>` en su rama `children || (...)` (ver
`frontend/packages/puck/components/Puck/index.tsx` línea ~511) — con `children` presentes esa rama
jamás corre. **La piel real es EXCLUSIVAMENTE el JSX manual de las líneas 1696-2161.** No repliques
`overrides.headerActions`/`button` — es ruido, no diseño.

---

## a) LAYOUT

### Contenedor raíz

```
.puck-container                          fixed inset-0 z-50 bg-[var(--ed-surface)]
  └─ <Puck config data ... iframe={{enabled:true}}>
       └─ div.flex.flex-col.h-screen.w-full.overflow-hidden      ← columna vertical: header / content-area / mobile-nav
```

`.puck-container iframe` (el `<canvas>` real) es el selector de acceso usado en ≥10 sitios
distintos del wrapper (hotkeys, guías, tema, a11y, animaciones) — si `VersoEditor` no usa iframe,
cada uno de esos 10 puntos necesita su equivalente explícito, no es opcional.

### HEADER — 48px (`h-12`)

Una fila, 3 grupos, `justify-between`, fondo `--ed-surface`, `border-b` `--ed-outline-variant`,
`px-3 gap-3`, `z-20`.

**Grupo izquierdo** (`flex items-center gap-3 min-w-0`):
1. Botón salir en móvil (`md:hidden`, solo si `onCancel`) — `MSym chevron_left` 22px.
2. Wordmark "WordJS" — `text-[18px] font-black tracking-tight text-[var(--ed-primary)] select-none`.
3. Separador vertical `h-4 w-px bg-[var(--ed-outline-variant)]` (`hidden md:block`).
4. Breadcrumb (`hidden md:flex`, `text-[12px]`): `{breadcrumbRoot}` (botón si hay `onCancel`) ›
   `MSym chevron_right` 12px opacity-50 › título de la página en `font-semibold text-[var(--ed-on-surface)] truncate max-w-[220px]`.

**Grupo centro** (`flex items-center gap-3 shrink-0`):
1. `ViewportControls` — segmented control (ver abajo).
2. Separador vertical.
3. `HistoryControls` — undo/redo.
4. `SaveStateChip` — solo si hay `onSave`.
5. Chip de presencia (`coEditors.length > 0`, `hidden lg:flex`) — píldora ámbar con `MSym person`
   14px filled + nombres + "también está/están editando".

**Grupo derecho** (`flex items-center gap-2 min-w-0`):
1. Botón "Insertar" (`hidden lg:flex`) — `MSym search` 14 + texto 11px + `<kbd>⌘K</kbd>` monoespaciado.
2. Replay animaciones (`hidden md:flex`) — `MSym play_arrow` 18.
3. Guías (`hidden md:flex`) — `MSym grid_view` 16, estado activo = `bg-surface-container-high text-primary`.
4. Toggle panel propiedades (`hidden md:flex`) — `MSym tune` 18, mismo patrón de estado activo.
5. Selector de estado (`ModernSelect`, `hidden md:block`) — draft/publish/pending.
6. Botón "Vista Previa" (`hidden md:block`) — borde, sin relleno.
7. Botón Guardar/Publicar — relleno `--ed-primary`, `MSym sync` 12 animado mientras `saving`.
8. Avatar — círculo 32px `--ed-primary-container` con `MSym person` 16 filled.

Todos los botones cuadrados del header son **28px** (`w-7 h-7`) salvo el avatar (32px) y el select
(altura de `ModernSelect`).

### RAIL izquierdo — 64px (`w-16`), oculto en móvil (`hidden md:flex`)

Columna, `bg-[var(--ed-surface)]`, `border-r`, `py-2 gap-1 z-30`. Cada entrada es un botón
**48×48px** (`w-12 h-12 rounded-lg flex-col gap-1`) con `MSym` 20px + etiqueta `text-[9px]`.

Orden exacto:
1. `blocks` — `add_box` — "Bloques"
2. `outline` — `layers` — "Estructura"
3. `patterns` — `dashboard_customize` — "Plantillas"
4. (separado, sin selección de `railView`) `image` — "Recursos" → abre `MediaPickerModal`
5. `mt-auto` (empuja al fondo): `forum` "Notas" (solo si `pageId`) · `history` "Historial" (solo si
   `pageId`) · `settings` "Ajustes" (deselecciona y abre el panel derecho)

Estado activo = `bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)]` +
`fill={active}` en el `MSym`. **Click sobre la vista YA activa colapsa el panel** (no hay botón de
colapso aparte) — comportamiento a preservar, no solo el look.

### PANEL IZQUIERDO — 280px (`md:w-[280px]`)

```
div (header 40px, h-10, px-3, bg-surface-container-low, border-b)
  ├─ span.uppercase.text-[11px].font-semibold.tracking-wider   ← "Bloques"/"Plantillas"/"Estructura"
  └─ botón cerrar (chevron_left en desktop / close en móvil, 16px)
div.flex-1.overflow-y-auto.custom-scrollbar
  └─ <Puck.Outline/> (railView==='outline', envuelto en p-3)
     — o —
     <BlockInserter components view={railView} onInsert={...}/>
```

Colapsa a `md:w-0 md:opacity-0` (transición 200ms) — nunca `display:none` en desktop (permite la
transición de ancho); usa el atributo `inert` cuando está colapsado para sacar sus controles del
tab order. En móvil es un sheet fijo (`fixed inset-x-0 top-12 bottom-14 z-40`) entre el header y el
nav inferior, controlado por `mobileSheet==='left'` — **estado separado** de `showSidebar` a
propósito (no contaminar la preferencia de escritorio persistida).

### CANVAS (`PreviewFrame`)

- Fondo `--ed-surface-container-low` + retícula de puntos (`radial-gradient` 0.5px, `20px 20px`,
  color `#c8c4d5`).
- Escritorio: tarjeta blanca con borde `--ed-outline-variant` + `shadow-lg`, ancho fijo **1280px**
  (NO el ancho disponible — la promesa del preset "Escritorio" es el breakpoint `lg:` real).
- Tablet/móvil: tarjeta con bisel — `ring-[7px] ring-gray-900 rounded-[2rem] shadow-2xl`, anchos
  **768px** / **375px**.
- Todo se escala (`transform: scale()`, `origin-top-left`) para caber en el área disponible; padding
  del área: 28px desktop, 24px tablet/móvil, 12px si `area.w < 640` (ventana angosta → sin bisel,
  ancho real disponible, sin downscale).
- Estado vacío (`data.content.length === 0`): tarjeta centrada `bg-white/95 backdrop-blur`, círculo
  144px con `MSym space_dashboard` 56, título 18px, CTA píldora `MSym add_circle` + 3 patrones
  rápidos (`PATTERNS.slice(0,3)`).

### PANEL DERECHO (`PropertiesPanel`) — 320px (`md:w-[320px]`)

```
aside (md:static md:w-[320px], en móvil: fixed inset-x-0 top-12 bottom-14 z-40)
  ├─ header (p-3, bg-surface-container-low, border-b)
  │    ├─ chip 32×32 rounded, bg-primary-container, MSym {icono del bloque} 20
  │    ├─ nombre del bloque (12px bold) + "ID: <id>" en --puck-font-family-monospaced (10px)
  │    └─ botón cerrar — MSym chevron_right 16
  ├─ tabs (role=tablist, border-b) — Contenido · Estilo · Avanzado
  │    activa: text-primary border-b-2-primary bg-surface-container-low
  │    deshabilitada (sin campos de ese tipo): text-outline-variant cursor-not-allowed
  ├─ <Puck.Fields/> dentro de div[data-ptab={tab}] — el filtrado es 100% CSS (ver sección b)
  │    overlay "Panel bloqueado" mientras isDragging (círculo 64px + replace_image 32 + texto)
  └─ footer (solo si hay estilo/avanzado disponibles): botón "Restablecer estilos" full-width,
       borde, MSym refresh 14, hover → texto --ed-error
```

Las 3 pestañas **NO son un `<Puck.Fields>` distinto** — Puck renderiza una única lista plana de
campos; el split es CSS puro sobre 3 clases marcador que los campos compartidos ya llevan
(`wjs-f-look` / `wjs-f-anim` / `wjs-f-hide`, ver sección b). Si `VersoEditor` no reproduce esas
clases marcador en sus propios campos compartidos, las pestañas Estilo/Avanzado quedan
permanentemente deshabilitadas (el `useEffect` de disponibilidad hace `querySelector` sobre ellas).

### Mobile bottom nav — 56px (`h-14`), `fixed inset-x-0 bottom-0 z-40`

4 pestañas iguales (`flex-1 flex-col`): Bloques (`add_box`) · Capas (`layers`) · Propiedades
(`tune`) · Ajustes (`settings`). Icono en píldora `w-10 h-6`, activa = `bg-primary text-white`.

**FAB** insertar — `fixed right-4 bottom-[72px] z-40`, círculo 48px, `bg-primary`, `MSym add` 24,
oculto mientras hay un sheet abierto.

### Overlays / drawers flotantes

| Elemento | Posición | z-index | Ancho |
|---|---|---|---|
| `CommandPalette` (⌘K) | portal a `<body>`, `pt-[14vh]` centrado | `z-[9999]` | `max-w-xl`, `max-h-[70vh]` |
| Drawer A11y | `fixed top-12 bottom-0 right-0` | `z-[90]` | `340px` |
| `RevisionsSidebar` | (componente aparte, no auditado línea a línea) | `z-5000` (memoria) | — |
| `ReviewComments` | (idem) | — | — |
| Toast | `fixed bottom-16 md:bottom-4`, `right: 336px` si panel der. abierto, si no `16px` | `z-[80]` | auto |

---

## b) TOKENS

**Regla de oro: `puck-theme.css` es el ÚNICO dueño de `--ed-*` hoy.** `globals.css` tenía una
definición vieja, sin consumidores, y fue borrada a propósito por colisión (línea 28-29 de
`globals.css`: *"the old `--ed-*` editor-chrome tokens lived here… deleted, single owner"*). Si
`VersoEditor` redeclara `--ed-*` en otro fichero, reintroduce exactamente esa colisión.

### Roles `--ed-*` (valores STATED del diseño Stitch, no derivados)

| Token | Valor | Uso típico |
|---|---|---|
| `--ed-surface` | `#fcf8ff` | Fondo del `.puck-container`, header |
| `--ed-surface-container` | `#f0ecf6` | Fondos de botón/hover neutro, viewport track |
| `--ed-surface-container-low` | `#f6f2fc` | Headers de panel, canvas bg |
| `--ed-surface-container-high` | `#eae6f1` | Estado activo de icon-buttons del header |
| `--ed-surface-container-highest` | `#e4e1eb` | — |
| `--ed-surface-container-lowest` | `#ffffff` | Panel izq/der, tarjetas de bloque |
| `--ed-on-surface` | `#1b1b22` | Texto principal |
| `--ed-on-surface-variant` | `#464553` | Texto secundario, iconos inactivos |
| `--ed-outline` | `#777584` | Bordes fuertes, placeholder — **exactamente 4.50:1 en blanco: CERO margen AA**, no usar para texto pequeño (nota explícita en el código, línea 267 BlockInserter) |
| `--ed-outline-variant` | `#c8c4d5` | Bordes hairline por defecto |
| `--ed-primary` | `#1f108e` | Acento, CTA, tab activa |
| `--ed-primary-container` | `#3730a3` | Chip de identidad de bloque, rail activo |
| `--ed-on-primary-container` | `#a9a7ff` | Texto/icono sobre `primary-container` |
| `--ed-primary-fixed` | `#e2dfff` | Scrollbar thumb, hover de tarjetas de patrón |
| `--ed-secondary-container` | `#6063ee` | (declarado, sin consumidor confirmado en estos 3 ficheros) |
| `--ed-inverse-surface` | `#303037` | ActionBar flotante, Toast, DragHint pill |
| `--ed-inverse-on-surface` | `#f3eff9` | Texto sobre inverse-surface |
| `--ed-surface-dim` | `#dcd8e3` | (declarado, sin consumidor confirmado) |
| `--ed-error` | `#ba1a1a` | Delete hover, reset-styles hover |
| `--ed-error-container` | `#ffdad6` | Delete action (reposo) |
| `--ed-on-error-container` | `#93000a` | — |
| `--ed-success` | `#4ade80` | Check del toast (única fuente: `text-green-400` del Stitch original — NO se inventó, el código lo dice explícitamente) |

### Otros tokens vivos

| Token | Definición | Nota |
|---|---|---|
| `--puck-font-family-monospaced` | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | IDs de bloque, `<kbd>`, inputs numéricos |
| `--puck-font-family` | en `body{}`: `var(--font-inter, "Inter"), "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` | Declarado en `body`, no en `:root`, por diseño (ver Tipografía abajo) |
| `--puck-side-bar-width` | `280px` | **TRAMPA**: es una variable STOCK del fork Puck para SU propio sidebar; el panel izquierdo real de 280px es Tailwind arbitrario (`w-[280px]`) y NO consume esta variable — coincidencia de valor, no acoplamiento |
| `--toast-right` | inline, `336px` / `16px` según `showProperties` | Solo en el `style` del Toast |

Las rampas `--puck-color-azure-*` / `--puck-color-grey-*` / `--puck-color-red-*` (12 pasos cada
una, interpoladas en OKLCH desde los roles del Stitch) retintan **el fork de Puck**, no el chrome de
la app — irrelevantes para `VersoEditor` salvo que reuse literalmente las clases CSS-module del
fork (no las reusará, es un motor nuevo).

### Reglas CSS a preservar por SIGNIFICADO, no por selector de fork

`puck-theme.css` tiene dos categorías de reglas — una portable, otra no:

**PORTABLE (aplica igual sin el fork):**
- `@font-face` × 2 (Material Symbols subset + JetBrains Mono var) + `.msym{...}` — copiar tal cual.
- El bloque `body{--puck-font-family:...}` — adaptar el nombre de variable si `VersoEditor` no
  reusa `--puck-font-family`, pero preservar el ENCADENAMIENTO `var(--font-inter, "Inter")` y el
  hecho de que se declara en un ANCESTRO donde `--font-inter` ya existe (ver Tipografía).
- El bloque de scrollbars custom (`.custom-scrollbar`, thumb `--ed-primary-fixed`, 4px) — clases
  `.puck-container`/`.puck-editor-ui` son namespacing de la app, no del fork; portan igual.
- `.wjs-colorful` (react-colorful sizing) — si el picker de color sobrevive tal cual.
- El bloque de pointer-events para `.inline-text-view [contenteditable]` / `.wjs-bubble-menu` — es
  el fix concreto que hace clicable el editor inline; el MECANISMO (Puck pone
  `pointer-events:none` en contenido renderizado durante drag) puede no existir en el motor nuevo,
  pero si `VersoEditor` tiene un problema equivalente, esta es la receta.

**FORK-SPECIFIC (selectores `[class*="_ActionBar_"]`, `[class*="_DraggableComponent_"]`,
`[class*="_LayerTree_"]`, `[class*="PuckFields-*"]`, `[class*="Input-*"]`) — NO PORTAN.** Targetean
fragmentos legibles de nombres de clase CSS-module generados por el build de `@wordjs/puck`; un
motor nuevo no tiene esas clases. Lo que SÍ hay que preservar es el **resultado visual** que
describen (pill oscura del ActionBar flotante con sombra `0 8px 24px rgba(27,27,34,.28)`; wash de
hover `rgba(96,99,238,.08)`; selección = outline `--ed-primary-container` + `box-shadow: 0 0 0 4px
rgba(31,16,142,.12)`; filas de árbol 13px con borde-izquierdo 2px en selección; inputs 4px de
radio, borde `--ed-outline-variant` → `--ed-outline` en hover, focus → `--ed-primary`; radio-group
segmentado con celda activa rellena de `--ed-primary`) — ese resultado sí es parte del diseño a
igualar, solo que expresado con las clases propias del wrapper nuevo.

Filtrado de pestañas del panel derecho (SÍ portable como CONTRATO, ver sección PropertiesPanel):
```css
[data-ptab="content"] [campo]:has(.wjs-f-look),
[data-ptab="content"] [campo]:has(.wjs-f-anim),
[data-ptab="content"] [campo]:has(.wjs-f-hide) { display:none; }
[data-ptab="style"] [campo]:not(:has(.wjs-f-look)) { display:none; }
[data-ptab="advanced"] [campo]:not(:has(.wjs-f-anim)):not(:has(.wjs-f-hide)) { display:none; }
```

### Tipografía — cómo llega Inter al editor (cadena completa, verificada, 3 ficheros)

1. `frontend/src/app/fonts.ts` — `Inter({subsets:["latin"], variable:"--font-inter"})`. next/font
   registra la familia real con un nombre HASHEADO (`__Inter_<hash>`), nunca el literal `"Inter"`.
2. `frontend/src/app/layout.tsx` — `inter.variable` va en `<html className=...>` (es decir, en
   `:root`), NO en `<body>` — el comentario de `puck-theme.css` línea 130-134 (*"Declared on BODY,
   not :root"*) describe la razón histórica del patrón pero está **desactualizado respecto al
   layout actual**: hoy `--font-inter` SÍ está disponible en `:root` directamente. No es un bug —
   `body{--puck-font-family:var(--font-inter,...)}` sigue resolviendo (body hereda de html) — pero
   si `VersoEditor` copia la razón textual del comentario, copiaría una explicación caduca.
3. `frontend/src/app/admin/layout.tsx` línea 52 — el árbol admin completo (que incluye el editor)
   se envuelve en `<div className={inter.className}>` — esto aplica la clase de fuente REAL
   directamente, además (no en vez) de la variable. Es la razón por la que el editor tiene Inter
   incluso si algo rompiera la cadena de la variable.

**Para `VersoEditor`: basta con que su árbol viva bajo `admin/layout.tsx` (o repita ese mismo
patrón `inter.className` + `--font-inter` accesible en un ancestro) — no hace falta reinventar la
carga de fuentes.**

---

## c) ICONOGRAFÍA

### Tres sistemas de iconos conviven en la piel actual — no es una elección, es el estado real:

1. **Material Symbols Outlined, subset ligature-based, vía `<MSym name="…"/>`** — el sistema del
   CHROME de la app (header, rail, panel, BlockInserter, CommandPalette, blockCatalog). 161 glifos
   nombrados, self-hosted en `/fonts/material-symbols-outlined-subset.woff2?v=2` (95 280 bytes,
   `font-display:block`).
2. **Font Awesome 6 (self-hosted, SIN subsetear)** — `<i className="fa-solid fa-…">`. Vive en el
   código MUERTO de `overrides.headerActions` (sección 0) y en `BLOCK_META.icon` (el campo legacy
   `icon`, todavía consumido por otros lugares fuera del alcance de este blueprint — no lo
   necesitas para replicar la piel visible, pero no lo borres del catálogo si otra superficie lo
   lee). También aparece en `PATTERN_MS_ICON` como las CLAVES de un mapa que traduce el `icon`
   (Font Awesome) de `PATTERNS` a un `ms` (Material Symbols) para las tarjetas de patrón — un
   patrón de traducción, no una mezcla accidental.
3. **lucide-react**, solo dentro del fork vendorizado, en los 2 botones NATIVOS del ActionBar de
   bloque que la app NO controla: `Duplicate` → `<Copy size={16}/>`, `Delete` → `<Trash
   size={16}/>` (`frontend/packages/puck/components/DraggableComponent/index.tsx` líneas 710-719).
   El tercer botón nativo, `Edit` (línea 693-708, la divergencia WORDJS #2), usa Font Awesome:
   `<i className="fa-solid fa-pencil"/>` — NO Material Symbols. Si `VersoEditor` reconstruye el
   ActionBar de bloque desde cero (que es justo lo que la auditoría F0 recomienda:
   "reimplementar ese punto de entrada desde cero"), aquí tienes los 3 glifos exactos a igualar:
   **pencil (editar) · copy (duplicar) · trash (eliminar)**, más los 2 que sí son de la app
   (`ActionBarOverride`, Material Symbols): `expand_less` (Subir) / `expand_more` (Bajar).

### Cómo se extrajo el subset (reproducible, sin nueva dependencia — `fontTools` ya estaba disponible)

```
python3 -c "
from fontTools.ttLib import TTFont
f = TTFont('frontend/public/fonts/material-symbols-outlined-subset.woff2')
f.saveXML('gsub_dump.ttx', tables=['GSUB','cmap'])
"
```
El subset usa el feature GSUB `rlig` (`LigatureSubst`, lookup type 7→4): cada nombre de icono es
una secuencia de glifos-carácter (`d,e,l,e,t,e` → un único glifo `uniE872`) sustituida por
ligadura — exactamente como funciona la fuente COMPLETA de Material Symbols, solo que aquí con
únicamente 161 secuencias registradas. **Un nombre fuera de esas 161 no tiene regla de sustitución
→ el navegador imprime las letras sueltas del `name` tal cual, en vez de un glifo → caja/texto
roto.** Regenerar el subset = volver a pedir la API `css2` de Google Fonts con el parámetro
`icon_names=` incluyendo el nombre nuevo (no hay script propio committeado que automatice esto hoy
— es manual).

### Los 161 nombres del subset actual (verificado por extracción binaria, no por lectura de código)

```
access_time, access_time_filled, add, add_box, add_circle, add_circle_outline, animation, api,
arrow_downward, arrow_upward, article, assessment, audiotrack, badge, bolt, calendar_month,
call_to_action, category, check, check_box_outline_blank, check_circle, check_circle_filled,
check_circle_outline, chevron_left, chevron_right, clear, close, cloud_done, cloud_off,
cloud_upload, code, collections, color_lens, content_copy, control_point, create, crop_16_9,
crop_original, dashboard, dashboard_customize, delete, delete_outline, description,
desktop_windows, device_reset, drag_indicator, edit, email, expand_less, expand_more, filter,
filter_list, fmd_good, format_align_center, format_align_justify, format_align_left,
format_align_right, format_quote, forum, gallery_thumbnail, grade, grid_view, help, help_outline,
history, horizontal_rule, https, image, imagesmode, info, insert_chart, insert_chart_filled,
insert_chart_outlined, insert_link, insert_photo, keyboard_command_key, keyboard_return, launch,
layers, link, list, list_alt, location_on, location_pin, lock, lock_open, lock_outline, mail,
mail_outline, map, markunread, menu_book, mobile, mode, mode_edit, mode_edit_outline, more_horiz,
more_vert, movie, movie_creation, music_note, navigate_before, navigate_next, newspaper,
open_in_new, palette, perm_identity, person, person_filled, person_outline, place, play_arrow,
play_circle, poll, publish, query_builder, question_answer, redo, refresh, remove_red_eye,
replace_image, restore, room, rss_feed, schedule, search, security, settings, share, smart_button,
smartphone, space_bar, space_dashboard, star, star_border, star_outline, stay_current_portrait,
storefront, subject, sync, table_chart, tablet_mac, timeline, title, toc, tune, undo, unfold_less,
unfold_more, view_agenda, view_carousel, view_column, view_comfy, view_quilt, view_stream,
visibility, visibility_off, watch_later, web, web_asset, widgets
```

**Verificación cruzada (script, no inspección manual):** los 64 nombres literales usados hoy en
`PuckEditor.tsx` + `BlockInserter.tsx` + `CommandPalette.tsx` + `blockCatalog.ts` (más el fallback
`"widgets"`) están **los 65 dentro del subset** — CERO cajas vacías hoy. Cualquier glifo nuevo que
`VersoEditor` quiera usar debe estar en esta lista o regenerar el `.woff2`.

### Mapa 1:1 — icono usado, dónde, para qué (los 3 ficheros en alcance)

| Contexto | `name`/`ms` | Tamaño típico | Nota |
|---|---|---|---|
| Undo / Redo (`HistoryControls`) | `undo` / `redo` | 20 | disabled → `--ed-outline-variant` |
| Save chip — guardando | `sync` (clase `animate-spin`) | 16 | |
| Save chip — cambios sin guardar | `cloud_upload` | 16 | color `amber-700` inline, no token `--ed-*` |
| Save chip — guardado | `cloud_done` | 16 | `fill` activo, color `--ed-primary` |
| Viewport switcher | `desktop_windows` / `tablet_mac` / `smartphone` | 18 | segmented control |
| ActionBar override — mover | `expand_less` / `expand_more` | 16 | Subir/Bajar, Material Symbols (NO lucide) |
| Drag hint pill | `info` | 18 | |
| Rail: Bloques / Estructura / Plantillas | `add_box` / `layers` / `dashboard_customize` | 20 | `fill={active}` |
| Rail: Recursos | `image` | 20 | |
| Rail: Notas / Historial / Ajustes | `forum` / `history` / `settings` | 20 | |
| Panel izq — cerrar | `chevron_left` (desktop) / `close` (móvil) | 16 | |
| Panel izq — buscar bloque | `search` | 18 | + botón limpiar `close` 16 |
| Panel izq — tabs Bloques/Plantillas | `add_box` / `dashboard_customize` | 14 | |
| Panel der — icono de identidad del bloque | `BLOCK_META[type].ms \|\| "widgets"` | 20 | dentro de chip 32px |
| Panel der — cerrar | `chevron_right` | 16 | |
| Panel der — drag lock overlay | `replace_image` | 32 | |
| Panel der — reset estilos | `refresh` | 14 | |
| Header — insertar (⌘K) | `search` | 14 | + `<kbd>⌘K</kbd>` |
| Header — replay animaciones | `play_arrow` | 18 | |
| Header — guías | `grid_view` | 16 | |
| Header — toggle panel propiedades | `tune` | 18 | |
| Header — guardar/publicar | `sync` (solo mientras `saving`) | 12 | |
| Header — avatar | `person` | 16 | `fill` |
| Header — presencia | `person` | 14 | `fill` |
| Empty canvas — ilustración | `space_dashboard` | 56 | |
| Empty canvas — CTA | `add_circle` | 20 | |
| Mobile bottom nav | `add_box` / `layers` / `tune` / `settings` | 18 | `fill={active}` |
| Mobile FAB | `add` | 24 | |
| Toast — check | `check_circle` | 20 | `fill`, color `--ed-success` |
| Toast — cerrar | `close` | 16 | |
| A11y drawer — cerrar | `close` | 16 | |
| CommandPalette — buscador | `search` | 18 | |
| CommandPalette — sin resultados | `search` | 32 | opacity 40% |
| BlockInserter — grupo | `GROUP_MS_ICON[grupo]` (`space_dashboard`/`edit`/`imagesmode`/`bolt`/`rss_feed`/`widgets`) | 14 | |
| BlockInserter — tarjeta de bloque | `BLOCK_META[type].ms \|\| "widgets"` | 20 | ver tabla completa en `blockCatalog.ts` |
| BlockInserter — pattern (usuario) | `add_circle` / `delete` | 16/14 | |
| BlockInserter — pattern (built-in) | `PATTERN_MS_ICON[p.icon] \|\| "dashboard_customize"` | 18 | traducción fa-*→ms, ver tabla abajo |

`PATTERN_MS_ICON` (Font Awesome del catálogo `PATTERNS` → Material Symbols de la tarjeta):
`fa-mountain-sun→web · fa-heading→title · fa-list-check→list_alt · fa-grip→grid_view ·
fa-chart-simple→insert_chart · fa-tags→storefront · fa-quote-left→format_quote ·
fa-circle-question→help · fa-bullhorn→call_to_action`.

`BLOCK_META.ms` completo (30 bloques + fallback) vive en `frontend/src/lib/blockCatalog.ts`
líneas 19-58 — reprodúcelo literal, es la tabla que alimenta TANTO `BlockInserter` como
`CommandPalette` (fuente compartida, no dupliques).

---

## d) MICROINTERACCIONES

### `SaveStateChip` — estados y textos exactos (byte-a-byte, `trStr` clave el string ES)

| Estado (orden de evaluación) | Icono | Texto ES | Color |
|---|---|---|---|
| `saving` | `sync` animado | "Guardando…" | `--ed-outline` (heredado) |
| `hasChanges && status==='draft'` | `cloud_upload` | "Sin guardar" | `amber-700` |
| `hasChanges && status!=='draft'` | `cloud_upload` | "Cambios sin publicar" | `amber-700` |
| `savedAt && mins<1 && !wasAuto` | `cloud_done` fill | "Guardado" | `--ed-primary` |
| `savedAt && mins<1 && wasAuto` | `cloud_done` fill | "Autoguardado" | `--ed-primary` |
| `savedAt && mins≥1 && !wasAuto` | `cloud_done` fill | "Guardado hace {m}m" | `--ed-primary` |
| `savedAt && mins≥1 && wasAuto` | `cloud_done` fill | "Autoguardado hace {m}m" | `--ed-primary` |

El `<span>` permanece MONTADO siempre (`sr-only xl:not-sr-only`, `aria-live="polite"`) — nunca
desmontar/remontar el contenedor, solo su contenido, o la región `aria-live` no anuncia el primer
mensaje. Re-render cada 30s (`setInterval`) para que "hace Xm" no quede mintiendo sin que el padre
se re-renderice.

### Toast

Píldora `--ed-inverse-surface` / `--ed-inverse-on-surface`, `rounded-lg shadow-xl`, 4 segundos
exactos (`setTimeout(4000)`), `MSym check_circle` fill `--ed-success` + texto 13px + botón cerrar.
Posición desplazada 336px a la izquierda si el panel de propiedades está abierto (para no
solaparlo) — variable inline `--toast-right`. Solo lo dispara el guardado MANUAL (`handleManualSave`)
y `paletteActions` (import de página, etc.) — el autosave NUNCA muestra toast (ya lo reporta el
chip del header; un toast cada 8-30s sería ruido, decisión explícita en el código).

### `DragHint`

Solo existe mientras `appState.ui.isDragging` es true (lectura reactiva del store de Puck vía
`usePuck`). Píldora `fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-[70]`,
`pointer-events-none`, `MSym info` 18 + "Arrastra a una zona iluminada para añadir el bloque".

### CommandPalette (⌘K)

- Abre con `Ctrl/Cmd+K` desde CUALQUIER sitio (antes del guard "no interceptar mientras se escribe"
  — así abre incluso con foco en un campo o dentro del iframe del canvas).
- Al abrir: guarda `document.activeElement`, limpia `query`, resetea `active=0`, foco al input tras
  20ms (deja pintar el portal antes de robar foco); al cerrar, restaura el foco anterior.
- Lista: ACCIONES primero (sin cabecera de grupo salvo que haya ≥1, rótulo "Acciones" 10px
  uppercase), luego bloques agrupados con cabecera de grupo repetida solo cuando el grupo cambia
  (`lastGroup` mutable fuera de cualquier hook, técnica intencional — no un bug).
- Teclado: `↑/↓` mueve `active` clamp `[0,total-1]` · `Enter` ejecuta la fila activa · `Esc` cierra ·
  `Tab`/`Shift+Tab` con FOCUS TRAP manual dentro del diálogo (primer/último `input,button`).
- Fila activa: `bg-[var(--ed-surface-container)]`, icono `--ed-primary`, `trailing` (hint tipo
  `↵ Insertar` o `Ctrl+S`) visible SOLO en la fila activa y solo `sm:` en adelante.
- Footer: hint de teclado a la izquierda, versión de la app a la derecha (`WordJS v{APP_VERSION}` —
  ojo, es la versión de la app real vía `NEXT_PUBLIC_WORDJS_VERSION`, NO el `ASSET_VERSION` de
  cache-busting — el código tiene un comentario explícito contra esa confusión).
- Backdrop `rgba(27,27,34,0.4)` + `backdrop-blur-sm`, clic en backdrop cierra, clic dentro del
  diálogo hace `stopPropagation`.

### Atajos visibles en tooltips/UI (no solo funcionales)

| Atajo | Dónde se ve | Acción |
|---|---|---|
| `Ctrl/⌘+K` | botón "Insertar" del header (`<kbd>`), tooltip del FAB móvil | abre CommandPalette |
| `Ctrl+Z` | tooltip de Undo | `trStr("Deshacer (Ctrl+Z)")` |
| `Ctrl+Shift+Z` | tooltip de Redo | `trStr("Rehacer (Ctrl+Shift+Z)")` |
| `Ctrl+S` | — (sin tooltip visible, pero activo globalmente) | guardar |
| `Ctrl+D` | fila "Duplicar bloque" en CommandPalette (`hint:"Ctrl+D"`) | duplicar selección |
| `Supr` | fila "Eliminar bloque" (`hint:"Supr"`) | eliminar selección |
| `Ctrl+C` / `Ctrl+V` | sin tooltip, funcional (clipboard localStorage) | copiar/pegar bloque |
| ESC | `<kbd>ESC</kbd>` en el header del CommandPalette | cerrar |

### Chip de presencia (colaboración v1)

Heartbeat `POST /api/v1/presence/:pageId` cada 10s + `navigator.sendBeacon` en `beforeunload`
(acción `{action:"leave"}`). Solo se pinta si `coEditors.length > 0`, `hidden lg:flex`, píldora
ámbar (`amber-800`/`amber-50`/`amber-200` — **NO tokens `--ed-*`**, es la única pieza de chrome que
usa la paleta Tailwind ámbar cruda en vez de roles del sistema). Singular/plural: "también está
editando" vs "también están editando".

---

## e) CONTROLES — aria-label / title / traducción exacta (TRIPLES, `puckI18n.ts`)

`trStr(s, lang)` busca el string **ES tal cual aparece en el código** dentro del diccionario — un
cambio de un solo carácter en el literal ES sin actualizar `puckI18n.ts` rompe la traducción EN/PT
en silencio (queda el string ES sin traducir). Al portar un control a `VersoEditor`, si conservas el
mismo string ES fuente, la traducción sigue funcionando sin tocar el diccionario; si lo cambias,
hay que actualizar la entrada.

| Control | aria-label / title (ES, literal) | EN | PT |
|---|---|---|---|
| Undo | "Deshacer (Ctrl+Z)" | "Undo (Ctrl+Z)" | "Desfazer (Ctrl+Z)" |
| Redo | "Rehacer (Ctrl+Shift+Z)" | "Redo (Ctrl+Shift+Z)" | "Refazer (Ctrl+Shift+Z)" |
| Viewport desktop/tablet/mobile | "Escritorio"/"Tableta"/"Móvil" | "Desktop"/"Tablet"/"Mobile" | "Desktop"/"Tablet"/"Celular" |
| ActionBar mover arriba/abajo | "Subir"/"Bajar" | "Move up"/"Move down" | "Subir"/"Descer" |
| Rail: Bloques | "Bloques" | "Blocks" | "Blocos" |
| Rail: Estructura | (usa `t('editor.panel.structure')`, dict `i18n.ts` — fuera del alcance de `puckI18n.ts`) | — | — |
| Rail: Plantillas | "Plantillas" | "Templates" | "Modelos" |
| Rail: Recursos | "Recursos" | "Assets" | "Recursos" |
| Rail: Notas | "Comentarios de revisión" (title) / "Notas" (label visible) | "Review comments" / "Notes" | "Comentários de revisão" / "Notas" |
| Rail: Historial | via `t('editor.revisionHistory')` (title) / "Historial" (label) | — | — |
| Rail: Ajustes | "Ajustes de página" (title) / "Ajustes" (label) | "Page settings" / "Settings" | "Configurações da página" / "Configurações" |
| Panel izq — buscar | "Buscar bloque…" (placeholder) / "Buscar bloque" (aria-label) | "Search block…" / "Search block" | "Buscar bloco…" / "Buscar bloco" |
| Panel izq — limpiar búsqueda | "Limpiar" | "Clear" | "Limpar" |
| Panel der — cerrar | via `t('editor.hideProperties')` | — | — |
| Panel der — reset estilos | "Restablecer estilos" | "Reset styles" | "Redefinir estilos" |
| Panel der — tabs | "Contenido"(no en TRIPLES, revisar `i18n.ts`) / "Estilo" / "Avanzado" | — / "Style" / "Advanced" | — / "Estilo" / "Avançado" |
| Header — insertar | "Insertar bloque (Ctrl/⌘ + K)" (title) / "Insertar" (texto) | "Insert block (Ctrl/⌘ + K)" / "Insert" | "Inserir bloco (Ctrl/⌘ + K)" / "Inserir" |
| Header — replay / guías | "Reproducir las animaciones de entrada" / "Guías y contornos" | "Play the entrance animations" / "Guides and outlines" | "Reproduzir as animações de entrada" / "Guias e contornos" |
| Header — preview | "Vista Previa" (botón) / "Vista previa en el sitio real (los borradores solo los ves tú)" (title) | "Preview" / "Preview on the live site (drafts stay private to you)" | "Pré-visualização" / … |
| Header — guardar/publicar | "Guardar" / "Publicar" (según `status`) | "Save"(implícito via t()) / "Publish" | — |
| Empty canvas | "Comienza tu diseño" / "Tu lienzo está listo. Añade el primer bloque para empezar a construir tu visión." / "Añadir primer bloque" | "Start your design" / … / "Add first block" | "Comece seu design" / … / "Adicionar primeiro bloco" |
| Drag hint | "Arrastra a una zona iluminada para añadir el bloque" | "Drag to a highlighted zone to add the block" | "Arraste para uma zona destacada para adicionar o bloco" |
| Panel bloqueado (drag lock) | "Panel bloqueado" / "Suelta el bloque en el lienzo para editar sus propiedades." | "Panel locked" / "Drop the block on the canvas to edit its properties." | "Painel bloqueado" / … |
| CommandPalette — buscador | "Buscar un bloque para insertar…" / "Buscar un bloque para insertar" (aria) | "Search for a block to insert…" / … | "Buscar um bloco para inserir…" / … |
| CommandPalette — hint pie | "Usa ↑↓ para navegar · ↵ para insertar" | "Use ↑↓ to navigate · ↵ to insert" | "Use ↑↓ para navegar · ↵ para inserir" |
| CommandPalette — grupo acciones | "Acciones" | "Actions" | "Ações" |
| Guardado exitoso (toast) | "¡Cambios guardados con éxito!" | "Changes saved successfully!" | "Alterações salvas com sucesso!" |
| Save chip (los 4 textos) | ver tabla de microinteracciones arriba | — | — |
| Sin título (breadcrumb) | "Sin título" | "Untitled" | "Sem título" |
| Breadcrumb root por defecto | "Páginas" (o "Entradas" si `breadcrumbRoot` lo pasa el post-editor) | "Pages" / "Posts" | "Páginas" / "Posts" |

(Tabla no exhaustiva de las ~150 entradas de `CHROME_STRINGS` — cubre los controles visibles del
header/rail/panel/CommandPalette. Para cualquier string nuevo, añadir su tripleta ES/EN/PT en
`puckI18n.ts` con el string ES IDÉNTICO byte-a-byte al literal del componente.)

---

## f) Capturas DOM (JSX fuente recortado, referencia de clases exactas)

### Header — grupo derecho, controles cuadrados (líneas 1774-1822 de `PuckEditor.tsx`)

```tsx
<div className="flex items-center gap-2 min-w-0">
    <button
        type="button"
        onClick={() => setCmdkOpen(true)}
        title={trStr("Insertar bloque (Ctrl/⌘ + K)", language)}
        className="hidden lg:flex items-center gap-2 h-7 px-2.5 rounded-md border border-[var(--ed-outline-variant)] text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] transition-colors"
    >
        <MSym name="search" size={14} />
        <span className="text-[11px]">{trStr("Insertar", language)}</span>
        <kbd
            className="text-[9px] text-[var(--ed-on-surface-variant)] bg-[var(--ed-surface-container)] rounded px-1 py-0.5 leading-none"
            style={{ fontFamily: "var(--puck-font-family-monospaced)" }}
        >⌘K</kbd>
    </button>
    {/* replay, guías, tune — mismo patrón w-7 h-7 rounded-md, estado activo bg-surface-container-high text-primary */}
    <button
        onClick={() => setShowProperties(!showProperties)}
        className={`hidden md:flex w-7 h-7 rounded-md items-center justify-center transition-colors ${showProperties ? 'bg-[var(--ed-surface-container-high)] text-[var(--ed-primary)]' : 'text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]'}`}
        title={showProperties ? t('editor.hideProperties') : t('editor.showProperties')}
    >
        <MSym name="tune" size={18} />
    </button>
</div>
```

### Rail izquierdo — entrada de navegación (líneas 1881-1908)

```tsx
<nav className="hidden md:flex w-16 shrink-0 bg-[var(--ed-surface)] border-r border-[var(--ed-outline-variant)] flex-col items-center py-2 gap-1 z-30">
    {([
        { id: 'blocks' as const, icon: 'add_box', label: trStr("Bloques", language) },
        { id: 'outline' as const, icon: 'layers', label: trStr("Estructura", language) },
        { id: 'patterns' as const, icon: 'dashboard_customize', label: trStr("Plantillas", language) },
    ]).map((item) => {
        const active = showSidebar && railView === item.id;
        return (
            <button
                key={item.id}
                type="button"
                onClick={() => {
                    if (showSidebar && railView === item.id) setShowSidebar(false);
                    else { setRailView(item.id); setShowSidebar(true); }
                }}
                title={item.label}
                aria-pressed={active}
                className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors ${active
                    ? 'bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)]'
                    : 'text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)]'}`}
            >
                <MSym name={item.icon} size={20} fill={active} />
                <span className="text-[9px] leading-none">{item.label}</span>
            </button>
        );
    })}
</nav>
```

### Panel derecho — header de identidad del bloque + tabs (líneas 942-985)

```tsx
<aside className={`flex-col bg-[var(--ed-surface-container-lowest)] border-l border-[var(--ed-outline-variant)] ${mobileOpen ? "flex fixed inset-x-0 top-12 bottom-14 z-40" : "hidden"} md:flex md:static md:inset-auto md:w-[320px] md:shrink-0 md:z-30`}>
    <div className="shrink-0 p-3 flex items-center gap-2.5 bg-[var(--ed-surface-container-low)] border-b border-[var(--ed-outline-variant)]">
        <div className="w-8 h-8 shrink-0 rounded bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)] flex items-center justify-center">
            <MSym name={msIcon} size={20} />
        </div>
        <div className="min-w-0 flex-1">
            <h3 className="text-[12px] font-bold text-[var(--ed-on-surface)] leading-4 truncate">{label}</h3>
            <p className="text-[10px] text-[var(--ed-on-surface-variant)] truncate" style={{ fontFamily: "var(--puck-font-family-monospaced)" }}>
                {blockId ? `ID: ${blockId}` : t('editor.properties')}
            </p>
        </div>
        <button type="button" onClick={onClose} title={t('editor.hideProperties')} className="w-6 h-6 shrink-0 rounded flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors">
            <MSym name="chevron_right" size={16} />
        </button>
    </div>
    <div className="flex shrink-0 border-b border-[var(--ed-outline-variant)]" role="tablist">
        {TABS.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} disabled={!x.enabled} onClick={() => setTab(x.id)}
                className={`flex-1 py-2.5 text-[11px] font-medium transition-colors border-b-2 ${tab === x.id
                    ? 'text-[var(--ed-primary)] border-[var(--ed-primary)] bg-[var(--ed-surface-container-low)]'
                    : x.enabled
                        ? 'text-[var(--ed-on-surface-variant)] border-transparent hover:bg-[var(--ed-surface-container)]'
                        : 'text-[var(--ed-outline-variant)] border-transparent cursor-not-allowed'}`}>
                {x.label}
            </button>
        ))}
    </div>
</aside>
```

### Tarjeta de bloque del inserter (líneas 271-289 de `BlockInserter.tsx`)

```tsx
<Drawer.Item key={item.name} name={item.name} label={item.label}>
    {() => (
        <div
            title={item.desc ? trStr(item.desc, language) : item.label}
            onClick={onInsert ? () => tapInsert(item.name) : undefined}
            className={`group flex flex-col items-center gap-1 p-2 rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] hover:border-[var(--ed-primary)] transition-colors ${onInsert ? "cursor-pointer active:scale-95" : "cursor-grab active:cursor-grabbing"}`}
        >
            <MSym
                name={item.ms}
                size={20}
                className="text-[var(--ed-on-surface-variant)] group-hover:text-[var(--ed-primary)] transition-colors"
            />
            <span className="w-full text-[11px] leading-tight text-center text-[var(--ed-on-surface)] truncate">
                {item.label}
            </span>
        </div>
    )}
</Drawer.Item>
```
Grilla contenedora: `grid grid-cols-3 md:grid-cols-2 gap-2` (3 columnas en móvil/sheet angosto,
2 en el panel de escritorio de 280px — MÁS columnas en la pantalla MÁS angosta, es intencional:
el sheet móvil es full-width mientras el panel de escritorio es un carril fijo de 280px).

**Nota de implementación:** `Drawer.Item` (del fork) renderiza su `children` DOS VECES — una copia
fantasma absolutamente posicionada detrás de la real, para el placeholder de arrastre. El styling de
la tarjeta NUNCA puede depender de `:nth-child`/conteo de hermanos por esta razón — documentado
explícitamente en el comentario de cabecera de `BlockInserter.tsx`. Si `VersoEditor` reimplementa
su propio DnD (que es justo el plan, según `f0-audit-core.md`), esta restricción probablemente no
aplique — pero si por lo que sea el nuevo motor también duplica nodos para el placeholder, recuerda
esta trampa.

---

## CHECKLIST numerada de paridad visual (gate F3 — pantalla a pantalla, navegador real, mismo tamaño)

1. Header: 48px de alto exactos, 3 grupos, hairline inferior `--ed-outline-variant`, fondo `--ed-surface`.
2. Wordmark "WordJS" 18px font-black `--ed-primary`, breadcrumb 12px con separador `chevron_right` 12px opacity 50%.
3. Segmented viewport control: track `--ed-surface-container` `p-0.5`, chip activo `bg-white shadow-sm text-primary`, 3 iconos `desktop_windows`/`tablet_mac`/`smartphone` a 18px.
4. Undo/Redo: 20px, disabled = `--ed-outline-variant` + cursor not-allowed, sin fondo en reposo.
5. `SaveStateChip`: los 4 estados/textos exactos de la tabla (d), región `aria-live` siempre montada.
6. Botón Insertar (⌘K) del header visible solo `lg:`, con `<kbd>⌘K</kbd>` monoespaciado.
7. Botones cuadrados 28px (replay/guías/tune) con estado activo `bg-surface-container-high text-primary`.
8. Botón Guardar/Publicar: relleno `--ed-primary`, texto según `status` ("Guardar" vs "Publicar"), spinner `sync` 12px solo mientras `saving`.
9. Avatar 32px círculo `--ed-primary-container` con `person` filled 16px.
10. Rail 64px exactos, 3 entradas primarias (Bloques/Estructura/Plantillas) + Recursos + grupo inferior (Notas/Historial/Ajustes con `mt-auto`), botones 48×48px, etiqueta 9px.
11. Click en la vista de rail YA activa colapsa el panel (no hay botón de colapso separado).
12. Panel izquierdo 280px, header 40px con label uppercase 11px + botón cerrar (`chevron_left` desktop / `close` móvil).
13. BlockInserter: buscador con `search` 18px + limpiar `close`, chips de categoría con "Todos" primero, grilla `grid-cols-3 md:grid-cols-2`.
14. Tarjeta de bloque: icono 20px + label 11px, borde hover `--ed-primary`, sin dependencia de `:nth-child`.
15. Tab Plantillas: caja "Guardar como plantilla" con borde punteado, sección "Mis plantillas" (solo si hay alguna), sección "Plantillas" built-in con preview en vivo escalado ~23.6%.
16. Canvas: retícula de puntos de fondo, desktop = tarjeta 1280px fija con sombra, tablet/móvil = bisel `ring-[7px] ring-gray-900 rounded-[2rem]` a 768/375px.
17. Estado vacío del canvas: círculo 144px + `space_dashboard` 56px + CTA píldora + 3 patrones rápidos.
18. Panel derecho 320px, header con chip 32px + nombre 12px bold + ID en monoespaciada 10px.
19. 3 tabs Contenido/Estilo/Avanzado — deshabilitadas cuando `avail.style`/`avail.advanced` es false, filtrado 100% vía `data-ptab` + `:has(.wjs-f-*)`.
20. Overlay "Panel bloqueado" durante drag: círculo 64px + `replace_image` 32px + 2 líneas de texto.
21. Footer "Restablecer estilos" solo visible si hay estilo o avanzado disponible.
22. Toast: píldora `--ed-inverse-surface`, 4s, desplazada 336px si el panel derecho está abierto.
23. DragHint: píldora inferior centrada, solo durante `isDragging`, `pointer-events-none`.
24. CommandPalette: backdrop blur, ancho `max-w-xl`, acciones agrupadas antes que bloques, fila activa con highlight + trailing hint, footer con versión de la app.
25. Mobile: bottom nav 56px con 4 tabs, sheets izq/der independientes de las preferencias de escritorio (`localStorage puck_show_sidebar`/`puck_show_properties` intactas).
26. Mobile FAB: círculo 48px `bottom-[72px] right-4`, oculto mientras un sheet está abierto.
27. Los 3 sistemas de icono coexisten donde corresponde: Material Symbols en TODO el chrome de la app; si se reimplementa el ActionBar de bloque, usar pencil/copy/trash (equivalentes a los 3 glifos nativos del fork) en vez de forzar Material Symbols ahí donde el original no lo hacía.
28. Los 64+ nombres de icono usados existen en el subset de 161 — verificar CUALQUIER glifo nuevo contra la lista de la sección (c) antes de usarlo, o regenerar el `.woff2`.
29. Tipografía Inter aplicada (vía `inter.className` heredado o equivalente) + JetBrains Mono en IDs/kbd/inputs numéricos.
30. Ningún `--ed-*` redeclarado fuera de la hoja de estilos única del editor (evitar la colisión que ya se solucionó una vez en `globals.css`).
31. Todos los `title`/`aria-label`/textos visibles pasan por `trStr()` (o equivalente) con el string ES IDÉNTICO byte-a-byte al de la tabla (e) — verificar en/pt cambiando el idioma del admin, no solo en es.
32. Contraste: nunca usar `--ed-outline` para texto pequeño sobre fondo claro (4.50:1 exacto, cero margen AA) — usar `--ed-on-surface-variant` en su lugar, como ya hace el código en el contador de resultados del BlockInserter.
