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
    PackageOpen,
    RotateCcw,
    Search,
    SearchX,
    Truck,
} from "lucide-react";

import "../styles/InspectionPage.css";


/* =========================================================
   TYPES
========================================================= */

type ReturnStatus =
    | "DESPACHADO"
    | "DEVUELTO_PARCIALMENTE"
    | "DEVUELTO_COMPLETAMENTE";


type ReturnDocumentType =
    | "CONDUCE"
    | "FACTURA";


interface ReturnDocument {

    id: number;

    /*
        GUID REAL DE ADM CLOUD
    */
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

    /*
        NUEVO ESTATUS DE DEVOLUCIÓN
    */
    devolucion_status:
        ReturnStatus;

}


/* =========================================================
   RAW DOCUMENT FROM BACKEND

   Esto permite temporalmente aceptar diferentes nombres
   del campo status mientras actualizas el backend.
========================================================= */

interface BackendReturnDocument {

    id:
        number;

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

    devolucion_status?:
        string;

    return_status?:
        string;

    inspeccion_status?:
        string;

    status?:
        string;

}


/* =========================================================
   CONFIG
========================================================= */

const PAGE_SIZE =
    10;


const SEARCH_DELAY =
    400;


/* =========================================================
   DATE -> TIMESTAMP
========================================================= */

const getDocumentDateTime =
    (
        fecha:
            string | null
    ):
        number => {

        if (
            !fecha
        ) {

            return Number.POSITIVE_INFINITY;

        }


        const cleanDate =
            fecha.trim();


        /*
            DD/MM/YYYY
        */

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


        /*
            ISO / POSTGRES
        */

        const parsedDate =
            new Date(
                cleanDate
            ).getTime();


        if (
            Number.isNaN(
                parsedDate
            )
        ) {

            return Number.POSITIVE_INFINITY;

        }


        return parsedDate;

    };


/* =========================================================
   SORT DOCUMENTS
========================================================= */

const sortDocuments =
    (
        documents:
            ReturnDocument[]
    ):
        ReturnDocument[] => {

        return [
            ...documents
        ].sort(
            (
                a,
                b
            ) => {

                const dateA =
                    getDocumentDateTime(
                        a.fecha
                    );


                const dateB =
                    getDocumentDateTime(
                        b.fecha
                    );


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


                return (
                    dateA -
                    dateB
                );

            }
        );

    };


/* =========================================================
   NORMALIZE STATUS
========================================================= */

const normalizeReturnStatus =
    (
        document:
            BackendReturnDocument
    ):
        ReturnStatus => {

        const rawStatus =
            String(
                document.devolucion_status ??
                document.return_status ??
                document.inspeccion_status ??
                document.status ??
                ""
            )
                .trim()
                .toUpperCase()
                .replace(
                    /[\s-]+/g,
                    "_"
                );


        /* =============================================
           DESPACHADO
        ============================================= */

        if (
            rawStatus ===
            "DESPACHADO"
        ) {

            return "DESPACHADO";

        }


        /* =============================================
           DEVUELTO PARCIALMENTE
        ============================================= */

        if (
            rawStatus ===
            "DEVUELTO_PARCIALMENTE" ||

            rawStatus ===
            "DEVUELTO_PARTIALMENTE" ||

            rawStatus ===
            "PARCIALMENTE_DEVUELTO"
        ) {

            return "DEVUELTO_PARCIALMENTE";

        }


        /* =============================================
           DEVUELTO COMPLETAMENTE
        ============================================= */

        if (
            rawStatus ===
            "DEVUELTO_COMPLETAMENTE" ||

            rawStatus ===
            "COMPLETAMENTE_DEVUELTO"
        ) {

            return "DEVUELTO_COMPLETAMENTE";

        }


        /*
            Si todavía el backend no manda el nuevo campo,
            asumimos que el documento simplemente está
            despachado y todavía no tiene devolución.

            Más adelante lo ideal es que backend mande:
            
            DESPACHADO
            DEVUELTO_PARCIALMENTE
            DEVUELTO_COMPLETAMENTE
        */

        return "DESPACHADO";

    };


/* =========================================================
   NORMALIZE DOCUMENT
========================================================= */

