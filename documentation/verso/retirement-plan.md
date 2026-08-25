# Plan de retirada del fork `@wordjs/puck` y del editor legacy

> **HISTORICAL — this plan was carried out; it is no longer a plan.** Every phase below has
> landed. Gone from the tree: `frontend/packages/puck` (and its `NOTICE.md`),
> `frontend/src/lib/editorEngine.ts`, `EngineToggle.tsx`, `PuckEditor.tsx`,
> `PuckEditorSkeleton.tsx`, `BlockInserter.tsx`, `CommandPalette.tsx`, `InlineTiptap.tsx`, and
> `@tiptap/*` from `frontend/package.json`. The Phase 0/8 renames landed too: `lib/puckI18n.ts` →
> `lib/editorI18n.ts`, `lib/puckPatterns.ts` → `lib/blockPatterns.ts`, `lib/puckPluginRegistry.ts`
> → `lib/versoPluginRegistry.ts`, `components/puckConfig.tsx` → `components/versoConfig.tsx`,
> `components/puck-theme.css` → `components/editor-theme.css`, `components/puck/` →
> `components/blocks/`, `scripts/generate-puck-plugin-registry.js` →
> `scripts/generate-verso-plugin-registry.js`. What did NOT change, deliberately: `_puck_data` is
> still the persisted post-meta key. Kept as the record of the retirement; the file paths and line
> numbers below point at a tree that no longer exists.

> F5a. Plan EJECUTABLE para después de F7 (verificación final de Verso). Nada de este documento se
> ejecuta ahora — es la lista de pasos, en orden seguro, para cuando se decida apagar el editor
> legacy. Cada paso indica qué desbloquea, cómo verificarlo, y qué NO tocar todavía. Basado en la
> evidencia de `derivation-audit.md` §7 (barrido) y en los imports reales verificados en este pase
> (no supuestos — cada afirmación de "X importa Y" fue confirmada con grep+lectura, y donde no pude
> confirmar algo con certeza lo marco explícitamente como "verificar al ejecutar").

## Precondición

- F7 completo y verde (3 modos, navegador, marketplace, ensayo de migración) con Verso como motor
  probado end-to-end.
- Recomendado (no impuesto por este documento — decisión de producto): un período de "soak" con
  `verso` como default y `legacy` todavía disponible vía flag, antes de borrar nada físicamente. La
  Fase 1 de abajo es reversible con un solo commit; la Fase 2 en adelante no lo es sin `git revert`.

## Mapa de dependencias — qué bloquea a qué

```
Fase 0 (independiente, se puede hacer en cualquier momento, incluso antes de F7)
  rename puckI18n/puckPatterns/puckPluginRegistry ──┐
                                                      │ (no bloquea ni es bloqueado por nada más)
Fase 1 — flip del default (reversible)
  editorEngine.ts: default "legacy"→"verso"
        │
        ▼
Fase 2 — quitar el flag y los ternarios (requiere Fase 1 estable)
  pages/[id], posts/[id], chrome/page.tsx: Verso incondicional
        │
        ├──► EditorBootFallback.tsx necesita su PROPIO fallback
        │    ANTES de que PuckEditorSkeleton.tsx pueda borrarse (Verso lo importa hoy)
        │
        ▼
Fase 3 — borrar componentes legacy-only (requiere Fase 2)
  PuckEditor.tsx, PuckEditorSkeleton.tsx, CommandPalette.tsx (legacy),
  BlockInserter.tsx, InlineTiptap.tsx, chrome: rama <Puck> cruda
        │
        ├──► PluginBlockHeavy.tsx sigue usando <Render> del fork para
        │    bloques de plugin/Symbol en el sitio PÚBLICO — esto NO es
        │    parte del editor legacy, hay que resolverlo en su propio
        │    paso ANTES de poder borrar packages/puck (bloquea Fase 5)
        │
        ▼
Fase 4 — borrar tests-pin del fork/legacy (requiere Fase 3)
        │
        ▼
Fase 5 — borrar frontend/packages/puck + deps (requiere Fase 3 Y que
         PluginBlockHeavy.tsx ya no importe @wordjs/puck)
        │
        ▼
Fase 6 — quitar @tiptap/* de package.json (requiere Fase 3, InlineTiptap
         borrado y cero otros consumidores)
        │
        ▼
Fase 7 — NOTICE.md deja de tener objeto: se borra con packages/puck (Fase 5)

Fase 8 (independiente de 2-7, pero solo tiene sentido después de Fase 3:
        el consumidor legacy de estos archivos ya no existe)
  rename puckConfig.tsx + components/puck/* + puck-theme.css + clases
  puck-container/puck-editor-ui — TOCA EL CAMINO PÚBLICO, pase propio
        │
        ▼
Fase 9 — grep-gate final + sección README
```

