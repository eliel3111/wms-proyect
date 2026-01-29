import { useNavigate } from "react-router-dom";
import "../styles/Transfer.css";
import { useEffect, useState } from "react";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import apiClient from "../services/apiClient.ts";
import { useModal } from "../context/ModalContext.tsx";

export default function TransferMenu() {
  const navigate = useNavigate();
  const { openModal } = useModal();

  const [loading, setLoading] = useState(true);
  const [pendingLines, setPendingLines] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasActiveSession, setHasActiveSession] = useState<boolean>(false);

  // 🔹 Cargar transferencias pendientes
  useEffect(() => {
    async function loadPendingTransfers() {
      try {
        setLoading(true);

        const response = await apiClient.get("/transfer/pending");
        const result = response.data;

        if (!result.success) {
          throw new Error(result.message || "Error cargando transferencias");
        }

        setPendingLines(result.data);
        setHasActiveSession(result.totalLines > 0);

      } catch (err) {
        console.error("Error cargando transfer pendientes:", err);
        setError("No se pudieron cargar las transferencias pendientes");
      } finally {
        setLoading(false);
      }
    }

    loadPendingTransfers();
  }, []);

  // 🔹 Iniciar sesión de transferencia
  async function handleStartTransfer() {
    try {
      const res = await apiClient.get("/transfer/start");

      if (res.data.success) {
        navigate("/transfer/pick"); // pantalla donde eliges origen / productos
      }

    } catch (error) {
      console.error("Error iniciando transferencia:", error);
      alert("Error iniciando sesión de transferencia");
    }
  }

  // 🔹 Ir a drop
  function handleGoToTransferDrop() {
    if (!hasActiveSession) {
      openModal({
        title: "No existe una sesión de transferencia",
        message: "Primero debes seleccionar productos para transferir."
      });
      return;
    }

    navigate("/transfer/drop");
  }

  if (loading) return <LoadingScreen />;

  if (error) {
    return <div className="error-screen">{error}</div>;
  }

  return (
    <div className="transfer-page">
      <div
        style={{ gap: pendingLines.length === 0 ? "60px" : "16px" }}
        className="transfer-container"
      >
        {/* 🏷️ TÍTULO */}
        <div className="transfer-header">
          <h1>Transfer</h1>
        </div>

        {/* 🔘 BOTONES */}
        <div className="transfer-actions">
          <button
            className="transfer-btn-primary"
            onClick={handleStartTransfer}
          >
            SELECCIONAR PRODUCTOS
          </button>

          <button
            className="transfer-btn-secondary"
            onClick={handleGoToTransferDrop}
          >
            MOVER A UBICACIÓN
          </button>
        </div>

        {/* 🔽 TABLA DE PENDIENTES */}
        {pendingLines.length > 0 && (
          <>
            <div className="transfer-subtitle">
              <h3 className="transfer-pending-title">Transferencias pendientes</h3>
            </div>

            <div className="transfer-table-wrapper">
              <table className="transfer-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Descripción</th>
                    <th className="only-mobile">Origen</th>
                    <th className="only-mobile">Destino</th>
                    <th>Pendiente</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingLines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.sku}</td>
                      <td>{line.description}</td>
                      <td className="only-mobile">{line.from_location}</td>
                      <td className="only-mobile">{line.to_location}</td>
                      <td>{Number(line.pending_qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}