const normalizeDocument =
    (
        document:
            BackendReturnDocument
    ):
        ReturnDocument => {

        return {

            id:
                document.id,

            erp_id:
                document.erp_id,

            tipo:
                document.tipo,

            numero:
                document.numero,

            fecha:
                document.fecha,

            cliente:
                document.cliente,

            ubicacion:
                document.ubicacion,

            erp_referencia:
                document.erp_referencia,

            devolucion_status:
                normalizeReturnStatus(
                    document
                ),

        };

    };


/* =========================================================
   COMPONENT
========================================================= */

export default function ReturnsPage() {


    /* =====================================================
       NAVIGATE
    ===================================================== */

    const navigate =
        useNavigate();


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
        useState<ReturnDocument[]>(
            []
        );


    /*
        IMPORTANTE:

        Antes empezaba en true porque cargabas
        /inspection/initial.

        Ahora empieza FALSE porque NO hacemos
        ninguna llamada al entrar.
    */

    const [
        loading,
        setLoading,
    ] =
        useState(false);


    const [
        error,
        setError,
    ] =
        useState<string | null>(
            null
        );


    /* =====================================================
       SEARCH DOCUMENTS

       IMPORTANTE:

       - Si searchValue está vacío:
         NO SE HACE NINGÚN GET.

       - Solamente buscamos cuando el usuario escribe.
    ===================================================== */

    useEffect(
        () => {

            const cleanSearch =
                searchValue.trim();


            /* =============================================
               INPUT VACÍO

               NO CONSULTAR ADM CLOUD
               NO CONSULTAR BACKEND
            ============================================= */

            if (
                !cleanSearch
            ) {

                setDocuments(
                    []
                );


                setCurrentPage(
                    1
                );


                setError(
                    null
                );


                setLoading(
                    false
                );


                return;

            }


            /* =============================================
               ABORT CONTROLLER
            ============================================= */

            const controller =
                new AbortController();


            /* =============================================
               DEBOUNCE
            ============================================= */

            const timeout =
                window.setTimeout(
                    async () => {

                        try {

                            console.log("");

                            console.log(
                                "========================================"
                            );

                            console.log(
                                "🔄 BUSCANDO DOCUMENTO PARA DEVOLUCIÓN"
                            );

                            console.log(
                                "SEARCH:",
                                cleanSearch
                            );

                            console.log(
                                "========================================"
                            );


                            setLoading(
                                true
                            );


                            setError(
                                null
                            );


                            /*
                                MANTENGO TU ENDPOINT ACTUAL:

                                /inspection/search

                                Si después cambias el backend a:

                                /returns/search

                                solamente cambia esta URL.
                            */

                            const response =
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


                            console.log(
                                "📥 RETURN SEARCH RESPONSE:",
                                response.data
                            );


                            /* =====================================
                               VALIDATE RESPONSE
                            ===================================== */

                            if (
                                !response.data?.success
                            ) {

                                throw new Error(
                                    response.data?.message ||
                                    "No se pudo obtener el documento."
                                );

                            }


                            /* =====================================
                               DOCUMENTS
                            ===================================== */

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


                            /* =====================================
                               NORMALIZE
                            ===================================== */

                            const normalizedDocuments =
                                receivedDocuments.map(
                                    (
                                        document:
                                            BackendReturnDocument
                                    ) =>

                                        normalizeDocument(
                                            document
                                        )
                                );


                            /* =====================================
                               SORT
                            ===================================== */

                            const sortedDocuments =
                                sortDocuments(
                                    normalizedDocuments
                                );


                            /* =====================================
                               SAVE
                            ===================================== */

                            setDocuments(
                                sortedDocuments
                            );


                            setCurrentPage(
                                1
                            );


                        } catch (
                            error:
                                any
                        ) {


                            /* =====================================
                               CANCELLED REQUEST
                            ===================================== */

                            if (
                                error?.code ===
                                "ERR_CANCELED" ||

                                error?.name ===
                                "CanceledError" ||

                                error?.name ===
                                "AbortError"
                            ) {

                                return;

                            }


                            console.error(
                                "❌ ERROR BUSCANDO DEVOLUCIÓN:",
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

                                "No se pudo buscar la factura o conduce."
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

                    },

                    SEARCH_DELAY
                );


            /* =============================================
               CLEANUP
            ============================================= */

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

       AHORA NAVEGA A:

       /returns/factura/GUID

       o

       /returns/conduce/GUID
    ===================================================== */

    const handleDocumentClick =
        (
            document:
                ReturnDocument
        ) => {


            const guid =
                String(
                    document.erp_id
                ).trim();


            const tipo =
                document.tipo;


            console.log("");

            console.log(
                "========================================"
            );

            console.log(
                "🔄 DOCUMENTO PARA DEVOLUCIÓN"
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

            console.log(
                "========================================"
            );


            navigate(
                `/returns/${tipo.toLowerCase()}/${guid}`,
                {

                    state: {

                        guid,

                        tipo,

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
                ReturnStatus
        ) => {


            /* =========================================
               DESPACHADO
            ========================================= */

            if (
                status ===
                "DESPACHADO"
            ) {

                return (

                    <Truck
                        size={15}
                        strokeWidth={2.3}
                    />

                );

            }


            /* =========================================
               DEVUELTO PARCIALMENTE
            ========================================= */

            if (
                status ===
                "DEVUELTO_PARCIALMENTE"
            ) {

                return (

                    <RotateCcw
                        size={15}
                        strokeWidth={2.3}
                    />

                );

            }


            /* =========================================
               DEVUELTO COMPLETAMENTE
            ========================================= */

            return (

                <CheckCircle2
                    size={15}
                    strokeWidth={2.3}
                />

            );


        };


    /* =====================================================
       STATUS LABEL
    ===================================================== */

    const formatStatus =
        (
            status:
                ReturnStatus
        ) => {


            if (
                status ===
                "DESPACHADO"
            ) {

                return "Despachado";

            }


            if (
                status ===
                "DEVUELTO_PARCIALMENTE"
            ) {

                return "Devuelto Parcialmente";

            }


            return "Devuelto Completamente";

        };


    /* =====================================================
       STATUS CLASS
    ===================================================== */

    const getStatusClass =
        (
            status:
                ReturnStatus
        ) => {


            if (
                status ===
                "DESPACHADO"
            ) {

                return "inspection-status-despachado";

            }


            if (
                status ===
                "DEVUELTO_PARCIALMENTE"
            ) {

                return "inspection-status-devuelto-parcialmente";

            }


            return "inspection-status-devuelto-completamente";

        };


    /* =====================================================
       FLAGS
    ===================================================== */

    const hasSearch =
        searchValue
            .trim()
            .length >
        0;


    const hasDocuments =
        documents.length >
        0;


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

                        <RotateCcw
                            size={28}
                            strokeWidth={2.1}
                        />

                    </div>


                    <div className="inspection-heading-content">

                        <h1 className="inspection-title">

                            Devolución de Productos

                        </h1>


                        <p className="inspection-subtitle">

                            Busque una factura o conduce para iniciar una devolución

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

                        placeholder="Buscar número de factura o conduce..."

                        autoComplete="off"
                    />

                </div>


                {/* =============================================
                    PAGINATION

                    SOLO SE MUESTRA SI HAY RESULTADOS
                ============================================= */}

                {
                    hasDocuments && (

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

                    )
                }


            </section>


            {/* =================================================
                RESULTS CARD
            ================================================= */}

            <section className="inspection-table-card">


                {/* =================================================
                    ESTADO INICIAL

                    NO SE HACE NINGUNA BÚSQUEDA
                ================================================= */}

                {
                    !hasSearch

                        ? (

                            <div className="returns-empty-state">


                                <div className="returns-empty-icon-wrapper">

                                    <PackageOpen
                                        size={42}
                                        strokeWidth={1.7}
                                    />

                                </div>


                                <h2 className="returns-empty-title">

                                    Aún no hay nada que mostrar

                                </h2>


                                <p className="returns-empty-description">

                                    Ingrese el número de una factura o conduce
                                    para consultar los productos que pueden ser
                                    devueltos por el cliente.

                                </p>


                                <div className="returns-empty-search-hint">

                                    <Search
                                        size={16}
                                        strokeWidth={2}
                                    />

                                    <span>

                                        Utilice el buscador superior para comenzar

                                    </span>

                                </div>


                            </div>

                        )


                        /* =================================================
                           LOADING
                        ================================================= */

                        : loading

                            ? (

                                <div className="returns-empty-state">


                                    <div className="returns-loading-circle">

                                        <RotateCcw
                                            size={31}
                                            strokeWidth={2}
                                        />

                                    </div>


                                    <h2 className="returns-empty-title">

                                        Buscando documento...

                                    </h2>


                                    <p className="returns-empty-description">

                                        Estamos consultando la factura o conduce solicitado.

                                    </p>


                                </div>

                            )


                            /* =================================================
                               ERROR
                            ================================================= */

                            : error

                                ? (

                                    <div className="returns-empty-state">


                                        <div className="returns-empty-icon-wrapper returns-empty-error">

                                            <SearchX
                                                size={37}
                                                strokeWidth={1.8}
                                            />

                                        </div>


                                        <h2 className="returns-empty-title">

                                            No se pudo realizar la búsqueda

                                        </h2>


                                        <p className="returns-empty-description">

                                            {
                                                error
                                            }

                                        </p>


                                    </div>

                                )


                                /* =================================================
                                   NO RESULTS
                                ================================================= */

                                : currentDocuments.length ===
                                    0

                                    ? (

                                        <div className="returns-empty-state">


                                            <div className="returns-empty-icon-wrapper">

                                                <SearchX
                                                    size={38}
                                                    strokeWidth={1.7}
                                                />

                                            </div>


                                            <h2 className="returns-empty-title">

                                                Documento no encontrado

                                            </h2>


                                            <p className="returns-empty-description">

                                                No encontramos ninguna factura o conduce
                                                que coincida con

                                                {" "}

                                                <strong>

                                                    {searchValue.trim()}

                                                </strong>

                                                .

                                            </p>


                                            <span className="returns-empty-secondary">

                                                Verifique el número e inténtelo nuevamente.

                                            </span>


                                        </div>

                                    )


                                    /* =================================================
                                       TABLE
                                    ================================================= */

                                    : (

                                        <div className="inspection-table-container">


                                            <table className="inspection-table">


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


                                                                    {/* ID */}

                                                                    <td
                                                                        data-label="ID"
                                                                        className="inspection-id"
                                                                    >

                                                                        {
                                                                            document.id
                                                                        }

                                                                    </td>


                                                                    {/* TYPE */}

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


                                                                    {/* NUMBER */}

                                                                    <td
                                                                        data-label="Número"
                                                                        className="inspection-document-number"
                                                                    >

                                                                        {
                                                                            document.numero
                                                                        }

                                                                    </td>


                                                                    {/* DATE */}

                                                                    <td
                                                                        data-label="Fecha"
                                                                        className="inspection-date"
                                                                    >

                                                                        {
                                                                            document.fecha ||
                                                                            "-"
                                                                        }

                                                                    </td>


                                                                    {/* CLIENT */}

                                                                    <td
                                                                        data-label="Cliente"
                                                                        className="inspection-client"
                                                                    >

                                                                        {
                                                                            document.cliente ||
                                                                            "-"
                                                                        }

                                                                    </td>


                                                                    {/* LOCATION */}

                                                                    <td
                                                                        data-label="Ubicación"
                                                                        className="inspection-location"
                                                                    >

                                                                        {
                                                                            document.ubicacion ||
                                                                            "-"
                                                                        }

                                                                    </td>


                                                                    {/* ERP REFERENCE */}

                                                                    <td
                                                                        data-label="ERP Referencia"
                                                                        className="inspection-reference"
                                                                    >

                                                                        {
                                                                            document.erp_referencia ||
                                                                            "-"
                                                                        }

                                                                    </td>


                                                                    {/* STATUS */}

                                                                    <td
                                                                        data-label="Estatus"
                                                                        className="inspection-status-cell"
                                                                    >

                                                                        <span
                                                                            className={`
                                                                                inspection-status-pill
                                                                                ${getStatusClass(
                                                                                    document.devolucion_status
                                                                                )}
                                                                            `}
                                                                        >

                                                                            {
                                                                                getStatusIcon(
                                                                                    document.devolucion_status
                                                                                )
                                                                            }


                                                                            <span>

                                                                                {
                                                                                    formatStatus(
                                                                                        document.devolucion_status
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