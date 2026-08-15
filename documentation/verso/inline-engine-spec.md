# Spec ejecutable — motor de texto inline PROPIO de Verso (F3.5)

**Estado**: spec previa a codificar (misma técnica que el DnD: tabular ANTES de escribir el motor).
**Decisión ratificada del usuario**: el motor inline de Verso es propio; Tiptap queda SOLO en el
editor legacy y Verso termina con **cero imports de `@tiptap/*`**. El alcance está ACOTADO al
contrato real del editor actual: schemas `plain` y `rich` (negrita, cursiva, enlace, listas
ul/ol), saneado in/out. **NO es un motor genérico.**

**Fuentes de verdad leídas para esta spec** (todas verificadas en el árbol, no de memoria):

- `frontend/src/components/InlineTiptap.tsx` (777 líneas — el comportamiento legacy a igualar,
  SOLO lectura; no se toca).
- `frontend/src/components/verso/inline/VersoInline.tsx` + `inlineSession.ts` — el ciclo de
  vida/commit/throttle **SE CONSERVA tal cual**; el motor solo sustituye a Tiptap como productor
  de contenido.
- `frontend/src/lib/sanitize.ts` — `sanitizeHTML` es el saneador de referencia (rama DOMPurify en
  cliente, sanitize-html en SSR).
- `documentation/verso/f3-parity-checklist.md` **W34** (hueco justificado: «portar el BubbleMenu
  Tiptap ahora sería trabajo desechable» — esta spec ES el desbloqueo de W34 vía F3.5).
- `node_modules/@tiptap/extension-link/dist/index.js` (v3.27.1) — defaults reales del Link:
  `HTMLAttributes: { target: "_blank", rel: "noopener noreferrer nofollow" }` usados como
  DEFAULT de los atributos de la marca, `autolink: true`, `linkOnPaste: true`.

Los casos ejecutables viven en
`frontend/src/lib/verso/inline-engine/__fixtures__/text-cases.json` (§10).

---

## 1. Normalización canónica del HTML emitido (el contrato de salida)

Todo HTML que el motor emite hacia `session.onContent(raw)` en schema `rich` cumple ESTA
normalización. Los `expectedHtml` del fixture están escritos en esta forma. La normalización se
define aquí una vez y los tests la exigen byte a byte.

### 1.1 Subconjunto de tags y atributos que el motor PUEDE producir

| Tag | Atributos | Notas |
|---|---|---|
| `p` | ninguno | Todo bloque de texto es un `<p>`. Nunca `div`, nunca `h*`. |
| `br` | ninguno | Solo por Shift+Enter. Serializado `<br>` (sin auto-cierre). |
| `strong` | ninguno | Negrita. Nunca `b`. |
| `em` | ninguno | Cursiva. Nunca `i`. |
| `a` | `href`, `target`, `rel` — EN ESE ORDEN | `target="_blank"` solo con «nueva pestaña»; cuando hay `target="_blank"`, SIEMPRE `rel="noopener noreferrer"`; sin target, sin rel. |
| `ul`, `ol` | ninguno | Un solo nivel (D6). |
| `li` | ninguno | Su contenido va SIEMPRE envuelto en un `<p>` (D5). |

El motor **jamás** emite: `span`, `style=`, `class=`, `u`, `s`, `code`, `mark`, `div`, `h1..h6`,
`blockquote`, `pre`, `hr`, `img`, `iframe`. `sanitizeHTML` permite un superconjunto (colores,
font-size vía `span[style]`, tablas, etc.) — eso es la política de RENDER de contenido, no el
contrato de EMISIÓN de este motor.

### 1.2 Reglas de forma

1. **Doc vacío → `""`** (cadena vacía). Equivalente al `"<p></p>" → ""` del legacy y de
   `richTransform`. Un `<p></p>` vacío INTERMEDIO (línea en blanco entre párrafos con contenido,
   o el `<li><p></p></li>` recién creado por Enter) sí se emite.
2. **Orden canónico de anidamiento de marcas: `strong` > `em` > `a`** (strong el más externo, el
   enlace el más interno). Cualquier combinación se serializa en ese orden; si un texto es
   `em`+`strong`, sale `<strong><em>…</em></strong>` aunque la marca em «llegara antes».
