import { CalendarDays, Zap, AlertTriangle, Settings } from "lucide-react";
import apiClient from "../services/apiClient";
import { useState, useEffect } from "react";
import { useModal } from "../context/ModalContext";
import type { AdjustmentMode, InventorySession } from "./InventorySession";
import { SyncERPFullScreen } from "../components/SyncERPFullScreen";

type Props = {
  adjustmentMode: AdjustmentMode;
  setAdjustmentMode: React.Dispatch<React.SetStateAction<AdjustmentMode>>;
  setHasActiveSession: React.Dispatch<React.SetStateAction<boolean>>;
  setSession: React.Dispatch<React.SetStateAction<InventorySession | null>>;
};

type Warehouse = {
  id: string;
  code: string;
  name: string;
  erp_warehouse_id: string;
};

export default function InventoryMonitorOptions({
  adjustmentMode,
  setAdjustmentMode,
  setHasActiveSession,
  setSession
}: Props) {
  const { openModal } = useModal();
  const [loading, setLoading] = useState(false);
  const [
    warehouses,
    setWarehouses
  ] = useState<Warehouse[]>([]);
  const [
    warehouseSelected,
    setWarehouseSelected
  ] = useState<Warehouse | null>(null);


  // ========================================================
  // OBTENER ALMACENES AL ABRIR LA PÁGINA
  // ========================================================

  useEffect(() => {
    const fetchWarehouses = async () => {
      try {
        console.log(
          "🏬 Buscando almacenes disponibles..."
        );

        //setLoadingWarehouses(true);

        const response =
          await apiClient.get(
            "/inventory/warehouses"
          );

        const data = response.data;

        if (!data.success) {
          setWarehouses([]);

          openModal({
            title:
              data.title ||
              "No encontramos almacenes",

            message:
              data.message ||
              "Asegúrese de crear almacenes."
          });

          return;
        }

        const receivedWarehouses =
          Array.isArray(data.warehouses)
            ? data.warehouses
            : [];

        setWarehouses(
          receivedWarehouses
        );

        console.log(
          "✅ Almacenes guardados en state:",
          receivedWarehouses
        );

        if (receivedWarehouses.length === 1) {
          setWarehouseSelected(
            receivedWarehouses[0]
          );

          console.log(
            "✅ Único almacén seleccionado automáticamente:",
            receivedWarehouses[0]
          );
        } else {
          setWarehouseSelected(null);
        }

      } catch (error) {
        console.error(
          "❌ Error obteniendo almacenes:",
          error
        );

        setWarehouses([]);

        openModal({
          title:
            "Error obteniendo almacenes",

          message:
            "No se pudieron obtener los almacenes disponibles."
        });

      } finally {
        //setLoadingWarehouses(false);
      }
    };

    fetchWarehouses();
  }, [openModal]);






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

      if (!warehouseSelected) {
        openModal({
          title: "Seleccione un almacén",
          message:
            "Debe seleccionar un almacén antes de crear la sesión de inventario."
        });

        return;
      }


      setLoading(true);
      const response = await apiClient.post(
        "/inventory/new-session",
        {
          warehouseId: warehouseSelected.id,
          erpWarehouseId:
            warehouseSelected.erp_warehouse_id
        }
      );
      const data = response.data;

      if (!data.success) {
        setLoading(false);
        openModal({
          title: data.title,
          message: data.message,
        });
        return;
      }

      setHasActiveSession(data.hasActiveSession);
      setAdjustmentMode(data.adjustmentMode);
      setSession(data.session);
      setLoading(false);
    } catch (error) {
      console.error("❌ Error creando sesión:", error);

      setLoading(false);
      openModal({
        title: "Error creando sesión",
        message: "No se pudo crear la sesión de inventario.",
      });
    }
  };

  if (loading) {
    return <SyncERPFullScreen />;
  }

  return (
  <div className="inventory-monitor-container-options">

    {/* =====================================================
        HEADER
    ===================================================== */}

    <div className="inventory-monitor-adjuments">

      <div className="inventory-monitor-adjuments-arriba">

        <div className="inventory-monitor-header-icon">
          <Settings
            size={27}
            strokeWidth={2}
          />
        </div>

        <div className="inventory-monitor-header-content">

          <span className="inventory-monitor-eyebrow">
            INVENTARIO
          </span>

          <h3>
            Modo de Ajuste de Inventario
          </h3>

          <div className="inventory-monitor-adjuments-abajo">
            Seleccione el método de ajuste que se aplicará al finalizar los conteos.
          </div>

        </div>

      </div>

    </div>


    {/* =====================================================
        MODOS DE AJUSTE
    ===================================================== */}

    <div className="inventory-monitor-options">

      {/* AJUSTE FINAL */}

      <div
        className={`
          inventory-monitor-option
          ${
            adjustmentMode === "final"
              ? "selected"
              : ""
          }
        `}
        onClick={() =>
          handleChangeMode("final")
        }
      >

        <div className="option-radio">
          <span />
        </div>


        <div className="option-content">

          <div className="option-header">

            <div className="option-icon calendar">

              <CalendarDays
                size={31}
                strokeWidth={2}
              />

            </div>


            <div className="option-title-row">

              <h4>
                Ajuste al Final
              </h4>

              <span className="option-recommended">
                Recomendado
              </span>

            </div>

          </div>


          <p>
            Los ajustes se aplicarán al finalizar y confirmar toda la sesión de inventario.
          </p>

        </div>

      </div>


      {/* AJUSTE INMEDIATO */}

      <div
        className={`
          inventory-monitor-option
          ${
            adjustmentMode === "immediate"
              ? "selected"
              : ""
          }
        `}
        onClick={() =>
          handleChangeMode(
            "immediate"
          )
        }
      >

        <div className="option-radio">
          <span />
        </div>


        <div className="option-content">

          <div className="option-header">

            <div className="option-icon flash">

              <Zap
                size={32}
                strokeWidth={2.1}
              />

            </div>


            <div className="option-title-row">

              <h4>
                Ajuste Inmediato
              </h4>

            </div>

          </div>


          <p>
            Los ajustes se aplicarán inmediatamente después de cada conteo.
          </p>

        </div>

      </div>

    </div>


    {/* =====================================================
        ALERTA
    ===================================================== */}

    <div className="inventory-monitor-alert">

      <div className="inventory-monitor-alert-icon">

        <AlertTriangle
          size={21}
          strokeWidth={2}
        />

      </div>


      <p>

        <strong>
          No puede cambiar el método de ajuste mientras exista una sesión activa.
        </strong>

        <span>
          Estados bloqueados: draft o in-progress.
        </span>

      </p>

    </div>


    {/* =====================================================
        WAREHOUSE + ACTION
    ===================================================== */}

    <div className="inventory-monitor-session-section">

      <div className="inventory-warehouse-select-container">

        <label htmlFor="warehouse-select">
          Almacenes disponibles
        </label>


        <div className="inventory-warehouse-select-wrapper">

          <select
            id="warehouse-select"
            className="inventory-warehouse-select"
            value={
              warehouseSelected?.id ??
              ""
            }
            disabled={
              warehouses.length <= 1
            }
            onChange={(event) => {

              const selectedWarehouse =
                warehouses.find(
                  warehouse =>
                    String(
                      warehouse.id
                    ) ===
                    event.target.value
                ) ?? null;


              setWarehouseSelected(
                selectedWarehouse
              );


              console.log(
                "🏬 Almacén seleccionado:",
                selectedWarehouse
              );

            }}
          >

            {warehouses.length === 0 && (

              <option value="">
                No hay almacenes disponibles
              </option>

            )}


            {warehouses.length > 1 &&
              !warehouseSelected && (

                <option value="">
                  Seleccione un almacén
                </option>

              )}


            {warehouses.map(
              warehouse => (

                <option
                  key={
                    warehouse.id
                  }
                  value={
                    String(
                      warehouse.id
                    )
                  }
                >

                  {warehouse.code}
                  {" - "}
                  {warehouse.name}

                </option>

              )
            )}

          </select>

        </div>

      </div>


      <button
        type="button"
        className="inventory-session-action-btn"
        onClick={
          handleCreateSession
        }
      >

        Crear Sesión de Inventario

      </button>

    </div>

  </div>
);
}