**Por qué `@dnd-kit/core`/`@dnd-kit/sortable`/`@dnd-kit/utilities` NO están en ningún paso de
abajo:** son dependencias del **árbol raíz** de `frontend/package.json`, usadas únicamente por
`frontend/src/app/admin/widgets/page.tsx` (verificado por grep — 0 otros consumidores), una feature
de admin sin relación con el editor. El fork usa una familia de paquete **distinta**
(`@dnd-kit/react`/`@dnd-kit/helpers`, declaradas en `frontend/packages/puck/package.json`, no en el
`package.json` raíz). Borrar `@dnd-kit/core`/`sortable`/`utilities` por confundirlas con las del
editor rompería la página de widgets — verificar el nombre exacto del paquete antes de tocar
`package.json` en cualquier paso.

## Fase 0 — Renombrados independientes (sin dependencias, se puede hacer ya o en paralelo)

1. `frontend/src/lib/puckI18n.ts` → `frontend/src/lib/versoI18n.ts` (o `editorI18n.ts` si se
   quiere neutral respecto al motor). Actualizar los ~6 importadores conocidos hoy (`BlockPalette.tsx`,
   `OutlineTree.tsx`, `PatternsPanel.tsx`, `PropertiesPanel.tsx`, `SaveStateChip.tsx`,
   `VersoCommandPalette.tsx`, `VersoEditor.tsx` en el lado Verso; re-grepear el lado legacy —
   `PuckEditor.tsx` y afines — porque conviven hasta la Fase 3 y también lo importan).
2. `frontend/src/lib/puckPatterns.ts` → `frontend/src/lib/blockPatterns.ts`. Mismo tratamiento:
   actualizar importadores Verso (`editor/patterns.ts`, `editor/blockClipboard.ts`,
   `editor/__tests__/blockClipboard.test.ts`) Y legacy (`PuckEditor.tsx`) en el mismo commit — es un
   rename mecánico de un módulo de datos puro, no cambia semántica, seguro con ambos motores vivos.
3. `frontend/src/lib/puckPluginRegistry.ts` (generado, gitignorado) → `frontend/src/lib/
   pluginBlockRegistry.ts`. Requiere en el MISMO commit: renombrar
   `frontend/scripts/generate-puck-plugin-registry.js` → `generate-plugin-block-registry.js`,
   actualizar las 2 invocaciones en `package.json` (`predev`/`prebuild`), actualizar la entrada de
   `.gitignore` (línea 122 hoy: `frontend/src/lib/puckPluginRegistry.ts`), y el import real en
   `lib/verso/pluginBlocks.tsx:52`. Verificar que el generador no siga escribiendo al path viejo
   (`git grep` del nombre de archivo dentro del propio script).

**Gate de la Fase 0:** `tsc`/`vitest`/`eslint` completos (toca módulos compartidos por ambos
motores) + arrancar la app en modo legacy Y verso y confirmar que el panel de propiedades, la
paleta de comandos y los patrones siguen funcionando en AMBOS (los textos i18n y los patrones son
observables a simple vista).

## Fase 1 — Flip del default

4. `frontend/src/lib/editorEngine.ts`: cambiar el último eslabón de `resolveEditorEngine` de
   `"legacy"` a `"verso"` (línea 46 hoy: `?? "legacy"` → `?? "verso"`). El flag sigue existiendo
   (`?engine=legacy` y `localStorage wjs_editor_engine=legacy` siguen permitiendo volver atrás) —
   este paso es deliberadamente reversible con un solo commit de vuelta.
5. Actualizar `frontend/src/lib/__tests__/editorEngine.test.ts` (pinea la matriz de precedencia —
   el test debe fijar el NUEVO default como expectativa, no solo dejar de fallar).

