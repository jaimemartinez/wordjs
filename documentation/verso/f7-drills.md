# F7 — Drills de NO-PÉRDIDA (reejecutables)

> Cuatro scripts que atacan la pregunta que decide si Verso puede reemplazar al editor legacy:
> **¿se pierde contenido en algún punto del ciclo real de vida de un documento?** No son tests
> sintéticos: cada uno trabaja sobre una **COPIA de la instalación de dev** (`backend/data/wordjs.db`,
> 187 posts / 162 filas `_puck_data`) y ejecuta el **código real** del editor y del backend.
>
> Viven en `scripts/verso-drills/`. Cada uno imprime un bloque `RESUMEN` con contadores y sale con
> **exit code ≠ 0 si algo falla**.

## Cómo se reejecutan

```bash
# los cuatro, con veredicto agregado (exit 0 solo si los cuatro salen 0)
node scripts/verso-drills/run-all.cjs

# uno a uno
node scripts/verso-drills/drill1-migration-rehearsal.cjs [--docs=10] [--cmds=40] [--seed=1337]
node scripts/verso-drills/drill2-cross-revisions.cjs     [--docs=12]
node scripts/verso-drills/drill3-wxr-roundtrip.cjs       [--docs=25]
node scripts/verso-drills/drill4-inline-guard-load.cjs   [--docs=20]

# cualquiera acepta --keep-copy para NO borrar la copia temporal (depurar a mano)
```

Requisitos (ya presentes en un árbol de desarrollo normal):

- `backend/node_modules`: `better-sqlite3` (copia y lectura de la BD), `esbuild` (compila el kernel
  del frontend a un CJS para node), `ts-node` (drills 2 y 3 cargan el backend TypeScript).
- `frontend/node_modules`: `sanitize-html`, `dompurify`, `htmlparser2` (los resuelve esbuild al
  empaquetar `lib/sanitize.ts`).
- **No hace falta levantar ningún servidor** y da igual que el dev server esté corriendo.

### Seguridad de datos (por qué no rompen tu instalación)

- La BD viva se abre **solo en readonly** y **solo para copiarla**, con el *backup API* de SQLite
  (`_common.cjs#copyLiveDb`) — que sí arrastra el contenido del `-wal`, a diferencia de un `copyFile`
  del `.db` a secas. Todo el trabajo posterior ocurre sobre la copia en el temporal del SO
  (`%TEMP%/wordjs-verso-drills/`), que se borra al terminar.
- Abrir una BD en modo WAL —aunque sea readonly— toca el fichero `-shm` (índice compartido). Es
  inevitable y **no altera datos**: verificado antes y después con el mismo recuento (187 posts, 162
  filas `_puck_data`) y el mismo `sha256` del conjunto de valores `_puck_data`.
- Los drills 2 y 3 **sí escriben**, pero exclusivamente sobre la copia / sobre bases limpias creadas
  en el temporal (`config.dbPath` repuntado antes de cargar `config/database`, el patrón de
  `backend/src/tests/wxr-import.test.ts`).

### Piezas compartidas

| Fichero | Qué es |
|---|---|
| `_common.cjs` | copia de la BD, apertura readonly, `Reporter` (contadores + RESUMEN + exit code), PRNG determinista, `firstDiff` |
| `kernel-entry.ts` | re-exporta el código **real** del frontend (`lib/verso/normalize`, `lib/verso/commands`, `lib/verso/inline-engine`, `lib/sanitize`) + `htmlToText`; esbuild lo empaqueta a CJS para node |
| `run-all.cjs` | lanza los cuatro y agrega el veredicto |

Todos son **CommonJS (`.cjs`)** a propósito: `ts-node/register` es un hook de `require`.

---

## Drill 1 — Ensayo de migración (`drill1-migration-rehearsal.cjs`)

**Fase A.** Las **162** filas `_puck_data` de la copia pasan por `toNormalized → fromNormalized` y se
comparan **byte a byte** (`JSON.stringify`, no `deepEqual`: el orden de claves también es contrato).
Un documento con `zones` legacy vivas puede cambiar (única diferencia permitida del contrato): ahí se
exige **punto fijo** en la segunda pasada y **cero pérdida de bloques**.

**Fase B.** Sobre los N documentos con más bloques se aplica una secuencia determinista de comandos
reales (`insertNode` / `setProps` / `setRootProps` / `moveNode` / `duplicateSubtree` / `removeNode`) y
después se deshace **entera** con los inversos que devuelve `applyCommand`; la serialización final
debe ser byte-igual a la de partida.