3. **Fusión voraz**: runs adyacentes que comparten la marca más externa se agrupan bajo UNA sola
   etiqueta de esa marca (p.ej. `(strong,a)("o") + (strong)(" d")` →
   `<strong><a …>o</a> d</strong>`), aplicado recursivamente hacia dentro. Dos runs con marcas
   idénticas e iguales atributos se funden en un solo run (nunca
   `<strong>ab</strong><strong>cd</strong>`).
4. **Sin elementos de marca vacíos**: jamás `<strong></strong>`, `<em></em>`, `<a…></a>`.
5. **Texto byte a byte**: sin trims, sin colapso de espacios. Escapado en nodos de texto: `<`
   `>` `&` → entidades (`&lt;` `&gt;` `&amp;`); comillas solo se escapan dentro de valores de
   atributo (`"` → `&quot;`).
6. **Atributos con comillas dobles**, minúsculas, orden fijo (tabla 1.1). `href` se guarda
   verbatim (sin normalizar barras ni añadir protocolo, D8: sin autolink).
7. **Punto fijo de `sanitizeHTML`**: para todo output O del motor,
   `sanitizeHTML(O) === O` en la rama cliente (DOMPurify preserva orden de atributos del DOM
   parseado; el hook de `rel` no añade nada porque el motor ya emite
   `rel="noopener noreferrer"` con `_blank`). Esto es un gate de test sobre TODOS los
   `expectedHtml` rich del fixture. (La rama SSR — sanitize-html — re-serializa `<br />` con
   auto-cierre: el punto fijo se define sobre la rama CLIENTE, que es la que corre en el editor;
   verificado que todos los expected del fixture son punto fijo de la rama SSR módulo esa
   diferencia de `<br>`.)

En schema `plain` el valor emitido es **TEXTO plano** (no HTML): verbatim, sin escapar (React
escapa al render; el servidor sanea `PUCK_HTML_FIELDS` al guardar) — idéntico al contrato actual
de `plainTransform`/`plainDocOf` (que preserva byte a byte, incluso `<b>` literal).

---

## 2. BubbleMenu

### 2.1 Inventario COMPLETO del legacy (`InlineTiptap.tsx`) — referencia

Aparece con **selección no vacía** (comportamiento del BubbleMenu de Tiptap v3), flota sobre la
selección (portal fuera del editable — la razón por la que el legacy NO cierra en blur),
z-index 100000, contenedor `.wjs-bubble-menu`. Botones, en orden, todos con
`onMouseDown={preventDefault}` para no perder la selección:

| # | Control | Comportamiento legacy exacto |
|---|---|---|
| 1-4 | Negrita, Cursiva, Subrayado, Tachado | `toggleBold/Italic/Underline/Strike`; activo = fondo primario. |
| 5 | **LinkButton** | Popover: input URL (Enter aplica), input de búsqueda en contenido del sitio (`useContentSearch` de `puck/LinkField` — páginas/posts, resultado clicado aplica `/{slug}`), checkbox «Abrir en pestaña nueva», botón Aplicar, botón Quitar enlace (solo si `isActive("link")`). Captura la selección al abrir (`selRef`) y la restaura al aplicar. `href` vacío/blanco ⇒ `extendMarkRange("link").unsetLink()`. Con valor ⇒ `extendMarkRange("link").setLink({href: trim, target: newTab ? "_blank" : null})`. |
| 6 | **ColorButton** | Paleta de 12 swatches (`TEXT_COLORS`), **eyedropper** (EyeDropper API, solo Chromium, oculto si no existe; captura/restaura selección), picker hex custom (`react-colorful` + input `#rrggbb`), Quitar color. Aplica `setColor` (marca textStyle → `span[style="color: …"]`). |
| 7 | **HighlightButton** | 6 swatches (`HIGHLIGHT_COLORS`) + quitar; `setBackgroundColor` (span style). |
| 8 | **FontFamilyControl** | Lista de fuentes instaladas vía `GET /fonts` (caché module-level `FONT_FAMILY_CACHE`, nunca invalidada); «Predeterminada» = unset; oculto si 0 fuentes. |
| 9 | **FontSizeControl** | Stepper − px + sobre la escala fija `FONT_SIZES` 12…80; el actual = fontSize del textStyle o el computado del editor. |
| 10-13 | Alineación izq/centro/dcha/justificar | `setTextAlign` sobre `paragraph`. |
| 14-15 | Lista, Lista numerada | `toggleBulletList/OrderedList`. **Solo si `!inline`** (Heading inline no lista). |
| 16 | Limpiar formato | `unsetAllMarks()` — quita TODAS las marcas, **incluido el enlace**; NO toca listas ni alineación. |

