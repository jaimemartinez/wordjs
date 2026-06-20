"use client";

import React from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle, Color, FontSize } from "@tiptap/extension-text-style";
import { HexColorPicker } from "react-colorful";

/**
 * InlineTiptap — in-place rich-text editing for a Text/Heading block.
 *
 * The block's own element hosts a Tiptap (ProseMirror) editor in its real position, so it inherits
 * the block's actual background (transparent) and color → identical to the rendered text (white text
 * over a dark hero stays visible). Formatting is a floating BubbleMenu (just buttons) that appears on
 * selection.
 *
 * Saving is CONTINUOUS (debounced onUpdate) so changes are never lost — there is deliberately NO
 * commit-on-blur, because Tiptap's BubbleMenu renders in a portal OUTSIDE the editable, so clicking a
 * toolbar button blurs the editor; closing on blur would slam the editor shut on every button press.
 * Editing closes only on a genuine click-away (outside BOTH the editable and the toolbar) or Escape.
 *
 * `onCommit` saves the HTML (no close). `onClose` exits edit mode. `inline` (Heading) disables block
 * structures and strips the single wrapping <p> so the heading stays inline-only.
 */
// Quick-pick text colors for the toolbar swatch popover (WordJS creator palette + common tones).
const TEXT_COLORS: { name: string; value: string }[] = [
    { name: "Negro", value: "#0f172a" },
    { name: "Gris", value: "#64748b" },
    { name: "Rojo", value: "#dc2626" },
    { name: "Naranja", value: "#ea580c" },
    { name: "Ámbar", value: "#d97706" },
    { name: "Verde", value: "#16a34a" },
    { name: "Teal", value: "#0d9488" },
    { name: "Azul", value: "#2563eb" },
    { name: "Índigo", value: "#4f46e5" },
    { name: "Morado", value: "#7c3aed" },
    { name: "Rosa", value: "#db2777" },
    { name: "Blanco", value: "#ffffff" },
];

/**
 * ColorButton — a custom text-color control for the BubbleMenu: a palette swatch grid + a custom
 * color picker + a remove-color action, in the editor's own UI (replaces the bare native <input
 * type="color"> that opened the OS picker). Module-level so it keeps its open state across renders.
 */
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80];

// Font-size stepper for the toolbar: − [current px] +. Reads the active textStyle fontSize, falling
// back to the editor's computed base size, and snaps up/down the FONT_SIZES scale.
function FontSizeControl({ editor }: { editor: any }) {
    const attrSize = parseInt((editor.getAttributes("textStyle").fontSize as string) || "", 10);
    let base = 16;
    try {
        base = parseInt(getComputedStyle(editor.view.dom).fontSize, 10) || 16;
    } catch {
        /* getComputedStyle unavailable (SSR / detached) — keep 16 */
    }
    const current = attrSize || base;

    const setSize = (px: number) => editor.chain().focus().setFontSize(`${px}px`).run();
    const dec = () => setSize([...FONT_SIZES].reverse().find((s) => s < current) ?? FONT_SIZES[0]);
    const inc = () => setSize(FONT_SIZES.find((s) => s > current) ?? FONT_SIZES[FONT_SIZES.length - 1]);

    return (
        <div className="flex items-center">
            <button
                type="button"
                title="Reducir tamaño"
                onMouseDown={(e) => e.preventDefault()}
                onClick={dec}
                className="w-7 h-8 rounded-md flex items-center justify-center text-gray-200 hover:bg-white/10 transition"
            >
                <i className="fa-solid fa-minus text-[10px]"></i>
            </button>
            <span
                className="text-[11px] font-semibold text-gray-300 w-6 text-center tabular-nums select-none"
                title="Tamaño de fuente (px)"
            >
                {current}
            </span>
            <button
                type="button"
                title="Aumentar tamaño"
                onMouseDown={(e) => e.preventDefault()}
                onClick={inc}
                className="w-7 h-8 rounded-md flex items-center justify-center text-gray-200 hover:bg-white/10 transition"
            >
                <i className="fa-solid fa-plus text-[10px]"></i>
            </button>
        </div>
    );
}

