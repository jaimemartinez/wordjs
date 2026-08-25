# Oráculo del editor de Chrome (/admin/chrome) — contrato de paridad para la unificación sobre Verso

> **ESTADO.** §1–§3 (bloques, forma del dato, endpoints, validaciones) siguen siendo el contrato
> vigente y se han vuelto a verificar contra el código: 9 tipos, presupuestos 64KB / 100 bloques /
> profundidad 3, `PUT`/`DELETE /api/v1/chrome/:part` con `authenticate + isAdmin`. Lo que ha
> cambiado es el editor: la unificación terminó y el motor legacy se retiró con el fork, así que
> `/admin/chrome` monta `ChromeVersoEditor` incondicionalmente — no hay bandera de motor, ni
> `EngineToggle`, ni rama `<Puck>` en un ternario. §4 describe el editor legacy que servía de
> oráculo (útil como registro de lo que había que igualar, no como descripción de la pantalla de
> hoy) y §6 describe el andamiaje de doble motor que ya no existe.
>
> Escrito ANTES de tocar código (mandato del checkpoint, 2026-08-15). Fuentes: lectura completa de
> `frontend/src/app/admin/chrome/page.tsx`, `frontend/src/app/admin/chrome/chromeEditorConfig.tsx`,
> `frontend/src/lib/chromeData.ts`, `frontend/src/lib/api.ts` (chromeApi), `backend/src/routes/chrome.ts`
> y `backend/src/core/chrome-validate.ts`. Este documento ES el contrato: la variante Verso se mide
> contra cada punto de aquí.

## 1. Qué bloques de chrome existen (contrato v1, allowlist CERRADA)

9 tipos, definidos por partida doble (frontend `lib/chromeData.ts` BLOCK_SPECS ↔ backend
`core/chrome-validate.ts`, con harness de paridad):

