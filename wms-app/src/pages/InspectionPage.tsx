import {
    useEffect,
    useState,
} from "react";

import {
    useNavigate,
} from "react-router-dom";

import apiClient from "../services/apiClient.ts";

import {
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    ClipboardCheck,
    Clock3,
    Search,
    XCircle,
} from "lucide-react";

import "../styles/InspectionPage.css";


/* =========================================================
   TYPES
========================================================= */

type InspectionStatus =
    | "PENDIENTE"
    | "APROBADO"
    | "RECHAZADO";


type InspectionDocumentType =
    | "CONDUCE"
    | "FACTURA";


interface InspectionDocument {

    id:
        number;

    /*
        ERP ID:

        NO SE MUESTRA VISUALMENTE.

        Se utiliza para identificar el documento
        cuando hacemos click.
    */
    erp_id:
        string | number;

    tipo:
        InspectionDocumentType;

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
        InspectionStatus;

}


/* =========================================================
   GET DATE AS TIMESTAMP

   ACEPTA:

   05/01/2026

   2026-01-05

   2026-01-05T10:30:00.000Z

   2026-01-05 10:30:00

   DOCUMENTOS SIN FECHA:
   SE MANDAN AL FINAL
========================================================= */

const getInspectionDateTime = (
    fecha: string | null
): number => {

    // =====================================================
    // NO DATE
    // =====================================================

    if (
        !fecha
    ) {

        return Number.POSITIVE_INFINITY;

    }


    const cleanDate =
        fecha.trim();


    // =====================================================
    // FORMAT:
    // DD/MM/YYYY
    // =====================================================

    const ddMmYyyy =
        cleanDate.match(
            /^(\d{2})\/(\d{2})\/(\d{4})$/
        );


    if (
        ddMmYyyy
    ) {

        const [
            ,
            day,
            month,
            year,
        ] =
            ddMmYyyy;


        return new Date(
            Number(
                year
            ),
            Number(
                month
            ) - 1,
            Number(
                day
            )
        ).getTime();

    }


    // =====================================================
    // ISO / POSTGRES
    // =====================================================

    const parsedDate =
        new Date(
            cleanDate
        ).getTime();


    if (
        Number.isNaN(
            parsedDate
        )
    ) {

        console.warn(
            "⚠️ Fecha inválida en inspección:",
            fecha
        );


        return Number.POSITIVE_INFINITY;

    }


    return parsedDate;

};


/* =========================================================
   SORT DOCUMENTS

   MÁS VIEJO
       ↓
   MÁS RECIENTE
========================================================= */

const sortInspectionDocuments =
    (
        receivedDocuments:
            InspectionDocument[]
    ):
        InspectionDocument[] => {

        return [
            ...receivedDocuments
        ].sort(
            (
                a,
                b
            ) => {

                const dateA =
                    getInspectionDateTime(
                        a.fecha
                    );


                const dateB =
                    getInspectionDateTime(
                        b.fecha
                    );


                // =========================================
                // SAME DATE
                // =========================================

                if (
                    dateA ===
                    dateB
                ) {

                    return (
                        Number(
                            a.id
                        ) -
                        Number(
                            b.id
                        )
                    );

                }


                // =========================================
                // OLD -> NEW
                // =========================================

                return (
                    dateA -
                    dateB
                );

            }
        );

    };


/* =========================================================
   COMPONENT
========================================================= */

