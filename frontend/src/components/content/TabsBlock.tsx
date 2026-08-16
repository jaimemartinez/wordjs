"use client";
/**
 * Tabs block — client island (active-tab state). Shared verbatim by the editor canvas and the
 * public ContentRenderer.
 */
import React from "react";
import { bc, blockVars, cx, unit } from "@/components/blocks/blockVars";

export default function TabsBlock({ tabs, color, activeColor, borderColor, borderWidth, tabPad, panelBg, panelPad, panelRadius, css }: any) {
    const [activeTab, setActiveTab] = React.useState(0);
    return (
        <div
            className={bc('tabs')}
            style={{
                ...blockVars('tabs', {
                    color,
                    'active-color': activeColor,
                    'border-color': borderColor,
                    'border-width': unit(borderWidth),
                    'tab-pad': tabPad,
                    'panel-bg': panelBg,
                    'panel-pad': unit(panelPad),
                    'panel-radius': unit(panelRadius),
                }),
                ...css,
            }}
        >
            <div className={bc('tabs__list')} role="tablist">
                {tabs?.map((tab: any, index: number) => (
                    <button
                        key={index}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === index}
                        className={cx(bc('tabs__tab'), activeTab === index && 'is-active')}
                        onClick={() => setActiveTab(index)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className={bc('tabs__panel')} role="tabpanel">
                {tabs?.[activeTab]?.content}
            </div>
        </div>
    );
}
