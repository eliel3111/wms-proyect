import {
    ClipboardCheck,
    FileText,
    Info,
    CheckSquare,
} from "lucide-react";
import {  useState } from "react";
import { useModal } from "../context/ModalContext";
import "../styles/InventoryReport.css";
import apiClient from "../services/apiClient";

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

    function handleReporteInventarioFisicoUbicacion() {
        console.log("📍 Ejecutando Reporte del Inventario Físico con Ubicación");

        // Aquí luego puedes llamar tu API
        // apiClient.get("/inventory/report/by-location")
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
                <div className="inventory-report-button-action">
                    <CheckSquare size={24} />
                    <span>Aplicar Inventario</span>
                </div>
            </div>
        </div>
    );
}