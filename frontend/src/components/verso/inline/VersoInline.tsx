"use client";
/**
 * Verso — VersoInline: edición inline declarativa IN SITU con Tiptap (F2).
 *
 * Se monta DENTRO del bloque activo (VersoBlock lo pinta en lugar del render
 * del bloque cuando `inlineEditingId === nodeId` y el registry declara
 * `BlockDefinition.inline`), en el MISMO documento del iframe — sin portal al
 * padre: el árbol React ya vive portaleado en el canvas, así que Tiptap hereda
 * el contexto del bloque sin puentes por window.* (a diferencia del
 * InlineTiptap del editor actual, que registra window.puckCommitActive — ese
 * acoplo es exactamente lo que este componente sustituye; se reutiliza su
 * stack Tiptap/BubbleMenu, no su código).
 *
 * Contrato de commits (inlineSession.ts, lógica pura testeada):
 * - onUpdate → session.onContent: commits parciales throttled
 *   (INLINE_COMMIT_THROTTLE_MS) vía handle.transact(setProps) con coalesceKey
 *   `inline:<nodeId>` — la coalescencia del store agrupa la sesión en pocas
 *   entradas de undo.
 * - schema "rich": HTML de editor.getHTML() pasado por la MISMA sanitizeHTML
 *   isomórfica de lib/sanitize antes de setProps (defensa en profundidad; el
 *   saneado del servidor no cambia). "<p></p>" vacío se normaliza a "".
 * - schema "plain": texto de editor.getText() tal cual (no es HTML; React lo
 *   escapa al render y el servidor sanea los PUCK_HTML_FIELDS al guardar).
 *   Enter deshabilitado (handleKeyDown) y sin marcas ni bubble menu.
 * - Escape o mousedown fuera (del editable Y del bubble menu) → session.end():
 *   commit final + setInlineEditing(null). handle.commitInline() también hace
 *   flush: la sesión está suscrita a inlineEditingId (ver inlineSession.ts).
 */
import React from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { sanitizeHTML } from "@/lib/sanitize";
import { useVersoRenderContext } from "../render/context";
import { createInlineSession, type InlineSession } from "./inlineSession";

export interface VersoInlineProps {
    /** Clave interna del nodo en edición (== inlineEditingId). */
    nodeId: string;
    /** Prop de destino declarada en BlockDefinition.inline. */
    prop: string;
    schema: "rich" | "plain";
}

/**
 * rich: el mismo stack del InlineTiptap actual acotado al contrato F2
 * (negrita/cursiva/enlace/listas). heading:false — un Heading inline es plain.
 */
const RICH_EXTENSIONS = [
    StarterKit.configure({ heading: false, link: { openOnClick: false } }),
];

/** plain: solo doc/paragraph/text — sin marcas, sin estructuras de bloque. */
const PLAIN_EXTENSIONS = [
    StarterKit.configure({
        heading: false,
        bold: false,
        italic: false,
        strike: false,
        underline: false,
        code: false,
        link: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
    }),
];

/**
 * Contenido inicial de un schema plain como JSON de ProseMirror: el valor es
 * TEXTO, pasarlo como string lo interpretaría como HTML (un título con "<b>"
 * literal se parsearía). El nodo de texto lo preserva byte a byte.
 */
function plainDocOf(text: string): { type: string; content: Array<Record<string, unknown>> } {
    return {
        type: "doc",
        content: [{ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) }],
    };
}

/** rich: "<p></p>" (doc vacío de Tiptap) se normaliza a "" antes de sanear. */
function richTransform(raw: string): string {
    return sanitizeHTML(raw === "<p></p>" ? "" : raw);
}

/** plain: texto tal cual (no es HTML; ver doc-comment del módulo). */
function plainTransform(raw: string): string {
    return raw;
}

const BUBBLE_BTN_CLS =
    "flex h-7 w-7 items-center justify-center rounded text-xs leading-none transition";

