# Especificación ejecutable del comportamiento DnD del fork @wordjs/puck

> F2/VERSO — arnés previo al motor nuevo. Este documento describe el comportamiento OBSERVABLE del
> clúster de arrastre-y-suelta del fork (`frontend/packages/puck/lib/dnd/*`,
> `components/DropZone`, `components/DraggableComponent`, `components/DragDropContext`) tal como
> existe HOY, para que el motor nuevo lo resuelva **idénticamente** sin heredar su implementación
> contra `@dnd-kit/react` 0.1.18. No es una guía de refactor ni prescribe cómo implementarlo — es un
> contrato de comportamiento. El fixture ejecutable que acompaña esta spec vive en
> `frontend/src/lib/verso/__fixtures__/dnd-cases.json`.
>
> Ficheros fuente auditados (solo lectura, sin modificar):
> `lib/dnd/NestedDroppablePlugin.ts` (294L), `lib/dnd/collision/dynamic/{index,get-direction,
> get-midpoint-impact,store,track-movement-interval}.ts` (184L combinadas), `lib/dnd/collision/
> directional/index.ts` (56L), `lib/dnd/use-sensors.ts` (64L), `components/DropZone/index.tsx`
> (618L) + `components/DropZone/lib/{use-drag-axis,use-content-with-preview,use-min-empty-height}.ts`,
> `components/DragDropContext/index.tsx` (607L), `components/DraggableComponent/index.tsx` (739L),
> más soporte: `lib/global-position.ts`, `lib/root-droppable-id.ts`, `lib/get-frame.ts`,
> `lib/get-deep-dir.ts`, `lib/throttle.ts`, `lib/data/insert.ts`, `lib/dnd/use-on-drag-finished.ts`,
> `components/DropZone/context.tsx`.

## 0. Vocabulario y constantes exactas

| Término | Significado | Fuente |
|---|---|---|
| `zoneCompound` | id de una zona droppable, forma `${areaId}:${zone}` (p.ej. `root:default-zone`, `compA:content`) | `DropZone/index.tsx:303-309` |
| `areaId` | id del **componente que posee** una zona (el contenedor) | `DropZone/context.tsx` |
| `rootDroppableId` | constante literal `"root:default-zone"` | `lib/root-droppable-id.ts` |
| `rootAreaId` | constante literal `"root"` | `lib/root-droppable-id.ts` |
| `depth` | entero que crece **+1 en cada frontera de zona Y +1 en cada frontera de componente**; la zona raíz arranca en `depth=0` (`DragDropContext` `nextContextValue`); cada `DraggableComponent` la pasa como `depth+1` a su `DropZoneProvider` interno, y cada `DropZoneEdit` lee `ctx.depth` tal cual. Cadena zona→comp→zona→comp da profundidades 0,1,2,3,4... | `DraggableComponent/index.tsx:624-630`, `DropZone/index.tsx:294` |
| `path` | array de ids ancestros (zonas+componentes) desde la raíz, EXCLUYENDO el propio nodo; se usa para excluir descendientes del ítem arrastrado | `indexes.nodes[id].path` |
| `BUFFER` | `6` (px) — contracción del *bounding box* de cada candidato antes del hit-test | `NestedDroppablePlugin.ts:66` |
| `midpointOffset` | `0.05` (5% de la dimensión del droppable en el eje de arrastre) — "zona muerta" alrededor del punto medio | `collision/dynamic/index.ts:40` |
| `INTERVAL_SENSITIVITY` | `10` (px) — el punto "previo" de trackeo de movimiento solo se actualiza cuando el delta supera este umbral (suaviza jitter) | `track-movement-interval.ts:12` |
| `AREA_CHANGE_DEBOUNCE_MS` | `100` — debounce de cambio de ÁREA (no de zona) mientras el drag está activo | `DragDropContext/index.tsx:76` |
| ventana de fallback deshabilitado | `100` ms tras cada cambio de zona/área — `collisionStore.fallbackEnabled=false` temporalmente | `DragDropContext/index.tsx:90-107` |
| activación de sensor | ver §7 — `mouse`=sin restricción sobre el handle, `touch`={delay:200ms,tolerance:10px}, `other`={delay:200ms,tolerance:10px,distance:5px} | `use-sensors.ts` |

Todo el proceso ocurre en **dos fases desacopladas**, ejecutadas por sistemas distintos:

- **Fase 1 — ¿QUÉ zona/área es la candidata?** (`NestedDroppablePlugin`, corre en cada
  `pointermove`, throttled a 50ms, a nivel `document.body` con `capture:true`). Decide qué zona
  queda **habilitada** para colisión.
- **Fase 2 — ¿EN QUÉ ÍNDICE dentro de esa zona?** (los *collision detectors* de dnd-kit —
  `createDynamicCollisionDetector` por cada componente sorteable, `pointerIntersection` por cada
  `DropZone` vacía — más el `onDragOver` de `DragDropContext` que traduce el resultado de colisión
  en `{zone, index}`).

Solo la zona que la Fase 1 marcó como "más profunda" tiene sus *droppables* internos habilitados;
la Fase 2 nunca ve candidatos de otras zonas porque están `disabled`.

## 1. Fase 1 — resolución de candidato (`findDeepestCandidate`)

### 1.1 Recolección de candidatos (`getPointerCollisions`)

1. `elements = document.elementsFromPoint(x, y)` sobre el documento del `target` del evento — lista
   en **orden de pintado, de más al frente hacia atrás** (top-to-bottom z-order del navegador).
2. Si algún elemento de esa lista tiene `[data-puck-drawer]` → **la lista se restringe a solo ese
   elemento** (el drawer de bloques nuevos gana SIEMPRE sobre cualquier elemento droppable que esté
   debajo, aunque se solapen).
3. Si (tras el paso 2) algún elemento tiene `[data-puck-preview]` (el contenedor del iframe del
   canvas) y NO había drawer → se traduce el punto a coordenadas del `<iframe id="preview-frame">`
   (`GlobalPosition.frame`, ver §1.4) y se vuelve a correr `elementsFromPoint` **dentro del
   documento del iframe**. Esto es lo que permite arrastrar un bloque nuevo desde el drawer (que
   vive en el documento host) hacia dentro del canvas (que vive en el iframe).
