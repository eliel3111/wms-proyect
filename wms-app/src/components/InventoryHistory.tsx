
import { useEffect, useRef, useState } from "react";

import {
  History,
  Warehouse,
  UserRound,
  Package,
  PackageCheck,
  PackageX,
  FileText,
  FileSpreadsheet,
  CalendarDays,
  Clock3,
  CheckCircle2,
  AlertCircle,
  CircleDashed,
  ClipboardList,
  X,
  RefreshCw,
  LoaderCircle,
  ArrowRight,
  Download,
} from "lucide-react";

import apiClient from "../services/apiClient";
import "../styles/InventoryHistory.css";

// ============================================================
// TYPES
// ============================================================

interface InventorySessionHistory {
  id: number;
  code: string;
  status: string;
  user_id: number;
  user_full_name: string | null;
  erp_warehouse_id: string;
  warehouse_name: string | null;
  total_products: number;
  counted_products: number;
  not_counted_products: number;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
}

interface HistoryResponse {
  success: boolean;
  message: string;
  total: number;
  sessions: InventorySessionHistory[];
}

type QtyValue = number | string | null;

interface InventoryReportProduct {
  id: number;
  erp_id: string;
  session_id: number;
  sku: string | null;
  erp_name: string | null;
  erp_sku: string | null;
  description: string | null;
  total_inventory_qty: QtyValue;
  erp_stock: QtyValue;
  unit_cost: QtyValue;
  difference: QtyValue;
  status: string | null;
  exist_erp: boolean;
  product_no_exist: boolean;
  wms_counted: boolean | null;
}

interface InventoryReportSummary {
  total_products: number;
  counted_products: number;
  not_counted_products: number;
  loss_products: number;
  gain_products: number;
  matched_products: number;
}

interface InventoryReportResponse {
  success: boolean;
  message: string;
  session: InventorySessionHistory;
  summary: InventoryReportSummary;
  products: InventoryReportProduct[];
}

// ============================================================
// STATUS HELPERS
// ============================================================

function getStatusInfo(status: string) {
  const value = status?.toLowerCase() ?? "";

  switch (value) {
    case "review":
      return {
        label: "En revisión",
        className: "review",
        icon: AlertCircle,
      };

    case "in-progress":
      return {
        label: "En progreso",
        className: "in-progress",
        icon: Clock3,
      };

    case "completed":
    case "posted":
      return {
        label: "Completado",
        className: "completed",
        icon: CheckCircle2,
      };

    case "draft":
      return {
        label: "Borrador",
        className: "draft",
        icon: CircleDashed,
      };

    default:
      return {
        label: status || "Desconocido",
        className: "default",
        icon: CircleDashed,
      };
  }
}

// ============================================================
// FORMATTERS
// ============================================================

