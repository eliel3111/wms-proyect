
import { useEffect, useState } from "react";

import {
  ClipboardCheck,
  FileSpreadsheet,
  MapPin,
  ChevronRight,
  Info,
  CheckSquare,
  Settings2,
  PackageCheck,
  PackageX,
  AlertCircle,
} from "lucide-react";

import { useModal } from "../context/ModalContext";
import ConfirmationModal from "../components/ConfirmationModal";
import apiClient from "../services/apiClient";
import socket from "../services/socket";

import type {
  InventoryAdjustmentProgress,
} from "../types/inventoryAdjustment";

import "../styles/InventoryReport.css";

// ============================================================
// TYPES
// ============================================================

interface ReportOption {
  id: number;
  title: string;
  description: string;
}

interface ConfirmationData {
  title: string;
  message: string;
  confirmText: string;
  action: () => Promise<void>;
}

// ============================================================
// REPORT OPTIONS
// ============================================================

const reports: ReportOption[] = [
  {
    id: 1,
    title: "Reporte Final del Inventario",
    description:
      "Compara las cantidades físicas registradas en el WMS " +
      "con las existencias del sistema ADM Cloud.",
  },
  {
    id: 2,
    title: "Inventario Físico por Ubicación",
    description:
      "Consulta el inventario físico organizado por las " +
      "ubicaciones registradas dentro de cada almacén.",
  },
];

// ============================================================
// SOCKET HOOK
// ============================================================

function useInventoryJobProgress(
  jobId: number | null,
  onProgress: (data: InventoryAdjustmentProgress) => void
) {
  useEffect(() => {
    if (!jobId) return;

    const joinRoom = () => {
      socket.emit("inventory_adjustment:join", { jobId });
    };

    const handleProgress = (
      data: InventoryAdjustmentProgress
    ) => {
      if (Number(data.jobId) !== Number(jobId)) {
        return;
      }

      console.log("📡 INVENTORY PROGRESS:", data);
      onProgress(data);
    };

    socket.on(
      "inventory_adjustment:progress",
      handleProgress
    );

    socket.on("connect", joinRoom);

    if (socket.connected) {
      joinRoom();
    }

    return () => {
      socket.off(
        "inventory_adjustment:progress",
        handleProgress
      );

      socket.off("connect", joinRoom);

      if (socket.connected) {
        socket.emit("inventory_adjustment:leave", {
          jobId,
        });
      }
    };
  }, [jobId, onProgress]);
}

// ============================================================
// PROGRESS CARD
// ============================================================

