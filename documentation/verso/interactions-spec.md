# Spec ejecutable — motor de interacciones de Verso (F9)

**Estado**: spec previa a codificar. Misma técnica que el DnD y el motor inline: **tabular y decidir
ANTES de escribir código**.

**Tesis**: no construimos "un Webflow IX3 con otro nombre". Construimos un **compilador de
interacciones a CSS nativo** con un runtime mínimo para lo que el CSS no puede expresar. El camino
feliz (entrada por viewport y scrub de scroll) sale de la página con **cero bytes de JavaScript**.
Eso no es una micro-optimización: es lo que nos separa de IX3, que carga GSAP + ScrollTrigger en
toda página con interacciones y necesita un mecanismo explícito anti-FOUC para tapar el hueco.

---

## 0. Fuentes de verdad

### 0.1 Leídas en el árbol (no de memoria)

| Fichero | Qué aporta al diseño |
|---|---|
| `backend/public/css/wordjs-ui.css` L1029–1086 (`ENTRANCE ANIMATIONS`) | 12 entradas `.wjs-anim-<t>[data-wjs-anim="in"]` + `@keyframes`, TODO dentro de `@media (prefers-reduced-motion: no-preference)`. Contrato: `to` siempre neutro. |
| `backend/public/css/wordjs-ui.css` L2626–2725 (`SCROLL-DRIVEN INTERACTIONS`) | `@supports (animation-timeline: view())`, `animation-range: cover 0% cover 100%`, intensidad como clase discreta `wjs-scroll-amt-10…100`. **Y la verruga documentada**: entrada y scroll pelean por `transform`, "gana el scroll" con reglas 0,3,0. |
| `frontend/src/components/puck/blockShell.ts` | `AnimSpec`, `animClasses()`, `appearanceToStyle()` — puras, sin `"use client"`, compartidas por editor y público. El sitio donde vive el nuevo tipo. |
| `frontend/src/components/content/SharedBlockShell.tsx` | Las 4 ramas del wrapper y las **DOS capas anidadas** (entrada ↔ apariencia jamás comparten elemento porque `animation-fill-mode: both` mataría el `:hover`). |
| `frontend/src/components/content/AnimatedShell.tsx` | La ÚNICA rama hidratada. Clampa `duration` 100–3000 y `delay` 0–3000 en el render. |
| `frontend/src/components/puck/entranceAnimation.ts` | `IntersectionObserver` con `threshold: 0` (comentario: no "afinar"), `ANIM_REPLAY_EVENT` como evento DOM para cruzar el iframe, limpieza que nunca deja el bloque `armed`-invisible. |
| `frontend/src/lib/verso/types.ts` | El contrato duro: `_puck_data` **byte-exacto**, `keyOrder`, gate `verso-roundtrip.test.ts` sobre el corpus de producción. |
| `frontend/src/lib/verso/sharedFields.tsx` | `withSharedVersoFields` inyecta `hide`/`anim`/`look` con defaults byte-idénticos; `clampAnimSpec` clampa en la frontera de ESCRITURA además del render. Opt-out: una def que ya declare `fields.hide`. |
| `frontend/src/components/verso/canvas/FrameController.tsx` L166–208 | `swapThemeCss(url)` escribe un `<link>` **imperativamente en el `head` del iframe**, y el contenido va por `createPortal(children, root)` desde la raíz React del documento PADRE. |
| `frontend/src/components/public/ThemeLoader.tsx` | Grupos de `precedence` en React 19: `wjs-base` (framework) < `wjs-theme`. Render-blocking a propósito, contra el FOUC. |
| `frontend/package.json` | React **19.2.8**, Next **16.1.1** → `<style href precedence>` con deduplicación por `href` está disponible. |

### 0.2 Verificado en la web (agosto 2026)

**CSS scroll-driven animations** — `animation-timeline`, global **85,43 %** (caniuse):

| Navegador | Estado real | Nota |
|---|---|---|
| Chrome / Edge | **115+** (jul 2023) | Completo, incluido `timeline-scope`. |
| Safari | **26.0+** (sep 2025) | Confirmado en el blog de WebKit («WebKit Features in Safari 26.0»). Fuentes secundarias citan además scroll-driven *en el hilo del compositor* en 26.4 y correcciones de precisión de progreso / `animation-play-state` en 26.5 (jun 2026) — **no verificado en fuente primaria**, no se apoya ninguna decisión en ello. |
| Firefox | **NO en release** | Tras `layout.css.scroll-driven-animations.enabled`. Activo por defecto **solo en Nightly (136+)**. `animation-range-*` llegó en 151, `<timeline-range-name>` en selectores de `@keyframes` en 152. **`timeline-scope` no está implementado.** Prioridad Interop 2026. |

> ⚠ Hay artículos de blog de 2026 afirmando "Firefox 132+ lo soporta" y "soporte universal". **Son
> falsos.** MDN *Experimental features* y caniuse coinciden: en release sigue flagueado (caniuse
> apunta al 156, aún no publicado). **El fallback no es una cortesía: es el camino de Firefox.**

**`@property`** — Baseline: Chrome 85, Safari 16.4, Firefox 128. Permite interpolar variables
tipadas. Sin soporte degrada a variable sin tipo (salta en vez de interpolar). **Disponible, pero
ver §4.4: NO va en el camino caliente.**

**`timeline-scope`** — todo menos Firefox; `timeline-scope: all` solo Safari y derivados.
Especificación aún en Editor's Draft. **Fuera de alcance en F9-A/B.**