4. Para cada elemento de la lista resultante, se leen los atributos `data-puck-dropzone` (id de
   zona) y `data-puck-dnd` (id de componente); se ignora cualquier elemento con
   `data-puck-dnd-void`.
5. **Buffer de 6px**: si el elemento tiene alguno de esos dos atributos, se contrae su
   `getBoundingClientRect()` 6px por cada lado (`left+6, right-6, top+6, bottom-6`) y se comprueba
   que el punto (en coordenadas de FRAME — ver nota abajo) caiga dentro del rect contraído; si no,
   el elemento se **descarta como candidato para esta posición** (no se agrega a `candidates[]`),
   pero el resto de la lista de `elementsFromPoint` se sigue procesando normalmente (no corta el
   bucle).
   - **Nota de implementación observada**: la comprobación de buffer usa siempre
     `position.frame.x/y` (coordenadas traducidas "como si estuviera dentro del iframe"),
     independientemente de si el elemento candidato realmente vive en el documento del iframe o en
     el host. En la práctica esto no genera bugs visibles porque todo componente/zona droppable
     real SOLO se renderiza dentro del iframe — pero es una asunción implícita no garantizada por
     tipos. Ver hallazgo F-1.
6. Cada elemento que sobrevive el buffer se resuelve contra el **registro vivo de droppables**
   (`manager.registry.droppables.get(id)`) y se agrega a `candidates[]`. Un mismo elemento puede
   aportar HASTA DOS candidatos (uno por `data-puck-dropzone`, otro por `data-puck-dnd`) si tiene
   ambos atributos — no ocurre en el DOM actual (son atributos mutuamente exclusivos por tipo de
   nodo) pero el código no lo impide.

### 1.2 Orden por profundidad y desempate (`depthSort`)

`candidates.sort((a,b) => a.depth - b.depth)` (ascendente). El `Array.prototype.sort` de JS es
**estable** (garantizado desde ES2019), y el resultado se **invierte** justo después
(`.reverse()`, ver §1.3 paso 3). Para profundidades distintas esto da el resultado esperado
(mayor profundidad primero), pero para **empates exactos de profundidad**, el efecto neto de
"ordenar estable ascendente y luego invertir todo el array" es que **también se invierte el orden
relativo de los elementos empatados** — el candidato que ganaría un naive "topmost wins" en
realidad PIERDE. Ver hallazgo F-2 (comportamiento verificado por simulación manual paso a paso,
no es una regla de prioridad deliberada del código).

### 1.3 Filtrado (orden exacto de aplicación)

Tras ordenar ascendente por profundidad:

1. Se localiza el candidato cuyo `id === draggable.id` (el propio ítem que se está arrastrando) y
   se **elimina** de la lista (si existe).
2. Se filtran (con `.filter`, preservando orden) los candidatos que:
   - **Sean descendientes del ítem arrastrado**: `candidateData.path.indexOf(draggedCandidateId) >
     -1` → excluido. (Nota: esta comprobación solo se activa si el ítem arrastrado SÍ estaba en la
     lista de candidatos originalmente — `draggedCandidateIndex > -1`; si el propio ítem arrastrado
     nunca apareció como candidato en este tick, sus descendientes NO se filtran por esta regla.
     Ver hallazgo F-3.)
   - Sean de tipo `"dropzone"` con `isDroppableTarget === false` (el `accepts()`/`allow`/`disallow`
     de esa zona rechaza el `componentType` que se arrastra — ver §1.5) → excluido.
   - Sean de tipo `"dropzone"` cuyo `areaId === draggedCandidateId` (la zona pertenece al propio
     componente que se arrastra — redundante con la regla de `path` pero cubre el caso raíz de esa
     zona) → excluido.
   - Sean de tipo `"component"` con `inDroppableZone === false` (el componente vive dentro de una
     zona que rechaza el tipo arrastrado) → excluido.
3. Se **invierte** el array filtrado (`reverse()`). Como venía ascendente por profundidad, tras
   invertir queda **descendente**: el candidato con MAYOR profundidad primero.
4. `primaryCandidate = filteredCandidates[0]` — el más profundo que sobrevivió el filtrado.

Si `candidates.length === 0` desde el inicio (nada bajo el puntero, ni con buffer) →
**`{zone: rootDroppableId, area: rootAreaId}` inmediatamente**, sin pasar por el filtrado.

Si tras el filtrado no queda ningún `primaryCandidate` (todo fue descartado) → también
`{zone: null, area: null}` — **distinto** del caso anterior: aquí NO se cae a root, se devuelve
`null` explícito (ver hallazgo F-4, esto significa que un puntero que SOLO está sobre candidatos
rechazados —p.ej. una única dropzone que no acepta el tipo, sin nada más debajo— deja de tener
zona/área "deepest" válida, lo cual congela `zoneDepthIndex`/`areaDepthIndex` en su último valor
conocido en vez de volver a la raíz).

### 1.4 Resolución de `zone` y `area` desde el candidato ganador (`getZoneId`)

- Si `primaryCandidate.type === "component"`:
  - Si `containsActiveZone === true` (el componente tiene ≥1 zona hija propia actualmente
    "activa" — ver `DraggableComponent`, se computa como `Object.values(localZones).some(Boolean)`
    vía el canal `registerLocalZone`/`unregisterLocalZone` que las `DropZoneEdit` hijas propagan
    hacia arriba) → `zone = null`. Esto representa "el puntero está sobre el chrome del
    contenedor, no sobre un hueco droppable concreto dentro de él" — se **descarta este
    candidato como zona** y el sistema debe resolver realmente contra su(s) zona(s) interna(s) (que
    ya deberían haber ganado como candidatos de mayor profundidad si el puntero estaba
    genuinamente sobre ellas).
  - Si no → `zone = candidateData.zone` (la zona EN LA QUE VIVE este componente, es decir: soltar
    "junto a" este componente, dentro de la zona de su padre).
- Si `primaryCandidate.type === "void"` → `zone = "void"` (zona explícitamente no-droppable;
  produce cancelación en `onDragEnd`, ver §6).
- En cualquier otro caso (tipo `"dropzone"`) → `zone = primaryCandidate.id` (el propio
  `zoneCompound`).

`area`:
- Si el candidato es un `component` Y `containsActiveZone===true` → `area = primaryCandidate.id`
  (el propio componente se convierte en el "área" activa — es el contenedor cuyo interior se está
  evaluando).
