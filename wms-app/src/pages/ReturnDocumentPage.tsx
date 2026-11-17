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


type ReturnStatus =
    | "PENDIENTE"
    | "APROBADO"
    | "RECHAZADO";


type ReturnDocumentType =
    | "CONDUCE"
    | "FACTURA";


type QuantityVisualState =
    | "neutral"
    | "complete";


interface SelectedReturnDocument {

    id?:
        string | number;

    erp_id:
        string | number;

    tipo:
        ReturnDocumentType;

    numero:
        string;

    fecha:
        string | null;

    cliente:
        string;

    ubicacion:
        string;

    erp_referencia:
        string;

    inspeccion_status:
        ReturnStatus;
}


interface ReturnLocationState {

    guid?:
        string;

    tipo?:
        ReturnDocumentType;

    document?:
        SelectedReturnDocument;
}


interface ReturnLine {

    id:
        string;

    erp_line_id:
        string;

    erp_item_id:
        string;

    sku:
        string;

    description:
        string;

    quantity:
        number;

    completed_quantity:
        number;

    returned_quantity:
        number;

    inspection_status:
        ReturnStatus;

    erp_uom_name:
        string | null;

    erp_row_order:
        number | null;
}


interface ReturnLinesResponse {

    success:
        boolean;

    message?:
        string;

    document?:
        Partial<SelectedReturnDocument>;

    lines:
        ReturnLine[];
}


interface ScanLookupResponse {

    success:
        boolean;

    code?:
        string;

    message?:
        string;

    source?:
        string;

    data?: {

        id:
            string;

        sku:
            string;

        erp_sku:
            string;

        erp_name:
            string | null;

        description:
            string | null;
    };
}


interface ReturnStatusSummary {

    inspection_status:
        ReturnStatus;

    total_lines:
        number;

    zero_lines:
        number;

    matching_lines:
        number;

    difference_lines:
        number;
}


interface SaveReturnLineResponse {

    success:
        boolean;

    message?:
        string;

    warning?:
        string | null;

    line?:
        ReturnLine;

    inspection_status?:
        ReturnStatus;

    inspection_summary?:
        ReturnStatusSummary;
}


const UUID_PATTERN =
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;


const SCANNER_GAP_MS =
    300;


function normalizeCode(
    raw:
        unknown
): string {

    return String(
        raw ??
        ""
    )
        .replace(
            /[\r\n]/g,
            ""
        )
        .trim()
        .toUpperCase();
}


function getQuantityVisualState(
    returned:
        number |
        string |
        null |
        undefined
): QuantityVisualState {

    if (
        returned === null ||
        returned === undefined ||
        String(
            returned
        ).trim() === ""
    ) {

        return "neutral";
    }


    const returnedQty =
        Number(
            returned
        );


    if (
        !Number.isFinite(
            returnedQty
        ) ||
        returnedQty <= 0
    ) {

        return "neutral";
    }


    return "complete";
}


function formatStatus(
    status:
        ReturnStatus
): string {

    return (
        status.charAt(
            0
        ) +
        status
            .slice(
                1
            )
            .toLowerCase()
    );
}


