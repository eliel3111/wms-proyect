import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";


type ModalState = {
    isOpen: boolean;
    title: string;
    message: string;
    buttonText: string;
    onCloseCallback?: () => void; // 👈 NUEVO
};

type ModalContextType = ModalState & {
    openModal: (data: Partial<Omit<ModalState, "isOpen">>) => void;
    closeModal: () => void;
};

const ModalContext = createContext<ModalContextType | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
    const [modal, setModal] = useState<ModalState>({
        isOpen: false,
        title: "Error",
        message: "",
        buttonText: "Cerrar",
    });

    function openModal(
        data: Partial<Omit<ModalState, "isOpen">> & {
            onCloseCallback?: () => void;
        }
    ) {
        setModal(prev => ({
            ...prev,
            ...data,
            isOpen: true,
        }));
    }


    function closeModal() {
        setModal(prev => {
            prev.onCloseCallback?.(); // 👈 EJECUTA callback
            return { ...prev, isOpen: false, onCloseCallback: undefined };
        });
    }


    return (
        <ModalContext.Provider value={{ ...modal, openModal, closeModal }}>
            {children}
        </ModalContext.Provider>
    );
}

export function useModal() {
    const ctx = useContext(ModalContext);
    if (!ctx) throw new Error("useModal must be used inside ModalProvider");
    return ctx;
}