function InventoryProgressCard({
  progress,
  zero = false,
}: {
  progress: InventoryAdjustmentProgress;
  zero?: boolean;
}) {
  const current = progress.currentProduct;

  const stats = [
    {
      label: "Procesados",
      value: progress.processedProducts,
    },
    {
      label: "Total",
      value: progress.totalProducts,
    },
    {
      label: "Correctos",
      value: progress.successfulProducts,
    },
    {
      label: "Errores",
      value: progress.failedProducts,
    },
  ];

  return (
    <section className="inventory-adjustment-progress-card">

      {/* HEADER */}

      <div className="inventory-adjustment-progress-header">

        <div className="inventory-adjustment-progress-title-group">

          <div className="inventory-adjustment-progress-icon">
            {zero ? (
              <PackageX size={22} />
            ) : (
              <Settings2 size={22} />
            )}
          </div>

          <div>
            <h3>
              {zero
                ? "Ajuste de Productos No Contados"
                : "Ajuste de Inventario"}
            </h3>

            <span>
              Job #{progress.jobId}
            </span>
          </div>

        </div>

        <span
          className={
            `inventory-adjustment-status status-${progress.status}`
          }
        >
          {progress.status}
        </span>

      </div>

      {/* PROGRESS BAR */}

      <div className="inventory-adjustment-progress-section">

        <div className="inventory-adjustment-progress-labels">
          <span>
            {zero
              ? "Ajustando existencias a cero"
              : "Progreso del ajuste"}
          </span>

          <strong>{progress.percentage}%</strong>
        </div>

        <div className="inventory-adjustment-progress-track">
          <div
            className="inventory-adjustment-progress-fill"
            style={{
              width: `${Math.max(
                0,
                Math.min(100, Number(progress.percentage) || 0)
              )}%`,
            }}
          />
        </div>

      </div>

      {/* STATS */}

      <div className="inventory-adjustment-progress-stats">
        {stats.map((stat) => (
          <div
            className="inventory-adjustment-stat"
            key={stat.label}
          >
            <span className="inventory-adjustment-stat-label">
              {stat.label}
            </span>

            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>

      {/* CURRENT PRODUCT */}

      {current && (
        <div className="inventory-adjustment-current">

          <div className="inventory-adjustment-current-label">
            Producto actual
          </div>

          <div className="inventory-adjustment-current-info">

            <span>
              ERP ID:{" "}
              <strong>{current.erpProductId}</strong>
            </span>

            {current.citrusQtyBefore !== undefined &&
              current.citrusQtyBefore !== null && (
                <span>
                  Existencia ERP:{" "}
                  <strong>{current.citrusQtyBefore}</strong>
                </span>
              )}

            {current.desiredQty !== undefined &&
              current.desiredQty !== null && (
                <span>
                  Cantidad deseada:{" "}
                  <strong>{current.desiredQty}</strong>
                </span>
              )}

          </div>

        </div>
      )}

      {/* MESSAGE */}

      <div className="inventory-adjustment-progress-message">
        <span className="inventory-adjustment-progress-message-dot" />

        <span>
          {progress.message || "Procesando inventario..."}
        </span>
      </div>

      {progress.errorMessage && (
        <div className="inventory-adjustment-error">
          <AlertCircle size={17} />
          <span>{progress.errorMessage}</span>
        </div>
      )}

    </section>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================

export default function InventoryReport() {

  const { openModal } = useModal();

  const [hoveredReport, setHoveredReport] =
    useState<ReportOption | null>(null);

  const [showConfirmation, setShowConfirmation] =
    useState(false);

  const [confirmationTitle, setConfirmationTitle] =
    useState("");

  const [confirmationMessage, setConfirmationMessage] =
    useState("");

  const [confirmationText, setConfirmationText] =
    useState("Confirmar");

  const [confirmationAction, setConfirmationAction] =
    useState<(() => Promise<void>) | null>(null);

  const [confirmationLoading, setConfirmationLoading] =
    useState(false);

  // ==========================================================
  // COUNTED JOB
  // ==========================================================

  const [adjustmentJobId, setAdjustmentJobId] =
    useState<number | null>(null);

  const [adjustmentProgress, setAdjustmentProgress] =
    useState<InventoryAdjustmentProgress | null>(null);

  const [adjustmentStarting, setAdjustmentStarting] =
    useState(false);

  // ==========================================================
  // ZERO JOB
  // ==========================================================

  const [zeroAdjustmentJobId, setZeroAdjustmentJobId] =
    useState<number | null>(null);

  const [zeroAdjustmentProgress, setZeroAdjustmentProgress] =
    useState<InventoryAdjustmentProgress | null>(null);

  const [zeroAdjustmentStarting, setZeroAdjustmentStarting] =
    useState(false);

  // ==========================================================
  // SOCKET LISTENERS
  // ==========================================================

  useInventoryJobProgress(
    adjustmentJobId,
    setAdjustmentProgress
  );

  useInventoryJobProgress(
    zeroAdjustmentJobId,
    setZeroAdjustmentProgress
  );

  // ==========================================================
  // ERROR MODAL
  // ==========================================================

  const showError = (
    title: string,
    message: string
  ) => {
    openModal({
      title,
      message,
      buttonText: "Entendido",
      titleColor: "red",
    });
  };

  // ==========================================================
  // DOWNLOAD EXCEL
  // ==========================================================

  async function downloadExcel(
    endpoint: string,
    fileName: string
  ) {
    try {
      console.log("📄 DESCARGANDO EXCEL:", endpoint);

      const response = await apiClient.get(endpoint, {
        responseType: "blob",
      });

      const contentType = String(
        response.headers["content-type"] || ""
      );

      // El backend puede devolver JSON aunque
      // responseType sea blob.

      if (contentType.includes("application/json")) {
        const raw =
          response.data instanceof Blob
            ? await response.data.text()
            : String(response.data);

        const data = JSON.parse(raw);

        showError(
          data.title || "Error generando reporte",
          data.message || "No se pudo generar el reporte."
        );

        return;
      }

      const blob = new Blob([response.data], {
        type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;

      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);

      console.log("✅ EXCEL DESCARGADO:", fileName);

    } catch (error: any) {
      console.error("❌ ERROR DESCARGANDO EXCEL:", error);

      let message =
        "No se pudo descargar el reporte de inventario.";

      const backendData = error?.response?.data;

      try {
        if (backendData instanceof Blob) {
          const text = await backendData.text();
          const parsed = JSON.parse(text);

          message =
            parsed.message ||
            parsed.error ||
            message;
        } else if (backendData) {
          message =
            backendData.message ||
            backendData.error ||
            message;
        }
      } catch (parseError) {
        console.error(
          "❌ ERROR LEYENDO RESPUESTA:",
          parseError
        );
      }

      showError("Error generando reporte", message);
    }
  }

  // ==========================================================
  // REPORT ACTIONS
  // ==========================================================

  async function handleReporteFinalInventario() {
    await downloadExcel(
      "/inventory/report/final",
      "inventario-fisico.xlsx"
    );
  }

  async function handleReporteInventarioFisicoUbicacion() {
    await downloadExcel(
      "/inventory/report/locations",
      "inventario-fisico-ubicaciones.xlsx"
    );
  }

  function handleReportClick(reportId: number) {
    if (reportId === 1) {
      void handleReporteFinalInventario();
      return;
    }

    if (reportId === 2) {
      void handleReporteInventarioFisicoUbicacion();
      return;
    }

    console.warn("⚠️ REPORTE NO RECONOCIDO:", reportId);
  }

  // ==========================================================
  // INITIAL JOB PROGRESS
  // ==========================================================

  function createInitialProgress(
    job: any,
    message: string
  ): InventoryAdjustmentProgress {

    const jobId = Number(job?.jobId);
    const totalProducts = Number(job?.totalProducts) || 0;
    const processedProducts =
      Number(job?.processedProducts) || 0;

    return {
      jobId,

      sessionId: job?.sessionId
        ? Number(job.sessionId)
        : undefined,

      status: job?.status || "pending",
      phase: "starting",

      totalProducts,
      processedProducts,

      successfulProducts:
        Number(job?.successfulProducts) || 0,

      failedProducts:
        Number(job?.failedProducts) || 0,

      percentage: totalProducts > 0
        ? Math.round(
            (processedProducts / totalProducts) * 100
          )
        : 0,

      currentLineId: job?.currentLineId ?? null,
      errorMessage: job?.errorMessage ?? null,
      message,
    };
  }

  // ==========================================================
  // APPLY COUNTED INVENTORY
  // ==========================================================

  async function handleApplyInventory() {

    try {
      setAdjustmentStarting(true);

      const response = await apiClient.post(
        "/inventory/start-adjustment"
      );

      const data = response.data;

      console.log("📦 COUNTED JOB:", data);

      if (!data.success) {
        showError(
          data.title || "Error",
          data.message ||
            "No se pudo iniciar el ajuste."
        );
        return;
      }

      const job = data.data;
      const jobId = Number(job?.jobId);

      if (!Number.isSafeInteger(jobId) || jobId <= 0) {
        throw new Error(
          "El backend no devolvió un jobId válido."
        );
      }

      setAdjustmentJobId(jobId);

      setAdjustmentProgress(
        createInitialProgress(
          job,
          "Preparando ajuste de inventario..."
        )
      );

    } catch (error: any) {
      console.error("❌ ERROR COUNTED:", error);

      showError(
        "Error aplicando inventario",
        error?.response?.data?.message ||
          error?.message ||
          "No se pudo iniciar el ajuste de inventario."
      );

    } finally {
      setAdjustmentStarting(false);
    }
  }

  // ==========================================================
  // APPLY ZERO INVENTORY
  // ==========================================================

  async function handleApplyInventoryZero() {

    try {
      setZeroAdjustmentStarting(true);

      const response = await apiClient.post(
        "/inventory/start-adjustment-zero"
      );

      const data = response.data;

      console.log("📦 ZERO JOB:", data);

      if (!data.success) {
        showError(
          data.title || "Error",
          data.message ||
            "No se pudo iniciar el ajuste ZERO."
        );
        return;
      }

      // No hay productos pendientes para ajustar.

      if (data.data?.citrusAdjustmentRequired === false) {
        setZeroAdjustmentJobId(null);
        setZeroAdjustmentProgress(null);

        openModal({
          title: data.title || "Inventario actualizado",
          message:
            data.message ||
            "No existen productos pendientes para ajustar a cero.",
          buttonText: "Entendido",
          titleColor: "green",
        });

        return;
      }

      const job = data.data;
      const jobId = Number(job?.jobId);

      if (!Number.isSafeInteger(jobId) || jobId <= 0) {
        throw new Error(
          "El backend no devolvió un jobId válido."
        );
      }

      setZeroAdjustmentJobId(jobId);

      setZeroAdjustmentProgress(
        createInitialProgress(
          job,
          "Preparando productos para ajustar a cero..."
        )
      );

    } catch (error: any) {
      console.error("❌ ERROR ZERO:", error);

      showError(
        "Error aplicando inventario",
        error?.response?.data?.message ||
          error?.message ||
          "No se pudo iniciar el ajuste ZERO."
      );

    } finally {
      setZeroAdjustmentStarting(false);
    }
  }

  // ==========================================================
  // CONFIRMATION MODAL
  // ==========================================================

  function openConfirmation({
    title,
    message,
    confirmText,
    action,
  }: ConfirmationData) {

    setConfirmationTitle(title);
    setConfirmationMessage(message);
    setConfirmationText(confirmText);

    setConfirmationAction(() => action);
    setShowConfirmation(true);
  }

  function confirmZeroAdjustment() {
    openConfirmation({
      title: "Aplicar inventario en cero",
      message:
        "¿Está seguro de que desea ajustar a cero " +
        "en ADM Cloud los productos no encontrados " +
        "durante este inventario?",
      confirmText: "Aplicar CERO",
      action: handleApplyInventoryZero,
    });
  }

  function confirmCountedAdjustment() {
    openConfirmation({
      title: "Aplicar inventario contado",
      message:
        "¿Está seguro de que desea aplicar en ADM Cloud " +
        "las cantidades físicas contadas durante este inventario?",
      confirmText: "Aplicar CONTADO",
      action: handleApplyInventory,
    });
  }

  async function handleConfirm() {
    if (!confirmationAction || confirmationLoading) {
      return;
    }

    try {
      setConfirmationLoading(true);

      await confirmationAction();

      setShowConfirmation(false);
      setConfirmationAction(null);

    } catch (error) {
      console.error("❌ ERROR CONFIRMANDO:", error);

      showError(
        "Error de confirmación",
        "No se pudo completar la operación."
      );

    } finally {
      setConfirmationLoading(false);
    }
  }

  // ==========================================================
  // RENDER
  // ==========================================================

  return (
    <div className="inventory-report-container">

      {/* =====================================================
          PAGE HEADER
      ===================================================== */}

      <header className="inventory-report-page-header">

        <div className="inventory-report-page-icon">
          <ClipboardCheck
            size={29}
            strokeWidth={2}
          />
        </div>

        <div className="inventory-report-page-heading">

          <span className="inventory-report-eyebrow">
            INVENTARIO
          </span>

          <h1 className="inventory-report-page-title">
            Reportes de Inventario
          </h1>

          <p className="inventory-report-page-subtitle">
            Consulta los reportes físicos y administra
            los ajustes de inventario.
          </p>

        </div>

      </header>

      {/* =====================================================
          COUNTED PROGRESS
      ===================================================== */}

      {adjustmentProgress && (
        <InventoryProgressCard
          progress={adjustmentProgress}
        />
      )}

      {/* =====================================================
          ZERO PROGRESS
      ===================================================== */}

      {zeroAdjustmentProgress && (
        <InventoryProgressCard
          progress={zeroAdjustmentProgress}
          zero
        />
      )}

      {/* =====================================================
          REPORTS SECTION
      ===================================================== */}

      <section className="inventory-report-center">

        {/* LEFT */}

        <div className="inventory-report-center-left">

          <div className="inventory-report-section-heading">

            <span className="inventory-report-section-eyebrow">
              CONSULTAS
            </span>

            <h2>Reportes disponibles</h2>

            <p>
              Selecciona el reporte que deseas consultar.
            </p>

          </div>

          {reports.map((report) => (

            <button
              type="button"
              key={report.id}
              className="inventory-report-option"
              onMouseEnter={() => setHoveredReport(report)}
              onMouseLeave={() => setHoveredReport(null)}
              onFocus={() => setHoveredReport(report)}
              onBlur={() => setHoveredReport(null)}
              onClick={() => handleReportClick(report.id)}
            >

              <span className="inventory-report-option-icon">
                {report.id === 1 ? (
                  <FileSpreadsheet
                    size={25}
                    strokeWidth={1.9}
                  />
                ) : (
                  <MapPin
                    size={25}
                    strokeWidth={1.9}
                  />
                )}
              </span>

              <span className="inventory-report-option-body">

                <span className="inventory-report-option-meta">
                  REPORTE {String(report.id).padStart(2, "0")} · EXCEL
                </span>

                <span className="inventory-report-option-text">
                  {report.title}
                </span>

              </span>

              <ChevronRight
                className="inventory-report-option-chevron"
                size={18}
              />

            </button>

          ))}

        </div>

        {/* RIGHT */}

        <aside className="inventory-report-center-right">

          <div className="inventory-report-description-box">

            <div className="inventory-report-description-icon">
              <Info
                size={25}
                strokeWidth={1.9}
              />
            </div>

            <div className="inventory-report-description-content">

              <span className="inventory-report-description-eyebrow">
                INFORMACIÓN DEL REPORTE
              </span>

              <h3>
                {hoveredReport
                  ? hoveredReport.title
                  : "¿Qué incluye cada reporte?"}
              </h3>

              <p className="inventory-report-description-text">

                {hoveredReport
                  ? hoveredReport.description
                  : "Coloca el cursor sobre una opción o " +
                    "selecciónala con el teclado para conocer " +
                    "su contenido antes de descargarla."}

              </p>

            </div>

          </div>

        </aside>

      </section>

      {/* =====================================================
          ACTION BUTTONS
      ===================================================== */}

      <div className="inventory-report-button">

        {/* ZERO */}

        <button
          type="button"
          className="inventory-report-button-action zero-adjustment"
          disabled={
            zeroAdjustmentStarting ||
            adjustmentStarting ||
            confirmationLoading
          }
          onClick={confirmZeroAdjustment}
        >
          <PackageX size={20} />

          <span>
            {zeroAdjustmentStarting
              ? "Iniciando ajuste..."
              : "Aplicar Inventario en CERO (0.000)"}
          </span>
        </button>

        {/* COUNTED */}

        <button
          type="button"
          className="inventory-report-button-action"
          disabled={
            adjustmentStarting ||
            zeroAdjustmentStarting ||
            confirmationLoading
          }
          onClick={confirmCountedAdjustment}
        >
          <PackageCheck size={20} />

          <span>
            {adjustmentStarting
              ? "Iniciando ajuste..."
              : "Aplicar Inventario CONTADO"}
          </span>

          <CheckSquare size={17} />
        </button>

      </div>

      {/* =====================================================
          CONFIRMATION MODAL
      ===================================================== */}

      <ConfirmationModal
        isOpen={showConfirmation}
        title={confirmationTitle}
        message={confirmationMessage}
        confirmText={confirmationText}
        cancelText="Cancelar"
        loading={confirmationLoading}
        onClose={() => {
          if (confirmationLoading) return;

          setShowConfirmation(false);
          setConfirmationAction(null);
        }}
        onConfirm={handleConfirm}
      />

    </div>
  );
}