**Webflow IX3 ("Interactions with GSAP", 2025→2026)** — verificado en su Help Center y blog:
timeline horizontal con acciones sobre pistas; triggers *page load*, *click* (primer clic), *hover*
(mouse-enter/mouse-leave), *scroll* (ScrollTrigger con scrub), *mouse move* (continuo), eventos
personalizados; ajustes por evento *Control* (play / pause-resume / stop / no action / toggle
play-reverse), *Speed*, *Jump to*, *Delay*; **SplitText** por carácter, palabra o línea; **Stagger**
de grupos; **presets** de acción ("Save as preset", reutilizables desde el panel Interactions);
interacciones con ámbito de componente y Shared Libraries. Limitaciones **suyas, declaradas**: no
soporta triggers específicos de widget (navbar, tabs, dropdown, slider); la prevención de FOUC
—inyectar `visibility: hidden !important` y quitarlo con la clase `w-mod-ix3`— **no aplica con
scoping complejo o selectores dinámicos**; "inclusive motion design" (respetar reduced-motion desde
el panel) sigue anunciado como futuro, hoy es *conditional playback* opcional.

---

## 1. Matriz frente a IX3 — qué igualamos, qué descartamos, qué superamos

| Capacidad IX3 | Decisión | Razón |
|---|---|---|
| Timeline de pasos con easing por paso | **IGUALAR** | `@keyframes` con `animation-timing-function` dentro del selector de paso es 1:1. |
| Triggers load / hover / click / scroll-scrub / entrada en viewport | **IGUALAR** | §3.2. |
| Stagger sobre hijos | **IGUALAR** | Reglas `:nth-child()` generadas → CSS puro. |
| Presets reutilizables | **SUPERAR** | Los suyos son **copia al aplicar**; los nuestros son **por referencia** (§3.5). |
| Ámbito por componente / Shared Libraries | **IGUALAR** | Nuestro equivalente ya existe: símbolos (`lib/symbols.ts`). |
| SplitText por **palabra** | **IGUALAR (acotado)** | Solo en bloques que lo declaren, con `aria-label` + `aria-hidden`. |
| SplitText por **carácter** y por **línea** | **DESCARTAR** | Carácter: coste a11y real (lectores de pantalla deletrean) y rompe el motor inline. Línea: exige medición del texto renderizado → imposible en SSR, y el markup del canvas y del público deben salir del MISMO código. |
| Trigger *mouse move* continuo | **DESCARTAR** | Un handler por movimiento de ratón en el hilo principal, inexpresable en CSS, y sin caso de uso en un CMS de contenido. |
| Grafo de acciones con dependencias arbitrarias | **DESCARTAR** | Es un editor de motion, no un CMS. Tope explícito en §6. |
| Triggers específicos de widget | **DESCARTAR** | IX3 tampoco los tiene. |
| Motor de animación | **SUPERAR** | Ellos: GSAP + ScrollTrigger (+ SplitText) en **toda** página con interacciones. Nosotros: **0 bytes de JS** en el camino feliz; el runtime solo baja si la página tiene algo que el CSS no expresa, o si el navegador no soporta scroll-driven. |
| Prevención de FOUC | **SUPERAR** | Su solución es tapar con `visibility: hidden !important` desde JS y confesar que falla con selectores dinámicos. En el camino nativo el frame 0 lo aplica `animation-fill-mode: both` **antes del primer paint**: no hay nada que tapar. |
| `prefers-reduced-motion` | **SUPERAR** | En IX3 es opcional (*conditional playback*). Aquí es **absoluto y sin escape**: §7.2. |
| Composición de dos animaciones sobre `transform` | **SUPERAR** | Ellos resuelven en runtime (GSAP). Hoy nosotros lo resolvemos con "gana el scroll" (verruga documentada en ui.css L2635–2642). El compilador lo resuelve **en compilación**: §4.3. |

---

## 2. Contrato — las 5 restricciones duras, y dónde las impone el diseño

| # | Restricción | Cómo la impone este diseño (no por disciplina, por construcción) |
|---|---|---|
| 1 | `_puck_data` byte-exacto | La interacción es **una prop del bloque** (`ix`), sin default, sin almacén paralelo. Los presets viven FUERA del documento y el bloque guarda solo un **id**: editar un preset no toca ni un byte de `_puck_data`. |
| 2 | Un tema jamás envía JS | Los presets NO viven en el tema (§3.5). El runtime es una isla del SITIO. El tema solo puede influir vía tokens, como siempre. |
| 3 | Cero CLS | El **tipo** `IxProps` es una lista cerrada de 8 propiedades, todas de compositor. Nada fuera de esa lista es representable, así que nada fuera de esa lista puede llegar al CSS. Un fuzz lo verifica. |
| 4 | reduced-motion siempre | Todo el CSS generado se emite dentro de `@media (prefers-reduced-motion: no-preference)`; el runtime consulta la media query y no arma. **Sin override por bloque ni por sitio.** |
| 5 | Mismo markup canvas ↔ público | El compilador es **puro** y vive en `blockShell.ts` (sin `"use client"`). Las clases del bloque salen de `ixClasses()`, una función, dos superficies. Solo cambia el **canal de entrega de la hoja**, que ya es distinto hoy para el tema (`ThemeLoader` vs `swapThemeCss`). |

---

## 3. DECISIÓN 1 — Modelo de datos

### 3.1 La prop

Clave: **`ix`**. Se inyecta en `withSharedVersoFields` junto a `hide`/`anim`/`look`, **sin
`defaultProps`**.

> Por qué sin default, a diferencia de `anim: { type: "fade-up", … }`: un default cambia los bytes
> de todo bloque nuevo. `anim` lo hace porque su default es una decisión de diseño (todo bloque
> nuevo aparece subiendo). `ix` no tiene un valor "por defecto" que signifique algo; su ausencia ES
> el valor. Bloque sin tocar → la clave no existe → los bytes de hoy y de mañana son idénticos.

