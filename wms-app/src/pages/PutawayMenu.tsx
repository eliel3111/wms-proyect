import { useNavigate } from "react-router-dom";
import "../styles/Putaway.css";
import { useEffect, useState, useRef } from "react";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import apiClient from "../services/apiClient";


export default function PutawayMenu() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [pendingLines, setPendingLines] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        console.log(result.data);
        setPendingLines(result.data);

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
            RECOGER
          </button>

          <button className="putaway-btn-secondary">
            DESCARGAR
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
