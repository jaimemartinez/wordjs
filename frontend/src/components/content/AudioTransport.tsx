"use client";
/**
 * Audio transport — the AudioPlayer block's client island (playback state, marquee measurement,
 * scrubbing). The block's outer element renders on the server (blocks.tsx AudioPlayerBlock).
 */
import React, { useState } from "react";
import { cx } from "@/components/puck/blockVars";
import { fmtTime } from "./SelfHostedVideo";

const AudioTransport = ({ src, title }: { src: string; title: string }) => {
    const ref = React.useRef<HTMLAudioElement | null>(null);
    const bodyRef = React.useRef<HTMLDivElement | null>(null);
    const labelRef = React.useRef<HTMLSpanElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const [now, setNow] = useState(0);
    const [total, setTotal] = useState(NaN);
    // A marquee that slides a title which already fits is just noise. Measure the label against its
    // column and only animate when it genuinely overflows — re-measured on resize, because the
    // column is fluid.
    const [scrolls, setScrolls] = useState(false);
    React.useEffect(() => {
        const body = bodyRef.current, label = labelRef.current;
        if (!body || !label) return;
        const measure = () => setScrolls(label.scrollWidth > body.clientWidth + 1);
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(body);
        return () => ro.disconnect();
    }, [title]);

    React.useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const onTime = () => setNow(el.currentTime);
        const onMeta = () => setTotal(el.duration);
        const onPlay = () => setPlaying(true);
        const onPause = () => setPlaying(false);
        const onEnd = () => { setPlaying(false); setNow(0); };
        el.addEventListener('timeupdate', onTime);
        el.addEventListener('loadedmetadata', onMeta);
        el.addEventListener('durationchange', onMeta);
        el.addEventListener('play', onPlay);
        el.addEventListener('pause', onPause);
        el.addEventListener('ended', onEnd);
        if (el.readyState >= 1) onMeta();
        return () => {
            el.removeEventListener('timeupdate', onTime);
            el.removeEventListener('loadedmetadata', onMeta);
            el.removeEventListener('durationchange', onMeta);
            el.removeEventListener('play', onPlay);
            el.removeEventListener('pause', onPause);
            el.removeEventListener('ended', onEnd);
        };
    }, [src]);

    const toggle = () => {
        const el = ref.current;
        if (!el) return;
        if (el.paused) el.play().catch(() => { /* autoplay policy — the user will press again */ });
        else el.pause();
    };
    const seek = (v: number) => {
        const el = ref.current;
        if (el && isFinite(total)) { el.currentTime = v; setNow(v); }
    };

    const pct = isFinite(total) && total > 0 ? (now / total) * 100 : 0;

    return (
        <>
            <button
                type="button"
                className="wp-block-audio-player__button"
                onClick={toggle}
                aria-label={playing ? 'Pausar' : 'Reproducir'}
            >
                <i className={cx('fa-solid', playing ? 'fa-pause' : 'fa-play')} aria-hidden="true"></i>
            </button>
            <div className="wp-block-audio-player__body" ref={bodyRef}>
                {/* The label is duplicated so the marquee loops seamlessly; the copy exists only
                    while it actually scrolls, and is aria-hidden so the name is announced once. */}
                <div className="wp-block-audio-player__marquee" title={title}>
                    <div className={cx('wp-block-audio-player__track', scrolls && 'is-scrolling')}>
                        <span className="wp-block-audio-player__title" ref={labelRef}>{title}</span>
                        {scrolls && <span className="wp-block-audio-player__title" aria-hidden="true">{title}</span>}
                    </div>
                </div>
                <input
                    type="range"
                    className="wp-block-audio-player__scrub"
                    min={0}
                    max={isFinite(total) && total > 0 ? total : 0}
                    step="any"
                    value={now}
                    onChange={(e) => seek(parseFloat(e.target.value))}
                    aria-label="Posición de reproducción"
                    aria-valuetext={`${fmtTime(now)} de ${fmtTime(total)}`}
                    style={{ ['--wjs-audio-progress-pct' as any]: `${pct}%` }}
                />
                <div className="wp-block-audio-player__times">
                    <span>{fmtTime(now)}</span>
                    <span>{fmtTime(total)}</span>
                </div>
            </div>
            {/* No `controls`: the transport above replaces it. Kept in the DOM as the media engine
                and as the no-JS fallback. */}
            <audio ref={ref} src={src} preload="metadata" className="wp-block-audio-player__engine">
                <a href={src}>Descargar el audio</a>
            </audio>
        </>
    );
};

export default AudioTransport;
