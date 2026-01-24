"use client";

import React, { createContext, useContext, useState, useRef, ReactNode } from "react";
import ConfirmationModal from "@/components/ConfirmationModal";

interface ModalContextType {
    alert: (message: string, title?: string) => Promise<void>;
    confirm: (message: string, title?: string, isDanger?: boolean) => Promise<boolean>;
}

const ModalContext = createContext<ModalContextType | undefined>(undefined);

export function ModalProvider({ children }: { children: ReactNode }) {
    const [modalState, setModalState] = useState<{
        isOpen: boolean;
        type: "alert" | "confirm";
        title: string;
        message: string;
        isDanger: boolean;
    }>({
        isOpen: false,
        type: "alert",
        title: "",
        message: "",
        isDanger: false,
    });

    const resolveRef = useRef<(value: any) => void>(() => { });

    const alert = (message: string, title: string = "Alert"): Promise<void> => {
        return new Promise((resolve) => {
            resolveRef.current = resolve;
            setModalState({
                isOpen: true,
                type: "alert",
                title,
                message,
                isDanger: false,
            });
        });
    };

    const confirm = (message: string, title: string = "Confirm", isDanger: boolean = false): Promise<boolean> => {
        return new Promise((resolve) => {
            resolveRef.current = resolve;
            setModalState({
                isOpen: true,
                type: "confirm",
                title,
                message,
                isDanger,
            });
        });
    };

    const handleClose = () => {
        setModalState((prev) => ({ ...prev, isOpen: false }));
        if (modalState.type === "confirm") {
            resolveRef.current(false);
        } else {
            resolveRef.current(undefined);
        }
    };

    const handleConfirm = () => {
        setModalState((prev) => ({ ...prev, isOpen: false }));
        if (modalState.type === "confirm") {
            resolveRef.current(true);
        } else {
            resolveRef.current(undefined);
        }
    };

    return (
        <ModalContext.Provider value={{ alert, confirm }}>
            {children}
            <ConfirmationModal
                isOpen={modalState.isOpen}
                onClose={handleClose}
                onConfirm={handleConfirm}
                title={modalState.title}
                message={modalState.message}
                isDanger={modalState.isDanger}
                confirmText={modalState.type === "alert" ? "OK" : "Confirm"}
                cancelText={modalState.type === "alert" ? undefined : "Cancel"}
            />
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
