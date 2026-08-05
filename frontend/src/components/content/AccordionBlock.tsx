"use client";
/**
 * Accordion block — client island (open-panel state). Shared verbatim by the editor canvas and the
 * public ContentRenderer.
 */
import React from "react";
import { blockVars, cx, unit } from "@/components/puck/blockVars";

export default function AccordionBlock({ items, bg, borderColor, radius, pad, headerBg, headerColor, activeColor, panelBg, panelColor, css }: any) {
    const [openIndex, setOpenIndex] = React.useState<number | null>(0);
    return (
        <div
            className="wp-block-accordion"
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
                    <div key={index} className={cx('wp-block-accordion__item', open && 'is-open')}>
                        <button
                            type="button"
                            className="wp-block-accordion__header"
                            aria-expanded={open}
                            onClick={() => setOpenIndex(open ? null : index)}
                        >
                            {item.title}
                            <i className="fa-solid fa-chevron-down wp-block-accordion__icon" aria-hidden="true"></i>
                        </button>
                        {open && <div className="wp-block-accordion__panel">{item.content}</div>}
                    </div>
                );
            })}
        </div>
    );
}