| type | props (req=requerida, opt=opcional) | notas |
|---|---|---|
| `ChromeLogo` | `size` opt `'sm'\|'md'\|'lg'` | preview vacío si no hay site_logo ni blogname |
| `ChromeSiteTitle` | `showTagline` opt boolean | |
| `ChromeNav` | `location` req `'header'\|'footer'`; `orientation` req `'horizontal'\|'vertical'` | **BARRADO en announcement** (document-scoped: drawer móvil + body scroll-lock) |
| `ChromeSearch` | `placeholder` opt string | |
| `ChromeSocials` | `source` req `'settings'` | links de settings.footer_socials |
| `ChromeText` | `text` req string | |
| `ChromeButton` | `label` req string; `href` req isSafeChromeHref (rel `/…` o http(s); `//` y `/\` rechazados); `variant` req `'primary'\|'ghost'` | |
| `ChromeSpacer` | `size` req `'sm'\|'md'\|'lg'` | |
| `ChromeRow` | `items` req array (SLOT — único anidamiento permitido); `align` req `'start'\|'center'\|'end'\|'between'`; `gap` req `'sm'\|'md'\|'lg'`; `wrap` opt boolean | |

- `props.id` string permitido en TODOS (el editor lo estampa; el contrato lo admite explícitamente).
- Cualquier prop desconocida, tipo desconocido, o violación ⇒ composición ENTERA inválida (fail-closed).
- Presupuestos: ≤ 64KB serializado, ≤ 100 bloques, profundidad ≤ 3 (solo vía ChromeRow.items).
- defaultProps del editor (chromeEditorConfig): Logo `{size:'md'}`; SiteTitle `{showTagline:false}`;
  Nav `{location:'header',orientation:'horizontal'}` en part header y `{location:'footer',orientation:'vertical'}`
  en footer (¡dependen del part!); Search `{placeholder:'Buscar…'}`; Socials `{source:'settings'}`;
  Text `{text:'Texto'}`; Button `{label:'Botón',href:'/',variant:'primary'}`; Spacer `{size:'md'}`;
  Row `{align:'between',gap:'md',wrap:false}` (SIN `items` en defaults — el slot se materializa al insertar).
- En part `announcement` el config BORRA ChromeNav del drawer (`delete config.components.ChromeNav`).

## 2. Forma EXACTA del dato y dónde se guarda

- Forma persistida (contrato v1): `{ root: { props: {} }, content: [{ type, props }] }` — Puck Data
  SIN extras: el editor recorta con `toContractData` (nunca persiste `zones` ni claves ajenas).
- **Dónde**: option del sitio `site_chrome_<part>` (part ∈ header|footer|announcement), guardada como
  **JSON string** vía `updateOption`. El hook updated_option dispara la purga de frontend
  (site_chrome_* está en SETTINGS_OPTIONS de frontend-purge).
- **Endpoints** (lib/api.ts `chromeApi` — la ÚNICA vía de escritura; los writers genéricos de settings
  rechazan site_chrome_*):
  - `PUT /api/v1/chrome/:part` body `{ data: <ChromeData> }` → `{ part, saved: true }`. Auth: authenticate + isAdmin.
  - `DELETE /api/v1/chrome/:part` → `{ part, deleted: boolean }` (restaurar = borrar la option y purgar; el
    editor recarga con skipSite).
  - Lecturas: `settingsApi.get()` (`/settings`; site_chrome_* son PUBLIC_SETTINGS) y el fichero estático
    del tema `/themes/<slug>/chrome/<part>.json`.
- **Precedencia efectiva al cargar** (misma que el layout público): 1º option `site_chrome_<part>`
  → 2º `chrome/<part>.json` del tema activo (fetch estático, cache no-store) → 3º STARTER_TEMPLATES[part]
  (lib/chromeData.ts). Cada nivel pasa por parseChromeData fail-closed. Un fallo del GET /settings NO cae
  al starter (eso pisaría la composición real en el siguiente Save): deja el editor SIN montar y muestra
  el error. La announcement valida con `position:'announcement'`.
- El dato de chrome **NO es `_puck_data`**: no hay meta de post, no hay revisiones, no hay autosave,
  no hay _wjs_template. Los guards de _puck_data del editor de páginas NO aplican. El equivalente de
  `unhydratedSaveBlocked` ya existe estructuralmente: si la carga falla, initialData queda null ⇒ el
  editor no se monta y handleSave corta (`!data || saving || loading`).

## 3. Validaciones

- **Local (pre-PUT)**: `parseChromeData(contract, { source:'editor', position: part==='announcement' ? 'announcement' : undefined })`
  — errores como strings planos; si falla NO se llama al endpoint y los errores van al banner rojo.
- **Servidor (autoridad de escritura)**: `validateChromeData(data, { part })` en el PUT. 400 con
  `{ code:'chrome_invalid', message, errors: [{ code, path, message }] }`. Códigos: CHROME_TOO_LARGE,
  CHROME_INVALID_JSON, CHROME_INVALID_SHAPE, CHROME_UNKNOWN_TYPE, CHROME_UNKNOWN_PROP,
  CHROME_MISSING_PROP, CHROME_INVALID_PROP, CHROME_UNSAFE_HREF, CHROME_TOO_MANY_BLOCKS,
  CHROME_TOO_DEEP, CHROME_BLOCK_NOT_IN_PART. `api()` preserva `errors[]` en el Error lanzado; el
  editor los aplana con `describeError` (path + message — un objeto como React child tiraría el editor).
- part inválido en la URL ⇒ 400 `rest_invalid_param`.

## 4. Comportamiento observable del editor actual (page.tsx) — checklist de paridad

- **C01 Montaje**: `<Puck>` DIRECTO con `buildChromeEditorConfig(part)` (memoizado por part), NUNCA
  PuckEditor. `key={part}-{mountKey}` — cambiar de part o recargar remonta el store entero.
- **C02 Carga (loadPart)**: precedencia site→theme→starter (§2); badge de fuente (`site`/`theme`/`starter`
  con icono propio); estampa ids (`withBlockIds`: `<type>-<uuid>` en cada bloque, recursivo por
  ChromeRow.items); fija baseline JSON para dirty; `setMountKey(k+1)`.
- **C03 Dirty tracking**: onChange guarda el dato VIVO en `latestDataRef` (ref, no state — un state
  re-renderizaría la página por tecla) y compara `JSON.stringify(toContractData(nuevo)) !== baseline`.
  Editar con un switch de part pendiente CANCELA la petición pendiente (editar = «seguir editando»).
- **C04 Selector de part** (header/footer/announcement, aria-pressed + check no-cromático): con
  cambios sin guardar NO cambia — muestra banner ámbar con Descartar/Cancelar (2 pasos, jamás
  window.confirm: congela el in-app browser). Guardar con el banner abierto lo descarta (gated en dirty).
- **C05 Guardar**: recorta a contrato → validación local (si falla: banner rojo, sin PUT) →
  `chromeApi.save(part, contract)` → éxito: baseline=contract, dirty=false, source='site', toast éxito;
  fallo: errores del 400 aplanados al banner + toast error. Deshabilitado mientras saving||loading.
- **C06 Restaurar**: confirmación de 2 pasos en el propio botón (rojo, timeout 4s) →
  `chromeApi.reset(part)` → toast → `loadPart(part, { skipSite: true })` (recarga SIN el nivel site).
- **C07 Canvas WYSIWYG**: iframe de Puck con inyección de `wjs-ui-framework` (uiFrameworkHref) ANTES
  de `wjs-theme-stylesheet` (themeStylesheetHref(slug, active_theme_version)) re-asertada cada 700ms
  toda la sesión (AutoFrame recarga/reordena); título accesible del iframe (chrome.admin.canvasTitle).
- **C08 Layout 3 paneles fijo** (children de <Puck> reemplazan su UI): izquierda w-64 (Puck.Components
  drawer arrastrable + Puck.Outline), centro Puck.Preview en card max-w-5xl, derecha w-72 Puck.Fields
  del bloque seleccionado. El drawer es DRAG-ONLY (sin tap-insert). Sin: autosave, revisiones,
  comentarios, a11y, InlineTiptap, CommandPalette, patrones, guías, viewport-switcher,
  withSharedBlockFields (los props extra hide/anim/look VIOLARÍAN el contrato cerrado).
- **C09 Root canvas por part** (chromeEditorConfig root.render — mismo wrapper que el layout público):
  header → `<header data-scrolled="false" class="wjs-header wjs-chrome-header bg-[var(--wjs-bg-surface-glass,white)] shadow-sm py-4"><div class="wjs-header-container container mx-auto px-4 min-h-16">`;
  announcement → `<aside class="wjs-chrome-announcement w-full bg-[var(--wjs-bg-announcement,var(--wjs-color-primary,#1f2937))] text-[var(--wjs-color-on-primary,#ffffff)] text-sm"><div class="wjs-announcement-container container mx-auto px-4 py-2 min-h-8">`;
  footer → `<footer class="wjs-chrome-footer bg-[var(--wjs-bg-footer,rgb(17,24,39))] text-[var(--wjs-color-text-footer-main,white)] py-12"><div class="wjs-footer-container container mx-auto px-4 min-h-24">`.
- **C10 Bindings de preview**: los bloques con datos (Logo/SiteTitle/Nav/Socials) resuelven
  settings + menús por location con UN fetch cliente compartido module-level (settingsApi.get +
  menusApi.getByLocation header/footer, fallos degradan a bindings vacíos); mientras llega:
  placeholder pulsante con el label del bloque; si resuelve a nada: hint punteado («sin logo», «sin
  menú en {location}»…) — nunca un bloque invisible/inseleccionable.
- **C11 ChromeRow en el canvas**: el SLOT es el propio contenedor flex (mismas clases literales que
  el ChromeRow público: `wjs-chrome-row flex items-center w-full min-h-12` + ALIGN_CLASS/GAP_CLASS
  + flex-wrap condicional) — los bloques dropeados son hijos flex directos.
- **C12 Avisos**: banner de viewport estrecho (lg oculta fields, md oculta drawer — se AVISA, no se
  recorta en silencio); nota de purga (indigo); banner rojo de errores desechable.
- **C13 i18n**: todo el chrome de la página vía useI18n (claves chrome.admin.*); el config vía
  t()/getStoredLanguage (se construye fuera del árbol React).
- **C14 Estados**: spinner centrado mientras loading; si initialData es null (carga fallida) el editor
  y el Save nunca se montan.
- **C15 Legacy paralelo**: /admin/footer sigue existiendo durante la beta (fuera de este alcance).

## 5. Tests existentes

- `frontend/src/lib/__tests__/chromeData.test.ts` — parser/validador/starters/menú tree (NO tocar).
- Paridad frontend↔backend del validador: harness propio del backend (chrome-validate).
- El editor de chrome (page.tsx / chromeEditorConfig.tsx) NO tenía tests propios de componente
  cuando se escribió este oráculo. Sí los tiene ahora:
  `frontend/src/app/admin/chrome/__tests__/chromeVersoAdapter.test.ts` (anti-drift por referencia
  contra `chromeEditorConfig`, clases del ChromeRow Verso, round-trip de los starters, guardado con
  el endpoint espiado).

## 6. Decisiones de la unificación (implementadas en este checkpoint)

> Las dos primeras viñetas son andamiaje de transición y YA NO EXISTEN: al retirar el fork se
> borraron `editorEngine.ts`, `EngineToggle` y la rama `<Puck>`, y `/admin/chrome` monta
> `ChromeVersoEditor` sin condición (`frontend/src/app/admin/chrome/page.tsx`). El resto de la
> sección sigue describiendo el código vigente: `chromeContract.ts`, `chromeVersoAdapter.tsx`, la
> ausencia deliberada de `withSharedVersoFields`, y los caminos compartidos de
> carga/guardado/restaurar/dirty.

- Flag idéntico a pages/posts: `resolveEditorEngineFromBrowser()` (query > localStorage > env >
  **legacy DEFAULT ABSOLUTO**), re-resuelto en navegación suave; EngineToggle (solo dev) presente.
- La rama legacy (el bloque `<Puck …>…</Puck>`) queda BYTE-INTACTA dentro del ternario; las funciones
  puras `withBlockIds`/`toContractData`/`genId` se MUEVEN sin cambios a `chromeContract.ts` para que
  el test de wiring ejercite el productor REAL (lección fixture-vs-producer), y la línea del PUT pasa
  por `saveChromeComposition` (wrapper 1:1 de chromeApi.save, espiable).
- Los BlockDefinitions Verso se derivan DEL PROPIO `buildChromeEditorConfig` (adaptador
  `chromeVersoAdapter.tsx`): label/fields/defaultProps/render se reutilizan por referencia — fidelidad
  por construcción; el ÚNICO render sustituido es ChromeRow (en Verso el slot llega como función
  `(className?)=>ReactNode`, mismas clases literales) y el root wrapper se reutiliza tal cual (C09).
- SIN withSharedVersoFields a propósito (C08: el contrato cerrado rechaza props extra).
- El guardado/carga/restaurar/dirty/banners son los MISMOS caminos compartidos de page.tsx para ambos
  motores; en Verso `latestDataRef` nunca queda stale (el store notifica onChange en CADA transacción
  committeada y en undo/redo — no existe el deep-equal guard de Puck), así que handleSave no necesita
  handle vivo. `unhydratedSaveBlocked` se añade explícito como cinturón (equivalente estructural ya
  existente, C14/§2).
- Mejora deliberada (documentada, no regresión): la paleta Verso admite además tap-to-insert
  (el drawer legacy era drag-only) y expone undo/redo por teclado (Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y).

## 7. Defectos cazados EN NAVEGADOR durante el checkpoint (y sus fixes)

Verificación en vivo sobre `?engine=verso` (dev, mono en :3000) — tres defectos invisibles a los
tests de node, corregidos y re-verificados en pantalla:

1. **Click en un bloque-enlace navegaba el ADMIN entero**: Logo/Nav/Button renderizan next/link y
   el árbol portaleado al iframe comparte el router del PADRE — seleccionar el Logo hacía
   router.push("/") de toda la página. Fix: el listener de selección (capture en el doc del iframe)
   hace `preventDefault` sobre `a, button, [type='submit']` — next/link respeta defaultPrevented; el
   canvas queda inerte a navegación (paridad con el overlay legacy de Puck que se comía los clicks).
   El MISMO riesgo existe en VersoEditor (pages/posts) con Button/PostsGrid → task aparte spawneada.
2. **Panel de campos stale tras undo/redo**: el panel solo se suscribía al id de selección; un undo
   cambia props sin tocar la selección → el canvas revertía y el select seguía mostrando el valor
   deshecho. Fix: `SelectedBlockFields` se suscribe al NODO (useVersoNode).
3. **Dirty en falso positivo permanente (violaba C03)**: la normalización de Verso emite `id`
   PRIMERO en nodos sin slots (byte-distinto del crudo estampado, deep-igual) → el primer edit
   dejaba «sin guardar» aunque se deshiciera todo. Fix: `onInit` del ChromeVersoEditor entrega la
   serialización Verso inicial y page.tsx re-basa `latestDataRef`/`baselineJsonRef` sobre ella
   (rama verso; el baseline legacy no cambia). Test pineando el invariante en
   `chromeVersoAdapter.test.ts`.

Verificado en pantalla además: legacy por defecto intacto + EngineToggle; selección con ActionBar
(subir/bajar/duplicar/eliminar); edición en vivo del select con re-render del canvas; drag&drop de
la paleta al slot de una Fila (outline sincronizado); Ctrl+Z revierte canvas+panel; cambio de part
con guard de descarte cuando hay cambios reales y directo cuando no; footer carga su composición
efectiva. NO ejercitado en esta pasada (queda para el gate del orquestador): PUT real de Guardar y
DELETE de Restaurar (para no mutar el sitio local), canvas del part announcement, viewport estrecho.
