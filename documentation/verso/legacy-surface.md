# Inventario de superficie legacy — arnés F2

> **HISTORICAL — the surface inventoried here has been removed.** `frontend/packages/puck`,
> `PuckEditor.tsx`, `BlockInserter.tsx`, `CommandPalette.tsx` and `InlineTiptap.tsx` are gone, and
> no code in `frontend/src` writes or reads the seven `window.puck*` globals or
> `__PUCK_INTERNAL_DO_NOT_USE` any more — the only surviving mentions are comments naming what Verso
> replaced them with. Kept as the record of what the retirement had to reach; every `file:line`
> below is a dead pointer. Two of its findings are still true and still live: `_puck_data` remains
> the persisted post-meta key, and §6 still holds — the 31 marketplace plugins' compiled bundles
> contain no `usePuck`/`useGetPuck`/`puckComponents`/`renderDropZone` and no `window.puck*`
> reference.

Encargo: inventario exacto (file:line) de toda la superficie que el motor nuevo debe sustituir, o cuya
retirada en F5 debe verificarse mecánicamente. Ámbito: `frontend/src` (excluye `frontend/packages/puck`,
el fork vendorizado, salvo mención explícita de contexto) + bundles compilados de
`marketplace/plugins/*/dist/*.js`.

**Método:** orientación por `graphify query` (el grafo de graphify es AST/import-edges — no indexa
literales de string como `window.puckDispatch` ni atributos DOM, así que solo confirmó qué ficheros del
fork exportan los símbolos de §3; para los globals/atributos/localStorage el grafo no aportó nodos útiles
y todo §1-§2 y §5-§6 es Grep exhaustivo sobre código fuente) + Grep exhaustivo por patrón exacto sobre
`frontend/src` y los bundles de marketplace. Sin resultados de graphify relevantes para §1/§2/§4/§5/§6 más
allá de confirmar la ubicación de los símbolos exportados por el fork (§3).

