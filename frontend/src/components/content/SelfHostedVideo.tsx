"use client";
/**
 * Click-to-play cover for a SELF-HOSTED <video> (VideoEmbed's same-origin path). The one client
 * island of the VideoEmbed block: the iframe/placeholder paths render fully on the server. The
 * element itself is server-rendered HTML; this component only owns the cover interaction.
 */
import React, { useState } from "react";
import { bc, cx } from "@/components/blocks/blockVars";

export const fmtTime = (s: number): string => {
    if (!isFinite(s) || s < 0) return '--:--';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const SelfHostedVideo = ({ src, poster, vars }: { src: string; poster: string; vars: React.CSSProperties }) => {
    const ref = React.useRef<HTMLVideoElement | null>(null);
    const [started, setStarted] = useState(false);
    const [total, setTotal] = useState(NaN);

    // The element is server-rendered, so `loadedmetadata` can fire BEFORE React hydrates and attaches
    // its handler — the duration would then never arrive and the chip would never appear. Seed from
    // the element on mount and keep a listener for the case where it has not loaded yet.
    React.useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const onMeta = () => setTotal(el.duration);
        if (el.readyState >= 1) onMeta();
        el.addEventListener('loadedmetadata', onMeta);
        return () => el.removeEventListener('loadedmetadata', onMeta);
    }, [src]);

    const start = () => {
        setStarted(true);
        const el = ref.current;
        if (el) { el.play().catch(() => { /* the native controls are showing; they can press play */ }); }
    };

    return (
        <div className={cx(bc('video-embed'), started && 'is-playing')} style={vars}>
            <video
                ref={ref}
                src={src}
                poster={poster || undefined}
                controls={started}
                preload="metadata"
                playsInline
                onLoadedMetadata={(e) => setTotal(e.currentTarget.duration)}
            />
            {!started && (
                <button type="button" className={bc('video-embed__cover')} onClick={start} aria-label="Reproducir el vídeo">
                    <span className={bc('video-embed__scrim')} aria-hidden="true" />
                    <span className={bc('video-embed__play')} aria-hidden="true">
                        <i className="fa-solid fa-play"></i>
                    </span>
                    {isFinite(total) && <span className={bc('video-embed__chip')}>{fmtTime(total)}</span>}
                </button>
            )}
        </div>
    );
};

export default SelfHostedVideo;
