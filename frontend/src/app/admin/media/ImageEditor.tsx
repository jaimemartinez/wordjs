"use client";

/**
 * The media library's image editor (QA S1-15): rotate, flip, crop and scale down, then POST /media/:id/edit.
 * The preview is a canvas drawn with the same order the server applies (rotate → flip); the crop box sits
 * over it in fractions of the turned image, which is what the server takes. Mouse, touch and keyboard all
 * move the box (arrows move it, Shift + arrows resize it).
 */
import { useEffect, useRef, useState } from "react";
import { mediaApi, type MediaItem } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { useToast } from "@/contexts/ToastContext";
import DialogLayer from "@/components/DialogLayer";
import { Button } from "@/components/ui";
import {
    FULL_CROP, clampCrop, cropForAspect, dragCrop, editRequest, resultSize, rotatedSize, turn,
    type CropBox, type ImageEditState,
} from "@/lib/imageEdit";

const ASPECTS: Array<{ key: string; value: number | "original" | null }> = [
    { key: "free", value: null },
    { key: "original", value: "original" },
    { key: "1:1", value: 1 },
    { key: "4:3", value: 4 / 3 },
    { key: "3:2", value: 3 / 2 },
    { key: "16:9", value: 16 / 9 },
];

const PREVIEW_MAX_W = 720;
const PREVIEW_MAX_H = 440;

type Corner = "nw" | "ne" | "sw" | "se";

