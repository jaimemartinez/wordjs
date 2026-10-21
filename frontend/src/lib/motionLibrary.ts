/**
 * The MOTION LIBRARY's author-facing model (Ajustes ▸ Movimientos, and the motion picker in Verso).
 *
 * A preset is an interaction body (`IxSpec`: trigger + tracks of steps). That is the right shape for
 * the engine and the wrong one for most authors, who want "appears sliding up when it scrolls into
 * view, a bit slower". This module is the translation, and nothing else:
 *
 *  - SIMPLE MODE: a small closed vocabulary (effect · when · speed · delay · this block or its items
 *    one after another) that maps to EXACTLY one normalized `IxSpec` (`simpleToSpec`), and back
 *    (`specToSimple`) only when the body is exactly one of those — never a lossy round trip. A body
 *    the simple mode cannot express opens in the advanced editor instead.
 *  - TEMPLATES: starting points expressed in that vocabulary.
 *  - DESCRIPTIONS: one plain-language sentence for any body ("Appears sliding up when it scrolls into
 *    view, one item after another"), through the admin catalogue (`motion.*` keys) so it reads in the
 *    admin's language.
 *  - USAGE BY PAGE: which pages reference a preset by id, for "Used on N pages" with links.
 *
 * The engine contract is untouched: every body still goes through `normalizeIxSpec`, presets are
 * still saved through `ixPresetSave`, and usage still counts references by id (`ixPresetUsage`).
 */
import {
    ixPresetUsage,
    normalizeIxSpec,
    type IxPreset,
    type IxProps,
    type IxSpec,
    type IxStep,
    type IxTrigger,
} from "@/lib/verso/interactions";

export type SimpleEffect = "fade" | "up" | "down" | "left" | "right" | "zoomIn" | "zoomOut" | "lift";
export type SimpleWhen = "view" | "load" | "hover" | "click" | "scroll";
export type SimpleSpeed = "fast" | "normal" | "slow";
export type SimpleTarget = "self" | "children";

export interface SimpleMotion {
    effect: SimpleEffect;
    when: SimpleWhen;
    speed: SimpleSpeed;
    /** ms before it starts (timed triggers only). */
    delay: number;
    target: SimpleTarget;
    /** ms between one item and the next when `target` is "children". */
    stagger: number;
}

export const SIMPLE_EFFECTS: readonly SimpleEffect[] = ["fade", "up", "down", "left", "right", "zoomIn", "zoomOut", "lift"];
export const SIMPLE_WHENS: readonly SimpleWhen[] = ["view", "load", "hover", "click", "scroll"];
export const SIMPLE_SPEEDS: readonly SimpleSpeed[] = ["fast", "normal", "slow"];
export const SPEED_MS: Readonly<Record<SimpleSpeed, number>> = { fast: 300, normal: 600, slow: 1000 };
export const SIMPLE_DELAY_MAX = 2000;
export const SIMPLE_STAGGER_MAX = 400;

/** The two keyframes of each effect: where the block starts → where it ends. */
const EFFECT_FRAMES: Readonly<Record<SimpleEffect, readonly [IxProps, IxProps]>> = {
    fade: [{ opacity: 0 }, { opacity: 1 }],
    up: [{ opacity: 0, y: 24 }, { opacity: 1, y: 0 }],
    down: [{ opacity: 0, y: -24 }, { opacity: 1, y: 0 }],
    left: [{ opacity: 0, x: -32 }, { opacity: 1, x: 0 }],
    right: [{ opacity: 0, x: 32 }, { opacity: 1, x: 0 }],
    zoomIn: [{ opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1 }],
    zoomOut: [{ opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1 }],
    lift: [{ y: 0, scale: 1 }, { y: -6, scale: 1.02 }],
};

/** Effects that start invisible: on hover or click they would hide the block until touched. */
const HIDES_AT_REST: ReadonlySet<SimpleEffect> = new Set(["fade", "up", "down", "left", "right", "zoomIn", "zoomOut"]);

/** Whether `effect` makes sense for `when` (the editor disables the rest, with the reason). */
export function effectFitsWhen(effect: SimpleEffect, when: SimpleWhen): boolean {
    if (when === "hover" || when === "click") return !HIDES_AT_REST.has(effect);
    return true;
}

const timed = (when: SimpleWhen): boolean => when !== "scroll";

function triggerOf(when: SimpleWhen): IxTrigger {
    switch (when) {
        case "view": return { on: "view", once: true };
        case "load": return { on: "load" };
        case "hover": return { on: "hover" };
        case "click": return { on: "click", toggle: true };
        case "scroll": return { on: "scrub" };
    }
}