**AVISO DE VOLATILIDAD:** `frontend/src/components/PuckEditor.tsx` fue editado por otra sesión/proceso
DURANTE esta auditoría — un primer Grep (early in the session) reportó el setter de `puckDispatch` en la
línea 829; una repetición posterior del mismo Grep, en el mismo archivo, sin ninguna edición mía, lo
reportó en la línea 830 (deriva de +1 a +4 líneas según la zona del archivo). Las líneas de este documento
para `PuckEditor.tsx`, `admin/pages/[id]/page.tsx` y `admin/posts/[id]/page.tsx` son de la ÚLTIMA pasada
de Grep (snapshot único, todos los patrones re-verificados en el mismo lote de llamadas) — pero dado que
F2 está `in_progress` sobre este mismo archivo, **re-grepea antes de usar estas líneas para nada
mecánico** (script, sed, IDE go-to-line). El resto de ficheros (puckPatterns.ts, BlockInserter.tsx,
InlineTiptap.tsx, CommandPalette.tsx, SymbolBlock.tsx, PluginBlockHeavy.tsx, admin/chrome/*) no mostraron
deriva entre pasadas.

---

## 1. Consumidores de los 7 globals `window.puck*` / `__PUCK_INTERNAL_DO_NOT_USE`

Todos los globals se asignan sin tipos, sin validación, y se leen con `(window as any).x` u opcional-
chaining `?.` (fail-silent si no existen). Todos menos `__PUCK_INTERNAL_DO_NOT_USE` tienen fallback
`(window.parent as any)?.x` porque quien lee vive DENTRO del iframe del canvas (StablePuckRoot, InlineText,
OverlayBlocker) y quien escribe vive FUERA (PuckEditor.tsx, el documento padre).

### `window.puckDispatch`
**Setter (1):** `PuckEditor.tsx:830` — `(window as any).puckDispatch = getPuck().dispatch;`, dentro de
`StablePuckRoot` (línea 823+, componente `root.render` a nivel de módulo, renderiza DENTRO del iframe vía
`useGetPuck()`).

**Consumidores (14):**
- `frontend/src/lib/puckPatterns.ts:158` — `appendItems()` (interna; alimenta `insertPattern`/
  `insertUserPattern`, patrones prediseñados + patrones de usuario)
- `frontend/src/lib/puckPatterns.ts:190` — `insertBlock()` (inserción única desde ⌘K)
- `PuckEditor.tsx:1202` — `updateComponent()` callback (recibe `{id,newProps}` desde `EditorContext`;
  camino de escritura de InlineText/InlineTiptap al comitear edición inline; recorre recursivamente slots)
- `PuckEditor.tsx:1394` — `selectBlockById()` (bridge inestable: primero lee
  `__PUCK_INTERNAL_DO_NOT_USE` para resolver zona/índice, luego dispatch `setUi`)
- `PuckEditor.tsx:1493` — `paletteActions` acción "import" (⌘K → reemplaza toda la página con JSON
  importado, vía `migrate()`)
- `PuckEditor.tsx:1538` — `paletteActions` acción "duplicate"
- `PuckEditor.tsx:1547` — `paletteActions` acción "delete-block"
- `PuckEditor.tsx:1554` — `paletteActions` acción "page-settings" (deselecciona para que
  `Puck.Fields` caiga a los campos ROOT)
- `PuckEditor.tsx:1953` — botón del rail derecho de escritorio "Ajustes de página" (mismo deselect)
- `PuckEditor.tsx:2081` — botón de la barra inferior móvil "Ajustes" (mismo deselect, ruta táctil)
- `PuckEditor.tsx:2172` — `onSelect` de `<MediaPickerModal>` (inserta bloque Image desde la biblioteca
  de medios)
- `frontend/src/components/BlockInserter.tsx:102` — `tapInsert()` (modo tap-to-insert móvil; el panel
  cubre el canvas, así que el tap es la única vía de inserción)
- `frontend/src/components/editor/A11yAudit.tsx:11` — SOLO comentario de doc (describe el contrato, no
  invoca)
- `frontend/src/components/CommandPalette.tsx:16` — SOLO comentario de doc

### `window.puckGetData`
**Setter (1):** `PuckEditor.tsx:833` — `(window as any).puckGetData = () => getPuck().appState.data;`,
mismo `StablePuckRoot`.

**Consumidores (4):**
- `PuckEditor.tsx:1464` — `paletteActions` acción "export" (descarga la página como JSON)
- `frontend/src/lib/puckPatterns.ts:242` — `saveCurrentPageAsPattern()` (captura la página viva como
  patrón de usuario reutilizable)
- `frontend/src/app/admin/pages/[id]/page.tsx:202` — `handleSubmit` (lee el store vivo antes de
  persistir; fallback a `puckDataRef.current`)
- `frontend/src/app/admin/posts/[id]/page.tsx:200` — `handleSubmit`, mismo patrón

### `window.puckUpdateComponent`
**Setters (2, redundantes — ver riesgo abajo):**
- `PuckEditor.tsx:840` — dentro de `StablePuckRoot`, dentro del valor de `EditorContext.Provider`
  (con fallback `window.parent`, así que este setter en realidad LEE antes de exponer — el nombre real
  del setter que escribe el global vive en el efecto de abajo)
- `PuckEditor.tsx:1252` — `(window as any).puckUpdateComponent = updateComponent;`, useEffect con deps
  `[activeEditorId, updateComponent, setActiveEditorId]`, SIN cleanup (no hay `delete` al desmontar)

**Consumidores (3):**
- `PuckEditor.tsx:929` — `PropertiesPanel.resetStyles()` (botón RESET del panel de propiedades: vuelve
  `look`/`anim`/`hide` al `defaultProps` del tipo de bloque, vía el camino normal de update para que
  quede en el historial)
- `PuckEditor.tsx:1528` — `paletteActions` acción "paste-styles" (pega `{look,anim,hide}` desde
  `STYLE_CLIPBOARD_KEY`)
- (el propio `StablePuckRoot` en L840 es también lector — pasa el valor recibido de `window.parent` hacia
  abajo al `EditorContext` que consume `InlineText`)

### `window.puckActiveEditorId`
**Setters (3 — REDUNDANCIA REAL, no solo documental):** los tres viven en el MISMO componente
`PuckEditor` (no en distintos módulos):
- `PuckEditor.tsx:1143` — `useEffect` keyed en `[activeEditorId]`: asigna el global + dispara
  `puck-editor-change` SOLO en `window`
- `PuckEditor.tsx:1149` — `useEffect` separado, asigna `puckSetActiveEditorId = setActiveEditorId`, CON
  cleanup (`delete` en L1151 al desmontar)
- `PuckEditor.tsx:1250-1252` — un TERCER `useEffect`, keyed en
  `[activeEditorId, updateComponent, setActiveEditorId]`, que vuelve a asignar LOS TRES globals
  (`puckActiveEditorId`, `puckSetActiveEditorId`, `puckUpdateComponent`) Y dispara `puck-editor-change`
  en `window` Y en `iframe.contentWindow` — sin cleanup para `puckActiveEditorId`/`puckUpdateComponent`
  (solo el efecto de L1149 limpia `puckSetActiveEditorId`)

**Consumidores (6):**
- `PuckEditor.tsx:154` — `EditorHotkeys.inlineEditing()` (gatea los atajos de teclado: si hay edición
  inline activa, Ctrl+Z/Ctrl+V/etc. no interceptan)
- `PuckEditor.tsx:643` — `readActiveId()` dentro de `InlineText` (lectura inicial)
- `PuckEditor.tsx:727` — `OverlayBlocker`, estado inicial al montar
- `PuckEditor.tsx:736` — `OverlayBlocker`, listener de `puck-editor-change` con fallback al global si
  `e.detail` viene vacío
- `PuckEditor.tsx:843` — dentro de `StablePuckRoot`, valor pasado a `EditorContext.Provider`
  (`activeEditorId: ... ?? null`)
- `PuckEditor.tsx:665` — comentario de doc (referencia a `patch-puck-actions.js`, no encontrado como
  fichero real en `frontend/src` — probablemente nombre de un parche externo/histórico, no un módulo vivo)

### `window.puckSetActiveEditorId`
**Setters:** `PuckEditor.tsx:1149` y `PuckEditor.tsx:1251` (mismo par redundante de arriba).

**Consumidor (1, el único que importa de verdad):** `frontend/packages/puck/components/DraggableComponent`
— la acción "Edit" del `ActionBar` del FORK, SOLO para `componentType==="Text"|"Heading"`, llama
`puckSetActiveEditorId?.(id)`. Este consumidor vive fuera de `frontend/src` (en el fork) por diseño — es
la Divergencia 2 documentada en f0-audit-core.md; pineado por
`frontend/src/lib/__tests__/puckForkDivergence.test.ts:144`. En `frontend/src` solo hay lectura indirecta
vía el global — ningún otro fichero de `frontend/src` LLAMA a `puckSetActiveEditorId` directamente.

### `window.puckCommitActive`
**Setter (1):** `frontend/src/components/InlineTiptap.tsx:699` —
`(window as any).puckCommitActive = () => save(editor.getHTML());`, dentro de un `useEffect` que también
lo limpia (`InlineTiptap.tsx:708`, `if (...) puckCommitActive = null` — no usa `delete`, deja `null`
residual en vez de borrar la clave).

**Consumidores (2):**
- `frontend/src/app/admin/pages/[id]/page.tsx:201` — `try { puckCommitActive?.() } catch {}` antes de
  leer `puckGetData()`, para forzar el flush de una edición inline abierta antes de guardar
- `frontend/src/app/admin/posts/[id]/page.tsx:199` — mismo patrón

### `window.__PUCK_INTERNAL_DO_NOT_USE`
**No tiene setter en `frontend/src`** — lo instala el FORK internamente (`use-puck.ts` /
`plugin-debug.tsx`, fuera de alcance de este inventario); `frontend/src` solo LEE.

**Consumidores (4), los 3 sitios de producción que documenta f0-audit-core.md + 1 nuevo hallazgo:**
- `PuckEditor.tsx:320` — `ActionBarOverride.move()`: lee `appStore.getState().state.indexes.zones[zone]
  .contentIds.length` para clampear el botón "Bajar" (mover bloque) al final de la zona
- `PuckEditor.tsx:1388` — `selectBlockById()`: lee `state.indexes.nodes[blockId]` para resolver
  zona+índice antes de despachar `setUi`
- `PuckEditor.tsx:1439` — `readSelected()`: lee `selectedItem` (usado por CommandPalette "copy-styles"/
  "save-symbol" y paletteActions "paste-styles")
- `PuckEditor.tsx:1444` — `readSelector()`: lee `state.ui.itemSelector` (usado por "duplicate"/
  "delete-block"/Ctrl+C de bloque)

---

## 2. Selector `.puck-container` y atributos `data-puck-*` en `frontend/src`

### `.puck-container` — 17 sitios (no ~10; el conteo real en `frontend/src` es mayor que la cifra
aproximada de f0-audit-core.md, que solo contaba querySelector JS)

**Origen/setter (1):** `PuckEditor.tsx:1674` — `<div className="puck-container fixed inset-0 z-50 ...">`
(el propio contenedor del editor).

**Selectores CSS (6):**
- `frontend/src/app/globals.css:49-50` — `.puck-container, .puck-container>div` (reset de layout base)
- `frontend/src/components/puck-theme.css:311` — comentario ("`.puck-editor-ui` marca UI que PORTALEA
  FUERA de `.puck-container`")
- `puck-theme.css:312,317,322,326` — 4 reglas de scrollbar custom bajo `.puck-container .custom-scrollbar`

**`document.querySelector(".puck-container iframe")` en JS (9 sitios, todos en `PuckEditor.tsx`):**
- `:248` y `:262` — `EditorHotkeys`: engancha/desengancha el listener de teclado DENTRO del realm del
  iframe (polling cada 1000ms por si el iframe recarga)
- `:356` — `GuidesController`: pinta contornos/overlay de spacing sobre el `contentDocument`
- `:416` — `PreviewFrame`: inyecta CSS de scrollbar fino en el iframe (polling 400ms, timeout 10s)
- `:458` — `PreviewFrame`: reafirma el "contrato de documento" (`:root`/`:root>body` inmutables) —
  polling cada 700ms, TODA la vida del editor, sin timeout
- `:499` — `PreviewFrame`: inyecta el stylesheet del tema activo + UI framework en el iframe
- `:1377` — `runAudit()` (a11y): obtiene el `contentDocument` para el scan de `A11yAudit.tsx`
- `:1567` — `paletteActions` acción "replay" (⌘K): re-dispara animaciones de entrada
- `:1794` — botón de cabecera "Reproducir animaciones" (misma función que `:1567`, duplicado UI)

**Referencia de comentario (1):** `frontend/src/components/editor/canvasGuides.ts:2`.

### `data-puck-component`
**Setter:** el fork (`DraggableComponent`, fuera de alcance) estampa `data-puck-component="<blockId>"` en
la raíz de cada bloque renderizado.

**Consumidores en `frontend/src` (5):**
- `PuckEditor.tsx:360` — `GuidesController`: `doc.querySelector('[data-puck-component="${selId}"]')`
  para pintar el overlay de spacing sobre el bloque seleccionado
- `PuckEditor.tsx:776,803` — 2 reglas CSS inyectadas (`[data-puck-component]{...}` / `[data-puck-component]
  {...}`) — contrato de estilos del canvas
- `frontend/src/components/editor/canvasGuides.ts:36-37` — outline dashed + hover del modo "Guías"
- `frontend/src/components/editor/A11yAudit.tsx:50` — `el.closest("[data-puck-component]")
  ?.getAttribute(...)` para mapear un issue de a11y de vuelta a su bloque

### `data-puck-dnd`
**Consumidor único (1):** `frontend/src/components/editor/A11yAudit.tsx:43` —
`el.hasAttribute("data-puck-dnd") || !!el.closest(EDITOR_OVERLAY_SELECTOR)` — filtro NEGATIVO: excluye el
handle de dnd-kit (presente en TODA raíz de bloque) del scan de a11y para no marcarlo falsamente como
"elemento de contenido sin nombre accesible". Comentario en L35 explica por qué NO se usa como ancestro.

### `data-puck-overlay-layer`
**Cero consumidores funcionales en `frontend/src`** — las únicas 4 apariciones son en
`frontend/src/lib/__tests__/puckForkDivergence.test.ts:94,96,108,116`, un PIN DE TEXTO (regex sobre el
código fuente del fork, no ejecuta comportamiento) que verifica que el fork sigue portaleando el overlay
fuera del iframe. Ningún componente de `frontend/src` lee ni escribe este atributo directamente — la app
solo depende de que el fork lo mantenga.

### `data-puck-preview`
**Cero consumidores en `frontend/src`** (verificado con Grep sin restricción de directorio: el atributo
solo existe dentro de `frontend/packages/puck/` — `DraggableComponent/index.tsx`, `Preview/index.tsx`,
`dist/*.js`, `NestedDroppablePlugin.ts`, `NOTICE.md` — y en `.next/` compilado, que es artefacto de build,
no fuente). El código de aplicación nunca selecciona por `[data-puck-preview]`; usa `.puck-container
iframe` para el mismo propósito (encontrar el documento del canvas). Diferencia de vocabulario entre el
fork (ancestro DOM real dentro del iframe) y la app (selector de clase en el documento padre) — un motor
nuevo no necesita replicar este atributo si no reimplementa el mecanismo interno del fork.

### `data-puck-entry`
**Consumidor único (1), solo en un STRING CSS, no como selector de query:** `PuckEditor.tsx:451,456` —
comentario + regla `"#frame-root,[data-puck-entry]{height:auto!important;min-height:100vh!important;
max-height:none!important}"` inyectada en el iframe para que el punto de montaje de AutoFrame CREZCA con
el contenido (evita que el iframe quede recortado en páginas largas). Es el ÚNICO de los 5 atributos
`data-puck-*` pedidos que la app usa para ESCRIBIR una regla CSS dirigida a un elemento del fork, no para
leer/seleccionar en JS.

---

## 3. Imports de `@wordjs/puck` en `frontend/src` — 9 ficheros

| Fichero | Símbolos | Uso |
|---|---|---|
| `components/PuckEditor.tsx:3` | `Puck, Config, Data, migrate, useGetPuck, createUsePuck, ActionBar` | El wrapper completo — `Puck` monta el editor, `migrate` normaliza datos al cargar/importar, `useGetPuck`/`createUsePuck` alimentan `HistoryControls`/`EditorHotkeys`/`ActionBarOverride`, `ActionBar` compone el override de la barra de acciones por bloque (mover arriba/abajo) |
| `components/BlockInserter.tsx:4` | `Drawer, Render` | `Drawer`/`Drawer.Item` para la lista arrastrable de bloques (línea 258+); `Render` para la miniatura en vivo de un patrón al ~24% de escala (línea 69) |
| `components/CommandPalette.tsx:5` | `useGetPuck` | `getPuck().appState.ui.itemSelector` (línea 103) para insertar un bloque tras la selección actual |
| `components/content/PluginBlockHeavy.tsx:7` | `Render` | Mitad "pesada" de `PluginBlockIsland` — `<Render config={...} data={...}>` (línea 15) para renderizar en el sitio PÚBLICO cualquier bloque de plugin/Symbol (lazy-loaded, cero SSR) |
| `components/puck/SymbolBlock.tsx:4` | `Render` | `makeSymbolRender()` — anida el contenido de un Symbol vía `<Render>` con un config LIVE recortado (excluye `Symbol` del propio config anidado para capar profundidad en 1) |
| `app/admin/pages/[id]/page.tsx:14` | `Data` (solo tipo) | Tipado del payload `_puck_data` que se envía al backend |
| `app/admin/posts/[id]/page.tsx:13` | `Data` (solo tipo) | Igual que pages |
| `app/admin/chrome/chromeEditorConfig.tsx:10` | `Config` (solo tipo) | Tipado del config del editor de chrome (menús/header/footer) |
| `app/admin/chrome/page.tsx:11` | `Puck, Data` (Data solo tipo) | **Implementación PARALELA**: monta `<Puck>` DIRECTO con sub-componentes propios — `Puck.Components` (L405), `Puck.Outline` (L409), `Puck.Preview` (L417), `Puck.Fields` (L425) — layout de 3 paneles custom, SIN pasar por `PuckEditor.tsx`. **Cero** referencias a ninguno de los globals/eventos/atributos de §1-§2 (verificado por Grep sobre `app/admin/chrome/**`: 0 resultados) — confirma que esta ruta no necesita el bridge de globals porque no tiene edición inline, undo/redo visible, autosave ni patrones (coincide con f0-audit-core.md línea 50) |

No hay ningún import de `@wordjs/puck` en `frontend/src` fuera de estos 9 ficheros.

---

## 4. `CustomEvent('puck-editor-change')`

**Forma del `detail`: el id del editor activo directamente (string \| null), NUNCA `{activeId}`.**
Confirmado en los 3 emisores.

**Emisores (3, todos en `PuckEditor.tsx`, TODOS en el mismo componente):**
- `:1144` — `window.dispatchEvent(new CustomEvent(..., {detail: activeEditorId}))`, dentro del efecto de
  L1143 (SOLO en `window`)
- `:1254` + `:1260` — dentro del efecto de L1250-1252 (el "tercero redundante" de §1): dispara EN
  `window` (L1254) Y ADEMÁS busca `document.querySelector('iframe')` (sin scope a `.puck-container`,
  cualquier iframe de la página) y dispara también en `iframe.contentWindow` (L1260) — este es el ÚNICO
  emisor que cruza al realm del iframe explícitamente por evento; el resto de la sincronización iframe↔
  padre pasa por el global `window.puckActiveEditorId` leído directamente (no por el evento)

**Listeners (2, ambos en `PuckEditor.tsx`, dentro de componentes que se MONTAN dentro del iframe):**
- `:648-649` — dentro de `InlineText` (línea ~630+): `handler = (e) => setActiveId(e?.detail ??
  readActiveId())`; determina si ESTE bloque de texto es el que está en edición (`isEditing = activeId
  === id`)
- `:738-739` — dentro de `OverlayBlocker` (línea 720+): `handleUpdate = (e) => setActiveId(e?.detail ??
  window.puckActiveEditorId ?? null)`; controla si el overlay de selección del fork debe ocultarse
  (`pointer-events:none` inyectado vía `<style>`) mientras hay edición inline activa

No hay más emisores/listeners de `puck-editor-change` en `frontend/src`.

---

## 5. localStorage keys del editor

| Key | Constante | Forma | Escritores | Lectores |
|---|---|---|---|---|
| `wjs_block_clipboard` | `BLOCK_CLIPBOARD_KEY` (`PuckEditor.tsx:46`) | `{type, props}` (item Puck completo) | `writeBlockClipboard()` `PuckEditor.tsx:51`, invocado en `PuckEditor.tsx:237` (Ctrl+C sobre un bloque seleccionado, solo si `!winSel \|\| winSel.isCollapsed` para no robar copia de texto) | `readBlockClipboard()` `PuckEditor.tsx:55`, invocado en `PuckEditor.tsx:156` dentro de `EditorHotkeys.pasteBlock()` (Ctrl+V) |
| `wjs_style_clipboard` | `STYLE_CLIPBOARD_KEY` (`PuckEditor.tsx:48`) | `{look, anim, hide}` | `PuckEditor.tsx:1516` — paletteActions "copy-styles" | `PuckEditor.tsx:1527` — paletteActions "paste-styles" (línea 1528 aplica vía `puckUpdateComponent`) |
| `wjs_user_patterns` | `USER_PATTERNS_KEY` (`puckPatterns.ts:219`) | `Array<{id, name, items, createdAt}>`, cap 30 (`slice(0,30)` en `persistUserPatterns`) | `persistUserPatterns()` `puckPatterns.ts:233`, invocado desde `saveCurrentPageAsPattern()` (L241+) y `deleteUserPattern()` (L257+) | `loadUserPatterns()` `puckPatterns.ts:223` |
| `puck_show_sidebar` | literal (sin constante) | `'true'`/`'false'` (string) | `PuckEditor.tsx:1642` | `PuckEditor.tsx:1631` |
| `puck_show_properties` | literal (sin constante) | `'true'`/`'false'` (string) | `PuckEditor.tsx:1648` | `PuckEditor.tsx:1632` |

Nota: `wjs_block_clipboard`/`wjs_style_clipboard` NO tienen prefijo `puck_` pero SÍ `wjs_`; los 2 flags de
sidebar tienen prefijo `puck_` sin `wjs_` — inconsistencia de naming ya presente, sin impacto funcional,
pero un motor nuevo que "limpie" el prefijo debe decidir migrar (leer ambas claves una temporada) o
aceptar perder el estado guardado de usuarios existentes.

---

## 6. Grep de bundles compilados de marketplace — `usePuck|useGetPuck|puckComponents|renderDropZone`

**Resultado: 0 coincidencias en los 31 plugins** (`admin.bundle.js` + `component.bundle.js` +
`hooks.bundle.js` donde exista, 52 ficheros `dist/*.js` en total). Verificado también sin restricción de
patrón exacto: 0 coincidencias de `.puck.` (property access), `isEditing`, `dragRef` — los 3 campos del
objeto `puck` que `ComponentConfig.render(props)` inyecta según el contrato duro de f0-audit-core.md
(línea 30) — y 0 coincidencias de `@wordjs/puck` o `globalThis.WordJS.puck` como import/global expuesto.

Los bundles SÍ están minificados (identificadores locales renombrados a 1-2 letras vía esbuild) pero los
NOMBRES DE PROPIEDAD sobre objetos externos (imports nombrados, propiedades de `globalThis.WordJS.*`)
sobreviven la minificación sin renombrar — así que este resultado no es un falso negativo por ofuscación:
si algún plugin accediera a `props.puck.renderDropZone` o importara `useGetPuck` desde el host, el
literal `renderDropZone`/`useGetPuck` seguiría apareciendo en el bundle. Confirmado inspeccionando la
cabecera de `card-gallery/dist/{admin,component}.bundle.js`: los únicos globals que el runtime del host
inyecta son `globalThis.WordJS.React` y `globalThis.WordJS.JSXRuntime` — NO existe ni se referencia un
`globalThis.WordJS.puck` ni un canal equivalente hacia la API headless de Puck.

**Recuento por plugin: 0/31 en las 4 APIs buscadas**, para los 31 directorios de
`marketplace/plugins/*`:
analytics-tag, auctions, bookings, breadcrumbs, card-gallery, conference-manager, contact-forms,
cookie-consent, digital-downloads, donations, event-tickets, events-calendar, faq, image-lightbox,
invoices, job-board, mail-server, newsletter, notification-bar, online-store, photo-carousel, polls,
popup-builder, related-posts, restaurant-menu, social-share, table-of-contents, testimonials,
vendor-marketplace, video-gallery, youtube-videos.

Los bloques de plugin registran su render vía un objeto plano `{fields, defaultProps, render}` (confirmado
en `card-gallery/dist/component.bundle.js`: `fields:{galleryId:{type:"custom", label:"Select Gallery",
render:({value,onChange})=>...}}`) — consistente con el contrato de `ComponentConfig` documentado, pero
NINGUNO usa `props.puck.renderDropZone` (es decir, ningún plugin de los 31 declara un bloque CONTENEDOR
con zona anidada) ni toca la API headless del store. **Esto cierra explícitamente el hueco que
f0-audit-core.md dejó abierto** (línea 25: "No se verificó si algún plugin/bloque llama directamente a
usePuck/useGetPuck... no se detectó en esta pasada") — la respuesta es NO, verificado sobre los 31 bundles
compilados reales, no solo sobre fuente: **F4 puede tratar el catálogo de 31 plugins como bloques HOJA
puros (fields+defaultProps+render), sin necesidad de portar ninguna API headless ni el mecanismo de
slot/renderDropZone para ellos.**

---

## Hallazgos transversales para quien diseñe el motor (no pedidos explícitamente, mismo Grep)

- **La redundancia de 3 efectos para `puckActiveEditorId`/`puckSetActiveEditorId` (§1) es código real
  duplicado dentro de UN MISMO componente**, no solo un patrón cross-módulo documentado por el f0-audit —
  probablemente arrastre histórico de una refactorización a medias. Un motor nuevo NO debería replicar
  esta triplicación; pero si el reemplazo se hace incrementalmente sobre `PuckEditor.tsx` (en vez de
  reescritura limpia), conviene consolidar los 3 efectos ANTES de tocar el resto, para no cazar bugs
  fantasma de "¿cuál de los 3 setters ganó la carrera?".
- `OverlayBlocker` también depende de los selectores CSS `[data-puck-overlay-portal]` y
  `[data-puck-overlay]` (`PuckEditor.tsx:761-763`, dentro del bloque leído para el hallazgo de
  `data-puck-overlay-layer`) — no estaban en la lista pedida pero son la MISMA familia de contrato con el
  fork (ocultar el overlay de selección mientras hay edición inline) y se rompen igual de silenciosamente
  si el motor nuevo no estampa un equivalente.
- El comentario de `PuckEditor.tsx:665` referencia un fichero `patch-puck-actions.js` que no existe como
  módulo real en `frontend/src` (Grep de nombre de fichero: 0 resultados) — o es terminología histórica de
  una versión anterior del wrapper, o un artefacto de build/parche externo no versionado; no bloquea nada
  pero puede confundir a quien lea el código fuente buscando ese fichero.
