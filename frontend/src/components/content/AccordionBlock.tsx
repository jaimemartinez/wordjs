"use client";
/**
 * Accordion block — client island (open-panel state). Shared verbatim by the editor canvas and the
 * public ContentRenderer.
 */
import React from "react";
import { bc, blockVars, cx, unit } from "@/components/blocks/blockVars";

export default function AccordionBlock({ items, bg, borderColor, radius, pad, headerBg, headerColor, activeColor, panelBg, panelColor, css }: any) {
    const [openIndex, setOpenIndex] = React.useState<number | null>(0);
    return (
        <div
            className={bc('accordion')}
            style={{
                ...blockVars('accordion', {
                    bg,
                    'border-color': borderColor,
                    radius: unit(radius),
                    pad,
                    'header-bg': headerBg,
                    'header-color': headerColor,
                    'active-color': activeColor,
                    'panel-bg': panelBg,
                    'panel-color': panelColor,
                }),
                ...css,
            }}
        >
            {items?.map((item: any, index: number) => {
                const open = openIndex === index;
                return (
                    <div key={index} className={cx(bc('accordion__item'), open && 'is-open')}>
                        <button
                            type="button"
                            className={bc('accordion__header')}
                            aria-expanded={open}
                            onClick={() => setOpenIndex(open ? null : index)}
                        >
                            {item.title}
                            <i className={cx('fa-solid fa-chevron-down', bc('accordion__icon'))} aria-hidden="true"></i>
                        </button>
                        {open && <div className={bc('accordion__panel')}>{item.content}</div>}
                    </div>
                );
            })}
        </div>
    );
}
