import {
    ClipboardCheck,
    FileText,
    Info,
    CheckSquare,
} from "lucide-react";
import {
    useEffect,
    useState
} from "react";
import { useModal } from "../context/ModalContext";
import "../styles/InventoryReport.css";
import apiClient from "../services/apiClient";
import ConfirmationModal from "../components/ConfirmationModal";
interface ReportOption {
    id: number;
    title: string;
    description: string;
}
import socket from "../services/socket";
import type {
    InventoryAdjustmentProgress
} from "../types/inventoryAdjustment";

const reports: ReportOption[] = [
    {
        id: 1,
        title: "Reporte Final del Inventario",
        description:
            "Este reporte muestra los productos contados en el WMS, comparando la cantidad física contra la existencia registrada en Citrus.",
    },
    {
        id: 2,
        title: "Reporte del Inventario Fisico con Ubicacion",
        description:
            "Este reporte muestra los productos que existen en Citrus con balance, pero que no fueron encontrados o contados en el WMS.",
    },
    {
        id: 3,
        title: "Reporte de Auditoria",
        description:
            "Este reporte muestra un resumen general de diferencias, ganancias, pérdidas y productos que requieren revisión antes de aplicar el inventario.",
    },
];

export default function InventoryReport() {

    const [hoveredReport, setHoveredReport] = useState<ReportOption | null>(null);
    const { openModal } = useModal();
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

    const [
        adjustmentJobId,
        setAdjustmentJobId
    ] =
        useState<number | null>(
            null
        );


    const [
        adjustmentProgress,
        setAdjustmentProgress
    ] =
        useState<InventoryAdjustmentProgress | null>(
            null
        );


    const [
        adjustmentStarting,
        setAdjustmentStarting
    ] =
        useState(false);


    const [
        zeroAdjustmentJobId,
        setZeroAdjustmentJobId
    ] = useState<number | null>(null);


    const [
        zeroAdjustmentProgress,
        setZeroAdjustmentProgress
    ] = useState<InventoryAdjustmentProgress | null>(null);


    const [
        zeroAdjustmentStarting,
        setZeroAdjustmentStarting
    ] = useState(false);


    useEffect(
        () => {

            if (
                !adjustmentJobId
            ) {
                return;
            }


            console.log(
                "🟨 CONFIGURANDO SOCKET PARA JOB:",
                adjustmentJobId
            );


            // ========================================================
            // FUNCIÓN PARA ENTRAR AL ROOM
            // ========================================================

            const joinRoom =
                () => {

                    console.log(
                        "📡 ENTRANDO AL ROOM DEL JOB:",
                        adjustmentJobId
                    );


                    socket.emit(
                        "inventory_adjustment:join",
                        {
                            jobId:
                                adjustmentJobId
                        }
                    );

                };


            // ========================================================
            // RECIBIR PROGRESO
            // ========================================================

            const handleProgress =
                (
                    data:
                        InventoryAdjustmentProgress
                ) => {

                    console.log(
                        "📡 PROGRESO RECIBIDO:",
                        data
                    );


                    // Protección:
                    // solamente procesamos eventos
                    // pertenecientes al job actual.

                    if (
                        Number(data.jobId) !==
                        Number(adjustmentJobId)
                    ) {

                        return;

                    }


                    setAdjustmentProgress(
                        data
                    );

                };


            // ========================================================
            // PRIMERO REGISTRAMOS LISTENER
            // ========================================================

            socket.on(
                "inventory_adjustment:progress",
                handleProgress
            );


            // ========================================================
            // IMPORTANTE:
            // SI SOCKET YA ESTÁ CONECTADO, JOIN AHORA
            // ========================================================

            if (
                socket.connected
            ) {

                joinRoom();

            }


            // ========================================================
            // SI SOCKET SE RECONECTA, VOLVER A ENTRAR AL ROOM
            // ========================================================

            socket.on(
                "connect",
                joinRoom
            );


            // ========================================================
            // CLEANUP
            // ========================================================

            return () => {

                console.log(
                    "📴 LIMPIANDO SOCKET JOB:",
                    adjustmentJobId
                );


                socket.off(
                    "inventory_adjustment:progress",
                    handleProgress
                );


                socket.off(
                    "connect",
                    joinRoom
                );


                if (
                    socket.connected
                ) {

                    socket.emit(
                        "inventory_adjustment:leave",
                        {
                            jobId:
                                adjustmentJobId
                        }
                    );

                }

            };

        },
        [
            adjustmentJobId
        ]
    );

    useEffect(
        () => {

            if (
                !zeroAdjustmentJobId
            ) {
                return;
            }


            console.log(
                "🟨 CONFIGURANDO SOCKET ZERO JOB:",
                zeroAdjustmentJobId
            );


            // =====================================================
            // ENTRAR AL ROOM
            // =====================================================

            const joinZeroRoom =
                () => {

                    console.log(
                        "📡 ENTRANDO AL ZERO JOB:",
                        zeroAdjustmentJobId
                    );


                    socket.emit(
                        "inventory_adjustment:join",
                        {
                            jobId:
                                zeroAdjustmentJobId
                        }
                    );

                };


            // =====================================================
            // RECIBIR PROGRESO
            // =====================================================

            const handleZeroProgress =
                (
                    data:
                        InventoryAdjustmentProgress
                ) => {

                    // Solamente nos interesa
                    // este Job Zero.

                    if (
                        Number(data.jobId) !==
                        Number(zeroAdjustmentJobId)
                    ) {

                        return;

                    }


                    console.log(
                        "📡 ZERO PROGRESS:",
                        data
                    );


                    setZeroAdjustmentProgress(
                        data
                    );

                };


            // =====================================================
            // LISTENER
            // =====================================================

            socket.on(
                "inventory_adjustment:progress",
                handleZeroProgress
            );


            // =====================================================
            // SOCKET YA CONECTADO
            // =====================================================

            if (
                socket.connected
            ) {

                joinZeroRoom();

            }


            // =====================================================
            // RECONEXIÓN
            // =====================================================

            socket.on(
                "connect",
                joinZeroRoom
            );


            // =====================================================
            // CLEANUP
            // =====================================================

            return () => {

                socket.off(
                    "inventory_adjustment:progress",
                    handleZeroProgress
                );


                socket.off(
                    "connect",
                    joinZeroRoom
                );


                if (
                    socket.connected
                ) {

                    socket.emit(
                        "inventory_adjustment:leave",
                        {
                            jobId:
                                zeroAdjustmentJobId
                        }
                    );

                }

            };

        },
        [
            zeroAdjustmentJobId
        ]
    );

    //REPORTE FINAL DEL INVENTARIO
    async function handleReporteFinalInventario() {
        console.log("📄 Ejecutando Reporte Final del Inventario");

        try {
            const response = await apiClient.get("/inventory/report/final", {
                responseType: "blob",
            });

            const contentType = response.headers["content-type"];

            // Si el backend devuelve JSON de error, aunque responseType sea blob,
            // hay que convertirlo a texto y luego a JSON.
            if (contentType?.includes("application/json")) {
                const text = await response.data.text();
                const data = JSON.parse(text);

                if (!data.success) {
                    openModal({
                        title: data.title || "Error",
                        message: data.message || "No se pudo generar el reporte final.",
                    });

                    return;
                }
            }

            // Si llegó aquí, asumimos que el backend devolvió el Excel
            const blob = new Blob([response.data], {
                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            });

            const url = window.URL.createObjectURL(blob);

            const link = document.createElement("a");
            link.href = url;
            link.setAttribute("download", "inventario-fisico.xlsx");
            document.body.appendChild(link);
            link.click();

            link.remove();
            window.URL.revokeObjectURL(url);

            console.log("✅ Reporte final descargado correctamente");
        } catch (error) {
            console.error("❌ Error generando reporte final:", error);

            openModal({
                title: "Error generando reporte",
                message: "No se pudo generar el reporte final del inventario.",
            });
        }
    }

    //REPORTE DE INVENTARIO POR UBICACIONES
    async function handleReporteInventarioFisicoUbicacion() {
        console.log("📍 Ejecutando Reporte del Inventario Físico con Ubicación");

        try {
            const response = await apiClient.get(
                "/inventory/report/locations",
                {
                    responseType: "blob",
                }
            );

            const contentType =
                response.headers["content-type"];

            // El backend puede devolver JSON si ocurre una validación
            if (contentType?.includes("application/json")) {
                const text = await response.data.text();
                const data = JSON.parse(text);

                openModal({
                    title: data.title || "Error",
                    message:
                        data.message ||
                        "No se pudo generar el reporte.",
                });

                return;
            }

            const blob = new Blob([response.data], {
                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            });

            const url =
                window.URL.createObjectURL(blob);

            const link =
                document.createElement("a");

            link.href = url;
            link.download =
                "inventario-fisico-ubicaciones.xlsx";

            document.body.appendChild(link);
            link.click();
            link.remove();

            window.URL.revokeObjectURL(url);

            console.log(
                "✅ Reporte de ubicaciones descargado"
            );
        } catch (error) {
            console.error(
                "❌ Error descargando reporte:",
                error
            );

            openModal({
                title: "Error generando reporte",
                message:
                    "No se pudo descargar el reporte de inventario con ubicaciones.",
            });
        }
    }

    //APLICAR AJUSTE DE INVENTARIO
    const handleApplyInventory =
        async () => {

            try {

                setAdjustmentStarting(
                    true
                );


                const response =
                    await apiClient.post(
                        "/inventory/start-adjustment"
                    );


                console.log(
                    "🟨 RESPUESTA APPLY INVENTORY:",
                    response.data
                );


                if (
                    !response.data.success
                ) {

                    openModal({

                        title:
                            response.data.title ||
                            "Error",

                        message:
                            response.data.message ||
                            "No se pudo iniciar el ajuste."
                    });


                    return;

                }


                const job =
                    response.data.data;


                const jobId =
                    Number(
                        job.jobId
                    );


                if (
                    !Number.isInteger(jobId) ||
                    jobId <= 0
                ) {

                    throw new Error(
                        "El backend no devolvió un jobId válido."
                    );

                }


                console.log(
                    "🆔 JOB RECIBIDO:",
                    jobId
                );


                // ==========================================
                // GUARDAR JOB ID
                // ==========================================

                setAdjustmentJobId(
                    jobId
                );


                // ==========================================
                // CREAR ESTADO INICIAL
                // ==========================================

                const totalProducts =
                    Number(
                        job.totalProducts
                    ) || 0;


                const processedProducts =
                    Number(
                        job.processedProducts
                    ) || 0;


                setAdjustmentProgress({

                    jobId,

                    sessionId:
                        job.sessionId
                            ? Number(job.sessionId)
                            : undefined,

                    status:
                        job.status ||
                        "pending",

                    phase:
                        "starting",

                    totalProducts,

                    processedProducts,

                    successfulProducts:
                        Number(
                            job.successfulProducts
                        ) || 0,

                    failedProducts:
                        Number(
                            job.failedProducts
                        ) || 0,

                    percentage:
                        totalProducts > 0
                            ? Math.round(
                                (
                                    processedProducts /
                                    totalProducts
                                ) * 100
                            )
                            : 0,

                    currentLineId:
                        job.currentLineId ??
                        null,

                    errorMessage:
                        job.errorMessage ??
                        null,

                    message:
                        "Preparando ajuste de inventario..."

                });


            } catch (error) {

                console.error(
                    "❌ ERROR APPLY INVENTORY:",
                    error
                );


                openModal({
                    title:
                        "Error",

                    message:
                        "No se pudo iniciar el ajuste de inventario."
                });


            } finally {

                setAdjustmentStarting(
                    false
                );

            }

        };


    // ============================================================
    // APLICAR AJUSTE DE INVENTARIO A CERO
    // ============================================================

    async function handleApplyInventoryZero() {

        console.log(
            "📦 Ejecutando ajuste de inventario ZERO"
        );


        try {

            setZeroAdjustmentStarting(
                true
            );


            const response =
                await apiClient.post(
                    "/inventory/start-adjustment-zero"
                );


            const data =
                response.data;


            console.log(
                "📦 RESPUESTA ZERO:",
                data
            );


            // =====================================================
            // ERROR DEL BACKEND
            // =====================================================

            if (!data.success) {

                openModal({
                    title:
                        data.title ||
                        "Error",

                    message:
                        data.message ||
                        "No se pudo iniciar el ajuste de inventario."
                });


                return;

            }


            // =====================================================
            // OBTENER JOB
            // =====================================================

            const job =
                data.data;


            const jobId =
                Number(
                    job.jobId
                );


            if (
                !Number.isInteger(jobId) ||
                jobId <= 0
            ) {

                throw new Error(
                    "El backend no devolvió un jobId válido."
                );

            }


            console.log(
                "🆔 ZERO JOB RECIBIDO:",
                jobId
            );


            // =====================================================
            // GUARDAR JOB ID
            // =====================================================

            setZeroAdjustmentJobId(
                jobId
            );


            // =====================================================
            // CREAR PROGRESO INICIAL
            // =====================================================

            const totalProducts =
                Number(
                    job.totalProducts
                ) || 0;


            const processedProducts =
                Number(
                    job.processedProducts
                ) || 0;


            const successfulProducts =
                Number(
                    job.successfulProducts
                ) || 0;


            const failedProducts =
                Number(
                    job.failedProducts
                ) || 0;


            setZeroAdjustmentProgress({

                jobId,

                sessionId:
                    job.sessionId
                        ? Number(job.sessionId)
                        : undefined,

                status:
                    job.status ||
                    "pending",

                phase:
                    "starting",

                totalProducts,

                processedProducts,

                successfulProducts,

                failedProducts,

                percentage:
                    totalProducts > 0
                        ? Math.round(
                            (
                                processedProducts /
                                totalProducts
                            ) * 100
                        )
                        : 0,

                currentLineId:
                    job.currentLineId ??
                    null,

                errorMessage:
                    job.errorMessage ??
                    null,

                message:
                    "Preparando productos para ajustar a cero..."

            });


        } catch (error: any) {

            console.error(
                "❌ Error iniciando ajuste ZERO:",
                error
            );


            openModal({
                title:
                    "Error aplicando inventario",

                message:
                    error?.response?.data?.message ||
                    "No se pudo iniciar el ajuste de inventario."
            });


        } finally {

            setZeroAdjustmentStarting(
                false
            );

        }

    }

    function handleReporteAuditoria() {
        console.log("🧾 Ejecutando Reporte de Auditoría");

        // Aquí luego puedes llamar tu API
        // apiClient.get("/inventory/report/audit")
    }

    function handleReportClick(reportId: number) {
        if (reportId === 1) {
            handleReporteFinalInventario();
            return;
        }

        if (reportId === 2) {
            handleReporteInventarioFisicoUbicacion();
            return;
        }

        if (reportId === 3) {
            handleReporteAuditoria();
            return;
        }

        console.log("⚠️ Reporte no reconocido:", reportId);
    }

    //FUNCION PARA ABRIR EL MODAL
    function openConfirmation({
        title,
        message,
        confirmText,
        action
    }: {
        title: string;
        message: string;
        confirmText: string;
        action: () => Promise<void>;
    }) {

        setConfirmationTitle(title);

        setConfirmationMessage(message);

        setConfirmationText(confirmText);

        // IMPORTANTE:
        // guardamos una función dentro del state
        setConfirmationAction(
            () => action
        );

        setShowConfirmation(true);
    }


    return (
        <div className="inventory-report-container">
            {/* 1. TITLE */}
            <div className="inventory-report-title">
                <div className="inventory-report-title-content">
                    <div className="inventory-report-title-icon">
                        <ClipboardCheck size={34} />
                    </div>

                    <div className="inventory-report-title-text">
                        Reportes de Inventario
                    </div>
                </div>
            </div>

            {adjustmentProgress && (

                <div className="inventory-adjustment-progress-card">

                    {/* HEADER */}
                    <div className="inventory-adjustment-progress-header">

                        <div className="inventory-adjustment-progress-title-group">

                            <div className="inventory-adjustment-progress-icon">
                                ⚙️
                            </div>

                            <div>
                                <h3>
                                    Ajuste de Inventario
                                </h3>

                                <span>
                                    Job #{adjustmentProgress.jobId}
                                </span>
                            </div>

                        </div>


                        <div
                            className={`
          inventory-adjustment-status
          status-${adjustmentProgress.status}
        `}
                        >
                            {adjustmentProgress.status}
                        </div>

                    </div>


                    {/* PROGRESO */}
                    <div className="inventory-adjustment-progress-section">

                        <div className="inventory-adjustment-progress-labels">

                            <span>
                                Progreso del ajuste
                            </span>

                            <strong>
                                {adjustmentProgress.percentage}%
                            </strong>

                        </div>


                        <div className="inventory-adjustment-progress-track">

                            <div
                                className="inventory-adjustment-progress-fill"
                                style={{
                                    width:
                                        `${adjustmentProgress.percentage}%`
                                }}
                            />

                        </div>

                    </div>


                    {/* STATS */}
                    <div className="inventory-adjustment-progress-stats">

                        <div className="inventory-adjustment-stat">

                            <span className="inventory-adjustment-stat-label">
                                Procesados
                            </span>

                            <strong>
                                {adjustmentProgress.processedProducts}
                            </strong>

                        </div>


                        <div className="inventory-adjustment-stat">

                            <span className="inventory-adjustment-stat-label">
                                Total
                            </span>

                            <strong>
                                {adjustmentProgress.totalProducts}
                            </strong>

                        </div>


                        <div className="inventory-adjustment-stat">

                            <span className="inventory-adjustment-stat-label">
                                Correctos
                            </span>

                            <strong>
                                {adjustmentProgress.successfulProducts}
                            </strong>

                        </div>


                        <div className="inventory-adjustment-stat">

                            <span className="inventory-adjustment-stat-label">
                                Errores
                            </span>

                            <strong>
                                {adjustmentProgress.failedProducts}
                            </strong>

                        </div>

                    </div>


                    {/* PRODUCTO ACTUAL */}
                    {adjustmentProgress.currentProduct && (

                        <div className="inventory-adjustment-current">

                            <div className="inventory-adjustment-current-label">
                                Producto actual
                            </div>

                            <div className="inventory-adjustment-current-info">

                                <span>
                                    ERP ID:
                                    {" "}
                                    <strong>
                                        {
                                            adjustmentProgress
                                                .currentProduct
                                                .erpProductId
                                        }
                                    </strong>
                                </span>


                                {
                                    adjustmentProgress
                                        .currentProduct
                                        .citrusQtyBefore !== undefined && (

                                        <span>
                                            Citrus:
                                            {" "}
                                            <strong>
                                                {
                                                    adjustmentProgress
                                                        .currentProduct
                                                        .citrusQtyBefore
                                                }
                                            </strong>
                                        </span>

                                    )
                                }


                                {
                                    adjustmentProgress
                                        .currentProduct
                                        .desiredQty !== undefined && (

                                        <span>
                                            Físico:
                                            {" "}
                                            <strong>
                                                {
                                                    adjustmentProgress
                                                        .currentProduct
                                                        .desiredQty
                                                }
                                            </strong>
                                        </span>

                                    )
                                }

                            </div>

                        </div>

                    )}


                    {/* MENSAJE */}
                    <div className="inventory-adjustment-progress-message">

                        <div className="inventory-adjustment-progress-message-dot" />

                        <span>
                            {
                                adjustmentProgress.message ||
                                "Procesando inventario..."
                            }
                        </span>

                    </div>

                </div>

            )}


            {zeroAdjustmentProgress && (

                <div className="inventory-adjustment-progress-card">

                    {/* HEADER */}
                    <div className="inventory-adjustment-progress-header">

                        <div className="inventory-adjustment-progress-title-group">

                            <div className="inventory-adjustment-progress-icon">
                                0
                            </div>

                            <div>

                                <h3>
                                    Ajuste de Productos No Contados
                                </h3>

                                <span>
                                    Job #{zeroAdjustmentProgress.jobId}
                                </span>

                            </div>

                        </div>


                        <div
                            className={`
                    inventory-adjustment-status
                    status-${zeroAdjustmentProgress.status}
                `}
                        >
                            {zeroAdjustmentProgress.status}
                        </div>

                    </div>


                    {/* PROGRESS */}
                    <div className="inventory-adjustment-progress-section">

                        <div className="inventory-adjustment-progress-labels">

                            <span>
                                Ajustando existencias a cero
                            </span>

                            <strong>
                                {zeroAdjustmentProgress.percentage}%
                            </strong>

                        </div>


                        <div className="inventory-adjustment-progress-track">

                            <div
                                className="inventory-adjustment-progress-fill"
                                style={{
                                    width:
                                        `${zeroAdjustmentProgress.percentage}%`
                                }}
                            />

                        </div>

                    </div>


                    {/* STATS */}
                    <div className="inventory-adjustment-progress-stats">

                        <div className="inventory-adjustment-stat">

                            <span className="inventory-adjustment-stat-label">
                                Procesados
                            </span>

                            <strong>
                                {
                                    zeroAdjustmentProgress
                                        .processedProducts
                                }
                            </strong>

                        </div>


                        <div className="inventory-adjustment-stat">

                            <span className="inventory-adjustment-stat-label">
                                Total
                            </span>

                            <strong>
                                {
                                    zeroAdjustmentProgress
                                        .totalProducts
                                }
                            </strong>

                        </div>


                        <div className="inventory-adjustment-stat">

                            <span className="inventory-adjustment-stat-label">
                                Correctos
                            </span>

                            <strong>
                                {
                                    zeroAdjustmentProgress
                                        .successfulProducts
                                }
                            </strong>

                        </div>


                        <div className="inventory-adjustment-stat">

                            <span className="inventory-adjustment-stat-label">
                                Errores
                            </span>

                            <strong>
                                {
                                    zeroAdjustmentProgress
                                        .failedProducts
                                }
                            </strong>

                        </div>

                    </div>


                    {/* PRODUCTO ACTUAL */}
                    {zeroAdjustmentProgress.currentProduct && (

                        <div className="inventory-adjustment-current">

                            <div className="inventory-adjustment-current-label">
                                Producto actual
                            </div>


                            <div className="inventory-adjustment-current-info">

                                <span>
                                    ERP ID:{" "}

                                    <strong>
                                        {
                                            zeroAdjustmentProgress
                                                .currentProduct
                                                .erpProductId
                                        }
                                    </strong>
                                </span>


                                {
                                    zeroAdjustmentProgress
                                        .currentProduct
                                        .citrusQtyBefore !== undefined && (

                                        <span>
                                            Existencia Citrus:{" "}

                                            <strong>
                                                {
                                                    zeroAdjustmentProgress
                                                        .currentProduct
                                                        .citrusQtyBefore
                                                }
                                            </strong>
                                        </span>

                                    )
                                }


                                {
                                    zeroAdjustmentProgress
                                        .currentProduct
                                        .desiredQty !== undefined && (

                                        <span>
                                            Nueva cantidad:{" "}

                                            <strong>
                                                {
                                                    zeroAdjustmentProgress
                                                        .currentProduct
                                                        .desiredQty
                                                }
                                            </strong>
                                        </span>

                                    )
                                }

                            </div>

                        </div>

                    )}


                    {/* MESSAGE */}
                    <div className="inventory-adjustment-progress-message">

                        <div className="inventory-adjustment-progress-message-dot" />

                        <span>
                            {
                                zeroAdjustmentProgress.message ||
                                "Procesando productos..."
                            }
                        </span>

                    </div>

                </div>

            )}


            {/* 2. CENTER */}
            <div className="inventory-report-center">
                {/* 2.1 LEFT */}
                <div className="inventory-report-center-left">
                    {reports.map((report) => (
                        <div
                            key={report.id}
                            className="inventory-report-option"
                            onMouseEnter={() => setHoveredReport(report)}
                            onMouseLeave={() => setHoveredReport(null)}
                            onClick={() => handleReportClick(report.id)}
                        >
                            <div className="inventory-report-option-icon">
                                <FileText size={34} />
                            </div>

                            <div className="inventory-report-option-text">
                                {report.title}
                            </div>
                        </div>
                    ))}
                </div>

                {/* 2.2 RIGHT */}
                <div className="inventory-report-center-right">
                    <div className="inventory-report-description-box">
                        <div className="inventory-report-description-icon">
                            <Info size={34} />
                        </div>

                        <div className="inventory-report-description-text">
                            {hoveredReport
                                ? hoveredReport.description
                                : "Pasa el mouse sobre un reporte para ver una explicación breve de su contenido y su función dentro del inventario."}
                        </div>
                    </div>
                </div>
            </div>



            {/* 3. BUTTON */}
            <div className="inventory-report-button">
                <div
    className={`
        inventory-report-button-action
        zero-adjustment
        ${zeroAdjustmentStarting ? "disabled" : ""}
    `}

    onClick={() => {

        if (zeroAdjustmentStarting) {
            return;
        }

        openConfirmation({
            title:
                "Aplicar inventario en cero",

            message:
                "¿Está seguro de que desea llevar a cero (0.000) en Citrus todos los productos que no fueron contados durante el inventario físico?",

            confirmText:
                "Aplicar en CERO",

            action:
                handleApplyInventoryZero
        });

    }}
>
    <CheckSquare size={24} />

    <span>
        {
            zeroAdjustmentStarting
                ? "Iniciando ajuste a CERO..."
                : "Aplicar Inventario en CERO (0.000)"
        }
    </span>
</div>
                
                
                <div
    className={`
        inventory-report-button-action
        ${adjustmentStarting ? "disabled" : ""}
    `}

    onClick={() => {

        if (adjustmentStarting) {
            return;
        }

        openConfirmation({
            title:
                "Aplicar inventario contado",

            message:
                "¿Está seguro de que desea aplicar en Citrus las cantidades físicas contadas durante este inventario?",

            confirmText:
                "Aplicar CONTADO",

            action:
                handleApplyInventory
        });

    }}
>
    <CheckSquare size={24} />

    <span>
        {
            adjustmentStarting
                ? "Iniciando ajuste..."
                : "Aplicar Inventario CONTADO"
        }
    </span>
</div>
            </div>



            <ConfirmationModal

                isOpen={
                    showConfirmation
                }

                title={
                    confirmationTitle
                }

                message={
                    confirmationMessage
                }

                confirmText={
                    confirmationText
                }

                cancelText="Cancelar"

                loading={
                    confirmationLoading
                }

                onClose={() => {

                    if (confirmationLoading) {
                        return;
                    }

                    setShowConfirmation(false);

                    setConfirmationAction(null);
                }}

                onConfirm={async () => {

                    if (!confirmationAction) {
                        return;
                    }

                    try {

                        setConfirmationLoading(true);

                        await confirmationAction();

                        setShowConfirmation(false);

                        setConfirmationAction(null);

                    } finally {

                        setConfirmationLoading(false);

                    }

                }}

            />


        </div>
    );
}