- En cualquier otro caso → `area = primaryCandidate.data.areaId` (el id del componente dueño de la
  zona/componente ganador).

### 1.5 `accepts()` — `allow`/`disallow`

Implementado en `DropZoneEdit.acceptsTarget` (`DropZone/index.tsx:357-383`), reevaluado por cada
zona contra el `componentType` del ítem que se arrastra (`draggedItem.data.componentType` leído del
`ZoneStoreContext`):

```
si componentType es null/undefined → true (acepta todo; ocurre cuando aún no hay draggedItem)
si hay `disallow`:
    filteredDisallow = disallow - allow   (se excluyen de disallow los tipos explícitamente en allow)
    si componentType ∈ filteredDisallow → false
si no, si hay `allow`:
    si componentType ∉ allow → false
en cualquier otro caso → true
```

`allow` sin `disallow` = allow-list pura. `disallow` sin `allow` = block-list pura. Ambos presentes
= `allow` gana sobre `disallow` para los tipos que aparecen en ambos (whitelist explícita
prevalece).

## 2. Habilitación de colisión (gating entre Fase 1 y Fase 2)

El resultado `{zone, area}` de la Fase 1 llega al callback `onChange` del plugin, configurado en
`DragDropContextClient` (`DragDropContext/index.tsx:214-273`). Este callback **decide si y cuándo**
escribir `zoneDepthIndex`/`areaDepthIndex` en el `zoneStore` — son estos dos índices (NO el
resultado crudo de la Fase 1) los que cada `DropZoneEdit` lee para decidir si sus *droppables*
internos están `disabled`.

Reglas de escritura (en este orden):

1. Si `params.zone !== "void"` pero el estado actual tiene `zoneDepthIndex["void"] === true`
   (veníamos de estar sobre "vacío") → escritura **inmediata**, sin importar si está en medio de un
   drag (salir de "void" siempre es inmediato, para que el usuario recupere feedback visual rápido
   al volver a una zona real).
2. Si cambió el `area` (`areaChanged`, comparado contra las claves actuales de `areaDepthIndex`):
   - Si el drag está activo (`manager.dragOperation.status.dragging`): se usa
     `useDebouncedCallback(setDeepestAndCollide, 100)` — **pero solo si los parámetros nuevos
     difieren de los últimos que ya estaban pendientes de debounce** (dedupe por referencia de
     valores `{area, zone}` guardada en `debouncedParamsRef`); si difieren, se cancela cualquier
     debounce pendiente y se reprograma uno nuevo de 100ms.
   - Si NO está arrastrando (drag aún no confirmado por sensor) → escritura inmediata.
3. Si cambió la `zone` pero NO el `area` (`zoneChanged && !areaChanged`) → escritura **inmediata**
   siempre (sin debounce), y se cancela cualquier debounce de área pendiente.
4. Si ninguno cambió → no-op.

`setDeepestAndCollide` (la escritura real):
- `zoneDepthIndex = params.zone ? {[params.zone]: true} : {}` — **un único key**, sustituye
  cualquier estado anterior (solo una zona puede estar "habilitada" a la vez).
- `areaDepthIndex` análogo con `params.area`.
- Deshabilita `collisionStore.fallbackEnabled` durante 100ms (`useTempDisableFallback`) — evita que
  el detector de colisión de respaldo (`closestCorners`, ver §3.4) produzca falsos positivos justo
  tras cambiar de zona.
- Tras 50ms adicionales, fuerza `manager.collisionObserver.forceUpdate(true)` (recalcula colisión
  con el nuevo set de droppables habilitados).

`DropZoneEdit` lee `isDeepestZone = zoneStore.zoneDepthIndex[zoneCompound] ?? false`; combinado con
`targetAccepted` (accepts()), da `isEnabled`. Este `isEnabled` se propaga a:
- El propio `useDroppable` de la `DropZoneEdit` (`disabled: !isDropEnabled`, donde
  `isDropEnabled = isEnabled && (preview ? contentIdsWithPreview.length===1 :
  contentIdsWithPreview.length===0)` — **el contenedor de la zona SOLO es un droppable directo
  cuando está genuinamente vacía** o contiene únicamente el propio preview que se está insertando).
- `sortable.droppable.disabled` de CADA `DraggableComponent` hijo de esa zona, vía una suscripción
  al `zoneStore` en un `useEffect` de `DraggableComponent` (`sortable.droppable.disabled =
  !zoneStore.getState().enabledIndex[zoneCompound]`, y el `enabledIndex[zoneCompound]` se escribe
  desde `DropZoneEdit` en un `useEffect` separado apenas cambia `isEnabled`).

**Consecuencia observable clave**: en una zona **con contenido**, el espacio "muerto" entre/alrededor
de los ítems (el padding del contenedor, huecos entre hijos) NO es droppable — solo lo son las
formas geométricas de los propios ítems hijos (vía sus *sortable* individuales). Colgar el puntero
sobre el padding de una zona no vacía no actualiza el preview de inserción; el preview se queda en
su último valor válido hasta que el puntero entre en la geometría de colisión de algún ítem.

## 3. Fase 2 — resolución de índice dentro de la zona ganadora

### 3.1 Eje de arrastre (`dragAxis`) por layout — `useDragAxis`

Recalculado por `DropZoneEdit` vía `getComputedStyle` de su propio nodo DOM, en cada cambio de
`status` del store y en `viewportchange`:

| `display` computado | `flexDirection` | `dragAxis` resultante |
|---|---|---|
| `grid` | — | `"dynamic"` |
| `flex` | `row` (o `row-reverse`) | `"x"` |
| cualquier otro (`flex` column, `block`, etc.) | — | `"y"` (default) |

Este `dragAxis` de la ZONA se pasa a cada hijo como `autoDragAxis`. Cada `DraggableComponent`
recalcula el suyo propio (`useEffect`, `DraggableComponent/index.tsx:591-611`):

1. Si se pasó `userDragAxis` explícito (prop `collisionAxis` de la `DropZone` que lo declara el
   autor del bloque contenedor) → **ese gana siempre**, ignorando el resto.
2. Si no, y el `display` computado del propio elemento draggable es `inline`/`inline-block` →
   forzado a `"x"`.
3. En cualquier otro caso → usa el `autoDragAxis` heredado de la zona.

