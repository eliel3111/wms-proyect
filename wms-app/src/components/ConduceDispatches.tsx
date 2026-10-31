import {
    useEffect,
    useState
} from "react";

import {
    Truck,
    Warehouse
} from "lucide-react";

import apiClient from "../services/apiClient";

import {
    LoadingScreen
} from "../components/LoadingScreen";

import {
    MultiValueSearchInput
} from "../components/MultiValueSearchInput";

import {
    useModal
} from "../context/ModalContext";

import "../styles/conduce-dispatches.css";
import ConduceDispatchDetails from "../pages/ConduceDispatchDetails.tsx";

/* =========================================================
   TYPES
========================================================= */

interface Dispatch {

    id: number;

    erp_doc_id: string;

    erp_doc_date: string | null;

    erp_reference: string | null;

    erp_relationship_name: string | null;

    erp_location_id: string | number | null;

    warehouse_name: string | null;

}


/* =========================================================
   COMPONENT
========================================================= */

export default function ConduceDispatches() {

    const { openModal } =
        useModal();

const [selectedDispatch, setSelectedDispatch] =
    useState<Dispatch | null>(null);
    /* =====================================================
       STATES
    ===================================================== */

    const [
        data,
        setData
    ] = useState<Dispatch[]>([]);


    const [
        loading,
        setLoading
    ] = useState(true);


    const [
        searchValues,
        setSearchValues
    ] = useState<string[]>([]);


    const [
        page,
        setPage
    ] = useState(1);


    const [
        total,
        setTotal
    ] = useState(0);


    const limit = 10;


    /* =====================================================
       PAGINATION VALUES
    ===================================================== */

    const totalPages =
        Math.max(
            1,
            Math.ceil(
                total / limit
            )
        );


    const start =
        total === 0
            ? 0
            : (page - 1) * limit + 1;


    const end =
        Math.min(
            page * limit,
            total
        );


    /* =====================================================
       LOAD
    ===================================================== */

    useEffect(() => {

        fetchDispatches();

    }, [page]);


    /* =====================================================
       FETCH DISPATCHES
    ===================================================== */

    const fetchDispatches =
        async (
            values: string[] =
                searchValues
        ) => {

            try {

                setLoading(
                    true
                );


                console.log(
                    "🚚 Buscando conduces:",
                    values
                );


                const response =
                    await apiClient.get(
                        "/picking/monitor",
                        {
                            params: {

                                page,

                                limit,

                                search:
                                    values.join(",")

                            }
                        }
                    );


                const result =
                    response.data;


                if (!result.success) {

                    throw new Error(
                        result.message ||
                        "No se pudieron obtener los conduces."
                    );

                }


                setData(
                    result.data || []
                );


                setTotal(
                    Number(
                        result.total || 0
                    )
                );


            } catch (error: any) {

                console.error(
                    "❌ Error obteniendo conduces:",
                    error
                );


                setData(
                    []
                );


                setTotal(
                    0
                );


                openModal({
                    title:
                        error.response
                            ?.data
                            ?.title ||
                        "Error cargando conduces",

                    message:
                        error.response
                            ?.data
                            ?.message ||
                        error.message ||
                        "No se pudieron cargar los conduces."
                });


            } finally {

                setLoading(
                    false
                );

            }

        };


    /* =====================================================
       SEARCH
    ===================================================== */

    const handleSearchDispatches =
        (
            values: string[]
        ) => {

            console.log(
                "🔎 Buscar conduces:",
                values
            );


            setSearchValues(
                values
            );


            /*
             * Si ya estamos en página 1,
             * buscamos inmediatamente.
             *
             * Si estamos en otra página,
             * cambiar page dispara useEffect.
             */

            if (page === 1) {

                fetchDispatches(
                    values
                );

            } else {

                setPage(
                    1
                );

            }

        };


    /* =====================================================
       PREVIOUS PAGE
    ===================================================== */

    const goToPrevPage = () => {

        setPage(
            current =>
                Math.max(
                    1,
                    current - 1
                )
        );

    };


    /* =====================================================
       NEXT PAGE
    ===================================================== */

    const goToNextPage = () => {

        setPage(
            current =>
                Math.min(
                    totalPages,
                    current + 1
                )
        );

    };



// =====================================================
// ABRIR DETALLES DEL CONDUCE
// =====================================================

const handleOpenDispatch = (dispatch: Dispatch) => {

    console.log("📄 Abriendo conduce:", dispatch);

    setSelectedDispatch(dispatch);

};

    /* =====================================================
       FORMAT DATE
    ===================================================== */

    const formatDate =
        (
            value: string | null
        ) => {

            if (!value) {
                return "—";
            }


            const date =
                new Date(
                    value
                );


            if (
                Number.isNaN(
                    date.getTime()
                )
            ) {

                return value;

            }


            return date.toLocaleDateString(
                "es-DO",
                {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric"
                }
            );

        };


    /* =====================================================
       PAGINATION BUTTONS
    ===================================================== */

    const getPaginationPages =
        () => {

            if (
                totalPages <= 6
            ) {

                return Array.from(
                    {
                        length:
                            totalPages
                    },
                    (
                        _,
                        index
                    ) =>
                        index + 1
                );

            }


            if (
                page <= 4
            ) {

                return [
                    1,
                    2,
                    3,
                    4,
                    5,
                    "...",
                    totalPages
                ];

            }


            if (
                page >=
                totalPages - 3
            ) {

                return [
                    1,
                    "...",
                    totalPages - 4,
                    totalPages - 3,
                    totalPages - 2,
                    totalPages - 1,
                    totalPages
                ];

            }


            return [
                1,
                "...",
                page - 1,
                page,
                page + 1,
                "...",
                totalPages
            ];

        };

        // =====================================================
// MOSTRAR DETALLES DEL CONDUCE
// =====================================================

if (selectedDispatch) {

    return (

        <ConduceDispatchDetails

            dispatch={selectedDispatch}

            onBack={() => {

                console.log("⬅️ Volviendo a la lista de conduces");

                setSelectedDispatch(null);

            }}

        />

    );

}

    /* =====================================================
       RETURN
    ===================================================== */

    return (

        <div className="dispatch-monitor-page">


            {/* =================================================
                HEADER
            ================================================= */}

            <div className="dispatch-monitor-banner">

                <div className="dispatch-monitor-title-group">

                    <div className="dispatch-monitor-eyebrow">

                        Pantalla Monitor

                    </div>


                    <h1 className="dispatch-monitor-title">

                        Conduce de Despachos

                    </h1>

                </div>


                <div className="dispatch-monitor-truck">

                    <Truck
                        size={41}
                        strokeWidth={1.8}
                    />

                </div>

            </div>


            {/* =================================================
                MAIN CARD
            ================================================= */}

            <section className="dispatch-monitor-card">


                {/* =============================================
                    CARD HEADER
                ============================================= */}

                <div className="dispatch-monitor-card-header">

                    <div>

                        <h2>

                            Conduces de Despacho

                        </h2>

                        <p>

                            Consulta los conduces creados en ADM Cloud.

                        </p>

                    </div>


                    <div className="dispatch-monitor-search">

                        <MultiValueSearchInput
                            values={
                                searchValues
                            }

                            onChange={
                                setSearchValues
                            }

                            onSearch={
                                handleSearchDispatches
                            }

                            width="470px"

                            placeholder="Buscar conduces..."

                            autoFocus
                        />

                    </div>

                </div>


                {/* =============================================
                    TABLE
                ============================================= */}

                <div className="dispatch-monitor-table">


                    {/* HEADER */}

                    <div className="dispatch-monitor-row dispatch-monitor-row-header">

                        <div>
                            Número
                        </div>

                        <div>
                            Fecha
                        </div>

                        <div>
                            Referencia
                        </div>

                        <div>
                            Cliente
                        </div>

                        <div>
                            Ubicación
                        </div>

                    </div>


                    {/* BODY */}

                    <div className="dispatch-monitor-table-body">

                        {loading ? (

                            <div className="dispatch-monitor-loading">

                                <LoadingScreen />

                            </div>

                        ) : data.length === 0 ? (

                            <div className="dispatch-monitor-empty">

                                <Truck
                                    size={42}
                                    strokeWidth={1.5}
                                />


                                <strong>

                                    No se encontraron conduces

                                </strong>


                                <span>

                                    Intenta realizar otra búsqueda.

                                </span>

                            </div>

                        ) : (

                            data.map(
                                dispatch => (

                                    <div
                                        key={
                                            dispatch.id
                                        }

                                        className="dispatch-monitor-row"
                                    >


                                        {/* ======================
                                            NUMERO / LINK
                                        ====================== */}

                                        <div>

                                            <button
                                                type="button"

                                                className="dispatch-monitor-number"

                                                onClick={() =>
                                                    handleOpenDispatch(
                                                        dispatch
                                                    )
                                                }
                                            >

                                                {
                                                    dispatch.erp_doc_id
                                                }

                                            </button>

                                        </div>


                                        {/* ======================
                                            FECHA
                                        ====================== */}

                                        <div className="dispatch-monitor-date">

                                            {
                                                formatDate(
                                                    dispatch.erp_doc_date
                                                )
                                            }

                                        </div>


                                        {/* ======================
                                            REFERENCIA
                                        ====================== */}

                                        <div className="dispatch-monitor-reference">

                                            {
                                                dispatch.erp_reference ||
                                                "—"
                                            }

                                        </div>


                                        {/* ======================
                                            CLIENTE
                                        ====================== */}

                                        <div className="dispatch-monitor-client">

                                            {
                                                dispatch.erp_relationship_name ||
                                                "—"
                                            }

                                        </div>


                                        {/* ======================
                                            UBICACION
                                        ====================== */}

                                        <div className="dispatch-monitor-location">

                                            <span className="dispatch-monitor-location-icon">

                                                <Warehouse
                                                    size={18}
                                                    strokeWidth={1.8}
                                                />

                                            </span>


                                            <span>

                                                {
                                                    dispatch.warehouse_name ||
                                                    `Almacén ${dispatch.erp_location_id ?? ""}`
                                                }

                                            </span>

                                        </div>

                                    </div>

                                )
                            )

                        )}

                    </div>

                </div>


                {/* =============================================
                    FOOTER / PAGINATION
                ============================================= */}

                {!loading &&
                    total > 0 && (

                        <div className="dispatch-monitor-footer">


                            <div className="dispatch-monitor-results">

                                Mostrando{" "}

                                <strong>
                                    {start}
                                </strong>

                                {" - "}

                                <strong>
                                    {end}
                                </strong>

                                {" de "}

                                <strong>
                                    {total}
                                </strong>

                                {" conduces"}

                            </div>


                            <div className="dispatch-monitor-pagination">


                                <button
                                    type="button"

                                    className="dispatch-page-button"

                                    disabled={
                                        page === 1
                                    }

                                    onClick={
                                        goToPrevPage
                                    }
                                >

                                    ‹

                                </button>


                                {
                                    getPaginationPages()
                                        .map(
                                            (
                                                value,
                                                index
                                            ) => {

                                                if (
                                                    value ===
                                                    "..."
                                                ) {

                                                    return (

                                                        <span
                                                            key={
                                                                `ellipsis-${index}`
                                                            }

                                                            className="dispatch-page-ellipsis"
                                                        >

                                                            …

                                                        </span>

                                                    );

                                                }


                                                return (

                                                    <button
                                                        key={
                                                            value
                                                        }

                                                        type="button"

                                                        className={`
                                                            dispatch-page-button
                                                            ${
                                                                page ===
                                                                value
                                                                    ? "active"
                                                                    : ""
                                                            }
                                                        `}

                                                        onClick={() =>
                                                            setPage(
                                                                Number(
                                                                    value
                                                                )
                                                            )
                                                        }
                                                    >

                                                        {
                                                            value
                                                        }

                                                    </button>

                                                );

                                            }
                                        )
                                }


                                <button
                                    type="button"

                                    className="dispatch-page-button"

                                    disabled={
                                        page ===
                                        totalPages
                                    }

                                    onClick={
                                        goToNextPage
                                    }
                                >

                                    ›

                                </button>

                            </div>

                        </div>

                    )}

            </section>

        </div>

    );

}