**Gate:** los 3 modos + navegador (regla dura del proyecto) — abrir `/admin/pages/[id]` y
`/admin/posts/[id]` SIN query param y confirmar que monta Verso; confirmar que `?engine=legacy`
todavía monta el editor viejo.

## Fase 2 — Quitar el flag y los ternarios

6. Antes de tocar nada más: dar a `components/verso/editor/EditorBootFallback.tsx` su propio
   fallback de carga (hoy importa y renderiza `PuckEditorSkeleton` incondicionalmente — confirmado
   por lectura directa del archivo) — un esqueleto propio, aunque sea una copia trivial del legacy
   renombrada. Este paso es un **bloqueante real** de la Fase 3, no cosmético: si se borra
   `PuckEditorSkeleton.tsx` antes de esto, Verso deja de compilar.
7. `frontend/src/app/admin/pages/[id]/page.tsx` y `.../posts/[id]/page.tsx`: quitar el ternario
   `engine === "verso" ? <VersoEditor/> : <PuckEditor/>`, dejar solo `<VersoEditor/>`. Quitar los
   imports de `PuckEditor`/`PuckEditorSkeleton`/`resolveEditorEngineFromBrowser`/`EditorEngine`.
8. `frontend/src/app/admin/chrome/page.tsx`: mismo tratamiento — quitar la rama `<Puck
   config={...}>` cruda (líneas ~12-13 el import, ~391-398+ el ternario por `engine`), dejar solo
   `<ChromeVersoEditor/>`. **Verificar al ejecutar** si `chromeContract.ts` (solo importado hoy por
   este archivo) se usaba exclusivamente en la rama que se borra — si es así, se borra con ella; si
   `chromeVersoAdapter.tsx` también lo necesita, se conserva. `chromeEditorConfig.tsx` SÍ se
   conserva (lo importa también `chromeVersoAdapter.tsx`, confirmado) — solo revisar si pierde algún
   import de tipo `Config`/`Puck` de `@wordjs/puck` que ya no haga falta.
9. Borrar `frontend/src/lib/editorEngine.ts` + su test + la constante
   `EDITOR_ENGINE_STORAGE_KEY`/`EDITOR_ENGINE_QUERY_PARAM` + la variable de entorno
   `NEXT_PUBLIC_WORDJS_EDITOR_ENGINE` de cualquier `.env.example`/doc de despliegue que la mencione.
   `frontend/src/components/verso/editor/EngineToggle.tsx` (el UI que deja al autor cambiar de
   motor manualmente) se borra aquí también — ya no hay a qué motor cambiar.

**Gate:** 3 modos + navegador. Confirmar que `?engine=legacy` YA NO tiene efecto (no hay nada que lo
lea) y no rompe nada (debe ignorarse en silencio, no crashear).

## Fase 3 — Borrar componentes legacy-only

10. Re-grepear (el árbol puede haber cambiado desde este audit) `@wordjs/puck` y `PuckEditor` en
    `frontend/src` para confirmar que, tras la Fase 2, los únicos importadores que quedan son
    exactamente los que se listan aquí (si apareció alguno nuevo, investigar antes de borrar).
11. Borrar: `frontend/src/components/PuckEditor.tsx`, `PuckEditorSkeleton.tsx`,
    `frontend/src/components/CommandPalette.tsx` (la legacy — `VersoCommandPalette.tsx` es
    independiente y se queda), `frontend/src/components/BlockInserter.tsx`,
    `frontend/src/components/InlineTiptap.tsx`, `frontend/src/components/editor/A11yAudit.tsx`
    **verificar primero** si tiene una variante Verso propia o si Verso ya tiene su propio a11y
    audit (`components/verso/editor/a11y.ts` existe — confirmar si A11yAudit.tsx es legacy-only o
    compartido antes de borrar), `frontend/src/components/puck/SymbolBlock.tsx` **verificar
    primero**: `components/verso/blocks/VersoSymbolBlock.tsx` documenta HOY que no puede montar el
    mismo camino porque está "prohibido" tocar el legacy — tras la Fase 3 esa prohibición ya no
    aplica; re-evaluar si conviene unificar en vez de mantener dos implementaciones de Symbol.