`"dynamic"` (grid) significa: en cada tick, la dirección se decide por cuál eje tuvo mayor `|delta|`
desde el último punto "asentado" (ver §3.2) — puede alternar entre horizontal y vertical dentro del
mismo drag.

### 3.2 Dirección de movimiento (`trackMovementInterval` + `getDirection`)

- **Estado GLOBAL, no por-drag**: `intervalCache` es un objeto módulo-level compartido por TODAS
  las invocaciones del detector dinámico (ver hallazgo F-5).
- En cada llamada: `delta = current - previous` (donde `previous` es el último punto que superó el
  umbral, NO el punto inmediatamente anterior).
- `direction = getDirection(dragAxis, delta) || direction_anterior` — si el delta en el eje
  relevante es exactamente `0`, se conserva la dirección previamente calculada (nunca vuelve a
  `null` una vez establecida, salvo en el primerísimo tick del proceso).
- `previous` solo se actualiza a `current` cuando `|delta.x| > 10 || |delta.y| > 10` (histéresis:
  micro-movimientos por debajo de 10px no mueven el punto de referencia, lo que evita que
  `direction` "tiemble" con jitter del puntero).
- `getDirection(axis, delta)`:
  - `axis==="dynamic"`: si `|delta.y| > |delta.x|` → `delta.y>0 ? "down" : "up"` (o `null` si
    `delta.y===0`); si no, → `delta.x>0 ? "right" : "left"` (o `null` si `delta.x===0`). **Empate
    exacto `|delta.y| === |delta.x|`** cae en la rama del eje X (la condición es estrictamente
    `>`, no `>=`) — ver hallazgo F-6.
  - `axis==="x"`: solo mira `delta.x` (ignora Y por completo).
  - `axis==="y"` (o cualquier otro valor no reconocido): solo mira `delta.y`.

### 3.3 Punto medio y zona muerta (`getMidpointImpact`)

Con `dragShape` = *bounding box* actual del clon que se arrastra, `dropShape` = *bounding box* del
droppable candidato, `direction` de §3.2, `offset = midpointOffset(0.05) × dimensión_relevante_del_
dropShape`:

| `direction` | Condición "está sobre el punto medio" (`overMidpoint === true`) |
|---|---|
| `"down"` | `dragShape.bottom >= dropShape.center.y + offset` (comparación `>=`, INCLUSIVA) |
| `"up"` | `dragShape.top < dropShape.center.y - offset` (comparación `<`, ESTRICTA) |
| `"left"` | `dropShape.center.x - offset >= dragShape.left` (comparación `>=`, INCLUSIVA) |
| `"right"` | `dragShape.right - offset >= dropShape.center.x` (comparación `>=`, INCLUSIVA) |
| `null` | cae en la rama `"right"` por defecto (el `if/else if` de `getMidpointImpact` no tiene caso `null` explícito; el último `else` cubre tanto `"right"` como `null`) — ver hallazgo F-7 |

**Asimetría deliberada de bordes**: 3 de las 4 direcciones usan `>=` (inclusivo) pero `"up"` usa
`<` (estricto). En el valor EXACTO del umbral, `"down"/"left"/"right"` cuentan como "ya pasó el
punto medio" mientras que `"up"` en el valor exacto **todavía no** cuenta.

### 3.4 Selección del detector ganador — prioridades

Para cada droppable habilitado, en este orden (el primero que produce colisión gana, salvo la regla
de prioridad `Highest` que puede ganar sobre cualquier otro droppable del mismo tick):

1. **`Highest` — colisión "de origen pegajoso"** (`directionalCollision`, solo se evalúa si
   `dragOperation.source.id === droppable.id`, es decir, el droppable evaluado es la posición
   ORIGINAL del propio ítem que se arrastra): compara la distancia euclidiana del centro del
   droppable al punto `previous` trackeado vs. al punto `current`; si la distancia está
   **disminuyendo** → colisión `Highest`. Si es exactamente igual, se conserva el estado de
   "creciente/decreciente" anterior (`distanceChange` también es módulo-level global, mismo
   hallazgo F-5). Esto es lo que permite que un ítem "regrese limpiamente" a su propio hueco sin
   parpadeo cuando el puntero se acerca de vuelta a su posición original.
2. **`High` — punto medio con intersección real**: requiere `intersectionArea > 0` (solapamiento
   geométrico real, no solo proximidad) **Y** `overMidpoint===true` (§3.3). Si ambas condiciones se
   cumplen, colisión con `value = intersectionRatio` (área de intersección / área total del
   droppable).
3. **`Low`/`Lowest` — fallback por proximidad** (`closestCorners` de `@dnd-kit/collision`), SOLO si
   `collisionStore.fallbackEnabled===true` (no está en la ventana de 100ms post-cambio-de-zona) Y
   el droppable evaluado no es el origen. Restricción adicional: el fallback solo se evalúa si el
   `dragShape` proyecta sobre el `dropShape` en el **eje ortogonal** al eje de arrastre (para
   `dragAxis==="y"` requiere solape en X; para cualquier otro requiere solape en Y) — esto evita
   "saltar" de columna/fila por proximidad diagonal. Si además hay `intersectionArea>0` →
   prioridad `Low`; si no (pura cercanía sin solapamiento) → prioridad `Lowest`.
4. Si nada de lo anterior aplica → sin colisión con ese droppable en este tick (`null`).

Para una **zona vacía**, el droppable candidato es el CONTENEDOR de la `DropZone` misma (no hay
hijos), usando el detector `pointerIntersection` (importado de `@dnd-kit/collision`, punto-dentro-
de-rectángulo simple — no el detector dinámico) — el índice resultante es siempre `0`.

> **Divergencia conocida del proxy puro (§3.4.1)**: el resolutor puro
> (`frontend/src/lib/verso/dnd/resolve.ts`) no trackea movimiento entre ticks — no puede computar
> "distancia decreciente hacia el centro del origen" por sí solo. El driver de sensores debe proveer
> `dragging.originApproaching` (boolean, derivado del trackeo real de distancia): cuando viene
> definido, la colisión `Highest` del origen se produce SOLO si es `true`. Cuando es `undefined`
> (p.ej. los 48 casos del fixture, que son de un solo tick), el resolutor cae al proxy
> puntero-dentro-del-rect-del-origen, que aproxima el comportamiento pero no es idéntico al
> `directionalCollision` del fork.