export default function ImageEditor({ item, onClose, onSaved }: { item: MediaItem; onClose: () => void; onSaved: (updated: MediaItem) => void }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [state, setState] = useState<ImageEditState>({ rotate: 0, flipH: false, flipV: false, crop: FULL_CROP, width: null });
    const [aspectKey, setAspectKey] = useState("free");
    const [saving, setSaving] = useState(false);
    const drag = useRef<{ mode: "move" | Corner; startX: number; startY: number; start: CropBox } | null>(null);

    // The natural size is what the browser shows (EXIF orientation applied), the same frame the server
    // turns from after its own auto-orientation.
    const srcW = img?.naturalWidth || item.mediaDetails?.width || 0;
    const srcH = img?.naturalHeight || item.mediaDetails?.height || 0;
    const turned = rotatedSize(srcW, srcH, state.rotate);
    const scale = turned.width && turned.height ? Math.min(PREVIEW_MAX_W / turned.width, PREVIEW_MAX_H / turned.height, 1) : 1;
    const viewW = Math.max(1, Math.round(turned.width * scale));
    const viewH = Math.max(1, Math.round(turned.height * scale));
    const aspectValue = (() => {
        const a = ASPECTS.find((x) => x.key === aspectKey)?.value ?? null;
        return a === "original" ? (srcW && srcH ? turned.width / turned.height : null) : a;
    })();
    const result = resultSize(srcW, srcH, state);
    const request = editRequest(srcW, srcH, state);

    useEffect(() => {
        const image = new Image();
        image.onload = () => setImg(image);
        image.onerror = () => setLoadFailed(true);
        image.src = item.sourceUrl;
    }, [item.sourceUrl]);

    // Rotate first, then mirror the turned image — the server's order.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !img) return;
        canvas.width = viewW;
        canvas.height = viewH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, viewW, viewH);
        ctx.save();
        ctx.translate(viewW / 2, viewH / 2);
        ctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
        ctx.rotate((state.rotate * Math.PI) / 180);
        const dw = srcW * scale, dh = srcH * scale;
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
    }, [img, state.rotate, state.flipH, state.flipV, viewW, viewH, srcW, srcH, scale]);

    // A turn or a flip changes what the box sits on: it starts again from the chosen ratio.
    const reshape = (next: Partial<ImageEditState>, aspect: number | null = aspectValue) => {
        setState((s) => {
            const merged = { ...s, ...next };
            const r = rotatedSize(srcW, srcH, merged.rotate);
            const a = aspectKey === "original" ? (r.width / r.height) : aspect;
            return { ...merged, crop: cropForAspect(a, r.width, r.height) };
        });
    };

    const chooseAspect = (key: string) => {
        setAspectKey(key);
        const a = ASPECTS.find((x) => x.key === key)?.value ?? null;
        const value = a === "original" ? turned.width / turned.height : a;
        setState((s) => ({ ...s, crop: cropForAspect(value, turned.width, turned.height) }));
    };

    const startDrag = (mode: "move" | Corner, e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = { mode, startX: e.clientX, startY: e.clientY, start: state.crop };
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const d = drag.current;
        const frame = frameRef.current;
        if (!d || !frame) return;
        const rect = frame.getBoundingClientRect();
        const dx = (e.clientX - d.startX) / rect.width;
        const dy = (e.clientY - d.startY) / rect.height;
        const crop = dragCrop(d.start, d.mode, dx, dy, aspectValue, turned.width, turned.height);
        setState((s) => ({ ...s, crop }));
    };
    const endDrag = () => { drag.current = null; };

    const onCropKey = (e: React.KeyboardEvent) => {
        const step = 0.01;
        const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        const m = moves[e.key];
        if (!m) return;
        e.preventDefault();
        const crop = e.shiftKey
            ? dragCrop(state.crop, "se", m[0], m[1], aspectValue, turned.width, turned.height)
            : dragCrop(state.crop, "move", m[0], m[1], null, turned.width, turned.height);
        setState((s) => ({ ...s, crop }));
    };

    const save = async () => {
        if (!request) return;
        setSaving(true);
        try {
            const updated = await mediaApi.editImage(item.id, request);
            addToast(t("media.edit.saved"), "success");
            onSaved(updated);
        } catch (error) {
            addToast(error instanceof Error && error.message ? error.message : t("media.edit.failed"), "error");
        } finally {
            setSaving(false);
        }
    };

    const c = clampCrop(state.crop);
    const toolClass = "min-h-11 px-3 rounded-xl border border-gray-200 bg-white text-sm font-bold text-gray-700 hover:bg-gray-50 flex items-center gap-2";
    const corners: Array<{ k: Corner; pos: React.CSSProperties }> = [
        { k: "nw", pos: { left: -10, top: -10, cursor: "nwse-resize" } },
        { k: "ne", pos: { right: -10, top: -10, cursor: "nesw-resize" } },
        { k: "sw", pos: { left: -10, bottom: -10, cursor: "nesw-resize" } },
        { k: "se", pos: { right: -10, bottom: -10, cursor: "nwse-resize" } },
    ];

    return (
        <DialogLayer className="flex items-center justify-center p-3 sm:p-6 bg-black/90 backdrop-blur-md">
            <div className="absolute inset-0" onClick={onClose}></div>
            <div role="dialog" aria-modal="true" aria-labelledby="image-editor-title" className="relative bg-white rounded-3xl shadow-2xl max-w-5xl w-full max-h-[calc(100dvh-1.5rem)] overflow-y-auto p-4 sm:p-6 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h3 id="image-editor-title" className="text-xl font-black text-gray-900">{t("media.edit.title")}</h3>
                        <p className="text-xs font-medium text-gray-500 mt-1">{t("media.edit.keepsEarlier")}</p>
                    </div>
                    <button type="button" onClick={onClose} aria-label={t("common.close")} className="w-11 h-11 shrink-0 rounded-full bg-gray-50 text-gray-500 hover:bg-gray-100 flex items-center justify-center">
                        <i className="fa-solid fa-xmark text-lg"></i>
                    </button>
                </div>

                <div className="flex flex-wrap gap-2" role="toolbar" aria-label={t("media.edit.title")}>
                    <button type="button" className={toolClass} onClick={() => reshape({ rotate: turn(state.rotate, -90) })}>
                        <i className="fa-solid fa-rotate-left" aria-hidden="true"></i>{t("media.edit.rotateLeft")}
                    </button>
                    <button type="button" className={toolClass} onClick={() => reshape({ rotate: turn(state.rotate, 90) })}>
                        <i className="fa-solid fa-rotate-right" aria-hidden="true"></i>{t("media.edit.rotateRight")}
                    </button>
                    <button type="button" className={toolClass} aria-pressed={state.flipH} onClick={() => reshape({ flipH: !state.flipH })}>
                        <i className="fa-solid fa-left-right" aria-hidden="true"></i>{t("media.edit.flipH")}
                    </button>
                    <button type="button" className={toolClass} aria-pressed={state.flipV} onClick={() => reshape({ flipV: !state.flipV })}>
                        <i className="fa-solid fa-up-down" aria-hidden="true"></i>{t("media.edit.flipV")}
                    </button>
                    <label className="flex items-center gap-2 text-sm font-bold text-gray-700">
                        {t("media.edit.aspect")}
                        <select className="min-h-11 rounded-xl border border-gray-200 px-2 text-sm" value={aspectKey} onChange={(e) => chooseAspect(e.target.value)}>
                            {ASPECTS.map((a) => (
                                <option key={a.key} value={a.key}>
                                    {a.key === "free" ? t("media.edit.aspectFree") : a.key === "original" ? t("media.edit.aspectOriginal") : a.key}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button type="button" className={toolClass} onClick={() => { setAspectKey("free"); setState((s) => ({ ...s, crop: FULL_CROP })); }}>
                        <i className="fa-solid fa-expand" aria-hidden="true"></i>{t("media.edit.resetCrop")}
                    </button>
                </div>

                <div className="flex items-center justify-center bg-gray-100 rounded-2xl p-3 sm:p-6 min-h-[200px]">
                    {loadFailed ? (
                        <p className="text-sm text-red-600">{t("media.edit.failed")}</p>
                    ) : (
                        <div
                            ref={frameRef}
                            className="relative touch-none select-none max-w-full"
                            style={{ width: viewW, aspectRatio: `${viewW} / ${viewH}` }}
                            onPointerMove={onPointerMove}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                        >
                            <canvas ref={canvasRef} className="block w-full h-full" aria-hidden="true" />
                            {img && (
                                // The dimmed outside: a spread shadow on a copy of the box, clipped to the image (the
                                // box itself is not clipped, so its corner handles stay whole at the edges).
                                <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
                                    <div className="absolute" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.width * 100}%`, height: `${c.height * 100}%`, boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)" }} />
                                </div>
                            )}
                            {img && (
                                <div
                                    role="group"
                                    tabIndex={0}
                                    aria-label={t("media.edit.cropArea")}
                                    onKeyDown={onCropKey}
                                    onPointerDown={(e) => startDrag("move", e)}
                                    className="absolute outline-none focus-visible:ring-4 focus-visible:ring-blue-400 border-2 border-white"
                                    style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.width * 100}%`, height: `${c.height * 100}%`, cursor: "move" }}
                                    data-testid="crop-box"
                                >
                                    {corners.map(({ k, pos }) => (
                                        <span
                                            key={k}
                                            aria-hidden="true"
                                            title={t("media.edit.cropHandle")}
                                            onPointerDown={(e) => startDrag(k, e)}
                                            style={pos}
                                            className="absolute w-5 h-5 rounded-full bg-white border-2 border-blue-600"
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <label htmlFor="image-editor-width" className="text-[11px] font-black uppercase tracking-widest text-gray-500 block mb-1.5">{t("media.edit.width")}</label>
                        <input
                            id="image-editor-width"
                            type="number"
                            min={1}
                            inputMode="numeric"
                            className="w-40 min-h-11 rounded-xl border border-gray-200 px-3 text-sm"
                            value={state.width ?? ""}
                            onChange={(e) => setState((s) => ({ ...s, width: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null }))}
                            aria-describedby="image-editor-width-help"
                        />
                        <p id="image-editor-width-help" className="text-[11px] text-gray-500 mt-1">{t("media.edit.widthHelp")}</p>
                    </div>
                    <p className="text-sm font-bold text-gray-700" aria-live="polite">
                        {t("media.edit.result").replace("{w}", String(result.width)).replace("{h}", String(result.height))}
                    </p>
                    <div className="flex gap-2">
                        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
                        <Button icon="fa-floppy-disk" loading={saving} disabled={!request || saving || !img} onClick={save}>{t("media.edit.save")}</Button>
                    </div>
                </div>
            </div>
        </DialogLayer>
    );
}
