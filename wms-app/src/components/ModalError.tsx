// src/components/ModalError.tsx

import { useEffect, useId, useRef } from "react";

import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle
} from "lucide-react";

import "../styles/ModalError.css";

import { useModal } from "../context/ModalContext";

export default function ModalError() {

  const {
    isOpen,
    title,
    message,
    buttonText,
    titleColor,
    closeModal
  } = useModal();

  const buttonRef = useRef<HTMLButtonElement>(null);

  const titleId = useId();
  const messageId = useId();

  // =====================================================
  // IDENTIFICAR TIPO DE MODAL
  // =====================================================

  const normalizedColor = String(
    titleColor || "red"
  ).toLowerCase();

  const modalType =
    normalizedColor === "green" ||
    normalizedColor === "success"
      ? "success"
      : normalizedColor === "orange" ||
        normalizedColor === "yellow" ||
        normalizedColor === "warning"
        ? "warning"
        : "error";

  // =====================================================
  // ICONO SEGÚN ESTADO
  // =====================================================

  const StatusIcon =
    modalType === "success"
      ? CheckCircle2
      : modalType === "warning"
        ? AlertTriangle
        : AlertCircle;

  // =====================================================
  // ENFOQUE AUTOMÁTICO
  // =====================================================

  useEffect(() => {

    if (!isOpen) return;

    buttonRef.current?.focus();

  }, [isOpen]);

  // =====================================================
  // NO RENDERIZAR SI ESTÁ CERRADO
  // =====================================================

  if (!isOpen) return null;

  // =====================================================
  // RENDER
  // =====================================================

  return (

    <div
      className="modal-error-overlay"
      onClick={closeModal}
    >

      <div
        className={`
          modal-error-content
          modal-error-${modalType}
        `}
        role={
          modalType === "error"
            ? "alertdialog"
            : "dialog"
        }
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {

          // Evita enviar teclas al listener del scanner
          e.stopPropagation();

          if (e.key === "Escape") {
            closeModal();
          }

        }}
      >

        {/* =====================================
            ICONO
        ===================================== */}

        <div className="modal-error-icon">

          <StatusIcon
            size={34}
            strokeWidth={1.9}
          />

        </div>


        {/* =====================================
            TITULO
        ===================================== */}

        <h2
          id={titleId}
          className="modal-error-title"
        >
          {title}
        </h2>


        {/* =====================================
            MENSAJE
        ===================================== */}

        <p
          id={messageId}
          className="modal-error-message"
        >
          {message}
        </p>


        {/* =====================================
            BOTÓN
        ===================================== */}

        <button
          ref={buttonRef}
          type="button"
          className="modal-error-button"
          onClick={closeModal}
        >
          {buttonText || "Entendido"}
        </button>

      </div>

    </div>

  );
}