Resultado (2026-08-15, ejecutado con `--docs=25 --cmds=200 --seed=99`; por defecto son 10×40):

```
filas__puck_data                  : 162
roundtrip_byte_ok                 : 159
docs_con_zones_legacy             : 1     zones_punto_fijo_ok : 1
metas_huerfanas_post_borrado      : 33
json_invalido                     : 2     (ambas HUÉRFANAS: valor literal "changed", posts 45/48 ya borrados)
docs_editados                     : 25    comandos_por_doc : 200
comandos_aplicados                : 5000  comandos_rechazados_sin_tocar_doc : 0
undo_byte_exacto_ok               : 25
VEREDICTO: OK
```

> Las filas `_puck_data` cuyo post ya no existe se cuentan aparte y **no** hacen fallar el drill: son
> restos de un post borrado, no contenido de nadie. Si una fila inválida colgase de un post VIVO,
> sería fallo.

## Drill 2 — Revisiones cruzadas (`drill2-cross-revisions.cjs`)

Ciclo completo con el código real del backend (`models/Post`, `core/revisions`, `core/sanitize-meta`),
replicando el orden de escritura de `routes/posts.ts` (PUT `/posts/:id`, ~L460-479:
`Post.updateMeta(id, key, sanitizeMetaValue(key, value))` y **después** `saveRevision(id)`):

1. documento tal cual lo dejó el editor legacy → 2. re-guardado legacy → **R1** →
3. abierto y guardado por **Verso** (`toNormalized` → `setProps` + `insertNode` → `fromNormalized`) →
**R2** → 4. `restoreRevision(R1)` → 5. el `_puck_data` debe volver **byte-igual a R1** y ningún meta
presente en R1 puede desaparecer ni cambiar.

Resultado (2026-08-15, 12 documentos):

```
restaurado_byte_igual_a_R1                        : 12/12   ← el contrato del ciclo
restaurado_byte_igual_al_original_en_BD           : 9
restaurado_distinto_del_original_en_BD_(saneador) : 3
legacy_save_MUTA_bytes                            : 3
saneador_idempotente_desde_2a_pasada              : 12/12
meta_PERDIDO_en_restore                           : 0
colision_post_name_revisiones                     : 1   ← FALLO (bug preexistente, ver abajo)
```

## Drill 3 — WXR round-trip (`drill3-wxr-roundtrip.cjs`)

Dos patas, cada fase en **su propio proceso** (el driver SQLite fija `dbPath` en su constructor, así
que una ejecución no puede hablar con dos bases):

- **Pata A** — exportador REAL (`core/import-export.ts#exportToWXR`, la de `GET /export/wxr`) sobre la
  copia → importador REAL (`core/wxr-import.ts#importWxr`, con `sanitizeImportedMeta`) sobre una BD
  limpia.
- **Pata B** — un WXR construido con `<wp:postmeta>` por documento (lo que emite un WordPress real y
  lo que el importador sí sabe leer), con los 25 documentos más grandes del corpus, importado en otra
  BD limpia. Compara byte a byte y verifica la supervivencia de **cada tipo de bloque**.

Resultado (2026-08-15):

```
PATA A  export_bytes 874 · items 0 · wp:postmeta 0 · _puck_data recuperados 0   ← FALLO x2
PATA B  docs 25 · tipos de bloque distintos 30 · reimportados 25/25
        byte_igual_tras_saneador_de_import 25/25 · perdidas_de_bloques 0
        byte_igual_al_original 22/25 (los 3 restantes, por el saneador de escritura del drill 2)
```

## Drill 4 — Fuzz de carga real contra el guard inline (`drill4-inline-guard-load.cjs`)

El guard fail-closed de `VersoTextSurface` (L563-577) pone la sesión en **solo lectura** si el
pipeline pierde texto. Un falso positivo = el autor no puede editar ese bloque. El drill replica el
pipeline con el código real sobre los 20 documentos más grandes/profundos **y** sobre todos los
valores rich distintos del corpus entero:

```
refText = htmlToText(sanitizeHTML(valor))     ← equivalente en node de div.textContent
modelo  = parseRichHtml(valor)
(a) inlineGuardLosesText(refText, docGuardText(modelo))
(b) inlineGuardLosesText(refText, docGuardText(parseRichHtml(serializeDocForEditor(modelo))))
```

