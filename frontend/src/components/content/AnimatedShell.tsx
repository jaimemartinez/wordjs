"use client";
/**
 * The ANIMATED outer wrapper of SharedBlockShell — the only part of the shared block wrapper that
 * needs the client (IntersectionObserver entrance hook). Renders the exact same element the editor
 * wrapper renders on its animated path: classes = [hideCls, animClasses(anim)], style = the anim
 * duration/delay custom properties (clamped like the editor side — hostile _puck_data could carry
 * a multi-hour delay).
 */
import React from "react";
import { animClasses } from "@/components/blocks/blockShell";
import type { AnimSpec } from "@/components/blocks/blockShell";
import { useEntranceAnimation } from "@/components/blocks/entranceAnimation";

export default function AnimatedShell({ hideCls, anim, children }: { hideCls: string; anim: AnimSpec; children: React.ReactNode }) {
    const animActive = !!anim.type;
    const ref = React.useRef<HTMLDivElement>(null);
    useEntranceAnimation(ref, animActive ? anim : null);
    return (
        <div
            ref={ref}
            className={[hideCls, animClasses(anim)].filter(Boolean).join(" ")}
            style={{
                "--wjs-anim-dur": `${Math.min(Math.max(Number(anim.duration) || 600, 100), 3000)}ms`,
                "--wjs-anim-delay": `${Math.min(Math.max(Number(anim.delay) || 0, 0), 3000)}ms`,
            } as React.CSSProperties}
        >
            {children}
        </div>
    );
}
