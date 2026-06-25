import { CalendarDays, Zap, AlertTriangle, Settings } from "lucide-react";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import type { AdjustmentMode, InventorySession } from "./InventorySession";

type Props = {
  adjustmentMode: AdjustmentMode;
  setAdjustmentMode: React.Dispatch<React.SetStateAction<AdjustmentMode>>;
  setHasActiveSession: React.Dispatch<React.SetStateAction<boolean>>;
  setSession: React.Dispatch<React.SetStateAction<InventorySession | null>>;
};

export default function InventoryMonitorOptions({
  adjustmentMode,
  setAdjustmentMode,
  setHasActiveSession,
  setSession
}: Props) {
  const { openModal } = useModal();

  const handleChangeMode = async (mode: AdjustmentMode) => {
    try {
      const response = await apiClient.post("/inventory/adjustment-mode", {
        adjustmentMode: mode
      });

      const data = response.data;

      if (!data.success) {
        openModal({
        title: data.title,
        message: data.message,
      });
        
        return;
      }

      setAdjustmentMode(data.adjustmentMode);
    } catch (error) {
      console.error("❌ Error actualizando modo:", error);
     
      openModal({
        title: "Error de configuración",
        message: "No se pudo actualizar el modo de inventario.",
      });

     
    }
  };

  const handleCreateSession = async () => {
    try {
      const response = await apiClient.post("/inventory/new-session", {});
      const data = response.data;

      if (!data.success) {
        
        openModal({
        title: data.title,
        message: data.message,
      });
        return;
      }

      setHasActiveSession(data.hasActiveSession);
      setAdjustmentMode(data.adjustmentMode);
      setSession(data.session);
    } catch (error) {
      console.error("❌ Error creando sesión:", error);

      
      openModal({
        title: "Error creando sesión",
        message: "No se pudo crear la sesión de inventario.",
      });
    }
  };

  return (
    <div className="inventory-monitor-container-options">
      <div className="inventory-monitor-adjuments">
        <div className="inventory-monitor-adjuments-arriba">
          <Settings size={22} />
          <h3>Modo de Ajuste de Inventario</h3>
        </div>

        <div className="inventory-monitor-adjuments-abajo">
          Seleccione el método de ajuste que se aplicará al finalizar los conteos.
        </div>
      </div>

      <div className="inventory-monitor-options">
        <div
          className={`inventory-monitor-option ${
            adjustmentMode === "final" ? "selected" : ""
          }`}
          onClick={() => handleChangeMode("final")}
        >
          <div className="option-radio"></div>

          <div className="option-header">
            <div className="option-icon calendar">
              <CalendarDays size={34} />
            </div>

            <div className="option-title-row">
              <h4>Ajuste al Final</h4>
              <span>Recomendado</span>
            </div>
          </div>

          <p>
            Los ajustes se aplicarán al finalizar y confirmar toda la sesión de inventario.
          </p>
        </div>

        <div
          className={`inventory-monitor-option ${
            adjustmentMode === "immediate" ? "selected" : ""
          }`}
          onClick={() => handleChangeMode("immediate")}
        >
          <div className="option-radio"></div>

          <div className="option-header">
            <div className="option-icon flash">
              <Zap size={36} />
            </div>

            <div className="option-title-row">
              <h4>Ajuste Inmediato</h4>
            </div>
          </div>

          <p>
            Los ajustes se aplicarán inmediatamente después de cada conteo.
          </p>
        </div>
      </div>

      <div className="inventory-monitor-alert">
        <AlertTriangle size={24} />
        <p>
          No puede cambiar el método de ajuste mientras exista una sesión activa
          <br />
          <span>(draft o in-progress).</span>
        </p>
      </div>

      <button
        className="inventory-session-action-btn"
        onClick={handleCreateSession}
      >
        Crear Sesión de Inventario
      </button>
    </div>
  );
}