### 3.5 De colisión a `{zone, index}` — `onDragOver` de `DragDropContext`

```
target = event.operation.target        // ganador de colisión de dnd-kit para este tick
si !target || !source || target.type === "void" → return (preview no cambia)

si target.type === "component":
    targetZone  = targetData.zone
    targetIndex = targetData.index                    // índice ACTUAL del ítem-objetivo en su zona
    dir = getDeepDir(target.element)                   // "ltr"|"rtl", ver §3.6
    collisionPosition =
        (collisionData.direction === "up") ||
        (dir === "ltr" && collisionData.direction === "left") ||
        (dir === "rtl" && collisionData.direction === "right")
        ? "before" : "after"

    si (targetIndex >= sourceIndex) && (sourceZone === targetZone):
        targetIndex -= 1        // compensa el "hueco" que deja el origen al quitarse de la MISMA zona

    si collisionPosition === "after":
        targetIndex += 1
si no (target.type !== "component", i.e. contenedor de zona vacía):
    targetZone  = target.id
    targetIndex = 0

// guarda de auto-drop / descendiente (SEGUNDA guarda, redundante con la de Fase 1 §1.3)
sourceId = primer segmento de source.id antes de ":"
targetId = primer segmento de target.id antes de ":"
path = indexes.nodes[target.id].path
si targetId === sourceId || algún elemento de path tiene sourceId como su primer segmento:
    return   // preview no cambia esta vuelta

// escribe el preview (ver §4 para new vs existing)
```

**Orden de las dos correcciones de índice**: primero la compensación de "mismo-zona-shift"
(`-1` si `targetIndex >= sourceIndex` y misma zona), **después** el `+1` por `"after"`. El orden
importa: para mover el primer ítem de una lista de 3 al final (`sourceIndex=0`, apuntando al último
ítem `targetIndex=2`, `direction="down"` → after): `targetIndex(2) >= sourceIndex(0)` → `-1` → `1`;
luego `after` → `+1` → `2`. Resultado: índice final `2` (última posición tras remover el origen).

### 3.6 RTL — `getDeepDir`

`getDeepDir(el)` camina hacia arriba por `el.parentElement` buscando el primer `[dir]` explícito
(no usa `getComputedStyle` ni herencia CSS — es un walk manual del atributo HTML `dir`); si llega a
la raíz sin encontrar ninguno, devuelve `"ltr"` por defecto. Solo afecta las direcciones
`"left"`/`"right"` (ver tabla en `onDragOver` arriba) — `"up"`/`"down"` son universales, no se
invierten nunca por `dir`. El `dir` relevante es el del **elemento objetivo de la colisión**
(`target.element`), no el de la zona raíz ni el del ítem arrastrado — por tanto una zona RTL anidada
dentro de una página LTR (o viceversa) usa su propio `dir` local para este cálculo.

## 4. Distinción nuevo vs. existente

`dragMode.current` se fija en `onBeforeDragStart`: `"new"` si `event.operation.source.type ===
"drawer"`, si no `"existing"`. Se resetea (`initialSelector.current = undefined`) en cada nuevo
`onBeforeDragStart`.

| | `"new"` (desde el drawer) | `"existing"` (reordenar/mover) |
|---|---|---|
| Preview en `onDragStart` | no se crea preview aquí (el drawer no tiene item real en el store) | se crea inmediatamente un preview `type:"move"` en la zona de origen, leyendo el ítem real vía `getItem` |
| Preview en `onDragOver` | `previewIndex[targetZone] = {type:"insert", componentType: sourceData.componentType, index: targetIndex, props:{id: source.id}}` | `initialSelector.current` se fija SOLO la primera vez (si aún es `undefined`) al `{zone, index}` de origen; luego `previewIndex[targetZone] = {type:"move", componentType, index: targetIndex, props: item.props}` leyendo el ítem por `initialSelector.current` (no por la posición actual, que puede ya haber cambiado por el propio preview) |
| Commit en `onDragEnd` (tras animación, §6) | `insertComponent(componentType, zone, index, state)` — crea un nodo NUEVO (id nuevo) | `dispatch({type:"move", sourceIndex: initialSelector.current.index, sourceZone: initialSelector.current.zone, destinationIndex: preview.index, destinationZone: preview.zone, recordHistory:false})` |

## 5. Umbral de activación del drag (`useSensors`)

Un único `PointerSensor` (dnd-kit) con `activationConstraints` que dependen del tipo de puntero Y de
si el `pointerdown` ocurrió sobre el propio *handle* del elemento sorteable:

| Caso | Restricción aplicada | Efecto |
|---|---|---|
| `pointerType==="mouse"` y el target del evento ES el handle (o descendiente de él) | `mouse` (no pasado explícitamente por `DragDropContext` → `undefined`) | **sin restricción**: el drag arranca en el primer `pointermove` tras el `pointerdown`, sin delay ni distancia mínima |
| `pointerType==="touch"` | `{delay:{value:200, tolerance:10}}` | debe mantener el dedo quieto (dentro de 10px) 200ms antes de que se reconozca como drag — evita competir con el scroll táctil |
| Cualquier otro caso (pen, mouse fuera del handle, etc.) | `{delay:{value:200, tolerance:10}, distance:{value:5}}` | ambas restricciones activas simultáneamente (semántica exacta de combinación delegada a `@dnd-kit/react` PointerSensor — no reimplementada en el fork) |

`DraggableComponent` no pasa un *handle* explícito a `useSortable` → el elemento draggable completo
actúa como su propio handle (cualquier click en cualquier parte del bloque activa el drag,
sujeto a que no haya un elemento interactivo hijo que capture el evento antes).

## 6. Autoscroll

Delegado por completo a `AutoScroller` de `@dnd-kit/dom` (parte de `defaultPreset.plugins`),
**sin ninguna configuración custom** (umbrales/velocidad son los defaults de la librería — el fork
no los toca). Único control expuesto: la prop `disableAutoScroll` de `<DragDropContext>` filtra el
plugin `AutoScroller` fuera del array de plugins activos por completo (on/off, sin gradación). El
motor nuevo necesita decidir explícitamente si depende de una librería externa equivalente o
implementa su propio autoscroll — este comportamiento es una **caja negra externa**, no hay lógica
propia que documentar más allá del on/off.

