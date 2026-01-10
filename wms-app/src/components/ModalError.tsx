// src/components/ModalError.tsx
import "../styles/ModalError.css";
import { useModal } from "../context/ModalContext";

export default function ModalError() {
  const { isOpen, title, message, buttonText, closeModal } = useModal();

  if (!isOpen) return null;

  return (
    <div className="modal-error-overlay" onClick={closeModal}>
      <div
        className="modal-error-content"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        <p>{message}</p>

        <button className="modal-error-button" onClick={closeModal}>
          {buttonText}
        </button>
      </div>
    </div>
  );
}
