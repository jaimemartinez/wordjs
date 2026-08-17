"use client";
/**
 * ParticleField — the ONE client island of the ParticleField block (blocks.tsx ParticleFieldBlock
 * renders the absolutely-positioned wrapper on the server; this owns the `<canvas>` and its drawing).
 *
 * Why this is a BLOCK and not an interaction preset or a theme: the interactions engine compiles to
 * pure CSS (zero JS — it can't drive a canvas/WebGL), and a theme never ships JS. A particle field is
 * an animated raster, so it has to live where code is allowed: a client island with a `<canvas>`.
 *
 * Hard rules honoured here:
 *  · SSR-safe / zero CLS — the server ships an EMPTY canvas as the mount point; nothing is drawn until
 *    hydration. The wrapper is `position:absolute; inset:0` (out of flow), so it reserves no layout.
 *  · Lazy — drawing starts only when the canvas enters the viewport (IntersectionObserver) and stops
 *    when it leaves OR the tab is hidden (visibilitychange). No CPU/battery burnt off-screen.
 *  · prefers-reduced-motion: reduce → NEVER animates. One static frame is painted and rAF never starts.
 *  · Perf — requestAnimationFrame, devicePixelRatio-aware backing store (capped at 2), particle count
 *    clamped, and every rAF/observer/listener torn down on unmount (no leaks).
 *  · Security — the author's colour is read back as a BROWSER-NORMALISED `rgb(...)` via
 *    getComputedStyle (the wrapper exposes it as the `--wjs-particle-color` custom property). Nothing
 *    the author typed is ever concatenated into raw CSS or eval'd; canvas fillStyle only ever sees a
 *    validated numeric rgb triplet.
 */
import React from "react";

export type ParticleSpeed = "slow" | "medium" | "fast";

const SPEED_PX: Record<string, number> = { slow: 0.15, medium: 0.35, fast: 0.7 };

/**
 * The reduced-motion gate, exported so the contract is testable in the node test env (the frontend
 * suite ships no DOM). `true` ⇒ the visitor asked the OS to minimise motion and the field must NOT
 * animate (one static frame is painted, rAF never starts). A window without matchMedia ⇒ not reduced.
 */
export function prefersReducedMotion(win: Pick<Window, "matchMedia">): boolean {
    return typeof win?.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Parse a getComputedStyle colour (`rgb(...)`/`rgba(...)`) into a numeric triplet; fall back safely. */
function parseRgb(value: string): { r: number; g: number; b: number } {
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(value);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };
    return { r: 110, g: 168, b: 254 };
}

interface Particle { x: number; y: number; vx: number; vy: number; }