// Normalize a textStyle color (which may come back as rgb(...)) to a #rrggbb hex for the picker/input.
const toHex = (c: string): string => {
    if (!c) return "#2563eb";
    if (c[0] === "#") return c.length === 4 ? "#" + c.slice(1).split("").map((x) => x + x).join("") : c;
    const m = c.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
        const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
        return "#" + h(+m[1]) + h(+m[2]) + h(+m[3]);
    }
    return "#2563eb";
};

function ColorButton({ editor }: { editor: any }) {
    const [open, setOpen] = React.useState(false);
    const [custom, setCustom] = React.useState(false);
    const ref = React.useRef<HTMLDivElement>(null);
    const current: string = (editor.getAttributes("textStyle").color as string) || "";
    const hex = toHex(current);

    const [hexInput, setHexInput] = React.useState(hex);
    React.useEffect(() => { setHexInput(hex); }, [hex]);

    const close = () => { setOpen(false); setCustom(false); };

    React.useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) close();
        };
        document.addEventListener("mousedown", onDoc, true);
        return () => document.removeEventListener("mousedown", onDoc, true);
    }, [open]);

    const setColor = (c: string) => editor.chain().focus().setColor(c).run();
    const removeColor = () => { editor.chain().focus().unsetColor().run(); close(); };

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                title="Color del texto"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setOpen((o) => !o)}
                className={`w-8 h-8 rounded-md flex flex-col items-center justify-center transition ${
                    open ? "bg-white/15 text-white" : "text-gray-200 hover:bg-white/10"
                }`}
            >
                <i className="fa-solid fa-palette text-[13px] leading-none"></i>
                <span className="block w-4 h-[3px] rounded-full mt-[3px]" style={{ backgroundColor: current || "#e5e7eb" }}></span>
            </button>

            {open && (
                <div
                    className={`absolute top-full left-1/2 -translate-x-1/2 mt-2 z-[100001] rounded-xl bg-white shadow-2xl border border-gray-200 p-2.5 ${custom ? "w-[212px]" : "w-[184px]"}`}
                    onMouseDown={(e) => e.preventDefault()}
                >
                    {!custom ? (
                        <>
                            <div className="grid grid-cols-6 gap-1.5">
                                {TEXT_COLORS.map((c) => {
                                    const active = hex.toLowerCase() === c.value.toLowerCase();
                                    return (
                                        <button
                                            key={c.value}
                                            type="button"
                                            title={c.name}
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => { setColor(c.value); close(); }}
                                            className={`w-6 h-6 rounded-full transition hover:scale-110 ${
                                                active ? "ring-2 ring-offset-1 ring-editor-primary" : "ring-1 ring-gray-200"
                                            }`}
                                            style={{ backgroundColor: c.value }}
                                        />
                                    );
                                })}
                            </div>
                            <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-gray-100">
                                <button
                                    type="button"
                                    title="Color personalizado"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => setCustom(true)}
                                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-gray-50 hover:bg-gray-100 text-[11px] font-semibold text-gray-600"
                                >
                                    <i className="fa-solid fa-eye-dropper text-[10px]"></i>
                                    Personalizado
                                </button>
                                <button
                                    type="button"
                                    title="Quitar color"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={removeColor}
                                    className="px-2.5 py-1.5 rounded-lg bg-gray-50 hover:bg-gray-100 text-[11px] font-semibold text-gray-600"
                                >
                                    <i className="fa-solid fa-ban text-[10px]"></i>
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="wjs-colorful">
                                <HexColorPicker color={hex} onChange={setColor} />
                            </div>
                            <div className="flex items-center gap-1.5 mt-2.5">
                                <span className="w-7 h-7 rounded-md ring-1 ring-gray-200 shrink-0" style={{ backgroundColor: hex }}></span>
                                <input
                                    type="text"
                                    value={hexInput}
                                    spellCheck={false}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setHexInput(v);
                                        if (/^#[0-9a-fA-F]{6}$/.test(v.trim())) setColor(v.trim());
                                    }}
                                    placeholder="#2563EB"
                                    className="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-[11px] font-mono uppercase text-gray-700 focus:outline-none focus:ring-2 focus:ring-editor-primary/30 focus:border-editor-primary"
                                />
                            </div>
                            <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-gray-100">
                                <button
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => setCustom(false)}
                                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-gray-50 hover:bg-gray-100 text-[11px] font-semibold text-gray-600"
                                >
                                    <i className="fa-solid fa-arrow-left text-[10px]"></i>
                                    Volver
                                </button>
                                <button
                                    type="button"
                                    title="Quitar color"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={removeColor}
                                    className="px-2.5 py-1.5 rounded-lg bg-gray-50 hover:bg-gray-100 text-[11px] font-semibold text-gray-600"
                                >
                                    <i className="fa-solid fa-ban text-[10px]"></i>
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

