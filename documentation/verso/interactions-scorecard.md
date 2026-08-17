# Verso Interactions — Competitive Scorecard

**Date**: 2026-08-16. **Status**: Phase 0 deliverable of the interactions program — the benchmark
that decides what gets built, in what order, before touching the core.

**Method**: capability-by-capability audit of Webflow Interactions with GSAP ("IX3", launched
2025-07-10, feature drops through 2026-07-20), Motion (formerly Framer Motion, v13.1.0), and GSAP
3.15 + ScrollTrigger/SplitText/Observer/Flip — verified against their official docs on 2026-08-16,
not from memory. Browser-platform claims verified against MDN browser-compat-data, WebKit release
blogs, and the Interop 2026 README. The current Verso engine state was audited from source
(`frontend/src/lib/verso/interactions/**`, panel, runtime, emission, backend settings).

**Verdicts**: `MATCH` (we do it, comparably), `SURPASS` (we do it demonstrably better),
`BUILD` (gap worth closing — becomes roadmap), `OMIT` (deliberate omission, reason given).
Every OMIT has a written reason; that is the contract of this document.

---

## 0. The one-paragraph verdict

Verso's architecture already **surpasses** all three competitors on the axes that cannot be
retrofitted: zero-JS native compilation (IX3 ships GSAP site-wide on every page with
interactions), zero-CLS by type construction, FOUC-free by construction (IX3 injects
`visibility:hidden !important` from JS and documents where that fails), absolute
`prefers-reduced-motion` (IX3's is an optional per-interaction setting), and by-reference presets
whose edits propagate with a literally empty `_puck_data` diff. What it lacks is **breadth**:
fewer animatable properties, fewer easing options, no pointer trigger, single-track editing UI,
and several model capabilities (repeat, toggle, ranges) that exist in the data model but have no
panel controls. The roadmap below closes the breadth gap without surrendering a single
architectural guarantee.

---

## 1. Scorecard by capability area

### 1.1 Triggers

| Capability | IX3 | Motion | GSAP | Verso today | Verdict |
|---|---|---|---|---|---|
| Enter viewport, once | Scroll "trigger actions" | `whileInView` + `once` | ScrollTrigger `once` | `view` + `once:true` (IO latch, reuses the proven `entranceAnimation` harness) | **MATCH** |
| Enter/exit viewport, repeating | toggleActions | `whileInView` | toggleActions | `view` + `once:false` → pure CSS `view()` timeline | **SURPASS** — 0 JS in Chromium/WebKit; they always ship their engine |
| Element scroll scrub | Scrub mode | `scroll({target})` | `scrub:true` | `scrub` → `animation-timeline: view()` | **SURPASS** on payload (0 JS native path) |
| Page scroll progress | — (element-relative only) | `scroll()` | scroller config | `scrub` + `src:"page"` → `scroll()` | **MATCH+** (native, and IX3 lacks a page-progress trigger) |
| Scrub smoothing (catch-up lag) | Yes (scrub:number) | via `useSpring` | `scrub: 1` | Not offered | **OMIT** — smoothing forces every frame onto the JS main thread (it is inexpressible in scroll-driven CSS); exact 1:1 linkage is a feature, not a gap. Revisit only if authors ask. |
| Hover | Enter/leave types | `whileHover` | custom | `hover` → CSS transition/animation, always paired with `:focus-visible` | **MATCH**, **SURPASS** on keyboard parity (IX3 does not pair focus) |
| Click / toggle | 1st/2nd click config | `whileTap` | custom | `click` + `toggle` in model & runtime; **no panel UI, compiler ignores the flag** | **BUILD (P1)** — expose toggle in panel |
| Page load (+delay) | Yes | mount animations | yes | `load` + `delay` → pure CSS, 0 JS | **SURPASS** on payload |
| Scroll range / start-end offsets | Start/End + canvas markers | offset syntax | start/end syntax | `IxRange` (spec-vocabulary `cover/contain/entry/exit`) in model; **no panel UI** | **BUILD (P1)** — range editor in author language |
| Mouse move / pointer parallax | Flagship (2026-07-20): Mouse X/Y, follow, interval, velocity | MotionValues (DIY) | Observer + quickTo | Absent | **BUILD (P6)** — quarantined runtime trigger (see §3) |
| Custom JS event | "Trigger snippet" escape hatch | n/a | n/a | Absent | **OMIT** for now — CMS authors don't write JS; when the plugin system needs it, a closed, slug-validated `CustomEvent` name can arm units without new surface. Recorded as future seam, not built. |
| Widget triggers (tabs/nav/slider) | **No** (their declared gap) | n/a | n/a | n/a | **OMIT** — IX3 doesn't have them either; block-level triggers cover the CMS case. |
| Scroll pin | Pin + pin-spacer | — | `pin:true` | Not offered | **OMIT** — GSAP's pin mutates layout (inserts a spacer element); that is a layout change by design, incompatible with the zero-CLS guarantee. CSS `position: sticky` is the native, CLS-free answer and belongs to the layout system, not the interaction engine. |
| Scroll snap | — | — | `snap` | Not offered | **OMIT** — snap belongs to CSS `scroll-snap` (layout), and JS-driven snapping is scroll-jacking-adjacent. |

### 1.2 Targeting

| Capability | IX3 | Motion | GSAP | Verso today | Verdict |
|---|---|---|---|---|---|
| Self | ✓ | ✓ | ✓ | `self` | **MATCH** |
| Direct children (stagger) | Children scope | variant children | any | `children` | **MATCH** |
| Another element | ID/class/attribute | refs | any selector | `block` + validated id (runtime-resolved; `timeline-scope` has zero Firefox implementation) | **MATCH** (bounded by design) |
| Arbitrary selector / class targeting | ✓ (combinators) | n/a | ✓ | Not offered | **OMIT** — an author-supplied selector is a CSS injection surface and breaks the engine's core invariant (*no author string ever reaches the stylesheet*). Closed relationship scopes preserve the invariant; the useful ones (self/children/words/block-by-id) exist. `descendants` can be added as a closed scope if demand appears. |
| Words (split text) | SplitText words | **paid** (Motion+) | SplitText | `words` on `ixText` blocks, aria-label + aria-hidden enforced by construction, 40-word cap | **MATCH**; **SURPASS** vs Motion (theirs is paywalled) |
| Chars / lines split | ✓ | paid | ✓ | Not offered | **OMIT** — chars: screen readers and the inline editor both break (real a11y cost, spec §1); lines: requires measuring rendered text, impossible in SSR where canvas and public markup must come from the same code. |
| Component scoping | Components + Shared Libraries (2026-04-16) | n/a | n/a | Symbols already carry `ix` props | **MATCH** |

### 1.3 Animatable properties

Verso's list is closed **on purpose** — the zero-CLS guarantee lives in the type. The expansion
below stays inside that rule: transform-class and paint-class properties only, never layout.

| Capability | IX3 | Motion | GSAP | Verso today | Verdict |
|---|---|---|---|---|---|
| opacity | ✓ | ✓ | ✓ | ✓ | **MATCH** |
| x / y translate | ✓ | ✓ | ✓ | ✓ (`translate3d`) | **MATCH** |
| z translate + perspective | ✓ (needs ancestor perspective) | ✓ | ✓ | `rotateX` hard-codes `perspective(1000px)` | **BUILD (P3)** — `z` + configurable perspective, self-contained in the transform |
| scale (uniform) | ✓ | ✓ | ✓ | ✓ | **MATCH** |
| scaleX / scaleY | ✓ | ✓ | ✓ | — | **BUILD (P3)** |
| rotate (Z) | ✓ | ✓ | ✓ | ✓ | **MATCH** |
| rotateX / rotateY | ✓ | ✓ | ✓ | rotateX only | **BUILD (P3)** — rotateY completes the 3D set |
| skewX / skewY | ✓ | ✓ | ✓ | — | **BUILD (P3)** — transform-class, compositor-safe |
| transform-origin | ✓ (corners/center/custom) | ✓ | ✓ | default only | **BUILD (P3)** — closed enum (9 positions), never a free string |
| blur | not documented | ✓ | ✓ | ✓ | **MATCH** (we beat IX3 here) |
| Extended filters (brightness/contrast/saturate/grayscale/hue-rotate) | not documented | ✓ | ✓ | — | **BUILD (P3)** — numeric, filter is compositor-accelerated in Blink; paint elsewhere (documented, not load-bearing) |
| color / background-color / border-color | ✓ | ✓ (all formats) | ✓ | — | **BUILD (P3)** — paint-class (explicitly acceptable under the CLS rule). Encoding: **integer 0xRRGGBB**, clamped, emitter formats `rgb()` itself — the *no author string* invariant survives intact. |
| clip reveal | — | `clipPath` | ✓ | `clip` (left→right only, hard-coded) | **BUILD (P3)** — direction enum (4 edges + center-out), still `inset()` numbers |
| width / height / size animation | ✓ (discouraged by their own docs) | ✓ (`width:"auto"`) | ✓ | **not representable** | **OMIT** — direct size animation is reflow, the exact thing the engine guarantees never happens. `transform: scale` covers the visual effect. This omission is the product's identity, not a gap. |
| SVG stroke draw (pathLength / DrawSVG) | not exposed visually | `pathLength` | DrawSVG | — | **BUILD (P8, quarantined)** — stroke-dash animation is paint-only, no reflow; gated to blocks that declare `ixSvg` (icons/dividers). Last in line: niche in a content CMS. |
| SVG morph / motion path | — / — | `arc()` path | MorphSVG/MotionPath | — | **OMIT** — motion-editor territory; no content-CMS case that `x/y/rotate` doesn't cover. CSS `offset-path` exists cross-browser if this is ever revisited. |
| CSS variable animation | Variables action (2026-03-26) | ✓ (with paint caveat) | ✓ | — | **OMIT** in the hot path — an animated custom property recalcs on the main thread and un-composites the transform that reads it (spec §4.4). Static per-block scalars (`--wjs-ixv-*`) are the sanctioned channel (P7 wires intensity). Binding color endpoints to theme tokens is recorded as a revisit item, blocked on the theme-boundary rule (a theme must never drive motion). |
| Lottie / Spline / Rive | ✓ (2025-12→2026-04) | — | — | — | **OMIT** — each is a third-party JS runtime shipped to visitors; violates native-first and the byte budget. If ever wanted, it is plugin-marketplace space, not engine core. |

### 1.4 Steps, tracks and timeline model

| Capability | IX3 | Motion | GSAP | Verso today | Verdict |
|---|---|---|---|---|---|
| Multi-step keyframes | Absolute-time blocks | keyframe arrays + `times` | full timeline | 2–6 steps at 0–100% with per-step ease | **MATCH** (percentage model scales to scrub and time alike) |
| Parallel tracks / overlapping actions | Tracks on the timeline | variants | nested timelines | Model has 3 tracks (per-track target, dur, delay) — **panel edits only track 0** | **BUILD (P5)** — multi-track editing + accessible visual step strip |
| Sequencing across tracks | Absolute positions | orchestration | position parameter | Per-track delay/duration overlap; no cross-track dependency graph | **MATCH** for overlap; dependency graphs **OMIT** (spec §1: it's a motion editor feature, not a CMS one — determinism and author reasoning win) |
| Repeat / infinite / yoyo | Per-action + per-timeline | repeat/repeatType | repeat/yoyo | `repeat` + `alt` in model & CSS emission — **no panel UI**; silently ignored on scrub/hover-2-step | **BUILD (P1)** — UI + honest warnings |
| Timeline labels/nesting | — | labels in sequences | ✓ | — | **OMIT** — same reason as dependency graphs. |
| Hide/disable an action for debugging | ✓ | — | — | — | **OMIT** — the panel's remove + undo covers the authoring loop; a hidden-but-shipped state is a foot-gun in a CMS. |

### 1.5 Easing

| Capability | IX3 | Motion | GSAP | Verso today | Verdict |
|---|---|---|---|---|---|
| Named eases | ~9 families | ~8 + springs | 12+ families | 6 (closed table of beziers) | **BUILD (P2)** — extend the closed table |
| Custom cubic-bezier | Ease visualizer (2026-01-28) | bezier arrays | CustomEase | — | **BUILD (P2)** — 4 clamped numbers per step; the no-string invariant holds |
| Graphical curve editor | ✓ | — | Ease Visualizer | — | **BUILD (P2)** — accessible editor (keyboard-operable handles + numeric inputs), not mouse-only |
| Springs (physics) | via GSAP elastic | first-class (stiffness/damping/mass) | elastic/CustomWiggle | fake spring bezier | **BUILD (P2) = SURPASS** — sample real spring physics at compile time into CSS `linear()` (Baseline everywhere: Chrome 113 / Firefox 112 / Safari 17.2). **Zero-JS springs; nobody else ships that.** |
| Bounce / elastic / wiggle | ✓ | — | ✓ | — | **BUILD (P2)** — same `linear()` compilation |
| Per-step easing | Per-action | `ease` arrays | easeEach | ✓ already | **MATCH** |
| Stagger-distribution easing | — | stagger `ease` | ✓ | — | **OMIT** — niche; the visible effect (non-linear rollout) is approximable with grid/center origins (P4). Revisit on demand. |

### 1.6 Stagger

| Capability | IX3 | Motion | GSAP | Verso today | Verdict |
|---|---|---|---|---|---|
| Fixed delay per sibling | ✓ ("delay between") | `stagger(d)` | `each` | ✓ (`:nth-child` rules, 24 cap) | **MATCH** |
| Total-time mode | ✓ ("total time") | — | `amount` | — | **BUILD (P4)** — `sibling-count()` math where supported |
| from: start/end | ✓/? | first/last | ✓ | ✓ (`end` exact via `:nth-last-child`) | **MATCH** |
| from: center | not documented | ✓ | ✓ | degraded to start with warning | **BUILD (P4) = SURPASS over IX3** — exact zero-JS center via `sibling-index()`/`sibling-count()` (Chrome 138, Safari 26.2, Firefox 154 due 2026-08-18; per-child index var is the universal fallback we already ship for words) |
| Grid stagger | not exposed | — | `grid:[r,c]` | — | **BUILD (P4)** — author declares columns; row/col from `sibling-index()` + `round()`, `nth-child` fallback |
| Distance-from-point stagger | — | — | `distribute` | — | **OMIT** — requires measuring rendered geometry (main-thread, layout-dependent, SSR-hostile). The grid mode delivers the same perceived effect deterministically. |
| Random order | — | — | `from:"random"` | — | **OMIT** for now — true random breaks byte-determinism of emitted CSS; a hash-seeded deterministic shuffle is possible if demand appears. |
| Zero-JS stagger emission | n/a (JS engine) | n/a | n/a | 24 `:nth-child` rules | **BUILD (P4)** — single `sibling-index()` rule where supported: smaller CSS, unlimited siblings |

### 1.7 Presets, reuse, propagation

| Capability | IX3 | Motion | GSAP | Verso today | Verdict |
|---|---|---|---|---|---|
| Reusable presets | "Save as preset" | — | effects registry | Site presets **by reference** (id in `_puck_data`, body in settings, `rev` in the CSS hash) | **SURPASS** — editing a preset propagates to every page with an empty `_puck_data` diff; cache-busting is structural (rev → hash → href) |
| System library | — | — | — | 16 system presets (12 entrances, 4 scroll) | **BUILD (P7)** — curated expansion (springs, staggered cards, hero combos) |
| Parametrizable presets (variables) | Variable binding | — | function values | intensity scalar channel (`--wjs-ixv-amt`) declared but unwired | **BUILD (P7)** — per-block intensity without forking the preset |
| Preset live preview in admin | canvas preview | — | — | none (must open the editor) | **BUILD (P7)** — reuse the WAAPI scrubber on a sample element |
| Usage counts | — | — | — | computed at delete-time only | **BUILD (P7)** — show on list |
| Cross-site copy | ✓ (2026-02-17) | n/a | n/a | — | **OMIT** — single-site product today; preset export/import piggybacks on settings tooling when multi-site exists. |

### 1.8 Performance, payload, correctness

| Capability | IX3 | Motion | GSAP | Verso today | Verdict |
|---|---|---|---|---|---|
| JS payload on a page with interactions | GSAP + plugins **site-wide**; double-loads if Classic coexists | 2.3–34 KB by tier | ~24 KB+ | **0 bytes** native path; ≤2 KB island + ≤4 KB scrub chunk only where needed | **SURPASS** — and the tiering is decided server-side per page |
| FOUC prevention | JS injects `visibility:hidden !important`, removed on `w-mod-ix3`; **documented failure modes**, no opt-out, JS-off = FOUC | n/a | manual | Nothing to hide: frame 0 applied by `animation-fill-mode` before first paint; served HTML never hides content | **SURPASS by construction** |
| CLS guarantee | discouraged-but-possible size animation | layout animations exist | any prop | **unrepresentable** outside compositor/paint set | **SURPASS by construction** |
| Scroll off-main-thread | No (GSAP is main-thread by design; lagSmoothing mitigates) | ScrollTimeline where available | No | Native scroll-driven CSS (compositor in Chromium) | **SURPASS** |
| Bundle budget enforcement | — | — | — | CSS ≤8 KB asserted; **JS chunk budgets NOT asserted** | **BUILD (P1)** — assert built-chunk byte budgets in tests |
| Firefox fallback | n/a (JS everywhere) | ScrollTimeline gap too | n/a | IO + single rAF + WAAPI positioning; **`src:"page"` progress diverges from native** (element-relative vs document scroll) | **BUILD (P1)** — fix page-progress fallback parity |

### 1.9 Accessibility

| Capability | IX3 | Motion | GSAP | Verso today | Verdict |
|---|---|---|---|---|---|
| prefers-reduced-motion | Optional per-interaction setting (2025-09-30): "no animation" or "skip to end" | `reducedMotion="user"` opt-in config | `matchMedia` pattern (DIY) | **Absolute, three layers, no override** (media-wrapped CSS + runtime check + static `!important` kill) | **SURPASS** — an OS accessibility preference is not a checkbox an author can clear |
| Keyboard parity of hover/click | — | tap is keyboard-accessible | DIY | `:focus-visible` paired always; Enter/Space on click | **SURPASS** vs IX3 |
| Split-text screen readers | SplitText masking; FOUC hides content from AT pre-reveal | paid | aria:"auto" (3.13) | aria-label + aria-hidden **by construction** (the label can't be omitted) | **MATCH** vs GSAP 3.13, **SURPASS** vs IX3's pre-reveal hiding |
| Panel operable by keyboard | partial (drag-heavy timeline; has shortcuts) | n/a | n/a | All controls labeled, radiogroups, status announcements; scrubber arm/release designed for keyboard | **MATCH+**, keep AA as a gate for every new control |
| Responsive/breakpoint gating | ✓ (breakpoints cascade, 2025-09-30) | — | matchMedia | — | **BUILD (P4)** — closed breakpoint enum → `@media` wrap; pure CSS, useful as a mobile performance lever |

---

## 2. What we deliberately do NOT build (consolidated)

Each omission above, with its load-bearing reason, in one place:

1. **Size/layout animation** (width/height/margin/top…) — reflow; the zero-CLS guarantee lives in
   the closed type. `transform: scale` covers the visuals. This is identity, not debt.
2. **Arbitrary selector targeting** — CSS injection surface; breaks the *no author string in the
   stylesheet* invariant that makes the compiler safe against hostile `_puck_data`/WXR/API input.
3. **Char/line text splitting** — chars: screen-reader and inline-editor breakage; lines: needs
   rendered-text measurement, impossible under SSR-parity (canvas and public share markup code).
4. **Cross-track dependency graphs / timeline nesting / labels** — motion-editor scope. The CMS
   case is covered by 3 parallel tracks with delays; determinism and author reasoning win.
5. **Scroll pin & snap** — pin mutates layout (spacer) against the CLS guarantee; CSS
   `position: sticky` / `scroll-snap` are the native answers and belong to layout, not ix.
6. **Scrub smoothing** — inexpressible in scroll-driven CSS; would force the native path onto the
   JS main thread. Exact linkage is the performance feature.
7. **Animated CSS variables in the hot path** — de-composites transforms (spec §4.4). Static
   scalars (`--wjs-ixv-*`) are the sanctioned channel.
8. **Lottie/Spline/Rive** — third-party visitor-facing JS runtimes; native-first and the byte
   budget are non-negotiable. Plugin-marketplace space if ever.
9. **Mouse-move interval/clone actions** (IX3's element-cloning) — DOM mutation mid-animation is
   CLS risk by definition; the pointer trigger we do build (P6) is transform-only.
10. **Distance/random staggers** — geometry measurement or nondeterminism; grid mode delivers the
    perceived effect deterministically.
11. **Custom JS event trigger** — no authoring story in a CMS today; recorded as a future seam
    (closed slug-validated event names) for the plugin system.
12. **Widget triggers** — IX3 doesn't have them either.
13. **Cross-site preset copy** — no multi-site product surface today.
14. **Hidden-but-editable actions** — a shipped-but-invisible state is a foot-gun; undo covers it.

---

## 3. Prioritized roadmap (by author value ÷ architectural cost)

Order chosen by value to a **content-CMS author** (visible power, soonest), respecting the hard
rules (zero CLS, native-first, byte-identical HTML without `ix`, zero data loss, theme contract,
AA, hostile input, English on GitHub).

| # | Phase | Contents | Why this order |
|---|---|---|---|
| **P1** | **Control completeness & honesty** — **SHIPPED 2026-08-16** | Panel UI for repeat/infinite/ping-pong (`repeat`/`alt`), `click.toggle`, `load.delay`, scrub source (`self`/`page`), view/scrub **range editor** (author-language over `IxRange`, percent-only under page scroll); compiler warnings where options were silently ignored (repeat/alt on scrub & hover-2-step, stagger on self/block); JS built-chunk byte-budget test (island 859 B/2 KB, scrub 1110 B/4 KB); Firefox page-scrub progress parity (`host.pageProgress()`); canvas collision-suffix fidelity (compiled page in the editor render context, guarded by a real FNV-collision test). Browser-verified: canvas sheet + computed styles, public surface computed `animation-timeline: scroll()` / `animation-range: 20% 80%` / `infinite alternate` | The model already supported all of it — highest value per line of code, and it converts silent lies into honest warnings (method lesson: guarantee properties where they can't be dodged) |
| **P2** | **Easing engine** — **SHIPPED 2026-08-16** | Custom cubic-bezier per step (`bez`: four clamped numbers, wins over `ease`, hashes into the unit); **bounce/elastic physics compiled to CSS `linear()`** (32/24 even samples, byte-stable — zero-JS physics, a genuine first among these competitors); graphical curve editor (SVG drag + full keyboard: arrow-stepped handles with aria-live announcements + labelled numeric inputs as the canonical path), mirrored in the preset admin. Browser-verified: keyboard-only edit propagated to the canvas sheet; public surface shows the custom bezier and a 33-point `linear()` driving a live `infinite alternate` animation | Multiplies the perceived quality of every existing and future interaction; compile-side is cheap, Baseline support is universal |
| **P3** | **Property expansion** — **SHIPPED 2026-08-16** | The closed list grew 8 → 22: rotateY, z + per-track perspective (200–4000, default byte-stable), skewX/Y, scaleX/Y, filter family (brightness/contrast/saturate/grayscale/hue), **colors as integer 0xRRGGBB** exempt from neutral-fill (they animate *from the block's natural color*), clip directions (6), transform-origin (closed 9-position enum, emitted stateless and outside `@supports` so the Firefox runtime path obeys it). Original 8 keys keep canonical-order primacy — a parity pin proves pre-P3 documents emit byte-identical CSS. Fuzz whitelist extended (compositor + sanctioned paint props and nothing else). Browser-verified with computed styles on both surfaces: mid-flight `rgba(255,136,0,…)` interpolating from transparent, `matrix3d`, `transform-origin: 0px 0px`, `perspective(500px)` | Closes the biggest visible breadth gap vs all three, without one reflow property |
| **P4** | **Stagger 2.0 + responsive gating** — **SHIPPED 2026-08-16** | One native `sibling-index()` rule under a self-conditioned `@supports` replaces the 24 `:nth-child` rules where the engine understands it (Chrome 138+/Safari 26.2+/FF 154+): unlimited siblings, and **exact** center/end, total-time via `sibling-count()`, and diagonal grid via `round(down)`/`mod` over author-declared columns. The WAAPI runtime shares the identical formulas (parity test: `[0,80,160,80,160,240]` for 6 children × 3 cols); only the nth-child fallback approximates, with a warning. Per-device gating (`off`, block-level, hashes) compiles to the complementary merged `@media` and the runtime checks the same condition before arming. Browser-verified: computed grid delays byte-exact in the real engine, `@media` wrap live, and at 375px `animation-name: none` with the block still visible at opacity 1 | Signature "wow" of modern motion; the platform primitives just landed cross-browser (Firefox 154: 2026-08-18) |
| **P5** | **Multi-track editing + visual step strip** — **SHIPPED 2026-08-16** | Panel edits all 3 tracks (selector, add-neutral, remove; every writer threaded with the track index), accessible step strip (button markers at true % positions, click-to-focus the row), block-scoped replay («Probar» reads the store selection; «Probar todo» re-arms the page). **The browser drill caught a real bug no unit test saw**: two tracks on the SAME target emitted two `animation` rules and the last silently won — fixed structurally by grouping tracks per target selector into ONE animation list (timeline/range broadcast from the trigger; same-property overlap warns; single-track emission byte-identical). Verified live: computed `animationName: "…-0, …-1"` | The data model has always supported it; unlocks layered compositions (parallax bg + rising fg + staggered children) |
| **P6** | **Pointer trigger (quarantined runtime)** | `{on:"pointer"}` parallax/tilt/follow: rAF-coalesced, transform-only, ≤2 KB gz addition, loads only when used, inert under reduced-motion | The one trigger class CSS cannot express and IX3's 2026 flagship; our per-page conditional loading beats their site-wide GSAP |
| **P7** | **Preset library & parametrization** | Curated system-preset expansion (springs, card sequences, hero combos), intensity scalar (`--wjs-ixv-amt`) wired through `IxLayer.style`, live preview + usage counts in the preset admin | Compounds P2–P6 into one-click author value; presets are already our architectural killer feature |
| **P8** | **SVG stroke draw (optional tail)** | `draw` property gated to `ixSvg`-declaring blocks; stroke-dash paint-only technique | Niche in a content CMS; explicitly last and demand-gated |

**Agreed set for the Definition of Done**: every row above marked MATCH/SURPASS stays green; every
BUILD row lands through P1–P7 (P8 demand-gated); every OMIT stands with its reason. Each phase
ships under the program's hard gates: native-first compilation, zero CLS, panel controls
keyboard-operable, canvas preview, revert-red tests, browser-verified computed styles, green
`tsc`/`vitest`/`eslint`/build, and CI+CodeQL green on main.

---

## 4. Platform facts this plan leans on (verified 2026-08-16)

- **Scroll-driven animations**: Chrome/Edge 115+, Safari 26.0+ (26.5 fixed range-edge bugs);
  **Firefox release does NOT ship it** (flag-only; Nightly default-on; Interop 2026 focus area).
  Blogs claiming "Firefox 132+ supports it" are false. The WAAPI `ScrollTimeline` shares the same
  gap — the IO+rAF fallback remains the only Firefox path.
- **`timeline-scope`**: no Firefox implementation at all; `all` keyword removed in Chrome 138.
  External-target CSS stays runtime-resolved (as shipped).
- **`linear()` easing**: Baseline everywhere (Chrome 113, Firefox 112, Safari 17.2) — the
  zero-JS spring vehicle for P2.
- **`sibling-index()`/`sibling-count()`**: Chrome/Edge 138, Safari 26.2, Firefox 154 scheduled
  2026-08-18 — P4's native stagger, with the per-child index var as universal fallback.
- **`@property`**: Baseline (Chrome 85, Safari 16.4, Firefox 128) — typed static scalars only
  (hot-path animation of custom properties stays banned, spec §4.4).
- **Compositor truth**: transform+opacity composited in all engines; filter composited in Blink;
  background-color/color/clip-path are main-thread paint in all engines as of Aug 2026 (Chromium's
  composited background-color project never shipped). Color animation is therefore allowed but
  documented as paint-class, and never made load-bearing for 60fps claims.
- **GSAP is fully free** (all bonus plugins) since the Webflow acquisition — pricing is not a
  moat; architecture is.
