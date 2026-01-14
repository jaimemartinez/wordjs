"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useRouter } from "next/navigation";
import ConfirmationModal from "@/components/ConfirmationModal";

interface UnsavedChangesContextType {
    isDirty: boolean;
    setIsDirty: (value: boolean) => void;
    checkAndNavigate: (href: string) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextType | undefined>(undefined);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
    const [isDirty, setIsDirty] = useState(false);
    const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
    const router = useRouter();

    // Handle browser close / refresh
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (isDirty) {
                e.preventDefault();
                e.returnValue = ""; // Chrome requires this
            }
        };

        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, [isDirty]);

    const checkAndNavigate = (href: string) => {
        if (isDirty) {
            setPendingNavigation(href);
        } else {
            router.push(href);
        }
    };

    const confirmNavigation = () => {
        if (pendingNavigation) {
            setIsDirty(false); // Clear dirty state so we can navigate
            router.push(pendingNavigation);
            setPendingNavigation(null);
        }
    };

    const cancelNavigation = () => {
        setPendingNavigation(null);
    };

    return (
        <UnsavedChangesContext.Provider value={{ isDirty, setIsDirty, checkAndNavigate }}>
            {children}
            <ConfirmationModal
                isOpen={!!pendingNavigation}
                onClose={cancelNavigation}
                onConfirm={confirmNavigation}
                title="Unsaved Changes"
                message="You have unsaved changes. Are you sure you want to leave? Your changes will be lost."
                confirmText="Leave Page"
                isDanger={true}
            />
        </UnsavedChangesContext.Provider>
    );
}

export function useUnsavedChanges() {
    const context = useContext(UnsavedChangesContext);
    if (!context) {
        throw new Error("useUnsavedChanges must be used within an UnsavedChangesProvider");
    }
    return context;
}
