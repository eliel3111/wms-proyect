
import { useState, useEffect } from "react";

import type {
  Dispatch,
  SetStateAction
} from "react";

import {
  CalendarDays,
  Zap,
  AlertTriangle,
  Settings,
  Warehouse,
  Plus
} from "lucide-react";

import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";

import type {
  AdjustmentMode,
  InventorySession
} from "./InventorySession";

import { SyncERPFullScreen } from "../components/SyncERPFullScreen";

import "../styles/InventoryMonitorOptions.css";

// ============================================================
// TYPES
// ============================================================

type Props = {
  adjustmentMode: AdjustmentMode;

  setAdjustmentMode:
    Dispatch<SetStateAction<AdjustmentMode>>;

  setHasActiveSession:
    Dispatch<SetStateAction<boolean>>;

  setSession:
    Dispatch<SetStateAction<InventorySession | null>>;
};

type WarehouseType = {
  id: string;
  code: string;
  name: string;
  erp_warehouse_id: string;
};

// ============================================================
// COMPONENT
// ============================================================

export default function InventoryMonitorOptions({
  adjustmentMode,
  setAdjustmentMode,
  setHasActiveSession,
  setSession
}: Props) {

  const { openModal } = useModal();

  const [loading, setLoading] = useState(false);

  const [warehouses, setWarehouses] =
    useState<WarehouseType[]>([]);

  const [warehouseSelected, setWarehouseSelected] =
    useState<WarehouseType | null>(null);

  // ==========================================================
  // 1. OBTENER ALMACENES
  // ==========================================================

  useEffect(() => {

    const fetchWarehouses = async () => {

      try {

        console.log("🏬 BUSCANDO ALMACENES DISPONIBLES");

        const response = await apiClient.get(
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

        const receivedWarehouses: WarehouseType[] =
          Array.isArray(data.warehouses)
            ? data.warehouses
            : [];

        setWarehouses(receivedWarehouses);

        console.log(
          "✅ ALMACENES OBTENIDOS:",
          receivedWarehouses
        );

        // Seleccionar automáticamente
        // cuando solamente existe un almacén.

        if (receivedWarehouses.length === 1) {
          setWarehouseSelected(receivedWarehouses[0]);
        } else {
          setWarehouseSelected(null);
        }

      } catch (error) {

        console.error(
          "❌ ERROR OBTENIENDO ALMACENES:",
          error
        );

        setWarehouses([]);

        openModal({
          title: "Error obteniendo almacenes",
          message:
            "No se pudieron obtener los almacenes disponibles."
        });

      }
    };

    void fetchWarehouses();

  }, [openModal]);

  // ==========================================================
  // 2. CAMBIAR MODO DE AJUSTE
  // ==========================================================

  const handleChangeMode = async (
    mode: AdjustmentMode
  ) => {

    try {

      const response = await apiClient.post(
        "/inventory/adjustment-mode",
        {
          adjustmentMode: mode
        }
      );

      const data = response.data;

      if (!data.success) {

        openModal({
          title: data.title || "Error",
          message:
            data.message ||
            "No se pudo cambiar el modo de ajuste."
        });

        return;
      }

      setAdjustmentMode(data.adjustmentMode);

    } catch (error) {

      console.error(
        "❌ ERROR ACTUALIZANDO MODO:",
        error
      );

      openModal({
        title: "Error de configuración",
        message:
          "No se pudo actualizar el modo de inventario."
      });

    }
  };

  // ==========================================================
  // 3. CREAR SESIÓN
  // ==========================================================

  const handleCreateSession = async () => {

    try {

      if (!warehouseSelected) {

        openModal({
          title: "Seleccione un almacén",
          message:
            "Debe seleccionar un almacén antes " +
            "de crear la sesión de inventario."
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

        openModal({
          title:
            data.title ||
            "Error creando sesión",

          message:
            data.message ||
            "No se pudo crear la sesión de inventario."
        });

        return;
      }

      setHasActiveSession(data.hasActiveSession);
      setAdjustmentMode(data.adjustmentMode);
      setSession(data.session);

      console.log(
        "✅ SESIÓN CREADA:",
        data.session
      );

    } catch (error) {

      console.error(
        "❌ ERROR CREANDO SESIÓN:",
        error
      );

      openModal({
        title: "Error creando sesión",
        message:
          "No se pudo crear la sesión de inventario."
      });

    } finally {

      setLoading(false);

    }
  };

  // ==========================================================
  // 4. LOADING
  // ==========================================================

  if (loading) {
    return <SyncERPFullScreen />;
  }

  // ==========================================================
  // 5. RENDER
  // ==========================================================

  return (

    <div className="inventory-monitor-container-options">

      {/* =====================================================
          PAGE HEADER - NUEVO DISEÑO
      ===================================================== */}

      <header className="inventory-mode-page-header">

        <div className="inventory-mode-page-icon">

          <Settings
            size={29}
            strokeWidth={2}
          />

        </div>

        <div className="inventory-mode-page-heading">

          <span className="inventory-mode-eyebrow">
            INVENTARIO
          </span>

          <h1 className="inventory-mode-page-title">
            Modo de Ajuste de Inventario
          </h1>

          <p className="inventory-mode-page-subtitle">
            Configure el método de ajuste que se
            aplicará durante la sesión de inventario.
          </p>

        </div>

      </header>

      {/* =====================================================
          ADJUSTMENT OPTIONS
      ===================================================== */}

      <div className="inventory-monitor-options">

        {/* ===================================================
            AJUSTE FINAL
        =================================================== */}

        <div
          className={`
            inventory-monitor-option
            ${adjustmentMode === "final" ? "selected" : ""}
          `}
          onClick={() =>
            void handleChangeMode("final")
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

                <h4>Ajuste al Final</h4>

                <span className="option-recommended">
                  Recomendado
                </span>

              </div>

            </div>

            <p>
              Los ajustes se aplicarán al finalizar y
              confirmar toda la sesión de inventario.
            </p>

          </div>

        </div>

{/* ===================================================
    AJUSTE INMEDIATO - DESHABILITADO TEMPORALMENTE
=================================================== */}

<button
  type="button"
  className="
    inventory-monitor-option
    inventory-monitor-option-disabled
  "
  disabled
  aria-label="Ajuste Inmediato, próximamente disponible"
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

        <span className="option-coming-soon">
          Próximamente
        </span>

      </div>

    </div>

    <p>
      Los ajustes se aplicarán inmediatamente
      después de cada conteo. Esta función
      no está disponible por el momento.
    </p>

  </div>

</button>

      </div>

      {/* =====================================================
          WARNING
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
            No puede cambiar el método de ajuste
            mientras exista una sesión activa.
          </strong>

          <span>
            Estados bloqueados: draft o in-progress.
          </span>

        </p>

      </div>

      {/* =====================================================
          WAREHOUSE SECTION
      ===================================================== */}

      <div className="inventory-monitor-session-section">

        <div className="inventory-warehouse-select-container">

          <label htmlFor="warehouse-select">

            <Warehouse
              size={17}
              strokeWidth={1.9}
            />

            <span>
              Almacenes disponibles
            </span>

          </label>

          <div className="inventory-warehouse-select-wrapper">

            <select
              id="warehouse-select"
              className="inventory-warehouse-select"

              value={
                warehouseSelected?.id ?? ""
              }

              disabled={
                warehouses.length <= 1
              }

              onChange={(event) => {

                const selectedWarehouse =
                  warehouses.find(
                    warehouse =>
                      String(warehouse.id) ===
                      event.target.value
                  ) ?? null;

                setWarehouseSelected(selectedWarehouse);

                console.log(
                  "🏬 ALMACÉN SELECCIONADO:",
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

              {warehouses.map((warehouse) => (

                <option
                  key={warehouse.id}
                  value={String(warehouse.id)}
                >

                  {warehouse.code} - {warehouse.name}

                </option>

              ))}

            </select>

          </div>

        </div>

        {/* ===================================================
            CREATE SESSION
        =================================================== */}

        <button
          type="button"
          className="inventory-session-action-btn"
          onClick={() =>
            void handleCreateSession()
          }
        >

          <Plus
            size={19}
            strokeWidth={2}
          />

          <span>
            Crear Sesión de Inventario
          </span>

        </button>

      </div>

    </div>

  );
}
