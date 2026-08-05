"use client";
/**
 * Tabs block — client island (active-tab state). Shared verbatim by the editor canvas and the
 * public ContentRenderer.
 */
import React from "react";
import { blockVars, cx, unit } from "@/components/puck/blockVars";

export default function TabsBlock({ tabs, color, activeColor, borderColor, borderWidth, tabPad, panelBg, panelPad, panelRadius, css }: any) {
    const [activeTab, setActiveTab] = React.useState(0);
    return (
        <div
            className="wp-block-tabs"
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
            <div className="wp-block-tabs__list" role="tablist">
                {tabs?.map((tab: any, index: number) => (
                    <button
                        key={index}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === index}
                        className={cx('wp-block-tabs__tab', activeTab === index && 'is-active')}
                        onClick={() => setActiveTab(index)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="wp-block-tabs__panel" role="tabpanel">
                {tabs?.[activeTab]?.content}
            </div>
        </div>
    );
}
