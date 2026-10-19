/**
 * «Pagos de cuotas» in the coordinator portal — the fourth review round (node, no DOM):
 *   - the words under each part are the administration's («Queda pagado al validarse», «… lo pendiente» when
 *     other money of theirs still waits, «Faltará $X») — not a portal-only «queda al día al validarse»;
 *   - an amount typed «250» reads «250,00» once its field is left, so a «Manual» split never mixes «250»,
 *     «250,00» and «100».
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { balanceC, checkDraft, newDraft, type DraftContext, type BalanceC } from "../../../../../../marketplace/plugins/conference-manager/client/portal/feePayments";
import { tidyMoneyInput } from "../../../../../../marketplace/plugins/conference-manager/client/portal/feeSplit";
import RegisterPaymentSheet, { afterText } from "../../../../../../marketplace/plugins/conference-manager/client/portal/RegisterPaymentSheet";
import { MoneyInput } from "../../../../../../marketplace/plugins/conference-manager/client/portal/ui";

const flat = (html: string) => html.replace(/<!-- -->/g, "");

describe("the words under a part", () => {
    it("afterText: «Faltará $X» / «Queda pagado al validarse lo pendiente» / «Queda pagado al validarse»", () => {
        expect(afterText(12000)).toBe("Faltará $120,00");
        expect(afterText(0, 2500)).toBe("Queda pagado al validarse lo pendiente");
        expect(afterText(0)).toBe("Queda pagado al validarse");
        expect(afterText(12000, 2500)).toBe("Faltará $120,00");
    });
    it("checkDraft knows each person's OTHER money awaiting validation (an edited payment's own part left out)", () => {
        const balances = new Map<number, BalanceC>([[1, balanceC({ due: 500, validated: 0, pending: 0 })], [2, balanceC({ due: 500, validated: 0, pending: 250 })]]);
        const ctx: DraftContext = { balances, methods: ["Efectivo"], proofRequiredFor: ["Transferencia"], maxPeople: 200 } as DraftContext;
        const d = { ...newDraft([1, 2], ["Efectivo"], null), method: "Efectivo", mode: "manual" as const, total: "750", manual: { 1: "500", 2: "250" } };
        const parts = checkDraft(d, ctx).parts;
        expect(parts.map((p) => [p.id, p.afterOwed, p.otherPending])).toEqual([[1, 0, 0], [2, 0, 25000]]);
        // Correcting a pending payment that holds Luis's 250: his own part is not «other».
        const own = checkDraft({ ...d, ownPending: true, ownParts: { 2: 25000 } }, ctx).parts;
        expect(own.find((p) => p.id === 2)!.otherPending).toBe(0);
    });
    it("the sheet shows them under each part", () => {
        const balances = new Map<number, BalanceC>([[1, balanceC({ due: 500, validated: 0, pending: 0 })], [2, balanceC({ due: 500, validated: 0, pending: 250 })]]);
        const ctx: DraftContext = { balances, methods: ["Efectivo"], proofRequiredFor: ["Transferencia"], maxPeople: 200 } as DraftContext;
        const d = { ...newDraft([1, 2], ["Efectivo"], null), method: "Efectivo", mode: "manual" as const, total: "750", totalTouched: true, manual: { 1: "500,00", 2: "250,00" } };
        const html = flat(renderToStaticMarkup(<RegisterPaymentSheet draft={d} setDraft={() => {}} ctx={ctx} nameOf={(id) => `P${id}`} groups={[]} busy={false} error={null} personErrors={{}} onSubmit={() => {}} onClose={() => {}} />));
        expect(html).toContain('data-split-after="1">Queda pagado al validarse</span>');
        expect(html).toContain('data-split-after="2">Queda pagado al validarse lo pendiente</span>');
        expect(html).not.toContain("al día al validarse");
    });
});

describe("an amount reads the same way in every field", () => {
    it("tidyMoneyInput", () => {
        expect(tidyMoneyInput("250")).toBe("250,00");
        expect(tidyMoneyInput("1.250,5")).toBe("1.250,50");
        expect(tidyMoneyInput("100.5")).toBe("100,50");
        expect(tidyMoneyInput("250,00")).toBe("250,00");
        expect(tidyMoneyInput("abc")).toBe("abc");
        expect(tidyMoneyInput("")).toBe("");
    });
    it("MoneyInput: leaving it writes the amount the sheet's way; a tidy or unreadable value is left alone", () => {
        const input = (value: string, onChange: (v: string) => void) => {
            const el = MoneyInput({ value, onChange, label: "Parte" }) as React.ReactElement<{ children: React.ReactElement[] }>;
            return (el.props.children as React.ReactElement<{ onBlur: () => void }>[])[1];
        };
        const onChange = vi.fn();
        input("250", onChange).props.onBlur();
        expect(onChange).toHaveBeenCalledWith("250,00");
        onChange.mockClear();
        input("250,00", onChange).props.onBlur();
        input("abc", onChange).props.onBlur();
        expect(onChange).not.toHaveBeenCalled();
    });
});