function getStatusIcon(
    status:
        ReturnStatus
) {

    if (
        status === "APROBADO"
    ) {

        return (
            <CheckCircle2
                size={14}
                strokeWidth={2.4}
            />
        );
    }


    if (
        status === "RECHAZADO"
    ) {

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


export default function ReturnDocumentPage() {


    const navigate =
        useNavigate();


    const location =
        useLocation();


    const {
        openModal
    } =
        useModal();


    const {
        tipo:
            routeTipo,

        erpId:
            routeErpId
    } =
        useParams<{
            tipo:
                string;

            erpId:
                string;
        }>();


    const navigationState =
        location.state as
            ReturnLocationState |
            null;


    const selectedDocument =
        navigationState
            ?.document;


    const documentGuid =
        String(
            routeErpId ??
            navigationState?.guid ??
            selectedDocument?.erp_id ??
            ""
        ).trim();


    const documentType =
        String(
            routeTipo ??
            navigationState?.tipo ??
            selectedDocument?.tipo ??
            ""
        )
            .trim()
            .toUpperCase() as
        ReturnDocumentType;


    const [
        returnLines,
        setReturnLines
    ] =
        useState<ReturnLine[]>(
            []
        );


    const [
        fetchedDocument,
        setFetchedDocument
    ] =
        useState<
            Partial<SelectedReturnDocument> |
            null
        >(
            null
        );


    const [
        isLoading,
        setIsLoading
    ] =
        useState(
            true
        );


    const [
        loadError,
        setLoadError
    ] =
        useState<
            string |
            null
        >(
            null
        );


    const [
        retryKey,
        setRetryKey
    ] =
        useState(
            0
        );


    const [
        selectedLine,
        setSelectedLine
    ] =
        useState<
            ReturnLine |
            null
        >(
            null
        );


    const [
        isScanModalOpen,
        setIsScanModalOpen
    ] =
        useState(
            false
        );


    const [
        productConfirmed,
        setProductConfirmed
    ] =
        useState(
            false
        );


    const [
        confirmedErpSku,
        setConfirmedErpSku
    ] =
        useState(
            ""
        );


    const [
        manualCode,
        setManualCode
    ] =
        useState(
            ""
        );


    const [
        qty,
        setQty
    ] =
        useState(
            ""
        );


    const [
        scanError,
        setScanError
    ] =
        useState<
            string |
            null
        >(
            null
        );


    const [
        isScanning,
        setIsScanning
    ] =
        useState(
            false
        );


    const [
        isSaving,
        setIsSaving
    ] =
        useState(
            false
        );


    const scanBufferRef =
        useRef(
            ""
        );


    const lastScannerKeyTimeRef =
        useRef(
            0
        );


    const scanRequestBusyRef =
        useRef(
            false
        );


    const qtyInputRef =
        useRef<
            HTMLInputElement |
            null
        >(
            null
        );


    const productInputRef =
        useRef<
            HTMLInputElement |
            null
        >(
            null
        );


    const resetScannerBuffer =
        useCallback(
            () => {

                scanBufferRef.current =
                    "";

                lastScannerKeyTimeRef.current =
                    0;

            },
            []
        );


    const showRedError =
        useCallback(
            (
                message:
                    string,

                title =
                    "❌ ERROR EN LA OPERACIÓN"
            ) => {

                openModal({

                    title,

                    message,

                    buttonText:
                        "Entendido",

                    titleColor:
                        "red"

                });

            },
            [
                openModal
            ]
        );


    useEffect(
        () => {

            const controller =
                new AbortController();


            let cancelled =
                false;


            async function fetchDocumentLines() {


                setIsLoading(
                    true
                );


                setLoadError(
                    null
                );


                setReturnLines(
                    []
                );


                setFetchedDocument(
                    null
                );


                setIsScanModalOpen(
                    false
                );


                setSelectedLine(
                    null
                );


                resetScannerBuffer();


                if (
                    !UUID_PATTERN.test(
                        documentGuid
                    )
                ) {

                    setLoadError(
                        "El GUID del documento no es válido."
                    );

                    setIsLoading(
                        false
                    );

                    return;
                }


                if (
                    documentType !== "CONDUCE" &&
                    documentType !== "FACTURA"
                ) {

                    setLoadError(
                        "El tipo debe ser CONDUCE o FACTURA."
                    );

                    setIsLoading(
                        false
                    );

                    return;
                }


                try {


                    const url =
                        `/returns/${documentType.toLowerCase()}` +
                        `/${documentGuid}/lines/sync`;


                    console.log("");
                    console.log("🟦 ========================================");
                    console.log("🔄 SINCRONIZANDO DEVOLUCIÓN");
                    console.log(
                        "📄 TIPO:",
                        documentType
                    );
                    console.log(
                        "🆔 GUID:",
                        documentGuid
                    );
                    console.log(
                        "📄 URL:",
                        url
                    );
                    console.log("🟦 ========================================");


                    const response =
                        await apiClient.post<
                            ReturnLinesResponse
                        >(
                            url,
                            {},
                            {
                                signal:
                                    controller.signal
                            }
                        );


                    if (
                        cancelled
                    ) {
                        return;
                    }


                    if (
                        !response.data.success ||
                        !Array.isArray(
                            response.data.lines
                        )
                    ) {

                        throw new Error(
                            response.data.message ||
                            "Respuesta inválida del backend."
                        );
                    }


                    setReturnLines(
                        response.data.lines
                    );


                    setFetchedDocument(
                        response.data.document ??
                        null
                    );


                    console.log(
                        "✅ PRODUCTOS PARA DEVOLUCIÓN:",
                        response.data.lines
                    );


                    console.log(
                        "🏷️ ESTADO DEL DOCUMENTO:",
                        response.data.document
                            ?.inspeccion_status
                    );


                } catch (
                    error:
                        unknown
                ) {


                    if (
                        cancelled
                    ) {
                        return;
                    }


                    const err =
                        error as {

                            code?:
                                string;

                            message?:
                                string;

                            response?: {

                                data?: {

                                    message?:
                                        string;
                                };
                            };
                        };


                    if (
                        err.code !== "ERR_CANCELED"
                    ) {

                        console.error(
                            "❌ ERROR SINCRONIZANDO DEVOLUCIÓN:",
                            error
                        );


                        setLoadError(
                            err.response
                                ?.data
                                ?.message ??
                            err.message ??
                            "No se pudieron cargar los productos para la devolución."
                        );
                    }


                } finally {


                    if (
                        !cancelled
                    ) {

                        setIsLoading(
                            false
                        );
                    }
                }
            }


            void fetchDocumentLines();


            return () => {

                cancelled =
                    true;

                controller.abort();

            };

        },
        [
            documentGuid,
            documentType,
            retryKey,
            resetScannerBuffer
        ]
    );


    const openLineModal =
        useCallback(
            (
                line:
                    ReturnLine,

                verifiedErpSku =
                    ""
            ) => {


                setSelectedLine(
                    line
                );


                setIsScanModalOpen(
                    true
                );


                setProductConfirmed(
                    Boolean(
                        verifiedErpSku
                    )
                );


                setConfirmedErpSku(
                    verifiedErpSku
                );


                setManualCode(
                    ""
                );


                setQty(
                    String(
                        line.returned_quantity ??
                        0
                    )
                );


                setScanError(
                    null
                );


                resetScannerBuffer();


                console.log(
                    "📦 ABRIENDO MODAL DE DEVOLUCIÓN:",
                    line
                );

            },
            [
                resetScannerBuffer
            ]
        );


    function closeScanModal() {


        if (
            isSaving ||
            isScanning
        ) {
            return;
        }


        setIsScanModalOpen(
            false
        );


        setSelectedLine(
            null
        );


        setProductConfirmed(
            false
        );


        setConfirmedErpSku(
            ""
        );


        setManualCode(
            ""
        );


        setQty(
            ""
        );


        setScanError(
            null
        );


        resetScannerBuffer();
    }


    const handleScannedCode =
        useCallback(
            async (
                rawCode:
                    string
            ) => {


                const scannedCode =
                    normalizeCode(
                        rawCode
                    );


                if (
                    !scannedCode ||
                    scanRequestBusyRef.current ||
                    isSaving
                ) {
                    return;
                }


                scanRequestBusyRef.current =
                    true;


                setIsScanning(
                    true
                );


                setScanError(
                    null
                );


                resetScannerBuffer();


                try {


                    console.log(
                        "📡 CÓDIGO ESCANEADO:",
                        scannedCode
                    );


                    const response =
                        await apiClient.post<
                            ScanLookupResponse
                        >(
                            "/inspection/scan",
                            {
                                code:
                                    scannedCode
                            }
                        );


                    const result =
                        response.data;


                    if (
                        !result.success ||
                        !result.data?.erp_sku
                    ) {


                        setProductConfirmed(
                            false
                        );


                        setConfirmedErpSku(
                            ""
                        );


                        showRedError(
                            result.message ||
                            `No se encontró ningún producto para ${scannedCode}.`
                        );


                        return;
                    }


                    const resolvedErpSku =
                        normalizeCode(
                            result.data.erp_sku
                        );


                    console.log(
                        "✅ PRODUCTO RESUELTO:",
                        {
                            scannedCode,

                            productSku:
                                result.data.sku,

                            erpSku:
                                resolvedErpSku,

                            source:
                                result.source
                        }
                    );


                    const matches =
                        returnLines.filter(

                            line =>
                                normalizeCode(
                                    line.sku
                                ) === resolvedErpSku

                        );


                    if (
                        matches.length === 0
                    ) {


                        setProductConfirmed(
                            false
                        );


                        setConfirmedErpSku(
                            ""
                        );


                        showRedError(
                            `Se encontró el producto ${result.data.sku} ` +
                            `(${resolvedErpSku}), pero no existe ` +
                            "en las líneas de este documento."
                        );


                        return;
                    }


                    if (
                        isScanModalOpen &&
                        selectedLine
                    ) {


                        const correctLine =
                            matches.find(

                                line =>
                                    String(
                                        line.id
                                    ) ===
                                    String(
                                        selectedLine.id
                                    )

                            );


                        if (
                            !correctLine
                        ) {


                            setProductConfirmed(
                                false
                            );


                            setConfirmedErpSku(
                                ""
                            );


                            showRedError(
                                `El producto ${resolvedErpSku} ` +
                                "no corresponde a la línea seleccionada " +
                                `(${selectedLine.sku}).`
                            );


                            return;
                        }


                        setProductConfirmed(
                            true
                        );


                        setConfirmedErpSku(
                            resolvedErpSku
                        );


                        setManualCode(
                            ""
                        );


                        setScanError(
                            null
                        );


                        console.log(
                            "🟩 PRODUCTO CONFIRMADO PARA DEVOLUCIÓN:",
                            resolvedErpSku
                        );


                        return;
                    }


                    if (
                        matches.length > 1
                    ) {


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


                } catch (
                    error:
                        unknown
                ) {


                    const err =
                        error as {

                            message?:
                                string;

                            response?: {

                                data?: {

                                    message?:
                                        string;
                                };
                            };
                        };


                    console.error(
                        "❌ ERROR DE ESCÁNER EN DEVOLUCIÓN:",
                        error
                    );


                    setProductConfirmed(
                        false
                    );


                    setConfirmedErpSku(
                        ""
                    );


                    showRedError(
                        err.response
                            ?.data
                            ?.message ??
                        err.message ??
                        "No se pudo completar la devolución. Inténtalo nuevamente."
                    );


                } finally {


                    scanRequestBusyRef.current =
                        false;


                    setIsScanning(
                        false
                    );
                }
            },
            [
                returnLines,
                isScanModalOpen,
                selectedLine,
                isSaving,
                openLineModal,
                showRedError,
                resetScannerBuffer
            ]
        );


    useEffect(
        () => {


            if (
                isLoading ||
                loadError
            ) {
                return;
            }


            const handleKeyDown =
                (
                    event:
                        KeyboardEvent
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
                        event.target as
                            HTMLElement |
                            null;


                    const editing =
                        Boolean(
                            target?.closest(
                                'input, textarea, select, [contenteditable="true"], [role="textbox"]'
                            )
                        );


                    if (
                        editing
                    ) {

                        resetScannerBuffer();

                        return;
                    }


                    if (
                        event.key === "Enter" ||
                        event.key === "Tab"
                    ) {


                        const code =
                            scanBufferRef.current;


                        resetScannerBuffer();


                        if (
                            !code.trim()
                        ) {
                            return;
                        }


                        event.preventDefault();


                        void handleScannedCode(
                            code
                        );


                        return;
                    }


                    if (
                        event.key.length === 1
                    ) {


                        const now =
                            Date.now();


                        if (
                            lastScannerKeyTimeRef.current &&
                            now -
                            lastScannerKeyTimeRef.current >
                            SCANNER_GAP_MS
                        ) {

                            scanBufferRef.current =
                                "";
                        }


                        scanBufferRef.current +=
                            event.key;


                        lastScannerKeyTimeRef.current =
                            now;
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

        },
        [
            isLoading,
            loadError,
            handleScannedCode,
            resetScannerBuffer
        ]
    );


    useEffect(
        () => {


            if (
                !isScanModalOpen
            ) {
                return;
            }


            if (
                productConfirmed
            ) {


                qtyInputRef
                    .current
                    ?.focus();


                qtyInputRef
                    .current
                    ?.select();


            } else {


                productInputRef
                    .current
                    ?.focus();
            }

        },
        [
            isScanModalOpen,
            productConfirmed
        ]
    );


    async function confirmReturnLine() {


        if (
            isSaving ||
            isScanning
        ) {
            return;
        }


        if (
            !selectedLine ||
            !productConfirmed ||
            !confirmedErpSku
        ) {


            setScanError(
                "Primero debe escanear y confirmar el producto devuelto."
            );


            return;
        }


        const quantity =
            qty.trim();


        if (
            !/^\d+(?:\.\d{1,4})?$/.test(
                quantity
            ) ||
            Number(
                quantity
            ) > 99999999999999
        ) {


            setScanError(
                "La cantidad devuelta debe ser mayor o igual a 0 y tener hasta 4 decimales."
            );


            return;
        }


        setIsSaving(
            true
        );


        setScanError(
            null
        );


        try {


            const url =
                `/returns/${documentType.toLowerCase()}` +
                `/${documentGuid}` +
                `/lines/${selectedLine.id}`;


            console.log("");
            console.log("🔵 ========================================");
            console.log("💾 GUARDANDO DEVOLUCIÓN");
            console.log(
                "📄 DOCUMENTO:",
                documentGuid
            );
            console.log(
                "📦 SKU:",
                confirmedErpSku
            );
            console.log(
                "🔢 CANTIDAD DEVUELTA:",
                quantity
            );
            console.log("🔵 ========================================");


            const response =
                await apiClient.patch<
                    SaveReturnLineResponse
                >(
                    url,
                    {

                        scanned_code:
                            confirmedErpSku,

                        returned_quantity:
                            quantity

                    }
                );


            if (
                !response.data.success ||
                !response.data.line
            ) {


                throw new Error(
                    response.data.message ||
                    "No se pudo guardar la devolución."
                );
            }


            const updatedLine =
                response.data.line;


            setReturnLines(

                previous =>

                    previous.map(

                        line =>

                            String(
                                line.id
                            ) ===
                            String(
                                updatedLine.id
                            )

                                ? {
                                    ...line,
                                    ...updatedLine
                                }

                                : line

                    )

            );


            console.log(
                "✅ CANTIDAD DEVUELTA GUARDADA:",
                updatedLine
            );


            if (
                response.data.warning
            ) {

                console.warn(
                    "⚠️ ADVERTENCIA DE DEVOLUCIÓN:",
                    response.data.warning
                );
            }


            const newReturnStatus =
                response.data
                    .inspection_status ??
                response.data
                    .inspection_summary
                    ?.inspection_status;


            if (
                newReturnStatus === "PENDIENTE" ||
                newReturnStatus === "APROBADO" ||
                newReturnStatus === "RECHAZADO"
            ) {


                setFetchedDocument(
                    previous => ({

                        ...(
                            previous ??
                            {}
                        ),

                        inspeccion_status:
                            newReturnStatus

                    })
                );


                console.log(
                    "🏷️ ESTADO DE DEVOLUCIÓN ACTUALIZADO:",
                    newReturnStatus
                );


                console.log(
                    "📊 RESUMEN DE DEVOLUCIÓN:",
                    response.data
                        .inspection_summary
                );


            } else {


                console.warn(
                    "⚠️ El backend no devolvió un estado válido para la devolución."
                );
            }


            setIsScanModalOpen(
                false
            );


            setSelectedLine(
                null
            );


            setProductConfirmed(
                false
            );


            setConfirmedErpSku(
                ""
            );


            setManualCode(
                ""
            );


            setQty(
                ""
            );


            setScanError(
                null
            );


            resetScannerBuffer();


        } catch (
            error:
                unknown
        ) {


            const err =
                error as {

                    message?:
                        string;

                    response?: {

                        data?: {

                            message?:
                                string;
                        };
                    };
                };


            console.error(
                "❌ ERROR GUARDANDO DEVOLUCIÓN:",
                error
            );


            setScanError(
                err.response
                    ?.data
                    ?.message ??
                err.message ??
                "No se pudo guardar la cantidad devuelta."
            );


        } finally {


            setIsSaving(
                false
            );
        }
    }


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
            ? String(
                rawDate
            ).slice(
                0,
                10
            )
            : "-";


    const documentLocation =
        fetchedDocument?.ubicacion ||
        selectedDocument?.ubicacion ||
        "-";


    const documentReference =
        fetchedDocument?.erp_referencia ||
        selectedDocument?.erp_referencia ||
        "-";


    const documentStatus:
        ReturnStatus =
        fetchedDocument?.inspeccion_status ||
        selectedDocument?.inspeccion_status ||
        "PENDIENTE";


    const modalQuantityState:
        QuantityVisualState =
        selectedLine === null
            ? "neutral"
            : getQuantityVisualState(
                qty
            );


    const modalHasReturnQuantity =
        modalQuantityState === "complete";


    if (
        isLoading
    ) {

        return (

            <div className="inspection-document-page">

                <section
                    className="inspection-document-table-card"
                    style={{
                        padding:
                            28
                    }}
                >

                    <h2>
                        Cargando productos del documento...
                    </h2>

                    <p>
                        Consultando Adm Cloud y sincronizando
                        los productos disponibles para devolución.
                    </p>

                </section>

            </div>

        );
    }


    if (
        loadError
    ) {

        return (

            <div className="inspection-document-page">

                <section
                    className="inspection-document-table-card"
                    style={{
                        padding:
                            28
                    }}
                >

                    <h2>
                        No se pudo cargar la devolución
                    </h2>


                    <p
                        role="alert"
                    >
                        {
                            loadError
                        }
                    </p>


                    <div
                        style={{
                            display:
                                "flex",

                            gap:
                                10,

                            marginTop:
                                16
                        }}
                    >

                        <button
                            type="button"
                            className="inspection-document-back-button"
                            onClick={
                                () =>
                                    setRetryKey(
                                        previous =>
                                            previous + 1
                                    )
                            }
                        >
                            Reintentar
                        </button>


                        <button
                            type="button"
                            className="inspection-document-back-button"
                            onClick={
                                () =>
                                    navigate(
                                        "/returns"
                                    )
                            }
                        >
                            Volver
                        </button>

                    </div>

                </section>

            </div>

        );
    }


    return (

        <div className="inspection-document-page">


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

                            {
                                documentNumber
                            }

                        </h1>


                        <p className="inspection-document-subtitle">

                            {
                                clientName
                            }

                        </p>

                    </div>


                </div>


                <div className="inspection-document-summary">


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


                    <div className="inspection-document-summary-item">

                        <span className="inspection-document-summary-label">
                            Referencia
                        </span>


                        <span className="inspection-document-summary-value inspection-document-summary-mono">

                            {
                                documentReference
                            }

                        </span>

                    </div>


                    <div className="inspection-document-summary-item">

                        <span className="inspection-document-summary-label">
                            Fecha
                        </span>


                        <span className="inspection-document-summary-value">

                            {
                                documentDate
                            }

                        </span>

                    </div>


                    <div className="inspection-document-summary-item">

                        <span className="inspection-document-summary-label">
                            Ubicación
                        </span>


                        <span className="inspection-document-summary-value">

                            {
                                documentLocation
                            }

                        </span>

                    </div>


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

                            {
                                getStatusIcon(
                                    documentStatus
                                )
                            }


                            <span>

                                {
                                    formatStatus(
                                        documentStatus
                                    )
                                }

                            </span>

                        </span>

                    </div>


                </div>


                <div className="inspection-document-actions">

                    <button
                        type="button"
                        className="inspection-document-back-button"
                        onClick={
                            () =>
                                navigate(
                                    "/returns"
                                )
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


            <section className="inspection-document-table-card">


                <div className="inspection-document-table-header">


                    <div>

                        <h2 className="inspection-document-table-title">
                            Productos
                        </h2>


                        <p className="inspection-document-table-subtitle">
                            Escanee el producto devuelto o
                            seleccione una línea para registrar
                            la cantidad devuelta.
                        </p>

                    </div>


                    <div className="inspection-document-line-count">

                        {
                            returnLines.length
                        }

                        {" "}

                        {
                            returnLines.length === 1
                                ? "línea"
                                : "líneas"
                        }

                    </div>


                </div>


                <div className="inspection-document-table-container">


                    <table className="inspection-document-table">


                        <thead>

                            <tr>

                                <th>
                                    No.
                                </th>

                                <th>
                                    Código
                                </th>

                                <th>
                                    Descripción
                                </th>

                                <th>
                                    Cantidad
                                </th>

                                <th>
                                    Devuelta
                                </th>

                            </tr>

                        </thead>


                        <tbody>


                            {
                                returnLines.length === 0 && (

                                    <tr>

                                        <td
                                            colSpan={
                                                5
                                            }
                                            style={{
                                                textAlign:
                                                    "center",

                                                padding:
                                                    24
                                            }}
                                        >

                                            Este documento no tiene
                                            productos disponibles.

                                        </td>

                                    </tr>

                                )
                            }


                            {
                                returnLines.map(
                                    (
                                        line,
                                        index
                                    ) => {


                                        const visualState =
                                            getQuantityVisualState(
                                                line.returned_quantity
                                            );


                                        return (

                                            <tr
                                                key={
                                                    line.id
                                                }
                                                className={`
                                                    inspection-document-table-row
                                                    inspection-document-row-${visualState}
                                                `}
                                                tabIndex={
                                                    0
                                                }
                                                role="button"
                                                aria-label={
                                                    `Devolver producto ${line.sku}`
                                                }
                                                onClick={
                                                    () =>
                                                        openLineModal(
                                                            line
                                                        )
                                                }
                                                onKeyDown={
                                                    event => {

                                                        if (
                                                            (
                                                                event.key === "Enter" ||
                                                                event.key === " "
                                                            ) &&
                                                            !scanBufferRef
                                                                .current
                                                                .trim()
                                                        ) {

                                                            event.preventDefault();

                                                            openLineModal(
                                                                line
                                                            );
                                                        }
                                                    }
                                                }
                                            >


                                                <td
                                                    data-label="No."
                                                    className="inspection-document-line-number"
                                                >
                                                    {
                                                        index + 1
                                                    }
                                                </td>


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

                                                            {
                                                                line.sku
                                                            }

                                                        </span>

                                                    </div>

                                                </td>


                                                <td
                                                    data-label="Descripción"
                                                    className="inspection-document-description"
                                                >
                                                    {
                                                        line.description
                                                    }
                                                </td>


                                                <td
                                                    data-label="Cantidad"
                                                    className="inspection-document-quantity"
                                                >
                                                    {
                                                        line.quantity
                                                    }
                                                </td>


                                                <td
                                                    data-label="Devuelta"
                                                    className={`
                                                        inspection-document-quantity
                                                        inspection-document-quantity-${visualState}
                                                    `}
                                                >

                                                    <span className="inspection-document-inspected-value">

                                                        {
                                                            visualState === "complete"
                                                                ? (
                                                                    <CheckCircle2
                                                                        size={16}
                                                                        strokeWidth={2.5}
                                                                        aria-hidden="true"
                                                                    />
                                                                )
                                                                : null
                                                        }


                                                        {
                                                            line.returned_quantity
                                                        }

                                                    </span>

                                                </td>


                                            </tr>

                                        );
                                    }
                                )
                            }


                        </tbody>


                    </table>


                </div>


            </section>


            <ScanModal
                open={
                    isScanModalOpen
                }
                onClose={
                    closeScanModal
                }
            >


                {
                    selectedLine && (

                        <div className="inspection-scan-modal">


                            <div className="inspection-scan-modal-title">

                                <ScanLine
                                    size={24}
                                />


                                <div>

                                    <h2>
                                        Confirmar devolución
                                    </h2>


                                    <p>
                                        Lea el producto y confirme
                                        la cantidad que está devolviendo
                                        el cliente.
                                    </p>

                                </div>


                            </div>


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
                                            : "📡 Lea el producto devuelto"
                                    }

                                </span>


                                <div className="inspection-scan-product-name">

                                    {
                                        selectedLine.description
                                    }

                                </div>


                                <div className="inspection-scan-product-sku">

                                    ERP SKU: {
                                        selectedLine.sku
                                    }

                                </div>


                                <div className="inspection-scan-confirm-state">

                                    {
                                        productConfirmed
                                            ? "Producto devuelto verificado correctamente"
                                            : "Pendiente de confirmar con el escáner"
                                    }

                                </div>


                                {
                                    !productConfirmed && (

                                        <div className="inspection-scan-manual-row">

                                            <input
                                                ref={
                                                    productInputRef
                                                }
                                                type="text"
                                                value={
                                                    manualCode
                                                }
                                                placeholder="Escanee SKU WMS o código de barras"
                                                aria-label="Código del producto devuelto"
                                                disabled={
                                                    isSaving ||
                                                    isScanning
                                                }
                                                onChange={
                                                    event =>
                                                        setManualCode(
                                                            event.target.value
                                                        )
                                                }
                                                onFocus={
                                                    resetScannerBuffer
                                                }
                                                onKeyDown={
                                                    event => {

                                                        if (
                                                            (
                                                                event.key === "Enter" ||
                                                                event.key === "Tab"
                                                            ) &&
                                                            event
                                                                .currentTarget
                                                                .value
                                                                .trim()
                                                        ) {

                                                            event.preventDefault();

                                                            void handleScannedCode(
                                                                event
                                                                    .currentTarget
                                                                    .value
                                                            );
                                                        }
                                                    }
                                                }
                                            />


                                            <button
                                                type="button"
                                                disabled={
                                                    isSaving ||
                                                    isScanning ||
                                                    !manualCode.trim()
                                                }
                                                onClick={
                                                    () =>
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


                            <section
                                className={`
                                    inspection-scan-yellow-panel
                                    ${
                                        modalHasReturnQuantity
                                            ? "inspection-scan-qty-complete"
                                            : ""
                                    }
                                `}
                            >


                                <span className="inspection-scan-label">

                                    {
                                        modalHasReturnQuantity
                                            ? "✅ Cantidad devuelta registrada"
                                            : "🔢 Ingrese la cantidad devuelta"
                                    }

                                </span>


                                <div className="inspection-scan-qty-row">


                                    <input
                                        ref={
                                            qtyInputRef
                                        }
                                        type="number"
                                        min="0"
                                        step="0.0001"
                                        value={
                                            qty
                                        }
                                        disabled={
                                            !productConfirmed ||
                                            isSaving ||
                                            isScanning
                                        }
                                        aria-label="Cantidad devuelta"
                                        onChange={
                                            event =>
                                                setQty(
                                                    event.target.value
                                                )
                                        }
                                        onFocus={
                                            resetScannerBuffer
                                        }
                                        onKeyDown={
                                            event => {

                                                if (
                                                    event.key === "Enter" &&
                                                    productConfirmed
                                                ) {

                                                    event.preventDefault();

                                                    void confirmReturnLine();
                                                }
                                            }
                                        }
                                    />


                                    <div className="inspection-scan-expected">

                                        <span>
                                            Cantidad del documento
                                        </span>


                                        <strong>
                                            {
                                                selectedLine.quantity
                                            }
                                        </strong>


                                        <small>
                                            {
                                                selectedLine
                                                    .erp_uom_name ??
                                                "unidades"
                                            }
                                        </small>

                                    </div>


                                </div>


                                {
                                    modalHasReturnQuantity && (

                                        <p className="inspection-scan-qty-success">

                                            <CheckCircle2
                                                size={16}
                                                aria-hidden="true"
                                            />

                                            Cantidad devuelta lista para confirmar.

                                        </p>

                                    )
                                }


                                <p className="inspection-scan-helper">

                                    Puede devolver una cantidad menor
                                    a la cantidad original del documento.

                                </p>


                            </section>


                            {
                                scanError && (

                                    <p
                                        className="inspection-scan-error"
                                        role="alert"
                                    >
                                        {
                                            scanError
                                        }
                                    </p>

                                )
                            }


                            {
                                productConfirmed &&
                                qty !== "" &&
                                Number(
                                    qty
                                ) >
                                Number(
                                    selectedLine.quantity
                                ) && (

                                    <p
                                        className="inspection-scan-warning"
                                        role="alert"
                                    >

                                        ⚠️ La cantidad devuelta
                                        supera la cantidad del documento.

                                    </p>

                                )
                            }


                            <div className="inspection-scan-actions">


                                <button
                                    type="button"
                                    className="inspection-scan-cancel"
                                    disabled={
                                        isSaving ||
                                        isScanning
                                    }
                                    onClick={
                                        closeScanModal
                                    }
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
                                    onClick={
                                        () =>
                                            void confirmReturnLine()
                                    }
                                >

                                    {
                                        isSaving
                                            ? "Guardando devolución..."
                                            : "Confirmar devolución"
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