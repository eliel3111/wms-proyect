import {
    ClipboardCheck,
    FileText,
    Info,
    CheckSquare,
} from "lucide-react";
import { useState } from "react";
import { useModal } from "../context/ModalContext";
import "../styles/InventoryReport.css";
import apiClient from "../services/apiClient";
import ConfirmationModal from "../components/ConfirmationModal";
interface ReportOption {
    id: number;
    title: string;
    description: string;
}

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
    async function handleApplyInventory() {
        console.log("📦 Ejecutando ajuste de inventario");

        try {
            const response = await apiClient.post(
                "/inventory/start-adjustment"
            );

            const data = response.data;

            if (!data.success) {
                openModal({
                    title: data.title || "Error",
                    message:
                        data.message ||
                        "No se pudo iniciar el ajuste de inventario.",
                });

                return;
            }

            console.log(
                "✅ Ajuste de inventario iniciado:",
                data
            );

            openModal({
                title: "Ajuste iniciado",
                message:
                    data.message ||
                    "El ajuste de inventario fue iniciado correctamente.",
            });

        } catch (error: any) {
            console.error(
                "❌ Error iniciando ajuste de inventario:",
                error
            );

            openModal({
                title: "Error aplicando inventario",
                message:
                    error?.response?.data?.message ||
                    "No se pudo iniciar el ajuste de inventario.",
            });
        }
    }


    //APLICAR AJUSTE DE INVENTARIO
    async function handleApplyInventoryZero() {
        console.log("📦 Ejecutando ajuste de inventario");

        try {
            const response = await apiClient.post(
                "/inventory/start-adjustment-zero"
            );

            const data = response.data;

            if (!data.success) {
                openModal({
                    title: data.title || "Error",
                    message:
                        data.message ||
                        "No se pudo iniciar el ajuste de inventario.",
                });

                return;
            }

            console.log(
                "✅ Ajuste de inventario iniciado:",
                data
            );

            openModal({
                title: "Ajuste iniciado",
                message:
                    data.message ||
                    "El ajuste de inventario fue iniciado correctamente.",
            });

        } catch (error: any) {
            console.error(
                "❌ Error iniciando ajuste de inventario:",
                error
            );

            openModal({
                title: "Error aplicando inventario",
                message:
                    error?.response?.data?.message ||
                    "No se pudo iniciar el ajuste de inventario.",
            });
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
                    className="inventory-report-button-action zero-adjustment"

                    onClick={() =>
                        openConfirmation({
                            title: "Aplicar inventario en cero",

                            message:
                                "¿Está seguro de que desea llevar a cero (0.000) en Citrus todos los productos que no fueron contados durante el inventario físico?",

                            confirmText:
                                "Aplicar en CERO",

                            action:
                                handleApplyInventoryZero
                        })
                    }
                >
                    <CheckSquare size={24} />

                    <span>
                        Aplicar Inventario en CERO (0.000)
                    </span>
                </div>
                <div
                    className="inventory-report-button-action"

                    onClick={() =>
                        openConfirmation({
                            title: "Aplicar inventario contado",

                            message:
                                "¿Está seguro de que desea aplicar en Citrus las cantidades físicas contadas durante este inventario?",

                            confirmText:
                                "Aplicar CONTADO",

                            action:
                                handleApplyInventory
                        })
                    }
                >
                    <CheckSquare size={24} />

                    <span>
                        Aplicar Inventario CONTADO
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