12. `frontend/src/components/puck-theme.css`: NO se borra todavía en este paso (ver Fase 8 — Verso
    todavía la consume como "única fuente" de varios tokens); solo confirmar que ya no queda ningún
    selector en ella que exista SOLO para el legacy que se acaba de borrar (limpieza menor opcional).

**Gate:** `tsc` (el más útil aquí: cualquier import colgante rompe el build), 3 modos + navegador
completo del flujo de edición de página/post/chrome.

## Fase 4 — Borrar los tests-pin del fork/legacy

13. Borrar `frontend/src/lib/__tests__/puckForkDivergence.test.ts` (pinea las 2 divergencias del
    fork — sin objeto una vez el fork se borra en la Fase 5; borrar aquí, un paso antes, para que el
    propio borrado del fork en la Fase 5 no dependa de recordar limpiar esto después).
14. Borrar `frontend/src/components/__tests__/puckEditorWrapper.test.ts` y
    `puckHistoryUndoRedo.test.ts` (prueban `PuckEditor.tsx`, ya borrado en la Fase 3).
15. `frontend/src/app/admin/chrome/__tests__/chromeVersoAdapter.test.ts`: **no borrar entero sin
    revisar** — el nombre sugiere que prueba el ADAPTADOR (`chromeVersoAdapter.tsx`, que sigue vivo
    tras la retirada), no la ruta legacy cruda; puede que solo haga falta quitar un import de
    `chromeEditorConfig`/tipo `Config` si el archivo mezclaba ambos.

**Gate:** `vitest` completo — la suite debe seguir en verde con recuento de tests menor (los
borrados) y ningún test roto por un import colgante.

## Fase 5 — Borrar `frontend/packages/puck` y sus dependencias

16. **Bloqueante a resolver ANTES de este paso** (no es parte del editor legacy — es el sitio
    público): `frontend/src/components/content/PluginBlockHeavy.tsx` importa `Render` de
    `@wordjs/puck` para pintar bloques de plugin/Symbol en el sitio público (la mitad "pesada" de
    `PluginBlockIsland`, lazy-loaded). `ContentRenderer.tsx`/`ChromeRenderer.tsx` YA decidieron (por
    presupuesto de bundle, documentado en su propio código) no depender del `<Render>` del fork para
    los bloques CORE — este es el único punto público que todavía sí depende de él. Construir un
    reemplazo equivalente (mismo patrón que ya usa `ContentRenderer.tsx` para bloques core,
    aplicado al caso plugin/Symbol) es su propio sub-encargo, con su propio gate de performance
    (presupuesto de bundle del programa de performance F0-F5 ya existente) — no una simple
    sustitución de import. Sin esto, `frontend/packages/puck` no se puede borrar sin romper el sitio
    público.
17. Borrar el directorio `frontend/packages/puck/` completo (`bundle/`, `components/`, `dist/`,
    `lib/`, `node_modules/`, `reducer/`, `store/`, `styles/`, `styles.css`, `types/`,
    `globals.d.ts`, `index.ts`, `LICENSE`, `NOTICE.md`, `package.json`, `react-import.js`,
    `tsconfig.json`, `tsup.config.ts`).
18. `frontend/package.json`: quitar `"@wordjs/puck": "*"` de dependencies, quitar el script
    `build:editor` y sus 2 invocaciones en `predev`/`prebuild`.
19. Re-grepear `@wordjs/puck` sobre todo `frontend/src` — debe dar 0 resultados. Si queda alguno,
    NO continuar — significa que algún consumidor no estaba en este plan.

**Gate:** `npm install` limpio (confirma que nada más referencia el workspace borrado), `tsc`,
`vitest`, build de producción de los 3 modos completo, navegador (el sitio público en particular —
este paso es el que más arriesga el camino público por el punto 16).

## Fase 6 — Quitar `@tiptap/*`

20. Re-grepear `@tiptap` sobre `frontend/src` (debe dar 0 tras borrar `InlineTiptap.tsx` en la
    Fase 3 — el motor de texto inline de Verso, F3.5, es "CERO imports de Tiptap" por diseño y
    contrato propio, confirmado en el comentario de cabecera de `VersoInline.tsx`). Si da 0, quitar
    las 8 líneas `@tiptap/*` de `frontend/package.json`.

