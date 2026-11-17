
import {
    ArrowLeft,
    CheckCircle2,
    ClipboardCheck,
    Clock3,
    Package,
    ScanLine,
    XCircle
} from "lucide-react";

import {
    useCallback,
    useEffect,
    useRef,
    useState
} from "react";

import {
    useLocation,
    useNavigate,
    useParams
} from "react-router-dom";

import apiClient from "../services/apiClient";
import ScanModal from "../components/ScanModal.tsx";
import { useModal } from "../context/ModalContext";

import "../styles/InspectionDocumentPage.css";


// ============================================================
// 1. TIPOS
// ============================================================

type InspectionStatus =
    | "PENDIENTE"
    | "APROBADO"
    | "RECHAZADO";

type InspectionDocumentType =
    | "CONDUCE"
    | "FACTURA";

type QuantityVisualState =
    | "neutral"
    | "complete"
    | "mismatch";

interface SelectedInspectionDocument {
    id?: string | number;
    erp_id: string | number;
    tipo: InspectionDocumentType;
    numero: string;
    fecha: string | null;
    cliente: string;
    ubicacion: string;
    erp_referencia: string;
    inspeccion_status: InspectionStatus;
}

interface InspectionLocationState {
    guid?: string;
    tipo?: InspectionDocumentType;
    document?: SelectedInspectionDocument;
}

interface InspectionLine {
    id: string;
    erp_line_id: string;
    erp_item_id: string;
    sku: string;
    description: string;
    quantity: number;
    completed_quantity: number;
    inspected_quantity: number;
    inspection_status: InspectionStatus;
    erp_uom_name: string | null;
    erp_row_order: number | null;
}


// ============================================================
// 2. RESPUESTAS DEL BACKEND
// ============================================================

interface InspectionLinesResponse {
    success: boolean;
    message?: string;
    document?: Partial<SelectedInspectionDocument>;
    lines: InspectionLine[];
}

interface ScanLookupResponse {
    success: boolean;
    code?: string;
    message?: string;
    source?: string;

    data?: {
        id: string;
        sku: string;
        erp_sku: string;
        erp_name: string | null;
        description: string | null;
    };
}

interface InspectionStatusSummary {
    inspection_status: InspectionStatus;
    total_lines: number;
    zero_lines: number;
    matching_lines: number;
    difference_lines: number;
}

interface SaveInspectionLineResponse {
    success: boolean;
    message?: string;
    line?: InspectionLine;
    inspection_status?: InspectionStatus;
    inspection_summary?: InspectionStatusSummary;
}


// ============================================================
// 3. CONSTANTES Y HELPERS
// ============================================================

const UUID_PATTERN =
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const SCANNER_GAP_MS = 300;


// ============================================================
// NORMALIZAR CÓDIGO
// ============================================================

function normalizeCode(raw: unknown): string {
    return String(raw ?? "")
        .replace(/[\r\n]/g, "")
        .trim()
        .toUpperCase();
}


// ============================================================
// COMPARAR CANTIDADES
// ============================================================

function quantitiesMatch(
    inspected: number | string | null | undefined,
    document: number | string | null | undefined
): boolean {

    if (
        inspected === null ||
        inspected === undefined ||
        inspected === "" ||
        document === null ||
        document === undefined ||
        document === ""
    ) {
        return false;
    }

    const inspectedQty = Number(inspected);
    const documentQty = Number(document);

    return (
        Number.isFinite(inspectedQty) &&
        Number.isFinite(documentQty) &&
        inspectedQty === documentQty
    );
}


// ============================================================
// 4. ESTADO VISUAL DE CANTIDAD INSPECCIONADA
//
// NEUTRAL:
// inspected_quantity = 0, NULL O VACÍO.
//
// COMPLETE:
// inspected_quantity > 0 Y COINCIDE.
//
// MISMATCH:
// inspected_quantity > 0 Y NO COINCIDE.
//
// ESTA FUNCIÓN NO MODIFICA EL ESTADO DEL DOCUMENTO.
// SOLO CONTROLA LOS COLORES DE LA INTERFAZ.
// ============================================================

function getQuantityVisualState(
    inspected: number | string | null | undefined,
    document: number | string | null | undefined
): QuantityVisualState {

    if (
        inspected === null ||
        inspected === undefined ||
        String(inspected).trim() === ""
    ) {
        return "neutral";
    }

    const inspectedQty = Number(inspected);

    // CERO NO TIENE FONDO NI ICONO.
    if (
        !Number.isFinite(inspectedQty) ||
        inspectedQty === 0
    ) {
        return "neutral";
    }

    return quantitiesMatch(inspected, document)
        ? "complete"
        : "mismatch";
}


// ============================================================
// FORMATEAR ESTADO
// ============================================================

function formatStatus(status: InspectionStatus): string {
    return (
        status.charAt(0) +
        status.slice(1).toLowerCase()
    );
}


// ============================================================
// ICONO DEL ESTADO GLOBAL
// ============================================================