function BubbleButton({
    label,
    active,
    onCmd,
    children,
}: {
    label: string;
    active?: boolean;
    onCmd: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            // preventDefault en mousedown: conserva la selección/foco del editor.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCmd}
            className={`${BUBBLE_BTN_CLS} ${active ? "bg-white/25 text-white" : "text-gray-200 hover:bg-white/10"}`}
        >
            {children}
        </button>
    );
}

/**
 * Control de enlace mínimo (sin el buscador de contenido del editor actual —
 * evita importar components/puck/*): input de URL en el propio bubble menu.
 * La selección se captura al abrir (el input roba el foco) y se restaura al
 * aplicar — mismo patrón que el LinkButton de referencia.
 */
function InlineLinkControl({ editor }: { editor: Editor }) {
    const [open, setOpen] = React.useState(false);
    const [url, setUrl] = React.useState("");
    const selRef = React.useRef<{ from: number; to: number } | null>(null);

    const openPopover = () => {
        const { from, to } = editor.state.selection;
        selRef.current = { from, to };
        setUrl((editor.getAttributes("link").href as string) || "");
        setOpen(true);
    };

    const apply = (href: string) => {
        const chain = editor.chain().focus();
        if (selRef.current) chain.setTextSelection(selRef.current);
        if (!href.trim()) chain.extendMarkRange("link").unsetLink().run();
        else chain.extendMarkRange("link").setLink({ href: href.trim() }).run();
        setOpen(false);
    };

    return (
        <span className="relative inline-flex">
            <BubbleButton
                label="Enlace"
                active={editor.isActive("link") || open}
                onCmd={() => (open ? setOpen(false) : openPopover())}
            >
                🔗
            </BubbleButton>
            {open && (
                <span
                    className="absolute left-0 top-full z-10 mt-1 flex w-56 items-center gap-1 rounded bg-gray-900 p-1 shadow-xl"
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <input
                        autoFocus
                        type="text"
                        value={url}
                        spellCheck={false}
                        aria-label="URL del enlace"
                        placeholder="https://… o /pagina"
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                apply(url);
                            }
                        }}
                        className="min-w-0 flex-1 rounded bg-white/10 px-1.5 py-1 text-xs text-white placeholder:text-gray-400 focus:outline-none"
                    />
                    <button
                        type="button"
                        aria-label="Aplicar enlace"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => apply(url)}
                        className={`${BUBBLE_BTN_CLS} text-gray-200 hover:bg-white/10`}
                    >
                        ✓
                    </button>
                    {editor.isActive("link") && (
                        <button
                            type="button"
                            aria-label="Quitar enlace"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => apply("")}
                            className={`${BUBBLE_BTN_CLS} text-gray-200 hover:bg-white/10`}
                        >
                            ✕
                        </button>
                    )}
                </span>
            )}
        </span>
    );
}

