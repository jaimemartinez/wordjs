# Auditoría de derivación — Verso vs. el fork `@wordjs/puck`

> F5a. Encargo: para cada subsistema del fork retirable (`frontend/packages/puck`), enumerar el
> equivalente en Verso y dictaminar, con evidencia de código leído en ambos lados (no solo grep de
> nombres), si es reescritura limpia o derivación. Veredicto final: si `NOTICE.md` (la nota de
> atribución MIT del fork) puede retirarse al borrar `frontend/packages/puck`.
>
> **Alcance y método.** `frontend/packages/puck` es un fork vendorizado de Puck v0.20.2
> (`@measured/puck`, MIT, ver `frontend/packages/puck/LICENSE` + `NOTICE.md`) — el fork en sí **no
> se toca** en este pase (su retirada física es post-F7). Este documento compara el fork con los
> módulos de Verso que lo sustituyen funcionalmente: `frontend/src/lib/verso/*` y
> `frontend/src/components/verso/*`. Para cada subsistema pedido leí el código fuente completo de
> ambos lados (no until until until — leí archivo por archivo, no infería de nombres) y cito
> archivo:línea. No leí `frontend/packages/puck/dist` (compilado) en ningún momento.
>
> **Marco legal aplicado (no soy abogado; esto es una evaluación de ingeniería con criterio de
> derecho de autor de software, para que Legal la revise, no para sustituir esa revisión).** El
> copyright de software protege la **expresión** (la elección concreta de código, estructura de
> implementación, comentarios, nombres creativos) — no protege **ideas, métodos de operación,
> algoritmos en abstracto ni interfaces necesarias para interoperar** (17 U.S.C. §102(b); Oracle
> v. Google, 593 U.S. 1 (2021), sobre código declarativo de API necesario para interoperabilidad;
> doctrina de *merger* cuando solo hay una forma práctica de expresar una idea; doctrina de *scènes
> à faire* para patrones estándar del dominio). Bajo ese marco, distingo tres niveles de similitud,
> de menor a mayor riesgo:
> 1. **Idea/comportamiento observable** (p.ej. "un campo select solo acepta strings como value de
>    `<option>`, así que hay que codificar el valor real de alguna forma") — nunca protegible.
> 2. **Interfaz/forma de datos necesaria para interoperar** (p.ej. la unión de 10 tipos de campo con
>    sus propiedades) — protegible en teoría, pero de bajísimo riesgo práctico cuando (a) existe una
>    necesidad de interoperabilidad real y documentada (31 plugins ya compilados que declaran contra
>    esa forma) y (b) la reimplementación usa mecánica de tipos y nombres propios, no una copia del
>    archivo.
> 3. **Implementación/algoritmo concreto** (estructura de funciones, estructuras de datos internas,
>    fórmulas, nombres de variables no forzados por ningún contrato externo) — el nivel donde vive el
>    verdadero riesgo de derivación.
>
> Cada subsistema se dictamina contra estos tres niveles por separado, porque (como pidió el
> encargo) el resolutor DnD y el contrato de campos son honestamente distintos entre sí en el nivel
> donde se concentra el riesgo.

## Resumen ejecutivo

**Veredicto global: reescritura limpia. `NOTICE.md` puede retirarse cuando se borre
`frontend/packages/puck`, sin matices que bloqueen la retirada — con un matiz documentado (no
bloqueante) en el contrato de tipos de campo, nivel 2 de la escala de arriba, no nivel 3.**

De los 6 subsistemas pedidos, los 6 son arquitecturalmente distintos en el nivel 3 (estructura de
datos interna, algoritmo, nombres propios): ningún archivo de Verso es una traducción línea-a-línea
ni una reorganización cosmética de un archivo del fork. El punto de mayor similitud estructural de
todo el árbol no está en ninguno de los 6 subsistemas de render/interacción sino en el **contrato de
tipos de campo** (`VersoField` en `registry.ts` vs. `Field` en `packages/puck/types/Fields.ts`) —
nivel 2: una interfaz de datos, no una implementación — y existe por una razón documentada y
verificable: 31 plugins de marketplace ya compilados (algunos de terceros) declaran sus `fields`
contra esa forma exacta y deben seguir funcionando sin recompilar. Ese punto se trata en detalle en
la §4 con la evidencia completa; aquí el resumen es que la tabla de tipos es lo más parecido que hay
en todo el árbol, y aun así es una reescritura independiente (mecánica de tipos distinta, sin
genéricos, sin importar el fork) de una interfaz dictada por necesidad de interoperabilidad, no una
copia de implementación.

| Subsistema | Equivalente Verso | Nivel 3 (impl.) | Nivel 2 (interfaz) | Riesgo | Veredicto |
|---|---|---|---|---|---|
| store/reducer | `lib/verso/store.ts` + `commands.ts` | Distinto por completo | Distinto por completo | Bajo | Reescritura limpia |
| DnD (resolutor) | `lib/verso/dnd/resolve.ts` | Distinto (funciones puras, sin dnd-kit) | Réplica deliberada de la spec de comportamiento (constantes, operadores) | Medio — mitigado, ver §2 | Reimplementación de especificación, no copia de expresión |
| Canvas/AutoFrame | `components/verso/canvas/FrameController.tsx` | Opuesto (documento propio + portal vs. mirror de estilos del host) | N/A | Bajo | Reescritura limpia |
| Campos/AutoField | `components/verso/fields/VersoFieldControl.tsx` (render) | Distinto (dispatch único vs. sistema de overrides + shadow-state) | Ver fila de abajo | Bajo (render) | Reescritura limpia |
| — contrato de tipos de campo | `lib/verso/registry.ts` (`VersoField`) | — | Estructuralmente próximo, por interoperabilidad documentada | Medio — el punto de mayor similitud del árbol, ver §4 | Interfaz de interoperabilidad, no copia de expresión |
| Render/SlotRender | `components/verso/render/{EditorRenderer,VersoBlock,VersoSlot}.tsx` | Distinto (suscripción por-nodo vs. store global) | Bajo (contrato DOM genérico) | Bajo | Reescritura limpia |
| Overlay/ActionBar | `components/verso/overlay/{OverlayLayer,GeometryStore,ActionBar}.tsx` | Opuesto (capa central vs. N overlays portalled) | N/A | Bajo | Reescritura limpia |

## 1. Store / reducer

**Fork:** `packages/puck/reducer/{index.ts,actions.tsx,actions/*.ts}` + `packages/puck/store/*`.
Reducer de React (`useReducer`) sobre acciones discretas al estilo Redux
(`insert`/`replace`/`replaceRoot`/`reorder`/`move`/`remove`/`duplicate`/`registerZone`/
`unregisterZone`/`setData`/`setUi`/`set`), cada una con su propio módulo bajo `reducer/actions/`,
indexadas por **zona+índice** (`destinationZone: string, destinationIndex: number`), con historia
grabada EXTERNAMENTE por un callback `record()` interceptado por tipo de acción
(`storeInterceptor`, `reducer/index.ts:32-63`) y un store zustand separado (`store/index.ts`) con
slices (`fields.ts`, `history.ts`, `nodes.ts`, `permissions.ts`) e índices derivados
(`state.indexes.nodes`/`state.indexes.zones`) recalculados aparte.

**Verso:** `lib/verso/store.ts` (`createEditor`) + `lib/verso/types.ts` + `lib/verso/commands.ts`.
Documento **normalizado** (mapa plano `id → VersoNode`, `lib/verso/types.ts:74-106`) con **comandos**
tipados (`insertNode`/`moveNode`/`removeNode`/`setProps`/`setRootProps`/`duplicateSubtree`/
`replaceData`, `types.ts:121-174`) aplicados dentro de una **transacción** (`store.ts:180-262`) que
genera sus propios inversos y los usa para undo/redo (parches inversos, no un segundo tipo de acción
"reverse"), con **coalescencia por ventana de tiempo** (`VERSO_HISTORY_COALESCE_MS`, `store.ts:46`) y
**suscripción por nodo** (`subscribeNode`, `store.ts:335-341`) para que un `setProps` en un
contenedor no fuerce a re-renderizar a sus hijos.

**Comparación (nivel 3, evidencia):**
- Direccionamiento: el fork direcciona por **zona+índice** (`sourceZone`/`destinationIndex`,
  `reducer/actions.tsx:32-51`); Verso direcciona por **id de nodo + slot** (`nodeId, toParentId,
  toSlotKey, toIndex`, `types.ts:129-135`). Son dos esquemas de direccionamiento incompatibles, no
  una renombrada de la otra: el del fork requiere reconstruir índices de zona en cada acción
  (`registerZone`/`unregisterZone` existen SOLO para ese propósito); el de Verso no tiene análogo
  porque el mapa de nodos ya es la fuente de verdad de posición.
- Undo/redo: el fork graba **snapshots del `AppState` completo** vía el callback `record()`
  (intercepta el resultado ya calculado del reducer); Verso graba **comandos + sus inversos
  exactos** (`HistoryEntry.commands`/`.inverse`, `types.ts:196-206`) y deshace **reaplicando los
  inversos**, no restaurando un snapshot — arquitectura de historia distinta (comando-con-inverso vs.
  snapshot), no una implementación alternativa del mismo mecanismo.
- Ninguna de las 11 acciones del fork tiene una función 1:1 en Verso con la misma firma; el propio
  concepto de "acción de zona" no existe en Verso.

**Veredicto: reescritura limpia**, sin matices. La única similitud es la que cualquier editor de
bloques necesita por definición (un árbol mutable con undo/redo) — nivel 1 de la escala, idea no
protegible.

## 2. DnD — el resolutor puro

**Fork:** `packages/puck/lib/dnd/*` + `components/DragDropContext` + `components/DraggableComponent`
+ `components/DropZone`, sobre `@dnd-kit/react` 0.1.18 (confirmado en
`packages/puck/package.json` — dependencia PROPIA del fork, no del árbol raíz de `frontend`).
Arquitectura de dos fases con estado global entre ticks (`intervalCache`, `distanceChange`,
module-level — ver hallazgo F-5 más abajo), acoplada a `document.elementsFromPoint`, sensores
`PointerSensor` y el ciclo de vida de `@dnd-kit`.

**Verso:** `lib/verso/dnd/resolve.ts` + `lib/verso/dnd/types.ts`. Función pura
`resolveDragTarget(input) → {slotId, index}`: sin DOM, sin dependencia de ninguna librería de DnD,
sin estado entre llamadas (el estado de "¿el origen se está acercando?" se recibe como parámetro
opcional `originApproaching` — lo calcula el *driver* de sensores en `components/verso/dnd/`, no el
resolutor). Estructura de datos de entrada propia (`ZoneGeom`/`ComponentGeom`, árbol con rects ya
resueltos) con memoización por `WeakMap` sobre la referencia del layout (`resolve.ts:116-124`, sin
análogo en el fork).

**Esto es honestamente el subsistema de mayor similitud en el nivel de ALGORITMO (no solo de
comportamiento) de los 6 auditados**, y merece el tratamiento explícito que pidió el encargo:

- `documentation/verso/dnd-spec.md` es una **especificación ejecutable del comportamiento
  observable** del clúster DnD del fork, escrita en F2 como arnés PREVIO al motor nuevo — el propio
  documento declara en su cabecera: "para que el motor nuevo lo resuelva **idénticamente** sin
  heredar su implementación". `resolve.ts` implementa esa spec, no el código del fork: sus
  comentarios citan secciones de la spec (`§1.1`, `§3.3`, hallazgos `F-2`…`F-9`), no líneas del
  fork.
- La spec tabula **comportamiento**, incluyendo asimetrías que EL PROPIO fork no documenta en
  ningún comentario y que solo aparecen por simulación manual del código (p.ej. F-2: el desempate de
  profundidad favorece al candidato pintado MÁS ATRÁS por un efecto colateral de `sort` estable +
  `reverse()`, no por una regla de prioridad deliberada; F-8: 3 de las 4 comparaciones de punto medio
  usan `>=` pero `"up"` usa `<` estricto). Verso **replica el resultado** de estas asimetrías
  (`resolve.ts:271-274`, `overMidpoint`) porque son la especificación de comportamiento que otros
  bloques/temas ya observan hoy — cambiarlas sería una regresión de UX, no una limpieza.
- **Por qué esto no es copia de expresión (nivel 2→3 vs. nivel 1):**
  1. **Los valores en sí son hechos observados, no expresión.** `DND_BUFFER = 6`,
     `DND_MIDPOINT_OFFSET = 0.05`, y las 4 comparaciones de `overMidpoint` no son código copiado del
     fork — son **constantes numéricas y predicados matemáticos** medidos empíricamente del
     comportamiento del fork y anotados en la spec como datos, no como fragmentos de código fuente.
     Un hecho sobre cómo se comporta un programa (`"cuando el puntero cruza el 55% del alto del
     droppable en dirección hacia abajo, el objetivo cambia"`) no es una obra protegida por copyright
     aunque el hecho se haya descubierto leyendo código con copyright — el copyright protege la
     expresión del CÓDIGO del fork, no los HECHOS sobre su comportamiento.
  2. **La forma de expresar esos hechos es independiente y distinta.** `resolve.ts` no usa
     `@dnd-kit`, no tiene sensores, no tiene `elementsFromPoint`, no tiene las clases/plugins
     (`NestedDroppablePlugin`, `createDynamicCollisionDetector`) del fork — usa funciones puras sobre
     un árbol aplanado con `Map`/`WeakMap`, con nombres de función y forma de datos propios
     (`findDeepestZone`, `resolveWithinZone`, `FlatLayout`, `zoneAccepts`) que no existen en el fork.
  3. **El único fragmento donde la TÉCNICA (no solo el resultado) se replica deliberadamente** es el
     desempate de profundidad: `candidates.sort((a,b) => a.node.depth - b.node.depth)` seguido de
     `filtered.reverse()` (`resolve.ts:214,238`) — el mismo patrón "ordenar ascendente estable, luego
     invertir" que produce el efecto F-2 en el fork. Esto es **el punto de mayor riesgo algorítmico
     real de todo el árbol** — no el contrato de campos (que es un problema de forma de datos, no de
     algoritmo). Pero: (a) es la única forma práctica de reproducir *exactamente* "estable ascendente
     + invertido" con las primitivas de `Array.prototype.sort` de JS — dado el requisito funcional de
     bug-compatibilidad con F-2, la doctrina de *merger* aplica con fuerza real aquí (hay
     esencialmente una sola manera idiomática de lograrlo); (b) son 2 líneas de una técnica genérica
     de programación (ordenar y invertir) sin ningún nombre de variable, comentario o estructura
     circundante compartida con el fork; (c) el resto de la función (aplanado del árbol, filtrado,
     `zoneAccepts`, resolución de índice) no comparte esta característica.
  4. **Sensores, autoscroll y el ciclo de fases entero son explícitamente NO replicados**: la propia
     spec documenta en `§3.4.1` que el resolutor puro es una **divergencia conocida** del proxy
     "origen pegajoso" del fork (no trackea movimiento entre ticks por sí solo) — Verso no intentó
     replicar el fork pieza por pieza, sino el contrato observable que le importa al usuario, con
     desviaciones documentadas donde replicar el mecanismo interno no aportaba nada.

**Veredicto: reimplementación de especificación de comportamiento, no copia de expresión.** El
mayor riesgo real (el patrón sort+reverse de 2 líneas) está protegido por la doctrina de *merger*
(única forma práctica de lograr el comportamiento requerido con las primitivas del lenguaje) y no
por casualidad — es un patrón de 2 líneas sin nombres ni comentarios compartidos. Recomiendo
mantener `dnd-spec.md` referenciado permanentemente desde `resolve.ts` (ya lo está) como evidencia de
que el proceso fue "leer comportamiento → escribir spec → implementar contra la spec", no "leer
código → traducir".

## 3. Canvas / `AutoFrame`

**Fork:** `packages/puck/components/AutoFrame/index.tsx` (basado en el patrón de
`react-frame-component`). Monta un iframe **vacío** y usa `CopyHostStyles` para **clonar en tiempo
de ejecución** cada `<style>`/`<link rel="stylesheet">` del documento HOST hacia dentro del iframe
(`collectStyles`, `mirrorEl`, con hashing para deduplicar y un `MutationObserver` del `<head>` del
host para mantener la copia sincronizada).

**Verso:** `components/verso/canvas/FrameController.tsx`. Monta un iframe que carga un **documento
real y separado** (`/admin/canvas-frame`, con su propio `<head>`/hojas de estilo ya declaradas) y
usa `createPortal` para teleportar el árbol React del editor a un `#verso-canvas-root` dentro de
ese documento — el árbol React es literalmente el mismo (mismo contexto de `EditorHandle`), no una
copia sincronizada de estilos. `swapThemeCss` (cambio de tema sin FOUC) es un mecanismo de
`<link>` propio sin análogo en el fork.

**Comparación:** son arquitecturas **opuestas** para el mismo problema ("necesito una vista aislada
dentro de un iframe"): el fork resuelve el aislamiento **mirroreando estilos del padre hacia un
iframe sin contenido propio**; Verso resuelve el mismo problema con **un documento propio con su
propia carga de estilos, y portalea el árbol de componentes (no estilos) hacia él**. No hay
`CopyHostStyles`, ni hashing de estilos, ni `MutationObserver` del `<head>` del padre en Verso;
tampoco hay carga de documento independiente ni `swapThemeCss` en el fork.

**Veredicto: reescritura limpia.** Cero superposición de técnica, más allá de la idea no protegible
"un editor visual usa un iframe".

## 4. Campos — el contrato de tipos vs. los renderers

Este es el subsistema que el encargo señaló como el de mayor riesgo, y hay que separarlo en dos
capas con veredictos distintos: el **contrato de tipos** (nivel 2 de la escala) y los **componentes
de render** (nivel 3). Son archivos distintos (`registry.ts` vs. `VersoFieldControl.tsx`) con
riesgo muy distinto.

### 4.1 Contrato de tipos — `VersoField` (`lib/verso/registry.ts:28-149`) vs. `Field`
(`packages/puck/types/Fields.ts`)

**Esto es, honestamente, el punto de mayor similitud estructural de todo el árbol auditado.** Los
10 discriminantes de tipo (`text`/`number`/`textarea`/`select`/`radio`/`array`/`object`/
`external`/`custom`/`slot`) coinciden 1:1 en nombre y, dentro de cada uno, las propiedades
coinciden en su mayoría (`placeholder`/`min`/`max`/`step`/`options:{label,value}[]`/
`arrayFields`/`objectFields`/`defaultItemProps`/`getItemSummary`/`fetchList`/`mapProp`/
`showSearch`/`initialQuery`/`filterFields`/`initialFilters`/`allow`/`disallow`, y la firma exacta
de `render` en `custom`: `{field, name, id, value, onChange, readOnly}`).

**Por qué existe (evidencia, no suposición):** el propio `registry.ts:4-9` lo declara como
"reescritura con compatibilidad de INTERFAZ (no de expresión)... el fork vendorizado se usa SOLO
como referencia de forma, nunca se importa" — y esto no es una afirmación sin respaldo:
`documentation/verso/legacy-surface.md §3` y `f0-audit-core.md` documentan que **31 plugins de
marketplace, ya compilados y en algunos casos de terceros**, declaran su `fields: {...}` contra
exactamente esta forma (verificado sobre los bundles `dist/*.js` reales, no solo sobre fuente —
`legacy-surface.md §6`), y `lib/verso/pluginBlocks.tsx` (`adaptLegacySingle`/`adaptLegacyMulti`,
`registry.ts:283-284`) los adapta **sin recompilarlos ni tocarlos**. Si Verso inventara su propia
taxonomía de campos con otros nombres, los 31 plugins dejarían de funcionar hasta que cada uno
publicara una nueva versión — una ruptura de compatibilidad hacia terceros sin beneficio.

**Por qué esto es nivel 2 (interfaz de interoperabilidad) y no nivel 3 (copia de expresión):**
1. **Necesidad de interoperabilidad real, no conveniencia.** Es exactamente el escenario de Oracle
   v. Google: una forma de datos/declaración necesaria para que código de terceros ya escrito siga
   funcionando contra un sistema nuevo. El propio criterio de esa doctrina — reimplementar una
   interfaz sin copiar la implementación subyacente para preservar interoperabilidad — es aplicable
   aquí con más fuerza que en el caso judicial, porque aquí el "código de terceros" (los 31 plugins)
   es indiscutiblemente real y ya existe, no hipotético.
2. **La forma de las propiedades es en gran parte vocabulario estándar del dominio** (`min`/`max`/
   `label`/`placeholder`/`options`), compartido por prácticamente cualquier librería de formularios
   (JSON Schema, Formik, react-jsonschema-form usan los mismos nombres) — *scènes à faire*: no hay
   forma creativa alternativa razonable de nombrar "el valor mínimo permitido".
3. **La mecánica de tipos es independiente, no una copia.** El fork usa **tipos genéricos
   paramétricos** que infieren la forma de cada sub-campo a partir del tipo de las props del
   componente (`ArrayField<Props, UserField>` con mapped types condicionales,
   `packages/puck/types/Fields.ts:48-62`); `VersoField` usa **interfaces planas sin genéricos**
   (`ArrayVersoField.arrayFields: Record<string, VersoField>`, `registry.ts:83-90`) — deliberadamente
   más simple porque, a diferencia del fork, el registro de Verso **no importa React** (agnóstico del
   framework de UI que finalmente pinte el panel — comentario propio, `registry.ts:32-33`). Esa es
   una decisión de diseño real y verificable, no cosmética.
4. **No hay import del fork.** `registry.ts` no importa ni un tipo de `packages/puck` — la forma se
   redeclaró de cero mirando el comportamiento observable (qué aceptan los 31 plugins), confirmado
   por tests de anti-deriva PROGRAMÁTICOS contra `puckConfig.tsx` importado
   (`lib/verso/__tests__/verso-coreBlocks.test.ts:34,81-131`) — esos tests comparan **shapes en
   runtime**, no fuente contra fuente.

**Veredicto: interfaz de interoperabilidad, de riesgo bajo-medio y bien mitigado, no copia de
expresión.** Es el ítem que más vale la pena que Legal revise si se quiere una segunda opinión, pero
la combinación de (a) necesidad de interoperabilidad documentada con terceros reales, (b) vocabulario
estándar del dominio, y (c) mecánica de tipos independiente sin import del fork, deja esto muy lejos
de la zona de infracción bajo cualquier lectura razonable de la doctrina citada arriba.

### 4.2 Componentes de render — `VersoFieldControl.tsx` vs. `AutoField/*`

Aquí, al leer código real de ambos lados (no solo la lista de tipos), la similitud **cae
drásticamente** — es la capa donde más se esperaría derivación y es la que menos tiene:

- **Dispatch:** el fork usa un `AutoFieldInternal` con un mapa `defaultFields` mezclable por
  `overrides.fieldTypes` (sistema de overrides de toda la app, `AutoField/index.tsx:125-171`), un
  wrapper `Label` inyectable, contexto anidado `NestedFieldContext` para rutas de `readOnly`
  wildcard (`arrayFields[*].x`), y un patrón de **estado sombra local** (`AutoFieldPrivate`,
  `index.tsx:276-319`) que evita que el estado global pise el valor mientras el campo tiene foco.
  Verso usa un **único componente con `switch(field.type)`** (`VersoFieldControl.tsx:392-418`), sin
  sistema de overrides, sin contexto anidado, sin store global, y **sin estado sombra** — el control
  es directamente controlado por la prop `value` en todo momento.
- **Array:** el fork permite **reordenar arrastrando** (`Sortable`/`SortableProvider` de dnd-kit,
  `ArrayField/index.tsx:166-224`), con un slice de UI global (`state.ui.arrayState[id]`) que mantiene
  `_arrayId`/`_originalIndex` para sobrevivir la reconciliación de React durante el drag, expandir/
  colapsar cada ítem en un acordeón (`openId`), y un botón "Duplicate" además de "Delete" —
  ningún botón explícito de subir/bajar. Verso usa **botones ↑/↓/× explícitos** sobre índices de
  array plano (`arrayMove`/`arrayRemoveAt` en `fieldHelpers.ts`, puras y testeadas en node), **sin
  drag, sin acordeón, sin duplicar, sin slice de UI global** — todos los sub-campos están siempre
  expandidos.
- **Select/Radio:** el fork codifica el valor real de cada opción como **JSON completo** en el
  atributo `value` del `<option>`/`<input>` (`JSON.stringify({value: option.value})`,
  `SelectField/index.tsx:35-43`, `RadioField/index.tsx:39`). Verso codifica por **índice posicional**
  (`optionIndexOf`/`optionValueAt`, `fieldHelpers.ts`) — dos técnicas distintas para el mismo
  problema (un `<select>` nativo solo admite strings), y la interfaz visual de radio de Verso es un
  grupo de píldoras seleccionables con `role="radiogroup"` e inputs `sr-only`, no los radios nativos
  con icono del fork.
- **External:** el fork **posee** la UI del picker (`ExternalInput`, con `fetchList`/`mapRow`/
  `renderFooter`/shim de `adaptor` deprecado). Verso **delega** el picker completo a una función
  inyectada por el llamador (`renderExternalPicker`, `VersoFieldControl.tsx:50-56`) — arquitectura
  invertida (dueño vs. delegador), documentado explícitamente como decisión ("no se acopla a
  MediaPickerModal", cabecera del archivo).

**Veredicto: reescritura limpia**, con más distancia de implementación que cualquier otro subsistema
comparado directamente (ni siquiera comparten mecanismo de reordenar, ni codificación de valor, ni
arquitectura del picker externo). La afinidad real del área de "campos" vive enteramente en 4.1
(el contrato de tipos), no aquí.

## 5. Render / `SlotRender`

**Fork:** `packages/puck/components/{Render,SlotRender}/index.tsx` + `DropZone`. `Render` monta un
`DropZoneProvider` (contexto de React) y pinta la zona raíz vía `DropZoneRenderPure`; `SlotRender`
lee el contenido de una zona desde un **store zustand global** (`useAppStore`, con `useShallow`
sobre `state.indexes.zones[...]`.

**Verso:** `components/verso/render/{EditorRenderer,VersoBlock,VersoSlot}.tsx`. Cada `VersoBlock` se
suscribe a **su propio nodo** vía `handle.subscribeNode` + `useSyncExternalStore`
(`VersoBlock.tsx:40,49-53`) — no hay contexto de React para el árbol de datos, solo para
`registry`/`componentMap`/callbacks estables (`context.ts`). `VersoBlock` reutiliza
`SharedBlockShell` — **el mismo componente que usa el sitio público** — para las 4 ramas de
salida/2 capas de animación-apariencia, dando paridad canvas↔público **por construcción**, algo sin
análogo en el fork (que no comparte código con ningún renderer público porque, como confirma la §6,
el propio sitio público de WordJS ya decidió NO usar el `<Render>` del fork por costo de bundle).
`VersoSlot` calcula el preview de arrastre con una función **pura y exportada para test**
(`slotEntries`, `VersoSlot.tsx:44-65`) que inserta un nodo movido o un "fantasma" según el
`dragPreview` del store — sin análogo en el fork (que resuelve el preview dentro del propio ciclo de
vida de `@dnd-kit`, no como una proyección pura de una lista).

**Comparación:** la única similitud real es el contrato de DOM "un slot es un único `<div>` con un
atributo identificador" (`data-wjs-slot` vs. `data-puck-dropzone`) — inevitable dado que cualquier
motor necesita un contenedor real (no `display:contents`) para poder medir geometría, y el propio
Verso lo documenta como principio general compartido con `ContentRenderer.slotOf` (el renderer
público, no el fork) en el comentario de cabecera de `VersoSlot.tsx`. El mecanismo de suscripción
(por-nodo vs. store global con `useShallow`), la fuente del wrapper visual (`SharedBlockShell`
compartido con público vs. nada compartido en el fork) y el cálculo de preview (función pura vs.
integrado en el ciclo de `@dnd-kit`) son todos distintos.

**Veredicto: reescritura limpia.**

## 6. Overlay / `ActionBar`

**Fork (comportamiento base + la propia divergencia WORDJS #1 de `NOTICE.md`):** Puck v0.20 upstream
renderiza el overlay de cada bloque **dentro del iframe**. El fork WordJS ya lo cambió (divergencia
#1 documentada en `packages/puck/NOTICE.md:27-54`, **una adición de WordJS sobre Puck, no algo
heredado de upstream**) a portalar cada overlay **individualmente** desde dentro del iframe hacia una
capa en el documento padre (`registerOverlayPortal`, `lib/overlay-portal/index.tsx`), con matemática
de scroll/escala en `DraggableComponent.getStyle` y un listener de resync de scroll por bloque.

**Verso:** `components/verso/overlay/{OverlayLayer,GeometryStore,ActionBar}.tsx`. La capa vive
**siempre** en el documento padre — no hay mecanismo de portal en absoluto (ni
`data-puck-overlay-portal` ni equivalente; el comentario de `OverlayLayer.tsx:9-10` señala
explícitamente que replicar ese atributo en la capa es "la trampa documentada del editor actual").
La geometría la calcula una clase dedicada (`GeometryStore`, `ResizeObserver` compartido +
batching por `requestAnimationFrame`, con *scheduler* inyectable para poder testear en Node sin
DOM) alimentada por un único callback `onBlockElement` por bloque — **un componente central**
(`OverlayLayer`) lee ese mapa de rects y pinta como mucho 2 contornos + 1 `ActionBar`, en vez de que
cada bloque porte su propio overlay portalled.

**Nota honesta sobre continuidad de IDEA (no de código):** la decisión de arquitectura "el overlay
vive siempre en el padre, nunca dentro del iframe" **no es una idea tomada de Puck upstream** — es
la idea que **el propio fork de WordJS ya había inventado** como su primera divergencia sobre Puck
(`NOTICE.md` Divergencia 1, preexistente a Verso). Que Verso mantenga esa decisión de arquitectura es
WordJS reutilizando su **propia** idea previa, no apropiándose de algo de un tercero — y en
cualquier caso una decisión de arquitectura de alto nivel ("dónde vive la capa de overlay") es idea/
método de operación, no expresión. La implementación concreta (mecanismo de portal por-bloque con
resync de scroll vs. `GeometryStore` central con batching por rAF) es opuesta en los dos casos.

**Veredicto: reescritura limpia**, con la nota de procedencia de idea de arriba documentada por
transparencia, no porque cambie el análisis de copyright.

## 7. Barrido de nombres en la superficie propia de Verso

Encargo: grep de "puck" en `frontend/src/components/verso` y `frontend/src/lib/verso`, renombrar lo
renombrable sin romper contratos, documentar cada referencia restante con su justificación.

**Metodología:** grep exhaustivo (`puck|Puck|PUCK`, sin distinción de mayúsculas) sobre ambos
directorios → cada resultado clasificado leyendo el archivo, no solo la línea — y para cada
identificador PascalCase `Puck*` declarado (no importado) dentro de la superficie propia, lectura
del punto de declaración para decidir si nombra un contrato externo real o es nombre gratuito.

**Resultado del barrido: no encontré identificadores, tipos, componentes ni variables declarados
por Verso que usen "puck" sin una razón contractual verificable.** El único símbolo PascalCase que
Verso declara con "Puck" en el nombre es `PuckCompatObject`/`withPuckCompat`
(`lib/verso/pluginBlocks.tsx:69,83`), y nombra exactamente lo que es: el objeto de compatibilidad
con la prop `puck` que los 31 bundles de plugin YA COMPILADOS leen por ese nombre literal en tiempo
de ejecución (`props.puck.renderDropZone`/`.isEditing`/`.dragRef`, verificado en
`lib/verso/__tests__/pluginBlocks.test.tsx:178-189`) — renombrar el TIPO quitaría la señal de qué
compatibilidad ofrece; renombrar la PROP `puck` rompería los 31 plugins en producción. No es deuda.

Todo lo demás que aparece en el grep cae en una de cinco categorías, todas justificadas:

1. **Comentarios de paridad histórica** ("espec: el PuckEditor legacy L1398-1430...") — explican por
   qué el código de Verso hace algo de una forma concreta, comparándolo con el comportamiento que
   sustituye. Protegidos explícitamente por el encargo. Ejemplos:
   `editor/presence.ts:4`, `editor/paletteActions.ts:4,19,242`, `editor/hotkeyMap.ts:5`,
   `editor/panelTabs.ts:5,53`, `editor/blockClipboard.ts:5-6,16`, `editor/saveFlow.ts:5`,
   `editor/saveChipModel.ts:3`, `editor/SaveStateChip.tsx:4`, `editor/PropertiesPanel.tsx:4`,
   `editor/EditorHotkeys.tsx:13`, `editor/a11y.ts:6`, `editor/VersoEditor.tsx:6,9,442,1076,1081`.
2. **`CONTENT_META_KEY = "_puck_data"`** (`lib/verso/types.ts:14`) — excepción ratificada
   explícitamente por el usuario (2026-08-15, ver también memoria del proyecto); es el nombre de la
   clave de meta que persiste el backend, cambiar el literal rompe cada página ya guardada.
3. **Referencias de import a archivos FUERA de la superficie propia de Verso** (ni fork ni
   "renombrable ahora" — son el editor legacy o infraestructura compartida, fuera del alcance de este
   barrido por instrucción explícita de no tocar el editor legacy):
   - Editor legacy puro, candidato a *borrado* (no rename) en la retirada: `@/components/PuckEditor`,
     `@/components/PuckEditorSkeleton`, `@/components/CommandPalette` (la legacy, no
     `VersoCommandPalette`), `@/components/BlockInserter`.
   - Módulos de datos puros REUTILIZADOS a propósito, candidatos a *rename* en la retirada (no
     borrado — su lógica sigue viva): `@/lib/puckPatterns` (patrones prediseñados/de usuario,
     localStorage), `@/lib/puckI18n` (diccionario ES del panel), `@/lib/puckPluginRegistry`
     (generado por `scripts/generate-puck-plugin-registry.js`, gitignorado).
   - Infraestructura de bloque **compartida con el sitio público**, NO exclusiva del editor legacy —
     ver hallazgo transversal abajo: `@/components/puckConfig`, `@/components/puck/*` (10 archivos:
     `AnimationField`, `AppearanceField`, `CSSControls`, `FormBlock`, `LinkField`, `SymbolBlock`,
     `VisibilityField`, `blockShell.ts`, `blockVars.ts`, `entranceAnimation.ts`).
4. **Tokens CSS/clases definidos en hojas compartidas** (`frontend/src/components/puck-theme.css`,
   fuera de la superficie propia de Verso, consumida a propósito como "única fuente" — comentario
   propio de `VersoEditor.tsx:6`): `var(--puck-font-family-monospaced)`
   (`editor/PropertiesPanel.tsx:113`, `editor/VersoEditor.tsx:821`, `editor/VersoCommandPalette.tsx:162`)
   y la clase `puck-editor-ui` (`editor/VersoCommandPalette.tsx:198`, que consume
   `puck-theme.css:311-327` para el reset de scrollbar del ⌘K) y `puck-container`
   (`editor/VersoEditor.tsx:720`, que consume el reset de `app/globals.css:49-50`). Verificado que
   **ambos motores** consumen estos mismos tokens/clases hoy — renombrar solo el lado Verso exigiría
   además tocar `puck-theme.css`/`globals.css`, hojas compartidas con el editor legacy que este
   encargo pidió explícitamente no tocar. Diferido al plan de retirada (§ correspondiente en
   `retirement-plan.md`), donde SÍ se puede tocar esa hoja porque el consumidor legacy ya se habrá
   borrado.
5. **Fixtures/tipos de test que modelan literalmente la forma real de un plugin o de un archivo
   externo** — renombrarlos reduciría la fidelidad de lo que el test verifica, no es deuda:
   - `puckComponentDef`/`puckComponents` en `lib/verso/__tests__/{pluginBlocks,verso-registry}.test.ts`
     modelan el nombre EXPORTADO literal que un bundle de plugin real usa (confirmado contra
     `marketplace/plugins/testimonials/client/puck/TestimonialsPuck.tsx` y
     `.../online-store/client/puck/OnlineStorePuck.tsx`, citados en los propios tests).
   - `CorpusEntry.puckData` (`lib/verso/__tests__/helpers.ts:23`) — verifiqué el fichero real
     `documentation/verso/corpus/corpus.json` (gitignorado, presente en este checkout): la clave JSON
     de cada entrada es literalmente `"puckData"` (generada por un script de extracción de
     producción, fuera de este árbol). Renombrar el campo del tipo TS sin tocar el generador del
     corpus rompería el mapeo en runtime (el `JSON.parse(...) as {entries: CorpusEntry[]}` es una
     aserción de tipo, no una validación — un desajuste sería silencioso).
   - `dnd/types.ts:97`/`dnd/resolve.ts:190` comentan `[data-puck-drawer]` citando la terminología de
     `dnd-spec.md` (el atributo real del FORK); verificado que el driver real de Verso
     (`components/verso/dnd/DnDDriver.tsx:203-204`) consulta `[data-wjs-palette]` — su propio
     atributo — así que no hay bug ni referencia colgante, es un comentario que explica el origen de
     la regla (§1.1 de la spec), no una dependencia de código.

**Hallazgo transversal (para el plan de retirada, no accionable aquí):** `@/components/puckConfig`
y los 10 archivos de `@/components/puck/*` **no son "el editor legacy"** — son consumidos en
producción por el **renderer público** (`content/ContentRenderer.tsx`, `content/blocks.tsx`,
`content/AccordionBlock.tsx`, `content/TabsBlock.tsx`, etc., verificado por grep de imports reales)
Y por Verso (`lib/verso/coreBlocks.tsx`, `lib/verso/sharedFields.tsx`, `components/verso/editor/
VersoEditor.tsx`, `components/verso/render/VersoBlock.tsx`) simultáneamente. Renombrar ese directorio
es un cambio real y correcto a largo plazo pero **no pertenece a "la superficie propia de Verso"**
(no es una referencia AL fork ni al editor legacy: es infraestructura de bloque compartida y
transversal) — lo documento en `retirement-plan.md` como su propio paso, deliberadamente posterior y
separado de la retirada del fork/editor legacy, porque toca el camino público.

**Conclusión del barrido: no ejecuté renombrados de código en este pase.** La superficie propia de
Verso (`components/verso/*`, `lib/verso/*`) ya está limpia de nombrado "puck" gratuito — el trabajo
de F2-F4 aparentemente ya evitó esa deuda sobre la marcha. Lo que queda es, en su totalidad,
justificable por una de las 5 categorías de arriba, y las dos únicas superficies con margen de
renombrado real (los módulos compartidos `puckI18n`/`puckPatterns`/`puckPluginRegistry`, y la
infraestructura de bloque `puckConfig`/`components/puck/*`) están fuera del árbol propio de Verso y
del alcance de "sin tocar el editor legacy" de este encargo — están secuenciadas en
`retirement-plan.md`.

## 8. Veredicto final sobre `NOTICE.md`

**`NOTICE.md` (la nota de atribución MIT a The Puck Contributors) puede retirarse cuando se borre
físicamente `frontend/packages/puck`, sin condiciones adicionales.** Su función hoy es exclusivamente
documentar las 2 divergencias funcionales del FORK VENDORIZADO frente a Puck v0.20.2 upstream — un
archivo que, tras la retirada física (fuera de alcance de F5a), deja de existir. No depende de nada
de lo auditado en Verso: los 6 subsistemas de Verso auditados aquí son reescrituras independientes
(o, en el caso del contrato de campos, una interfaz de interoperabilidad de riesgo bajo-medio y bien
mitigado) que no requieren atribución a Puck bajo los términos MIT (la licencia MIT exige conservar
el aviso de copyright **en el código que redistribuye/deriva de ese código** — Verso no redistribuye
ni deriva el código del fork en ninguno de los 6 subsistemas). Si Legal quiere, por prudencia
adicional más allá de lo que exige la licencia, WordJS puede optar por seguir citando a Puck como
origen del **formato de documento** (`_puck_data`/la unión de tipos de campo) en el README, como
cortesía y no como obligación — esto se deja preparado como borrador en `retirement-plan.md §5`, sin
tocar el README todavía (el legacy sigue conviviendo).
