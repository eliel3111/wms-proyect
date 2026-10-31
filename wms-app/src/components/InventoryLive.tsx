import { useEffect, useState } from "react";
import apiClient from "../services/apiClient";
import {
  ClipboardCheck,
  Users,
  Package,
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

    {/* =====================================================
        HEADER
    ===================================================== */}

    <div className="inventory-live-title">

      <div className="inventory-live-title-container">

        <div className="inventory-live-title-logo">
          <ClipboardCheck
            size={30}
            strokeWidth={2}
          />
        </div>


        <div className="inventory-live-title-titles">

          <div className="inventory-live-eyebrow">
            MONITOR
          </div>

          <div className="inventory-live-main-title">
            Inventario Físico / Estado del Conteo
          </div>

          <div className="inventory-live-subtitle">
            Visualización en tiempo real del avance del conteo de inventario.
          </div>

        </div>

      </div>


      {/* LIVE STATUS */}

      <div className="inventory-live-status">

        <span className="inventory-live-status-dot" />

        <div className="inventory-live-status-content">

          <strong>
            Actualizando en vivo
          </strong>

          <span>
            Los datos se actualizan automáticamente
          </span>

        </div>

      </div>

    </div>


    {/* =====================================================
        TABLE CARD
    ===================================================== */}

    <div className="inventory-live-table-container">

      {/* SECTION HEADER */}

      <div className="inventory-live-section-title">

        <div className="inventory-live-section-title-main">

          <Users
            size={23}
            strokeWidth={2}
          />

          <div>

            <span className="inventory-live-section-heading">
              Asignación de contadores
            </span>

            <span className="inventory-live-section-subtitle">
              Seguimiento en tiempo real del avance por usuario asignado.
            </span>

          </div>

        </div>

      </div>


      {/* ===================================================
          EMPTY
      =================================================== */}

      {summary.length === 0 ? (

        <div className="inventory-live-empty">

          <div className="inventory-live-empty-icon">

            <ClipboardCheck
              size={30}
              strokeWidth={1.8}
            />

          </div>

          <strong>
            Todavía no hay conteos registrados
          </strong>

          <span>
            Los usuarios aparecerán aquí cuando comiencen a registrar productos.
          </span>

        </div>

      ) : (

        <>

          {/* =================================================
              HEADER ROW
          ================================================= */}

          <div
            className="
              inventory-live-table-column
              inventory-live-table-header
            "
          >

            <div>
              <Users size={17} />
              <span>Contador</span>
            </div>


            <div>
              <Package size={17} />
              <span>
                Cantidad de productos contados
              </span>
            </div>


            <div>
              <PieChart size={17} />
              <span>
                % Avance
              </span>
            </div>

          </div>


          {/* =================================================
              USERS
          ================================================= */}

          {summary.map(
            (item, index) => (

              <div
                key={item.user_id}
                className={`
                  inventory-live-table-column
                  inventory-live-table-row
                  ${
                    index % 2 === 0
                      ? "row-white"
                      : "row-gray"
                  }
                `}
              >

                {/* USER */}

                <div className="inventory-live-user">

                  <div className="inventory-live-user-avatar">

                    <Users
                      size={16}
                      strokeWidth={2}
                    />

                  </div>

                  <span>
                    {item.full_name}
                  </span>

                </div>


                {/* COUNT */}

                <div className="inventory-live-count-value">

                  {item.total_lines_counted}

                </div>


                {/* PERCENT */}

                <div className="inventory-live-progress-cell">

                  <div className="inventory-live-progress-track">

                    <div
                      className="inventory-live-progress-value"
                      style={{
                        width: `${Math.min(
                          item.percent,
                          100
                        )}%`
                      }}
                    />

                  </div>


                  <span className="inventory-live-percent-value">

                    {item.percent}%

                  </span>

                </div>

              </div>

            )
          )}


          {/* =================================================
              TOTAL
          ================================================= */}

          <div
            className="
              inventory-live-table-column
              inventory-live-table-total-row
            "
          >

            <div>
              Total
            </div>


            <div className="inventory-live-count-value">

              {total}

            </div>


            <div className="inventory-live-total-progress">

              <span>
                Conteos registrados
              </span>

            </div>

          </div>

        </>

      )}

    </div>


    {/* =====================================================
        SUMMARY
    ===================================================== */}

    <div className="inventory-live-total">

      {/* PRODUCTS */}

      <div className="inventory-live-total-a">

        <div className="inventory-live-total-icon">

          <Package
            size={30}
            strokeWidth={2}
          />

        </div>


        <div className="inventory-live-total-info">

          <div className="inventory-live-total-label">
            Cantidad total de productos
          </div>

          <div className="inventory-live-total-number">

            {totalProducts}

          </div>

          <div className="inventory-live-total-description">
            Productos a contar en esta sesión
          </div>

        </div>

      </div>


      <div className="inventory-live-total-divider" />


      {/* PERCENT */}

      <div className="inventory-live-total-b">

        <div className="inventory-live-total-icon">

          <PieChart
            size={31}
            strokeWidth={2}
          />

        </div>


        <div className="inventory-live-total-info">

          <div className="inventory-live-total-label">
            % Contados
          </div>

          <div className="inventory-live-total-number">

            {totalPercent}%

          </div>

          <div className="inventory-live-total-description">

            {total} de {totalProducts} productos contados

          </div>

        </div>

      </div>

    </div>

  </div>
);
}