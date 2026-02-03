import { useNavigate } from "react-router-dom";
import "../styles/Putaway.css";
import { useEffect, useState } from "react";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";


export default function PutawayMenu() {
  const navigate = useNavigate();
  const { openModal } = useModal();

  const [loading, setLoading] = useState(true);
  const [pendingLines, setPendingLines] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasActiveSession, setHasActiveSession] = useState<boolean>(false);


  {/*CALL AL PENDING PUTAWAY LINES FOR THIS USER*/ }
  useEffect(() => {
    async function loadPendingPutaway() {
      try {
        setLoading(true);

        const response = await apiClient.get("/putaway/pending");
        const result = response.data;

        if (!result.success) {
          throw new Error(result.message || "Error cargando pendientes");
        }
        console.log(result);
        setPendingLines(result.data);
        setHasActiveSession(result.totalLines > 0);

      } catch (err: any) {
        console.error("Error cargando putaway pendientes:", err);
        setError("No se pudieron cargar los productos pendientes");
      } finally {
        setLoading(false);
      }
    }

    loadPendingPutaway();
  }, []);

  // Funcion para start a session
  async function handleStartPutaway() {
    try {
      const res = await apiClient.get("/putaway/start");

      if (res.data.success) {
        if (res.data.alreadyExists) {
          console.log("Ya existe sesión activa:", res.data.session);
        } else {
          console.log("Nueva sesión creada:", res.data.session);
        }

        // 👉 aquí navegas a la página de recoger
        navigate("/putaway/pick");
      }

    } catch (error) {
      console.error("Error iniciando putaway:", error);
      alert("Error iniciando sesión de putaway");
    }
  }

  //FUNCTION: For putaway button
  function handleGoToPutawayDrop() {
    if (!hasActiveSession) {
      openModal({
        title: "No existe una sesión de Putaway",
        message: "Recoga productos en la ubicacion de recepcion."
      });
      return;
    }

    navigate("/putaway/drop");
  }




  if (loading) return <LoadingScreen />;

  if (error) {
    return <div className="error-screen">{error}</div>;
  }


  return (
    <div className="putaway-page">

      {/* 🔷 CONTENEDOR INTERNO RESPONSIVE */}
      <div style={{
        gap: pendingLines.length == 0 ? "60px" : "16px",
      }} className="putaway-container">

        {/* 🏷️ TÍTULO */}
        <div className="putaway-header">
          <h1>PutAway</h1>
        </div>

        {/* 🔘 BOTONES */}
        <div className="putaway-actions"

        >
          <button
            className="putaway-btn-primary"
            onClick={handleStartPutaway}
          >
            RECOGER EN RECEPCION
          </button>

          <button
            //disabled={!hasActiveSession}
            className="putaway-btn-secondary"
            onClick={handleGoToPutawayDrop}
          >
            UBICAR
          </button>


        </div>

        {/* 🔽 SECCIÓN CONDICIONAL */}
        {pendingLines.length > 0 && (
          <>
            {/* 🧾 SUBTÍTULO */}
            <div className="putaway-subtitle">
              <h3>Productos pendientes por descargar</h3>
            </div>

            {/* 📋 TABLA */}
            <div className="putaway-table-wrapper">
              <table className="putaway-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Descripción</th>
                    <th>Cantidad</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingLines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.sku}</td>
                      <td>{line.description}</td>
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
