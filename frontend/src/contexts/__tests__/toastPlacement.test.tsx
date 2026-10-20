/**
 * Where the toast stack sits (core ToastContext). A phone — narrow, or a short touch screen (held sideways) —
 * gets it at the TOP, below the safe area: at the bottom (z 9999) it covered the pinned action row of whatever
 * sheet or dialog was open under it (the admin person sheet's «Editar · Cancelar inscripción · Eliminar», a
 * payment's «Devolver / Rechazar / Validar», the portal's «Enviar pago»). A desktop keeps the bottom right.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TOAST_PHONE_CSS, ToastItem, ToastProvider, toastCloseLabel } from "@/contexts/ToastContext";
import fs from "node:fs";
import path from "node:path";

describe("toast placement", () => {
    const out = renderToStaticMarkup(<ToastProvider><p>page</p></ToastProvider>);
    it("on a phone (narrow, or short and touch) the stack moves to the top, clear of the safe area and of a sheet's ✕", () => {
        expect(TOAST_PHONE_CSS).toMatch(/^@media \(max-width: 639\.98px\), \(max-height: 500px\) and \(pointer: coarse\) \{/);
        const rule = /\[data-wjs-toasts\] \{([^}]*)\}/.exec(TOAST_PHONE_CSS);
        expect(rule).not.toBeNull();
        expect(rule![1]).toContain("top: max(1rem, env(safe-area-inset-top));");
        expect(rule![1]).toContain("bottom: auto;");
        expect(rule![1]).toContain("right: calc(max(1rem, env(safe-area-inset-right)) + 3.25rem);");
        // The rule is rendered with the stack (unlayered: it wins over the container's Tailwind classes).
        expect(out).toContain(`<style>${TOAST_PHONE_CSS}</style>`);
    });
    it("a toast's ✕ has a name and a 44 px target, without growing the toast (2.18.0 review UX6-10)", () => {
        const one = renderToStaticMarkup(<ToastItem toast={{ id: "1", message: "Inscripción eliminada", type: "success" }} onClose={() => {}} closeLabel="Cerrar" />);
        const btn = /<button[^>]*data-toast-close=""[^>]*>/.exec(one)![0];
        expect(btn).toContain('type="button"');
        expect(btn).toContain('aria-label="Cerrar"');
        expect(btn).toContain("min-w-11 min-h-11 -m-3");
        expect(btn).not.toContain("p-1");
        expect(one).toContain('<i class="fa-solid fa-xmark text-sm" aria-hidden="true"></i>');
        expect(one).toContain("bg-green-600/95 text-white");
        // The name: the admin's language (the stored one; «Cerrar» by default), «Cerrar» given by the Spanish portal.
        expect(toastCloseLabel()).toBe("Cerrar");
        const src = fs.readFileSync(path.resolve(__dirname, "../ToastContext.tsx"), "utf8");
        expect(src).toContain("<ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} closeLabel={closeLabel ?? toastCloseLabel()} />");
        const portal = fs.readFileSync(path.resolve(__dirname, "../../../../marketplace/plugins/conference-manager/client/portal/CoordinatorPortal.tsx"), "utf8");
        expect(portal).toContain('<ToastProvider closeLabel="Cerrar">');
    });
    it("the desktop placement stays: bottom right, above every layer; the stack is a polite live region", () => {
        const stack = /<div[^>]*data-wjs-toasts[^>]*>/.exec(out)![0];
        expect(stack).toContain("bottom-[max(1rem,env(safe-area-inset-bottom))]");
        expect(stack).toContain("sm:left-auto");
        expect(stack).toContain("z-[9999]");
        expect(stack).toContain('role="status"');
        expect(stack).toContain('aria-live="polite"');
    });
});