/** The one normalized body a simple motion stands for (`undefined` only if the engine refuses it). */
export function simpleToSpec(m: SimpleMotion): IxSpec | undefined {
    const [from, to] = EFFECT_FRAMES[m.effect];
    const steps: IxStep[] = [
        { at: 0, set: { ...from }, ease: "out" },
        { at: 100, set: { ...to } },
    ];
    const track: NonNullable<IxSpec["tracks"]>[number] = {
        target: { kind: m.target === "children" ? "children" : "self" },
        steps,
    };
    if (timed(m.when)) {
        track.dur = SPEED_MS[m.speed];
        track.delay = Math.max(0, Math.min(SIMPLE_DELAY_MAX, Math.round(m.delay)));
    }
    if (m.target === "children" && m.stagger > 0) {
        track.stagger = { each: Math.max(0, Math.min(SIMPLE_STAGGER_MAX, Math.round(m.stagger))) };
    }
    const norm = normalizeIxSpec({ v: 1, trigger: triggerOf(m.when), tracks: [track] });
    return norm ? norm.spec : undefined;
}

const sameProps = (a: IxProps, b: IxProps): boolean => {
    const ka = Object.keys(a).filter((k) => a[k as keyof IxProps] !== undefined).sort();
    const kb = Object.keys(b).filter((k) => b[k as keyof IxProps] !== undefined).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k as keyof IxProps] === b[k as keyof IxProps]);
};

function whenOf(t: IxTrigger | undefined): SimpleWhen | null {
    if (!t) return null;
    if (t.on === "view" && t.once !== false && !t.range) return "view";
    if (t.on === "load" && !t.delay) return "load";
    if (t.on === "hover") return "hover";
    if (t.on === "click" && t.toggle === true) return "click";
    if (t.on === "scrub" && !t.range && (t.src === undefined || t.src === "self") && !t.smooth) return "scroll";
    return null;
}

/**
 * The simple motion a body is, or `null` when the simple editor cannot show it EXACTLY (more tracks,
 * more steps, other properties, a custom duration or curve…). `null` is not an error: it means
 * "open the advanced editor", which edits any body.
 */
export function specToSimple(spec: IxSpec | null | undefined): SimpleMotion | null {
    const norm = spec ? normalizeIxSpec(spec) : null;
    if (!norm) return null;
    const s = norm.spec;
    if (s.preset || !s.tracks || s.tracks.length !== 1 || s.off?.length) return null;
    const when = whenOf(s.trigger);
    if (!when) return null;
    const tr = s.tracks[0];
    const target = tr.target.kind === "self" ? "self" : tr.target.kind === "children" ? "children" : null;
    if (!target || tr.steps.length !== 2 || tr.repeat !== undefined && tr.repeat !== 1 || tr.alt || tr.axis || tr.clipDir || tr.origin || tr.persp) return null;
    if (tr.steps[0].ease !== "out" || tr.steps[0].bez) return null;
    if (tr.stagger && (tr.stagger.from && tr.stagger.from !== "start" || tr.stagger.total || tr.stagger.cols !== undefined)) return null;
    const effect = SIMPLE_EFFECTS.find((e) => sameProps(tr.steps[0].set, EFFECT_FRAMES[e][0]) && sameProps(tr.steps[1].set, EFFECT_FRAMES[e][1]));
    if (!effect) return null;
    let speed: SimpleSpeed = "normal";
    if (timed(when)) {
        const found = SIMPLE_SPEEDS.find((sp) => SPEED_MS[sp] === (tr.dur ?? 600));
        if (!found) return null;
        speed = found;
    }
    const out: SimpleMotion = {
        effect,
        when,
        speed,
        delay: timed(when) ? tr.delay ?? 0 : 0,
        target,
        stagger: target === "children" ? tr.stagger?.each ?? 0 : 0,
    };
    // Exact round trip, or nothing: the simple editor never rewrites a body it only resembles.
    const back = simpleToSpec(out);
    return back && JSON.stringify(back) === JSON.stringify(s) ? out : null;
}

export const DEFAULT_SIMPLE: SimpleMotion = { effect: "up", when: "view", speed: "normal", delay: 0, target: "self", stagger: 0 };

export interface MotionTemplate {
    id: string;
    /** `motion.template.<id>` in the admin catalogue. */
    labelKey: string;
    motion: SimpleMotion;
}