## 7. Commit gateado por animación

En `onDragEnd`:

1. Si `!source` (no había ítem de origen — caso degenerado) → limpia `draggedItem`, sale.
2. Si `event.canceled` o `target?.type === "void"` → **cancelación**: limpia `previewIndex`,
   dispara los listeners `dragend` registrados, `dispatch({type:"setUi", ui:{itemSelector:null,
   isDragging:false}})` — **nunca se llama `insertComponent` ni `dispatch({type:"move"})`**. Nada
   se crea ni se mueve.
3. En cualquier otro caso, se registra un `effect()` reactivo (`@dnd-kit/state`) que observa
   `source.status`; **el commit real (③ abajo) NO ocurre en este mismo tick de `onDragEnd`** —
   ocurre de forma diferida, la primera vez que `source.status === "idle"` (el estado que dnd-kit
   asigna una vez que la animación de "clon regresando/asentándose" —`transition: {duration:200ms,
   easing:'cubic-bezier(0.2,0,0,1)'}`, configurada en `useSortable`— termina). El efecto se
   auto-dispone (`dispose()`) tras ejecutarse una vez.
4. El commit real (dentro de `onAnimationEnd`, invocado cuando `status==="idle"`):
   - Limpia `previewIndex`.
   - Si el preview activo era `type:"insert"` → `insertComponent(...)`.
   - Si era `type:"move"` → `dispatch({type:"move", ..., recordHistory:false})`.
   - Inmediatamente después, `dispatch({type:"setUi", ui:{itemSelector:{index,zone}, isDragging:
     false}, recordHistory:true})` — **este segundo dispatch es el que graba el snapshot de
     historial** (el `move` en sí se dispachó con `recordHistory:false`); el motor nuevo debe
     replicar que el par (mutación de datos + cambio de selección) colapsa en **una sola** entrada
     de undo/redo, anclada al ÚLTIMO dispatch del par, no al primero.
   - Dispara los listeners `dragend`.

**Consecuencia para el motor nuevo**: el usuario puede soltar el botón del mouse (evento nativo
`pointerup`/`dragend` de dnd-kit) MILISEGUNDOS antes de que el dato real se escriba en el store —
durante la ventana de animación, `state.ui.isDragging` sigue siendo la única señal fiable de "el
drag todavía no terminó del todo" para cualquier código que dependa de leer el estado post-drop
(p.ej. `useOnDragFinished`, que expone justamente esta señal ya "asentada" a otros consumidores del
fork como `useMinEmptyHeight`).

## 8. Casos borde

### 8.1 Zona vacía
El contenedor de la `DropZone` (no un `DraggableComponent` hijo) es el droppable; detector
`pointerIntersection`; índice siempre `0`. Si la zona tenía 0 ítems y llega un preview, pasa a tener
"1" (el propio preview optimista) — el contenedor sigue siendo droppable exactamente mientras
`contentIdsWithPreview.length <= 1` en presencia de preview (ver §2).

### 8.2 Bloque sobre sí mismo
Filtrado en DOS capas independientes:
- Fase 1 (§1.3): el propio candidato se remueve de `candidates[]` antes de ordenar/filtrar.
- Fase 2 (§3.5): guarda explícita `targetId === sourceId` → `onDragOver` no actualiza el preview
  (se congela en su último valor válido).

### 8.3 Soltar sobre un descendiente propio
Misma doble capa: Fase 1 excluye por `path.indexOf(draggedId) > -1`; Fase 2 excluye si algún
segmento del `path` del target coincide con el `sourceId`. Previene anidar un contenedor dentro de
sí mismo (recursión infinita de datos).

### 8.4 Primer índice / último índice
- Primer índice (`0`): se alcanza aproximándose al primer ítem con `direction` "before"
  (`"up"` en columna, `"left"`/`"right"` según `dir` en fila) SIN el `+1`, y sin la resta de
  mismo-zona-shift si el origen no está antes del target.
- Último índice (`length` tras remover el origen si aplica): se alcanza con `direction` "after"
  sobre el último ítem de la zona, `targetIndex = lastIndex + 1` (menos la corrección de -1 si el
  origen estaba en la misma zona antes de esa posición).
- Mover el PRIMER ítem al final, o el ÚLTIMO al principio, son casos legítimos que ejercitan ambas
  correcciones de índice simultáneamente (ver ejemplos calculados en §3.5 y en el fixture,
  categoría `same-zone-shift`).

### 8.5 Zonas anidadas 4 niveles
La profundidad crece +1 en cada frontera zona↔componente (§0). Un árbol
`root(0) → CompA(1) → zonaInterna(2) → CompB(3) → zonaMasInterna(4)` tiene 4 niveles de anidamiento
de ZONA real (root, zonaInterna, zonaMasInterna cuenta 3 zonas — para 4 niveles de zona se necesita
una frontera componente↔zona adicional). El fixture cubre explícitamente árboles con 1, 2, 3 y 4
niveles de zona anidada, con las profundidades numéricas ya resueltas como dato de entrada (ver
`layout.depth` en cada nodo del fixture — el motor nuevo puede recalcularlas de la estructura, pero
deben coincidir con esta regla de +1 por frontera).

## 9. Hallazgos — comportamiento sorprendente o indocumentado (F-1..F-8)

- **F-1 (BUFFER usa coordenadas de frame incondicionalmente)**: `getPointerCollisions` calcula el
  buffer de 6px contra `position.frame.x/y` para TODO candidato, sin comprobar si ese candidato
  realmente vive dentro del iframe. Hoy es inofensivo porque todo elemento con `data-puck-dnd`/
  `data-puck-dropzone` vive exclusivamente dentro del iframe del canvas, pero es una asunción
  implícita, no verificada por tipos ni por runtime — un motor nuevo que renderice CUALQUIER
  droppable fuera de un iframe (o sin iframe del todo, si F1 decide esa arquitectura) hereda una
  bomba de relojería si copia este código literalmente.
