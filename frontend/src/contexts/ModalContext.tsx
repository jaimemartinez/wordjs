"use client";

import React, { createContext, useContext, useMemo, useState, useSyncExternalStore, ReactNode } from "react";
import ConfirmationModal from "@/components/ConfirmationModal";
import { getStoredLanguage, t, Language } from "@/lib/i18n";

/** Button labels a caller can pass instead of the localized defaults. */
export interface DialogLabels {
    confirmText?: string;
    cancelText?: string;
}

/** What a prompt's text box starts with and how it is typed. */
export interface PromptOptions extends DialogLabels {
    defaultValue?: string;
    placeholder?: string;
    /** The input's type: "text" (default), "email", "url" or "number". */
    inputType?: "text" | "email" | "url" | "number";
}

interface ModalContextType {
    alert: (message: string, title?: string, labels?: DialogLabels) => Promise<void>;
    confirm: (message: string, title?: string, isDanger?: boolean, labels?: DialogLabels) => Promise<boolean>;
    /**
     * The host's replacement for the browser's prompt(), which WordJS never uses: resolves to what the
     * reader typed, or null when they cancel (Cancel, Escape or the backdrop).
     */
    prompt: (message: string, title?: string, options?: PromptOptions) => Promise<string | null>;
}

/** The dialog on screen as the caller asked for it; what it left out is filled in when it renders. */
export interface ModalRequest {
    type: "alert" | "confirm" | "prompt";
    message: string;
    title?: string;
    isDanger: boolean;
    labels: DialogLabels;
    /** Set for a prompt: its text box. */
    input?: { defaultValue: string; placeholder?: string; inputType: "text" | "email" | "url" | "number" };
}

export interface ModalController extends ModalContextType {
    current: () => ModalRequest | null;
    subscribe: (listener: () => void) => () => void;
    /**
     * The reader answered: true = the confirming button, false = Cancel, Escape or the backdrop. A prompt
     * passes the text it holds with a true answer.
     */
    answer: (confirmed: boolean, value?: string) => void;
}

/**
 * The state behind useModal(), kept outside React so it can be driven without a DOM. A new request
 * replaces the one on screen (as before, the replaced promise never settles).
 */
export function createModalController(): ModalController {
    let current: ModalRequest | null = null;
    let settle: (confirmed: boolean, value?: string) => void = () => { };
    const listeners = new Set<() => void>();

    const show = (next: ModalRequest | null) => {
        current = next;
        listeners.forEach((listener) => listener());
    };
    const open = (request: ModalRequest) => new Promise<boolean>((resolve) => {
        settle = (confirmed) => resolve(confirmed);
        show(request);
    });

    return {
        alert: (message, title, labels = {}) =>
            open({ type: "alert", message, title, isDanger: false, labels }).then(() => undefined),
        confirm: (message, title, isDanger = false, labels = {}) =>
            open({ type: "confirm", message, title, isDanger, labels }),
        prompt: (message, title, options = {}) => new Promise<string | null>((resolve) => {
            const { defaultValue = "", placeholder, inputType = "text", ...labels } = options;
            settle = (confirmed, value) => resolve(confirmed ? (value ?? defaultValue) : null);
            show({ type: "prompt", message, title, isDanger: false, labels, input: { defaultValue, placeholder, inputType } });
        }),
        answer: (confirmed, value) => {
            // ConfirmationModal's confirming button calls onConfirm and then onClose: the first answer wins.
            const resolve = settle;
            settle = () => { };
            show(null);
            resolve(confirmed, value);
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
    const isPrompt = request.type === "prompt";
    return {
        title: request.title ?? t(isAlert ? "dialog.alert.title" : isPrompt ? "dialog.prompt.title" : "dialog.confirm.title", lang),
        confirmText: request.labels.confirmText ?? t(isAlert || isPrompt ? "dialog.ok" : "dialog.confirm", lang),
        cancelText: request.labels.cancelText ?? t("dialog.cancel", lang),
    };
}

/**
 * The host dialog of a controller. ModalProvider is mounted in app/_root/RootDocument.tsx, ABOVE the admin's and the
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
            onConfirm={(value) => controller.answer(true, value)}
            title={text?.title ?? ""}
            message={request?.message ?? ""}
            isDanger={request?.isDanger ?? false}
            confirmText={text?.confirmText}
            cancelText={text?.cancelText}
            input={request?.input}
        />
    );
}

const ModalContext = createContext<ModalContextType | undefined>(undefined);

export function ModalProvider({ children }: { children: ReactNode }) {
    const [controller] = useState(createModalController);
    const value = useMemo<ModalContextType>(() => ({ alert: controller.alert, confirm: controller.confirm, prompt: controller.prompt }), [controller]);

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
