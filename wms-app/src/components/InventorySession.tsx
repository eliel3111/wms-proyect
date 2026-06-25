import { useEffect, useState } from "react";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import InventoryMonitorOptions from "./InventoryMonitorOptions.tsx";
import InventoryActiveSessionView from "./InventoryActiveSessionView.tsx";
import "../styles/InventoryMonitorOptions.css";

export type AdjustmentMode = "final" | "immediate";

export type InventorySession = {
  id: number;
  code: string;
  user_id: number;
  full_name?: string;
  name?: string;
  status: "draft" | "in-progress" | "review" | "posted" | "cancelled";
  start_date: string | null;
  end_date?: string | null;
  created_at?: string;
  updated_at?: string;
};

export default function InventorySession() {
  const { openModal } = useModal();

  const [loading, setLoading] = useState(true);
  const [hasActiveSession, setHasActiveSession] = useState(false);
  const [adjustmentMode, setAdjustmentMode] =
    useState<AdjustmentMode>("final");
  const [session, setSession] = useState<InventorySession | null>(null);

  const getSessionStatus = async () => {
    try {
      setLoading(true);

      const response = await apiClient.get("/inventory/session-status");
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
      console.error("❌ Error consultando session-status:", error);


      openModal({
        title: "Error al consultar inventario",
        message: "No se pudo consultar el estado de la sesión de inventario.",
      });
      
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    getSessionStatus();
  }, []);
  //-----------------------------------------------------------------------------

  if (loading) {
    return <div>Cargando inventario...</div>;
  }

  return (
    <>
      {!hasActiveSession && (
        <InventoryMonitorOptions
          adjustmentMode={adjustmentMode}
          setAdjustmentMode={setAdjustmentMode}
          setHasActiveSession={setHasActiveSession}
          setSession={setSession}
        />
      )}

      {hasActiveSession && session && (
        <InventoryActiveSessionView
          adjustmentMode={adjustmentMode}
          session={session}
          setHasActiveSession={setHasActiveSession}
          setSession={setSession}
        />
      )}
    </>
  );
}