
import { useEffect, useState } from "react";

import {
    Activity,
    ArrowLeft,
    FileText,
    RefreshCw,
    Trash2,
    Truck,
    UsersRound,
} from "lucide-react";

import apiClient from "../services/apiClient";

import { useModal } from "../context/ModalContext";

import "../styles/ReceivingDetailsPage.css";
import "../styles/conduce-dispatch-details.css";


// ============================================================
// INTERFACES
// ============================================================

export interface DispatchSummary {
    id: number;
    erp_doc_id: string;
    erp_doc_date: string | null;
    erp_reference: string | null;
    erp_relationship_name: string | null;
    erp_location_id: string | number | null;
    warehouse_name: string | null;

    erp_status?: number | string | null;
    erp_status_desc?: string | null;

    // Estado local de SIDIAL
    state?: string | null;

    state_label?: string | null;
    state_color?: string | null;
}

interface DispatchLine {
    id: number;

    wms_sku?: string | null;
    product_sku?: string | null;
    sku?: string | null;

    erp_item_sku?: string | null;

    erp_name?: string | null;
    erp_item_name?: string | null;

    erp_quantity?: number | string | null;

    erp_completed_quantity?: number | string | null;

    erp_pending_completed_quantity?: number | string | null;
}

interface DispatchDetails extends DispatchSummary {
    state?: string | null;
    state_label?: string | null;
    state_color?: string | null;
}

interface DispatchDetailsResponse {
    success: boolean;
    title?: string;
    message?: string;

    data?: {
        dispatch: DispatchDetails;
        lines: DispatchLine[];
    };
}

interface ReverseDispatchResponse {
    success: boolean;

    title?: string;
    message?: string;
    code?: string;

    data?: {
        dispatch?: DispatchDetails;
        reversal_id?: number | string;
        lines_reverted?: number;
        total_qty_returned?: number;
    };
}

interface Props {
    dispatch: DispatchSummary;
    onBack: () => void;
    onReversed?: () => void;
}


// ============================================================
// HELPERS
// ============================================================

const quantity = (
    value: number | string | null | undefined
): number => {
    const n = Number(value ?? 0);

    return Number.isFinite(n) ? n : 0;
};

const displayQuantity = (value: number): string =>
    value.toLocaleString("es-DO", {
        maximumFractionDigits: 4,
    });


// ============================================================
// COMPONENT
// ============================================================

