import { useState } from "react";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import type { AdjustmentMode, InventorySession } from "./InventorySession.tsx";
import ConfirmationModal from "../components/ConfirmationModal";
import "../styles/InventoryMonitorOptions.css";

type Props = {
  adjustmentMode: AdjustmentMode;
  session: InventorySession;
  setHasActiveSession: React.Dispatch<React.SetStateAction<boolean>>;
  setSession: React.Dispatch<React.SetStateAction<InventorySession | null>>;
};

export default function InventoryActiveSessionView({
  adjustmentMode,
  session,
  setHasActiveSession,
  setSession
}: Props) {


  const { openModal } = useModal();
  const [showCancelConfirmation, setShowCancelConfirmation] =
    useState(false);


  const handleStartOrComplete = async () => {
    try {

      let endpoint = "";

      // DRAFT → INICIAR
      if (session.status === "draft") {
        endpoint = "/inventory/session/start";
      }

      // IN-PROGRESS → FINALIZAR
      else if (session.status === "in-progress") {
        endpoint = "/inventory/session/complete";
      }

      // REVIEW → VOLVER A CONTAR
      else if (session.status === "review") {
        endpoint = "/inventory/session/resume";
      }

      else {
        openModal({
          title: "Estado no válido",
          message:
            `No se puede procesar una sesión con estado ${session.status}.`,
        });

        return;
      }


      const response = await apiClient.post(
        endpoint,
        {
          id: session.id
        }
      );


      const data = response.data;


      if (!data.success) {

        openModal({
          title:
            data.title || "Error",

          message:
            data.message ||
            "No se pudo procesar la sesión de inventario.",
        });

        return;
      }


      setHasActiveSession(
        data.hasActiveSession
      );

      setSession(
        data.session
      );

    } catch (error) {

      console.error(
        "❌ Error procesando sesión:",
        error
      );


      openModal({
        title:
          "Error de sesión",

        message:
          "No se pudo procesar la sesión de inventario.",
      });

    }
  };

  const handleCancelSession = async () => {
    try {
      const response = await apiClient.post("/inventory/session/cancel", {
        id: session.id
      });

      const data = response.data;

      if (!data.success) {

        openModal({
          title: data.title,
          message: data.message,
        });
        return;
      }

      setHasActiveSession(false);
      setSession(null);
    } catch (error) {
      console.error("❌ Error cancelando sesión:", error);


      openModal({
        title: "Error cancelando sesión",
        message: "No se pudo cancelar la sesión de inventario.",
      });
    }
  };

  return (
    <div className="inventory-monitor-container-option">
      <div className="inventory-monitor-session-up">
        <div className="inventory-session-title">
          Estado de la Sesión
        </div>

        <div className="inventory-session-subtitle">
          Información general del inventario
        </div>
      </div>

      <div className="inventory-monitor-session-middle">
        <div className="inventory-session-row inventory-session-header">
          Sesión Activa
        </div>

        <div className="inventory-session-row inventory-session-code">
          {session.code}
        </div>

        <div className="inventory-session-row">
          <div className="inventory-session-label">Estado:</div>

          <div
            className={`inventory-session-status ${session.status === "draft"
              ? "draft"
              : session.status === "review"
                ? "review"
                : "in-progress"
              }`}
          >
            {session.status}
          </div>
        </div>

        <div className="inventory-session-row">
          <div className="inventory-session-label">Modo:</div>
          <div>{adjustmentMode}</div>
        </div>

        <div className="inventory-session-row">
          <div className="inventory-session-label">Creado por:</div>
          <div>{session.full_name || session.name || "N/A"}</div>
        </div>

        <div className="inventory-session-row">
          <div className="inventory-session-label">Fecha de inicio:</div>
          <div>{session.start_date || "No iniciada"}</div>
        </div>
      </div>

      <div className="inventory-monitor-session-down">
        <button
          className="inventory-session-close-btn"
          onClick={() =>
            setShowCancelConfirmation(true)
          }
        >
          Cancelar Sesión
        </button>

        <button
          className="inventory-session-action-btn"
          onClick={handleStartOrComplete}
        >

          {session.status === "draft"
            ? "Iniciar Sesión"

            : session.status === "in-progress"
              ? "Finalizar Sesión"

              : session.status === "review"
                ? "Reanudar Conteo"

                : "Procesar Sesión"
          }

        </button>
      </div>


      <ConfirmationModal
        isOpen={showCancelConfirmation}

        title="Cancelar sesión de inventario"

        message="¿Está seguro de que desea cancelar esta sesión de inventario? Esta acción cancelará la sesión actual."

        confirmText="Sí, cancelar sesión"

        cancelText="No, volver"

        onClose={() =>
          setShowCancelConfirmation(false)
        }

        onConfirm={async () => {

          await handleCancelSession();

          setShowCancelConfirmation(false);

        }}
      />
    </div>
  );
}