**Gate:** `npm install`, `tsc`, bundle-size check del programa de performance (una dependencia
grande menos debería REDUCIR el first-load, no solo no romperlo — vale la pena medir y documentar
la mejora).

## Fase 7 — `NOTICE.md`

21. Ya se borró junto con `frontend/packages/puck/` en la Fase 5 (vivía dentro de ese directorio).
    Este paso es solo el registro de que el veredicto de `derivation-audit.md §8` ("puede retirarse
    sin condiciones") ya se ejecutó — no hay acción adicional.

## Fase 8 — Renombrado de infraestructura de bloque compartida (camino PÚBLICO — pase propio, separado)

**No agrupar con las fases 1-7.** Esta fase toca archivos que el sitio público sirve en cada
request (`content/ContentRenderer.tsx`, `content/blocks.tsx`, `content/AccordionBlock.tsx`,
`content/AnimatedShell.tsx`, `content/AudioTransport.tsx`, `content/SearchBarBlock.tsx`,
`content/SelfHostedVideo.tsx`, `content/TabsBlock.tsx`, `content/SharedBlockShell.tsx`,
`lib/useRuntimePuckConfig.ts`) además de Verso (`lib/verso/coreBlocks.tsx`,
`lib/verso/sharedFields.tsx`, `components/verso/editor/VersoEditor.tsx`,
`components/verso/render/VersoBlock.tsx`) — el radio de impacto y el riesgo de regresión en el
camino público (cacheable, sensible a performance por el programa F0-F5 ya ejecutado) es de otro
orden que borrar un editor que ya nadie monta. Hacerlo como su propio cambio, con su propio gate de
performance, cuando las fases 1-7 lleven tiempo estables.

22. `frontend/src/components/puckConfig.tsx` → renombrar (p.ej. `blockDefinitions.tsx`). **Antes de
    renombrar, verificar** si sigue exportando un objeto `Config` de forma de `@wordjs/puck`
    consumido por algo (que para esta fase ya no debería existir, al haberse borrado el fork en la
    Fase 5) o si `lib/verso/coreBlocks.tsx` ya extrajo todo lo que necesita de él — si es lo
    segundo, valorar colapsar su contenido dentro de `coreBlocks.tsx` en vez de solo renombrar el
    archivo, para no mantener dos fuentes de la misma definición de bloque.
23. `frontend/src/components/puck/*` (10 archivos) → mover a un directorio neutral (p.ej.
    `components/blocks/fields/`), actualizar los ~14 importadores reales listados arriba.
24. `frontend/src/lib/useRuntimePuckConfig.ts` → renombrar (p.ej. `useRuntimeBlockRegistry.ts`).
25. `frontend/src/components/puck-theme.css` → renombrar (p.ej. `editor-theme.css`); en el mismo
    commit, renombrar las clases `puck-container` (consumida en `app/globals.css:49-50` y en
    `VersoEditor.tsx:720`) y `puck-editor-ui` (consumida en `puck-theme.css:311-327` y en
    `VersoCommandPalette.tsx:198`) a algo neutral (p.ej. `editor-container`/`editor-portal-ui`), y
    los tokens `--puck-font-family`/`--puck-font-family-monospaced` a `--ed-font-family*` (ya
    conviven con el resto de tokens `--ed-*` — esto es la limpieza final de consistencia, ahora
    posible porque el único otro consumidor, el legacy, ya no existe desde la Fase 3).
26. (Opcional, fuera del frontend — solo anotar, no ejecutar desde aquí) `PUCK_HTML_FIELDS` en
    `backend/src/core/sanitize-meta.ts` es un conjunto de nombres de prop genéricos
    (`content`/`html`/`text`/`title`/...) sin relación real con Puck — buen candidato a
    `HTML_BEARING_FIELDS` para quien mantenga el backend, pero decisión y ejecución de ese equipo,
    no de este plan.

**Gate:** `tsc`/`vitest`/`eslint` + navegador del sitio PÚBLICO (no solo el admin) en los 3 modos,
comparando el first-load contra el baseline del programa de performance F0-F5 — regla dura del
proyecto: no se toca el camino público sin volver a medir.

## Fase 9 — Grep-gate final y README

27. **Grep-gate mecánico** (falla si devuelve algo fuera de las excepciones listadas):

    ```sh
    grep -rniE "puck" \
      --include='*.ts' --include='*.tsx' --include='*.js' --include='*.css' \
      frontend/src backend/src \
      | grep -viE '_puck_data|CONTENT_META_KEY|CHANGELOG'
    ```

    Tras las fases 1-8, el resultado esperado es **vacío** salvo:
    - El literal `"_puck_data"` en sí (la clave de meta persistida — nunca cambia, es formato de
      datos en producción, no nombrado de código).
    - Cualquier `CHANGELOG.md`/nota histórica que narre el propio proceso de migración ("v1.x migró
      de Puck a Verso") — documentación de hechos pasados, no deuda de nombrado.
    - `PUCK_HTML_FIELDS` en `backend/` si el punto 26 no se ejecutó (queda fuera del alcance de este
      plan, que es frontend).

    Si el grep devuelve algo más, es una referencia que este plan no anticipó — investigar antes de
    dar la retirada por completa, no silenciar el gate.
28. Actualizar `.gitignore`: confirmar que las entradas de registries generados apuntan a los
    nombres nuevos (Fase 0, punto 3) y no a rutas ya borradas.
29. Actualizar `README.md` con la sección de abajo (borrador ya redactado — aplicar tal cual o
    ajustar tono, pero el contenido factual ya está verificado contra el código de este árbol).

## §5 — Borrador de sección README (NO aplicado — el legacy convive todavía)

> Insertar como sección propia del README principal, en la parte de arquitectura/editor. Redactado
> para pegarse tal cual una vez ejecutadas las fases 1-7 de este plan (referencias en tiempo
> presente, sin mencionar el flag ni el legacy).

```markdown
## El editor — Verso

WordJS incluye un editor visual de bloques propio, Verso
(`frontend/src/components/verso/`, `frontend/src/lib/verso/`): arrastrar-y-soltar, edición de
texto in situ, deshacer/rehacer, paleta de comandos y panel de propiedades, todo construido sobre
un núcleo propio sin dependencias de terceros para el estado del editor, el resolutor de
arrastre-y-suelta ni el motor de texto enriquecido.

**Arquitectura en 10 líneas:** el documento vive como un árbol normalizado (mapa id→nodo) mutado
exclusivamente por comandos dentro de transacciones con historial por parches inversos
(`lib/verso/store.ts`). El lienzo es un iframe con un documento propio al que el árbol de React se
telepórtala vía portal (`components/verso/canvas/FrameController.tsx`) — sin mezclar hojas de
estilo del padre. La capa de selección/arrastre/barra de acciones vive siempre en el documento
padre, medida por un `GeometryStore` propio (`components/verso/overlay/`), nunca dentro del
iframe. El resolutor de destino de arrastre (`lib/verso/dnd/resolve.ts`) es una función pura sin
dependencia de ninguna librería de DnD. El texto enriquecido se edita con un motor de edición
propio sobre `contenteditable` (`lib/verso/inline-engine/`), sin Tiptap ni ProseMirror. Los
bloques (core y de plugins de marketplace) se declaran contra un contrato de campos propio
(`lib/verso/registry.ts`) inspirado, por compatibilidad, en la forma de campos popularizada por
Puck — ver crédito abajo.

**Formato de documento:** el contenido se persiste como `{ content: [...], root: {...} }`, el
mismo formato que usó desde el principio el editor de bloques de WordJS.

**Crédito de cortesía:** las primeras versiones del editor de WordJS se construyeron sobre un
fork vendorizado de [Puck](https://github.com/measuredco/puck) (`@measured/puck`, MIT). Verso es
una reescritura completa e independiente — no comparte código, estructuras de datos internas ni
dependencias con Puck — pero el formato de documento persistido y la forma del contrato de campos
de bloque se diseñaron a propósito para seguir siendo compatibles con esa herencia, por respeto al
proyecto que dio forma a esa idea. Esta mención es una cortesía, no una obligación de la licencia
MIT (WordJS no redistribuye ni deriva código de Puck en el editor actual).
```
