/**
 * Admin content table — a SCHEDULED ('future') post must be first-class.
 *
 * The regression this pins: the backend's status=any listing omitted 'future', so a scheduled post
 * vanished from the admin table even though the badge mapping below already knew how to paint it.
 * Rendered markup is asserted with `renderToStaticMarkup` (node environment, no jsdom — the project
 * convention), through the SAME mapping the table row uses (statusBadgeView) and the real es catalog.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STATUS_TABS, statusBadgeView } from "../ContentTable";
import { StatusBadge } from "@/components/ui";
import { translations } from "@/lib/i18n";

const t = (k: string) => (translations.es as Record<string, string>)[k] || k;

describe("ContentTable — scheduled posts", () => {
    it("maps 'future' to the scheduled badge with the catalog label", () => {
        expect(statusBadgeView("future", t)).toEqual({ status: "scheduled", label: "Programado" });
    });

    it("RENDERS the scheduled badge visibly, with the info palette (not the unknown-status fallback)", () => {
        const html = renderToStaticMarkup(<StatusBadge {...statusBadgeView("future", t)} />);
        expect(html).toContain("Programado");
        expect(html).toContain("text-blue-600"); // statusMap.scheduled → info; neutral would mean unmapped
    });

    it("keeps the existing status mappings intact", () => {
        expect(statusBadgeView("publish", t)).toEqual({ status: "published", label: "Publicado" });
        expect(statusBadgeView("draft", t)).toEqual({ status: "draft", label: "Borrador" });
        expect(statusBadgeView("pending", t)).toEqual({ status: "pending", label: "pending" });
    });

    it("offers a Scheduled tab whose filter key is the real DB status ('future')", () => {
        const tab = STATUS_TABS.find((x) => x.key === "future");
        expect(tab).toBeTruthy();
        expect(t(tab!.labelKey)).toBe("Programadas");
        // The 'All' tab stays first — it is the privilege-scoped server-side 'any'.
        expect(STATUS_TABS[0].key).toBe("any");
    });
});
