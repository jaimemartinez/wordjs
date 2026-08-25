# Verso — Spec del CRDT de colaboración en tiempo real (F8)

> **Estado**: DECISIONES TOMADAS. Este documento no explora alternativas para que otro decida:
> elige, justifica y deja los gates escritos. Lo que queda abierto está marcado como
> **[ABIERTO]** con el criterio exacto que lo cerrará.
>
> **QUÉ SE CONSTRUYÓ DESPUÉS (leer antes que la tabla de decisiones).** F8 está implementado
> (`frontend/src/lib/verso/collab/*` y `crdt/*`, `backend/src/routes/collab.ts` y
> `backend/src/core/collab-rooms.ts` + `collab-ops.ts`), y dos decisiones de abajo NO son las que
> shippearon:
>
> - **D13/D14 — el transporte.** No hay WebSocket ni dependencia `ws`: SSE + POST, que D14 reservaba
>   como fallback, es el ÚNICO transporte. Las rutas reales son
>   `GET /api/v1/collab/:postId/stream` (bajada) más `POST .../ops`, `.../presence`, `.../resync` y
>   `.../leave`. El cliente usa `EventSource` + `fetch` (`collab/transport.ts`): cero dependencias,
>   cero bundle, y una URL relativa que funciona igual en monolito, en modo separado y tras el
>   gateway.
> - **La bandera.** `COLLAB_DEFAULT_ON` en `frontend/src/lib/verso/collab/flag.ts` vale **`true`**:
>   nació apagada y se encendió tras cerrar los hallazgos del transporte y pasar el gate multinodo.
>   Se apaga sin recompilar con `NEXT_PUBLIC_WORDJS_COLLAB=off` o
>   `localStorage.wordjs_collab="off"`.
>
> Verificadas y vigentes: D15 (bus Redis, canal `wordjs:collab`), D16 (cookie + Origin +
> `capsForType`, sin modo lector), D17 (ingest saneado con `sanitizePuckTree`) y D18 (migración
> `0012_create_collab` con `collab_docs` + `collab_ops` — más una tabla `collab_members` que esta
> spec no previó, para liveness visible en el clúster). El resto del documento se conserva como el
> registro de las decisiones tal como se tomaron.
>
> **Fecha**: 2026-08-15 · **Rama**: `feat/verso-editor` · **Fase**: F8 (posterior a F7)
>
> **Regla dura del proyecto que gobierna todo el documento**: la implementación es **PROPIA**, pero
> el algoritmo es **PUBLICADO Y PROBADO**. Nada inventado. Cada pieza de §1 cita el paper del que
> sale y el gate que demuestra que nuestra implementación se comporta como el paper.

---

## 0. Resumen ejecutivo — tabla de decisiones

| # | Decisión | Qué se elige | Por qué (una línea) |
|---|---|---|---|
| **D1** | Algoritmo de lista (slots) | **FugueMax** (Weidner–Gentle–Kleppmann) | Única familia con *maximal non-interleaving* demostrada; RGA solo garantiza no-interleaving izquierda→derecha, YATA tiene esquinas (prepends) |
| **D2** | Una sola lista para dos usos | El mismo motor Fugue ordena **hijos de slot** y **átomos de texto** | El interleaving casi no duele en bloques y duele muchísimo en texto: un motor, dos usos, un solo cuerpo de tests |
| **D3** | Props de bloque | **LWW-map por CLAVE** con HLC + tiebreak `siteId` | Dos autores tocando `color` y `padding` del mismo bloque no se pisan |
| **D4** | Texto inline | **CRDT de secuencia por campo** (opción *a*) sobre los átomos que el motor inline YA produce; marcas **por átomo** con LWW-HLC | La opción *b* (LWW por campo) pierde una de las dos ediciones de un párrafo: inaceptable |
| **D5** | Marcas ricas | **Peritext** queda como techo (F8.7), NO en v1 | Aceptamos y documentamos una anomalía concreta (§1.4.3) a cambio de no duplicar el modelo de marcas |
| **D6** | Yjs | **NO se usa**, y el motivo NO es la licencia (es MIT) | Yjs se apropia del modelo de documento y pone en riesgo el round-trip byte-exacto de `_puck_data`; §1.5 da también el caso a favor |
| **D7** | Identidad de réplica | `siteId` **por sesión de edición** (por pestaña/carga), no por usuario | Dos pestañas del mismo autor SON dos réplicas |
| **D8** | Identidad de bloque | El CRDT **reutiliza `props.id`**; la posición es un id aparte | Un bloque se mueve: la posición no puede ser la identidad |
| **D9** | Reloj | **HLC** (Kulkarni et al.) solo para LWW; **nunca** para ordenar listas | Mezclar reloj y estructura es el error clásico de los CRDT caseros |
| **D10** | `moveNode` | Operación **primitiva** de move, no `remove`+`insert`; convergencia por el log de moves de Kleppmann (do/undo/redo) | `remove`+`insert` **duplica** bajo concurrencia (probado en la literatura) |
| **D11** | `replaceData` | **No es una op CRDT**: es un `docReset` que sube el `epoch` y reinicia la sala | Importar una plantilla entera no tiene intención concurrente preservable |
| **D12** | Invariante de serialización | El CRDT replica **también** los metadatos de forma (`keyOrder`, `topKeyOrder`, `extras`, `contentKeyState`, `zonesKeyPresent`, `orphanZones`, `rootKeyPresent`) | Sin ellos, el primer guardado colaborativo rompe el gate de round-trip **con el corpus real** |
| **D13** | Transporte | **WebSocket propio con `ws`** sobre el `http.Server` existente, ruta `/api/v1/collab` | El gateway ya proxya `upgrade` para prefijos `/api`; `socket.io` añade protocolo y bundle que no necesitamos |
| **D14** | Fallback | SSE + POST con **el mismo protocolo de mensajes**, degradado y explícito | WordPress 7.0 eligió polling como *default* por compatibilidad de hosting: tenerlo, pero no como primario |
| **D15** | Multinodo | Bus **Redis existente** (`cache.publish/subscribe`), canal `wordjs:collab`, filtrado por sala, eco propio descartado por `NODE_ID` | Verificado: el gateway hace **round-robin por cada upgrade** → NO hay sticky sessions y NO se puede asumir una sala = un nodo |
| **D16** | Autorización | Cookie `wordjs_token` + check de `Origin` + `capsForType()` del post; sin permiso ⇒ cierre `4403`, **sin modo lector en v1** | Reutilizar el gate de capabilities existente; no inventar un segundo modelo de permisos |
| **D17** | Sanitización | El **ingest** del servidor sanea con `sanitize-meta.ts` antes de reenviar **y** debe ser idempotente | El canal CRDT es una ruta de escritura nueva: si no sanea, es un bypass de XSS entre editores |
| **D18** | Persistencia | **Tabla dedicada** (`collab_docs` + `collab_ops`) por el runner de migraciones, id `0012_create_collab` | Precedente verificado: WordPress reusó tablas existentes para RTC y tuvo que migrar a tabla dedicada por inestabilidad |
| **D19** | GC de tombstones | **Sesión efímera**: sala vacía ⇒ proyectar a `_puck_data` ⇒ `epoch+1` ⇒ **descartar el estado CRDT entero** | GC total sin coordinación distribuida; evita el crecimiento sin techo de tombstones de los docs longevos |
| **D20** | Conflicto observable | **Nunca** creamos una copia "(Conflicto)" tipo Notion: rebase de ops pendientes + panel de "no se pudo reaplicar"; el fallback duro es una **revisión** | Un post tiene slug, SEO y revisiones: duplicarlo es peor que el conflicto |

**Coste honesto**: 28–40 días-persona (≈6–8 semanas de una persona) para F8.0–F8.6. Con Yjs +
`y-websocket` serían ~8–12 días. Esa diferencia **es** el precio de la regla de implementación propia,
y está escrita aquí para que se pague con los ojos abiertos.

---

## 1. Sustrato que ya existe (esto NO se re-hace)

El diseño de abajo está construido sobre piezas verificadas en el árbol, no sobre suposiciones:

| Pieza | Dónde | Lo que aporta al CRDT |
|---|---|---|
| Documento normalizado `VersoDoc` | `frontend/src/lib/verso/types.ts` L37–L106 | Mapa plano `id→VersoNode` con `parentId`/`slotKey`/`index`: **ya es la forma que un CRDT quiere** (sin árbol que recorrer) |
| Ids estables | `types.ts` L22–L26 (`props.id`), `commands.ts` `duplicateSubtree` con `idMap` | Identidad de nodo lista para reutilizar (**D8**) |
| `applyCommand` puro + inverso exacto | `commands.ts` L1–L14, L85–L140 (draft con estructura compartida) | La aplicación de ops remotas entra por el MISMO camino inmutable |
| Store transaccional | `store.ts` L180–L262 (`transact`), L46 (coalescencia 250 ms), L264–L303 (undo/redo por inversos) | Punto único de emisión de ops (nadie muta fuera de `transact`) |
| Round-trip byte-exacto | `normalize.ts` L129–L208 / L256–L287, `emitNodeProps` L217 | **El contrato inamovible**: el CRDT es canal, el snapshot manda (**D12**) |
| Motor inline por átomos | `inline-engine/model.ts` L108–L144 (`Atom`, `paraToAtoms`, `atomsToPara`) | 1 unidad = 1 átomo = **1 elemento de secuencia CRDT**: el granulado ya existe (**D4**) |
| Marcas | `model.ts` L31–L50 (`Marks{bold,italic,link}`) | Marcas ya viven **por átomo**: encaja con LWW por átomo sin cambiar la forma del dato |
| Servidor HTTP(S) | `backend/src/index.ts` L697 / L721 / L733 | Handle sobre el que montar `ws` sin abrir otro puerto |
| Bus Redis | `backend/src/core/cache.ts` L179–L253 (`publish`, `subscribe`, subscriber dedicado), L186 `redisConfigured()` | Fan-out multinodo ya probado (**D15**) |
| Patrón de eco propio | `backend/src/core/notifications.ts` L12 (`NODE_ID`), L52–L70 | Copiar tal cual: entrega local + publish etiquetado |
| SSE con cap por usuario | `backend/src/routes/notifications.ts` L14–L56 | Modelo de cap/keepalive/cierre a replicar en WS |
| Auth | `backend/src/middleware/auth.ts` L87/L257 (cookie `wordjs_token`), L286 `authenticateAllowQuery` | Handshake del WS (**D16**) |
| Capabilities por tipo | `backend/src/core/post-capabilities.ts` (`capsForType`) | Autorización de sala sin modelo nuevo |
| Sanitizador de `_puck_data` | `backend/src/core/sanitize-meta.ts` (`PUCK_HTML_FIELDS`, `PUCK_URL_FIELDS`) | Frontera de confianza del ingest (**D17**) |
| Runner de migraciones | `backend/src/core/schema-migrations.ts` (ids hasta `0011`, patrón `INT_PK`/`TS` L392) | Tabla nueva cross-driver (**D18**) |
| Gateway | `gateway/src/index.js` L1048 (`upgrade`), L851–L865 (`getTarget`, round-robin) | WS ya enrutado; **sin** afinidad de sesión (**D15**) |
| CSP | `frontend/next.config.ts` L66 (`connect-src … ws: wss:`) | No hay que tocar CSP para abrir el WS |
| Guardado actual | `frontend/src/app/admin/posts/[id]/page.tsx` L202–L255 | Camino de snapshot (`autosave:true` salta revisión) que reutiliza el flush de sala |