```ts
/** Una interacción, serializable, en las props del bloque. blockShell.ts — PURO. */
export type IxSpec = {
  /** Versión del formato. Un lector viejo con v desconocida IGNORA la interacción (fail-open). */
  v: 1;
  /** Referencia a un preset de sitio. Si está, `tracks` NO puede estar (§3.5). */
  preset?: string;
  trigger?: IxTrigger;
  tracks?: IxTrack[];
};
```

### 3.2 Disparador

```ts
export type IxTrigger =
  | { on: "view";  once?: boolean; range?: IxRange }   // entrada en viewport
  | { on: "scrub"; range?: IxRange; src?: "self" | "page" }
  | { on: "hover" }
  | { on: "click"; toggle?: boolean }
  | { on: "load";  delay?: number };

/** Mapea 1:1 a `animation-range`. Nombres de la spec, sin traducir. */
export type IxRange = { from: IxEdge; to: IxEdge };
export type IxEdge = { at: "cover" | "contain" | "entry" | "exit"; pct: number };
```

`IxEdge` es deliberadamente el vocabulario de la especificación (`cover 0%`, `entry 100%`…): un
modelo intermedio "amigable" tendría que traducirse en los dos sentidos y perdería casos. El panel
traduce a lenguaje de autor; el DATO no.

### 3.3 Pistas y pasos

```ts
export type IxTrack = {
  target: IxTarget;
  /** ≥2 pasos, `at` estrictamente creciente, primero 0 y último 100. Máx. 6 (§6). */
  steps: IxStep[];
  dur?: number;                    // ms — solo triggers temporales (load/hover/click/view-once)
  delay?: number;                  // ms
  repeat?: number | "inf";
  alt?: boolean;                   // alternate
  stagger?: { each: number; from?: "start" | "end" | "center" };
};

export type IxStep = {
  at: number;                      // 0..100 — % de la pista (tiempo o rango de scroll, mismo eje)
  set: IxProps;
  /** Easing DE ESTE PASO AL SIGUIENTE. Se emite en el selector del paso. Ignorado en el último. */
  ease?: "linear" | "in" | "out" | "in-out" | "spring" | "back";
};

/** LISTA CERRADA. La restricción "cero CLS" vive AQUÍ, en el tipo. */
export type IxProps = Partial<{
  opacity: number;   // 0..1
  x: number;         // px   → translate3d
  y: number;         // px   → translate3d
  scale: number;     // 1 = neutro
  rotate: number;    // deg  (Z)
  rotateX: number;   // deg  (requiere perspective en la capa, como hace hoy .wjs-anim-flip)
  blur: number;      // px   → filter
  clip: number;      // 0..100 % de revelado → clip-path: inset()
}>;
```

Ocho propiedades. `width`, `height`, `margin`, `padding`, `top/left`, `font-size` **no son
representables**. No hay nada que auditar en el compilador: si no está en el tipo, no llega.

### 3.4 Objetivo

```ts
export type IxTarget =
  | { kind: "self" }
  | { kind: "children" }                 // hijos DIRECTOS del bloque (para stagger)
  | { kind: "words" }                    // solo bloques que declaren soporte (§3.4.1)
  | { kind: "block"; id: string };       // otro bloque, por props.id
```

**3.4.1 `words`** — solo en definiciones que declaren `ixText: true` (F9-D: `Heading` y `Quote`).
El renderer —el MISMO código en canvas y público— parte el texto en
`<span class="wjs-ixw" style="--wjs-ixv-i:3">` y pone `aria-label` con el texto íntegro en el contenedor y
`aria-hidden="true"` en los spans. Máx. 40 palabras; a partir de ahí no se parte (fail-open al
texto normal).

**3.4.2 `block`** — el objetivo externo se resuelve **siempre por runtime** en F9-A/B. En CSS puro
exigiría `timeline-scope`, que Firefox no implementa y cuyo valor `all` solo tiene Safari. Se
reevalúa en F9-C con gate propio; hasta entonces, un objetivo externo marca la unidad como
`needsRuntime` y punto.

### 3.5 Presets — el killer feature

**DECISIÓN: los presets viven en AJUSTES DEL SITIO** (una opción de backend, `wjs_ix_presets`), no
en el documento y no en el tema.

| Ubicación | Veredicto | Razón |
|---|---|---|
| En el tema | **NO** | Cambiar de tema borraría el movimiento de todas las páginas. Y un tema es su contrato de tokens y nada más (decisión ratificada 2026-08-05). Ningún tema debe poder decidir *cuándo* se mueve el contenido. |
| En el documento (`root.props`) | **NO** | Un preset de página no se comparte entre páginas → no es el killer feature, es una variable local. Y editarlo reescribiría N documentos: N revisiones, N purgas de caché, N oportunidades de romper el round-trip. |
| **En ajustes del sitio** | **SÍ** | Una fila, una etiqueta de purga, alcance global. Y sobre todo: **el bloque guarda un id, no un cuerpo**. |

```ts
export type IxPreset = {
  id: string;            // slug estable: "aparecer-tarjetas"
  name: string;
  trigger: IxTrigger;
  tracks: IxTrack[];
  /** Entero monótono. Entra en el hash del CSS (§4.5) para invalidar el caché del navegador. */
  rev: number;
};
```

**Cómo propaga un cambio sin tocar `_puck_data`** — porque no hay nada que tocar:

```
_puck_data:   { type: "Card", props: { id: "abc", ix: { v: 1, preset: "aparecer-tarjetas" } } }
                                                          └─ referencia, 24 bytes, inmutable
ajustes:      wjs_ix_presets["aparecer-tarjetas"] = { …cuerpo…, rev: 7 }
                                                                      └─ lo único que cambia
```

