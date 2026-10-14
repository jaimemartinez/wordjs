"use client";

import React, { createContext, useContext, useMemo, useState, useSyncExternalStore, ReactNode } from "react";
import ConfirmationModal from "@/components/ConfirmationModal";
import { getStoredLanguage, t, Language } from "@/lib/i18n";

/** Button labels a caller can pass instead of the localized defaults. */
export interface DialogLabels {
    confirmText?: string;
    cancelText?: string;
}

interface ModalContextType {
    alert: (message: string, title?: string, labels?: DialogLabels) => Promise<void>;
    confirm: (message: string, title?: string, isDanger?: boolean, labels?: DialogLabels) => Promise<boolean>;
}

/** The dialog on screen as the caller asked for it; what it left out is filled in when it renders. */
export interface ModalRequest {
    type: "alert" | "confirm";
    message: string;
    title?: string;
    isDanger: boolean;
    labels: DialogLabels;
}

export interface ModalController extends ModalContextType {
    current: () => ModalRequest | null;
    subscribe: (listener: () => void) => () => void;
    /** The reader answered: true = the confirming button, false = Cancel, Escape or the backdrop. */
    answer: (confirmed: boolean) => void;
}

/**
 * The state behind useModal(), kept outside React so it can be driven without a DOM. A new request
 * replaces the one on screen (as before, the replaced promise never settles).
 */
export function createModalController(): ModalController {
    let current: ModalRequest | null = null;
    let settle: (confirmed: boolean) => void = () => { };
    const listeners = new Set<() => void>();

    const show = (next: ModalRequest | null) => {
        current = next;
        listeners.forEach((listener) => listener());
    };
    const open = (request: ModalRequest) => new Promise<boolean>((resolve) => {
        settle = resolve;
        show(request);
    });

    return {
        alert: (message, title, labels = {}) =>
            open({ type: "alert", message, title, isDanger: false, labels }).then(() => undefined),
        confirm: (message, title, isDanger = false, labels = {}) =>
            open({ type: "confirm", message, title, isDanger, labels }),
        answer: (confirmed) => {
            // ConfirmationModal's confirming button calls onConfirm and then onClose: the first answer wins.
            const resolve = settle;
            settle = () => { };
            show(null);
            resolve(confirmed);
        },
        current: () => current,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

/** The title and button labels a request shows: the caller's own, else the defaults in `lang`. */
export function modalText(request: ModalRequest, lang: Language) {
    const isAlert = request.type === "alert";
    return {
        title: request.title ?? t(isAlert ? "dialog.alert.title" : "dialog.confirm.title", lang),
        confirmText: request.labels.confirmText ?? t(isAlert ? "dialog.ok" : "dialog.confirm", lang),
        cancelText: request.labels.cancelText ?? t("dialog.cancel", lang),
    };
}

/**
 * The host dialog of a controller. ModalProvider is mounted in app/layout.tsx, ABOVE the admin's and the
 * portals' I18nProvider, so its defaults come from the language every provider reads and writes
 * ('wordjs-lang' in localStorage, 'es' when unset), read when a dialog opens.
 */
export function ModalDialog({ controller }: { controller: ModalController }) {
    const request = useSyncExternalStore(controller.subscribe, controller.current, controller.current);
    const text = request ? modalText(request, getStoredLanguage()) : null;

    return (
        <ConfirmationModal
            isOpen={!!request}
            onClose={() => controller.answer(false)}
            onConfirm={() => controller.answer(true)}
            title={text?.title ?? ""}
            message={request?.message ?? ""}
            isDanger={request?.isDanger ?? false}
            confirmText={text?.confirmText}
            cancelText={text?.cancelText}
        />
    );
}

const ModalContext = createContext<ModalContextType | undefined>(undefined);

export function ModalProvider({ children }: { children: ReactNode }) {
    const [controller] = useState(createModalController);
    const value = useMemo<ModalContextType>(() => ({ alert: controller.alert, confirm: controller.confirm }), [controller]);

    return (
        <ModalContext.Provider value={value}>
            {children}
            <ModalDialog controller={controller} />
        </ModalContext.Provider>
    );
}

export function useModal() {
    const context = useContext(ModalContext);
    if (!context) {
        throw new Error("useModal must be used within a ModalProvider");
    }
    return context;
}