export default function InlineTiptap({
    html,
    inline = false,
    elementId,
    onCommit,
    onClose,
}: {
    html: string;
    inline?: boolean;
    elementId?: string;
    onCommit: (html: string) => void;
    onClose: () => void;
}) {
    const inlineRef = React.useRef(inline);
    inlineRef.current = inline;
    const onCommitRef = React.useRef(onCommit);
    onCommitRef.current = onCommit;
    const onCloseRef = React.useRef(onClose);
    onCloseRef.current = onClose;
    const debTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const save = React.useCallback((raw: string) => {
        let out = raw === "<p></p>" ? "" : raw;
        if (inlineRef.current) out = out.replace(/^<p>([\s\S]*?)<\/p>\s*$/i, "$1");
        onCommitRef.current(out);
    }, []);

    const editor = useEditor({
        immediatelyRender: false,
        extensions: [
            StarterKit.configure({
                heading: false,
                link: { openOnClick: false },
                ...(inline
                    ? {
                          bulletList: false,
                          orderedList: false,
                          listItem: false,
                          blockquote: false,
                          codeBlock: false,
                          horizontalRule: false,
                      }
                    : {}),
            }),
            TextStyle,
            Color,
            FontSize,
        ],
        content: html || "",
        autofocus: "end",
        editorProps: {
            attributes: {
                class: "prose max-w-none focus:outline-none",
                ...(elementId ? { id: elementId } : {}),
            },
        },
        onUpdate: ({ editor }) => {
            // Debounced continuous save — never lose changes, never close on blur.
            if (debTimer.current) clearTimeout(debTimer.current);
            debTimer.current = setTimeout(() => save(editor.getHTML()), 300);
        },
    });

    // Close only on a real click-away or Escape; flush the pending save first. Also expose the
    // window.puckCommitActive flusher the page-save handler calls before persisting.
    React.useEffect(() => {
        if (!editor) return;
        // Attach the close-detector to the document the EDITOR actually lives in (not necessarily the
        // top document) so it catches clicks even if the preview is in a nested context.
        const doc = editor.view.dom.ownerDocument || document;
        const flushClose = () => {
            if (debTimer.current) clearTimeout(debTimer.current);
            save(editor.getHTML());
            onCloseRef.current();
        };
        // "Inside" means anywhere within the block's editing wrapper (.inline-text-view) — NOT just the
        // contenteditable. Clicking the block's padding/min-height area targets the wrapper (the PARENT
        // of editor.view.dom), so a contains() check on view.dom wrongly reported "outside" and closed
        // the editor on every click in the block.
        const editorRoot = (editor.view.dom.closest(".inline-text-view") as Element | null) || editor.view.dom;
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node | null;
            if (!t) return;
            const inEditor = editorRoot.contains(t);
            const inBubble = t instanceof Element && !!t.closest(".wjs-bubble-menu");
            if (inEditor || inBubble) return;
            flushClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") flushClose();
        };
        doc.addEventListener("mousedown", onDown, true);
        doc.addEventListener("keydown", onKey, true);
        // The BubbleMenu can portal to the TOP document even when the editor is nested — listen there
        // too so toolbar clicks are recognized as "inside".
        if (doc !== document) document.addEventListener("mousedown", onDown, true);

        // Stop Puck's drag-and-drop (dnd-kit) from hijacking the pointer on the block while editing:
        // dragging to SELECT text would otherwise start a BLOCK drag, killing the selection (and the
        // BubbleMenu). A NATIVE bubble listener on the block wrapper stops the event before React's
        // root delegation hands it to Puck's draggable handlers. ProseMirror's own native selection on
        // the contenteditable has already fired (at the target, earlier), so text selection still works.
        const stopForPuck = (e: Event) => e.stopPropagation();
        editorRoot.addEventListener("pointerdown", stopForPuck);
        editorRoot.addEventListener("mousedown", stopForPuck);
        editorRoot.addEventListener("dragstart", stopForPuck);

        (window as any).puckCommitActive = () => save(editor.getHTML());
        return () => {
            doc.removeEventListener("mousedown", onDown, true);
            doc.removeEventListener("keydown", onKey, true);
            if (doc !== document) document.removeEventListener("mousedown", onDown, true);
            editorRoot.removeEventListener("pointerdown", stopForPuck);
            editorRoot.removeEventListener("mousedown", stopForPuck);
            editorRoot.removeEventListener("dragstart", stopForPuck);
            if (debTimer.current) clearTimeout(debTimer.current);
            if ((window as any).puckCommitActive) (window as any).puckCommitActive = null;
        };
    }, [editor, save]);

    if (!editor) return null;

    const Btn = ({
        onCmd,
        active,
        icon,
        title,
    }: {
        onCmd: () => void;
        active?: boolean;
        icon: string;
        title: string;
    }) => (
        <button
            type="button"
            title={title}
            onMouseDown={(e) => e.preventDefault()} // keep the editor selection/focus
            onClick={onCmd}
            className={`w-8 h-8 rounded-md flex items-center justify-center text-sm transition ${
                active ? "bg-editor-primary text-white" : "text-gray-200 hover:bg-white/10"
            }`}
        >
            <i className={`fa-solid ${icon}`}></i>
        </button>
    );

    const Sep = () => <span className="w-px h-5 bg-white/15 mx-0.5" />;

    return (
        <>
            <BubbleMenu editor={editor} className="z-[100000]">
              {/* Inner wrapper carries the .wjs-bubble-menu marker the close-detector checks, so it's
                  guaranteed to be an ancestor of the buttons regardless of where v3 puts className. */}
              <div className="wjs-bubble-menu flex items-center gap-0.5 bg-gray-900 rounded-xl shadow-2xl p-1 border border-white/10">
                <Btn title="Negrita" icon="fa-bold" active={editor.isActive("bold")} onCmd={() => editor.chain().focus().toggleBold().run()} />
                <Btn title="Cursiva" icon="fa-italic" active={editor.isActive("italic")} onCmd={() => editor.chain().focus().toggleItalic().run()} />
                <Btn title="Subrayado" icon="fa-underline" active={editor.isActive("underline")} onCmd={() => editor.chain().focus().toggleUnderline().run()} />
                <Btn title="Tachado" icon="fa-strikethrough" active={editor.isActive("strike")} onCmd={() => editor.chain().focus().toggleStrike().run()} />
                <Sep />
                <Btn
                    title="Enlace"
                    icon="fa-link"
                    active={editor.isActive("link")}
                    onCmd={() => {
                        const prev = (editor.getAttributes("link").href as string) || "";
                        const url = window.prompt("URL del enlace:", prev);
                        if (url === null) return;
                        if (url === "") editor.chain().focus().extendMarkRange("link").unsetLink().run();
                        else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
                    }}
                />
                <ColorButton editor={editor} />
                <Sep />
                <FontSizeControl editor={editor} />
                {!inline && (
                    <>
                        <Sep />
                        <Btn title="Lista" icon="fa-list-ul" active={editor.isActive("bulletList")} onCmd={() => editor.chain().focus().toggleBulletList().run()} />
                        <Btn title="Lista numerada" icon="fa-list-ol" active={editor.isActive("orderedList")} onCmd={() => editor.chain().focus().toggleOrderedList().run()} />
                    </>
                )}
              </div>
            </BubbleMenu>

            <EditorContent editor={editor} />
        </>
    );
}