### 2.2 Contrato del BubbleMenu Verso F3.5 (lo que el motor implementa)

Solo en schema `rich` (plain no tiene bubble, como hoy). Aparece con selección **no vacía** dentro
del editable; desaparece al colapsar la selección, al cerrar la sesión y mientras se arrastra la
selección (se muestra en `mouseup`/fin de selección, no durante). Posicionado sobre el punto
medio del rango (via `Range.getBoundingClientRect()` del documento del iframe), por encima; si no
hay hueco arriba, debajo. El contenedor conserva el marcador **`data-wjs-inline-bubble`** (es lo
que el detector de click-fuera de `VersoInline` ya considera «dentro» — se reutiliza sin cambios).

Botones (subset exacto del contrato, mismo patrón `onMouseDown preventDefault`):

| Control | Semántica |
|---|---|
| Negrita | toggle `strong` (§8.1). Activo si TODA la selección está en negrita. |
| Cursiva | toggle `em` (ídem). |
| Enlace | Popover mínimo estilo `InlineLinkControl` actual: input URL (Enter aplica), Aplicar, Quitar (si hay enlace activo) **+ checkbox «Abrir en pestaña nueva» (D9)**. Captura/restaura selección. `href` vacío ⇒ unlink. Semántica de rango: §8.3. **Sin buscador de contenido interno** (D10). |
| Lista / Lista numerada | toggle ul/ol (§8.4). |
| Limpiar formato | quita `strong`/`em`/`a` de la selección (paridad con `unsetAllMarks`: el enlace también cae); conserva estructura de lista y párrafos. |

Estado «activo» de cada botón se recalcula en cada cambio de selección (`selectionchange` del
documento del iframe, filtrado a selecciones dentro del editable).

Fuera de contrato F3.5 (documentado, jamás recorte silencioso — quedan como huecos de W34 con
dueño si el usuario los repesca): subrayado, tachado, color+eyedropper, resaltado,
fuente/tamaño, alineación, buscador de contenido en el popover de enlace. Motivo: el alcance
ratificado es negrita/cursiva/enlace/listas y esos controles emiten `span[style]`/`u`/`s`, fuera
del subset §1.1.

---

## 3. Semántica por schema

### 3.1 `rich` (hoy: bloque Text, prop `content`)

- **Documento**: secuencia de bloques; cada bloque es `p`, `ul` u `ol`; `li` contiene un `p`.
- **Marcas**: `strong`, `em`, `a[href,target,rel]`. Nada más. (El VersoInline actual, por usar
  StarterKit entero, acepta HOY subrayado/tachado/código por atajo aunque el bubble no los
  ofrezca — el motor nuevo CIERRA ese hueco: esos atajos son no-op, D2.)
- **Enter**: divide el párrafo en el caret (borrando antes la selección si no está colapsada).
  Dentro de un `li`: divide el ítem (nuevo `<li><p></p></li>` con lo que quede a la derecha);
  en un `li` VACÍO: saca el ítem de la lista (lo convierte en `<p>` hermano tras la lista; si
  la lista queda vacía, desaparece). Paridad con splitListItem/liftEmptyBlock del legacy.
- **Shift+Enter**: inserta `<br>` (hard break) sin dividir el bloque. También dentro de `li`.
- **Continuidad de marcas al teclear** (§8.6): `strong`/`em` son *inclusive* (teclear pegado al
  final de un run en negrita continúa la negrita); `a` NO es inclusive (teclear tras un enlace
  produce texto sin enlace). Paridad exacta con ProseMirror.
- **Marcas pendientes en caret colapsado**: pulsar Negrita con el caret colapsado NO cambia el
  HTML; arma una marca pendiente que se aplica al siguiente texto tecleado y se descarta al
  mover el caret. (Paridad con storedMarks; los fixtures solo verifican «sin cambio de HTML».)

