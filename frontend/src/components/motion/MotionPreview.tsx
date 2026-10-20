"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { compileIx, toRuntimeUnit, type IxCompileCtx, type IxRuntimeTrack } from "@/lib/verso/interactions";

/**
 * A LIVE preview of a motion: the body compiled by the REAL compiler (`compileIx` → runtime
 * keyframes) and played with the Web Animations API on a sample card with three items, so "this
 * block" moves the card and "its items one after another" moves the items with their stagger. No
 * hand-made imitation: the keyframes are the ones the page would emit.
 *
 * When it plays depends on the trigger, the way a visitor would see it:
 *  - entering the screen, page load, click, custom events: once when the card appears, and again
 *    with Replay (or hovering / focusing the card);
 *  - hover: forward while the pointer or focus is on the card, back when it leaves;
 *  - scroll and pointer (no clock): a slow back-and-forth sweep while hovered or after Replay.
 * With `prefers-reduced-motion: reduce` nothing plays by itself: the card shows its resting state and
 * only Replay — an explicit request — plays it.
 *
 * The stage is decorative (`aria-hidden`); the Replay button carries the accessible name.
 */
export interface MotionPreviewProps {
    /** An IxSpec or a preset body ({ trigger, tracks }), or a linked spec ({ preset: id }) with `ctx`. */
    spec: unknown;
    ctx?: IxCompileCtx;
    /** Accessible name of the replay button, e.g. "Replay the preview of Slide up". */
    replayLabel: string;
    /** Text on the replay button (visible). */
    replayText?: string;
    /** Bump to replay from outside (the editor replays after each change). */
    replayKey?: number;
    /** "auto": small on a phone, regular from lg. */
    size?: "sm" | "md" | "auto";
    /** Override the reduced-motion preference (tests). */
    reduced?: boolean;
    className?: string;
    /** "editor": Verso's --ed-* tokens (light and dark), instead of the admin's grays. */
    tone?: "admin" | "editor";
}

const RM_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeRm(cb: () => void) {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const mq = window.matchMedia(RM_QUERY);
    mq.addEventListener?.("change", cb);
    return () => mq.removeEventListener?.("change", cb);
}
const getRm = () => (typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(RM_QUERY).matches);

