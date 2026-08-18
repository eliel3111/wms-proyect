import { AlertTriangle, X } from "lucide-react";
import "../styles/ConfirmationModal.css";

interface ConfirmationModalProps {
  isOpen: boolean;

  title: string;

  message: string;

  onClose: () => void;

  onConfirm: () => void | Promise<void>;

  confirmText?: string;

  cancelText?: string;

  loading?: boolean;
}

export default function ConfirmationModal({
  isOpen,
  title,
  message,
  onClose,
  onConfirm,
  confirmText = "Confirmar",
  cancelText = "Cancelar",
  loading = false
}: ConfirmationModalProps) {

  if (!isOpen) {
    return null;
  }


  const handleConfirm = async () => {

    if (loading) {
      return;
    }

    await onConfirm();

  };


  return (

    <div
      className="confirmation-modal-overlay"
      onClick={onClose}
    >

      <div
        className="confirmation-modal"
        onClick={(e) =>
          e.stopPropagation()
        }
      >

        {/* ============================
            HEADER
        ============================ */}

        <div className="confirmation-modal-header">

          <div className="confirmation-modal-icon">
            <AlertTriangle size={26} />
          </div>


          <button
            type="button"
            className="confirmation-modal-close"
            onClick={onClose}
            disabled={loading}
          >
            <X size={22} />
          </button>

        </div>



        {/* ============================
            CONTENT
        ============================ */}

        <div className="confirmation-modal-content">

          <h2>
            {title}
          </h2>


          <p>
            {message}
          </p>

        </div>



        {/* ============================
            ACTIONS
        ============================ */}

        <div className="confirmation-modal-actions">

          <button
            type="button"
            className="confirmation-modal-cancel"
            onClick={onClose}
            disabled={loading}
          >
            {cancelText}
          </button>


          <button
            type="button"
            className="confirmation-modal-confirm"
            onClick={handleConfirm}
            disabled={loading}
          >

            {loading
              ? "Procesando..."
              : confirmText
            }

          </button>

        </div>

      </div>

    </div>

  );
}