### 3.2 `plain` (hoy: Heading `title`, Card `title`, Button `label`, CTABanner `title`, Quote `text`)

- Valor = **una sola línea de texto plano**, byte a byte (el valor inicial se carga como texto,
  nunca parseado como HTML — paridad con `plainDocOf`).
- **Enter y Shift+Enter: bloqueados** (no insertan nada, no cierran la sesión). El legacy actual
  bloquea ambos (su `handleKeyDown` mira `key === "Enter"` sin distinguir shift) — se conserva.
  EXCEPCIÓN IME: un Enter con `isComposing` no se intercepta (§7).
- **Sin marcas, sin bubble, sin atajos de formato** (Mod+B/I/K = no-op).
- **Pegado**: se aplana a una línea (§6.2) — esto CORRIGE el legacy, ver D7.

---

## 4. Atajos de teclado

### 4.1 Legacy (referencia — lo que Tiptap StarterKit daba gratis)

Mod = Ctrl (Win/Linux) / Cmd (macOS). Mod+B negrita, Mod+I cursiva, Mod+U subrayado,
Mod+Shift+S tachado, Mod+E código, Mod+Shift+7 lista ordenada, Mod+Shift+8 lista, Mod+Z /
Mod+Shift+Z / Mod+Y historia interna del editor, Enter split (párrafo o li), Shift+Enter `<br>`,
Backspace en frontera une bloques, **Tab/Shift+Tab en li: sink/lift (¡anidar listas!)**.
**No existe Mod+K en el legacy** (el popover de enlace solo se abre con el botón).

### 4.2 Contrato F3.5

| Atajo | Acción |
|---|---|
| Mod+B / Mod+I | toggle negrita / cursiva (rich; no-op en plain). |
| **Mod+K** | abre el popover de enlace con la selección capturada (**nuevo**, no existía en legacy — D3). Solo rich, con selección no vacía. |
| Enter / Shift+Enter | §3. |
| Backspace/Delete en frontera de bloque | une párrafos / une li con el anterior / saca el primer li a párrafo — paridad con contenteditable+PM. |
| Escape | flush + cierre de sesión (`session.end()`) — sin cambios respecto a VersoInline. En popover de enlace abierto: primero cierra el popover, un segundo Escape cierra la sesión. Durante composición IME: no hace nada (§7). |
| Tab / Shift+Tab | **no-op** (sin listas anidadas, D6; el foco NO sale del editable con Tab mientras la sesión está viva). |
| Mod+Z / Mod+Shift+Z / Mod+Y | undo/redo **local de la sesión** (§8.7). Jamás llegan al undo global del store: el guard existente ya lo garantiza (`EditorHotkeys.isTypingTarget` + `inlineEditingId !== null`, L46-56) y el motor además hace `preventDefault`+`stopPropagation`. |
| Mod+U, Mod+Shift+S, Mod+E, Mod+Shift+7/8 | **no-op** (D2: el motor no tiene esas marcas; las listas se togglean solo desde el bubble). |

---

## 5. Ciclo de commit (SE CONSERVA `inlineSession.ts` sin cambios)

El motor es un PRODUCTOR para la sesión existente; nada del contrato de commits cambia:

1. Cada mutación del documento del editor (teclear, toggle de marca, enter, pegar, borrar)
   produce `session.onContent(raw)` donde `raw` = serialización canónica §1 (rich) o el texto
   plano (plain). **Nunca durante una composición IME** (§7: se difiere a `compositionend`).
2. `inlineSession` aplica su **throttle** (`INLINE_COMMIT_THROTTLE_MS = 300`): primer commit
   inmediato, los siguientes como pronto 300 ms tras el último commit. OJO paridad: el legacy
   usaba **debounce trailing** de 300 ms (ningún guardado hasta 300 ms de silencio); la sesión
   Verso es **throttle leading+trailing** — decisión ya tomada en F2, se conserva (el primer
   carácter tecleado queda persistido al instante).
3. Cada commit pasa por `transform`: rich = `richTransform` (normaliza `""` y aplica
   `sanitizeHTML` — defensa en profundidad; como el output del motor es punto fijo de
   `sanitizeHTML` (§1.2.7), el saneado es no-op salvo ataque); plain = identidad. Emite
   `setProps` con `coalesceKey inline:<nodeId>` — la coalescencia del store agrupa la sesión en
   pocas entradas de undo. Contenido idéntico al último committeado NO abre transacción.
