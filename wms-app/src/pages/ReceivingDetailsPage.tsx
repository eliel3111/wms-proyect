import {
    useNavigate,
    useParams,
} from "react-router-dom";

import {
    useEffect,
    useMemo,
    useState,
} from "react";

import apiClient from "../services/apiClient.ts";

import {
  ArrowLeft,
  FileText,
  UsersRound,
  Activity,
  ClipboardList,
  Package,
  WifiOff,
  RefreshCw,
} from "lucide-react";

import "../styles/ReceivingDetailsPage.css";

interface PurchaseOrderDetails {

    id: number;

    purchase_order_number:
    string;

    erp_id:
    string | null;

    supplier_name:
    string | null;

    status:
    string;

}


interface DocumentItem {

    id: number;

    type:
    | "purchase_order"
    | "receipt";

    code:
    string;

}


interface DetailLine {

    id:
    number;

    origen_id:
    number;

    origen_type:
    | "purchase_order"
    | "receipt";

    sku:
    string;

    description:
    string | null;

    ordered_qty:
    number;

    received_qty:
    number;

    difference_qty:
    number;

}


interface PurchaseOrderDetailsResponse {

    success:
    boolean;

    data: {

        purchase_order:
        PurchaseOrderDetails;

        documents:
        DocumentItem[];

        lines:
        DetailLine[];

    };

}