function getStatusIcon(status: InspectionStatus) {

    if (status === "APROBADO") {
        return (
            <CheckCircle2
                size={14}
                strokeWidth={2.4}
            />
        );
    }

    if (status === "RECHAZADO") {
        return (
            <XCircle
                size={14}
                strokeWidth={2.4}
            />
        );
    }

    return (
        <Clock3
            size={14}
            strokeWidth={2.4}
        />
    );
}


// ============================================================
// 5. COMPONENTE PRINCIPAL
// ============================================================

export default function InspectionDocumentPage() {

    // ========================================================
    // ROUTER
    // ========================================================

    const navigate = useNavigate();
    const location = useLocation();
    const { openModal } = useModal();

    const {
        tipo: routeTipo,
        erpId: routeErpId
    } = useParams<{
        tipo: string;
        erpId: string;
    }>();

    const navigationState =
        location.state as InspectionLocationState | null;

    const selectedDocument =
        navigationState?.document;

    const documentGuid = String(
        routeErpId ??
        navigationState?.guid ??
        selectedDocument?.erp_id ??
        ""
    ).trim();

    const documentType = String(
        routeTipo ??
        navigationState?.tipo ??
        selectedDocument?.tipo ??
        ""
    )
        .trim()
        .toUpperCase() as InspectionDocumentType;


    // ========================================================
    // 6. ESTADOS DEL DOCUMENTO
    // ========================================================

    const [
        inspectionLines,
        setInspectionLines
    ] = useState<InspectionLine[]>([]);

    const [
        fetchedDocument,
        setFetchedDocument
    ] = useState<
        Partial<SelectedInspectionDocument> | null
    >(null);

    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [retryKey, setRetryKey] = useState(0);


    // ========================================================
    // 7. ESTADOS DEL MODAL
    // ========================================================

    const [
        selectedLine,
        setSelectedLine
    ] = useState<InspectionLine | null>(null);

    const [isScanModalOpen, setIsScanModalOpen] = useState(false);
    const [productConfirmed, setProductConfirmed] = useState(false);
    const [confirmedErpSku, setConfirmedErpSku] = useState("");
    const [manualCode, setManualCode] = useState("");
    const [qty, setQty] = useState("");
    const [scanError, setScanError] = useState<string | null>(null);
    const [isScanning, setIsScanning] = useState(false);
    const [isSaving, setIsSaving] = useState(false);


    // ========================================================
    // 8. REFERENCIAS DEL SCANNER
    // ========================================================

    const scanBufferRef = useRef("");
    const lastScannerKeyTimeRef = useRef(0);
    const scanRequestBusyRef = useRef(false);

    const qtyInputRef =
        useRef<HTMLInputElement | null>(null);

    const productInputRef =
        useRef<HTMLInputElement | null>(null);


    // ========================================================
    // LIMPIAR BUFFER
    // ========================================================

    const resetScannerBuffer = useCallback(() => {

        scanBufferRef.current = "";
        lastScannerKeyTimeRef.current = 0;

    }, []);


    // ========================================================
    // MODAL GLOBAL DE ERROR
    // ========================================================

    const showRedError = useCallback((
        message: string,
        title = "❌ ERROR EN LA OPERACIÓN"
    ) => {

        openModal({
            title,
            message,
            buttonText: "Entendido",
            titleColor: "red"
        });

    }, [openModal]);


    // ========================================================
    // 9. SINCRONIZAR DOCUMENTO DESDE ADM CLOUD
    //
    // POST /inspection/:tipo/:guid/lines/sync
    // ========================================================

    useEffect(() => {

        const controller = new AbortController();
        let cancelled = false;

        async function fetchDocumentLines() {

            setIsLoading(true);
            setLoadError(null);
            setInspectionLines([]);
            setFetchedDocument(null);
            setIsScanModalOpen(false);
            setSelectedLine(null);

            resetScannerBuffer();

            // =================================================
            // VALIDAR DOCUMENTO
            // =================================================

            if (!UUID_PATTERN.test(documentGuid)) {

                setLoadError(
                    "El GUID del documento no es válido."
                );

                setIsLoading(false);
                return;
            }

            if (
                documentType !== "CONDUCE" &&
                documentType !== "FACTURA"
            ) {

                setLoadError(
                    "El tipo debe ser CONDUCE o FACTURA."
                );

                setIsLoading(false);
                return;
            }

            try {

                const url =
                    `/inspection/${documentType.toLowerCase()}` +
                    `/${documentGuid}/lines/sync`;

                console.log(
                    "🟪 SINCRONIZANDO INSPECCIÓN:",
                    url
                );

                // =============================================
                // CONSULTAR BACKEND
                // =============================================

                const response =
                    await apiClient.post<InspectionLinesResponse>(
                        url,
                        {},
                        {
                            signal: controller.signal
                        }
                    );

                if (cancelled) return;

                // =============================================
                // VALIDAR RESPUESTA
                // =============================================

                if (
                    !response.data.success ||
                    !Array.isArray(response.data.lines)
                ) {

                    throw new Error(
                        response.data.message ||
                        "Respuesta inválida del backend."
                    );
                }

                // =============================================
                // GUARDAR LÍNEAS Y DOCUMENTO
                // =============================================

                setInspectionLines(
                    response.data.lines
                );

                setFetchedDocument(
                    response.data.document ?? null
                );

                console.log(
                    "✅ PRODUCTOS SINCRONIZADOS:",
                    response.data.lines
                );

                console.log(
                    "🏷️ ESTADO DEL DOCUMENTO:",
                    response.data.document?.inspeccion_status
                );

            } catch (error: unknown) {

                if (cancelled) return;

                const err = error as {
                    code?: string;
                    message?: string;
                    response?: {
                        data?: {
                            message?: string;
                        };
                    };
                };

                if (err.code !== "ERR_CANCELED") {

                    setLoadError(
                        err.response?.data?.message ??
                        err.message ??
                        "No se pudieron cargar los productos."
                    );
                }

            } finally {

                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        }

        void fetchDocumentLines();

        return () => {
            cancelled = true;
            controller.abort();
        };

    }, [
        documentGuid,
        documentType,
        retryKey,
        resetScannerBuffer
    ]);


    // ========================================================
    // 10. ABRIR MODAL DE INSPECCIÓN
    // ========================================================

    const openLineModal = useCallback((
        line: InspectionLine,
        verifiedErpSku = ""
    ) => {

        setSelectedLine(line);
        setIsScanModalOpen(true);

        setProductConfirmed(
            Boolean(verifiedErpSku)
        );

        setConfirmedErpSku(verifiedErpSku);
        setManualCode("");

        // CARGAR CANTIDAD ACTUAL.
        setQty(
            String(line.inspected_quantity ?? 0)
        );

        setScanError(null);
        resetScannerBuffer();

        console.log(
            "📦 ABRIENDO MODAL DE INSPECCIÓN:",
            line
        );

    }, [resetScannerBuffer]);


    // ========================================================
    // 11. CERRAR MODAL
    // ========================================================

    function closeScanModal() {

        if (isSaving || isScanning) return;

        setIsScanModalOpen(false);
        setSelectedLine(null);
        setProductConfirmed(false);
        setConfirmedErpSku("");
        setManualCode("");
        setQty("");
        setScanError(null);

        resetScannerBuffer();
    }


    // ========================================================
    // 12. PROCESAR CÓDIGO ESCANEADO
    //
    // products.sku / product_barcodes.barcode
    //             ↓
    // products.erp_sku
    //             ↓
    // InspectionLine.sku
    // ========================================================

    const handleScannedCode = useCallback(async (
        rawCode: string
    ) => {

        const scannedCode = normalizeCode(rawCode);

        if (
            !scannedCode ||
            scanRequestBusyRef.current ||
            isSaving
        ) {
            return;
        }

        scanRequestBusyRef.current = true;
        setIsScanning(true);
        setScanError(null);
        resetScannerBuffer();

        try {

            console.log(
                "📡 CÓDIGO ESCANEADO:",
                scannedCode
            );

            // ================================================
            // BUSCAR PRODUCTO EN EL BACKEND
            // ================================================

            const response =
                await apiClient.post<ScanLookupResponse>(
                    "/inspection/scan",
                    {
                        code: scannedCode
                    }
                );

            const result = response.data;

            if (
                !result.success ||
                !result.data?.erp_sku
            ) {

                setProductConfirmed(false);
                setConfirmedErpSku("");

                showRedError(
                    result.message ||
                    `No se encontró ningún producto para ${scannedCode}.`
                );

                return;
            }

            // ================================================
            // OBTENER ERP SKU
            // ================================================

            const resolvedErpSku =
                normalizeCode(
                    result.data.erp_sku
                );

            console.log(
                "✅ PRODUCTO RESUELTO:",
                {
                    scannedCode,
                    productSku: result.data.sku,
                    erpSku: resolvedErpSku,
                    source: result.source
                }
            );

            // ================================================
            // BUSCAR EN LAS LÍNEAS DEL DOCUMENTO
            // ================================================

            const matches =
                inspectionLines.filter(
                    line =>
                        normalizeCode(line.sku) ===
                        resolvedErpSku
                );

            if (matches.length === 0) {

                setProductConfirmed(false);
                setConfirmedErpSku("");

                showRedError(
                    `Se encontró el producto ${result.data.sku} ` +
                    `(${resolvedErpSku}), pero no existe ` +
                    "en las líneas de este documento."
                );

                return;
            }

            // ================================================
            // SI EL MODAL ESTÁ ABIERTO, VALIDAR LA LÍNEA
            // ================================================

            if (
                isScanModalOpen &&
                selectedLine
            ) {

                const correctLine =
                    matches.find(
                        line =>
                            String(line.id) ===
                            String(selectedLine.id)
                    );

                if (!correctLine) {

                    setProductConfirmed(false);
                    setConfirmedErpSku("");

                    showRedError(
                        `El producto ${resolvedErpSku} ` +
                        "no corresponde a la línea seleccionada " +
                        `(${selectedLine.sku}).`
                    );

                    return;
                }

                // PRODUCTO CONFIRMADO.
                setProductConfirmed(true);
                setConfirmedErpSku(resolvedErpSku);
                setManualCode("");
                setScanError(null);

                console.log(
                    "🟩 PRODUCTO CONFIRMADO:",
                    resolvedErpSku
                );

                return;
            }

            // ================================================
            // PRODUCTOS REPETIDOS
            // ================================================

            if (matches.length > 1) {

                showRedError(
                    `El producto ${resolvedErpSku} ` +
                    `aparece en ${matches.length} líneas. ` +
                    "Seleccione la línea correspondiente " +
                    "y escanee de nuevo.",
                    "⚠️ PRODUCTO REPETIDO"
                );

                return;
            }

            openLineModal(
                matches[0],
                resolvedErpSku
            );

        } catch (error: unknown) {

            const err = error as {
                message?: string;
                response?: {
                    data?: {
                        message?: string;
                    };
                };
            };

            console.error(
                "❌ ERROR DE ESCÁNER:",
                error
            );

            setProductConfirmed(false);
            setConfirmedErpSku("");

            showRedError(
                err.response?.data?.message ??
                err.message ??
                "No se pudo completar la operación. Inténtalo nuevamente."
            );

        } finally {

            scanRequestBusyRef.current = false;
            setIsScanning(false);
        }

    }, [
        inspectionLines,
        isScanModalOpen,
        selectedLine,
        isSaving,
        openLineModal,
        showRedError,
        resetScannerBuffer
    ]);


    // ========================================================
    // 13. DETECTAR SCANNER HID / PDA
    //
    // FINALIZA CON ENTER O TAB.
    // ========================================================

    useEffect(() => {

        if (isLoading || loadError) return;

        const handleKeyDown = (
            event: KeyboardEvent
        ) => {

            if (
                event.ctrlKey ||
                event.altKey ||
                event.metaKey ||
                event.isComposing
            ) {
                return;
            }

            const target =
                event.target as HTMLElement | null;

            // NO INTERFERIR CON INPUTS.
            const editing = Boolean(
                target?.closest(
                    'input, textarea, select, [contenteditable="true"], [role="textbox"]'
                )
            );

            if (editing) {
                resetScannerBuffer();
                return;
            }

            // ================================================
            // FIN DEL ESCANEO
            // ================================================

            if (
                event.key === "Enter" ||
                event.key === "Tab"
            ) {

                const code = scanBufferRef.current;
                resetScannerBuffer();

                if (!code.trim()) return;

                event.preventDefault();
                void handleScannedCode(code);
                return;
            }

            // ================================================
            // ACUMULAR CARACTERES
            // ================================================

            if (event.key.length === 1) {

                const now = Date.now();

                if (
                    lastScannerKeyTimeRef.current &&
                    now - lastScannerKeyTimeRef.current >
                    SCANNER_GAP_MS
                ) {
                    scanBufferRef.current = "";
                }

                scanBufferRef.current += event.key;
                lastScannerKeyTimeRef.current = now;
            }
        };

        window.addEventListener(
            "keydown",
            handleKeyDown
        );

        return () => {
            window.removeEventListener(
                "keydown",
                handleKeyDown
            );
        };

    }, [
        isLoading,
        loadError,
        handleScannedCode,
        resetScannerBuffer
    ]);


    // ========================================================
    // 14. ENFOCAR INPUT
    // ========================================================

    useEffect(() => {

        if (!isScanModalOpen) return;

        if (productConfirmed) {
            qtyInputRef.current?.focus();
            qtyInputRef.current?.select();
        } else {
            productInputRef.current?.focus();
        }

    }, [
        isScanModalOpen,
        productConfirmed
    ]);


    // ========================================================
    // 15. GUARDAR CANTIDAD INSPECCIONADA
    //
    // PATCH /inspection/:tipo/:guid/lines/:lineId
    //
    // TAMBIÉN ACTUALIZA EL ESTADO GLOBAL.
    // ========================================================

    async function confirmInspectionLine() {

        if (isSaving || isScanning) return;

        if (
            !selectedLine ||
            !productConfirmed ||
            !confirmedErpSku
        ) {

            setScanError(
                "Primero debe escanear y confirmar el producto."
            );

            return;
        }

        const quantity = qty.trim();

        // ================================================
        // VALIDAR CANTIDAD
        // ================================================

        if (
            !/^\d+(?:\.\d{1,4})?$/.test(quantity) ||
            Number(quantity) > 99999999999999
        ) {

            setScanError(
                "La cantidad debe ser mayor o igual a 0 y tener hasta 4 decimales."
            );

            return;
        }

        setIsSaving(true);
        setScanError(null);

        try {

            const url =
                `/inspection/${documentType.toLowerCase()}` +
                `/${documentGuid}` +
                `/lines/${selectedLine.id}`;

            console.log("");
            console.log("🟪 ========================================");
            console.log("💾 GUARDANDO INSPECCIÓN");
            console.log("📄 DOCUMENTO:", documentGuid);
            console.log("📦 SKU:", confirmedErpSku);
            console.log("🔢 CANTIDAD:", quantity);
            console.log("🟪 ========================================");

            // ================================================
            // PATCH AL BACKEND
            // ================================================

            const response =
                await apiClient.patch<SaveInspectionLineResponse>(
                    url,
                    {
                        scanned_code: confirmedErpSku,
                        inspected_quantity: quantity
                    }
                );

            if (
                !response.data.success ||
                !response.data.line
            ) {

                throw new Error(
                    response.data.message ||
                    "No se pudo guardar la inspección."
                );
            }

            // ================================================
            // ACTUALIZAR LÍNEA SIN RECARGAR
            // ================================================

            const updatedLine = response.data.line;

            setInspectionLines(previous =>
                previous.map(line =>
                    String(line.id) === String(updatedLine.id)
                        ? {
                            ...line,
                            ...updatedLine
                        }
                        : line
                )
            );

            console.log(
                "✅ CANTIDAD GUARDADA:",
                updatedLine
            );

            // ================================================
            // ACTUALIZAR ESTADO GLOBAL DEL DOCUMENTO
            // ================================================

            const newInspectionStatus =
                response.data.inspection_status ??
                response.data.inspection_summary?.inspection_status;

            if (
                newInspectionStatus === "PENDIENTE" ||
                newInspectionStatus === "APROBADO" ||
                newInspectionStatus === "RECHAZADO"
            ) {

                setFetchedDocument(previous => ({
                    ...(previous ?? {}),
                    inspeccion_status: newInspectionStatus
                }));

                console.log(
                    "🏷️ ESTADO GLOBAL ACTUALIZADO:",
                    newInspectionStatus
                );

                console.log(
                    "📊 RESUMEN:",
                    response.data.inspection_summary
                );

            } else {

                console.warn(
                    "⚠️ El backend no devolvió inspection_status."
                );
            }

            // ================================================
            // CERRAR MODAL
            // ================================================

            setIsScanModalOpen(false);
            setSelectedLine(null);
            setProductConfirmed(false);
            setConfirmedErpSku("");
            setManualCode("");
            setQty("");
            setScanError(null);

            resetScannerBuffer();

        } catch (error: unknown) {

            const err = error as {
                message?: string;
                response?: {
                    data?: {
                        message?: string;
                    };
                };
            };

            console.error(
                "❌ ERROR GUARDANDO INSPECCIÓN:",
                error
            );

            setScanError(
                err.response?.data?.message ??
                err.message ??
                "No se pudo guardar la cantidad inspeccionada."
            );

        } finally {

            setIsSaving(false);
        }
    }


    // ========================================================
    // 16. DATOS DEL ENCABEZADO
    // ========================================================

    const documentNumber =
        fetchedDocument?.numero ||
        selectedDocument?.numero ||
        (
            documentGuid
                ? `Documento ${documentGuid}`
                : "Documento"
        );

    const clientName =
        fetchedDocument?.cliente ||
        selectedDocument?.cliente ||
        "Cliente no disponible";

    const rawDate =
        fetchedDocument?.fecha ||
        selectedDocument?.fecha;

    const documentDate =
        rawDate
            ? String(rawDate).slice(0, 10)
            : "-";

    const documentLocation =
        fetchedDocument?.ubicacion ||
        selectedDocument?.ubicacion ||
        "-";

    const documentReference =
        fetchedDocument?.erp_referencia ||
        selectedDocument?.erp_referencia ||
        "-";

    const documentStatus: InspectionStatus =
        fetchedDocument?.inspeccion_status ||
        selectedDocument?.inspeccion_status ||
        "PENDIENTE";


    // ========================================================
    // 17. ESTADO VISUAL DEL MODAL
    //
    // CERO: SIN BACKGROUND.
    // IGUAL (> 0): VERDE.
    // DIFERENTE (> 0): ROJO.
    // ========================================================

    const modalQuantityState: QuantityVisualState =
        selectedLine === null
            ? "neutral"
            : getQuantityVisualState(
                qty,
                selectedLine.quantity
            );

    const modalQuantityMatches =
        modalQuantityState === "complete";

    const modalQuantityDiffers =
        modalQuantityState === "mismatch";


    // ========================================================
    // 18. PANTALLA DE CARGA
    // ========================================================

    if (isLoading) {

        return (
            <div className="inspection-document-page">

                <section
                    className="inspection-document-table-card"
                    style={{ padding: 28 }}
                >
                    <h2>
                        Cargando productos del documento...
                    </h2>

                    <p>
                        Consultando Adm Cloud y sincronizando
                        las líneas de inspección.
                    </p>
                </section>

            </div>
        );
    }


    // ========================================================
    // 19. PANTALLA DE ERROR
    // ========================================================

    if (loadError) {

        return (
            <div className="inspection-document-page">

                <section
                    className="inspection-document-table-card"
                    style={{ padding: 28 }}
                >
                    <h2>
                        No se pudo cargar la inspección
                    </h2>

                    <p role="alert">
                        {loadError}
                    </p>

                    <div
                        style={{
                            display: "flex",
                            gap: 10,
                            marginTop: 16
                        }}
                    >
                        <button
                            type="button"
                            className="inspection-document-back-button"
                            onClick={() =>
                                setRetryKey(n => n + 1)
                            }
                        >
                            Reintentar
                        </button>

                        <button
                            type="button"
                            className="inspection-document-back-button"
                            onClick={() =>
                                navigate("/inspection")
                            }
                        >
                            Volver
                        </button>
                    </div>
                </section>

            </div>
        );
    }


    // ========================================================
    // 20. JSX PRINCIPAL
    // ========================================================

    return (
        <div className="inspection-document-page">

            {/* =================================================
                HEADER DEL DOCUMENTO
            ================================================= */}

            <section className="inspection-document-toolbar">

                <div className="inspection-document-heading">

                    <div className="inspection-document-heading-icon">
                        <ClipboardCheck
                            size={27}
                            strokeWidth={2}
                        />
                    </div>

                    <div className="inspection-document-heading-content">
                        <h1 className="inspection-document-title">
                            {documentNumber}
                        </h1>

                        <p className="inspection-document-subtitle">
                            {clientName}
                        </p>
                    </div>

                </div>


                {/* =============================================
                    RESUMEN DEL DOCUMENTO
                ============================================= */}

                <div className="inspection-document-summary">

                    {/* TIPO */}

                    <div className="inspection-document-summary-item">

                        <span className="inspection-document-summary-label">
                            Tipo
                        </span>

                        <span
                            className={`
                                inspection-document-type-pill
                                inspection-document-type-${documentType.toLowerCase()}
                            `}
                        >
                            {
                                documentType === "CONDUCE"
                                    ? "Conduce"
                                    : "Factura"
                            }
                        </span>

                    </div>


                    {/* REFERENCIA */}

                    <div className="inspection-document-summary-item">

                        <span className="inspection-document-summary-label">
                            Referencia
                        </span>

                        <span className="inspection-document-summary-value inspection-document-summary-mono">
                            {documentReference}
                        </span>

                    </div>


                    {/* FECHA */}

                    <div className="inspection-document-summary-item">

                        <span className="inspection-document-summary-label">
                            Fecha
                        </span>

                        <span className="inspection-document-summary-value">
                            {documentDate}
                        </span>

                    </div>


                    {/* UBICACIÓN */}

                    <div className="inspection-document-summary-item">

                        <span className="inspection-document-summary-label">
                            Ubicación
                        </span>

                        <span className="inspection-document-summary-value">
                            {documentLocation}
                        </span>

                    </div>


                    {/* ESTADO GLOBAL */}

                    <div className="inspection-document-summary-item">

                        <span className="inspection-document-summary-label">
                            Estatus
                        </span>

                        <span
                            className={`
                                inspection-document-status-pill
                                inspection-document-status-${documentStatus.toLowerCase()}
                            `}
                        >
                            {getStatusIcon(documentStatus)}

                            <span>
                                {formatStatus(documentStatus)}
                            </span>
                        </span>

                    </div>

                </div>


                {/* =============================================
                    BOTÓN VOLVER
                ============================================= */}

                <div className="inspection-document-actions">

                    <button
                        type="button"
                        className="inspection-document-back-button"
                        onClick={() =>
                            navigate("/inspection")
                        }
                    >
                        <ArrowLeft
                            size={18}
                            strokeWidth={2.2}
                        />

                        <span>
                            Volver
                        </span>
                    </button>

                </div>

            </section>


            {/* =================================================
                21. TABLA DE PRODUCTOS
            ================================================= */}

            <section className="inspection-document-table-card">

                <div className="inspection-document-table-header">

                    <div>
                        <h2 className="inspection-document-table-title">
                            Productos
                        </h2>

                        <p className="inspection-document-table-subtitle">
                            Escanee un código WMS o un código de barras.
                            También puede seleccionar una línea.
                        </p>
                    </div>

                    <div className="inspection-document-line-count">
                        {inspectionLines.length}{" "}
                        {
                            inspectionLines.length === 1
                                ? "línea"
                                : "líneas"
                        }
                    </div>

                </div>


                <div className="inspection-document-table-container">

                    <table className="inspection-document-table">

                        <thead>
                            <tr>
                                <th>No.</th>
                                <th>Código</th>
                                <th>Descripción</th>
                                <th>Cantidad</th>
                                <th>Inspeccionada</th>
                            </tr>
                        </thead>

                        <tbody>

                            {/* SIN PRODUCTOS */}

                            {
                                inspectionLines.length === 0 && (
                                    <tr>
                                        <td
                                            colSpan={5}
                                            style={{
                                                textAlign: "center",
                                                padding: 24
                                            }}
                                        >
                                            Este documento no tiene
                                            líneas de productos.
                                        </td>
                                    </tr>
                                )
                            }


                            {/* =====================================
                                PRODUCTOS CON ESTADOS VISUALES

                                0 = NEUTRO
                                IGUAL > 0 = VERDE
                                DIFERENTE > 0 = ROJO
                            ===================================== */}

                            {
                                inspectionLines.map((line, index) => {

                                    const visualState =
                                        getQuantityVisualState(
                                            line.inspected_quantity,
                                            line.quantity
                                        );

                                    return (
                                        <tr
                                            key={line.id}

                                            className={`
                                                inspection-document-table-row
                                                inspection-document-row-${visualState}
                                            `}

                                            tabIndex={0}
                                            role="button"

                                            aria-label={
                                                `Inspeccionar producto ${line.sku}`
                                            }

                                            onClick={() =>
                                                openLineModal(line)
                                            }

                                            onKeyDown={event => {

                                                if (
                                                    (
                                                        event.key === "Enter" ||
                                                        event.key === " "
                                                    ) &&
                                                    !scanBufferRef.current.trim()
                                                ) {

                                                    event.preventDefault();
                                                    openLineModal(line);
                                                }
                                            }}
                                        >

                                            {/* NÚMERO */}

                                            <td
                                                data-label="No."
                                                className="inspection-document-line-number"
                                            >
                                                {index + 1}
                                            </td>


                                            {/* SKU */}

                                            <td
                                                data-label="Código"
                                                className="inspection-document-product-code"
                                            >
                                                <div className="inspection-document-product-code-wrapper">
                                                    <Package
                                                        size={15}
                                                        strokeWidth={2}
                                                    />

                                                    <span className="inspection-document-product-code-wrapper-sku">
                                                        {line.sku}
                                                    </span>
                                                </div>
                                            </td>


                                            {/* DESCRIPCIÓN */}

                                            <td
                                                data-label="Descripción"
                                                className="inspection-document-description"
                                            >
                                                {line.description}
                                            </td>


                                            {/* CANTIDAD DEL DOCUMENTO */}

                                            <td
                                                data-label="Cantidad"
                                                className="inspection-document-quantity"
                                            >
                                                {line.quantity}
                                            </td>


                                            {/* CANTIDAD INSPECCIONADA */}

                                            <td
                                                data-label="Inspeccionada"

                                                className={`
                                                    inspection-document-quantity
                                                    inspection-document-quantity-${visualState}
                                                `}
                                            >

                                                <span className="inspection-document-inspected-value">

                                                    {
                                                        visualState === "complete" ? (
                                                            <CheckCircle2
                                                                size={16}
                                                                strokeWidth={2.5}
                                                                aria-hidden="true"
                                                            />
                                                        ) : visualState === "mismatch" ? (
                                                            <XCircle
                                                                size={16}
                                                                strokeWidth={2.5}
                                                                aria-hidden="true"
                                                            />
                                                        ) : null
                                                    }

                                                    {line.inspected_quantity}

                                                </span>

                                            </td>

                                        </tr>
                                    );
                                })
                            }

                        </tbody>

                    </table>

                </div>

            </section>


            {/* =================================================
                22. MODAL DE INSPECCIÓN
            ================================================= */}

            <ScanModal
                open={isScanModalOpen}
                onClose={closeScanModal}
            >

                {
                    selectedLine && (

                        <div className="inspection-scan-modal">

                            {/* =================================
                                TÍTULO
                            ================================= */}

                            <div className="inspection-scan-modal-title">

                                <ScanLine size={24} />

                                <div>
                                    <h2>
                                        Confirmar inspección
                                    </h2>

                                    <p>
                                        Lea el producto y confirme
                                        la cantidad inspeccionada.
                                    </p>
                                </div>

                            </div>


                            {/* =================================
                                PANEL DE PRODUCTO
                            ================================= */}

                            <section
                                className={`
                                    inspection-scan-yellow-panel
                                    ${
                                        productConfirmed
                                            ? "inspection-scan-green-panel"
                                            : ""
                                    }
                                `}
                            >

                                <span className="inspection-scan-label">
                                    {
                                        productConfirmed
                                            ? "✅ Producto confirmado"
                                            : "📡 Lea el producto"
                                    }
                                </span>

                                <div className="inspection-scan-product-name">
                                    {selectedLine.description}
                                </div>

                                <div className="inspection-scan-product-sku">
                                    ERP SKU: {selectedLine.sku}
                                </div>

                                <div className="inspection-scan-confirm-state">
                                    {
                                        productConfirmed
                                            ? "Producto verificado correctamente"
                                            : "Pendiente de confirmar con el escáner"
                                    }
                                </div>


                                {/* INPUT DE CÓDIGO */}

                                {
                                    !productConfirmed && (

                                        <div className="inspection-scan-manual-row">

                                            <input
                                                ref={productInputRef}
                                                type="text"
                                                value={manualCode}

                                                placeholder="Escanee SKU WMS o código de barras"

                                                aria-label="Código del producto"

                                                disabled={
                                                    isSaving ||
                                                    isScanning
                                                }

                                                onChange={event =>
                                                    setManualCode(
                                                        event.target.value
                                                    )
                                                }

                                                onFocus={resetScannerBuffer}

                                                onKeyDown={event => {

                                                    if (
                                                        (
                                                            event.key === "Enter" ||
                                                            event.key === "Tab"
                                                        ) &&
                                                        event.currentTarget.value.trim()
                                                    ) {

                                                        event.preventDefault();

                                                        void handleScannedCode(
                                                            event.currentTarget.value
                                                        );
                                                    }
                                                }}
                                            />

                                            <button
                                                type="button"

                                                disabled={
                                                    isSaving ||
                                                    isScanning ||
                                                    !manualCode.trim()
                                                }

                                                onClick={() =>
                                                    void handleScannedCode(
                                                        manualCode
                                                    )
                                                }
                                            >
                                                {
                                                    isScanning
                                                        ? "Buscando..."
                                                        : "Validar"
                                                }
                                            </button>

                                        </div>

                                    )
                                }

                            </section>


                            {/* =================================
                                PANEL DE CANTIDAD

                                NEUTRO CUANDO ES CERO.
                                VERDE CUANDO COINCIDE.
                                ROJO CUANDO ES DIFERENTE.
                            ================================= */}

                            <section
                                className={`
                                    inspection-scan-yellow-panel
                                    ${
                                        modalQuantityMatches
                                            ? "inspection-scan-qty-complete"
                                            : modalQuantityDiffers
                                                ? "inspection-scan-qty-mismatch"
                                                : "inspection-scan-qty-neutral"
                                    }
                                `}
                            >

                                <span className="inspection-scan-label">

                                    {
                                        modalQuantityMatches
                                            ? "✅ Cantidad completa"
                                            : modalQuantityDiffers
                                                ? "❌ Cantidad diferente"
                                                : "🔢 Cantidad inspeccionada"
                                    }

                                </span>


                                <div className="inspection-scan-qty-row">

                                    {/* INPUT CANTIDAD */}

                                    <input
                                        ref={qtyInputRef}
                                        type="number"
                                        min="0"
                                        step="0.0001"
                                        value={qty}

                                        disabled={
                                            !productConfirmed ||
                                            isSaving ||
                                            isScanning
                                        }

                                        aria-label="Cantidad inspeccionada"

                                        onChange={event =>
                                            setQty(
                                                event.target.value
                                            )
                                        }

                                        onFocus={resetScannerBuffer}

                                        onKeyDown={event => {

                                            if (
                                                event.key === "Enter" &&
                                                productConfirmed
                                            ) {

                                                event.preventDefault();

                                                void confirmInspectionLine();
                                            }
                                        }}
                                    />


                                    {/* CANTIDAD ESPERADA */}

                                    <div className="inspection-scan-expected">

                                        <span>
                                            Cantidad del documento
                                        </span>

                                        <strong>
                                            {selectedLine.quantity}
                                        </strong>

                                        <small>
                                            {
                                                selectedLine.erp_uom_name ??
                                                "unidades"
                                            }
                                        </small>

                                    </div>

                                </div>


                                {/* MENSAJE VERDE */}

                                {
                                    modalQuantityMatches && (

                                        <p className="inspection-scan-qty-success">

                                            <CheckCircle2
                                                size={16}
                                                aria-hidden="true"
                                            />

                                            La cantidad inspeccionada coincide
                                            con la del documento.

                                        </p>

                                    )
                                }


                                {/* MENSAJE ROJO */}

                                {
                                    modalQuantityDiffers && (

                                        <p
                                            className="inspection-scan-qty-error"
                                            role="status"
                                        >

                                            <XCircle
                                                size={16}
                                                aria-hidden="true"
                                            />

                                            La cantidad inspeccionada es diferente
                                            a la del documento.

                                        </p>

                                    )
                                }


                                <p className="inspection-scan-helper">
                                    Este valor reemplaza la cantidad
                                    inspeccionada anterior.
                                </p>

                            </section>


                            {/* =================================
                                ERROR AL ESCANEAR O GUARDAR
                            ================================= */}

                            {
                                scanError && (
                                    <p
                                        className="inspection-scan-error"
                                        role="alert"
                                    >
                                        {scanError}
                                    </p>
                                )
                            }


                            {/* =================================
                                ADVERTENCIA POR EXCESO
                            ================================= */}

                            {
                                productConfirmed &&
                                qty !== "" &&
                                Number(qty) >
                                Number(selectedLine.quantity) && (

                                    <p
                                        className="inspection-scan-warning"
                                        role="alert"
                                    >
                                        ⚠️ La cantidad inspeccionada
                                        supera la cantidad del documento.
                                    </p>

                                )
                            }


                            {/* =================================
                                BOTONES
                            ================================= */}

                            <div className="inspection-scan-actions">

                                <button
                                    type="button"
                                    className="inspection-scan-cancel"

                                    disabled={
                                        isSaving ||
                                        isScanning
                                    }

                                    onClick={closeScanModal}
                                >
                                    Salir
                                </button>


                                <button
                                    type="button"
                                    className="inspection-scan-save"

                                    disabled={
                                        isSaving ||
                                        isScanning ||
                                        !productConfirmed ||
                                        qty.trim() === ""
                                    }

                                    onClick={() =>
                                        void confirmInspectionLine()
                                    }
                                >
                                    {
                                        isSaving
                                            ? "Guardando..."
                                            : "Confirmar cantidad"
                                    }
                                </button>

                            </div>

                        </div>

                    )
                }

            </ScanModal>

        </div>
    );
}
