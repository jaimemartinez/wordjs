"use client";
/**
 * Accordion block — client island (open-panel state). Shared verbatim by the editor canvas and the
 * public ContentRenderer.
 */
import React from "react";
import { bc, blockVars, cx, safeCss, unit } from "@/components/blocks/blockVars";

export default function AccordionBlock({ items, bg, borderColor, radius, pad, headerBg, headerColor, activeColor, panelBg, panelColor, css }: any) {
    const [openIndex, setOpenIndex] = React.useState<number | null>(0);
    // Prefijo estable para atar cada cabecera con su panel (`aria-controls`). Ahora que el panel
    // vive SIEMPRE en el DOM, esa relación es real y comprobable, no un adorno.
    const uid = React.useId();
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
                ...safeCss(css),
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
                            aria-controls={`${uid}-p${index}`}
                            onClick={() => setOpenIndex(open ? null : index)}
                        >
                            {item.title}
                            <i className={cx('fa-solid fa-chevron-down', bc('accordion__icon'))} aria-hidden="true"></i>
                        </button>
                        {/* El panel vive SIEMPRE en el DOM: antes se montaba y desmontaba, así que no
                            había nada que animar y abría de golpe. Ahora lo revela una transición de
                            altura hecha con grid (wordjs-ui.css) — cerrado es `visibility:hidden`, o
                            sea fuera del árbol de accesibilidad y del orden de tabulación, y su
                            contenido sigue en el HTML del servidor (rastreable). El envoltorio
                            interior es el que la técnica de grid necesita para recortar. */}
                        <div id={`${uid}-p${index}`} className={bc('accordion__panel')} role="region">
                            {/* Dos capas y no una: la de fuera RECORTA (overflow+min-height:0) y la
                                de dentro lleva el relleno. El relleno no colapsa con `min-height:0`
                                —la caja mide contenido más relleno—, así que en una sola capa el
                                panel cerrado se quedaba en 32px en vez de cero. */}
                            <div className={bc('accordion__panel-inner')}>
                                <div className={bc('accordion__panel-body')}>{item.content}</div>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
