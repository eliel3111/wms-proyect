import { useNavigate } from "react-router-dom";
import "../styles/Putaway.css";
import { useEffect, useState, useRef } from "react";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import apiClient from "../services/apiClient";


export default function PutawayMenu() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [pendingLines, setPendingLines] = useState([]);
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


  if (loading) return <LoadingScreen />;

  if (error) {
    return <div className="error-screen">{error}</div>;
  }


  return (
    <div className="putaway-page">

      {/* 🔷 CONTENEDOR INTERNO RESPONSIVE */}
      <div className="putaway-container">

        {/* 🏷️ TÍTULO */}
        <div className="putaway-header">
          <h1>PutAway</h1>
        </div>

        {/* 🔘 BOTONES */}
        <div className="putaway-actions">
          <button className="putaway-btn-primary">
            RECOGER
          </button>

          <button className="putaway-btn-secondary">
            DESCARGAR
          </button>
        </div>

        {/* 🔽 SECCIÓN CONDICIONAL */}
        {1 === 1 && (
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
                  {/* aquí luego haces el map */}
                  <tr>
                    <td>SKU-001</td>
                    <td>Producto ejemplo</td>
                    <td>50</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}

      </div>
    </div>
  );

}