export default function ParticleFieldCanvas({
    count,
    speed,
    linkLines,
    linkDistance,
    pointer,
}: {
    count?: number | string;
    speed?: ParticleSpeed | string;
    linkLines?: string | boolean;
    linkDistance?: number | string;
    pointer?: string | boolean;
}) {
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

    React.useEffect(() => {
        const canvasEl = canvasRef.current;
        if (!canvasEl) return;
        const context = canvasEl.getContext("2d");
        if (!context) return;
        // Rebind to non-null consts so the nested resize/render closures below don't see `| null`
        // (control-flow narrowing of a mutable ref is not carried into closures).
        const canvas = canvasEl;
        const ctx = context;

        // ── Sanitise + clamp every author-controlled input (hostile _puck_data) ──
        const N = Math.max(0, Math.min(Math.round(Number(count) || 0), 200));
        const step = SPEED_PX[String(speed)] ?? SPEED_PX.medium;
        const linkOn = String(linkLines) === "true" || linkLines === true;
        const linkDist = Math.max(0, Math.min(Number(linkDistance) || 0, 400));
        const pointerOn = String(pointer) === "true" || pointer === true;

        const reduce = prefersReducedMotion(window);

        // Colour: resolved ONCE, browser-normalised to rgb() — never raw author text.
        const { r, g, b } = parseRgb(getComputedStyle(canvas).color || "");
        const dotFill = `rgba(${r},${g},${b},0.85)`;

        let width = 0;
        let height = 0;
        const particles: Particle[] = [];
        const ptr = { x: -1e4, y: -1e4, active: false };

        function resize() {
            const rect = canvas.getBoundingClientRect();
            width = Math.max(1, Math.floor(rect.width));
            height = Math.max(1, Math.floor(rect.height));
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        function seed() {
            particles.length = 0;
            for (let i = 0; i < N; i++) {
                const angle = Math.random() * Math.PI * 2;
                const sp = step * (0.4 + Math.random() * 0.8);
                particles.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    vx: Math.cos(angle) * sp,
                    vy: Math.sin(angle) * sp,
                });
            }
        }

        function render(advance: boolean) {
            ctx.clearRect(0, 0, width, height);

            if (advance) {
                for (const p of particles) {
                    p.x += p.vx;
                    p.y += p.vy;
                    // wrap around the edges so the field never thins out
                    if (p.x < 0) p.x += width; else if (p.x > width) p.x -= width;
                    if (p.y < 0) p.y += height; else if (p.y > height) p.y -= height;

                    if (pointerOn && ptr.active) {
                        const dx = p.x - ptr.x;
                        const dy = p.y - ptr.y;
                        const dist = Math.hypot(dx, dy);
                        if (dist > 0.01 && dist < 120) {
                            const force = ((120 - dist) / 120) * 0.6;
                            p.x += (dx / dist) * force;
                            p.y += (dy / dist) * force;
                        }
                    }
                }
            }

            if (linkOn && linkDist > 0) {
                ctx.lineWidth = 1;
                for (let i = 0; i < particles.length; i++) {
                    for (let j = i + 1; j < particles.length; j++) {
                        const dx = particles[i].x - particles[j].x;
                        const dy = particles[i].y - particles[j].y;
                        const dist = Math.hypot(dx, dy);
                        if (dist < linkDist) {
                            ctx.strokeStyle = `rgba(${r},${g},${b},${((1 - dist / linkDist) * 0.5).toFixed(3)})`;
                            ctx.beginPath();
                            ctx.moveTo(particles[i].x, particles[i].y);
                            ctx.lineTo(particles[j].x, particles[j].y);
                            ctx.stroke();
                        }
                    }
                }
            }

            ctx.fillStyle = dotFill;
            for (const p of particles) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        let raf = 0;
        let running = false;
        let inView = false;

        function loop() {
            render(true);
            raf = requestAnimationFrame(loop);
        }
        function start() {
            if (running || reduce) return;
            running = true;
            raf = requestAnimationFrame(loop);
        }
        function stop() {
            running = false;
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
        }

        resize();
        seed();
        if (reduce) render(false); // static frame, no motion, ever

        const rebuild = () => {
            resize();
            seed();
            if (reduce) render(false);
        };

        // Lazy: run only while on-screen.
        let io: IntersectionObserver | null = null;
        if (typeof IntersectionObserver !== "undefined") {
            io = new IntersectionObserver(
                (entries) => {
                    inView = entries.some((e) => e.isIntersecting);
                    if (inView && !document.hidden) start();
                    else stop();
                },
                { threshold: 0 },
            );
            io.observe(canvas);
        } else {
            inView = true;
            start();
        }

        const onVisibility = () => {
            if (document.hidden) stop();
            else if (inView) start();
        };
        document.addEventListener("visibilitychange", onVisibility);

        const ro =
            typeof ResizeObserver !== "undefined" ? new ResizeObserver(rebuild) : null;
        if (ro) ro.observe(canvas);
        else window.addEventListener("resize", rebuild);

        let onPointerMove: ((e: PointerEvent) => void) | null = null;
        if (pointerOn && !reduce) {
            // The layer itself is pointer-events:none, so read the pointer from the window.
            onPointerMove = (e: PointerEvent) => {
                const rect = canvas.getBoundingClientRect();
                ptr.x = e.clientX - rect.left;
                ptr.y = e.clientY - rect.top;
                ptr.active = ptr.x >= 0 && ptr.y >= 0 && ptr.x <= width && ptr.y <= height;
            };
            window.addEventListener("pointermove", onPointerMove, { passive: true });
        }

        return () => {
            stop();
            io?.disconnect();
            ro?.disconnect();
            window.removeEventListener("resize", rebuild);
            document.removeEventListener("visibilitychange", onVisibility);
            if (onPointerMove) window.removeEventListener("pointermove", onPointerMove);
        };
    }, [count, speed, linkLines, linkDistance, pointer]);

    // The mount point. `color` carries the accent down as a normal CSS value so the effect only ever
    // reads a browser-resolved colour (see parseRgb above). aria-hidden: it is pure decoration.
    return (
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            style={{
                display: "block",
                width: "100%",
                height: "100%",
                color: "var(--wjs-particle-color, var(--wjs-color-primary, #6ea8fe))",
            }}
        />
    );
}
