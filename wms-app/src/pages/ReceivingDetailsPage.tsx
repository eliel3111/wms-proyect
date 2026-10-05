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

        navigate(-1);

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


    if (
        loading
    ) {

        return (

            <div className="receiving-details-page">

                Cargando detalles...

            </div>

        );

    }


    if (
        error
    ) {

        return (

            <div className="receiving-details-page">

                {
                    error
                }

            </div>

        );

    }



    return (

        <div className="receiving-details-page">

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