- **F-2 (empate de profundidad: gana el candidato pintado MÁS ATRÁS, no el de más al frente —
  efecto colateral de `reverse()` sobre un `sort` estable)**: `depthSort` ordena ascendente con
  `Array.sort` (estable desde ES2019): para candidatos con profundidad IDÉNTICA, el sort NO los
  reordena entre sí, conserva su orden de entrada (que es el de `elementsFromPoint`, más al frente
  primero). El código INMEDIATAMENTE DESPUÉS invierte el array completo con `.reverse()` (§1.3
  paso 3) para que la mayor profundidad quede primero. Para profundidades distintas esto funciona
  correctamente. Pero para el subconjunto EMPATADO, invertir el array TAMBIÉN invierte su orden
  relativo interno — el candidato que `elementsFromPoint` listó ÚLTIMO entre los empatados (el que
  estaba MÁS ATRÁS en el pintado) termina PRIMERO tras el `reverse()`, y por tanto ES EL QUE GANA.
  Verificado por simulación manual paso a paso: dados dos candidatos a la misma profundidad
  `[Front, Rear]` (Front pintado encima), tras `sort` ascendente estable con `root` antepuesto:
  `[root, Front, Rear]`; tras `.reverse()`: `[Rear, Front, root]` → `primaryCandidate = Rear`. No
  hay ninguna regla explícita de desempate "semántica" (ni por área, ni por cercanía al centro) —
  es enteramente un efecto colateral incidental de la combinación sort-estable+reverse, y va en la
  dirección OPUESTA a la intuición "lo que está encima gana". Ver el fixture, categoría
  `z-order-tiebreak`, para 3 casos que lo demuestran con aritmética completa (incluyendo el caso
  general N-way: gana el que el hit-test listó último entre los empatados).
- **F-3 (el filtro de "descendientes" solo actúa si el propio ítem arrastrado apareció como
  candidato en ese tick)**: la remoción de descendientes del ítem arrastrado
  (`candidateData.path.indexOf(draggedCandidateId) > -1`) está condicionada a
  `draggedCandidateId && draggedCandidateIndex > -1` — si el puntero está tan lejos del propio
  ítem arrastrado que este ni siquiera aparece en `candidates[]]` de ese tick (algo normal: el
  ítem arrastrado casi nunca está bajo el puntero durante un drag activo), la comprobación de
  "es descendiente" de todas formas sigue evaluándose porque la condición realmente exige que
  `draggedCandidateIndex` sea `> -1`... — en la práctica esto significa que la exclusión de
  descendientes se activa correctamente casi siempre PORQUE `draggedCandidateId` (el id del
  `draggable` actualmente en drag, tomado de `manager.dragOperation.source`, no de la lista de
  candidatos) está definido durante todo el drag; la parte realmente condicional es
  `draggedCandidateIndex > -1` (posición del ítem arrastrado DENTRO de `candidates[]`, que
  normalmente es `-1` porque el ítem arrastrado no está bajo el puntero) — cuando es `-1`, el
  `splice` de remoción del paso "quita el candidato arrastrado" no hace nada (no hay nada que
  quitar), PERO el filtro de descendientes por `path` toma la MISMA condición
  `draggedCandidateIndex > -1` como guarda, así que **cuando el ítem arrastrado no aparece como
  candidato explícito (el caso normal), el filtro de "es descendiente mío" NO SE APLICA EN
  ABSOLUTO** — la protección contra soltar dentro de tu propio descendiente en la Fase 1 depende
  enteramente de que ese descendiente esté marcado con el `path` correcto Y de que el propio ítem
  arrastrado casualmente esté en la lista de candidatos ese tick. La guarda REAL y confiable contra
  auto-anidamiento es la de Fase 2 (§3.5, comparación directa de `path` del target contra
  `sourceId`, sin ninguna condición previa) — la de Fase 1 es una optimización de "cortar temprano"
  best-effort, no la defensa autoritativa. El motor nuevo debe tratar la comprobación de Fase 2
  como la única fuente de verdad y no asumir que Fase 1 ya lo filtró.
