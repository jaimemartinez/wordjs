"use client";
/**
 * The body field of Settings → Emails: Verso's own rich-text surface (components/verso/inline/VersoTextSurface)
 * mounted outside the canvas — paragraphs, bold, italic, lists and links from the selection bubble, never raw
 * HTML. The surface is uncontrolled: it reads `initialValue` once, so the parent re-keys this component to
 * load another message or language.
 *
 * `insertRef` lets the placeholder chips put `{key}` at the caret: the text node goes into the DOM where the
 * selection is and an `input` event tells the surface to read the DOM back (the same path as typing).
 */
import React from "react";
import VersoTextSurface, { INLINE_HOST_SENTINEL } from "@/components/verso/inline/VersoTextSurface";

export type InsertAtCaret = (text: string) => boolean;

interface Props {
    id: string;
    initialValue: string;
    onChange(html: string): void;
    insertRef?: React.MutableRefObject<InsertAtCaret | null>;
    labelledBy: string;
    describedBy?: string;
}

export default function EmailBodyEditor({ id, initialValue, onChange, insertRef, labelledBy, describedBy }: Props) {
    const rootRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (!insertRef) return;
        insertRef.current = (text: string) => {
            const host = rootRef.current?.querySelector<HTMLElement>("[data-wjs-inline]");
            const sel = typeof window !== "undefined" ? window.getSelection() : null;
            if (!host || !sel || !sel.rangeCount || !host.contains(sel.anchorNode)) return false;
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const node = document.createTextNode(text);
            range.insertNode(node);
            range.setStartAfter(node);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            host.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        };
        return () => { insertRef.current = null; };
    }, [insertRef]);

    return (
        <div
            ref={rootRef}
            data-wjs-block-id={`email-body-${id}`}
            className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-[15px] leading-relaxed text-gray-800 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 [&_a]:text-blue-600 [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6"
        >
            <div role="textbox" aria-multiline="true" aria-labelledby={labelledBy} aria-describedby={describedBy} className="min-h-[10rem] outline-none">
                {INLINE_HOST_SENTINEL}
            </div>
            <VersoTextSurface
                nodeId={`email-body-${id}`}
                schema="rich"
                initialValue={initialValue}
                onContent={onChange}
                onRequestEnd={() => { /* the field stays editable: there is no session to end here */ }}
            />
        </div>
    );
}
