/**
 * Bus de invalidación de useEditorMenu.ts: tras una mutación del store nav_menu (MenuItemsEditor),
 * `invalidateEditorMenus()` debe subir la versión y notificar a los suscriptores — es lo que hace
 * que el <nav> del canvas refetchee sin recargar el editor. Entorno node puro.
 */
import { describe, expect, it, vi } from "vitest";
import {
    getEditorMenuVersion,
    invalidateEditorMenus,
    subscribeEditorMenuInvalidation,
} from "../useEditorMenu";

describe("useEditorMenu — bus de invalidación", () => {
    it("cada invalidación sube la versión en exactamente 1 y notifica a todos los suscriptores", () => {
        const a = vi.fn();
        const b = vi.fn();
        const offA = subscribeEditorMenuInvalidation(a);
        const offB = subscribeEditorMenuInvalidation(b);

        const before = getEditorMenuVersion();
        invalidateEditorMenus();
        expect(getEditorMenuVersion()).toBe(before + 1);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);

        invalidateEditorMenus();
        expect(getEditorMenuVersion()).toBe(before + 2);
        expect(a).toHaveBeenCalledTimes(2);

        offA();
        offB();
    });

    it("la desuscripción detiene las notificaciones (y no afecta a los demás)", () => {
        const kept = vi.fn();
        const dropped = vi.fn();
        const offKept = subscribeEditorMenuInvalidation(kept);
        const offDropped = subscribeEditorMenuInvalidation(dropped);

        offDropped();
        invalidateEditorMenus();
        expect(dropped).not.toHaveBeenCalled();
        expect(kept).toHaveBeenCalledTimes(1);
        offKept();
    });

    it("un suscriptor que se desuscribe DURANTE la notificación no rompe la iteración", () => {
        const order: string[] = [];
        const offSelf = subscribeEditorMenuInvalidation(() => {
            order.push("self");
            offSelf();
        });
        const offOther = subscribeEditorMenuInvalidation(() => order.push("other"));

        invalidateEditorMenus();
        expect(order).toEqual(["self", "other"]);
        offOther();
    });
});