Dos hallazgos del sustrato que **condicionan el diseño** y por eso van arriba, no en un apéndice:

1. **El gateway hace round-robin en cada `upgrade`** (`getTarget` incrementa `group.index` por
   llamada). Dos editores de la misma página aterrizan en **réplicas distintas** por construcción.
   Cualquier diseño que asuma "una sala = un proceso" está muerto al nacer en multinodo.
2. **`sanitize-meta.ts` solo corre en la ruta de escritura de posts.** Un canal que reparta props de
   un cliente a otro sin pasar por ahí es un **bypass de sanitización**, es decir XSS de editor a
   editor dentro del admin. §4.5 lo cierra.

---

## 2. §1 — ALGORITMO

### 1.1 Listas de hijos (slots): RGA vs YATA vs Fugue

**El problema que decide la elección: interleaving.** Dos autores insertan concurrentemente en la
misma posición; al fusionar, el resultado puede **intercalar** carácter a carácter (o bloque a
bloque) lo que cada uno escribió, produciendo texto corrupto. Es un problema documentado que afecta
**tanto a CRDTs como a OT** y que pasó dos décadas sin nombrarse ([Weidner, Gentle, Kleppmann, *The
Art of the Fugue*](https://arxiv.org/abs/2305.00583), publicado además en IEEE TPDS, 2025).

Estado del arte, verificado (agosto 2026):

| Algoritmo | Garantía de no-interleaving | Coste/estado |
|---|---|---|
| **RGA** (Roh et al.) | Solo **izquierda→derecha**. Escribir "hacia atrás" (RtL / prepends repetidos) **sí** interleava | Simple, muy probado; tombstones permanentes |
| **YATA** (Nicolaescu et al. — el de Yjs) | Buena en el caso común, con **esquinas conocidas** (inserciones al principio de la lista / prepends) | Producción masiva (Yjs), muy optimizado |
| **Fugue** | No-interleaving razonable, más simple | Rendimiento comparable a Yjs según los benchmarks del paper |
| **FugueMax** | ***Maximal non-interleaving* demostrada** | Una condición extra por inserción sobre Fugue |

Y el resultado que cierra el debate: **no existe** un CRDT de lista "doblemente no-interleaving"
(que evite a la vez el interleaving LtR y RtL) — [Weidner, *There Are No Doubly Non-Interleaving
List CRDTs*](https://mattweidner.com/assets/pdf/List_CRDT_Non_Interleaving.pdf). Por tanto
*maximal non-interleaving* **es el techo alcanzable**, y FugueMax es la implementación publicada de
ese techo.

> **D1 — Se implementa FugueMax.** Elegir el techo demostrado cuesta *una comparación extra por
> inserción* frente a Fugue simple y *un puñado de reglas* frente a RGA. No hay motivo para elegir a
> sabiendas un algoritmo con una anomalía conocida cuando el reemplazo está publicado, probado y
> tiene implementaciones independientes de referencia (Loro implementa Fugue).

**Objeción honesta que hay que responder**: en una lista de **bloques**, ¿importa el interleaving?
Poco: es raro que dos autores inserten 5 bloques cada uno exactamente en la misma posición al mismo
tiempo, y si pasa, un intercalado de bloques es feo pero legible. Si la lista de slots fuera el único
uso, RGA bastaría.

> **D2 — Pero no es el único uso.** El texto inline (§1.4) necesita una secuencia CRDT de átomos, y
> ahí el interleaving **sí** produce texto ilegible. Implementar RGA para bloques y Fugue para texto
> serían dos motores, dos suites de tests y dos fuentes de bugs. Se implementa **un** motor de lista
> genérico `FugueList<T>` y se instancia dos veces. Esta es la razón decisiva de D1: no es que los
> bloques lo necesiten, es que el texto lo necesita y el código es compartido.

### 1.2 Estructura concreta de `FugueList<T>`

Fugue representa cada **posición** como un nodo de un árbol de posiciones. La posición es
independiente del valor: por eso el mismo motor sirve para bloques y para caracteres.

```
Posición  = { id: OpId, parent: OpId | ROOT, side: 'L' | 'R' }
OpId      = `${siteId}@${counter}`        // causal dot: único global, jamás reutilizado
Elemento  = { pos: OpId, value: T, deleted: boolean }   // deleted = tombstone
```

**Inserción entre dos posiciones vivas `a` (izquierda) y `b` (derecha)** — regla de Fugue
([Weidner, *Fugue: A Basic List CRDT*](https://mattweidner.com/2022/10/21/basic-list-crdt.html)):

```
createBetween(a, b):
  if a no es ancestro de b:  nueva posición = hijo DERECHO de a
  else:                      nueva posición = hijo IZQUIERDO de b
```

**Orden de la lista** = recorrido **in-order** del árbol: primero los hijos izquierdos de un nodo (en
orden), luego el nodo, luego los hijos derechos.

**Desempate entre hermanos** (mismo `parent`, mismo `side`): por el causal dot, comparando primero
`counter` y después `siteId` como cadena — **determinista y total**, que es lo único que la
convergencia exige.

**Condición extra de FugueMax**: cuando la regla anterior deja ambigüedad, se resuelve mirando el
*origen derecho* de la inserción además del izquierdo (`leftOrigin` decide el interleaving hacia
adelante; `rightOrigin` el de vuelta). Esa segunda condición es lo que convierte Fugue en FugueMax.

> **[ABIERTO-1] La formulación exacta de la condición de FugueMax y del desempate por lado se toma
> del paper §4, no de esta spec.** Este documento fija *qué* algoritmo, no re-deriva sus lemas. El
> criterio de cierre es objetivo y está en el gate G-F8.1-b: los escenarios de interleaving del
> paper (LtR, RtL, y el escenario que separa Fugue de FugueMax) se codifican como tests, y la
> implementación es correcta cuando los pasa. Si nuestra lectura del paper produce otro resultado
> que el esperado, **el test manda y el código se corrige** — jamás al revés.

**Tombstones**: borrar marca `deleted = true` y **conserva la posición** (la necesitan las
inserciones concurrentes que la referencian como origen). El crecimiento sin techo que esto implica
en documentos longevos se ataca en **D19** (§5.4), no aquí: nuestra sesión es efímera y el estado
CRDT se destruye al vaciarse la sala.

**Complejidad**: inserción y borrado O(log n) con el índice de posiciones ordenado; proyección a
array O(n) amortizada con caché por slot. Los slots de una página real tienen decenas de elementos;
el texto de un párrafo, cientos. No hay presión de rendimiento aquí — la presión está en el número
de ops de red, no en el árbol.

### 1.3 Props: LWW-map con reloj híbrido

Cada nodo (y la raíz) tiene un **mapa LWW por clave**:

```
PropEntry = { value: Json, hlc: HLC, site: siteId }
gana el mayor (hlc, site) en orden lexicográfico   // site solo desempata empates exactos de HLC
```

**Granularidad = clave, no nodo.** Un `setProps({ color, padding })` genera **dos** entradas. Dos
autores tocando propiedades distintas del mismo bloque **no se pisan**: es el caso frecuente
(alguien ajusta el espaciado mientras otro cambia el texto del botón) y resolverlo por nodo sería
tirar trabajo ajeno sin necesidad.

**Borrado de clave** (`patch[k] === undefined`, semántica ya existente en `SetPropsCommand`) es un
`propDelete` con su propio HLC: un *tombstone de clave*, porque "borrado" debe poder ganar a un
"escrito" anterior y perder contra uno posterior. Un mapa que solo guardase valores no sabría
distinguir "nunca existió" de "lo borré después de tu escritura".

**`id` nunca entra en el mapa.** `commands.ts` ya rechaza cambiarlo (`immutable-id`); el CRDT lo
trata como identidad, no como dato (**D8**).

**Reloj: HLC** (Kulkarni et al., *Logical Physical Clocks*), tupla `(wallMs, logical, siteId)` con
las reglas estándar de send/receive. Motivo frente a un Lamport puro: los valores de HLC quedan
**cerca del tiempo real**, lo que hace que "el último que escribió gana" signifique de verdad *el
último* aunque los relojes derrapen, y hace legibles los logs y el panel de conflictos. Motivo
frente al reloj de pared puro: un cliente con el reloj adelantado ganaría **todos** los conflictos
para siempre; HLC acota eso.

> **D9 — HLC solo para LWW. La lista NUNCA se ordena por tiempo.** El orden de la lista lo da el
> árbol de posiciones. Es el error clásico de los CRDT caseros: si el reloj toca la estructura, un
> reloj torcido reordena el documento.

### 1.4 Texto inline: la decisión que más importa

#### 1.4.1 Las dos opciones, sin adornos

**(a) CRDT de secuencia por campo de texto**: cada campo rico (`text`, `content`, `heading`…) es una
`FugueList<Atom>`. Dos autores escriben en el mismo párrafo y ambas ediciones sobreviven, fusionadas
carácter a carácter.
· Coste: una lista CRDT por campo de texto vivo, ops de grano fino (una por pulsación, coalescidas),
mapeo bidireccional con el modelo del motor inline.

**(b) LWW por campo**: el campo entero es un valor del mapa de props; gana el último HLC.
· Coste: ~30 líneas. Consecuencia: si dos personas escriben en el mismo párrafo, **una de las dos
ediciones se pierde entera**, en silencio, sin que el que la pierde vea nada raro hasta que relee.

#### 1.4.2 Recomendación honesta

> **D4 — Se implementa (a).** La opción (b) es indefendible como comportamiento por defecto de un
> editor colaborativo: el usuario que escribe un párrafo y ve cómo desaparece al pulsar guardar no
> tiene forma de distinguirlo de una pérdida de datos, y la pérdida de datos es la línea que este
> proyecto no cruza. (b) queda **solo** para props escalares no textuales (§1.3), donde "el último
> gana" **es** la intención esperada (un color no se "fusiona").

Y hay un motivo técnico que abarata (a) enormemente y que sale del sustrato:
`inline-engine/model.ts` **ya trabaja en átomos** — `paraToAtoms` (L114) descompone el párrafo en
unidades de 1 code unit (o 1 `br`) **con sus marcas**, y `atomsToPara` (L129) las re-normaliza a
runs. Ese es **exactamente** el granulado que la secuencia CRDT necesita. El mapeo es:

```
Átomo del motor inline  ≡  elemento de FugueList<Atom>
posición del CRDT       ≡  identidad estable del átomo (sobrevive a inserciones ajenas)
offset UTF-16 del motor ≡  índice en la proyección viva (se recalcula, nunca se transmite)
```

No hay que reescribir el motor inline: hay que **envolverlo**. La proyección
`FugueList<Atom> → Atom[] → atomsToPara → serialize()` produce el HTML canónico que hoy ya se
guarda; el serializador sigue siendo la única autoridad de forma.

#### 1.4.3 Marcas: por átomo con LWW, y la anomalía que aceptamos

Las marcas (`bold`, `italic`, `link`) viven **en el átomo** (`Marks` en `model.ts` L31). Se replican
como un LWW-HLC por (átomo × marca).

Esto converge y cubre el caso natural: el texto insertado hereda las marcas del punto de inserción
(que es lo que el motor ya hace localmente). **La anomalía que compramos**, y que se documenta en la
UI y aquí en vez de esconderse:

> **"Agujero de negrita"**: A pone en negrita el rango `[0..10]` mientras B, que aún no ha recibido
> esa op, escribe texto *dentro* de ese rango. El texto de B nace sin negrita y queda como un hueco
> sin formato dentro del rango en negrita. Converge (todas las réplicas ven el mismo hueco), no
> pierde texto, pero no es la intención.

La solución publicada a esto es **Peritext** ([Litt, Lim, Kleppmann, van Hardenberg, CSCW 2022](https://www.inkandswitch.com/peritext/)),
que ancla las marcas a *spans* con identidades de carácter inicial/final y semántica de expansión,
de modo que el texto insertado dentro del span **hereda** la marca aunque venga de una réplica que no
la había visto.

> **D5 — Peritext NO entra en v1; queda como F8.7 con disparador escrito.** Motivo: Peritext es un
> segundo modelo de marcas (spans anclados) que convive mal con las marcas-por-átomo que el motor
> inline ya usa en TODO el editor, y su coste (formalizar expand/no-expand por tipo de marca,
> resolución de solapes) es comparable al del resto de F8. Disparador para hacerlo: si en uso real
> aparecen ≥3 reportes de "agujero de negrita" o si se añaden marcas nuevas con semántica de rango
> (comentarios, sugerencias) — ahí Peritext deja de ser lujo y pasa a ser requisito, porque un
> comentario **es** un span.

### 1.5 Por qué NO Yjs (y en qué mundo SÍ sería lo sensato)

Empecemos por lo que **no** es un argumento: la licencia. Yjs es **MIT**; no hay ningún bloqueo legal,
y este proyecto acaba de pasar por una limpieza de licencia (F5) precisamente para no volver a
depender de un fork ajeno. Decir "no usamos Yjs por la licencia" sería falso.

**El caso A FAVOR de Yjs, dicho en serio:**
- Es el estándar de facto, con años de producción, `y-protocols` (awareness/sync ya resueltos),
  `y-websocket`, persistencia (`y-leveldb`, `y-indexeddb`) y un formato binario muy compacto.
- **WordPress 7.0 eligió Yjs** para la colaboración en tiempo real del block editor
  ([Make WordPress Core, Phase 3](https://make.wordpress.org/core/2025/11/06/update-on-phase-3-2025/)):
  nuestro competidor directo resolvió este problema comprando la librería, no escribiéndola.
- Ahorraría ~5 semanas de las 6–8 estimadas.

**El caso EN CONTRA, en nuestro contexto concreto:**

1. **El contrato de persistencia.** Nuestra verdad es `_puck_data` **byte-exacto** (`normalize.ts`),
   con detalles que ningún modelo genérico expresa: orden original de claves top-level
   (`topKeyOrder` — los docs reales guardan `root` antes que `content`), `contentKeyState: "absent"`
   (revisiones reales sin la clave `content`), `extras` verbatim, `orphanZones`, `keyOrder` por
   ítem. Proyectar un `Y.Doc` a esa forma exige una capa de mapeo bidireccional **tan grande como el
   CRDT** y con un modo de fallo peor: cuando falle, falla el gate de round-trip sobre el corpus de
   producción, es decir, ensucia el `_puck_data` de páginas reales. Con motor propio, la forma es un
   dato de primera clase del CRDT (**D12**) en vez de una traducción.
2. **Opacidad frente a nuestras herramientas.** Nuestras ops tienen que pasar por `sanitize-meta.ts`
   en el ingest (**D17**) y ser auditables. Un update de Yjs es un blob binario: sanear "el valor de
   un campo HTML dentro de un update binario" implica decodificar, mutar y recodificar con la
   librería — posible, pero convierte una frontera de seguridad en un ejercicio de ingeniería
   inversa sobre un formato que no controlamos.
3. **Presupuesto de bundle.** El First-Load público se peleó de 375 KB a 217 KB gz. `yjs` +
   `y-websocket` + `y-protocols` añaden ~90–120 KB min al admin. Es admin, no público — pero es un
   coste real que un motor a medida (solo lo que usamos: lista + mapa + presencia) no paga.
4. **Interleaving.** Yjs es YATA, con las esquinas conocidas de §1.1. Si escribimos motor propio, la
   elección racional es el algoritmo *sin* esas esquinas.
5. **La regla del proyecto**: implementación propia. Es una restricción de producto, y se declara
   como tal, no se disfraza de argumento técnico.

**En qué mundo cambiaría la decisión** (dicho para que la decisión sea revisable, no dogma): si
mañana el requisito fuese colaboración **P2P sin servidor**, o documentos **longevos** con historia
completa preservada (sesión no efímera, lo que rompe D19), o interoperar con un ecosistema de
editores que ya hablan Yjs, la balanza se invertiría: ahí Yjs no es un atajo, es la arquitectura
correcta, y esta spec debería reescribirse en vez de forzarse.

---

## 3. §2 — IDENTIDAD Y CAUSALIDAD

### 2.1 `siteId`

```
siteId = 's_' + base32(crypto.getRandomValues(10 bytes))   // 16 chars
```

- **Una por sesión de edición** (por carga del editor), **no** por usuario ni por dispositivo: dos
  pestañas del mismo autor son dos réplicas que pueden divergir y deben poder desempatar entre sí
  (**D7**).
- **No se deriva del `userId`**: (i) evita colisión entre pestañas; (ii) el `siteId` viaja en cada
  op y acaba en la BD — no queremos un identificador de usuario incrustado en cada posición del
  documento para siempre.
- **Vida**: una recarga de página genera un `siteId` NUEVO. Una **reconexión** dentro de la misma
  carga **conserva** `siteId` y `counter` (están en memoria). Reutilizar un `siteId` con el contador
  reiniciado rompería la unicidad de `(siteId, counter)` — de ahí que no se persista en
  `sessionStorage`.
- El servidor **no confía** en el `siteId` que el cliente declara: lo registra por conexión y
  **rechaza** ops cuyo `siteId` no sea el de la conexión (evita que un cliente falsifique ops
  atribuidas a otro).

### 2.2 Contador lógico y `OpId`

```
OpId = `${siteId}@${counter}`     // counter monótono por sitio, empieza en 1
```

Es el **causal dot** de Fugue (identidad de posición) y a la vez el identificador de la op para
deduplicación e idempotencia (reenviar una op ya aplicada es un no-op exacto).

### 2.3 HLC

```
HLC = { wall: number(ms), l: number, site: siteId }

send():      l' = max(l, now());  c' = (l' === l) ? c+1 : 0
receive(m):  l' = max(l, m.l, now());
             c' = (l'===l===m.l) ? max(c, m.c)+1 : (l'===l) ? c+1 : (l'===m.l) ? m.c+1 : 0
compare(a,b) = (a.l,a.c,a.site) lexicográfico
```

Se usa **exclusivamente** para el LWW de props y de marcas (**D9**).

### 2.4 Orden y detección de concurrencia

- Cada réplica mantiene un **version vector** `VV: siteId → maxCounter`.
- Una op `o` es **causalmente lista** si todas sus dependencias explícitas están presentes:
  el nodo destino existe, y las posiciones `leftOrigin` / `rightOrigin` que referencia están en el
  árbol de posiciones (vivas o tombstone). Si no, va a un **buffer causal** indexado por la
  dependencia que falta y se aplica en cuanto llega.
- Dos ops son **concurrentes** si ninguna está en el VV que la otra llevaba al emitirse. Se
  transmite el VV comprimido (solo los sitios de la sala) en el mensaje `hello` y en los `resync`,
  no en cada op: en régimen normal el servidor entrega en orden y el buffer no se activa.
- **Hueco detectado** (llega `s@7` sin haber visto `s@6`): el cliente pide `resync` desde su VV; el
  servidor responde con las ops que faltan desde `collab_ops` o, si ya se compactaron, con un
  `snapshot` completo del estado CRDT y el VV correspondiente.
- **El servidor NO es un relay tonto**: valida, sanea (**D17**), asigna número de secuencia por sala
  y persiste. Eso da un **orden total por sala** que hace que el buffer causal sea, en la práctica,
  un mecanismo de reconexión y offline — no del camino caliente.

### 2.5 `props.id` es la identidad (D8), y qué pasa con las colisiones

```
nodeId  = props.id             // ya estable, ya generado con crypto.randomUUID en la inserción
posId   = OpId                 // la POSICIÓN del nodo en el slot de su padre
```

Separarlos es obligatorio: un bloque **se mueve** y debe conservar su identidad (para que las
ediciones de props/texto concurrentes con el move sigan aplicándose) mientras cambia de posición.

**Colisiones de `nodeId`** (dos réplicas insertan bloques con el mismo `props.id`: copiar-pegar entre
pestañas, import de una plantilla, o el `#dupN` que `normalize.ts` L64–L78 ya documenta como dato
corrupto real):

- Regla determinista y **local a cada réplica pero igual en todas**: al aplicar un `nodeCreate` cuyo
  `nodeId` ya existe con **distinto** `OpId` de creación, el nodo entrante se rebautiza
  `${nodeId}~${primeros 6 de siteId del creador}`. Es función pura de `(nodeId, OpId)` ⇒ todas las
  réplicas calculan el mismo nombre ⇒ converge.
- Se emite un `warning` al doc (mismo canal que los `warnings` de `normalize.ts`) y **no** se rompe
  nada: `props.id` real del ítem se reescribe al nuevo valor en la proyección, porque un
  `_puck_data` con dos bloques del mismo id ya es dato corrupto hoy.
- `duplicateSubtree` **no** depende de esta red de seguridad: el `idMap` lo genera **el emisor**
  (`commands.ts` ya materializa el `idMap` en el comando efectivo) y viaja explícito en las ops.

---

## 4. §3 — MAPEO comando → operación CRDT

### 3.1 Catálogo de operaciones (el "assembly" del canal)

```ts
type CollabOp =
  | { k:'nodeCreate';  id:OpId; nodeId:string; type:string; props:Record<string,Json>;
                       keyOrder?:string[]; extras?:Record<string,Json>; hlc:HLC }
  | { k:'listInsert';  id:OpId; parentId:string; slotKey:string;
                       left:OpId|'BEGIN'; right:OpId|'END'; nodeId:string }
  | { k:'listMove';    id:OpId; nodeId:string; toParentId:string; toSlotKey:string;
                       left:OpId|'BEGIN'; right:OpId|'END'; hlc:HLC }
  | { k:'nodeDelete';  id:OpId; nodeId:string; hlc:HLC }
  | { k:'propSet';     id:OpId; nodeId:string|ROOT; key:string; value:Json; hlc:HLC }
  | { k:'propDelete';  id:OpId; nodeId:string|ROOT; key:string; hlc:HLC }
  | { k:'textInsert';  id:OpId; nodeId:string; field:string;
                       left:OpId|'BEGIN'; right:OpId|'END'; atom:{br:boolean; ch:string; marks:Marks} }
  | { k:'textDelete';  id:OpId; nodeId:string; field:string; pos:OpId }
  | { k:'markSet';     id:OpId; nodeId:string; field:string; pos:OpId;
                       mark:'bold'|'italic'|'link'; value:boolean|LinkAttrs|null; hlc:HLC }
  | { k:'shapeSet';    id:OpId; key:ShapeKey; value:Json; hlc:HLC }   // metadatos de forma — §3.4
  | { k:'docReset';    id:OpId; epoch:number; snapshotHash:string }   // §3.3
```

Las ops de una misma transacción viajan en **un frame** con el mismo `txId` y se aplican como una
unidad en el receptor (no atómica en el sentido CRDT — cada op converge sola — pero sí para el
render y para el resaltado de "quién cambió qué").

### 3.2 Los 7 `VersoCommand`, uno a uno

| Comando (`types.ts` L121–L174) | Ops emitidas | Notas de convergencia |
|---|---|---|
| `insertNode` | `nodeCreate` + `listInsert` | El `index` del comando se traduce a `(left,right)` **leyendo la lista viva**: nunca se transmite un índice, siempre posiciones. Un índice concurrente es lo que produce el interleaving que D1 evita |
| `moveNode` | `listMove` (**primitiva**) | §3.2.1 |
| `removeNode` | `nodeDelete` | §3.2.2 |
| `setProps` | `propSet` × claves definidas + `propDelete` × claves `undefined` | Excepto campos de texto rico ⇒ van por `textInsert/textDelete/markSet` (§3.2.3) |
| `setRootProps` | `propSet`/`propDelete` con `nodeId = ROOT_ID` | El mapa LWW de la raíz cubre título, slug, plantilla y SEO: "el último gana" **por clave** es exactamente la intención |
| `duplicateSubtree` | Se **expande** en el emisor a N × (`nodeCreate` + `listInsert`) con el `idMap` ya materializado | No es una op CRDT: duplicar no tiene semántica concurrente propia. `applyCommand` ya devuelve el comando efectivo con `idMap` resuelto — encaje exacto con el sustrato |
| `replaceData` | `docReset` | §3.3 — **el único que no se expresa como CRDT** |

#### 3.2.1 `moveNode`: por qué es primitiva

Traducir un move a `remove` + `insert` es la tentación obvia y es un **error publicado**: bajo
concurrencia produce **duplicación** del elemento (una réplica ve el borrado y la reinserción en
orden distinto que otra) — ver [*Extending JSON CRDTs with Move Operations*](https://arxiv.org/pdf/2311.14007).
Por eso:

- **Un nodo tiene exactamente una posición viva.** `listMove` cambia esa posición; la anterior queda
  como tombstone.
- **Moves concurrentes del mismo nodo**: gana el de mayor `(hlc, site)`. El otro no duplica nada:
  simplemente deja de ser la posición viva.
- **Ciclos** (mover A dentro de su propio descendiente concurrentemente con mover ese descendiente
  dentro de A): descartar "el que crea ciclo al llegar" **no converge**, porque depende del orden de
  entrega. Se implementa la solución publicada y verificada en Isabelle/HOL:
  [Kleppmann et al., *A highly-available move operation for replicated trees*](https://martin.kleppmann.com/papers/move-op.pdf) —
  un **log de moves ordenado por HLC** con la disciplina *undo → apply → redo*: al llegar un move con
  timestamp anterior a moves ya aplicados, se deshacen los posteriores, se aplica el nuevo
  (descartándolo **si y solo si** crea ciclo en ese estado) y se rehacen los demás.
- **Coste acotado y por eso aceptable**: el log contiene **solo moves**, no todas las ops. En una
  sesión de edición real los moves son decenas, no miles; y el log se trunca en cada snapshot
  (**D19**). Es la diferencia entre "replay de todo el historial" (inviable) y "replay de los últimos
  N moves" (trivial).

#### 3.2.2 `removeNode`: borrado NO recursivo

`nodeDelete(nodeId)` marca **solo** ese nodo. Los descendientes quedan vivos pero **no alcanzables**
desde la raíz, y por tanto no se renderizan ni se serializan.

Motivo: si el borrado fuera recursivo y otra réplica hubiera **sacado un hijo** del subárbol
concurrentemente (`listMove` a otro padre), el borrado recursivo lo mataría **después** de haberlo
salvado — destruyendo trabajo que el usuario movió explícitamente para conservarlo. Con borrado
no recursivo, el hijo movido reaparece en su nuevo padre: la intención de ambos se preserva.

Los nodos huérfanos (no alcanzables) se recolectan en el snapshot (§5.4), que es cuando ya no puede
llegar un move que los rescate.

#### 3.2.3 Campos de texto rico

Un `setProps` cuya clave esté en el conjunto de campos ricos del bloque (el mismo criterio que
`sanitize-meta.ts` usa en `PUCK_HTML_FIELDS`, resuelto por el **registry** del bloque, no por el
nombre a ciegas) **no** se convierte en `propSet`. Se difiere al canal de texto:

- Mientras el campo está en edición inline (`inlineEditingId` del store, `types.ts` L216), las
  pulsaciones producen `textInsert`/`textDelete`/`markSet` con la coalescencia que ya existe
  (250 ms, `store.ts` L46) aplicada al **envío**, no a la generación (las ops se generan por átomo;
  se agrupan por frame de red).
- Al salir de edición (`commitInline`), la proyección canónica se guarda en la prop como siempre.
- **Un campo rico que se toca fuera del editor inline** (p. ej. desde un campo lateral que pega HTML
  entero) se trata como un **reemplazo**: `textDelete` de todo lo vivo + `textInsert` del nuevo
  contenido, en una transacción. Converge y es honesto: pegar un HTML entero **es** reemplazar.

### 3.3 `replaceData`: el comando que no es CRDT (D11)

`replaceData` sustituye el documento entero (import de JSON, aplicar plantilla). No existe una
fusión con sentido entre "he reemplazado el documento" y "he cambiado el padding de este bloque".

**Qué se hace**: el emisor envía `docReset { epoch: E+1, snapshotHash }` junto con el
`_puck_data` completo por el canal HTTP normal (con su sanitización y su revisión). El servidor:

1. Persiste el nuevo snapshot canónico.
2. Incrementa el `epoch` de la sala y **descarta el estado CRDT**.
3. Difunde `roomReset` a todos los clientes.

Los demás clientes muestran un aviso **modal** ("*Fulanita reemplazó el contenido de la página*") y
recargan el documento desde el snapshot. Sus ops en vuelo del epoch viejo se **rechazan** (`4409`) y
entran en el flujo de reconciliación de §6.4 — es decir, no se pierden en silencio: o se rebasan o
se ofrecen como revisión.

Requiere `edit` **y** ser un acto explícito del usuario (no hay `replaceData` automático). En la UI,
el botón que lo dispara avisa de que hay N personas en la sala antes de ejecutarlo.

### 3.4 EL INVARIANTE: `_puck_data` sigue siendo byte-exacto (D12)

> **El CRDT es el CANAL. El snapshot manda en la BD.** El estado CRDT nunca se persiste como verdad
> del contenido: se persiste como *estado de sesión* (§5). La verdad es y sigue siendo
> `meta._puck_data`, producido por `fromNormalized`.

Para que la proyección `estado CRDT → VersoData` sea **byte-exacta**, el CRDT debe replicar también
los metadatos de forma que `normalize.ts` conserva. Esto **no es un detalle**: el corpus de
producción tiene documentos con `content` **ausente** y con `root` **antes** que `content`
(`types.ts` L89–L101). Un CRDT que solo replique "los bloques" reordenaría claves y materializaría
claves ausentes **en el primer guardado colaborativo**, ensuciando el diff de revisiones de páginas
reales aunque el deep-equal pasara.

Se replican como entradas `shapeSet` en un mapa LWW a nivel de documento:

| Clave de forma | Origen | Semántica concurrente |
|---|---|---|
| `topKeyOrder` | `VersoDoc.topKeyOrder` | LWW (cambia solo en `replaceData`, que ya resetea) |
| `contentKeyState` | `VersoDoc.contentKeyState` | LWW; una inserción real lo promueve a `"array"` de forma monótona |
| `rootKeyPresent`, `zonesKeyPresent` | idem | LWW monótono (una vez true, no vuelve) |
| `extras` | `VersoDoc.extras` | LWW **por clave** (mismo mapa que props) |
| `orphanZones` | `VersoDoc.orphanZones` | LWW por clave compuesta; **nadie las edita**, viajan para no perderse |
| `keyOrder` por nodo | `VersoNode.keyOrder` | Va en el `nodeCreate`; un `propSet` de clave nueva **no** lo altera (`emitNodeProps` ya emite las nuevas al final) |
| `extras` por nodo | `VersoNode.extras` | En el `nodeCreate`, LWW por clave después |

**Gate G-F8.1-c (el gate que puede cancelar la fase)**: para cada documento del corpus de producción
usado en `verso-roundtrip.test.ts`:

```
data → toNormalized → toCrdt → (0 ops) → fromCrdt → fromNormalized  ⇒  JSON.stringify idéntico
```

y la versión con ruido: aplicar K ops aleatorias en 2 réplicas en órdenes distintos ⇒ **misma**
serialización en ambas. Si este gate no pasa, F8 no avanza: el canal no puede ensuciar el snapshot.

### 3.5 Integración con el store: cómo entran las ops remotas

- **Salida**: `transact()` sigue siendo el único camino de escritura. Se le añade un *sink*: cada
  comando efectivo se traduce a ops y se encola para el envío. Traducir **el comando efectivo**
  (índices clampados, `idMap` materializado — `ApplyCommandResult.command`) y no el comando crudo es
  obligatorio para que emisor y receptor apliquen lo mismo.
- **Entrada**: `applyRemote(ops)` proyecta el estado CRDT y produce un `VersoDoc` nuevo por el
  **mismo** camino inmutable, **sin** crear entrada de historia (una op remota no es un undo tuyo) y
  **sin** romper la coalescencia local en curso.
- **Invariante que ya existe y se conserva**: el DnD y la UI **solo emiten comandos**. El CRDT vive
  por debajo. Un fallo del canal no puede corromper el documento porque no puede mutarlo: solo puede
  emitir comandos que `applyCommand` valida.
- **Selección y cursor**: `rebuildState()` (`store.ts` L139–L144) ya limpia referencias a nodos
  desaparecidos. Con ops remotas eso pasará de vez en cuando; la UI debe avisar (§6.2) en vez de que
  la selección desaparezca en silencio.

---

## 5. §4 — TRANSPORTE

### 4.1 `ws` vs `socket.io` vs SSE+POST

| Criterio | `ws` | `socket.io` | SSE + POST |
|---|---|---|---|
| Bidireccional real | Sí | Sí | No (dos canales, latencia de ida por POST) |
| Bundle cliente | **0** (API nativa `WebSocket`) | ~40 KB min | 0 |
| Protocolo | Estándar, depurable con devtools | Propio sobre WS | Estándar |
| Rooms / fan-out | A mano (~80 líneas) | Incluido, pero atado a su Redis adapter | A mano |
| Multinodo | Nuestro bus Redis existente | Requiere `@socket.io/redis-adapter` (otra dep, otra semántica) | Nuestro bus |
| Compatibilidad hosting | Buena; el gateway ya proxya `upgrade` | Igual + fallback polling | Máxima |
| Deps nuevas | **1** (`ws`, sin deps transitivas) | 3–4 | 0 |

> **D13 — `ws`**, montado sobre el `http.Server`/`https.Server` que ya existe
> (`backend/src/index.ts` L697/L721), en `/api/v1/collab`. El prefijo `/api` importa: el handler
> `upgrade` del gateway (`gateway/src/index.js` L1048) resuelve por prefijo con `getTarget`, así que
> **no hay que tocar el gateway**. La CSP ya permite `ws:`/`wss:` (`frontend/next.config.ts` L66).
>
> Se rechaza `socket.io`: sus dos ventajas (rooms y reconexión) son ~120 líneas nuestras que además
> tienen que hablar con **nuestro** bus Redis; a cambio mete un protocolo propio entre nosotros y el
> problema, justo donde vamos a depurar convergencia.

> **D14 — Fallback SSE+POST**, con **el mismo protocolo de mensajes** (`GET /api/v1/collab/stream`
> + `POST /api/v1/collab/push`), activado automáticamente si el `upgrade` falla dos veces. Motivo
> para no despreciarlo: WordPress 7.0 eligió **HTTP polling como proveedor por defecto**
> ([PR #74564](https://github.com/WordPress/gutenberg/pull/74564)) precisamente porque el hosting
> compartido rompe WebSockets. Nosotros nos desplegamos en Proxmox/nginx propios, así que WS es el
> primario; el fallback existe para el usuario que no controla su proxy. La UI **dice** cuando está
> degradada (latencia visible), no lo esconde.

### 4.2 Protocolo de mensajes

```
C→S  hello    { postId, epoch, vv, siteId, clientVersion }
S→C  welcome  { epoch, snapshot|ops, vv, members[], serverTime }   // serverTime = semilla HLC
C→S  ops      { txId, ops[] }
S→C  ops      { txId, ops[], from:siteId, seq }                    // seq = orden total por sala
C→S  presence { sel:{nodeId|null, field?, anchor?:OpId, focus?:OpId} }   // coalescido a 50 ms
S→C  presence { siteId, userId, name, color, sel, at }
S→C  members  { joined|left: {siteId,userId,name} }
C→S  resync   { vv }
S→C  snapshot { epoch, state, vv }
S→C  roomReset{ epoch, reason:'replaceData'|'restoredRevision'|'externalWrite' }
S→C  error    { code, message }     // 4403 sin permiso · 4409 epoch viejo · 4429 rate limit
```

Frames JSON en v1 (depurables, saneables, y el volumen real es pequeño: una op de texto son ~120
bytes). **[ABIERTO-2]** compresión/binario: se decide con la métrica de F8.6 (bytes/minuto por
editor en una sesión real de 3 personas); umbral para actuar: >50 KB/min sostenido por cliente.

### 4.3 Multinodo (D15)

**Hecho verificado que manda aquí**: `getTarget` (`gateway/src/index.js` L851–L865) devuelve
`final[group.index % final.length]` e **incrementa `group.index` en cada llamada**, incluida la del
handler `upgrade`. Con 2 backends, dos editores de la misma página caen en **réplicas distintas**.
No hay afinidad de sesión y **no se va a introducir** (sería una regresión de disponibilidad: caer un
nodo tiraría sesiones enteras).

Diseño:

```
cliente A ─ws─→ backend#1 ─┐                           ┌─→ backend#1 ─ws─→ cliente A
                           ├─ Redis  wordjs:collab ────┤
cliente B ─ws─→ backend#2 ─┘   (payload lleva NODE_ID) └─→ backend#2 ─ws─→ cliente B
```

- **Entrega local primero, publish después**, con el payload etiquetado con `NODE_ID` para que el
  emisor descarte su propio eco. Es **exactamente** el patrón que `core/notifications.ts` (L12,
  L52–L70) ya usa en producción; se copia, no se reinventa.
- **Un canal único `wordjs:collab`** con el `postId` en el payload y filtrado local por sala, en v1.
  Motivo: `cache.ts` expone `subscribe(channel, handler)` sobre **una** conexión subscriber
  compartida (L235–L253), sin `unsubscribe` ni patrones; un canal por página exigiría extender ese
  módulo. El coste del canal único es tráfico cruzado (un nodo recibe ops de páginas que no tiene
  abiertas) — **medible** y despreciable con pocas salas.
  **[ABIERTO-3]**: si en F8.6 se mide >200 mensajes/s cruzados descartados por nodo, se extiende
  `cache.ts` con `subscribe/unsubscribe` dinámico y se pasa a `wordjs:collab:<postId>`.
- **El bus no garantiza orden entre nodos** — y el CRDT no lo necesita, esa es su gracia. El `seq`
  por sala lo asigna el nodo que persiste la op; los huecos los detecta el cliente por su VV y los
  cierra con `resync`.
- **Sin Redis** (mono-nodo/SQLite): fan-out en memoria. La colaboración **multinodo requiere Redis**,
  igual que el resto del multinodo (`documentation/multi-node.md`). Si `redisConfigured()` es falso y
  hay >1 backend registrado, el servidor **rechaza** abrir salas con un error explícito en vez de
  dar una colaboración silenciosamente rota — regla del proyecto: nunca degradar en silencio.
- **Persistencia como árbitro**: toda op se escribe en `collab_ops` (§5) **antes** de difundirse. Un
  nodo que se cae no pierde ops confirmadas; un cliente que reconecta a **otro** nodo recupera por
  `resync` desde la BD compartida.

### 4.4 Autorización del handshake (D16)

El navegador **no puede** poner cabeceras en `new WebSocket()`. Por tanto:

1. **Cookie `wordjs_token`** (HttpOnly, same-origin: el navegador la envía en el `upgrade`). Se
   verifica con el mismo `jwt.verify` del middleware (`auth.ts` L100/L357).
2. **Check de `Origin`** contra `siteUrl` — **obligatorio**: el navegador envía cookies también en
   upgrades cross-origin, así que sin este check el WS es un agujero CSRF (un sitio hostil abriría
   una sesión de edición con las credenciales de la víctima). Origin ausente o distinto ⇒ `4403`.
3. **Capability por post**: se carga el post, se resuelve la familia con
   `capsForType(post.type)` (`core/post-capabilities.ts`) y se exige `edit` (+ `editOthers` si el
   usuario no es el autor). **No se inventa un permiso nuevo**: si puedes editar el post por HTTP,
   puedes entrar en su sala; si no, no.
4. **Sin permiso ⇒ cierre `4403` antes de unirse.** **No hay modo lector en v1** (D16): un lector
   consumiría contenido en borrador por un canal que no pasa por los mismos filtros de la ruta de
   lectura, y su presencia filtraría "quién está editando qué" a quien no puede editar. Es superficie
   que no vamos a defender en v1.
5. **Límites** (mismo espíritu que el cap de SSE en `routes/notifications.ts` L28–L31):
   - máx. 3 conexiones por (usuario × post), 10 por usuario, N global configurable;
   - máx. 50 ops/s y 64 KB/s por conexión ⇒ `4429` y cierre al tercer aviso;
   - máx. tamaño de frame 256 KB; máx. nodos por documento (ya implícito) y máx. átomos por campo.
6. **El `siteId` se ata a la conexión** (§2.1): ops con otro `siteId` ⇒ cierre inmediato.

### 4.5 Sanitización en el ingest (D17) — la parte de seguridad que no se puede omitir

`sanitize-meta.ts` sanea `_puck_data` **en la ruta de escritura de posts**. El canal CRDT es una
**ruta de escritura nueva** que reparte valores de un cliente a otros y los pinta en el canvas del
editor. Sin sanear:

> Un cliente hostil (o una pestaña comprometida por XSS) emite `propSet(nodeId, 'text', '<img
> src=x onerror=…>')`; el servidor lo reenvía tal cual; el canvas del otro editor lo renderiza
> **dentro del admin autenticado**. El sanitizado del guardado llega tarde: el script ya corrió.

**Decisión**: el servidor sanea en el ingest, con el **mismo módulo**, antes de persistir y antes de
difundir. Los campos URL con `safePuckUrl`, los HTML con `sanitize`.

**Condición de corrección que esto impone**: la sanitización debe ser **idempotente y estable** —
si dos nodos sanean el mismo valor y obtienen resultados distintos (o si sanear dos veces cambia el
valor), las réplicas divergen. Por eso:

- **Gate G-F8.3-c**: `sanitize(sanitize(x)) === sanitize(x)` para todo `x` del corpus de producción
  y del corpus de fuzzing de F6. Si falla para alguna entrada, esa entrada se saneará **una sola vez
  en el ingest** y el valor saneado es el que viaja (nunca se re-sanea al recibir).
- El texto inline viaja como **átomos** (`ch` de 1 code unit + marcas), no como HTML: ahí no hay
  nada que sanear salvo el `href` de una marca `link` (`safePuckUrl`) y el tipo de las marcas. Esto
  reduce muchísimo la superficie: el HTML solo se materializa en la **proyección**, con el
  serializador canónico que ya existe.

---

## 6. §5 — PERSISTENCIA

### 5.1 Dónde vive el estado (D18) — con el precedente en la mano

WordPress construyó su RTC reusando tablas existentes (meta) y **tuvo que migrar a una tabla
dedicada** por bugs de invalidación de caché e inestabilidad — la propuesta de una tabla
`wp_collaboration` salió precisamente de esos fallos
([Trac #64622](https://core.trac.wordpress.org/ticket/64622),
[Phase 3 update](https://make.wordpress.org/core/2025/11/06/update-on-phase-3-2025/),
[cobertura](https://www.searchenginejournal.com/wordpresss-troubled-real-time-collaboration-feature/571201/)).

Nosotros vamos **directos a tabla dedicada**, y además tenemos razones propias para no tocar
`post_meta`: nuestra meta pasa por `sanitize-meta`, por el caché de opciones/posts, por las
revisiones y por el `merge por clave` del backend. Meter un blob de estado CRDT que cambia 20 veces
por segundo por ese camino invalidaría caché de contenido público y generaría revisiones basura.

### 5.2 Esquema (migración `0012_create_collab`)

Siguiendo el patrón cross-driver del runner (`INT_PK`/`TS`, `TEXT` para JSON, registro en
`LONG_TEXT_COLUMNS` de `mysql.ts` para las columnas grandes):

```sql
CREATE TABLE IF NOT EXISTS collab_docs (
  post_id      INTEGER PRIMARY KEY,
  epoch        INTEGER NOT NULL DEFAULT 1,
  state        TEXT    NOT NULL DEFAULT '',   -- snapshot del estado CRDT (JSON, base64 si se comprime)
  state_seq    INTEGER NOT NULL DEFAULT 0,    -- última op incluida en `state`
  vv           TEXT    NOT NULL DEFAULT '',   -- version vector del snapshot
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  flushed_at   TIMESTAMP,                     -- último volcado confirmado a _puck_data
  members      INTEGER NOT NULL DEFAULT 0     -- conexiones vivas (contador cooperativo)
);

CREATE TABLE IF NOT EXISTS collab_ops (
  id        <INT_PK>,
  post_id   INTEGER NOT NULL,
  epoch     INTEGER NOT NULL,
  site_id   TEXT    NOT NULL,
  counter   INTEGER NOT NULL,
  seq       INTEGER NOT NULL,      -- orden total por sala (asignado por el nodo que persiste)
  kind      TEXT    NOT NULL,
  payload   TEXT    NOT NULL,      -- JSON de la op ya SANEADA
  user_id   INTEGER,               -- autoría, para el panel de conflictos
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_ops_dot ON collab_ops (post_id, site_id, counter);
CREATE INDEX IF NOT EXISTS idx_collab_ops_room ON collab_ops (post_id, epoch, seq);
```

Notas de diseño, no adornos:
- `UNIQUE(post_id, site_id, counter)` hace la **idempotencia** un invariante de la BD: reenviar una
  op tras una reconexión no la duplica ni depende de que el proceso recuerde nada.
- `payload` guarda la op **ya saneada** (§4.5): lo que se persiste es lo que se difunde.
- `TEXT` y no `jsonb`: el proyecto corre sqlite-native, sqlite-legacy, Postgres **y** MySQL. La
  portabilidad manda; no consultamos por dentro del JSON.
- `members` es un contador **cooperativo** (se incrementa/decrementa en join/leave y se reconcilia
  por `heartbeat`): en multinodo nadie tiene la lista completa en memoria. Un nodo que muere deja el
  contador alto ⇒ el barrido periódico (§5.5) lo corrige por ausencia de heartbeats.

### 5.3 Snapshot periódico al `_puck_data` canónico

- **Cada 30 s de inactividad de la sala** y **siempre al vaciarse**, el nodo que tiene el *lease* de
  la sala (§5.5) proyecta el estado CRDT a `VersoData` y lo guarda **por el mismo camino que el
  editor usa hoy**: `PUT /api/v1/posts/:id` con `autosave: true` (`admin/posts/[id]/page.tsx` L237)
  ⇒ pasa por `sanitize-meta`, **no** genera revisión, no infla el historial.
- **Una revisión real solo la crea un humano** pulsando Guardar. La colaboración no debe convertir
  el historial de revisiones en un log de autosaves.
- **Autoría del autosave**: el último usuario que emitió una op (no "el que cerró la pestaña").
- **`content` HTML**: se regenera con el mismo pipeline que hoy (el editor ya deriva el HTML del
  árbol); el snapshot colaborativo no puede escribir `_puck_data` sin actualizar `content`, o el
  sitio público serviría contenido viejo.

### 5.4 Compactación y GC de tombstones (D19) — la decisión que evita el problema estructural

El problema es real y está medido en el ecosistema: los tombstones crecen sin techo en documentos
longevos, y purgarlos exige coordinación (solo se pueden borrar cuando **todas** las réplicas han
reconocido el borrado) — por eso Yjs/Automerge/Loro invierten tanto en compactación y aun así los
docs con cientos de miles de ops se degradan.

**Nuestra sesión colaborativa es EFÍMERA, y eso nos regala el GC total:**

```
sala vacía
  → proyectar estado CRDT → VersoData
  → PUT autosave (sanitizado, sin revisión)     ← ESCRITURA CANÓNICA CONFIRMADA
  → epoch = epoch + 1
  → DELETE FROM collab_ops WHERE post_id=? ; collab_docs.state=''
```

Después de eso **no quedan tombstones**: la próxima sesión arranca de cero desde `_puck_data`. No hay
crecimiento acumulativo, no hay coordinación distribuida, no hay heurística de TTL.

**El precio, dicho claro**: al subir el `epoch` se pierde la capacidad de fusionar automáticamente
ops de un cliente que estaba offline durante ese corte. Ese caso se atiende en §6.4 (rebase o
revisión), **nunca** con pérdida silenciosa. Es un intercambio consciente: cambiamos "merge
automático perfecto tras días offline" (que ni Notion resuelve bien) por "cero deuda de tombstones".

**Compactación intra-sesión** (mientras la sala vive): cuando `count(collab_ops) > 500` para una
sala, el nodo con el lease escribe el estado en `collab_docs.state` con `state_seq = max(seq)` y
borra las ops `<= state_seq`. Un `resync` posterior se sirve del snapshot + las ops nuevas.

### 5.5 Qué pasa cuando el último cliente se va

Secuencia exacta, con la regla dura primero:

> **NUNCA se borra el estado CRDT sin una escritura canónica confirmada.** Si el `PUT` falla
> (BD caída, validación, 409 de migración), el estado **se conserva** con `flushed_at` sin tocar y se
> reintenta: al reabrir la página, o en el barrido periódico. Perder la sesión es una molestia;
> perder el contenido es inadmisible.

1. Último `close`/timeout ⇒ `members` llega a 0 en el nodo con el **lease de sala** (una clave Redis
   `collab:lease:<postId>` con TTL 30 s renovada por el nodo dueño; sin Redis, el propio proceso).
2. Gracia de 10 s (una recarga de página no debe disparar el flush).
3. Proyección → `PUT` autosave → esperar 2xx.
4. `epoch+1`, purga de ops, `state=''`, `flushed_at=now()`.
5. `roomReset` a cualquier cliente que hubiera vuelto en medio (llegan al estado nuevo, no a uno
   fantasma).

**Barrido periódico** (cron existente, cada 5 min): salas con `updated_at` viejo, `members>0` y sin
heartbeats ⇒ se tratan como vacías y se ejecuta el flush. Cubre el nodo que muere sin cerrar.

**Escritura externa mientras la sala vive** (alguien restaura una revisión, o un plugin escribe el
post): el post cambia bajo los pies de la sala. Detección por `post_modified` distinto del que la
sala conoce ⇒ `roomReset { reason:'externalWrite' }`, con el mismo flujo que §3.3. Sin esto, la sala
sobreescribiría la restauración de la revisión al siguiente autosave — un bug de pérdida de datos
clásico en editores colaborativos.

---

## 7. §6 — MODELO DE CONFLICTOS OBSERVABLE

Principio: **el usuario nunca descubre un conflicto releyendo su texto.** Si algo suyo no sobrevivió
tal cual, se le dice en el momento, con el nombre de quien lo cambió y una acción posible.

### 6.1 Dos personas editan el mismo bloque

- **Props distintas** ⇒ ambas sobreviven (LWW por clave). Sin aviso: no hubo conflicto.
- **La misma prop** ⇒ gana el HLC mayor. El perdedor ve un **toast no modal**: "*Ana cambió el color
  de este bloque*", con el bloque resaltado 2 s y un botón "Recuperar el mío" que emite un `propSet`
  nuevo con su valor (no un "undo" — un cambio nuevo, que es lo único que converge).
- **El mismo texto** ⇒ fusión fina (D4): ambas ediciones viven. Sin toast; se ve el caret ajeno y el
  texto aparecer (§6.5).

### 6.2 Uno borra lo que otro está editando

**El borrado gana** (no resucitamos nodos: un nodo resucitado con el mismo id frente a un tombstone
no converge). Pero el que estaba editando ve un aviso **persistente** (no un toast que se va):

> "*Luis eliminó el bloque que estabas editando. Tu texto no se ha perdido.*" → **[Restaurar mi
> versión]**

"Restaurar" **re-inserta** el bloque con el contenido que el usuario tenía, con **id nuevo**, en la
posición donde estaba (usando las posiciones vecinas vivas). Es una inserción normal ⇒ converge y es
deshacible por su autor. Preservamos la intención sin romper el álgebra.

### 6.3 Uno mueve y otro edita dentro

**No es un conflicto**: mover cambia la posición; editar cambia props/texto. Las ops conmutan y
ambas sobreviven. Lo que hay que cuidar es la **experiencia**:

- El bloque se reubica con animación (200 ms) en vez de saltar.
- El cursor y la selección se **mantienen** (están anclados a `posId`, no a offsets ni a índices).
- Toast informativo solo si el bloque estaba seleccionado por el usuario: "*Ana movió este bloque*".
- El caso `moveNode` de un ancestro (se mueve el contenedor entero mientras editas dentro) es
  idéntico y no requiere nada especial.

### 6.4 Reconexión tras offline (D20): qué hacemos, y por qué no una copia "(Conflicto)"

Notion, con CRDTs por debajo, resuelve el conflicto offline **creando páginas duplicadas** y pidiendo
merge manual, y su propia documentación advierte del riesgo en ediciones no textuales.

> **D20 — Nosotros NO creamos posts "(Conflicto)".** Un post no es una página de Notion: tiene slug,
> URL pública, SEO, estado de publicación y un historial de revisiones. Duplicarlo crea un problema
> peor (contenido duplicado indexable, slugs `mi-pagina-conflicto-2`, listados sucios) que el
> conflicto que pretende resolver. Y, sobre todo: **ya tenemos la red de seguridad correcta**, que
> son las revisiones.

Tres regímenes, decididos por `epoch` y antigüedad:

**(i) Mismo epoch, ops encajan** (caída de red de segundos/minutos, la sala siguió viva):
merge normal por CRDT. Silencioso. Es el caso mayoritario.

**(ii) Epoch avanzado, offline corto (< 24 h), con ops locales pendientes** — la sala se cerró y
snapshotó mientras no estabas:
**rebase**, posible porque nuestras ops llevan `nodeId` **estable** y posiciones **relativas**:

```
para cada op local pendiente, en orden:
  propSet/propDelete/markSet → reaplicar si el nodo/átomo existe        → ✅
  textInsert/textDelete      → reaplicar si el campo existe y la vecindad vive → ✅
  listInsert                 → reinsertar junto a su vecino vivo más cercano   → ✅
  listMove                   → reaplicar si origen y destino existen           → ✅/❌
  nodeDelete                 → aplicar si el nodo existe (si ya no, no-op)     → ✅
  cualquiera cuyo objetivo ya no existe                                        → ❌ a la bandeja
```

Lo que no se puede reaplicar va a un **panel** ("3 cambios no se pudieron reaplicar") con el detalle
por cambio (bloque, campo, valor, hora) y un botón de copiar. Nada se pierde en silencio.

**(iii) Offline largo (≥ 24 h), o el post cambió por otra vía, o el rebase falla en >30 % de las
ops**: no se rebasa. El trabajo local se guarda **como revisión** del post (sistema de revisiones
existente), con nombre "Trabajo sin conectar de Fulanito — 15/08 18:20", y se le ofrece al usuario
comparar y restaurar con el diff que ya existe. Esta es la respuesta honesta: cuando la fusión
automática dejaría de ser fusión y pasaría a ser adivinación, decide una persona con las dos
versiones delante.

### 6.5 Presencia (awareness)

Canal **aparte del CRDT**: efímero, **no persiste**, no entra en `collab_ops`, se pierde al
desconectar. Es "awareness", no documento.

```
Presence = { siteId, userId, name, color, sel, at }
sel      = { nodeId } | { nodeId, field, anchor:OpId, focus:OpId } | null
```

- **Color** derivado determinísticamente del `userId` (mismo color en todas las pantallas y sesiones).
- **Anclas por `OpId`, no por offset**: el caret remoto sobrevive a inserciones ajenas sin saltar —
  es el motivo de que la presencia tenga que hablar el lenguaje del CRDT aunque no forme parte de él.
- **Coalescencia 50 ms** en el emisor (un `mousemove`/`selectionchange` no es un frame de red) y
  **heartbeat 10 s** con **TTL 30 s** en el servidor; al expirar se difunde la salida.
- UI: avatares en la barra superior (con "y N más" a partir de 5), **borde de color** en el bloque
  seleccionado por otro, **caret + selección de color** en el texto, y etiqueta con el nombre al
  pasar el cursor.
- **Privacidad**: solo nombre público y avatar. **Nunca** el email (el proyecto ya distingue eso en
  otras superficies). Un usuario sin permiso de edición **no aparece ni ve** presencia (D16: ni
  siquiera entra).

---

## 8. §7 — PLAN POR FASES, GATES Y ESTIMACIÓN

Cada fase tiene un **gate verificable**; ninguna se da por hecha por "compila y parece que va" — la
regla del proyecto ("«se parece» no es terminado") aplica igual aquí, con dos navegadores abiertos.

### F8.0 — Presencia sin CRDT (2–3 d)

Dep `ws`; sala, handshake, autorización, presencia, avatares. **Valor real desde el día 3**: ver
quién está editando ya previene la mitad de los conflictos.

**Gates**: `G-F8.0-a` dos navegadores con usuarios distintos se ven · `G-F8.0-b` sin permiso ⇒ 4403 ·
`G-F8.0-c` 2 backends + Redis: A en nodo 1 ve a B en nodo 2 · `G-F8.0-d` el bundle público **no**
crece (el código colaborativo solo carga en `/admin`).

### F8.1 — Núcleo CRDT en TS puro, sin red (5–8 d)

`FugueList<T>` (D1/D2), LWW-map + HLC, VV, buffer causal, log de moves (D10), proyección
CRDT↔`VersoDoc`, metadatos de forma (D12).

**Gates**:
- `G-F8.1-a` **convergencia por fuzzing**: N=2..5 réplicas × M=1000 ops aleatorias en órdenes
  distintos ⇒ estado idéntico (comparación por serialización canónica).
- `G-F8.1-b` **conformidad con el paper**: los escenarios de interleaving (LtR, RtL, y el que separa
  Fugue de FugueMax) codificados como tests, con el resultado esperado del paper. Cierra
  **[ABIERTO-1]**.
- `G-F8.1-c` **round-trip byte-exacto** sobre el corpus de producción (§3.4). **Gate de cancelación
  de fase.**
- `G-F8.1-d` moves concurrentes que formarían ciclo ⇒ mismo resultado en todas las réplicas, sin
  ciclo y sin duplicado.

### F8.2 — Mapeo comandos ↔ ops e integración con el store (4–6 d)

Sink en `transact`, `applyRemote`, texto inline sobre átomos (D4), expansión de `duplicateSubtree`,
`docReset` (D11).

**Gates**: `G-F8.2-a` propiedad "misma secuencia en dos órdenes ⇒ mismo `VersoData`" · `G-F8.2-b` el
DnD sigue emitiendo **solo** comandos (test de invariante ya existente sigue verde) · `G-F8.2-c`
undo/redo local intacto con 0 ops remotas (no-regresión de F2) · `G-F8.2-d` un párrafo editado por
dos réplicas a la vez conserva **ambas** ediciones y serializa HTML canónico válido.

### F8.3 — Transporte, autorización, multinodo (4–6 d)

WS + fallback, bus Redis, límites, sanitización de ingest.

**Gates**: `G-F8.3-a` un `contributor` no entra a una `page` ajena (4403) · `G-F8.3-b` `Origin`
cross-site rechazado · `G-F8.3-c` **idempotencia del sanitizador** (§4.5) · `G-F8.3-d` 3 modos
(mono/split/separate) + 2 backends con Redis, en Proxmox · `G-F8.3-e` cortar Redis con la sala viva
⇒ degradación **anunciada**, sin corrupción y sin ops perdidas tras reconectar · `G-F8.3-f` flood de
ops ⇒ 4429 y cierre, el resto de la sala sigue.

### F8.4 — Persistencia, compactación, snapshot (4–5 d)

Migración `0012`, lease de sala, flush, GC (D19), barrido.

**Gates**: `G-F8.4-a` migración aplica en sqlite-native, sqlite-legacy, Postgres y MySQL ·
`G-F8.4-b` `kill -9` a mitad de sesión ⇒ al reabrir no falta nada confirmado · `G-F8.4-c` sala vacía
⇒ `_puck_data` escrito, ops purgadas, `epoch+1` · `G-F8.4-d` **fallo inyectado en el `PUT`** ⇒ el
estado CRDT **NO** se borra y se reintenta · `G-F8.4-e` restaurar una revisión con la sala viva ⇒
`roomReset`, y el siguiente autosave **no** pisa la restauración.

### F8.5 — UX de conflictos, reconexión, undo colaborativo (5–7 d)

Los cuatro escenarios de §6, panel de rebase, revisión de rescate, undo por sitio.

**Gates**: `G-F8.5-a` los 4 escenarios reproducidos **en navegador** con dos perfiles y capturados ·
`G-F8.5-b` offline 10 min ⇒ merge sin pérdida · `G-F8.5-c` rebase imposible ⇒ panel con el detalle,
0 pérdidas silenciosas · `G-F8.5-d` undo tras op remota: nunca deshace lo ajeno, nunca corrompe.

### F8.6 — Endurecimiento y observabilidad (4–5 d)

Fuzz adversarial (ops malformadas, `OpId` inventados, `siteId` ajeno, payloads gigantes), métricas
`prom-client` (salas, miembros, ops/s, bytes/min, rebases fallidos), documentación de operador,
feature flag.

**Gates**: `G-F8.6-a` el fuzzer adversarial no consigue divergencia ni crash ni 500 · `G-F8.6-b`
métricas visibles · `G-F8.6-c` **flag apagado ⇒ el editor se comporta EXACTAMENTE como hoy** (mismo
bundle, mismo guardado, 0 conexiones) · `G-F8.6-d` cierra **[ABIERTO-2]** y **[ABIERTO-3]** con
números medidos, no con opinión.

### F8.7 — (Opcional, con disparador) Peritext para marcas de rango

Solo si se cumple el disparador de D5. 5–8 d adicionales.

### Estimación honesta y riesgos

| Fase | Días |
|---|---|
| F8.0 | 2–3 |
| F8.1 | 5–8 |
| F8.2 | 4–6 |
| F8.3 | 4–6 |
| F8.4 | 4–5 |
| F8.5 | 5–7 |
| F8.6 | 4–5 |
| **Total** | **28–40 días-persona (6–8 semanas)** |

**Dónde está el riesgo de verdad** (no donde parece):
1. **El texto inline (F8.2/F8.5), no la lista.** La lista de bloques es la parte fácil; el mapeo
   átomos↔CRDT↔DOM con cursores y IME es donde se pierde el tiempo. Mitigación: el motor inline ya
   es puro y testeable sin navegador — el CRDT del texto se prueba entero en Node antes de tocar el
   DOM.
2. **El undo colaborativo (F8.5).** "Deshacer lo mío sin deshacer lo tuyo" es un problema clásico y
   nuestra historia es de **parches inversos** (no de ops transformables). La decisión de §6/F8.5 es
   deliberadamente modesta: undo solo de ops propias, y un inverso cuyo objetivo ya no existe se
   descarta con aviso en vez de abortar la entrada entera. Cualquier ambición mayor (undo con
   transformación) se declara **fuera de F8**.
3. **El gate de round-trip (`G-F8.1-c`).** Si aparece una forma del corpus que el modelo CRDT no
   puede representar, la respuesta correcta es ampliar `shapeSet`, **nunca** relajar el gate.
4. **Multinodo sin sticky sessions.** Ya está diseñado para ello (D15), pero es donde un test que no
   se corra en Proxmox con 2 backends dará una falsa sensación de verde.

### Lo que NO hace F8 (declarado para que nadie lo asuma)

- No hay colaboración en el **frontend público** (nada de esto se carga fuera de `/admin`).
- No hay **P2P**: siempre hay servidor (es quien autoriza y sanea).
- No hay **historial CRDT permanente** ni "ver el documento como estaba hace 3 días con atribución
  por carácter": la sesión es efímera (D19) y el historial son las **revisiones**.
- No hay **comentarios ni sugerencias** (necesitarían Peritext, F8.7+).
- No hay **modo lector** (D16).
- No se toca el contrato de `_puck_data` (D12). Ni un byte.

---

## Anexo A — Fuentes consultadas (agosto 2026)

- Weidner, Gentle, Kleppmann — *The Art of the Fugue: Minimizing Interleaving in Collaborative Text
  Editing* — [arXiv:2305.00583](https://arxiv.org/abs/2305.00583) · versión de revista en
  [IEEE TPDS 2025](https://www.computer.org/csdl/journal/td/2025/11/11181220/2akrxcH1WG4)
- Weidner — *There Are No Doubly Non-Interleaving List CRDTs* —
  [PDF](https://mattweidner.com/assets/pdf/List_CRDT_Non_Interleaving.pdf)
- Weidner — *Fugue: A Basic List CRDT* (algoritmo en prosa) —
  [mattweidner.com](https://mattweidner.com/2022/10/21/basic-list-crdt.html) · implementación de
  referencia y benchmarks: [github.com/mweidner037/fugue](https://github.com/mweidner037/fugue)
- Litt, Lim, Kleppmann, van Hardenberg — *Peritext: A CRDT for Collaborative Rich Text Editing*
  (CSCW 2022) — [Ink & Switch](https://www.inkandswitch.com/peritext/)
- Kleppmann et al. — *A highly-available move operation for replicated trees* (verificado en
  Isabelle/HOL) — [PDF](https://martin.kleppmann.com/papers/move-op.pdf)
- *Extending JSON CRDTs with Move Operations* — [arXiv:2311.14007](https://arxiv.org/pdf/2311.14007)
- Loro — *Introduction to Loro's Rich Text CRDT* (Fugue + Peritext en producción) —
  [loro.dev](https://loro.dev/blog/loro-richtext)
- WordPress Core — *Update on Phase 3: Collaboration efforts* —
  [make.wordpress.org](https://make.wordpress.org/core/2025/11/06/update-on-phase-3-2025/) ·
  Trac [#64622](https://core.trac.wordpress.org/ticket/64622) ·
  [PR #74564 (polling por defecto)](https://github.com/WordPress/gutenberg/pull/74564) ·
  [cobertura de la inestabilidad](https://www.searchenginejournal.com/wordpresss-troubled-real-time-collaboration-feature/571201/)
- Notion — comportamiento de conflicto offline (páginas duplicadas, advertencia sobre ediciones no
  textuales) — [guía 2026](https://notionbackups.com/guides/notion-offline-mode)
- `ws` vs `socket.io` en producción y escalado con Redis —
  [comparativa 2026](https://www.pkgpulse.com/guides/best-websocket-libraries-nodejs-2026) ·
  [Ably: escalar Socket.IO](https://ably.com/topic/scaling-socketio)
- Hybrid Logical Clocks (Kulkarni et al.) — resumen práctico:
  [sookocheff.com](https://sookocheff.com/post/time/hybrid-logical-clocks/)
- Tombstones y compactación en CRDTs de producción —
  [comparativa Yjs/Automerge/Loro 2026](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026) ·
  [crdt-benchmarks](https://github.com/dmonad/crdt-benchmarks)

## Anexo B — Glosario mínimo

| Término | Significado aquí |
|---|---|
| **op** | Operación CRDT que viaja por el canal (§3.1) |
| **OpId / causal dot** | `siteId@counter`; identidad global e inmutable de una posición o de una op |
| **posId** | El `OpId` que identifica la posición de un elemento en una lista |
| **tombstone** | Posición borrada que se conserva porque otras ops la referencian |
| **epoch** | Generación de la sesión colaborativa; sube en cada flush/reset y **invalida** las ops viejas |
| **awareness / presencia** | Estado efímero (cursores, avatares) que **no** forma parte del documento |
| **lease de sala** | Clave Redis con TTL que designa al nodo responsable del flush y la compactación |
| **shape / metadatos de forma** | Los campos de `VersoDoc` que hacen el round-trip byte-exacto (§3.4) |

---

## Anexo C — ADENDA DE IMPLEMENTACIÓN F8.3 (transporte y persistencia)

> Escrito **al implementar**, no al diseñar. Corrige tres decisiones de este documento con lo que
> se encontró en el árbol. Donde esta adenda y el cuerpo del documento discrepen, **manda la
> adenda** — y el motivo está escrito, no implícito.

### C.1 — D13 revocada: el transporte primario es **SSE + POST**, no WebSocket

**D13 daba por hecho un sustrato que no existe.** La tabla de §1 apuntaba a
`backend/src/index.ts` como «el handle sobre el que montar `ws`». Al implementar se comprobó que el
backend **no tiene ningún servidor WebSocket, ninguna dependencia `ws`, y ni un solo handler de
`upgrade`** (`grep -rn "WebSocket\|upgrade" backend/src` solo devuelve el egress-guard, el CSP y
comentarios sobre actualizaciones de esquema). D13 no era «reutilizar lo que hay»: era **construir
un transporte nuevo entero**.

Se implementa **D14 como primario** (misma decisión, mismo protocolo de mensajes, otro tubo):

| | `ws` (D13) | **SSE + POST (elegido)** |
|---|---|---|
| Dependencias nuevas | 1 (`ws`) | **0** |
| Bundle cliente | 0 | **0** (`EventSource` + `fetch` nativos) |
| Listeners que hay que cubrir | HTTP **y** HTTPS-con-mTLS del modo separado | ninguno: son rutas de la API |
| Gateway/nginx | depende del proxy de `upgrade` | **igual que el resto de `/api`** |
| Autenticación / CSRF | handshake propio que auditar aparte | **el mismo `authenticate` + Origin del resto** |
| Precedente en producción | ninguno | `/api/v1/notifications/stream` |

**Lo que se paga, dicho claro**: la subida cuesta un round-trip HTTP en vez de ir por el mismo
socket. Con la coalescencia del emisor (un frame por transacción, no por pulsación) son decenas de
POST por minuto y editor. Si algún día se mide latencia de subida inaceptable, **el protocolo de
mensajes no cambia**: se sustituye el par de rutas y nada más.

Rutas: `GET /api/v1/collab/:postId/stream` · `POST …/ops` · `…/presence` · `…/resync` · `…/leave`.

### C.2 — El servidor NO ejecuta el CRDT (y por eso no hay compactación intra-sesión)

El cuerpo del documento asume en §5.3/§5.4 que «el nodo con el lease proyecta el estado CRDT». Eso
exigiría una segunda implementación del algoritmo en el backend — dos motores que **tienen** que
coincidir bit a bit o divergen. Se descarta. En su lugar:

- **El servidor valida y reparte; el CLIENTE proyecta.** El contenido canónico lo sigue escribiendo
  el editor por `PUT /api/v1/posts/:id`, que ya pasa por `sanitize-meta`. La colaboración **no abre
  una segunda vía de escritura al post**.
- **Sin compactación intra-sesión**, y no por pereza: el `base` de un epoch **no puede cambiar**.
  Las posiciones semilla que `toCrdt()` deriva del snapshot son función pura del snapshot, así que
  reemplazarlo re-derivaría semillas distintas de las que ya tienen los miembros vivos — divergencia
  garantizada. Compactar exige subir el `epoch` y que todos re-siembren, que es un `roomReset`.
- Ciclo de vida (D19 intacta): sala vacía ⇒ se purgan `collab_ops` y `collab_docs` ⇒ el siguiente
  que abra re-siembra del `_puck_data` vigente. **Se tira estado de SESIÓN, jamás contenido.**
- Tope `MAX_OPS_PER_EPOCH` (5000): superado, se sigue **difundiendo** (la sala no se rompe) pero se
  deja de persistir y se emite `warning{log_full}` ⇒ el cliente pasa a `degraded` y pide guardar y
  recargar. Degradación **anunciada**, nunca muda.

### C.3 — El version vector del `resync` debe ser de PREFIJO DENSO

Hallazgo de `collab-convergence.test.ts`, y merece quedar escrito porque es el error natural:

> El `vv` que expone `CrdtDoc` es un vector de **máximos** (`max(counter) visto por sitio`). Eso
> solo equivale a «lo tengo todo hasta ahí» bajo entrega **causal**. Y un `resync` se pide
> justamente cuando hay un **hueco**: recibir `s@3` sin haber visto `s@1` y `s@2` deja `vv[s]=3`, y
> el servidor concluye que no falta nada. El hueco se vuelve permanente.

La sesión mantiene por tanto su propio registro de dots **aplicados** y deriva el prefijo denso
(`1..n` todos presentes) para el `resync`. Reenviar una op que ya se tenía es un no-op exacto: el
error se paga en tráfico, nunca en corrección.

### C.4 — Seguridad del canal: lo que se garantiza

1. **Autenticación** igual que el resto de la API (cookie HttpOnly `wordjs_token` o Bearer). **No**
   se usa `authenticateAllowQuery`: un JWT en la query se filtra por access logs, `Referer` e
   historial, y `EventSource` ya manda la cookie same-origin.
2. **CSRF**: los POST los cubre el `csrfProtection` global; el **GET del stream no** (solo mira
   métodos que cambian estado), así que la ruta comprueba el Origin explícitamente. Sin eso, un
   sitio hostil abriría el stream con la cookie ambiental de la víctima y leería su borrador en vivo.
3. **Autorización por el post concreto**: mismo gate que `PUT /posts/:id` vía `capsForType` +
   own/others + published. No se inventa un permiso nuevo. **Sin modo lector** (D16 intacta).
4. **Atribución infalsificable**: el `siteId` se ata a la conexión SSE; los POST deben presentar un
   `siteId` de una conexión viva **y del usuario que llama**; y cada op debe declararse de ese mismo
   `siteId`. El `userId` **siempre** sale de `req.user`, nunca del cuerpo.
5. **Ingest hostil**: cada op se **reconstruye** campo a campo (nada no enumerado sobrevive ⇒ ni
   contrabando de campos ni contaminación de prototipos) y se sanea con el **mismo**
   `sanitizePuckTree`/`safePuckUrl` de la ruta de escritura, **una sola vez, en el ingest**: lo que
   se persiste es lo que se difunde, así que dos nodos no pueden sanear distinto y divergir.
6. **Sin amplificación**: no se puede empujar nada sin un stream abierto y autorizado; hay topes de
   ops/s, bytes/s, tamaño de frame, conexiones por usuario y por (usuario × post).

### C.5 — Lo que queda pendiente de F8.3

- **Cableado en el editor** (`sendCommand` en el sink de `transact`, `setSelection`, avatares y
  carets). El hook `useVersoCollab` está listo, tipado y probado; nada de esto toca
  `components/verso/editor/**`.
- **Verificación en navegador con dos perfiles** (regla dura del proyecto: «se parece» no es
  terminado) y el gate multinodo `G-F8.3-d` en Proxmox con 2 backends + Redis.
- **UX de conflictos (F8.5)**: los avisos ya viajan tipados en `CollabNotice`; falta pintarlos.
