"use client";

import React, { forwardRef } from "react";

/**
 * HiddenFileInput — the file chooser behind a screen's own drop area (react-dropzone's getInputProps(), or a
 * ref the area clicks). The area is what people see and use; this input only opens the browser's chooser,
 * so it stays out of the tab order and the accessibility tree. For a plain "choose a file" button use
 * FileButton instead.
 */
export const HiddenFileInput = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">>(
    function HiddenFileInput(props, ref) {
        return <input ref={ref} type="file" hidden tabIndex={-1} aria-hidden="true" {...props} />;
    },
);

export default HiddenFileInput;