export default function VersoInline({ nodeId, prop, schema }: VersoInlineProps) {
    const { handle } = useVersoRenderContext();

    // Valor inicial UNA vez: Tiptap no es controlado; los commits parciales
    // cambian node.props (y la referencia del nodo) sin re-alimentar el editor.
    const [initialValue] = React.useState<string>(() => {
        const v = handle.getDoc().nodes[nodeId]?.props[prop];
        return typeof v === "string" ? v : "";
    });

    // La sesión se crea en un efecto (no en render: crear una suscripción al
    // store durante el render es un side effect y StrictMode la duplicaría).
    const sessionRef = React.useRef<InlineSession | null>(null);
    React.useEffect(() => {
        const session = createInlineSession({
            handle,
            nodeId,
            prop,
            transform: schema === "rich" ? richTransform : plainTransform,
        });
        sessionRef.current = session;
        return () => {
            sessionRef.current = null;
            // Cleanup de React (desmontaje o cambio de nodo): flush del
            // pendiente SIN tocar inlineEditingId (eso es de end()/el store).
            session.dispose();
        };
    }, [handle, nodeId, prop, schema]);

    const editor = useEditor({
        immediatelyRender: false,
        extensions: schema === "rich" ? RICH_EXTENSIONS : PLAIN_EXTENSIONS,
        content: schema === "rich" ? initialValue || "" : plainDocOf(initialValue),
        autofocus: "end",
        editorProps: {
            attributes: {
                class: "focus:outline-none",
                "data-wjs-inline-editor": schema,
            },
            // plain: Enter deshabilitado (una sola línea, coherente con un título).
            ...(schema === "plain"
                ? { handleKeyDown: (_view: unknown, event: KeyboardEvent) => event.key === "Enter" }
                : {}),
        },
        onUpdate: ({ editor: e }) => {
            sessionRef.current?.onContent(schema === "plain" ? e.getText() : e.getHTML());
        },
    });

    // Escape o mousedown fuera (del editable Y del bubble menu) → commit final
    // + cierre. Listeners en el documento del IFRAME (ownerDocument del
    // editable) y en el del padre (paneles del editor): el componente corre en
    // el contexto JS del padre, así que `document` ES el documento padre.
    React.useEffect(() => {
        if (!editor) return;
        const editorRoot = editor.view.dom;
        const frameDoc = editorRoot.ownerDocument;
        const onDown = (e: Event) => {
            const t = e.target as Node | null;
            if (!t) return;
            const inEditor = editorRoot.contains(t);
            const inBubble = t instanceof Element && !!t.closest("[data-wjs-inline-bubble]");
            if (inEditor || inBubble) return;
            sessionRef.current?.end();
        };
        const onKey = (e: Event) => {
            if ((e as KeyboardEvent).key !== "Escape") return;
            e.stopPropagation(); // que no lo consuman el DnD ni el modo mover
            sessionRef.current?.end();
        };
        const docs: Document[] = frameDoc === document ? [frameDoc] : [frameDoc, document];
        for (const d of docs) {
            d.addEventListener("mousedown", onDown, true);
            d.addEventListener("keydown", onKey, true);
        }
        return () => {
            for (const d of docs) {
                d.removeEventListener("mousedown", onDown, true);
                d.removeEventListener("keydown", onKey, true);
            }
        };
    }, [editor]);

    if (!editor) return null;

    return (
        <div data-wjs-inline={nodeId} data-wjs-inline-schema={schema}>
            {schema === "rich" && (
                <BubbleMenu editor={editor}>
                    {/* El marcador data-wjs-inline-bubble es lo que el detector de
                        click-fuera considera "dentro" — garantizado ancestro de los
                        botones, ponga donde ponga el className la versión de menus. */}
                    <div
                        data-wjs-inline-bubble=""
                        role="toolbar"
                        aria-label="Formato del texto"
                        className="flex items-center gap-0.5 rounded-lg bg-gray-900 p-1 shadow-xl"
                    >
                        <BubbleButton
                            label="Negrita"
                            active={editor.isActive("bold")}
                            onCmd={() => editor.chain().focus().toggleBold().run()}
                        >
                            <strong>B</strong>
                        </BubbleButton>
                        <BubbleButton
                            label="Cursiva"
                            active={editor.isActive("italic")}
                            onCmd={() => editor.chain().focus().toggleItalic().run()}
                        >
                            <em>I</em>
                        </BubbleButton>
                        <InlineLinkControl editor={editor} />
                        <BubbleButton
                            label="Lista"
                            active={editor.isActive("bulletList")}
                            onCmd={() => editor.chain().focus().toggleBulletList().run()}
                        >
                            ••
                        </BubbleButton>
                        <BubbleButton
                            label="Lista numerada"
                            active={editor.isActive("orderedList")}
                            onCmd={() => editor.chain().focus().toggleOrderedList().run()}
                        >
                            1.
                        </BubbleButton>
                    </div>
                </BubbleMenu>
            )}
            <EditorContent editor={editor} />
        </div>
    );
}
