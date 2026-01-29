import React from "react";
import "../styles/ScanModal.css";

type ScanModalProps = {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
};

export default function ScanModal({ open, title, children }: ScanModalProps) {
  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal-fullscreen" role="dialog" aria-modal="true">
        
        

        {/* BODY */}
        <div className="modal-body fullscreen-body">
          {/* HEADER */}
        <div className="modal-header">
          <div className="modal-title">{title ?? "Detalle"}</div>

          {/*<button className="modal-close" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>*/}
        </div>
          {children}
        </div>

      </div>
    </div>
  );
}