/** Starting points for a new motion — each is a simple motion, so it opens in the simple editor. */
export const MOTION_TEMPLATES: readonly MotionTemplate[] = [
    { id: "fadeIn", labelKey: "motion.template.fadeIn", motion: { ...DEFAULT_SIMPLE, effect: "fade" } },
    { id: "slideUp", labelKey: "motion.template.slideUp", motion: { ...DEFAULT_SIMPLE } },
    { id: "zoom", labelKey: "motion.template.zoom", motion: { ...DEFAULT_SIMPLE, effect: "zoomIn" } },
    { id: "stagger", labelKey: "motion.template.stagger", motion: { ...DEFAULT_SIMPLE, target: "children", stagger: 120, speed: "fast" } },
    { id: "fromLeft", labelKey: "motion.template.fromLeft", motion: { ...DEFAULT_SIMPLE, effect: "left" } },
    { id: "hoverLift", labelKey: "motion.template.hoverLift", motion: { ...DEFAULT_SIMPLE, effect: "lift", when: "hover", speed: "fast" } },
    { id: "scrollRise", labelKey: "motion.template.scrollRise", motion: { ...DEFAULT_SIMPLE, when: "scroll" } },
    { id: "onLoad", labelKey: "motion.template.onLoad", motion: { ...DEFAULT_SIMPLE, effect: "fade", when: "load", speed: "slow" } },
];

/* ------------------------------------------------------------------ */
/* Plain-language description                                          */
/* ------------------------------------------------------------------ */

type T = (key: string) => string;

const fill = (s: string, vars: Record<string, string | number>): string =>
    s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const WHEN_KEY: Record<string, string> = {
    view: "motion.when.view",
    load: "motion.when.load",
    hover: "motion.when.hover",
    click: "motion.when.click",
    scrub: "motion.when.scroll",
    pointer: "motion.when.pointer",
    event: "motion.when.event",
};

/** Which effect a pair of keyframes looks like, for the sentence (exact or not). */
function effectLike(from: IxProps, to: IxProps): SimpleEffect | null {
    for (const e of SIMPLE_EFFECTS) if (sameProps(from, EFFECT_FRAMES[e][0]) && sameProps(to, EFFECT_FRAMES[e][1])) return e;
    if ((from.opacity ?? 1) < (to.opacity ?? 1)) {
        if ((from.y ?? 0) > (to.y ?? 0)) return "up";
        if ((from.y ?? 0) < (to.y ?? 0)) return "down";
        if ((from.x ?? 0) < (to.x ?? 0)) return "left";
        if ((from.x ?? 0) > (to.x ?? 0)) return "right";
        if ((from.scale ?? 1) < (to.scale ?? 1)) return "zoomIn";
        if ((from.scale ?? 1) > (to.scale ?? 1)) return "zoomOut";
        return "fade";
    }
    return null;
}

/**
 * One sentence for a body or a preset, e.g. "Appears sliding up when it scrolls into view, one item
 * after another". Falls back to "Animates when it scrolls into view" for bodies with no simple reading.
 */
export function describeMotion(body: { trigger?: IxTrigger; tracks?: IxSpec["tracks"] } | null | undefined, t: T): string {
    const trigger = body?.trigger;
    const tracks = body?.tracks ?? [];
    if (!trigger || tracks.length === 0) return t("motion.describe.none");
    const when = t(WHEN_KEY[trigger.on] ?? "motion.when.event");
    const first = tracks[0];
    const steps = first.steps;
    const eff = steps.length >= 2 ? effectLike(steps[0].set, steps[steps.length - 1].set) : null;
    let sentence = eff ? fill(t("motion.describe.effectWhen"), { effect: t(`motion.effectPhrase.${eff}`), when }) : fill(t("motion.describe.genericWhen"), { when });
    if (tracks.length > 1) sentence += " · " + fill(t("motion.describe.layers"), { n: tracks.length });
    else if (first.target.kind === "children") sentence += first.stagger?.each ? `, ${t("motion.describe.oneByOne")}` : `, ${t("motion.describe.items")}`;
    else if (first.target.kind === "words") sentence += `, ${t("motion.describe.words")}`;
    if (first.repeat === "inf") sentence += ` · ${t("motion.describe.loops")}`;
    return sentence;
}

export const describePreset = (p: IxPreset, t: T): string => describeMotion(p, t);

/* ------------------------------------------------------------------ */
/* Usage by page                                                       */
/* ------------------------------------------------------------------ */

export interface UsagePage {
    id: number;
    title: string;
    type: string;
    /** Blocks on this page linked to the preset. */
    blocks: number;
}

/**
 * For each preset id, the pages whose blocks reference it — the same by-id count as `ixPresetUsage`
 * (a block that unlinked a preset carries its own body and is not affected by it), kept per page.
 */
export function presetUsageByPage(
    entries: ReadonlyArray<{ id: number; title: string; type: string; data: unknown }>,
): Map<string, UsagePage[]> {
    const out = new Map<string, UsagePage[]>();
    for (const e of entries) {
        for (const [presetId, blocks] of ixPresetUsage(e.data)) {
            const list = out.get(presetId) ?? [];
            list.push({ id: e.id, title: e.title, type: e.type, blocks });
            out.set(presetId, list);
        }
    }
    return out;
}

/** Where the admin edits a page or a post. */
export const editorHref = (p: { id: number; type: string }): string => `/admin/${p.type === "post" ? "posts" : "pages"}/${p.id}`;
