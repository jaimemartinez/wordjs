/**
 * SERVER twin of withSharedBlockFields' wrapper (VisibilityField.tsx): the same hide classes,
 * appearance box and animation wrapper around every public block, computed with the SAME pure
 * helpers (blockShell.ts) the editor wrapper uses — one implementation, two render surfaces.
 *
 * Branching mirrors the editor Wrapped byte-for-byte:
 *  - nothing set                  → the block render, untouched (no wrapper element at all)
 *  - look only                    → the appearance box (server-rendered, zero hydration)
 *  - hide only                    → display:contents div with wjs-hide-* classes (pure CSS)
 *  - anim/scroll (± hide/look)    → AnimatedShell client island (the ONLY hydrated case)
 *
 * ── Capa ③: INTERACCIONES (motor F9) ────────────────────────────────────────────────────────
 * `ix` añade UNA capa más, entre la entrada y la caja de apariencia:
 *
 *     ① entrada (.wjs-anim)  →  ③ interacción (.wjs-ix-<hash>)  →  ② apariencia (.wjs-fx)  →  bloque
 *
 * Las tres son elementos DISTINTOS a propósito. ① y ② ya no podían compartir elemento porque
 * `animation-fill-mode: both` mata el `:hover`; ③ tiene ese mismo choque con las dos (usa
 * `animation` como ① y `:hover`/`transition` como ②) y además gana algo por estar anidada: los
 * `transform` de elementos anidados se COMPONEN, así que una entrada y un paralaje de scroll
 * conviven sin que ninguno tenga que "ganar" al otro. El razonamiento completo está en la cabecera
 * de `lib/verso/interactions/shell.ts`.
 *
 * Un bloque SIN `ix` no gana ningún elemento: la salida es byte-idéntica a la de antes del motor.
 * Y el servidor nunca estampa `data-wjs-ix`: el HTML servido no oculta NADA (cero CLS, cero FOUC).
 */
import { hideClasses, appearanceToStyle, ixLayer } from "@/components/blocks/blockShell";
import type { AnimSpec, Appearance, Hide } from "@/components/blocks/blockShell";
import type { IxCompileCtx, IxPage } from "@/lib/verso/interactions";
import { IX_SYS_CTX } from "@/lib/verso/interactions";
import AnimatedShell from "./AnimatedShell";

/**
 * Contexto de compilación por defecto: solo los presets del SISTEMA (`IX_SYS_CTX`, declarado UNA vez
 * en el motor). Los del sitio (`wjs_ix_presets`) los pasa explícitamente `ixCtx` desde el renderer
 * de la página (F9-E) o desde el canvas del editor, que son quienes los han leído de ajustes.
 */
const DEFAULT_IX_CTX: IxCompileCtx = IX_SYS_CTX;

export default function SharedBlockShell({ hide, anim: animProp, look: lookProp, ix, ixCtx, ixPage, children }: {
    hide?: Hide;
    anim?: AnimSpec;
    look?: Appearance;
    /** La prop `ix` del bloque, TAL CUAL sale de `_puck_data` (dato hostil: el motor la valida). */
    ix?: unknown;
    ixCtx?: IxCompileCtx;
    /**
     * La página YA COMPILADA (ContentRenderer). Solo ahí se ven todas las unidades a la vez, así que
     * solo ahí se pueden desambiguar dos cuerpos distintos que reclamen el mismo hash de 32 bits.
     * Sin ella se usa el hash desnudo: determinista igual, y suficiente para el canvas y para los
     * bloques que se pintan fuera del recorrido de la página.
     */
    ixPage?: IxPage;
    children: React.ReactNode;
}) {
    const hideCls = hideClasses(hide);
    // POLÍTICA DE MOVIMIENTO DEL SITIO (C5). Con el movimiento APAGADO también se cae la animación
    // de entrada clásica (`anim`), no solo el motor de interacciones: el ajuste se llama
    // «movimiento del sitio» y quien lo apaga espera un sitio quieto, no medio quieto. El bloque
    // se renderiza entonces sin su envoltorio animado — visible y en su estado final, que es la
    // misma degradación que ya tiene quien pide menos movimiento.
    const anim = (ixCtx?.motion === "off" ? {} : animProp || {}) as AnimSpec;
    const animActive = !!anim.type;
    const scrollActive = !!anim.scroll;
    const wrapActive = animActive || scrollActive;
    const look = appearanceToStyle(lookProp);
    const ixl = ix === undefined ? null : ixLayer(ix, ixCtx ?? DEFAULT_IX_CTX, ixPage);
    const inner = children;

    // Untouched block → no wrapper element at all, so its own render() is untouched.
    // NOTE: gate mirrors the editor wrapper EXACTLY, including its documented wart — a scroll-only
    // spec with entrance "Ninguna", no hide and no box takes this path and loses its scroll
    // classes there too. Fixing that belongs to both surfaces at once, in blockShell.
    if (!hideCls && !animActive && !look.hasBox && !ixl) return inner;

    // TWO NESTED LAYERS, deliberately — they must never share an element (see the editor wrapper:
    // entrance animation and appearance box fight over `animation`/`transform` on one element).
    const box = look.hasBox ? (
        <div className={look.className || undefined} style={look.style}>
            {look.overlay && <div style={look.overlay} aria-hidden="true" />}
            {/* The overlay is absolutely positioned over the box, so the block's own content
                needs its own stacking context to stay above it. */}
            {look.overlay ? <div style={{ position: "relative" }}>{inner}</div> : inner}
        </div>
    ) : (
        inner
    );

    // Capa ③ — nunca `display: contents`: un elemento sin caja no se puede transformar ni recortar.
    const ixed = ixl ? (
        <div
            className={ixl.className}
            style={Object.keys(ixl.style).length > 0 ? ixl.style : undefined}
            {...ixl.attrs}
        >
            {box}
        </div>
    ) : (
        box
    );

    if (!hideCls && !wrapActive) return ixed;

    if (wrapActive) {
        // The one hydrated case: the entrance/scroll wrapper needs the client hook.
        return <AnimatedShell hideCls={hideCls} anim={anim}>{ixed}</AnimatedShell>;
    }

    // hide-only: static wrapper, no hydration — the wjs-hide-* media queries do the work.
    return (
        <div className={hideCls} style={{ display: "contents" }}>
            {ixed}
        </div>
    );
}