export function MotionPreview({ spec, ctx, replayLabel, replayText, replayKey = 0, size = "md", reduced, className = "", tone = "admin" }: MotionPreviewProps) {
    const systemReduced = useSyncExternalStore(subscribeRm, getRm, () => false);
    const reduce = reduced ?? systemReduced;
    const unit = useMemo(() => {
        try {
            const u = compileIx(spec, ctx);
            return u ? toRuntimeUnit(u) : null;
        } catch {
            return null;
        }
    }, [spec, ctx]);
    const on = unit?.trigger.on ?? "view";
    const clockless = on === "scrub" || on === "pointer";

    const cardRef = useRef<HTMLDivElement | null>(null);
    const itemRefs = useRef<Array<HTMLSpanElement | null>>([]);
    const running = useRef<Animation[]>([]);
    const [playing, setPlaying] = useState(false);

    const stop = useCallback(() => {
        for (const a of running.current) a.cancel();
        running.current = [];
        setPlaying(false);
    }, []);

    const targetsOf = useCallback((track: IxRuntimeTrack): Element[] => {
        const card = cardRef.current;
        if (!card) return [];
        const kind = track.target.kind;
        if (kind === "children" || kind === "words") return itemRefs.current.filter((x): x is HTMLSpanElement => !!x);
        return [card];
    }, []);

    /** Plays every track; `direction` reverses for a hover leave; `sweep` loops for clockless triggers. */
    const play = useCallback((opts: { direction?: PlaybackDirection; sweep?: boolean } = {}) => {
        if (!unit) return;
        stop();
        const anims: Animation[] = [];
        for (const track of unit.tracks) {
            const els = targetsOf(track);
            els.forEach((el, i) => {
                const each = track.stagger ? track.stagger.each : 0;
                const order = track.stagger?.from === "end" ? els.length - 1 - i : track.stagger?.from === "center" ? Math.abs(i - (els.length - 1) / 2) : i;
                try {
                    const a = el.animate(track.kf as Keyframe[], opts.sweep
                        ? { duration: 1600, iterations: 2, direction: "alternate", easing: "ease-in-out", fill: "both", delay: each * order }
                        : {
                            duration: track.dur,
                            delay: (track.delay ?? 0) + each * order,
                            // Loops are previewed twice, not forever: a preview that never stops is noise.
                            iterations: track.repeat === "inf" ? 3 : Math.max(1, track.repeat ?? 1),
                            direction: opts.direction ?? (track.alt ? "alternate" : "normal"),
                            // The curve of each segment already travels inside the keyframes.
                            easing: "linear",
                            fill: "both",
                        });
                    anims.push(a);
                } catch {
                    /* keyframes this browser refuses: the worst preview is no preview */
                }
            });
        }
        running.current = anims;
        setPlaying(anims.length > 0);
        Promise.all(anims.map((a) => a.finished.catch(() => undefined))).then(() => {
            if (running.current === anims) setPlaying(false);
        });
    }, [unit, stop, targetsOf]);

    // A hover motion rests at its START; anything else rests at its END (what a visitor sees after it played).
    const rest = useCallback(() => {
        if (!unit) return;
        stop();
        for (const track of unit.tracks) {
            const frame = on === "hover" || clockless ? track.kf[0] : track.kf[track.kf.length - 1];
            if (!frame) continue;
            for (const el of targetsOf(track)) {
                try {
                    running.current.push(el.animate([frame as Keyframe, frame as Keyframe], { duration: 1, fill: "forwards" }));
                } catch { /* ignore */ }
            }
        }
    }, [unit, stop, targetsOf, on, clockless]);

    // Auto-play once when shown (and after each external replay request), unless the visitor asked
    // for reduced motion; hover motions wait for the pointer.
    useEffect(() => {
        if (!unit) return;
        if (reduce || on === "hover" || clockless) {
            rest();
            return stop;
        }
        play();
        return stop;
    }, [unit, replayKey, reduce, on, clockless, play, rest, stop]);

    const enter = () => {
        if (reduce || !unit) return;
        if (on === "hover") play();
        else if (clockless) play({ sweep: true });
    };
    const leave = () => {
        if (reduce || !unit) return;
        if (on === "hover") play({ direction: "reverse" });
    };

    const replay = () => {
        if (!unit) return;
        if (clockless) play({ sweep: true });
        else play();
    };

    const stageH = size === "sm" ? "h-24" : size === "auto" ? "h-20 lg:h-36" : "h-36";
    const cardW = size === "sm" ? "w-24 p-2" : size === "auto" ? "w-20 p-1.5 lg:w-36 lg:p-3" : "w-36 p-3";
    const barH = size === "sm" ? "h-2.5" : size === "auto" ? "h-2 lg:h-3.5" : "h-3.5";
    const lineH = size === "sm" ? "h-1.5" : size === "auto" ? "h-1 lg:h-2" : "h-2";
    return (
        <div className={`flex flex-col gap-2 ${className}`}>
            <div
                aria-hidden="true"
                onPointerEnter={enter}
                onPointerLeave={leave}
                className={`relative flex items-center justify-center overflow-hidden rounded-xl ${tone === "editor" ? "bg-[var(--ed-surface-container)]" : "bg-[repeating-linear-gradient(45deg,#f8fafc,#f8fafc_10px,#f1f5f9_10px,#f1f5f9_20px)]"} ${stageH}`}
            >
                <div
                    ref={cardRef}
                    className={`flex flex-col gap-1.5 rounded-xl border shadow-sm ${tone === "editor" ? "border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]" : "border-gray-200 bg-white"} ${cardW}`}
                >
                    <span className={`block rounded bg-gradient-to-r from-blue-500 to-indigo-500 ${barH}`} />
                    {[0, 1, 2].map((i) => (
                        <span
                            key={i}
                            ref={(el) => { itemRefs.current[i] = el; }}
                            className={`block rounded ${tone === "editor" ? "bg-[var(--ed-outline-variant)]" : "bg-gray-200"} ${lineH}`}
                            style={{ width: `${90 - i * 18}%` }}
                        />
                    ))}
                </div>
            </div>
            <button
                type="button"
                onClick={replay}
                onFocus={enter}
                onBlur={leave}
                disabled={!unit}
                aria-label={replayLabel}
                className={tone === "editor"
                    ? "inline-flex min-h-11 sm:min-h-8 items-center justify-center gap-2 self-start rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface)] px-3 text-[11px] font-semibold text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] disabled:opacity-40"
                    : "inline-flex min-h-11 sm:min-h-9 items-center justify-center gap-2 self-start rounded-lg border border-gray-200 bg-white px-3 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40"}
            >
                <i className={`fa-solid ${playing ? "fa-rotate-right fa-spin" : "fa-play"} text-[10px]`} aria-hidden="true"></i>
                {replayText ?? replayLabel}
            </button>
        </div>
    );
}

export default MotionPreview;
