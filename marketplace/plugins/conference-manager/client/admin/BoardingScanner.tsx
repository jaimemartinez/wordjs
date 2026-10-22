// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Verificar abordaje» (2.25.0): choose the bus being boarded, then scan each person's badge — the phone's
 * camera, a USB / Bluetooth reader (it types the code and Enter), or the code typed by hand — and the screen
 * says, big, whether that person travels on THIS bus: «Sí va en este bus», «Va en otro bus» (which one), «No
 * tiene pasaje», «Inscripción cancelada» or «Código desconocido». Read only: nothing is recorded.
 *
 * The camera, the readers (BarcodeDetector where it reads QR, else jsQR + the built-in barcode reader), the
 * aiming frame and the beeps are the meal scanner's (MealScanner.tsx); the QR's «Mi inscripción» link and the
 * older Code 128 badges both work (the server's findByScanCode reads either).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { conferenceApi } from "../lib/conference";
import { lockBodyScroll } from "../lib/overlay";
import { classifyRead } from "../lib/meals";
import {
    AimFrame, SCANNER_CSS, SCANNER_ROOT_STYLE, SCANNER_BAR_STYLE, SAFE_LEFT, SAFE_RIGHT,
    cameraAvailability, cameraFailure, createFeedback, decodeCameraFrame, getNativeDetector, useTx,
} from "./MealScanner";

const SAME_CODE_MS = 3000;
const money = (n: number) => { try { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0); } catch { return `$${Math.round(n || 0)}`; } };

const TONE: Record<string, { bg: string; icon: string }> = {
    ok: { bg: '#059669', icon: 'fa-circle-check' },
    other_bus: { bg: '#d97706', icon: 'fa-bus' },
    no_ticket: { bg: '#e11d48', icon: 'fa-circle-xmark' },
    cancelled: { bg: '#e11d48', icon: 'fa-ban' },
    unknown: { bg: '#374151', icon: 'fa-circle-question' },
    error: { bg: '#374151', icon: 'fa-triangle-exclamation' },
};

/** The verdict's headline and detail lines (pure; also used by the tests). */
export function boardingLines(tx, r) {
    if (!r) return { title: '', lines: [] };
    const name = r.person && r.person.name ? r.person.name : '';
    switch (r.result) {
        case 'ok': {
            const lines = [name, r.person && r.person.location].filter(Boolean);
            if (r.ticket && r.ticket.balance > 0) lines.push(tx('transport.board.owes', 'Pasaje con saldo pendiente: {amount}').replace('{amount}', money(r.ticket.balance)));
            return { title: tx('transport.board.ok', 'Sí va en este bus'), lines };
        }
        case 'other_bus':
            return { title: tx('transport.board.other', 'Va en otro bus'), lines: [name, `${tx('transport.board.hisbus', 'Su bus:')} ${(r.buses || []).map(b => b.name).join(', ')}`].filter(Boolean) };
        case 'no_ticket':
            return { title: tx('transport.board.none', 'No tiene pasaje'), lines: [name, r.person && r.person.location].filter(Boolean) };
        case 'cancelled':
            return { title: tx('transport.board.cancelled', 'Inscripción cancelada'), lines: [name].filter(Boolean) };
        case 'unknown':
            return { title: tx('transport.board.unknown', 'Código desconocido'), lines: [tx('transport.board.unknown.hint', 'No es una escarapela de este evento.')] };
        default:
            return { title: tx('transport.board.error', 'No se pudo comprobar'), lines: [r.message || tx('transport.board.retry', 'Revisa la conexión e inténtalo de nuevo.')] };
    }
}