- **F-4 (fallback a root vs. `null` explícito son casos DISTINTOS con efectos distintos)**: "cero
  candidatos desde el inicio" (nada bajo el puntero) devuelve `{zone: rootDroppableId, area:
  rootAreaId}` (reafirma la raíz activamente). "Candidatos existían pero todos fueron filtrados"
  devuelve `{zone: null, area: null}` (NO reafirma la raíz; `zoneDepthIndex`/`areaDepthIndex`
  conservan su ÚLTIMO valor conocido mientras el puntero permanezca sobre esa geometría rechazada).
  Un motor nuevo que colapse estos dos casos en uno solo ("sin candidato → root") cambiaría el
  comportamiento observable: hoy, pasar el puntero sobre una zona que rechaza el tipo arrastrado
  (pero está encima de la raíz) NO empuja la selección de vuelta a la raíz; se queda "pegada" al
  último candidato válido.
- **F-5 (estado de colisión global, no por-instancia ni por-drag)**: tanto `intervalCache`
  (`track-movement-interval.ts`) como `flushNext` (`collision/dynamic/index.ts`) como
  `distanceChange` (`collision/directional/index.ts`) son variables **module-level** compartidas
  por TODAS las invocaciones del detector, sin scoping por id de drag ni de droppable. Funciona
  porque solo hay un drag activo a la vez en el editor real, pero es una trampa para pruebas
  unitarias que invoquen el detector repetidamente sin resetear ese estado entre casos (el
  resultado del caso N puede depender de residuos del caso N-1) — el fixture adjunto documenta cada
  caso como si el estado estuviera "fresco", y el motor nuevo, si preserva este patrón, necesita un
  mecanismo explícito de reset entre tests.
- **F-6 (empate de eje en `dragAxis:"dynamic"` resuelve a X, no es indefinido)**: cuando
  `|delta.y| === |delta.x|` exactamente (movimiento perfectamente diagonal a 45°), `getDirection`
  usa `>` estricto para decidir "Y domina", así que el empate cae por defecto en la rama X
  (horizontal). No es un caso "ambiguo sin definir" — está determinísticamente sesgado hacia
  horizontal.
- **F-7 (`direction===null` se comporta como `"right"` en `getMidpointImpact`)**: la función no
  tiene rama explícita para `direction===null` (solo ocurre en el primerísimo tick de un drag antes
  de que haya habido CUALQUIER movimiento neto) — el último `else` cubre tanto `"right"` como
  `null`, así que un primer tick sin movimiento evalúa el midpoint como si la dirección fuera
  "derecha".
- **F-8 (asimetría de comparación en el punto medio, `>=` vs `<` estricto)**: documentado en §3.3 —
  `down`/`left`/`right` usan `>=` (el valor exacto del umbral YA cuenta como "pasado"), `up` usa `<`
  (el valor exacto del umbral TODAVÍA NO cuenta). Un motor nuevo que "normalice" las 4 ramas a la
  misma comparación por consistencia cambiaría el resultado exacto en el borde para arrastres
  verticales hacia arriba.
- **F-9 (hover sobre el "chrome" de un contenedor cuya zona anidada está activa DESHABILITA TODAS
  las zonas, no solo se ignora)**: cuando el candidato ganador de la Fase 1 es un `component` con
  `containsActiveZone===true`, `getZoneId` devuelve `zone=null` (§1.4) — esto NO es un caso
  degenerado sin efecto: en `DragDropContextClient`'s `onChange` (`getChanged`), un `params.zone`
  falsy con un `zoneDepthIndex` previo no vacío se interpreta como `zoneChanged=true`, y
  `setDeepestAndCollide` escribe `zoneDepthIndex = {}` (objeto vacío, ningún key). Efecto
  observable: al pasar el puntero sobre el padding/chrome de un contenedor que SÍ tiene una zona
  interna activa (pero sin estar el puntero físicamente sobre esa zona interna), **absolutamente
  ninguna zona de la página queda habilitada para colisión** durante ese tramo — ni la interna
  (el puntero no está sobre ella) ni la externa/padre (quedó explícitamente vaciada, no
  reafirmada). El usuario ve el drag "congelarse" sin preview hasta que el puntero entre
  genuinamente en una zona real. Ver fixture, caso `depth-3level-chrome-over-active-nested-zone-
  disables-all` y `buffer-excludes-nested-zone-edge-cascades-to-null-via-active-chrome` (donde el
  buffer de 6px puede DISPARAR esta cascada aunque el puntero esté a 1px de una zona real).

## 10. Esquema del fixture ejecutable

`frontend/src/lib/verso/__fixtures__/dnd-cases.json` — ver cabecera `$schemaNotes` del propio
fichero para la forma exacta. Resumen:

```
Case = {
  name: string
  category: string                  // agrupación temática (ver tabla abajo)
  layout: ZoneNode                  // árbol recursivo de zonas/ítems con rects ABSOLUTOS
  pointer: {x, y}                   // usado por la Fase 1 (hit-test + buffer)
  dragging: {
    type: "new" | "existing"
    sourceId?: string                // requerido si type==="existing"
    componentType: string
    rect: {left, top, right, bottom} // bounding box ACTUAL del clon que se arrastra (Fase 2)
    direction: "up"|"down"|"left"|"right"|null   // dirección YA resuelta (ver §3.2 — el fixture
                                                   // no requiere que el motor derive esto de
                                                   // movimiento crudo, es un input precomputado)
  }
  expected: { slotId: string|null, index: number|null }   // null = "el motor NO debe actualizar
                                                             // el preview este tick" (§1.3 F-4, §3.5)
  rationale: string                 // qué regla exacta de esta spec justifica el resultado

  // Campos opcionales, presentes solo en los casos que los necesitan:
  hitOrder?: string[]               // SOLO relevante si ≥2 candidatos comparten profundidad EXACTA
                                     // bajo el puntero: declara el orden elementsFromPoint (más al
                                     // frente primero). Ver F-2 (corregido): tras sort-estable-
                                     // ascendente + reverse(), gana el listado ÚLTIMO entre los
                                     // empatados. Categoría z-order-tiebreak únicamente.
  pointerOverDrawer?: boolean       // si true, simula que el elemento bajo el puntero tiene
                                     // [data-puck-drawer] (§1.1 paso 2): la lista de candidatos se
                                     // restringe a ese elemento (sin data-puck-dropzone/-dnd) =>
                                     // candidates=[] => fallback a rootDroppableId.
  dragging.fallbackEnabled?: bool   // default true (estado estable). false simula la ventana de
                                     // 100ms tras un cambio de zona/área en la que
                                     // collisionStore.fallbackEnabled está temporalmente
                                     // deshabilitado (§2, useTempDisableFallback) — usado para
                                     // casos donde NINGÚN detector (ni High ni fallback) puede
                                     // ganar, dando {null,null} de forma inequívoca sin depender
                                     // de la aritmética interna (externa, no auditada) de
                                     // closestCorners.
}

ZoneNode = {
  id: string            // zoneCompound, p.ej. "root:default-zone" o "compA:content"
  kind: "zone"
  areaId: string
  depth: number
  direction: "column"|"row"|"grid"
  dir: "ltr"|"rtl"
  accepts: null | string[]     // allow-list; null = acepta todo tipo
  disallow?: string[]
  rect: {left, top, right, bottom}
  items: ComponentNode[]
}

ComponentNode = {
  id: string
  kind: "component"
  componentType: string
  depth: number
  rect: {left, top, right, bottom}
  zIndex?: number         // solo presente en casos de solape; mayor = más al frente
  zones: ZoneNode[]       // [] si es hoja (sin dropzones anidadas)
}
```

Categorías presentes en el fixture (con recuento de casos):

| categoría | qué ejercita | nº casos |
|---|---|---|
| `depth-resolution` | Fase 1 completa: profundidad, chrome-vs-zona-activa, fallback a root | 5 |
| `midpoint-y` | punto medio eje vertical (columna), before/after, bordes exactos `>=`/`<` | 6 |
| `midpoint-x` | punto medio eje horizontal (fila), LTR | 4 |
| `rtl` | inversión left/right por `dir`, `getDeepDir` anidado | 5 |
| `grid` | `dragAxis:"dynamic"`, empate de eje | 4 |
| `new-vs-existing` | drawer vs sortable, shift de mismo-zona, cross-zona | 4 |
| `empty-zone` | contenedor como droppable, índice 0 | 4 |
| `self-and-descendant` | las dos guardas de auto-drop (§8.2, §8.3) | 3 |
| `accepts` | allow/disallow, prioridad allow-sobre-disallow | 4 |
| `buffer-edge` | los 6px de contracción, drawer-override | 4 |
| `z-order-tiebreak` | empate de profundidad resuelto por pintado | 3 |
| `first-last-index` | mover primer↔último con ambas correcciones combinadas | 2 |

Total: 48 casos (mínimo pedido: 40).