function formatDate(value: string | null) {
  if (!value) return "Sin registrar";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Fecha inválida";
  }

  return new Intl.DateTimeFormat("es-DO", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(date);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-DO", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatQuantity(value: QtyValue) {
  if (value === null || value === undefined) {
    return "—";
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return new Intl.NumberFormat("es-DO", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(number);
}

function getDifferenceClass(value: QtyValue) {
  const number = Number(value);

  if (value === null || !Number.isFinite(number)) {
    return "";
  }

  if (number < 0) return "loss";
  if (number > 0) return "gain";

  return "match";
}

// ============================================================
// MAIN COMPONENT
// ============================================================

export default function InventoryHistory() {

  const [sessions, setSessions] = useState<
    InventorySessionHistory[]
  >([]);

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(
    null
  );

  // ==========================================================
  // SELECTED SESSION
  // ==========================================================

  const [selectedSession, setSelectedSession] =
    useState<InventorySessionHistory | null>(null);

  // ==========================================================
  // REPORT DATA
  // ==========================================================

  const [reportData, setReportData] =
    useState<InventoryReportResponse | null>(null);

  const [reportLoading, setReportLoading] =
    useState(false);

  const [reportError, setReportError] =
    useState<string | null>(null);

  const [reportDownloading, setReportDownloading] =
    useState(false);

  const reportAbortRef = useRef<AbortController | null>(
    null
  );

  // ==========================================================
  // FETCH HISTORY
  // ==========================================================

  const fetchSessions = async () => {

    try {

      setLoading(true);
      setError(null);

      const response =
        await apiClient.get<HistoryResponse>(
          "/inventory/sessions/history"
        );

      if (!response.data.success) {
        throw new Error(
          response.data.message ||
          "No se pudieron obtener las sesiones."
        );
      }

      setSessions(response.data.sessions || []);

    } catch (err) {

      console.error(
        "❌ ERROR OBTENIENDO HISTORIAL:",
        err
      );

      setError(
        "No se pudo cargar el historial de inventarios."
      );

    } finally {

      setLoading(false);

    }
  };

  // ==========================================================
  // INITIAL LOAD
  // ==========================================================

  useEffect(() => {

    void fetchSessions();

    return () => {
      reportAbortRef.current?.abort();
    };

  }, []);

  // ==========================================================
  // LOAD REPORT FOR SELECTED SESSION
  // ==========================================================

  const fetchSessionReport = async (
    session: InventorySessionHistory
  ) => {

    // Cancelar consulta anterior si existiera.
    reportAbortRef.current?.abort();

    const controller = new AbortController();
    reportAbortRef.current = controller;

    setReportData(null);
    setReportError(null);
    setReportLoading(true);

    try {

      // ======================================================
      // DATOS QUE SE ENVÍAN AL BACKEND
      // ======================================================

      const body = {
        sessionId: session.id,
        code: session.code,
        erpWarehouseId: session.erp_warehouse_id,
      };

      console.log(
        "📤 CONSULTANDO REPORTE DE SESIÓN:",
        body
      );

      // ======================================================
      // POST AL BACKEND
      // ======================================================

      const response =
        await apiClient.post<InventoryReportResponse>(
          "/inventory/report/session/details",
          body,
          {
            signal: controller.signal,
          }
        );

      if (!response.data.success) {
        throw new Error(
          response.data.message ||
          "No se pudo obtener el reporte."
        );
      }

      if (controller.signal.aborted) {
        return;
      }

      console.log(
        "✅ REPORTE RECIBIDO:",
        response.data
      );

      setReportData(response.data);

    } catch (err: any) {

      if (controller.signal.aborted) {
        return;
      }

      console.error(
        "🟥 ERROR CARGANDO REPORTE:",
        err
      );

      setReportError(
        err?.response?.data?.message ||
        err?.message ||
        "No se pudo consultar el reporte de esta sesión."
      );

    } finally {

      if (!controller.signal.aborted) {
        setReportLoading(false);
      }

    }
  };

  // ==========================================================
  // CLICK REPORT BUTTON
  // ==========================================================

  const handleViewReport = (
    session: InventorySessionHistory
  ) => {

    console.log("📄 ABRIENDO REPORTE:", {
      id: session.id,
      code: session.code,
      status: session.status,
    });

    // Primero abrir modal.
    setSelectedSession(session);

    // Luego consultar el backend.
    void fetchSessionReport(session);
  };

  // ==========================================================
  // CLOSE REPORT
  // ==========================================================

  const closeReport = () => {

    if (reportDownloading) {
      return;
    }

    reportAbortRef.current?.abort();

    setSelectedSession(null);
    setReportData(null);
    setReportError(null);
    setReportLoading(false);
  };

  // ==========================================================
  // CLOSE MODAL WITH ESCAPE
  // ==========================================================

  useEffect(() => {

    if (!selectedSession) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeReport();
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("keydown", handleEscape);
    };

  }, [selectedSession, reportDownloading]);

  // ==========================================================
  // DOWNLOAD EXCEL FOR SELECTED SESSION
  // ==========================================================

  const handleDownloadExcel = async () => {

    if (
      !selectedSession ||
      reportDownloading ||
      !reportData
    ) {
      return;
    }

    try {

      setReportDownloading(true);
      setReportError(null);

      const sessionId = selectedSession.id;

      console.log(
        "📊 DESCARGANDO EXCEL SESIÓN:",
        sessionId
      );

      const response = await apiClient.get(
        `/inventory/report/session/${sessionId}/excel`,
        {
          responseType: "blob",
        }
      );

      const contentType = String(
        response.headers["content-type"] || ""
      );

      if (contentType.includes("application/json")) {

        const text =
          response.data instanceof Blob
            ? await response.data.text()
            : String(response.data);

        const data = JSON.parse(text);

        throw new Error(
          data.message ||
          "No se pudo descargar el Excel."
        );
      }

      const blob = new Blob(
        [response.data],
        {
          type:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
      );

      const url = window.URL.createObjectURL(blob);

      const link = document.createElement("a");

      link.href = url;

      link.download =
        `reporte-inventario-${selectedSession.code}.xlsx`;

      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 1000);

      console.log(
        "✅ EXCEL DESCARGADO:",
        selectedSession.code
      );

    } catch (err: any) {

      console.error(
        "🟥 ERROR DESCARGANDO EXCEL:",
        err
      );

      let message =
        err?.message ||
        "No se pudo descargar el Excel.";

      if (err?.response?.data instanceof Blob) {

        try {

          const text =
            await err.response.data.text();

          const parsed = JSON.parse(text);

          message =
            parsed.message ||
            message;

        } catch {
          // Conservar mensaje original.
        }
      }

      setReportError(message);

    } finally {

      setReportDownloading(false);

    }
  };

  // ==========================================================
  // DISPLAY DATA
  // ==========================================================

  const currentSession =
    reportData?.session || selectedSession;

  const summary =
    reportData?.summary;

  const products =
    reportData?.products || [];

  // ==========================================================
  // RENDER
  // ==========================================================

  return (
    <div className="inventory-history-page">

      {/* =====================================================
          PAGE HEADER
      ===================================================== */}

      <div className="inventory-history-page-header">

        <div className="inventory-history-page-icon">
          <History size={29} strokeWidth={2} />
        </div>

        <div className="inventory-history-page-heading">

          <span className="inventory-history-eyebrow">
            INVENTARIO
          </span>

          <h1 className="inventory-history-title">
            Historial de Inventarios
          </h1>

          <div className="inventory-history-subtitle">
            Consulta las sesiones, responsables y resultados
            de inventario.
          </div>

        </div>

      </div>

      {/* =====================================================
          HISTORY CARD
      ===================================================== */}

      <section className="inventory-history-card">

        <div className="inventory-history-card-header">

          <div className="inventory-history-card-header-left">

            <div className="inventory-history-card-icon">
              <ClipboardList size={21} strokeWidth={1.9} />
            </div>

            <div className="inventory-history-card-heading">
              <h2>Sesiones de Inventario</h2>
              <p>Registro de las sesiones no canceladas</p>
            </div>

          </div>

          <div className="inventory-history-card-actions">

            <span className="inventory-history-total">
              {formatNumber(sessions.length)} sesiones
            </span>

            <button
              type="button"
              className="inventory-history-refresh"
              onClick={() => void fetchSessions()}
              disabled={loading}
              title="Actualizar historial"
              aria-label="Actualizar historial"
            >
              <RefreshCw
                size={18}
                className={loading ? "spinning" : ""}
              />
            </button>

          </div>

        </div>

        {/* ===================================================
            LOADING
        =================================================== */}

        {loading && (
          <div className="inventory-history-message">

            <LoaderCircle
              size={27}
              className="spinning"
            />

            <span>
              Cargando sesiones de inventario...
            </span>

          </div>
        )}

        {/* ===================================================
            ERROR
        =================================================== */}

        {!loading && error && (
          <div
            className="inventory-history-message error"
            role="alert"
          >
            <AlertCircle size={25} />
            <span>{error}</span>
          </div>
        )}

        {/* ===================================================
            EMPTY
        =================================================== */}

        {!loading && !error && sessions.length === 0 && (
          <div className="inventory-history-message">
            <ClipboardList size={30} />
            <span>No existen sesiones de inventario.</span>
          </div>
        )}

        {/* ===================================================
            HISTORY TABLE
        =================================================== */}

        {!loading && !error && sessions.length > 0 && (

          <div className="inventory-history-table-wrapper">

            <table className="inventory-history-table">

              <thead>
                <tr>
                  <th>Sesión</th>
                  <th>Almacén</th>
                  <th>Responsable</th>
                  <th>Estado</th>
                  <th>Total productos</th>
                  <th>Contados</th>
                  <th>No contados</th>
                  <th className="inventory-history-action-heading">
                    Acción
                  </th>
                </tr>
              </thead>

              <tbody>

                {sessions.map((session) => {

                  const statusInfo =
                    getStatusInfo(session.status);

                  const StatusIcon = statusInfo.icon;

                  return (
                    <tr key={session.id}>

                      {/* SESSION */}

                      <td>
                        <div className="inventory-history-code-cell">

                          <div className="inventory-history-row-icon">
                            <ClipboardList size={18} />
                          </div>

                          <div className="inventory-history-code-info">

                            <span className="inventory-history-code">
                              {session.code}
                            </span>

                            <span className="inventory-history-secondary">
                              {formatDate(session.start_date)}
                            </span>

                          </div>

                        </div>
                      </td>

                      {/* WAREHOUSE */}

                      <td>
                        <div className="inventory-history-text-cell">

                          <Warehouse
                            size={17}
                            className="inventory-history-inline-icon"
                          />

                          <span>
                            {session.warehouse_name || "Sin almacén"}
                          </span>

                        </div>
                      </td>

                      {/* USER */}

                      <td>
                        <div className="inventory-history-text-cell">

                          <UserRound
                            size={17}
                            className="inventory-history-inline-icon"
                          />

                          <span>
                            {session.user_full_name || "Sin responsable"}
                          </span>

                        </div>
                      </td>

                      {/* STATUS */}

                      <td>
                        <span
                          className={
                            `inventory-history-status ${statusInfo.className}`
                          }
                        >
                          <StatusIcon size={15} />
                          <span>{statusInfo.label}</span>
                        </span>
                      </td>

                      {/* TOTAL PRODUCTS */}

                      <td>
                        <div className="inventory-history-number-cell">

                          <Package
                            size={17}
                            className="inventory-history-number-icon"
                          />

                          <span className="inventory-history-number">
                            {formatNumber(session.total_products)}
                          </span>

                        </div>
                      </td>

                      {/* COUNTED */}

                      <td>
                        <div className="inventory-history-number-cell counted">

                          <PackageCheck size={17} />

                          <span className="inventory-history-number">
                            {formatNumber(session.counted_products)}
                          </span>

                        </div>
                      </td>

                      {/* NOT COUNTED */}

                      <td>
                        <div className="inventory-history-number-cell not-counted">

                          <PackageX size={17} />

                          <span className="inventory-history-number">
                            {formatNumber(session.not_counted_products)}
                          </span>

                        </div>
                      </td>

                      {/* REPORT BUTTON */}

                      <td className="inventory-history-action-cell">

                        <button
                          type="button"
                          className="inventory-history-report-button"
                          onClick={() => handleViewReport(session)}
                          aria-label={`Ver reporte de ${session.code}`}
                        >
                          <FileText size={16} />
                          <span>Reporte</span>
                          <ArrowRight size={15} />
                        </button>

                      </td>

                    </tr>
                  );
                })}

              </tbody>

            </table>

          </div>
        )}

      </section>

      {/* =====================================================
          REPORT SUMMARY MODAL
      ===================================================== */}

      {selectedSession && currentSession && (

        <div
          className="inventory-history-modal-backdrop"
          onClick={closeReport}
        >

          <section
            className="inventory-history-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="inventory-history-modal-title"
            onClick={(event) => event.stopPropagation()}
          >

            {/* ================================================
                MODAL HEADER
            ================================================ */}

            <div className="inventory-history-modal-header">

              <div className="inventory-history-modal-heading">

                <FileText size={23} />

                <div>

                  <span className="inventory-history-eyebrow">
                    REPORTE DE INVENTARIO
                  </span>

                  <h2 id="inventory-history-modal-title">
                    {currentSession.code}
                  </h2>

                </div>

              </div>

              <button
                type="button"
                className="inventory-history-modal-close"
                onClick={closeReport}
                disabled={reportDownloading}
                aria-label="Cerrar reporte"
              >
                <X size={21} />
              </button>

            </div>

            {/* ================================================
                MODAL BODY
            ================================================ */}

            <div className="inventory-history-modal-body">

              {/* SESSION DETAILS */}

              <div className="inventory-history-modal-info">

                <div className="inventory-history-modal-info-row">
                  <Warehouse size={18} />

                  <div>
                    <span>Almacén</span>
                    <strong>
                      {currentSession.warehouse_name || "Sin almacén"}
                    </strong>
                  </div>
                </div>

                <div className="inventory-history-modal-info-row">
                  <UserRound size={18} />

                  <div>
                    <span>Responsable</span>
                    <strong>
                      {currentSession.user_full_name || "Sin responsable"}
                    </strong>
                  </div>
                </div>

                <div className="inventory-history-modal-info-row">
                  <CalendarDays size={18} />

                  <div>
                    <span>Inicio del inventario</span>
                    <strong>
                      {formatDate(currentSession.start_date)}
                    </strong>
                  </div>
                </div>

                <div className="inventory-history-modal-info-row">
                  <Clock3 size={18} />

                  <div>
                    <span>Fin del conteo</span>
                    <strong>
                      {formatDate(currentSession.end_date)}
                    </strong>
                  </div>
                </div>

              </div>

              {/* REPORT LOADING */}

              {reportLoading && (
                <div className="inventory-history-report-loading">
                  <LoaderCircle
                    size={26}
                    className="spinning"
                  />

                  <span>
                    Consultando el reporte de esta sesión...
                  </span>
                </div>
              )}

              {/* REPORT ERROR */}

              {!reportLoading && reportError && (
                <div
                  className="inventory-history-report-error"
                  role="alert"
                >

                  <AlertCircle size={20} />

                  <div>
                    <strong>No se pudo cargar el reporte</strong>
                    <p>{reportError}</p>
                  </div>

                  {!reportData && (
                    <button
                      type="button"
                      onClick={() =>
                        void fetchSessionReport(selectedSession)
                      }
                    >
                      <RefreshCw size={15} />
                      Reintentar
                    </button>
                  )}

                </div>
              )}

              {/* REPORT SUCCESS */}

              {!reportLoading && reportData && summary && (
                <>

                  {/* STATS */}

                  <div className="inventory-history-modal-stats">

                    <div className="inventory-history-stat">

                      <Package size={23} />

                      <strong>
                        {formatNumber(summary.total_products)}
                      </strong>

                      <span>Total productos</span>

                    </div>

                    <div className="inventory-history-stat counted">

                      <PackageCheck size={23} />

                      <strong>
                        {formatNumber(summary.counted_products)}
                      </strong>

                      <span>Contados</span>

                    </div>

                    <div className="inventory-history-stat not-counted">

                      <PackageX size={23} />

                      <strong>
                        {formatNumber(summary.not_counted_products)}
                      </strong>

                      <span>No contados</span>

                    </div>

                  </div>

                  {/* DETAIL TABLE HEADER */}

                  <div className="inventory-history-detail-heading">

                    <div>
                      <h3>Productos del Inventario</h3>

                      <p>
                        Comparación de cantidades físicas y ERP
                      </p>
                    </div>

                    <span>
                      {formatNumber(products.length)} productos
                    </span>

                  </div>

                  {/* DETAIL TABLE */}

                  <div className="inventory-history-detail-wrapper">

                    <table className="inventory-history-detail-table">

                      <thead>
                        <tr>
                          <th>Producto</th>
                          <th>ERP</th>
                          <th>Físico</th>
                          <th>Diferencia</th>
                          <th>Conteo</th>
                        </tr>
                      </thead>

                      <tbody>

                        {products.map((product) => (

                          <tr key={product.id}>

                            <td>

                              <div className="inventory-history-product-info">

                                <strong>
                                  {product.sku ||
                                    product.erp_sku ||
                                    product.erp_id}
                                </strong>

                                <span>
                                  {product.erp_name ||
                                    product.description ||
                                    "Producto sin descripción"}
                                </span>

                              </div>

                            </td>

                            <td className="inventory-history-detail-number">
                              {formatQuantity(product.erp_stock)}
                            </td>

                            <td className="inventory-history-detail-number">
                              {formatQuantity(
                                product.total_inventory_qty
                              )}
                            </td>

                            <td>
                              <span
                                className={
                                  `inventory-history-difference ${
                                    getDifferenceClass(product.difference)
                                  }`
                                }
                              >
                                {formatQuantity(product.difference)}
                              </span>
                            </td>

                            <td>

                              <span
                                className={
                                  `inventory-history-count-badge ${
                                    product.wms_counted === true
                                      ? "counted"
                                      : product.wms_counted === false
                                        ? "not-counted"
                                        : "unknown"
                                  }`
                                }
                              >

                                {product.wms_counted === true
                                  ? "Contado"
                                  : product.wms_counted === false
                                    ? "No contado"
                                    : "Sin dato"}

                              </span>

                            </td>

                          </tr>

                        ))}

                      </tbody>

                    </table>

                  </div>

                  {/* DOWNLOAD ACTION */}

                  <div className="inventory-history-modal-actions">

                    <button
                      type="button"
                      className="inventory-history-download-button"
                      disabled={reportDownloading}
                      onClick={() => void handleDownloadExcel()}
                    >

                      {reportDownloading ? (
                        <LoaderCircle
                          size={18}
                          className="spinning"
                        />
                      ) : (
                        <FileSpreadsheet size={18} />
                      )}

                      <span>
                        {reportDownloading
                          ? "Generando Excel..."
                          : "Descargar Reporte Excel"}
                      </span>

                      {!reportDownloading && (
                        <Download size={17} />
                      )}

                    </button>

                  </div>

                </>
              )}

            </div>

          </section>

        </div>
      )}

    </div>
  );
}