Guardar el preset → `rev++` → purga de la etiqueta `ix-presets` (mismo mecanismo que ya usa
`settings` en `core/frontend-purge.ts`) → la siguiente navegación de cada página recompila y emite
CSS con un hash nuevo. **El diff de `_puck_data` es literalmente vacío.** El gate F9-E es
exactamente esto.

**Overrides locales, acotados.** Un bloque con `preset` PUEDE llevar además `trigger`, y dentro de
él nada más. No puede llevar `tracks` (sería una bifurcación silenciosa que rompe la propagación).
Si el autor quiere cambiar los pasos, el panel ofrece **"Desvincular del preset"**: copia el cuerpo
a `tracks`, borra `preset`, y a partir de ahí es suyo. Una sola dirección, explícita, visible.

**Presets de sistema.** Los 12 tipos de entrada y los 4 efectos de scroll actuales se exponen como
presets de solo lectura con id `sys:fade-up`, `sys:parallax`, … Compilan al MISMO recorrido visual
que las clases estáticas de `wordjs-ui.css` (gate de paridad visual en F9-B). No sustituyen a
`anim`: coexisten (§6.4).

**Referencia rota** (preset borrado o `v` desconocida) → la unidad no se compila, el bloque se
renderiza sin interacción, visible. **Fail-open siempre**: la única forma de fallar es no moverse.

---

## 4. DECISIÓN 2 — Compilación a CSS nativo

### 4.1 La tubería

```
IxSpec (+ presets)  ──compileIx()──▶  IxUnit[]  ──┬──▶ ixCss(units)      → texto CSS   (backend nativo)
   dato del bloque      PURA            IR         └──▶ ixKeyframes(u)   → Keyframe[]  (backend WAAPI)
```

Un IR, **dos backends**. El backend WAAPI no es trabajo extra del fallback: lo consumen tres
clientes — el fallback de Firefox (§5), el scrubber del panel (§6.3) y los tests de paridad
(comparar recorridos sin navegador). Ese es el motivo de que el IR exista.

```ts
export type IxUnit = {
  hash: string;               // 7 chars base36 — §4.5
  cls: string;                // "wjs-ix-<hash>"
  rules: string[];            // reglas CSS listas (ya dentro de su @media/@supports al emitir)
  kf: Record<string, Keyframe[]>;  // nombre → pasos, para el backend WAAPI
  needsRuntime: "never" | "always" | "no-native";
};
```

### 4.2 Qué se expresa en CSS puro y qué no — la matriz que manda

| Trigger / caso | ¿CSS puro? | Traducción | `needsRuntime` |
|---|---|---|---|
| `scrub` (progreso ligado al scroll) | **SÍ** | `animation-timeline: view()` \| `scroll()`, `animation-range: <from> <to>`, `animation-duration: 1ms` (dummy), `fill-mode: both` | `no-native` |
| `view`, `once: false` (entra y sale) | **SÍ** | igual, con rango `entry 0% cover 40%` | `no-native` |
| `view`, **`once: true`** (la entrada de hoy) | **NO** | No existe *latch* en CSS: `view()` retrocede al subir. **Este es el hallazgo que justifica conservar el `IntersectionObserver` actual tal cual.** | `always` |
| `load` | **SÍ** | `animation` temporal normal, sin timeline | `never` |
| `hover`, 2 pasos | **SÍ** | `transition` sobre el estado `:hover` de la capa ix | `never` |
| `hover`, ≥3 pasos | **SÍ** | `.wjs-ix-<h>:hover { animation-name: … }` en la **capa ix**, que es propia — no comparte elemento con la apariencia ni con la entrada (misma razón que ya obligó a las dos capas anidadas) | `never` |
| `click` | **NO** | Sin *latch* en CSS. `:target` es un truco de URL; el *checkbox hack* exige cambiar el markup y eso viola la restricción 5. | `always` |
| `stagger` sobre `children` | **SÍ** | `.wjs-ix-<h> > :nth-child(k) { animation-delay: calc(<k-1> * <each>ms) }`, k = 1..24 | igual que su trigger |
| `stagger` sobre `words` | **SÍ** | `--wjs-ixv-i` inline por span + `calc(var(--wjs-ixv-i) * <each>ms)` | igual que su trigger |
| `target: block` (otro bloque) | **NO** (F9-A/B) | Exigiría `timeline-scope`; Firefox no lo implementa | `always` |
| Secuencia con dependencias entre pistas | **N/A** | Descartado (§1) | — |

`needsRuntime: "no-native"` significa: el CSS lo hace en Chrome y Safari 26+, y **solo en un
navegador sin `animation-timeline`** hace falta el runtime.

### 4.3 Composición: se resuelve en COMPILACIÓN