export default function ConduceDispatchDetails({
    dispatch,
    onBack,
    onReversed,
}: Props) {

    // ========================================================
    // ESTADOS
    // ========================================================

    const [details, setDetails] =
        useState<DispatchDetails | null>(null);

    const [lines, setLines] =
        useState<DispatchLine[]>([]);

    const [loading, setLoading] =
        useState(true);

    const [error, setError] =
        useState<string | null>(null);

    const [reload, setReload] =
        useState(0);

    const [deleting, setDeleting] =
        useState(false);


    // ========================================================
    // MODAL GLOBAL
    // ========================================================

    const { openModal } = useModal();


    // ========================================================
    // CARGAR DETALLES DEL CONDUCE
    // ========================================================

    useEffect(() => {
        let active = true;

        async function load() {
            setLoading(true);
            setError(null);

            try {

                const response =
                    await apiClient.get<DispatchDetailsResponse>(
                        `/picking/monitor/${dispatch.id}`
                    );

                const payload = response.data;

                if (
                    !payload.success ||
                    !payload.data?.dispatch
                ) {
                    throw new Error(
                        payload.message ||
                        "No fue posible cargar el conduce."
                    );
                }

                if (active) {

                    setDetails(
                        payload.data.dispatch
                    );

                    setLines(
                        Array.isArray(payload.data.lines)
                            ? payload.data.lines
                            : []
                    );

                }

            } catch (cause: unknown) {

                if (active) {

                    const reason = cause as {
                        response?: {
                            data?: {
                                message?: string;
                            };
                        };
                        message?: string;
                    };

                    setError(
                        reason.response?.data?.message ||
                        reason.message ||
                        "No fue posible cargar los detalles del conduce."
                    );

                }

            } finally {

                if (active) {
                    setLoading(false);
                }

            }
        }

        void load();

        return () => {
            active = false;
        };

    }, [dispatch.id, reload]);


    // ========================================================
    // BORRAR / REVERTIR CONDUCE
    // ========================================================

    const handleDeleteDispatch = async () => {

        if (deleting) {
            return;
        }

        // ====================================================
        // 1. CONFIRMAR OPERACIÓN
        // ====================================================

        const confirmed = window.confirm(
            `¿Estás seguro de que deseas borrar el conduce ${dispatch.erp_doc_id}?\n\n` +
            "Esta operación devolverá al inventario las cantidades despachadas.\n\n" +
            "El conduce debe estar anulado o eliminado en ADM Cloud."
        );

        if (!confirmed) {
            return;
        }

        setDeleting(true);

        console.log("");
        console.log("🔴 ========================================");
        console.log("🔴 SOLICITANDO REVERSIÓN DE CONDUCE");
        console.log("🔴 ========================================");
        console.log("📄 Conduce:", dispatch.erp_doc_id);
        console.log("🆔 ID local:", dispatch.id);

        try {

            // =================================================
            // 2. LLAMAR AL BACKEND
            // =================================================

            const response =
                await apiClient.post<ReverseDispatchResponse>(
                    `/picking/monitor/${dispatch.id}/reverse`,
                    {
                        reason:
                            "Reversión solicitada desde el monitor de conduces de despacho.",
                    }
                );

            const payload = response.data;

            console.log(
                "📥 RESPUESTA REVERSIÓN:",
                payload
            );


            // =================================================
            // 3. ERROR DEL BACKEND
            // =================================================

            if (!payload?.success) {

                openModal({
                    title:
                        payload?.title ||
                        "No se pudo borrar el conduce",

                    message:
                        payload?.message ||
                        "El servidor no pudo completar la reversión.",

                    buttonText: "Cerrar",

                    titleColor: "red",

                    onCloseCallback: undefined,
                });

                return;
            }


            // =================================================
            // 4. REVERSIÓN EXITOSA
            // =================================================

            console.log(
                "✅ CONDUCE REVERTIDO CORRECTAMENTE"
            );

            openModal({
                title:
                    payload.title ||
                    "Conduce anulado correctamente",

                message:
                    payload.message ||
                    `El conduce ${dispatch.erp_doc_id} fue revertido correctamente. ` +
                    "Las cantidades fueron devueltas al inventario.",

                buttonText: "Aceptar",

                titleColor: "green",

                onCloseCallback: undefined,
            });


            // =================================================
            // 5. ACTUALIZAR LISTADO
            // =================================================

            onReversed?.();


            // =================================================
            // 6. REGRESAR AL MONITOR
            // =================================================

            onBack();

        } catch (cause: unknown) {

            // =================================================
            // 7. CAPTURAR ERRORES
            // =================================================

            const apiError = cause as {
                response?: {
                    status?: number;
                    data?: ReverseDispatchResponse;
                };
                message?: string;
            };

            const backendError =
                apiError.response?.data;

            console.error(
                "❌ ERROR BORRANDO CONDUCE:",
                {
                    status:
                        apiError.response?.status,

                    title:
                        backendError?.title,

                    message:
                        backendError?.message,

                    code:
                        backendError?.code,
                }
            );


            // =================================================
            // 8. MOSTRAR ERROR EN MODAL
            // =================================================

            openModal({
                title:
                    backendError?.title ||
                    "Error al borrar conduce",

                message:
                    backendError?.message ||
                    apiError.message ||
                    "Ocurrió un error al intentar borrar el conduce.",

                buttonText: "Cerrar",

                titleColor: "red",

                onCloseCallback: undefined,
            });

        } finally {

            setDeleting(false);

        }
    };


    // ========================================================
    // DATOS DEL ENCABEZADO
    // ========================================================

    const header = details ?? dispatch;


    // ========================================================
    // ESTADO LOCAL DEL CONDUCE
    //
    // completed = Completado (green)
    // reverted  = Anulado    (red)
    // ========================================================

    const dispatchState = String(
        details?.state ??
        dispatch.state ??
        ""
    ).toLowerCase();


    // ========================================================
    // TEXTO DEL ESTADO
    // ========================================================

    const status =
        dispatchState === "completed"
            ? "Completado"
            : dispatchState === "reverted"
                ? "Anulado"
                : (
                    details?.state_label ||
                    dispatch.state_label ||
                    "Desconocido"
                );


    // ========================================================
    // COLOR DEL ESTADO
    // ========================================================

    const statusColor =
        dispatchState === "completed"
            ? "green"
            : dispatchState === "reverted"
                ? "red"
                : "gray";


    // ========================================================
    // CONDUCE ANULADO
    // ========================================================

    const isReverted =
        dispatchState === "reverted";


    // ========================================================
    // JSX
    // ========================================================

    return (

        <div className="receiving-details-page conduce-details-page">

            <div className="receiving-details-layout">


                {/* ============================================
                    PANEL SUPERIOR
                ============================================ */}

                <aside className="receiving-details-left">


                    {/* ========================================
                        BOTÓN VOLVER ATRÁS
                    ======================================== */}

                    <div className="receiving-details-back-section">

                        <button
                            type="button"
                            className="receiving-details-back-button"
                            onClick={onBack}
                            disabled={deleting}
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


                    {/* ========================================
                        INFORMACIÓN DEL CONDUCE
                    ======================================== */}

                    <div className="receiving-details-information-card">


                        {/* ====================================
                            PEDIDO
                        ==================================== */}

                        <div className="receiving-details-information-row receiving-details-order-row">

                            <div className="receiving-details-main-icon">

                                <Truck
                                    size={28}
                                    strokeWidth={2}
                                />

                            </div>


                            <div className="receiving-details-order-content">

                                <div className="receiving-details-order-title">
                                    Pedido:
                                </div>

                                <div className="receiving-details-order-number">
                                    {header.erp_doc_id || "—"}
                                </div>

                            </div>

                        </div>


                        {/* ====================================
                            CLIENTE
                        ==================================== */}

                        <div className="receiving-details-information-row">

                            <div className="receiving-details-small-icon">

                                <UsersRound
                                    size={22}
                                    strokeWidth={2}
                                />

                            </div>


                            <div className="receiving-details-field-content">

                                <div className="receiving-details-field-label">
                                    Cliente:
                                </div>

                                <div className="receiving-details-field-value">
                                    {
                                        header.erp_relationship_name ||
                                        "—"
                                    }
                                </div>

                            </div>

                        </div>


                        {/* ====================================
                            REFERENCIA
                        ==================================== */}

                        <div className="receiving-details-information-row">

                            <div className="receiving-details-small-icon">

                                <FileText
                                    size={21}
                                    strokeWidth={2}
                                />

                            </div>


                            <div className="receiving-details-field-content">

                                <div className="receiving-details-field-label">
                                    Referencia:
                                </div>

                                <div className="receiving-details-field-value">
                                    {header.erp_reference || "—"}
                                </div>

                            </div>

                        </div>


                        {/* ====================================
                            ESTADO DEL CONDUCE
                        ==================================== */}

                        <div className="receiving-details-information-row">

                            <div className="receiving-details-small-icon">

                                <Activity
                                    size={22}
                                    strokeWidth={2}
                                />

                            </div>


                            <div className="receiving-details-field-content receiving-details-status-content">

                                <div className="receiving-details-field-label">
                                    Estado:
                                </div>


                                <div
                                    className={`
                                        receiving-details-active-pill
                                        conduce-details-status-${statusColor}
                                    `}
                                >

                                    <span className="receiving-details-active-dot" />

                                    <span>
                                        {status}
                                    </span>

                                </div>

                            </div>

                        </div>

                    </div>

                </aside>


                {/* ============================================
                    PANEL INFERIOR
                ============================================ */}

                <main className="receiving-details-right">


                    {/* ========================================
                        HEADER
                    ======================================== */}

                    <div className="receiving-details-tabs conduce-details-titlebar">


                        {/* TÍTULO */}

                        <div className="conduce-details-heading">

                            <Truck
                                size={23}
                                strokeWidth={1.9}
                            />

                            <h2>
                                Detalles del Conduce de Despacho
                            </h2>

                        </div>


                        {/* ====================================
                            BOTÓN BORRAR CONDUCE
                        ==================================== */}

                        <button
                            type="button"

                            className="conduce-details-delete-button"

                            onClick={() => {
                                void handleDeleteDispatch();
                            }}

                            disabled={
                                deleting ||
                                loading ||
                                Boolean(error) ||
                                isReverted
                            }
                        >

                            {deleting ? (

                                <>
                                    <RefreshCw
                                        size={17}
                                        className="conduce-details-spinning"
                                    />

                                    <span>
                                        Borrando conduce...
                                    </span>
                                </>

                            ) : (

                                <>
                                    <Trash2
                                        size={17}
                                        strokeWidth={2}
                                    />

                                    <span>
                                        {
                                            isReverted
                                                ? "Conduce anulado"
                                                : "Borrar conduce"
                                        }
                                    </span>
                                </>

                            )}

                        </button>

                    </div>


                    {/* ========================================
                        CARGANDO DATOS
                    ======================================== */}

                    {loading ? (

                        <div
                            className="conduce-details-message"
                            role="status"
                        >
                            Cargando detalles del conduce...
                        </div>

                    ) : error ? (

                        /* ====================================
                            ERROR AL CARGAR
                        ==================================== */

                        <div
                            className="conduce-details-message"
                            role="alert"
                        >

                            <p>
                                {error}
                            </p>

                            <button
                                type="button"
                                className="receiving-details-back-button"

                                onClick={() =>
                                    setReload(n => n + 1)
                                }
                            >

                                <RefreshCw size={17} />

                                Intentar nuevamente

                            </button>

                        </div>

                    ) : (

                        /* ====================================
                            TABLA DE PRODUCTOS
                        ==================================== */

                        <div className="receiving-details-table-container">

                            <table className="receiving-details-table conduce-details-table">


                                {/* ============================
                                    HEADER TABLA
                                ============================ */}

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
                                            Adm Cloud Código
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


                                {/* ============================
                                    BODY TABLA
                                ============================ */}

                                <tbody>

                                    {lines.length === 0 ? (

                                        <tr>

                                            <td
                                                colSpan={9}
                                                className="conduce-details-empty"
                                            >
                                                Este conduce no tiene líneas registradas.
                                            </td>

                                        </tr>

                                    ) : lines.map((line, index) => {


                                        // ====================
                                        // CANTIDADES
                                        // ====================

                                        const ordered =
                                            quantity(
                                                line.erp_quantity
                                            );

                                        const completed =
                                            quantity(
                                                line.erp_completed_quantity
                                            );

                                        const pending =
                                            line.erp_pending_completed_quantity == null
                                                ? Math.max(
                                                    ordered - completed,
                                                    0
                                                )
                                                : quantity(
                                                    line.erp_pending_completed_quantity
                                                );


                                        // ====================
                                        // ESTADO DE LA LÍNEA
                                        // ====================

                                        const rowStatus =
                                            pending <= 0
                                                ? "completed"
                                                : completed > 0
                                                    ? "active"
                                                    : "pending";


                                        return (

                                            <tr key={line.id}>


                                                {/* CHECKBOX */}

                                                <td className="receiving-details-checkbox-column">

                                                    <input
                                                        type="checkbox"
                                                        aria-label={`Seleccionar línea ${index + 1}`}
                                                    />

                                                </td>


                                                {/* NÚMERO */}

                                                <td className="receiving-details-number-column">
                                                    {index + 1}
                                                </td>


                                                {/* WMS SKU */}

                                                <td className="receiving-details-product-code">

                                                    {
                                                        line.wms_sku ||
                                                        line.product_sku ||
                                                        line.sku ||
                                                        "—"
                                                    }

                                                </td>


                                                {/* ADM CLOUD SKU */}

                                                <td className="receiving-details-product-code">

                                                    {line.erp_item_sku || "—"}

                                                </td>


                                                {/* DESCRIPCIÓN */}

                                                <td className="receiving-details-description">

                                                    {
                                                        line.erp_name ||
                                                        line.erp_item_name ||
                                                        "—"
                                                    }

                                                </td>


                                                {/* CANTIDAD ORDENADA */}

                                                <td>
                                                    {displayQuantity(ordered)}
                                                </td>


                                                {/* CANTIDAD RECIBIDA */}

                                                <td>
                                                    {displayQuantity(completed)}
                                                </td>


                                                {/* PENDIENTE */}

                                                <td>
                                                    {displayQuantity(pending)}
                                                </td>


                                                {/* ESTADO LÍNEA */}

                                                <td>

                                                    <div
                                                        className={`
                                                            receiving-details-status-pill
                                                            receiving-details-status-${rowStatus}
                                                        `}
                                                    >

                                                        <span
                                                            className={`
                                                                receiving-details-status-dot
                                                                receiving-details-status-dot-${rowStatus}
                                                            `}
                                                        />

                                                        <span>
                                                            {rowStatus.toUpperCase()}
                                                        </span>

                                                    </div>

                                                </td>

                                            </tr>

                                        );
                                    })}

                                </tbody>

                            </table>

                        </div>

                    )}

                </main>

            </div>

        </div>

    );
}