export function BoardingScanner({ buses, busId: initialBus, onClose }: any) {
    const tx = useTx();
    const [busId, setBusId] = useState<number>(initialBus || (buses[0] && buses[0].id) || 0);
    const busRef = useRef(busId);
    useEffect(() => { busRef.current = busId; setVerdict(null); }, [busId]);
    const [verdict, setVerdict] = useState<any>(null);
    const [checking, setChecking] = useState(false);
    const [typed, setTyped] = useState('');
    const [cam, setCam] = useState<'starting' | 'on' | 'off' | 'denied' | 'unsupported' | 'insecure' | 'error'>('starting');
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const aimRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const loopRef = useRef<number | null>(null);
    const aliveRef = useRef(true);
    const inFlight = useRef(false);
    const lastCode = useRef<{ code: string; at: number }>({ code: '', at: 0 });
    const feedback = useRef(createFeedback());
    const rootRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // One read → one check (the same code within 3 s is the same sighting).
    const check = useCallback(async (raw: string) => {
        const read = classifyRead(raw);
        if (!read || inFlight.current || !busRef.current) return;
        const code = read.kind === 'reg' ? read.code : String(read.value || '').trim();
        const now = Date.now();
        if (code === lastCode.current.code && now - lastCode.current.at < SAME_CODE_MS) { lastCode.current.at = now; return; }
        lastCode.current = { code, at: now };
        inFlight.current = true; setChecking(true);
        try {
            const r = await conferenceApi.checkBoarding(busRef.current, raw);
            if (!aliveRef.current) return;
            setVerdict({ ...r, at: now });
            if (r.result === 'ok') feedback.current.ok(); else feedback.current.bad();
        } catch (e: any) {
            if (!aliveRef.current) return;
            setVerdict({ result: 'error', message: e?.message || '', at: now });
            feedback.current.bad();
        } finally { inFlight.current = false; if (aliveRef.current) setChecking(false); }
    }, []);
    const checkRef = useRef(check);
    checkRef.current = check;

    // ── camera ──
    const stopCamera = useCallback(() => {
        if (loopRef.current != null) { clearTimeout(loopRef.current); loopRef.current = null; }
        const s = streamRef.current; streamRef.current = null;
        if (s) s.getTracks().forEach((t) => { try { t.stop(); } catch { /* stopped */ } });
        if (videoRef.current) videoRef.current.srcObject = null;
    }, []);
    const loop = useCallback(async () => {
        const video = videoRef.current, stream = streamRef.current;
        if (!video || !stream) return;
        let spent = 0;
        try {
            if (!inFlight.current && video.readyState >= 2 && video.videoWidth > 0 && !video.paused) {
                const native = await getNativeDetector();
                if (native) {
                    const codes = await native.detect(video);
                    for (const c of codes || []) { checkRef.current(String(c.rawValue || '')); break; }
                } else {
                    const canvas = canvasRef.current || (canvasRef.current = document.createElement('canvas'));
                    const t0 = performance.now();
                    const hit = decodeCameraFrame(video, canvas, aimRef.current);
                    spent = performance.now() - t0;
                    if (hit) checkRef.current(hit.text);
                }
            }
        } catch { /* a bad frame: the next one */ }
        if (streamRef.current === stream && aliveRef.current) loopRef.current = window.setTimeout(loop, Math.max(80, Math.min(1000, Math.round(spent * 1.5))));
    }, []);
    const startCamera = useCallback(async () => {
        const avail = cameraAvailability();
        if (avail !== 'ok') { setCam(avail); return; }
        stopCamera();
        setCam('starting');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
            if (!aliveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
            streamRef.current = stream;
            const el = videoRef.current;
            if (el) { el.srcObject = stream; el.setAttribute('playsinline', 'true'); el.muted = true; const p = el.play(); if (p && p.catch) p.catch(() => { /* a tap starts it */ }); }
            setCam('on');
            loopRef.current = window.setTimeout(loop, 150);
        } catch (e: any) {
            stopCamera();
            setCam(cameraFailure(e).cam);
        }
    }, [loop, stopCamera]);

    useEffect(() => {
        aliveRef.current = true;
        feedback.current.prime();
        startCamera();
        const release = lockBodyScroll();
        const onVis = () => { if (document.visibilityState === 'hidden') stopCamera(); else if (cameraAvailability() === 'ok') startCamera(); };
        // Esc closes; a USB / Bluetooth reader types into the code box even when nothing has the focus.
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { onClose(); return; }
            const t = e.target as HTMLElement | null;
            const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
            if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) inputRef.current?.focus();
        };
        document.addEventListener('visibilitychange', onVis);
        window.addEventListener('keydown', onKey);
        return () => {
            aliveRef.current = false;
            document.removeEventListener('visibilitychange', onVis);
            window.removeEventListener('keydown', onKey);
            stopCamera(); feedback.current.close(); release();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Without a camera the code box is the way in: give it the focus.
    useEffect(() => { if (['denied', 'unsupported', 'insecure', 'error'].includes(cam)) inputRef.current?.focus(); }, [cam]);
    const bus = buses.find((b) => b.id === busId);
    const lines = boardingLines(tx, verdict);
    const tone = verdict ? TONE[verdict.result] || TONE.error : null;
    const camMessage = cam === 'denied' ? tx('transport.board.cam.denied', 'Sin permiso para la cámara. Puedes usar un lector o escribir el código.')
        : cam === 'insecure' ? tx('transport.board.cam.insecure', 'La cámara necesita una conexión segura (https).')
            : cam === 'unsupported' || cam === 'error' ? tx('transport.board.cam.none', 'No hay cámara disponible. Usa un lector o escribe el código.') : '';

    const ui = (
        <div ref={rootRef} style={SCANNER_ROOT_STYLE} role="dialog" aria-modal="true" aria-label={tx('transport.board.title', 'Verificar abordaje')} data-boarding-scanner="" tabIndex={-1}>
            <style>{SCANNER_CSS}</style>
            <div style={{ ...SCANNER_BAR_STYLE, padding: `12px ${SAFE_RIGHT} 10px ${SAFE_LEFT}`, paddingTop: 'max(12px, env(safe-area-inset-top))', display: 'flex', gap: 10, alignItems: 'center' }}>
                <i className="fa-solid fa-bus" aria-hidden="true" style={{ color: '#7dd3fc' }}></i>
                <select value={busId} onChange={(e) => setBusId(Number(e.target.value))} aria-label={tx('transport.board.bus', 'Bus que aborda')} data-boarding-bus=""
                    style={{ flex: 1, minWidth: 0, minHeight: 44, borderRadius: 12, padding: '0 10px', fontSize: 16, fontWeight: 800, color: '#111', background: '#fff' }}>
                    {buses.map((b) => <option key={b.id} value={b.id}>{b.name}{b.origin || b.destination ? ` · ${[b.origin, b.destination].filter(Boolean).join(' → ')}` : ''}</option>)}
                </select>
                <button type="button" onClick={onClose} aria-label={tx('transport.board.close', 'Cerrar')}
                    style={{ minWidth: 44, minHeight: 44, borderRadius: 12, background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 18 }}>
                    <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>

            <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', touchAction: 'none' }}>
                <video ref={videoRef} playsInline muted autoPlay style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                    <AimFrame frameRef={aimRef} scanning={cam === 'on' && !checking} />
                </div>
                <p style={{ position: 'absolute', left: 0, right: 0, top: 12, textAlign: 'center', fontSize: 13, fontWeight: 800, textShadow: '0 1px 2px #000' }}>
                    {checking ? tx('transport.board.checking', 'Comprobando…') : tx('transport.board.aim', 'Apunta al código QR de la escarapela')}
                </p>
                {camMessage && <p role="status" style={{ position: 'absolute', left: 16, right: 16, top: '40%', textAlign: 'center', fontSize: 14, fontWeight: 700, background: 'rgba(0,0,0,0.7)', padding: 12, borderRadius: 12 }}>{camMessage}</p>}

                {verdict && tone && (
                    <div role="status" aria-live="assertive" data-boarding-verdict={verdict.result}
                        style={{ position: 'absolute', left: SAFE_LEFT, right: SAFE_RIGHT, bottom: 12, background: tone.bg, color: '#fff', borderRadius: 20, padding: '16px 18px', boxShadow: '0 10px 30px rgba(0,0,0,.45)' }}
                        onClick={() => setVerdict(null)}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <i className={`fa-solid ${tone.icon}`} aria-hidden="true" style={{ fontSize: 34 }}></i>
                            <div style={{ minWidth: 0 }}>
                                <p style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.15 }}>{lines.title}</p>
                                {bus && verdict.result !== 'unknown' && verdict.result !== 'error' && <p style={{ fontSize: 12, opacity: 0.85, fontWeight: 700 }}>{tx('transport.board.boarding', 'Abordando:')} {bus.name}</p>}
                            </div>
                        </div>
                        {lines.lines.map((l, i) => <p key={i} style={{ marginTop: 6, fontSize: i === 0 ? 18 : 14, fontWeight: i === 0 ? 800 : 600, overflowWrap: 'anywhere' }}>{l}</p>)}
                    </div>
                )}
            </div>

            <form noValidate onSubmit={(e) => { e.preventDefault(); const v = typed.trim(); if (v) { lastCode.current = { code: '', at: 0 }; check(v); setTyped(''); } }}
                style={{ ...SCANNER_BAR_STYLE, display: 'flex', gap: 8, padding: `10px ${SAFE_RIGHT} 10px ${SAFE_LEFT}`, paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}>
                <input ref={inputRef} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={tx('transport.board.type', 'Lector o código escrito')} autoComplete="off" autoCapitalize="characters" spellCheck={false}
                    aria-label={tx('transport.board.type', 'Lector o código escrito')} data-boarding-input=""
                    style={{ flex: 1, minWidth: 0, minHeight: 44, borderRadius: 12, padding: '0 12px', fontSize: 16, fontWeight: 700, color: '#111', background: '#fff' }} />
                <button type="submit" disabled={!typed.trim() || checking} style={{ minHeight: 44, padding: '0 16px', borderRadius: 12, background: '#0284c7', color: '#fff', fontWeight: 900, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: !typed.trim() || checking ? 0.5 : 1 }}>
                    {tx('transport.board.check', 'Comprobar')}
                </button>
            </form>
        </div>
    );
    return typeof document !== 'undefined' ? createPortal(ui, document.body) : ui;
}
