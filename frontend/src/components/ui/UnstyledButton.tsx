"use client";

import React, { forwardRef } from "react";

/**
 * UnstyledButton — the kit's escape hatch for a bespoke clickable (a list row, a swatch, a canvas handle,
 * a card that opens something). It brings no look of its own, only what every button must have:
 * type="button" unless told otherwise, a visible keyboard focus ring, and disabled semantics. Use Button,
 * IconButton, Tabs or SegmentedControl whenever one of them fits.
 */
export const UnstyledButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(function UnstyledButton(
    { type, className = "", ...props },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type ?? "button"}
            className={`focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed ${className}`}
            {...props}
        />
    );
});

export default UnstyledButton;