Hoy `wordjs-ui.css` documenta el problema y lo resuelve por decreto ("cuando hay efecto de scroll,
GANA el scroll"), porque dos `animation` sobre el mismo elemento pelean por `transform` y la última
gana por propiedad. El compilador no tiene ese problema: si una pista pone `x`, `y`, `scale` y
`rotate` en el paso 3, emite **una declaración literal**:

```css
@keyframes wjs-ixk-a3f9c1 {
  0%   { animation-timing-function: cubic-bezier(.16,1,.3,1);
         opacity: 0; transform: translate3d(0,28px,0) scale(.96); }
  100% { opacity: 1; transform: translate3d(0,0,0) scale(1); }
}
```

Alternativas consideradas y **rechazadas**:

- `animation-composition: add` — resolvería la superposición en el navegador. Rechazada: añade
  varianza entre motores justo en el punto que menos varianza tolera, y su interacción con
  timelines de scroll está menos pisada. Componer en compilación es determinista y **testeable sin
  navegador**.
- Variables registradas con `@property` compuestas en un solo `transform` — ver §4.4.

### 4.4 `@property`: sí, pero NO en el camino caliente

Es tentador registrar `--wjs-ixv-x`, `--wjs-ixv-scale`… y escribir
`transform: translate3d(var(--wjs-ixv-x), …)`, dejando que cada pista anime su variable.
**Rechazado para el camino caliente**: una animación de propiedad personalizada tiene que
recalcularse en el **hilo principal**, y el `transform` que depende de ella deja de poder subir al
compositor. Cambiaríamos un problema de composición —ya resuelto en compilación— por una
regresión de rendimiento en la única parte que el contrato de §7 promete que no la tendrá.

`@property` se usa **exactamente para dos cosas**:

1. Registrar los escalares **estáticos** que el CSS lee con `calc()` (el papel que hoy hace
   `--wjs-scroll-amt`): `@property --wjs-ixv-amt { syntax: "<number>"; inherits: false; initial-value: 30 }`.
   No se animan; se tipan, para que `calc()` sea robusto y la herencia sea explícita.
2. Transiciones de **hover** de valores que no son de compositor y ya cuestan hilo principal.

Estas variables son **propiedad del motor**, no seams de tema: se llaman `--wjs-ixv-*` (nunca
`--wjs-ix-*`, que es el prefijo de las clases) y se **excluyen explícitamente** del manifiesto
`public/theme-tokens.json`. Si no se excluyen, `theme-doctor` las listará como tokens skinables y
las estaremos prometiendo sin querer. **Gate de F9-B.**

### 4.5 Nombrado determinista

```
hash = fnv1a32( canonicalJson(unidadCompilada) ).toString(36).padStart(7,"0").slice(-7)
clase          .wjs-ix-<hash>
keyframes      @keyframes wjs-ixk-<hash>[-<n>]      (n = índice de pista, solo si hay ≥2)
```

- **`canonicalJson`**: claves ordenadas, números normalizados (sin `-0`, 4 decimales fijos),
  `undefined` omitido. Así el hash no depende del orden de claves que traiga `_puck_data` ni de
  cómo el panel construyó el objeto.
- **La entrada del hash es la unidad COMPILADA, no el `IxSpec`**: dos bloques, uno con el preset y
  otro con el cuerpo desvinculado idéntico, comparten hash y comparten reglas. Un preset usado en
  40 bloques emite **un** juego de reglas.
- **Nunca** entran el id del bloque, su posición, ni la hora de guardado. Reguardar sin tocar la
  interacción reemite CSS **byte-idéntico** → diffs limpios.
- **FNV-1a de 32 bits**, no criptográfico: esto es una clave de caché, no una frontera de
  seguridad. El dominio de colisión es una página (decenas de unidades). Y la colisión se **detecta
  al emitir**: si dos cuerpos distintos reclaman el mismo hash, el emisor ordena los cuerpos por su
  JSON canónico y sufija `-1`, `-2`… — determinista, sin estado.
- **`rev` del preset entra en el hash**: editar el preset cambia el hash → cambia el `href` de la
  hoja → el navegador no puede servir CSS viejo.

### 4.6 Dónde se emite — tres superficies, un compilador

| Superficie | Canal | Por qué |
|---|---|---|
| **Sitio público** | `<style href="wjs-ix-<pageHash>" precedence="wjs-ix">{css}</style>` desde el componente de servidor de la página | React 19 **deduplica por `href`** y **hoistea a `<head>`** como recurso render-blocking: cero FOUC, cero CLS, y una sola etiqueta aunque 40 bloques compartan preset. Se declara **después** de `wjs-base` y `wjs-theme` en `ThemeLoader`, para que el orden de cascada sea framework < tema < interacciones. `href` **sin espacios** (React avisa si los hay). |
| **Canvas del editor** | `swapIxCss(css)` — hermano de `swapThemeCss(url)` en `VersoCanvasApi`, escribiendo un único `<style id="wjs-ix">` en el `head` del **iframe** | ⚠ **Aquí no sirve el hoisting de React.** El canvas es un iframe y el contenido llega por `createPortal` desde la raíz React del documento **padre** (`FrameController.tsx:208`), así que el hoisting de recursos apunta al `head` del padre y la hoja **nunca llegaría al canvas**. Es exactamente el motivo por el que el `<link>` del tema ya se inyecta a mano ahí. Mismo compilador, mismos bytes; solo cambia el canal, que ya era distinto. |
| **Estáticos** | `wordjs-ui.css` | Los registros `@property`, el `perspective` de la capa cuando hay `rotateX`, y el bloque `@media (prefers-reduced-motion: reduce) { … animation: none !important }`. Nada generado duplica lo que ya es estático. |

**Descartado — `<style>` por bloque**: N etiquetas idénticas cuando N bloques comparten preset, y
sin deduplicación posible en el canvas.
**Descartado — hoja por página servida por HTTP**: un round-trip extra en el camino crítico, una
ruta nueva, y un problema de invalidación que la deduplicación por `href` ya resuelve gratis.
**Descartado — variables inline + reglas estáticas** (lo que hace el contrato de bloques hoy): no
alcanza. Las variables inline pueden parametrizar una animación existente (intensidad, duración),
pero no pueden **crear** un `@keyframes` con los pasos que el autor definió. Por eso hay compilador
y no solo tokens. Lo que **sí** se conserva del patrón: los valores escalares por bloque siguen
viajando inline (`--wjs-ixv-amt`, `--wjs-ixv-i` del split), y las reglas viven en la hoja.

> ⚠ **Pendiente de verificar EN NAVEGADOR antes de dar F9-B por hecho**: que `<style precedence>`
> emitido desde el árbol portaleado no aterriza en el iframe. Es lectura estructural del código, no
> observación. Si resultara que sí aterriza, el canal del canvas se simplifica; el resto del diseño
> no cambia.

---

## 5. DECISIÓN 3 — Fallback

### 5.1 Cuándo baja JS, y cuánto

El servidor **ya compiló la página**, así que sabe exactamente qué hace falta:

| Situación de la página | Qué se carga |
|---|---|
| Sin interacciones | **Nada.** Ni una etiqueta. |
| Solo unidades `no-native` (scrub / view no-once) | Una isla ínfima que hace `CSS.supports("animation-timeline", "view()")` y, si es `true`, **retorna sin observar nada**. |
| Alguna unidad `always` (click, objetivo externo, `view`+`once`) | La isla de eventos, siempre. |
| `no-native` **y** navegador sin soporte | La isla de eventos hace `import()` de `ix-scrub` **en ese momento**. |

El troceado es de **bundle**, no solo de runtime: `IxRuntimeScrub` es un chunk aparte que Chrome y
Safari 26+ **nunca descargan**. El gate F9-C lo verifica sobre las peticiones de red, no sobre una
promesa.

Entrega: isla cliente Next (`next/dynamic`, `ssr: false`) renderizada **solo** si el manifiesto de
la página lo pide. Nada de `<script>` externo — CSP estricta, cero orígenes externos (regla del
programa de rendimiento).

### 5.2 El driver de scrub

**Descartado el polyfill `flackr/scroll-timeline`**: parchea el CSSOM globalmente, es grande, y
tendría que reparsear nuestra hoja generada para descubrir lo que nosotros ya sabemos como dato.

En su lugar, el runtime recibe el IR (`kf` + rango + objetivo) directamente:

1. Un **único** `IntersectionObserver` decide qué unidades están en pantalla.
2. Un **único** bucle `rAF`, activo solo mientras haya unidades en pantalla, recorre las activas.
3. Por unidad: progreso = posición del elemento dentro de su rango (`getBoundingClientRect` +
   alto del viewport), y se aplica con **WAAPI**:
   `anim = el.animate(kf, { duration: 1, fill: "both" }); anim.pause(); anim.currentTime = p;`
   La animación no corre: se **posiciona**. Es la misma técnica que el scrubber del panel (§6.3).
4. Listeners `scroll`/`resize` **pasivos**, coalescidos por el `rAF` (nunca trabajo dentro del
   listener).

Presupuesto: **≤ 4 KB gz** para `ix-scrub`, **≤ 2 KB gz** para la isla de eventos.

### 5.3 Entrada `once` — no es un fallback, es el camino

`view` + `once: true` usa el `IntersectionObserver` que **ya existe** (`entranceAnimation.ts`), en
todos los navegadores, sin cambios: `threshold: 0`, sin `rootMargin` negativo, limpieza que nunca
deja el bloque armado-invisible, y `ANIM_REPLAY_EVENT` como evento DOM para cruzar el iframe. No se
toca ni una línea. El motor nuevo **reutiliza** ese arnés y le añade la capacidad de arrancar
también unidades `ix`.

---

## 6. DECISIÓN 4 — El editor

### 6.1 Tres niveles, y el autor solo ve el que pidió

| Nivel | Qué muestra | Para quién |
|---|---|---|
| **1 — Preajuste** (por defecto) | Un `<select>` de presets (sistema + del sitio), intensidad, velocidad. **Es literalmente el `AnimationField` de hoy** con otra lista. | El 90 %. Nunca ve el nivel 2. |
| **2 — Disparador** | *Cuándo*: al entrar en pantalla / con el scroll / al pasar el ratón / al hacer clic / al cargar. *A quién*: este bloque / sus hijos, escalonados / las palabras del titular. Sin timeline. | El autor que ya sabe lo que quiere. |
| **3 — Pasos** (tras un disclosure "Editar pasos") | Tira horizontal de pasos con su `%`, y por paso una fila con las 8 propiedades y su easing. | El diseñador. |

### 6.2 Los topes, y por qué son estos

**6 pasos por pista, 3 pistas por bloque, 24 hijos con stagger, 40 palabras, 30 unidades por
página.** No son cifras redondas por gusto:

- **6 pasos** es donde la tira deja de caber en el ancho del panel sin scroll anidado — y una
  animación de entrada con 7 puntos de control no es una animación de entrada.
- **3 pistas** es el punto en que el autor deja de poder razonar sobre qué se mueve a la vez.
- **24 hijos** es el tope de reglas `:nth-child()` generadas; a partir de ahí todos comparten el
  retardo del 24.º (documentado, no silencioso).
- **30 unidades por página** es el presupuesto de bytes de §7.3.

Superado un tope, el compilador **no rompe el render**: emite lo que cabe y registra un aviso
visible en el panel. Nunca una página en blanco por un exceso de movimiento.

### 6.3 Previsualización

- **Replay**: el botón de play que ya existe. `ANIM_REPLAY_EVENT` se extiende para re-armar también
  las unidades `ix`. Mismo evento DOM, misma razón (cruza el iframe sin puente React).
- **Scrubber**: para las unidades de scrub, un `range` 0–100 en el panel. Mientras el autor
  arrastra, el canvas aplica una animación **WAAPI pausada** sobre el bloque con
  `currentTime = valor` — el **mismo backend** del fallback (§5.2). No se puede "scrubbear" una
  `view()` desde un slider; posicionar una WAAPI equivalente sí, y es exacto porque sale del mismo IR.

  **DESVIACIÓN AL IMPLEMENTAR (F9-D): se retira con un CONMUTADOR explícito, no "al soltar".**
  Esta sección decía que la animación se retiraba al soltar el ratón. Con teclado no existe soltar:
  quien mueve el `range` con las flechas nunca dispararía esa retirada y se quedaría con el bloque
  congelado a mitad de animación, sin forma de recuperarlo salvo deseleccionando. El control es por
  tanto un botón `aria-pressed` que arma y desarma el modo, y al desarmarlo se cancelan las WAAPI y
  el CSS nativo retoma. Mismo mecanismo, disparador accesible.

### 6.4 Migración desde `AnimationField` — **cero migración automática**

`anim` **no se toca, no se reescribe, no se convierte.** Sigue produciendo exactamente las clases
`wjs-anim-*` / `wjs-scroll-*` de hoy, con el mismo CSS estático.

Por qué no migrar automáticamente: reescribir `anim`→`ix` en las páginas guardadas cambia bytes de
`_puck_data` en cada una. Eso **rompe el gate de round-trip**, invalida el caché de todas, genera
una revisión por página, y **el visitante no ve ninguna diferencia**. Coste alto, beneficio cero.

Lo que sí hay:

- Los 12 tipos de entrada y los 4 de scroll existen **también** como presets de sistema
  (`sys:fade-up`…) para bloques nuevos.
- Un botón **"Convertir a interacción"** por bloque: escribe el `ix` equivalente y limpia `anim`.
  Manual, por bloque, reversible con deshacer.
- **Precedencia cuando ambos están puestos: gana `ix`, `anim` se ignora**, y el panel lo dice. Es
  la misma regla de especificidad que el efecto de scroll ya aplica hoy sobre la entrada; una sola
  regla, no una tabla de combinaciones.

---

## 7. DECISIÓN 5 — Rendimiento y accesibilidad como contrato

### 7.1 Cero CLS, por construcción

- El tipo `IxProps` cierra el conjunto a 8 propiedades de compositor. **El contrato vive en el
  tipo**, no en una revisión de código.
- El HTML servido **nunca** oculta nada: ninguna unidad `ix` puede producir `opacity: 0` en SSR.
  El estado inicial lo pone el navegador —`animation-fill-mode: both` en el camino nativo, el
  runtime en el otro—, jamás el servidor. Rastreadores y visitantes sin JS ven todo.
- En el camino nativo el frame 0 se aplica **en la primera resolución de estilo, antes del primer
  paint**: no hay destello y no hay nada que tapar. Es literalmente el problema que IX3 resuelve
  inyectando `visibility: hidden !important` desde JS, y confesando que su solución no cubre
  selectores dinámicos.

### 7.2 `prefers-reduced-motion` — absoluto

Tres capas, sin excepción y **sin override por bloque ni por sitio**:

1. Todo el CSS generado se emite dentro de `@media (prefers-reduced-motion: no-preference)`.
2. Un bloque estático en `wordjs-ui.css` con `@media (prefers-reduced-motion: reduce)` anula
   `animation`/`transition` de `.wjs-ix*` con `!important` (cinturón y tirantes, como ya se hace).
3. Ambas islas del runtime consultan la media query y **no arman**.

Se rechaza explícitamente el modelo de IX3 (*conditional playback* opcional): una preferencia de
accesibilidad del sistema operativo no es una casilla que el autor pueda desmarcar.

### 7.3 Presupuestos, medibles

| Métrica | Tope | Cómo se mide |
|---|---|---|
| CSS generado por página | **≤ 8 KB** sin comprimir | Assert en el test del compilador sobre la página de corpus con 30 unidades. |
| JS en una página con solo unidades nativas, en Chrome | **0 bytes de motor** (solo el `CSS.supports`, ~200 B) | Peticiones de red en el drill de navegador. |
| Chunk `ix-scrub` | ≤ 4 KB gz, **no descargado** en Chrome/Safari 26+ | Peticiones de red. |
| CLS con 30 unidades | **0.000** | `PerformanceObserver('layout-shift')` en el drill. |
| Bucles `rAF` en el fallback | **1** por documento | Assert unitario. |
| Unidades compiladas por página | ≤ 30 | Aviso en el panel; nunca error de render. |

### 7.4 Muchas interacciones en una página

Las de scrub nativas no consumen hilo principal en Chrome/Edge (115+); en Safari 26 se asume hilo
principal salvo que se confirme lo contrario, y el presupuesto de §7.3 se mide **en Safari**, que es
el peor caso nativo. Las de fallback comparten un `IntersectionObserver` y un `rAF`, y **solo se procesan
las unidades intersecantes** — 30 unidades de las que 3 están en pantalla cuestan 3, no 30.
El coste de CSS es sublineal en el número de bloques: N bloques con el mismo preset comparten una
clase y un `@keyframes`.

---

## 8. DECISIÓN 6 — Plan por fases y gates

Ningún gate es "compila" o "los tests pasan". Eso es el suelo.

### F9-A — Modelo + compilador (sin UI, sin emisión)

`IxSpec`/`IxTrack`/`IxUnit` en `blockShell.ts` (puro, sin `"use client"`); `compileIx()`,
`ixCss()`, `ixKeyframes()`, `fnv1a32`, `canonicalJson`.

**Gates**
1. **Determinismo**: 1000 permutaciones del orden de claves del mismo `IxSpec` → un solo hash. Y
   dos ejecuciones del proceso → CSS byte-idéntico.
2. **Whitelist**: fuzz con props arbitrarias (incluidas `width`, `height`, `top`, `margin`) → el
   CSS emitido **no contiene ninguna** propiedad fuera de `transform`/`opacity`/`filter`/`clip-path`.
3. **Round-trip INTACTO**: `verso-roundtrip.test.ts` sobre el corpus de producción sigue verde y el
   corpus no se modifica (F9-A no escribe nada en `_puck_data`).
4. **Colisión**: dos cuerpos forzados al mismo hash → sufijos deterministas, estables entre
   ejecuciones.

### F9-B — Emisión en las tres superficies + presets de sistema

`<style precedence="wjs-ix">` público; `swapIxCss` en `VersoCanvasApi`; `@property --wjs-ixv-*` y
estáticos en `wordjs-ui.css`; exclusión de `--wjs-ixv-*` del manifiesto de tokens.

**Gates**
1. **Paridad de bytes**: la misma página en `/preview` y en la ruta pública emite el **mismo texto
   CSS** (comparación de cadena, no "equivalente").
2. **Navegador** (regla dura del proyecto, y regla de memoria ★★): la interacción se ve **en el
   canvas** y **en la página pública**, comparadas a igual tamaño, en 3 puntos de scroll, con el
   computado leído del DOM. No vale "se parece".
3. **El hoisting**: verificar en navegador dónde aterriza `<style precedence>` desde el árbol
   portaleado. Si aterriza en el padre (lo esperado), `swapIxCss` es obligatorio y queda probado.
4. **Tema**: `theme-doctor` **no** lista ningún `--wjs-ixv-*`. Y un tema activo distinto no altera
   ninguna interacción (frontera: el tema no manda sobre el movimiento).
5. **Paridad con lo viejo**: `sys:fade-up` produce el mismo recorrido visual que
   `.wjs-anim-fade-up` (comparación de computado en 5 puntos de la animación).

### F9-C — Runtime de fallback

Isla de eventos + chunk `ix-scrub` + backend WAAPI.

**Gates**
1. **Chrome NO descarga `ix-scrub`** — verificado sobre las peticiones de red, no sobre el código.
2. **Firefox estable** (sin tocar el flag): el mismo recorrido que Chrome, ≤ 2 px de diferencia en
   5 puntos de scroll, medido en el navegador.
3. **Página sin interacciones: cero bytes** del motor. Cero.
4. **Un solo `rAF`** por documento con 30 unidades.
5. **reduced-motion** en los tres navegadores: nada se mueve, todo se ve.

### F9-D — Panel de 3 niveles + scrubber + replay + `words`

**Gates**
1. **a11y AA del panel**: navegable entero con teclado, roles y nombres accesibles, foco visible.
2. **Drill de autor**: crear un stagger de 6 tarjetas en **menos de 60 s sin documentación**.
3. **`words`**: el titular partido conserva `aria-label` con el texto íntegro y los spans son
   `aria-hidden`; un lector de pantalla lee la frase, no las palabras sueltas.
4. **Los topes avisan**: superar 6 pasos muestra el aviso y **renderiza**.

### F9-E — Presets de sitio y propagación (el killer feature)

Opción `wjs_ix_presets`, purga por etiqueta `ix-presets`, editor de presets en Ajustes.

**Gate único y decisivo**: un preset usado en **3 páginas**; se edita; entonces
(a) las 3 páginas públicas muestran la interacción nueva tras una navegación,
(b) el CSS emitido de las 3 cambia de hash,
(c) **`git diff` de `_puck_data` de las 3 páginas está VACÍO**.
Si (c) falla, el diseño está mal, no el código.

### F9-F — Verificación final

3 modos en Proxmox, navegador, presupuestos de §7.3, reduced-motion en los tres navegadores,
corpus de round-trip verde, marketplace y plugins intactos.

---

## 9. Riesgos y lo que queda por verificar

| # | Riesgo | Estado |
|---|---|---|
| R1 | `<style precedence>` desde el árbol portaleado no llega al iframe | **Lectura estructural, NO observado.** Gate F9-B.3. El diseño ya asume el peor caso (`swapIxCss`), así que confirmarlo no cuesta trabajo; refutarlo solo simplifica. |
| R2 | Firefox estable sin scroll-driven | **Confirmado** (MDN Experimental features + caniuse). El fallback es camino, no cortesía. Si Firefox lo activa durante F9, el chunk deja de bajar solo — el troceado por `CSS.supports` no necesita cambios. |
| R3 | Animar variables `@property` mata el compositor | Mitigado por diseño: fuera del camino caliente (§4.4). **Falta medir** el caso hover con `@property` en un perfil real. |
| R4 | `timeline-scope` (objetivo externo en CSS puro) | Fuera de alcance en F9-A/B por Firefox. Reevaluar en F9-C. |
| R5 | El split por palabras choca con el motor inline | Acotado a bloques que lo declaren (`Heading`, `Quote`) y solo en render, nunca en edición. Verificar que editar un titular partido no pierde texto — drill obligatorio de F9-D. |
| R6 | Presets referenciados desde páginas y borrados en Ajustes | Fail-open (bloque visible, sin movimiento). El editor de presets debe **avisar del recuento de usos** antes de borrar. |
| R7 | `_puck_data` hostil (API, WXR) con un `ix` malicioso | El compilador clampa en la frontera de escritura **y** al compilar, igual que `clampAnimSpec` hace con `anim`. Un `IxSpec` con `v` desconocida se ignora. Fuzz en el gate F9-A.2. |

---

## 10. Resumen en una frase

Una interacción es **una prop del bloque** que un **compilador puro** convierte en **CSS nativo con
nombres deterministas**, emitido por el canal que cada superficie ya usa para el tema; el JS solo
aparece para lo que el CSS no puede expresar —clic, latch de "una sola vez", objetivo externo— o
para el navegador que aún no lo soporta; los **presets viven en los ajustes del sitio y se
referencian por id**, así que cambiar uno propaga a todas las instancias **sin mover un byte de
`_puck_data`**.