export default function ReceivingDetailsPage() {

    const navigate =
        useNavigate();

    const {
        id,
    } =
        useParams<{
            id: string;
        }>();


    const [
        purchaseOrder,
        setPurchaseOrder,
    ] =
        useState<PurchaseOrderDetails | null>(
            null
        );


    const [
        documents,
        setDocuments,
    ] =
        useState<DocumentItem[]>(
            []
        );


    const [
        lines,
        setLines,
    ] =
        useState<DetailLine[]>(
            []
        );


    const [
        selectedDocument,
        setSelectedDocument,
    ] =
        useState<DocumentItem | null>(
            null
        );


    const [
        loading,
        setLoading,
    ] =
        useState<boolean>(
            true
        );


    const [
        error,
        setError,
    ] =
        useState<string | null>(
            null
        );

        const [isClosing, setIsClosing] =
    useState(false);


    useEffect(
        () => {

            if (
                !id
            ) {

                setError(
                    "No se recibió el ID de la orden."
                );

                setLoading(
                    false
                );

                return;

            }


            const purchaseOrderId =
                Number(
                    id
                );


            if (
                !Number.isInteger(
                    purchaseOrderId
                ) ||
                purchaseOrderId <= 0
            ) {

                setError(
                    "El ID de la orden de compra no es válido."
                );

                setLoading(
                    false
                );

                return;

            }


            const fetchPurchaseOrderDetails =
                async () => {

                    try {

                        setLoading(
                            true
                        );

                        setError(
                            null
                        );


                        console.log(
                            "📋 Buscando details PO:",
                            purchaseOrderId
                        );


                        const response =
                            await apiClient.get<PurchaseOrderDetailsResponse>(
                                `/receiving/purchase-order-details/${purchaseOrderId}`
                            );


                        console.log(
                            "📥 PURCHASE ORDER FULL DETAILS:",
                            response.data
                        );


                        if (
                            !response.data?.success
                        ) {

                            throw new Error(
                                "No se pudieron obtener los detalles."
                            );

                        }


                        const {
                            purchase_order,
                            documents,
                            lines,
                        } =
                            response.data.data;


                        // ================================================
                        // HEADER
                        // ================================================

                        setPurchaseOrder(
                            purchase_order
                        );


                        // ================================================
                        // PO + RECEIPTS
                        // ================================================

                        setDocuments(
                            Array.isArray(
                                documents
                            )
                                ? documents
                                : []
                        );


                        // ================================================
                        // TODAS LAS LÍNEAS
                        // ================================================

                        setLines(
                            Array.isArray(
                                lines
                            )
                                ? lines
                                : []
                        );


                        // ================================================
                        // SELECCIONAR PRIMER DOCUMENTO
                        //
                        // El primero es la Purchase Order.
                        // ================================================

                        if (
                            Array.isArray(
                                documents
                            ) &&
                            documents.length > 0
                        ) {

                            setSelectedDocument(
                                documents[0]
                            );

                        }


                    } catch (
                    error: any
                    ) {

                        console.error(
                            "❌ Error obteniendo details:",
                            error
                        );


                        setError(
                            error?.response?.data?.message ||
                            error?.message ||
                            "No se pudieron cargar los detalles."
                        );


                    } finally {

                        setLoading(
                            false
                        );

                    }

                };


            fetchPurchaseOrderDetails();


        },
        [
            id
        ]
    );


    const selectedLines =
        useMemo(
            () => {

                if (
                    !selectedDocument
                ) {

                    return [];

                }


                return lines.filter(
                    line =>
                        line.origen_id ===
                        selectedDocument.id &&
                        line.origen_type ===
                        selectedDocument.type
                );

            },
            [
                lines,
                selectedDocument
            ]
        );

    // =========================================
    // VOLVER
    // =========================================

    const handleBack = () => {

    if (isClosing) {
        return;
    }

    setIsClosing(true);

};


    // =========================================
    // BORRAR RECEPCIÓN
    // POR AHORA SOLO MOCK
    // =========================================

   /* const handleDeleteReceipt = () => {

        console.log(
            "Borrar recepción"
        );

    };*/


    if (loading) {

  return (

    <div className="receiving-details-page receiving-details-loading-page">

      <div className="receiving-details-loading-layout">


        {/* =========================================
            LEFT SIDE
        ========================================= */}

        <aside className="receiving-loading-left">


          {/* BACK BUTTON PLACEHOLDER */}

          <div className="receiving-loading-back-card">

            <div className="receiving-loading-back-button skeleton-shimmer">

              <div className="receiving-loading-back-icon" />

              <div className="receiving-loading-back-text" />

            </div>

          </div>


          {/* INFORMATION CARD */}

          <div className="receiving-loading-info-card">


            {/* PURCHASE ORDER */}

            <div className="receiving-loading-info-row receiving-loading-order-row">

              <div className="receiving-loading-main-icon skeleton-shimmer" />


              <div className="receiving-loading-text-group">

                <div className="receiving-loading-label skeleton-shimmer" />

                <div className="receiving-loading-order-number skeleton-shimmer" />

              </div>

            </div>


            {/* SUPPLIER */}

            <div className="receiving-loading-info-row">

              <div className="receiving-loading-small-icon skeleton-shimmer" />

              <div className="receiving-loading-text-group">

                <div className="receiving-loading-label skeleton-shimmer" />

                <div className="receiving-loading-value receiving-loading-value-long skeleton-shimmer" />

              </div>

            </div>


            {/* ERP ID */}

            <div className="receiving-loading-info-row">

              <div className="receiving-loading-small-icon skeleton-shimmer" />

              <div className="receiving-loading-text-group">

                <div className="receiving-loading-label skeleton-shimmer" />

                <div className="receiving-loading-value receiving-loading-value-medium skeleton-shimmer" />

              </div>

            </div>


            {/* STATUS */}

            <div className="receiving-loading-info-row">

              <div className="receiving-loading-small-icon skeleton-shimmer" />

              <div className="receiving-loading-text-group">

                <div className="receiving-loading-label skeleton-shimmer" />

                <div className="receiving-loading-status skeleton-shimmer" />

              </div>

            </div>

          </div>

        </aside>


        {/* =========================================
            RIGHT SIDE
        ========================================= */}

        <main className="receiving-loading-right">


          {/* TABS */}

          <div className="receiving-loading-tabs">

            <div className="receiving-loading-tab receiving-loading-tab-main skeleton-shimmer" />

            <div className="receiving-loading-tab skeleton-shimmer" />

            <div className="receiving-loading-tab skeleton-shimmer" />

          </div>


          {/* LOADING MESSAGE */}

          <div className="receiving-loading-message">

            <div className="receiving-loading-spinner">

              <div className="receiving-loading-spinner-ring" />

              <div className="receiving-loading-spinner-center" />

            </div>


            <div className="receiving-loading-message-content">

              <div className="receiving-loading-message-title">
                Cargando detalles
              </div>

              <div className="receiving-loading-message-subtitle">
                Estamos preparando la orden de compra y sus recepciones.
              </div>

            </div>

          </div>


          {/* TABLE */}

          <div className="receiving-loading-table">

            {/* HEADER */}

            <div className="receiving-loading-table-header">

              <div className="receiving-loading-header-cell receiving-loading-cell-check" />
              <div className="receiving-loading-header-cell receiving-loading-cell-number" />
              <div className="receiving-loading-header-cell" />
              <div className="receiving-loading-header-cell receiving-loading-cell-description" />
              <div className="receiving-loading-header-cell" />
              <div className="receiving-loading-header-cell" />
              <div className="receiving-loading-header-cell" />
              <div className="receiving-loading-header-cell" />

            </div>


            {/* ROWS */}

            {Array.from({ length: 6 }).map((_, index) => (

              <div
                className="receiving-loading-table-row"
                key={index}
              >

                <div className="receiving-loading-checkbox skeleton-shimmer" />

                <div className="receiving-loading-number skeleton-shimmer" />

                <div className="receiving-loading-table-line receiving-loading-line-code skeleton-shimmer" />

                <div className="receiving-loading-table-line receiving-loading-line-description skeleton-shimmer" />

                <div className="receiving-loading-table-line receiving-loading-line-small skeleton-shimmer" />

                <div className="receiving-loading-table-line receiving-loading-line-small skeleton-shimmer" />

                <div className="receiving-loading-table-line receiving-loading-line-small skeleton-shimmer" />

                <div className="receiving-loading-pill skeleton-shimmer" />

              </div>

            ))}

          </div>

        </main>

      </div>

    </div>

  );

}


    if (error) {

  const isNetworkError =
    error
      .toLowerCase()
      .includes("network");


  return (

    <div
      className={`
        receiving-details-page
        receiving-details-error-page

        ${
          isClosing
            ? "receiving-details-page-closing"
            : ""
        }
      `}
      onAnimationEnd={(event) => {

        if (
          isClosing &&
          event.animationName ===
            "receivingDetailsExitLeft"
        ) {

          navigate(-1);

        }

      }}
    >

      <div className="receiving-details-error-container">


        {/* =====================================
            ERROR ICON
        ===================================== */}

        <div className="receiving-details-error-icon">

          <WifiOff
            size={32}
            strokeWidth={1.8}
          />

        </div>


        {/* =====================================
            CONTENT
        ===================================== */}

        <div className="receiving-details-error-content">


          <span className="receiving-details-error-eyebrow">

            No pudimos cargar la información

          </span>


          <h2 className="receiving-details-error-title">

            {
              isNetworkError
                ? "No hay conexión con el servidor"
                : "Ocurrió un problema"
            }

          </h2>


          <p className="receiving-details-error-description">

            {
              isNetworkError
                ? "No fue posible conectarse al servidor del WMS. Verifica tu conexión o intenta nuevamente."
                : "No pudimos obtener los detalles de esta orden de compra. Puedes intentar nuevamente."
            }

          </p>


          {/* =====================================
              TECHNICAL MESSAGE
          ===================================== */}

          <div className="receiving-details-error-technical">

            <span className="receiving-details-error-technical-label">
              Detalle técnico
            </span>

            <span className="receiving-details-error-technical-value">
              {error}
            </span>

          </div>


          {/* =====================================
              ACTIONS
          ===================================== */}

          <div className="receiving-details-error-actions">


            <button
              type="button"
              className="
                receiving-details-error-button
                receiving-details-error-button-primary
              "
              onClick={() => {

                window.location.reload();

              }}
            >

              <RefreshCw
                size={17}
                strokeWidth={2}
              />

              <span>
                Intentar nuevamente
              </span>

            </button>


            <button
              type="button"
              className="
                receiving-details-error-button
                receiving-details-error-button-secondary
              "
              onClick={handleBack}
            >

              <ArrowLeft
                size={17}
                strokeWidth={2}
              />

              <span>
                Volver atrás
              </span>

            </button>

          </div>

        </div>

      </div>

    </div>

  );

}



    return (

    <div
        className={`
            receiving-details-page
            ${
                isClosing
                    ? "receiving-details-page-closing"
                    : ""
            }
        `}
        onAnimationEnd={(event) => {

            if (
                isClosing &&
                event.animationName ===
                    "receivingDetailsExitLeft"
            ) {

                navigate(-1);

            }

        }}
    >

        <div className="receiving-details-layout">


                {/* =====================================
            LEFT PANEL
        ===================================== */}

                <aside className="receiving-details-left">


                    {/* =================================
              BACK
          ================================= */}

                    <div className="receiving-details-back-section">

                       <button
    type="button"
    className="receiving-details-back-button"
    onClick={handleBack}
    disabled={isClosing}
>

    <ArrowLeft
        size={20}
        strokeWidth={2.2}
    />

    <span>
        Volver atrás
    </span>

</button>

                    </div>


                    {/* =================================
              ORDER INFORMATION
          ================================= */}

                    <div className="receiving-details-information-card">


                        {/* ===============================
                PURCHASE ORDER
            =============================== */}

                        <div
                            className="
                receiving-details-information-row
                receiving-details-order-row
              "
                        >

                            <div className="receiving-details-main-icon">

                                <FileText
                                    size={28}
                                    strokeWidth={2}
                                />

                            </div>


                            <div className="receiving-details-order-content">

                                <div className="receiving-details-order-title">

                                    Orden de Compra

                                </div>


                                <div className="receiving-details-order-number">

                                    {
                                        purchaseOrder
                                            ?.purchase_order_number ||
                                        "-"
                                    }

                                </div>

                            </div>

                        </div>


                        {/* ===============================
                SUPPLIER
            =============================== */}

                        <div className="receiving-details-information-row">

                            <div className="receiving-details-small-icon">

                                <UsersRound
                                    size={22}
                                    strokeWidth={2}
                                />

                            </div>


                            <div className="receiving-details-field-content">

                                <div className="receiving-details-field-label">

                                    Supplier:

                                </div>


                                <div className="receiving-details-field-value">

                                    {
                                        purchaseOrder
                                            ?.supplier_name ||
                                        "-"
                                    }

                                </div>

                            </div>

                        </div>


                        {/* ===============================
                ERP ID
            =============================== */}

                        <div className="receiving-details-information-row">

                            <div className="receiving-details-small-icon">

                                <FileText
                                    size={21}
                                    strokeWidth={2}
                                />

                            </div>


                            <div className="receiving-details-field-content">

                                <div className="receiving-details-field-label">

                                    ERP ID:

                                </div>


                                <div className="receiving-details-field-value">

                                    {
                                        purchaseOrder
                                            ?.erp_id ||
                                        "-"
                                    }

                                </div>

                            </div>

                        </div>


                        {/* ===============================
                STATUS
            =============================== */}

                        <div className="receiving-details-information-row">

                            <div className="receiving-details-small-icon">

                                <Activity
                                    size={22}
                                    strokeWidth={2}
                                />

                            </div>


                            <div
                                className="
                  receiving-details-field-content
                  receiving-details-status-content
                "
                            >

                                <div className="receiving-details-field-label">

                                    Estado:

                                </div>


                                <div className="receiving-details-active-pill">

                                    <span
                                        className="receiving-details-active-dot"
                                    />

                                    <span>

                                        {
                                            purchaseOrder
                                                ?.status
                                                ?.toUpperCase() ||
                                            "-"
                                        }

                                    </span>

                                </div>

                            </div>

                        </div>

                    </div>

                </aside>


                {/* =====================================
            RIGHT PANEL
        ===================================== */}

                <main className="receiving-details-right">


                    {/* =================================
              TABS
          ================================= */}

                    <div className="receiving-details-tabs">

                        {
                            documents.map(
                                document => {

                                    const isSelected =
                                        selectedDocument?.id ===
                                        document.id &&
                                        selectedDocument?.type ===
                                        document.type;


                                    return (

                                        <button

                                            key={
                                                `${document.type}-${document.id}`
                                            }

                                            type="button"

                                            className={`
              receiving-details-tab
              ${isSelected
                                                    ? "receiving-details-tab-selected"
                                                    : ""
                                                }
            `}

                                            onClick={
                                                () =>
                                                    setSelectedDocument(
                                                        document
                                                    )
                                            }

                                        >

                                            {
                                                document.type ===
                                                    "purchase_order"
                                                    ? (

                                                        <ClipboardList
                                                            size={22}
                                                            strokeWidth={2}
                                                        />

                                                    )
                                                    : (

                                                        <Package
                                                            size={22}
                                                            strokeWidth={2}
                                                        />

                                                    )
                                            }


                                            <span>

                                                {
                                                    document.type ===
                                                        "purchase_order"
                                                        ? "Orden de Compra"
                                                        : document.code
                                                }

                                            </span>

                                        </button>

                                    );

                                }
                            )
                        }

                    </div>


                    {/* =================================
              TABLE
          ================================= */}

                    <div className="receiving-details-table-container">

                        <table className="receiving-details-table">


                            {/* ===========================
                  TABLE HEADER
              =========================== */}

                            <thead>

                                <tr>

                                    <th className="receiving-details-checkbox-column">

                                        <input
                                            type="checkbox"
                                            aria-label="Seleccionar todas"
                                        />

                                    </th>


                                    <th className="receiving-details-number-column">

                                        No.

                                    </th>


                                    <th>

                                        Código de Producto

                                    </th>


                                    <th>

                                        Descripción

                                    </th>


                                    <th>

                                        Cantidad Ordenada

                                    </th>


                                    <th>

                                        Cantidad Recibida

                                    </th>


                                    <th>

                                        Pendiente

                                    </th>


                                    <th>

                                        Estado

                                    </th>

                                </tr>

                            </thead>


                            {/* ===========================
                  TABLE BODY
              =========================== */}

                            <tbody>

                                {
                                    selectedLines.map(
                                        (
                                            line,
                                            index
                                        ) => {

                                            const pending =
                                                Math.max(
                                                    line.ordered_qty -
                                                    line.received_qty,
                                                    0
                                                );


                                            const status =

                                                line.received_qty >=
                                                    line.ordered_qty

                                                    ? "COMPLETED"

                                                    : line.received_qty > 0

                                                        ? "ACTIVE"

                                                        : "PENDING";


                                            return (

                                                <tr
                                                    key={
                                                        `${line.origen_type}-${line.origen_id}-${line.id}`
                                                    }
                                                >

                                                    <td className="receiving-details-checkbox-column">

                                                        <input
                                                            type="checkbox"
                                                            aria-label={
                                                                `Seleccionar línea ${index + 1}`
                                                            }
                                                        />

                                                    </td>


                                                    <td className="receiving-details-number-column">

                                                        {
                                                            index + 1
                                                        }

                                                    </td>


                                                    <td className="receiving-details-product-code">

                                                        {
                                                            line.sku
                                                        }

                                                    </td>


                                                    <td className="receiving-details-description">

                                                        {
                                                            line.description ||
                                                            "-"
                                                        }

                                                    </td>


                                                    <td>

                                                        {
                                                            line
                                                                .ordered_qty
                                                                .toLocaleString()
                                                        }

                                                    </td>


                                                    <td>

                                                        {
                                                            line
                                                                .received_qty
                                                                .toLocaleString()
                                                        }

                                                    </td>


                                                    <td>

                                                        {
                                                            pending
                                                                .toLocaleString()
                                                        }

                                                    </td>


                                                    <td>

                                                        <div
                                                            className={`
                receiving-details-status-pill
                receiving-details-status-${status.toLowerCase()}
              `}
                                                        >

                                                            <span
                                                                className={`
                  receiving-details-status-dot
                  receiving-details-status-dot-${status.toLowerCase()}
                `}
                                                            />


                                                            <span>

                                                                {
                                                                    status
                                                                }

                                                            </span>

                                                        </div>

                                                    </td>

                                                </tr>

                                            );

                                        }
                                    )
                                }

                            </tbody>

                        </table>

                    </div>


                    {/* =================================
              FOOTER
          ================================= */}

                    <div className="receiving-details-footer">

                     {/*
<button
  type="button"
  className="receiving-details-delete-button"
  onClick={handleDeleteReceipt}
>

  <Trash2
    size={20}
    strokeWidth={2}
  />

  <span>
    Borrar Recepción
  </span>

</button>
*/}

                    </div>

                </main>

            </div>

        </div>

    );

}