4. **Flush** (commit inmediato del pendiente) en: Escape (`end()`), mousedown fuera del editable
   Y del bubble (`end()`), `handle.commitInline()` (vía suscripción de la sesión a
   `inlineEditingId` — el guardado de página sigue funcionando sin conocer al motor), y
   desmontaje de React (`dispose()`).
5. **HTML exacto que emite cada operación**: el documento completo re-serializado (§1) tras
   aplicar la operación — nunca deltas. Es exactamente lo que enumeran los `expectedHtml` del
   fixture (§10): cada caso `{initialHtml, op} → expectedHtml` ES el contrato de `raw` del
   siguiente `onContent`.

El acoplo `window.puckCommitActive` del legacy NO se replica (ya sustituido por
`commitInline()` en F2). La intercepción `pointerdown/mousedown/dragstart` del legacy para parar
el dnd-kit de Puck tampoco aplica tal cual: el DnD Verso propio ya ignora arrastres iniciados en
`[data-wjs-inline]` — el motor conserva ese atributo contenedor y añade `stopPropagation` en
`dragstart` del editable como cinturón (misma intención, superficie nueva).

---

## 6. Pegado

### 6.1 Legacy (referencia — lo que hace ProseMirror/Tiptap hoy)

HTML rico del portapapeles se parsea contra el schema: marcas soportadas se conservan
(negrita/cursiva/tachado/subrayado/código/enlace/estilos textStyle), `h1..h6` degradan a párrafo
(heading:false), `div` se desenvuelve, scripts/atributos peligrosos se pierden por el parser.
`linkOnPaste: true` (default v3 activo en AMBOS editores): pegar una URL sobre una selección
convierte la selección en enlace. `autolink: true`: teclear URL+espacio auto-enlaza.
Texto plano multilínea → un párrafo por línea.

### 6.2 Contrato F3.5

- **rich, HTML** (`clipboardData.getData("text/html")` no vacío): el HTML pegado pasa por
  `sanitizeHTML` y después se **proyecta sobre el subset §1.1**: `b→strong`, `i→em`,
  `h1..h6→p`, `div/section/…` desenvueltos a párrafos, `ul/ol/li` conservados (li se normaliza
  a `li>p`, un solo nivel: listas anidadas se aplanan a hermanas), `a` conserva `href` (+
  `target="_blank"`→ con su `rel` §1.1; cualquier otro target se descarta), **todo lo demás se
  desenvuelve a su texto** (incluidos `span[style]` con color/tamaño: el estilo se pierde,
  D11) y los elementos sin contenido textual se descartan. Se inserta en el caret /
  reemplazando la selección, fusionando el primer/último bloque pegado con el párrafo partido.
- **rich, texto plano**: split por `\n` (y `\r\n`) → cada línea un párrafo; una sola línea se
  inserta inline.
- **plain**: SIEMPRE texto (`text/plain`; si solo hay HTML, su `textContent`), y **aplanado a
  una línea**: `\n`/`\r\n`/tabs → un espacio (secuencias colapsadas a uno). Corrige el legacy
  (D7: hoy el pegado multilínea en plain cuela `\n\n` vía `getText()`).
- **Sin `linkOnPaste` y sin `autolink`** (D8): pegar una URL inserta la URL como texto. Enlace
  solo explícito (botón / Mod+K).

---

## 7. IME (garantías de composición)

1. Entre `compositionstart` y `compositionend` el motor **no emite `onContent`** (nada de
   commits a mitad de composición; el DOM intermedio de la composición jamás se serializa).
   Al `compositionend` se serializa y emite una vez.
2. Ningún `keydown` con `event.isComposing === true` (o `keyCode === 229`) se intercepta: ni el
   bloqueo de Enter en plain (el Enter que confirma el candidato DEBE pasar), ni Escape (que
   cancela la composición, no la sesión), ni atajos. **El legacy plain de VersoInline rompe esto
   hoy** (su `handleKeyDown` devuelve true para todo Enter): el motor lo corrige (D12).
