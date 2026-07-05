import { useEffect, useState } from "react";
import apiClient from "../services/apiClient";
import {
  ClipboardCheck,
  Users,
  Package,
  Percent,
  PieChart,
} from "lucide-react";
import socket from "../services/socket";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import "../styles/InventoryLive.css";

interface SummaryItem {
  user_id: number;
  full_name: string;
  total_lines_counted: number;
  percent: number;
}

export default function InventoryLive() {
  const [loading, setLoading] = useState(true);

  const [summary, setSummary] = useState<SummaryItem[]>([]);

  const [total, setTotal] = useState(0);

  const [totalProducts, setTotalProducts] = useState(0);

  const [totalPercent, setTotalPercent] = useState(0);

  useEffect(() => {
  loadSummary();
}, []);


async function loadSummary() {
  try {
    setLoading(true);

    const { data } = await apiClient.get(
      "/inventory/live-summary"
    );

    if (data.success) {
      setSummary(data.summary);

      setTotal(data.total);

      setTotalProducts(data.totalProducts);

      setTotalPercent(data.totalPercent);
    }
  } catch (err) {
    console.error(err);
  } finally {
    setLoading(false);
  }
}

useEffect(() => {
  const onConnect = () => {
    console.log("🟢 Socket conectado:", socket.id);

    socket.emit("join_inventory_summary");
    console.log("📦 Unido al room inventory_summary");
  };

  const handleInventorySummary = (data: any) => {
    console.log("📡 Inventory Summary recibido:", data);

    setSummary(data.summary ?? []);
    setTotal(data.total ?? 0);
    setTotalProducts(data.totalProducts ?? 0);
    setTotalPercent(data.totalPercent ?? 0);
  };

  socket.on("connect", onConnect);

  // Si ya estaba conectado antes de montar el componente
  if (socket.connected) {
    onConnect();
  }

  socket.on("inventory_summary", handleInventorySummary);

  return () => {
    socket.off("connect", onConnect);
    socket.off("inventory_summary", handleInventorySummary);
  };
}, []);


/*useEffect(() => {
  socket.on("inventory_summary", (data) => {
    setSummary(data.summary);
    setTotal(data.total);
    setTotalProducts(data.totalProducts);
    setTotalPercent(data.totalPercent);
  });

  return () => {
    socket.off("inventory_summary");
  };
}, []);*/
 if (loading) {
        return <LoadingScreen />;
    }

  return (
    <div className="inventory-live-container">
      <div className="inventory-live-title">
        <div className="inventory-live-title-container">
          <div className="inventory-live-title-logo">
            <ClipboardCheck size={34} />
          </div>

          <div className="inventory-live-title-titles">
            <div className="inventory-live-main-title">
              INVENTARIO FÍSICO / ESTADO DEL CONTEO
            </div>
            <div className="inventory-live-subtitle">Pantalla Monitor</div>
          </div>
        </div>
      </div>

      <div className="inventory-live-table-container">
        <div className="inventory-live-section-title">
          <Users size={26} />
          <span>Asignación de contadores</span>
        </div>

        {summary.length === 0 ? (
          <div className="inventory-live-empty">
            Todavía no hay conteos registrados.
          </div>
        ) : (
          <>
            <div className="inventory-live-table-column inventory-live-table-header">
              <div>
                <Users size={24} />
                <span>Contadores</span>
              </div>

              <div>
                <Package size={24} />
                <span>Cantidad de productos contados</span>
              </div>

              <div>
                <Percent size={24} />
                <span>%</span>
              </div>
            </div>

            {summary.map((item, index) => (
              <div
                key={item.user_id}
                className={`inventory-live-table-column inventory-live-table-row ${
                  index % 2 === 0 ? "row-white" : "row-gray"
                }`}
              >
                <div>{item.full_name}</div>
                <div>{item.total_lines_counted}</div>
                <div>{item.percent}%</div>
              </div>
            ))}

            <div className="inventory-live-table-column inventory-live-table-total-row">
              <div>Total:</div>
              <div>{total}</div>
              <div>-</div>
            </div>
          </>
        )}
      </div>

      <div className="inventory-live-total">
        <div className="inventory-live-total-a">
          <div className="inventory-live-total-icon">
            <Package size={34} />
          </div>

          <div className="inventory-live-total-info">
            <div className="inventory-live-total-label">
              Cantidad total de productos:
            </div>
            <div className="inventory-live-total-number">{totalProducts}</div>
          </div>
        </div>

        <div className="inventory-live-total-b">
          <div className="inventory-live-total-icon">
            <PieChart size={34} />
          </div>

          <div className="inventory-live-total-info">
            <div className="inventory-live-total-label">% Contados:</div>
            <div className="inventory-live-total-number">{totalPercent}%</div>
          </div>
        </div>
      </div>
    </div>
  );
}