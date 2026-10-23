"use client";

import { useRef, useState } from "react";
import { Button, type ButtonProps } from "./Button";

export interface FileButtonProps extends Omit<ButtonProps, "onChange" | "onDrop"> {
    /** Called with the chosen (or dropped) files. */
    onFiles: (files: File[]) => void;
    accept?: string;
    multiple?: boolean;
    /** Files dropped on the button are taken too. */
    droppable?: boolean;
}

/**
 * FileButton — a Button that opens the file chooser (a hidden <input type="file"> behind it), and
 * optionally takes files dropped on it. The same file can be picked twice in a row.
 */
export function FileButton({ onFiles, accept, multiple, droppable, children, className = "", disabled, ...props }: FileButtonProps) {
    const input = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);
    const take = (list: FileList | null) => {
        const files = list ? Array.from(list) : [];
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
    };
    return (
        <>
            <Button
                {...props}
                disabled={disabled}
                onClick={(e) => { props.onClick?.(e); if (!e.defaultPrevented) input.current?.click(); }}
                onDragOver={droppable ? (e) => { e.preventDefault(); setOver(true); } : undefined}
                onDragLeave={droppable ? () => setOver(false) : undefined}
                onDrop={droppable ? (e) => { e.preventDefault(); setOver(false); if (!disabled) take(e.dataTransfer.files); } : undefined}
                className={`${over ? "ring-4 ring-blue-200" : ""} ${className}`}
            >
                {children}
            </Button>
            <input
                ref={input}
                type="file"
                accept={accept}
                multiple={multiple}
                hidden
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => { take(e.target.files); e.target.value = ""; }}
            />
        </>
    );
}

export default FileButton;