**Límite honesto**: la pata (b) real relee el DOM ya pintado con `readRichModel` (imposible sin
navegador); aquí se sustituye por releer el HTML emitido — cubre motor y serializador, **no** el
walker DOM. Esa mitad la cubre el E2E de navegador.

Resultado (2026-08-15):

```
docs_analizados 20 (máx 28.213 bytes, profundidad 3) · 107.280 bytes analizados
valores rich del corpus completo : 69 distintos → 69 editables, 0 disparos, 0 fuera de punto fijo
otros props con marcado          : 30 → 0 disparos
control_negativo_detecta_perdida : 1   ← el arnés SÍ sabe detectar un disparo
sondas_que_disparan              : 2/8 (<textarea>, <select><option>) — no están en el corpus
VEREDICTO: OK
```

---

## Hallazgos abiertos (por qué 2 de los 4 salen en rojo)

Ninguno es una regresión de Verso: los tres son del backend y afectan igual al editor legacy. Los
drills los dejan en rojo a propósito para que no se olviden.

### H1 — El export de sitio sale VACÍO (`status: 'any'` no existe) · drill 3

`core/import-export.ts#exportSite` consulta `Post.findAll({ type, status: 'any' })`, y
`Post.buildWhere` (`models/Post.ts:507`) traduce eso a `post_status = 'any'` — una cadena literal que
no casa con ninguna fila. Medido sobre la copia real: `exportSite()` devuelve **0 posts y 0 pages**
con 17 entradas y 38 páginas en la BD (el mismo `findAll` con `status:'publish'` devuelve 8 y 8). El
WXR resultante ocupa **874 bytes y contiene 0 `<item>`**. Afecta a `GET /api/v1/export/wxr` y a la
exportación JSON del sitio.

### H2 — `exportToWXR()` no emite `wp:postmeta` ni páginas · drill 3

Aunque se arregle H1, `exportToWXR` (`core/import-export.ts:577`) recorre solo `data.content.posts`,
fuerza `<wp:post_type>post</wp:post_type>` y **no emite un solo `<wp:postmeta>`**: el `_puck_data` de
todo el sitio no viaja. El importador sí sabe leerlo (pata B: 25/25 documentos y 30 tipos de bloque
reimportados sin pérdida), así que el arreglo es del lado del exportador.

### H3 — Colisión de `post_name` entre revisiones del mismo milisegundo · drill 2

`core/revisions.ts:34` nombra cada revisión `${postId}-revision-v${Date.now()}` y el esquema tiene
`CREATE UNIQUE INDEX idx_posts_name_type ON posts (post_name, post_type) WHERE post_name <> ''`
(`config/database.ts:405`). Dos revisiones del mismo post en el mismo ms violan el índice:

- `routes/posts.ts:479` llama a `saveRevision` **fire-and-forget** → la revisión se pierde **en
  silencio** (sin punto de recuperación para esa edición).
- `core/revisions.ts:130` llama a `saveRevision` **fuera del `try`** de `restoreRevision` → el throw
  escapa y `routes/revisions.ts:185` devuelve **500 sin restaurar nada**.

El drill lo reproduce de dos formas: natural (durante el desarrollo de este drill saltó dos veces
seguidas de forma espontánea, abortando la ejecución) y **determinista**, congelando `Date.now()`.
`saveRevision` mide ~5 ms en esta máquina, así que la ventana natural es estrecha pero real.

### H4 — Notas de medición, sin acción obligatoria

- **El saneador de escritura cambia bytes en el primer guardado** de 3 de 12 documentos (`&` → `&amp;`
  en props de texto; `font-size: 40px` → `font-size:40px`). **Converge**: la segunda pasada ya es
  byte-estable en 12/12, así que no hay corrupción progresiva. Es previo a Verso (lo aplica la ruta,
  no el editor), pero explica diffs de revisiones que no vienen del editor.
- **`<textarea>` y `<select><option>`**: el saneador los conserva (están en `ALLOWED_TAGS` de
  `lib/sanitize.ts`) pero el motor inline no los modela, así que un bloque `Text` que los contenga
  quedaría en **solo lectura** al editarlo. No hay ni uno en el corpus actual; queda anotado como
  clase de riesgo si un autor pega un formulario dentro de un bloque de texto.
- **2 filas `_puck_data` con el valor literal `"changed"`** (posts 45 y 48, ya borrados) — basura de
  un test antiguo que quedó huérfana en `post_meta`.