export default function InspectionPage() {

    /* =====================================================
       NAVIGATE
    ===================================================== */

    const navigate =
        useNavigate();


    /* =====================================================
       CONFIG
    ===================================================== */

    const PAGE_SIZE =
        10;


    const SEARCH_DELAY =
        400;


    /* =====================================================
       STATE
    ===================================================== */

    const [
        searchValue,
        setSearchValue,
    ] =
        useState("");


    const [
        currentPage,
        setCurrentPage,
    ] =
        useState(1);


    const [
        documents,
        setDocuments,
    ] =
        useState<InspectionDocument[]>(
            []
        );


    const [
        loading,
        setLoading,
    ] =
        useState(true);


    const [
        error,
        setError,
    ] =
        useState<string | null>(
            null
        );


    /* =====================================================
       LOAD / SEARCH DOCUMENTS

       INPUT VACÍO:
       GET /inspection/initial

       INPUT CON TEXTO:
       GET /inspection/search?q=...

       SEARCH:
       DEBOUNCE 400ms
    ===================================================== */

    useEffect(
        () => {

            // =================================================
            // CLEAN INPUT
            // =================================================

            const cleanSearch =
                searchValue.trim();


            // =================================================
            // ABORT CONTROLLER
            // =================================================

            const controller =
                new AbortController();


            // =================================================
            // LOAD FUNCTION
            // =================================================

            const loadInspectionDocuments =
                async () => {

                    try {

                        console.log("");

                        console.log(
                            "========================================"
                        );


                        setLoading(
                            true
                        );


                        setError(
                            null
                        );


                        let response;


                        // =====================================
                        // INITIAL
                        // =====================================

                        if (
                            !cleanSearch
                        ) {

                            console.log(
                                "📦 CARGANDO INSPECCIÓN INICIAL"
                            );


                            response =
                                await apiClient.get(
                                    "/inspection/initial",
                                    {
                                        signal:
                                            controller.signal,
                                    }
                                );

                        }


                        // =====================================
                        // SEARCH
                        // =====================================

                        else {

                            console.log(
                                "🔎 BUSCANDO DOCUMENTOS DE INSPECCIÓN"
                            );


                            console.log(
                                "SEARCH:",
                                cleanSearch
                            );


                            response =
                                await apiClient.get(
                                    "/inspection/search",
                                    {

                                        params: {

                                            q:
                                                cleanSearch,

                                        },

                                        signal:
                                            controller.signal,

                                    }
                                );

                        }


                        console.log(
                            "========================================"
                        );


                        console.log(
                            "📥 INSPECTION RESPONSE:",
                            response.data
                        );


                        // =====================================
                        // VALIDATE
                        // =====================================

                        if (
                            !response.data?.success
                        ) {

                            throw new Error(
                                response.data?.message ||
                                "No se pudieron obtener los documentos."
                            );

                        }


                        // =====================================
                        // DOCUMENTS
                        // =====================================

                        const receivedDocuments =
                            response.data
                                ?.data
                                ?.documents;


                        if (
                            !Array.isArray(
                                receivedDocuments
                            )
                        ) {

                            throw new Error(
                                "El servidor devolvió documentos inválidos."
                            );

                        }


                        console.log(
                            "📦 DOCUMENTOS RECIBIDOS:",
                            receivedDocuments
                        );


                        // =====================================
                        // SORT
                        // =====================================

                        const sortedDocuments =
                            sortInspectionDocuments(
                                receivedDocuments
                            );


                        console.log(
                            "📅 DOCUMENTOS ORDENADOS:",
                            sortedDocuments
                        );


                        console.log(
                            "📊 TOTAL:",
                            sortedDocuments.length
                        );


                        // =====================================
                        // SAVE
                        // =====================================

                        setDocuments(
                            sortedDocuments
                        );


                        setCurrentPage(
                            1
                        );


                    } catch (
                        error: any
                    ) {

                        // =====================================
                        // CANCELLED REQUEST
                        // =====================================

                        if (
                            error?.code ===
                                "ERR_CANCELED" ||

                            error?.name ===
                                "CanceledError" ||

                            error?.name ===
                                "AbortError"
                        ) {

                            console.log(
                                "🟡 Request anterior cancelado."
                            );


                            return;

                        }


                        console.error(
                            "❌ ERROR INSPECTION:",
                            error
                        );


                        setDocuments(
                            []
                        );


                        setError(
                            error
                                ?.response
                                ?.data
                                ?.message ||

                            error
                                ?.message ||

                            "No se pudieron cargar los documentos de inspección."
                        );


                    } finally {

                        if (
                            !controller.signal.aborted
                        ) {

                            setLoading(
                                false
                            );

                        }

                    }

                };


            // =================================================
            // INITIAL LOAD
            // =================================================

            if (
                !cleanSearch
            ) {

                loadInspectionDocuments();


                return () => {

                    controller.abort();

                };

            }


            // =================================================
            // SEARCH DEBOUNCE
            // =================================================

            const timeout =
                window.setTimeout(
                    () => {

                        loadInspectionDocuments();

                    },
                    SEARCH_DELAY
                );


            // =================================================
            // CLEANUP
            // =================================================

            return () => {

                window.clearTimeout(
                    timeout
                );


                controller.abort();

            };


        },
        [
            searchValue
        ]
    );


    /* =====================================================
       PAGINATION
    ===================================================== */

    const totalPages =
        Math.max(
            1,
            Math.ceil(
                documents.length /
                PAGE_SIZE
            )
        );


    const safeCurrentPage =
        Math.min(
            currentPage,
            totalPages
        );


    const startIndex =
        (
            safeCurrentPage -
            1
        ) *
        PAGE_SIZE;


    const endIndex =
        startIndex +
        PAGE_SIZE;


    const currentDocuments =
        documents.slice(
            startIndex,
            endIndex
        );


    const visibleStart =
        documents.length ===
        0
            ? 0
            : startIndex + 1;


    const visibleEnd =
        Math.min(
            endIndex,
            documents.length
        );

/* =====================================================
   CLICK DOCUMENT

   ENVÍA A LA SIGUIENTE PÁGINA:

   - guid
   - tipo
   - document completo

   EJEMPLO:

   guid:
   "49c2a880-dbcc-42e5-f057-08df3bb29574"

   tipo:
   "FACTURA"

   URL:
   /inspection/factura/49c2a880-dbcc-42e5-f057-08df3bb29574
===================================================== */

const handleDocumentClick =
    (
        document:
            InspectionDocument
    ) => {

        // =================================================
        // 1. OBTENER GUID
        // =================================================

        const guid =
            String(
                document.erp_id
            ).trim();


        // =================================================
        // 2. OBTENER TIPO
        // =================================================

        const tipo =
            document.tipo;


        console.log("");

        console.log(
            "========================================"
        );

        console.log(
            "📄 DOCUMENTO DE INSPECCIÓN SELECCIONADO"
        );

        console.log(
            "========================================"
        );

        console.log(
            "GUID:",
            guid
        );

        console.log(
            "TIPO:",
            tipo
        );

        console.log(
            "DOCUMENT:",
            document
        );


        // =================================================
        // 3. NAVEGAR
        // =================================================

        navigate(
            `/inspection/${tipo.toLowerCase()}/${guid}`,
            {

                state: {

                    // GUID DEL DOCUMENTO
                    guid,

                    // FACTURA / CONDUCE
                    tipo,

                    // CONSERVAMOS DATOS DEL DOCUMENTO
                    document,

                },

            }
        );

    };

    /* =====================================================
       SEARCH INPUT
    ===================================================== */

    const handleSearchChange =
        (
            value:
                string
        ) => {

            setSearchValue(
                value
            );


            setCurrentPage(
                1
            );

        };


    /* =====================================================
       PREVIOUS PAGE
    ===================================================== */

    const handlePreviousPage =
        () => {

            setCurrentPage(
                previousPage =>
                    Math.max(
                        previousPage -
                        1,
                        1
                    )
            );

        };


    /* =====================================================
       NEXT PAGE
    ===================================================== */

    const handleNextPage =
        () => {

            setCurrentPage(
                previousPage =>
                    Math.min(
                        previousPage +
                        1,
                        totalPages
                    )
            );

        };


    /* =====================================================
       STATUS ICON
    ===================================================== */

    const getStatusIcon =
        (
            status:
                InspectionStatus
        ) => {

            // =========================================
            // APPROVED
            // =========================================

            if (
                status ===
                "APROBADO"
            ) {

                return (

                    <CheckCircle2
                        size={14}
                        strokeWidth={2.4}
                    />

                );

            }


            // =========================================
            // REJECTED
            // =========================================

            if (
                status ===
                "RECHAZADO"
            ) {

                return (

                    <XCircle
                        size={14}
                        strokeWidth={2.4}
                    />

                );

            }


            // =========================================
            // PENDING
            // =========================================

            return (

                <Clock3
                    size={14}
                    strokeWidth={2.4}
                />

            );

        };


    /* =====================================================
       FORMAT STATUS
    ===================================================== */

    const formatStatus =
        (
            status:
                InspectionStatus
        ) => {

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

        };


    /* =====================================================
       JSX
    ===================================================== */

    return (

        <div className="inspection-page">


            {/* =================================================
                HEADER / TOOLBAR
            ================================================= */}

            <section className="inspection-toolbar">


                {/* =============================================
                    TITLE
                ============================================= */}

                <div className="inspection-heading">


                    <div className="inspection-heading-icon">

                        <ClipboardCheck
                            size={27}
                            strokeWidth={2}
                        />

                    </div>


                    <div className="inspection-heading-content">

                        <h1 className="inspection-title">

                            Inspección

                        </h1>


                        <p className="inspection-subtitle">

                            Busque la factura o conduce

                        </p>

                    </div>

                </div>


                {/* =============================================
                    SEARCH
                ============================================= */}

                <div className="inspection-search">


                    <Search
                        className="inspection-search-icon"
                        size={20}
                        strokeWidth={2}
                    />


                    <input
                        type="text"

                        value={
                            searchValue
                        }

                        onChange={
                            event =>
                                handleSearchChange(
                                    event.target.value
                                )
                        }

                        className="inspection-search-input"

                        placeholder="Buscar por número de factura o conduce..."

                        autoComplete="off"
                    />

                </div>


                {/* =============================================
                    PAGINATION
                ============================================= */}

                <div className="inspection-pagination">


                    <button
                        type="button"

                        className="inspection-pagination-button"

                        onClick={
                            handlePreviousPage
                        }

                        disabled={
                            safeCurrentPage ===
                            1
                        }

                        aria-label="Página anterior"
                    >

                        <ChevronLeft
                            size={20}
                        />

                    </button>


                    <span className="inspection-pagination-counter">

                        {
                            visibleStart
                        }

                        {"–"}

                        {
                            visibleEnd
                        }

                        {" / "}

                        {
                            documents.length
                        }

                    </span>


                    <button
                        type="button"

                        className="inspection-pagination-button"

                        onClick={
                            handleNextPage
                        }

                        disabled={
                            safeCurrentPage ===
                            totalPages
                        }

                        aria-label="Página siguiente"
                    >

                        <ChevronRight
                            size={20}
                        />

                    </button>

                </div>

            </section>


            {/* =================================================
                TABLE CARD
            ================================================= */}

            <section className="inspection-table-card">


                {/* =============================================
                    LOADING
                ============================================= */}

                {
                    loading

                        ? (

                            <div className="inspection-empty">

                                {
                                    searchValue.trim()
                                        ? "Buscando documentos..."
                                        : "Cargando documentos de inspección..."
                                }

                            </div>

                        )


                        /* =====================================
                           ERROR
                        ===================================== */

                        : error

                            ? (

                                <div className="inspection-empty">

                                    {
                                        error
                                    }

                                </div>

                            )


                            /* =================================
                               EMPTY
                            ================================= */

                            : currentDocuments.length ===
                                0

                                ? (

                                    <div className="inspection-empty">

                                        {
                                            searchValue.trim()
                                                ? "No se encontraron facturas o conduces con esa búsqueda."
                                                : "No se encontraron facturas o conduces."
                                        }

                                    </div>

                                )


                                /* =============================
                                   TABLE
                                ============================= */

                                : (

                                    <div className="inspection-table-container">

                                        <table className="inspection-table">


                                            {/* =============================
                                                HEADER
                                            ============================= */}

                                            <thead>

                                                <tr>

                                                    <th>
                                                        ID
                                                    </th>

                                                    <th>
                                                        Tipo
                                                    </th>

                                                    <th>
                                                        Número
                                                    </th>

                                                    <th>
                                                        Fecha
                                                    </th>

                                                    <th>
                                                        Cliente
                                                    </th>

                                                    <th>
                                                        Ubicación
                                                    </th>

                                                    <th>
                                                        ERP Referencia
                                                    </th>

                                                    <th>
                                                        Estatus
                                                    </th>

                                                </tr>

                                            </thead>


                                            {/* =============================
                                                BODY
                                            ============================= */}

                                            <tbody>

                                                {
                                                    currentDocuments.map(
                                                        document => (

                                                            <tr

                                                                key={
                                                                    `${document.tipo}-${document.erp_id}`
                                                                }

                                                                className="inspection-table-row"

                                                                onClick={
                                                                    () =>
                                                                        handleDocumentClick(
                                                                            document
                                                                        )
                                                                }

                                                                onKeyDown={
                                                                    event => {

                                                                        if (
                                                                            event.key ===
                                                                                "Enter" ||

                                                                            event.key ===
                                                                                " "
                                                                        ) {

                                                                            event.preventDefault();


                                                                            handleDocumentClick(
                                                                                document
                                                                            );

                                                                        }

                                                                    }
                                                                }

                                                                tabIndex={
                                                                    0
                                                                }

                                                                role="button"

                                                                aria-label={
                                                                    `Abrir ${document.tipo.toLowerCase()} ${document.numero}`
                                                                }
                                                            >


                                                                {/* =====================
                                                                    INTERNAL ID
                                                                ===================== */}

                                                                <td
                                                                    data-label="ID"
                                                                    className="inspection-id"
                                                                >

                                                                    {
                                                                        document.id
                                                                    }

                                                                </td>


                                                                {/* =====================
                                                                    TYPE
                                                                ===================== */}

                                                                <td
                                                                    data-label="Tipo"
                                                                >

                                                                    <span
                                                                        className={`
                                                                            inspection-type-pill
                                                                            inspection-type-${document.tipo.toLowerCase()}
                                                                        `}
                                                                    >

                                                                        {
                                                                            document.tipo ===
                                                                            "CONDUCE"
                                                                                ? "Conduce"
                                                                                : "Factura"
                                                                        }

                                                                    </span>

                                                                </td>


                                                                {/* =====================
                                                                    DOCUMENT NUMBER
                                                                ===================== */}

                                                                <td
                                                                    data-label="Número"
                                                                    className="inspection-document-number"
                                                                >

                                                                    {
                                                                        document.numero
                                                                    }

                                                                </td>


                                                                {/* =====================
                                                                    DATE
                                                                ===================== */}

                                                                <td
                                                                    data-label="Fecha"
                                                                    className="inspection-date"
                                                                >

                                                                    {
                                                                        document.fecha ||
                                                                        "-"
                                                                    }

                                                                </td>


                                                                {/* =====================
                                                                    CLIENT
                                                                ===================== */}

                                                                <td
                                                                    data-label="Cliente"
                                                                    className="inspection-client"
                                                                >

                                                                    {
                                                                        document.cliente
                                                                    }

                                                                </td>


                                                                {/* =====================
                                                                    LOCATION
                                                                ===================== */}

                                                                <td
                                                                    data-label="Ubicación"
                                                                    className="inspection-location"
                                                                >

                                                                    {
                                                                        document.ubicacion
                                                                    }

                                                                </td>


                                                                {/* =====================
                                                                    ERP REFERENCE
                                                                ===================== */}

                                                                <td
                                                                    data-label="ERP Referencia"
                                                                    className="inspection-reference"
                                                                >

                                                                    {
                                                                        document.erp_referencia
                                                                    }

                                                                </td>


                                                                {/* =====================
                                                                    STATUS
                                                                ===================== */}

                                                                <td
                                                                    data-label="Estatus"
                                                                    className="inspection-status-cell"
                                                                >

                                                                    <span
                                                                        className={`
                                                                            inspection-status-pill
                                                                            inspection-status-${document.inspeccion_status.toLowerCase()}
                                                                        `}
                                                                    >

                                                                        {
                                                                            getStatusIcon(
                                                                                document.inspeccion_status
                                                                            )
                                                                        }


                                                                        <span>

                                                                            {
                                                                                formatStatus(
                                                                                    document.inspeccion_status
                                                                                )
                                                                            }

                                                                        </span>

                                                                    </span>

                                                                </td>

                                                            </tr>

                                                        )
                                                    )
                                                }

                                            </tbody>

                                        </table>

                                    </div>

                                )
                }

            </section>

        </div>

    );

}