3. Un click-fuera durante composición: se deja terminar la composición (el navegador dispara
   `compositionend` antes o durante el mousedown), y el flush del `end()` serializa el estado
   post-composición. Garantía mínima exigible: **nunca se persiste un estado intermedio de
   composición**.
4. El motor no muta el DOM del editable durante una composición (las re-normalizaciones se
   difieren a `compositionend`) — mutar bajo el IME rompe la composición en Safari/Android.

---

## 8. Casos borde (semántica normativa)

1. **Toggle sobre selección parcialmente marcada: UNIFICAR.** Si TODA la selección ya tiene la
   marca → se quita del rango; si alguna parte no la tiene → se aplica a TODO el rango. (Paridad
   ProseMirror `toggleMark`.) Estado «activo» del botón = «toda la selección marcada».
2. **Selección que cruza marcas**: aplicar una marca produce el anidamiento canónico §1.2.2-3,
   partiendo y re-fusionando runs según haga falta (ver fixtures `bold-envuelve-em-…`,
   `bold-cruza-frontera-de-enlace`).
3. **Enlace sobre selección con enlace previo: REEMPLAZO con extensión de rango.** Aplicar
   enlace con una selección que toca uno o más enlaces existentes primero extiende el rango a
   los límites del enlace tocado (paridad `extendMarkRange("link")` — así una selección parcial
   dentro de un enlace re-apunta el enlace ENTERO) y aplica el `href` nuevo a todo el rango
   resultante. Quitar enlace (unlink o href vacío) con el caret/selección dentro de un enlace
   quita el enlace COMPLETO.
4. **Toggle de lista**: sobre párrafos → cada párrafo seleccionado se vuelve `li` de UNA lista
   nueva; sobre ítems de la MISMA clase de lista → los ítems seleccionados salen a párrafos
   (partiendo la lista si la selección es interior); sobre ítems de la OTRA clase → la(s)
   lista(s) de los ítems seleccionados cambian de tipo. 
5. **Lista dentro de lista: NO** (D6). Tab no anida; pegar listas anidadas las aplana. El
   legacy SÍ anidaba (Tab → sinkListItem) — recorte deliberado del alcance acotado.
6. **Borrar hasta vaciar**: el documento vacío emite `""` (§1.2.1); la sesión sigue viva (no se
   cierra por vaciar); el placeholder visual es cosa del CSS del bloque, no del valor.
7. **Undo dentro de la sesión vs Ctrl+Z global**: el motor mantiene una pila de undo LOCAL de la
   sesión (snapshot de documento+selección por transacción de usuario, con coalescencia de
   tecleo consecutivo). No se usa el undo nativo del navegador (D4: con mutaciones programáticas
   del DOM el stack nativo de contenteditable queda corrupto/incompleto — mismo motivo por el
   que ProseMirror trae el suyo). Ctrl+Z con la sesión abierta: deshace DENTRO del editor y
   jamás toca el store (guard `isTypingTarget`/`inlineEditingId` ya existente + preventDefault
   del motor). Al cerrar la sesión, la pila local muere; el undo global del store ve la sesión
   entera como pocas entradas coalescedas (`coalesceKey inline:<nodeId>`), como hoy.
8. **Nodo desaparecido / cambio de `inlineEditingId`**: sin cambios — `inlineSession` ya hace
   fail-soft (commit no-op si el nodo no existe) y auto-dispose por suscripción.

---

## 9. Decisiones explícitas (dudas resueltas — ninguna en silencio)

