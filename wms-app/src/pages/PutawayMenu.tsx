import { useNavigate } from "react-router-dom";
import "../styles/Putaway.css";

export default function PutawayMenu() {
  const navigate = useNavigate();

  return (
    <div className="page-putaway">
      <h1>Putaway</h1>
      <p>Ubicar mercancía recibida en su ubicación final</p>

      <div className="putaway-card">
        <p>Este proceso te guiará para:</p>
        <ul>
          <li>📦 Escanear ubicación de origen</li>
          <li>📍 Escanear ubicación de destino</li>
          <li>✅ Confirmar movimiento</li>
        </ul>

        <button
          className="btn-primary"
          onClick={() => navigate("/putaway/pick")}
        >
          Iniciar Putaway
        </button>
      </div>
    </div>
  );
}