| # | Duda | Decisión |
|---|---|---|
| D1 | ¿`b/i` o `strong/em` en la emisión? | `strong`/`em` (lo que emite Tiptap hoy → los docs existentes ya lo llevan). El PARSER acepta también `b`/`i` (contenido legado/pegado) y los normaliza. |
| D2 | VersoInline hoy acepta subrayado/tachado/código por atajo de StarterKit sin ofrecerlos en el bubble. | El motor NO los soporta: atajos no-op; al PARSEAR contenido inicial, `u`/`s`/`code`/`mark`/`span[style]` se desenvuelven a texto (el formato fuera de contrato se pierde AL EDITAR ese bloque — asumido: los bloques rich de Verso solo han producido el subset; contenido creado en el editor legacy que entre a Verso puede perder color/tamaño/subrayado al editarse inline — riesgo aceptado y documentado). |
| D3 | El legacy no tiene Mod+K. | Se AÑADE Mod+K → popover de enlace (mejora deliberada, pedida en el encargo). |
| D4 | ¿Undo nativo del navegador o propio? | Pila propia por sesión (§8.7); el nativo es irrecuperable con mutaciones programáticas. |
| D5 | ¿`<li>texto</li>` o `<li><p>texto</p></li>`? | `<li><p>…</p></li>` — byte-compatible con TODO el contenido ya guardado por Tiptap (schema `listItem: paragraph block*`); el parser acepta ambos y normaliza a `li>p`. |
| D6 | ¿Listas anidadas? | NO. Un nivel. Tab no-op; el pegado aplana. (El legacy anidaba vía Tab.) |
| D7 | Pegado multilínea en plain. | Se aplana a una línea con espacios. El legacy (VersoInline plain) hoy deja pasar párrafos múltiples al pegar y `getText()` emite `\n\n` — bug de contrato, corregido. |
| D8 | `autolink`/`linkOnPaste` (activos hoy por defecto de Tiptap v3 en ambos editores). | FUERA. Enlace solo explícito. (Sorpresa del legacy documentada en findings.) |
| D9 | El popover de enlace de VersoInline no tiene toggle «nueva pestaña»; el legacy sí. | Se INCLUYE el toggle (está dentro del contrato de enlace y el saneador ya normaliza el `rel`). |
| D10 | ¿Buscador de contenido interno en el popover? | NO en F3.5 (evita `components/puck/*` en Verso, como ya decidió VersoInline). Hueco W34 documentado. |
| D11 | Tiptap v3 pone `target="_blank" rel="noopener noreferrer nofollow"` como DEFAULT de atributos del Link ⇒ los enlaces creados por VersoInline HOY salen con `target="_blank"` implícito. | El motor emite `target` SOLO si el usuario marca «nueva pestaña», y `rel="noopener noreferrer"` (sin `nofollow`: es contenido propio del sitio, y es lo que fuerza `sanitizeHTML` — punto fijo §1.2.7). Al parsear contenido existente, `rel` se recalcula según esta regla y `nofollow` se descarta. |
| D12 | El bloqueo de Enter en plain rompe la confirmación IME hoy. | Corregido: nada se intercepta con `isComposing` (§7.2). |
| D13 | ¿`<br>` al final de párrafo (trailing break de renderizado)? | El motor no emite `<br>` finales de relleno; un Shift+Enter al final del párrafo emite el `<br>` literal (queda una línea vacía visual). El parser tolera `<br>` finales sin duplicarlos. |

---

## 10. Fixture ejecutable (`text-cases.json`)

Ruta: `frontend/src/lib/verso/inline-engine/__fixtures__/text-cases.json`. 54 casos.

**Forma**: `{ meta, cases: [{ name, schemaKind, initialHtml, op, expectedHtml }] }`.

- **Marcadores de selección** (en vez de paths): `[[` abre y `]]` cierra la selección, embebidos
  en el TEXTO de `initialHtml`; `[[]]` juntos = caret colapsado. Todo caso tiene exactamente un
  `[[` y un `]]`. Los marcadores se retiran antes de cargar el documento. La dirección es
  ancla=`[[`, foco=`]]`.
- `initialHtml`/`expectedHtml` en schema `plain` contienen el VALOR de texto plano (no HTML).
- `expectedHtml` está en la normalización canónica §1 — el test debe comparar **byte a byte**
  (nada de comparar árboles «equivalentes»).
- `op.kind` ∈ `bold | italic | link | unlink | list | unlist | clearFormat | typeText | enter |
  paste`. Args: `link {href, newTab?}`; `list {ordered}`; `unlist {}`; `typeText {text}`
  (`text: ""` = borrar la selección); `enter {shift?}`; `paste {html?} | {text?}`.
- Gate adicional (rich): para cada caso, `sanitizeHTML(expectedHtml) === expectedHtml`.
- Los expected derivan del comportamiento del LEGACY (Tiptap/StarterKit ejecutado mentalmente
  contra su código) EXCEPTO donde una D-decision de §9 diverge a propósito; cada divergencia
  está anclada a su D en la tabla anterior (D5 `li>p`, D6 sin anidar, D7/D12 plain, D8 sin
  autolink, D11 target/rel).
