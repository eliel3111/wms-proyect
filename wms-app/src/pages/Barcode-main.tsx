
import {
    useState,
    useRef,
    useEffect
} from "react";
import "../styles/Barcode.css"
import "../styles/Barcode.bluetooth.css";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import {
    Search,
    Printer,
    X,
    Plus,
    Minus,
    Check,
    MapPin,
    ChevronDown,
    ChevronUp,
    Package,
} from "lucide-react";
import { getPrinterKind, printLabel, setPrinterKind, type PrinterKind } from "../services/labelPrinter.ts";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import { FaCubes } from "react-icons/fa6";
import { useAuth } from "../context/AuthProvider.tsx";


export interface Product {
    id: string;
    sku: string;
    description: string;
    erp_sku: string | null;
    erp_id: string | null;
    erp_name: string | null;
    supplier_barcode: string | null;
    total_qty_on_hand: number;
    locations: ProductLocation[];
}


interface ProductLocation {
    location_id: number;
    location_code: string;
    qty_on_hand: number;
    warehouse_id: string;
    is_active: boolean;
}


interface InventoryLocationOption {

    location_id: number;

    location_code: string;

    warehouse_id: string;

    description: string | null;

    is_active: boolean;

    location_type: string | null;

    tramo: number | null;

    nivel: number | null;

}



type PrintType = "internal" | "supplier";


export default function BarcodePage() {


    const { openModal } = useModal();

    const { can } =
        useAuth();


    const canAdjustStock =
        can(
            "inventory.adjust_stock"
        );


    const [value, setValue] = useState("");
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
    const [selectedLocation, setSelectedLocation] =
        useState<ProductLocation | null>(null);
    const [adjustQty, setAdjustQty] = useState("");


    // ==========================================================
    // AGREGAR STOCK EN NUEVA UBICACIÓN
    // ==========================================================

    const [
        isAddStockOpen,
        setIsAddStockOpen
    ] = useState(false);


    const [
        availableLocations,
        setAvailableLocations
    ] = useState<InventoryLocationOption[]>([]);



    const [
        locationSearchLoading,
        setLocationSearchLoading
    ] = useState(false);


    const [
        locationSearchMessage,
        setLocationSearchMessage
    ] = useState("");

    const [
        newStockLocation,
        setNewStockLocation
    ] = useState<InventoryLocationOption | null>(null);


    const [
        locationSearch,
        setLocationSearch
    ] = useState("");


    const [
        isLocationSelectOpen,
        setIsLocationSelectOpen
    ] = useState(false);


    const [
        newStockQty,
        setNewStockQty
    ] = useState("1");


    const [
        savingNewStock,
        setSavingNewStock
    ] = useState(false);

    // ==========================================
    // PRODUCTO SELECCIONADO
    // ==========================================

    const productSelectedFromProducts = products.find(
        (product) => product.id === selectedProduct?.id
    );


    // ==========================================
    // UBICACIONES DEL PRODUCTO
    // ==========================================

    const stockLocations =
        productSelectedFromProducts?.locations ?? [];


    // ==========================================
    // STOCK TOTAL
    // ==========================================

    const totalStock =
        productSelectedFromProducts?.total_qty_on_hand ?? 0;


    /* =========================================================
SEARCH LOCATIONS
DEBOUNCE + CANCEL REQUEST
========================================================= */

    useEffect(() => {

        /*
         * Solo buscar cuando estamos dentro
         * de la pantalla Registrar Stock.
         */

        if (!isAddStockOpen) {
            return;
        }


        /*
         * Solo buscar si el selector
         * está abierto.
         */

        if (!isLocationSelectOpen) {
            return;
        }


        const search =
            locationSearch.trim();


        /* =====================================================
           INPUT VACÍO
        ===================================================== */

        if (!search) {

            setAvailableLocations([]);

            setLocationSearchMessage("");

            setLocationSearchLoading(false);

            return;

        }


        /*
         * Controlador para cancelar
         * la request anterior.
         */

        const controller =
            new AbortController();


        /*
         * Debounce:
         *
         * El backend solo recibe la búsqueda
         * si el usuario deja de escribir
         * durante 300ms.
         */

        const timeoutId =
            window.setTimeout(
                async () => {

                    try {

                        setLocationSearchLoading(
                            true
                        );

                        setLocationSearchMessage(
                            ""
                        );


                        /* =========================================
                           EXCLUIR UBICACIONES ACTUALES
                        ========================================= */

                        const excludeIds =
                            stockLocations
                                .map(
                                    location =>
                                        location.location_id
                                )
                                .join(",");


                        /* =========================================
                           REQUEST
                        ========================================= */

                        const response =
                            await apiClient.get(
                                "/barcode/locations/search",
                                {
                                    params: {

                                        q:
                                            search,

                                        excludeIds:
                                            excludeIds ||
                                            undefined

                                    },

                                    signal:
                                        controller.signal
                                }
                            );


                        const result =
                            response.data;


                        if (!result.success) {

                            throw new Error(
                                result.message ||
                                "No se pudieron buscar las ubicaciones."
                            );

                        }


                        const locations:
                            InventoryLocationOption[] =
                            result.data || [];


                        setAvailableLocations(
                            locations
                        );


                        /* =========================================
                           NO EXISTE
                        ========================================= */

                        if (
                            locations.length === 0
                        ) {

                            setLocationSearchMessage(

                                result.message ||

                                `No existe una ubicación que contenga "${search}".`

                            );

                        } else {

                            setLocationSearchMessage(
                                ""
                            );

                        }


                    } catch (error: any) {

                        /*
                         * Si fue cancelada porque el usuario
                         * siguió escribiendo, NO es un error.
                         */

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
                            "❌ Error buscando ubicaciones:",
                            error
                        );


                        setAvailableLocations(
                            []
                        );


                        setLocationSearchMessage(
                            ""
                        );


                        /*
                         * Tu modal global de errores.
                         */

                        openModal({
                            title:
                                error.response
                                    ?.data
                                    ?.title ||
                                "Error buscando ubicación",

                            message:
                                error.response
                                    ?.data
                                    ?.message ||
                                error.message ||
                                "No se pudieron cargar las ubicaciones."
                        });

                    } finally {

                        if (
                            !controller.signal.aborted
                        ) {

                            setLocationSearchLoading(
                                false
                            );

                        }

                    }

                },
                300
            );


        /* =====================================================
           CLEANUP
    
           Si escribe otra letra antes de 300ms:
           - cancela timer
           - cancela HTTP anterior
        ===================================================== */

        return () => {

            window.clearTimeout(
                timeoutId
            );

            controller.abort();

        };


    }, [
        locationSearch,
        isAddStockOpen,
        isLocationSelectOpen,
        stockLocations,
        openModal
    ]);


    const handleOpenLocation = (
        location: ProductLocation
    ) => {

        if (!canAdjustStock) {
            return;
        }


        setSelectedLocation(
            location
        );


        setAdjustQty(
            String(
                location.qty_on_hand ?? 0
            )
        );

    };

    const [activeTab, setActiveTab] = useState<"print" | "manual">("manual");
    const isSupplierDisabled = !selectedProduct?.supplier_barcode;
    const [supplierCode, setSupplierCode] = useState("");

    const [loading, setLoading] = useState(false);
    const [printType, setPrintType] = useState<PrintType>("internal");
    const [quantity, setQuantity] = useState("");

    // Impresora elegida por este dispositivo (PDA Bluetooth / PC Zebra).
    const [printerKind, setPrinterKindState] = useState<PrinterKind>(getPrinterKind);
    const [printing, setPrinting] = useState(false);

    function changePrinterKind(kind: PrinterKind) {
        if (printing) return;
        setPrinterKind(kind);
        setPrinterKindState(kind);
    }


    const inputRef = useRef<HTMLInputElement>(null);
    const handleClear = () => {
        setValue("");
        setProducts([]);
        setTimeout(() => {
            inputRef.current?.focus();
        }, 0);
    };


    const [isClosing, setIsClosing] = useState(false);
    const handleCloseProductModal = () => {
        setIsClosing(true);

        setTimeout(() => {
            handleReset();
            setIsClosing(false);
        }, 220);
    };



    async function handleSearch() {

        if (!value.trim()) {
            return;
        }


        try {

            setLoading(true);


            console.log(
                "🔍 Buscando:",
                value
            );


            const res =
                await apiClient.post(
                    "/barcode/products/search",
                    {
                        text:
                            value,
                    }
                );


            console.log(
                "✅ Result:",
                res.data
            );


            setProducts(
                res.data.data || []
            );


            inputRef.current?.blur();


            if (
                !res.data.data ||
                res.data.data.length === 0
            ) {

                openModal({
                    title:
                        "Producto no encontrado",

                    message:
                        "No se encontró el producto escaneado.",
                });

            }


        } catch (error: any) {

            console.error(
                "❌ Error buscando producto:",
                error
            );


            console.log(
                "🔥 BACKEND RESPONSE:",
                error.response?.data
            );


            openModal({
                title:
                    error.response?.data?.title ||
                    "Error buscando producto",

                message:
                    error.response?.data?.message ||
                    error.message ||
                    "No se pudo buscar el producto.",
            });


        } finally {

            // MUY IMPORTANTE
            setLoading(false);

        }

    }


    async function handleSaveSupplierCode() {
        try {
            if (!selectedProduct?.id) {
                console.warn("❌ No hay producto seleccionado");
                return;
            }

            if (!supplierCode.trim()) {
                console.warn("❌ Código vacío");
                return;
            }

            console.log("🚀 Enviando:", {
                id: selectedProduct.id,
                barcode: supplierCode
            });

            const res = await apiClient.post("/barcode/supplierCode", {
                id: selectedProduct.id,
                barcode: supplierCode, // 👈 importante
            });

            console.log("✅ Guardado:", res.data);

            openModal({
                title: "",
                message: res.data.message
            });
            // 🔥 opcional: limpiar o feedback
            // setSupplierCode("");
            // alert("Guardado correctamente");

        } catch (error: any) {
            console.error("❌ Error guardando:", error);

            if (error.response) {
                console.log("🔥 BACKEND DATA:", error.response.data);

                openModal({
                    title: error.response.data.title,
                    message: error.response.data.message
                });

            } else {
                console.log("❌ Error sin response:", error.message);
            }
        }
    }

    async function refreshCurrentSearch() {
        try {
            if (!value.trim()) return;

            console.log("🔄 Actualizando búsqueda:", value);

            const res = await apiClient.post("/barcode/products/search", {
                text: value,
            });

            setProducts(res.data.data);

            console.log("✅ Búsqueda actualizada:", res.data.data);

        } catch (error) {
            console.error("❌ Error actualizando búsqueda:", error);
        }
    }

    async function handleReset() {

        setSelectedProduct(null);

        setSelectedLocation(null);

        setActiveTab("manual");

        setPrintType("internal");

        setQuantity("");

        setSupplierCode("");

        setAdjustQty("");


        // =========================================
        // RESET ADD STOCK
        // =========================================

        setIsAddStockOpen(false);

        setNewStockLocation(null);

        setLocationSearch("");

        setNewStockQty("1");

        setIsLocationSelectOpen(false);


        await refreshCurrentSearch();

    }


    const handleOpenAddStock = () => {

        console.log(
            "🟢 ABRIENDO REGISTRAR STOCK"
        );


        setNewStockLocation(
            null
        );


        setLocationSearch(
            ""
        );


        setAvailableLocations(
            []
        );


        setLocationSearchMessage(
            ""
        );


        setNewStockQty(
            "1"
        );


        setIsLocationSelectOpen(
            false
        );


        setIsAddStockOpen(
            true
        );

    };


    const handleCloseAddStock = () => {

        setIsAddStockOpen(
            false
        );


        setNewStockLocation(
            null
        );


        setLocationSearch(
            ""
        );


        setAvailableLocations(
            []
        );


        setLocationSearchMessage(
            ""
        );


        setNewStockQty(
            "1"
        );


        setIsLocationSelectOpen(
            false
        );

    };


    // ==========================================================
    // IMPRESIÓN ZEBRA / NIIMBOT BLUETOOTH
    //
    // No hacer ninguna petición HTTP ni setTimeout antes de
    // printLabel(): Web Bluetooth requiere un gesto del usuario.
    // La plantilla ZPL original vive en labelPrinter.ts.
    // ==========================================================
    async function handlePrint() {
        if (!selectedProduct || printing) return;

        const code = printType === "internal"
            ? selectedProduct.sku
            : selectedProduct.supplier_barcode;

        if (!code?.trim()) {
            openModal({
                title: "Código de barras requerido",
                message: "El producto no tiene el código de barras seleccionado.",
            });
            return;
        }

        const qty = quantity.trim() === "" ? 1 : Number(quantity);
        if (!Number.isSafeInteger(qty) || qty < 1 || qty > 100) {
            openModal({
                title: "Cantidad inválida",
                message: "Introduzca una cantidad entera entre 1 y 100 etiquetas.",
            });
            return;
        }

        setPrinting(true);

        try {
            // Se ejecuta inmediatamente desde onClick, sin await previos.
            await printLabel(
                selectedProduct.description,
                code,
                selectedProduct.erp_name || "",
                selectedProduct.erp_sku || "",
                qty,
                printerKind
            );
            console.log(`✅ Enviadas ${qty} etiquetas a ${printerKind}`);
        } catch (error: unknown) {
            console.error("❌ Error imprimiendo:", error);
            openModal({
                title: "No se pudo imprimir",
                message: error instanceof Error
                    ? error.message
                    : "Verifique la impresora y vuelva a intentarlo.",
            });
        } finally {
            setPrinting(false);
        }
    }


    const handleSaveInventoryAdjustment = async () => {
        try {
            if (!selectedLocation || !selectedProduct) return;

            const newQty = Number(adjustQty);

            if (Number.isNaN(newQty) || newQty < 0) {
                openModal({
                    title: "Cantidad inválida",
                    message: "La cantidad debe ser un número mayor o igual a 0.",
                });

                return;
            }

            const res = await apiClient.post("/inventory/adjust", {
                location_id: selectedLocation.location_id,
                warehouse_id: selectedLocation.warehouse_id,
                product_sku: selectedProduct.sku,
                product_id: selectedProduct.id,
                new_qty: newQty,
            });

            console.log("RESPUESTA AJUSTE:", res.data);

            openModal({
                title: res.data.title,
                message: res.data.message,
            });

            if (res.data.success) {
                handleReset();
            }

        } catch (error: any) {
            console.error("Error ajustando inventario:", error);

            openModal({
                title:
                    error.response?.data?.title ||
                    "Error ajustando inventario",

                message:
                    error.response?.data?.message ||
                    "No se pudo actualizar el inventario.",
            });
        }
    };


    const handleSaveNewLocationStock =
        async () => {

            try {

                if (
                    !selectedProduct ||
                    !newStockLocation
                ) {

                    openModal({
                        title: "Ubicación requerida",
                        message:
                            "Seleccione una ubicación antes de guardar.",
                    });

                    return;
                }


                const parsedQty =
                    Number(newStockQty);


                if (
                    !Number.isFinite(parsedQty) ||
                    parsedQty <= 0
                ) {

                    openModal({
                        title: "Cantidad inválida",
                        message:
                            "La cantidad debe ser mayor que 0.",
                    });

                    return;
                }


                setSavingNewStock(true);


                const response =
                    await apiClient.post(
                        "/inventory/add-location-stock",
                        {
                            warehouse_id:
                                newStockLocation.warehouse_id,

                            location_id:
                                newStockLocation.location_id,

                            product_sku:
                                selectedProduct.sku,

                            new_qty:
                                parsedQty,
                        }
                    );


                const result =
                    response.data;


                if (!result.success) {

                    throw new Error(
                        result.message ||
                        "No se pudo agregar el inventario."
                    );

                }


                // =========================================
                // REFRESCAR PRODUCTO Y UBICACIONES
                // =========================================

                await refreshCurrentSearch();


                // =========================================
                // CERRAR VISTA DE AGREGAR STOCK
                // =========================================

                handleCloseAddStock();


                // =========================================
                // SUCCESS MODAL
                // =========================================

                openModal({
                    title:
                        result.title ||
                        "Inventario agregado",

                    message:
                        result.message ||
                        "El stock fue agregado correctamente.",
                });


            } catch (error: any) {

                console.error(
                    "❌ Error agregando stock:",
                    error
                );


                openModal({
                    title:
                        error.response?.data?.title ||
                        "Error agregando stock",

                    message:
                        error.response?.data?.message ||
                        error.message ||
                        "No se pudo agregar el inventario.",
                });


            } finally {

                setSavingNewStock(false);

            }

        };

    if (loading) {
        return <LoadingScreen />;
    }



    return (
        <div
            className=" barcode-container"

        >
            <div className="barcode-section-search">
                <div className="section-content">

                    <div
                        className="barcode-search-dark"
                        onClick={() => {
                            inputRef.current?.focus();
                        }}
                    >
                        <Search
                            size={25}
                            color="#d0b112"
                            strokeWidth={2.5}
                        />

                        <input
                            type="text"
                            value={value}
                            ref={inputRef}
                            placeholder="Buscar producto, codigo de barra o descripcion..."
                            onChange={(e) => {
                                const newValue = e.target.value;
                                setValue(newValue);

                                // 👇 OPCIONAL: búsqueda automática (tipo Google)
                                // handleSearch();  <-- cuidado: esto hace muchas llamadas
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    handleSearch();
                                }
                            }}
                        />

                        {value && (
                            <button
                                className="clear"
                                onClick={(e) => {
                                    e.stopPropagation(); // 🔥 evita que el click suba al div
                                    handleClear();
                                }}
                            >
                                ✕
                            </button>
                        )}
                    </div>

                </div>
            </div>

            <div className="section">

                {products.length === 0 && (
                    <div className="empty-state">
                        <Printer size={180} strokeWidth={1.5} />
                        <p>Escanea o busca un producto</p>
                    </div>
                )}

                <div className="barcode-container-grid">


                    {products.map((p) => (
                        <div
                            key={p.id}
                            className="barcode-product-card"
                            onClick={() => setSelectedProduct(p)}
                        >
                            <div className="barcode-description">
                                {p.erp_name}<br />
                                {p.description}<br />
                                {p.erp_sku}<br />
                                {p.erp_id}
                            </div>

                            <div className="barcode-card-bottom">

                                <div className="barcode-details">
                                    <div>
                                        Codigo Interno: {p.sku ?? "-"}
                                    </div>

                                    {p.supplier_barcode && (
                                        <div>
                                            Codigo de Proveedor: {p.supplier_barcode}
                                        </div>
                                    )}
                                </div>

                                {p.total_qty_on_hand > 0 && (
                                    <div className="product-stock">
                                        <div className="product-stock-icon">
                                            ✓
                                        </div>

                                        <div className="product-stock-info">
                                            <span className="product-stock-label">
                                                Stock disponible
                                            </span>

                                            <span className="product-stock-quantity">
                                                {p.total_qty_on_hand ?? 0} unidades
                                            </span>
                                        </div>
                                    </div>
                                )}


                            </div>
                        </div>
                    ))}
                </div>

            </div>
            <div style={{
                position: "fixed",
                bottom: 0,
                left: 0,
                background: "red",
                color: "white",
                zIndex: 9999,
                fontSize: "12px"
            }}>
                {`scroll: ${document.body.scrollHeight} / screen: ${window.innerHeight}`}
            </div>

            {selectedProduct && (

                <div
                    className={`
            barcode-modal-overlay
            ${isClosing ? "closing" : ""}
        `}
                    onClick={handleCloseProductModal}
                >

                    <div
                        className={`
                barcode-modal-container
                ${isClosing ? "closing" : ""}
            `}
                        onClick={(e) => e.stopPropagation()}
                    >


                        {/* =====================================================
                VISTA 1
                AGREGAR STOCK EN OTRA UBICACIÓN
            ===================================================== */}

                        {isAddStockOpen ? (

                            <div className="barcode-add-stock-view">


                                {/* =============================================
                        HEADER
                    ============================================= */}

                                <div className="barcode-add-stock-header">

                                    <div className="barcode-add-stock-header-left">

                                        <div className="barcode-add-stock-header-icon">

                                            <Package
                                                size={27}
                                                strokeWidth={1.9}
                                            />

                                        </div>


                                        <div className="barcode-add-stock-heading">

                                            <h2>
                                                Registrar stock
                                            </h2>

                                            <p>
                                                Seleccione la ubicación y la cantidad.
                                            </p>

                                        </div>

                                    </div>


                                    <button
                                        type="button"
                                        className="barcode-add-stock-close"
                                        onClick={handleCloseAddStock}
                                        aria-label="Cerrar"
                                    >

                                        <X
                                            size={26}
                                            strokeWidth={2}
                                        />

                                    </button>

                                </div>


                                {/* =============================================
                        BODY
                    ============================================= */}

                                <div className="barcode-add-stock-body">


                                    {/* =========================================
                            PRODUCTO
                        ========================================= */}

                                    <div className="barcode-add-stock-product">

                                        <span className="barcode-add-stock-product-label">
                                            Producto
                                        </span>


                                        <span className="barcode-add-stock-product-sku">

                                            {selectedProduct.sku}

                                        </span>


                                        <span className="barcode-add-stock-product-description">

                                            {
                                                selectedProduct.erp_name ||
                                                selectedProduct.description
                                            }

                                        </span>

                                    </div>


                                    {/* =========================================
                            UBICACIÓN
                        ========================================= */}

                                    <div className="barcode-add-stock-field">

                                        <label className="barcode-add-stock-label">

                                            Ubicación

                                            <span>
                                                *
                                            </span>

                                        </label>


                                        <div
                                            className={`
                                    barcode-add-location-select
                                    ${isLocationSelectOpen
                                                    ? "open"
                                                    : ""
                                                }
                                `}
                                        >

                                            <MapPin
                                                className="barcode-add-location-main-icon"
                                                size={22}
                                                strokeWidth={2}
                                            />


                                            <input
                                                type="text"
                                                value={locationSearch}
                                                placeholder="Buscar ubicación..."
                                                autoComplete="off"

                                                onFocus={() => {

                                                    setIsLocationSelectOpen(
                                                        true
                                                    );

                                                }}

                                                onChange={(e) => {

                                                    setLocationSearch(
                                                        e.target.value
                                                    );

                                                    setNewStockLocation(
                                                        null
                                                    );

                                                    setIsLocationSelectOpen(
                                                        true
                                                    );

                                                }}
                                            />


                                            <button
                                                type="button"
                                                className="barcode-add-location-toggle"

                                                onClick={() => {

                                                    setIsLocationSelectOpen(
                                                        current =>
                                                            !current
                                                    );

                                                }}
                                            >

                                                {
                                                    isLocationSelectOpen
                                                        ? (

                                                            <ChevronUp
                                                                size={21}
                                                                strokeWidth={2}
                                                            />

                                                        )
                                                        : (

                                                            <ChevronDown
                                                                size={21}
                                                                strokeWidth={2}
                                                            />

                                                        )
                                                }

                                            </button>


                                            {/* =================================
                                    OPCIONES
                                ================================= */}

                                            {isLocationSelectOpen && (

                                                <div className="barcode-add-location-options">


                                                    {/* =========================================
            INPUT VACÍO
        ========================================= */}

                                                    {!locationSearch.trim() && (

                                                        <div className="barcode-add-location-empty">

                                                            Escriba un código de ubicación

                                                        </div>

                                                    )}


                                                    {/* =========================================
            LOADING
        ========================================= */}

                                                    {locationSearch.trim() &&
                                                        locationSearchLoading && (

                                                            <div className="barcode-add-location-empty">

                                                                Buscando ubicación...

                                                            </div>

                                                        )}


                                                    {/* =========================================
            NO EXISTE
        ========================================= */}

                                                    {locationSearch.trim() &&
                                                        !locationSearchLoading &&
                                                        availableLocations.length === 0 &&
                                                        locationSearchMessage && (

                                                            <div className="barcode-add-location-empty">

                                                                {locationSearchMessage}

                                                            </div>

                                                        )}


                                                    {/* =========================================
            RESULTS
        ========================================= */}

                                                    {!locationSearchLoading &&

                                                        availableLocations.map(
                                                            location => {

                                                                const isSelected =
                                                                    newStockLocation
                                                                        ?.location_id ===
                                                                    location.location_id;


                                                                return (

                                                                    <button
                                                                        key={
                                                                            location.location_id
                                                                        }

                                                                        type="button"

                                                                        className={`
                                barcode-add-location-option
                                ${isSelected
                                                                                ? "selected"
                                                                                : ""
                                                                            }
                            `}

                                                                        onClick={() => {

                                                                            setNewStockLocation(
                                                                                location
                                                                            );


                                                                            setLocationSearch(
                                                                                location.location_code
                                                                            );


                                                                            setIsLocationSelectOpen(
                                                                                false
                                                                            );

                                                                        }}
                                                                    >

                                                                        <MapPin
                                                                            size={19}
                                                                            strokeWidth={2}
                                                                        />


                                                                        <span>

                                                                            {
                                                                                location.location_code
                                                                            }

                                                                        </span>


                                                                        {isSelected && (

                                                                            <Check
                                                                                className="barcode-add-location-check"
                                                                                size={19}
                                                                                strokeWidth={2.3}
                                                                            />

                                                                        )}

                                                                    </button>

                                                                );

                                                            }
                                                        )
                                                    }

                                                </div>

                                            )}
                                        </div>

                                    </div>


                                    {/* =========================================
                            CANTIDAD
                        ========================================= */}

                                    <div className="barcode-add-stock-field">

                                        <label className="barcode-add-stock-label">

                                            Cantidad

                                            <span>
                                                *
                                            </span>

                                        </label>


                                        <div className="barcode-add-stock-quantity">


                                            {/* RESTAR */}

                                            <button
                                                type="button"
                                                className="barcode-add-qty-button"

                                                onClick={() => {

                                                    const currentQty =
                                                        Number(
                                                            newStockQty || 1
                                                        );


                                                    setNewStockQty(

                                                        String(
                                                            Math.max(
                                                                1,
                                                                currentQty - 1
                                                            )
                                                        )

                                                    );

                                                }}
                                            >

                                                <Minus
                                                    size={23}
                                                    strokeWidth={2}
                                                />

                                            </button>


                                            {/* INPUT */}

                                            <input
                                                type="number"
                                                min={1}
                                                inputMode="numeric"

                                                value={newStockQty}

                                                onChange={(e) => {

                                                    setNewStockQty(
                                                        e.target.value
                                                    );

                                                }}

                                                onFocus={(e) => {

                                                    e.currentTarget.select();

                                                }}
                                            />


                                            {/* SUMAR */}

                                            <button
                                                type="button"
                                                className="barcode-add-qty-button"

                                                onClick={() => {

                                                    const currentQty =
                                                        Number(
                                                            newStockQty || 0
                                                        );


                                                    setNewStockQty(

                                                        String(
                                                            currentQty + 1
                                                        )

                                                    );

                                                }}
                                            >

                                                <Plus
                                                    size={24}
                                                    strokeWidth={2}
                                                />

                                            </button>

                                        </div>

                                    </div>

                                </div>


                                {/* =============================================
                        FOOTER
                    ============================================= */}

                                <div className="barcode-add-stock-footer">

                                    <button
                                        type="button"
                                        className="barcode-add-stock-cancel"
                                        onClick={handleCloseAddStock}
                                    >

                                        Cancelar

                                    </button>


                                    <button
                                        type="button"
                                        className="barcode-add-stock-save"

                                        onClick={
                                            handleSaveNewLocationStock
                                        }

                                        disabled={
                                            !newStockLocation ||
                                            Number(newStockQty) <= 0 ||
                                            savingNewStock
                                        }
                                    >

                                        <Check
                                            size={21}
                                            strokeWidth={2.3}
                                        />


                                        <span>

                                            {
                                                savingNewStock
                                                    ? "Guardando..."
                                                    : "Guardar"
                                            }

                                        </span>

                                    </button>

                                </div>

                            </div>

                        ) : (

                            /* =================================================
                                VISTA 2
                                MODAL NORMAL DEL PRODUCTO
                            ================================================= */

                            <>


                                {/* =============================================
                        HEADER NORMAL
                    ============================================= */}

                                <div className="barcode-container-header">


                                    <div className="barcode-header-left">


                                        {/* IMPRIMIR */}

                                        <div
                                            className={`
                                    barcode-tab
                                    barcode-print-tab
                                    ${activeTab === "print"
                                                    ? "active"
                                                    : ""
                                                }
                                `}
                                            onClick={() =>
                                                setActiveTab("print")
                                            }
                                        >

                                            <Printer
                                                size={24}
                                                strokeWidth={1.5}
                                            />

                                            Imprimir

                                        </div>


                                        {/* INTRODUCIR */}

                                        <div
                                            className={`
                                    barcode-tab
                                    ${activeTab === "manual"
                                                    ? "active"
                                                    : ""
                                                }
                                `}
                                            onClick={() =>
                                                setActiveTab("manual")
                                            }
                                        >

                                            <Plus
                                                size={24}
                                                strokeWidth={2.5}
                                            />

                                            Introducir

                                        </div>

                                    </div>


                                    <div className="barcode-header-right">

                                        <button
                                            type="button"
                                            className="barcode-close-btn"
                                            onClick={
                                                handleCloseProductModal
                                            }
                                        >

                                            <X
                                                size={26}
                                                strokeWidth={3}
                                            />

                                        </button>

                                    </div>

                                </div>


                                {/* =============================================
                        CENTER
                    ============================================= */}

                                <div className="barcode-container-center">


                                    {/* =========================================
                            PRINT TAB
                        ========================================= */}

                                    {activeTab === "print" && (

                                        <div className="barcode-print-view">

                                            <div className="barcode-print-content">


                                                <h3 className="barcode-title">

                                                    Seleccione una opción

                                                </h3>


                                                {/* INTERNAL */}

                                                <div
                                                    className={`
                                            barcode-option
                                            ${printType === "internal"
                                                            ? "barcode-option-active"
                                                            : ""
                                                        }
                                        `}

                                                    onClick={() =>
                                                        setPrintType(
                                                            "internal"
                                                        )
                                                    }
                                                >

                                                    <div className="barcode-radio">

                                                        {
                                                            printType === "internal" && (

                                                                <div className="barcode-radio-dot" />

                                                            )
                                                        }

                                                    </div>


                                                    <span className="barcode-option-text">

                                                        Imprimir código interno del producto

                                                    </span>

                                                </div>


                                                {/* SUPPLIER */}

                                                <div
                                                    className={`
                                            barcode-option

                                            ${printType === "supplier"
                                                            ? "barcode-option-active"
                                                            : ""
                                                        }

                                            ${isSupplierDisabled
                                                            ? "barcode-option-disabled"
                                                            : ""
                                                        }
                                        `}

                                                    onClick={() => {

                                                        if (
                                                            isSupplierDisabled
                                                        ) {
                                                            return;
                                                        }


                                                        setPrintType(
                                                            "supplier"
                                                        );

                                                    }}
                                                >

                                                    <div className="barcode-radio">

                                                        {
                                                            printType === "supplier" &&
                                                            !isSupplierDisabled && (

                                                                <div className="barcode-radio-dot" />

                                                            )
                                                        }

                                                    </div>


                                                    <span className="barcode-option-text">

                                                        Imprimir código del proveedor

                                                    </span>

                                                </div>


                                                {/* QUANTITY */}

                                                <h3 className="barcode-title barcode-mt">

                                                    Cantidad

                                                </h3>


                                                <div className="barcode-quantity">

                                                    <input
                                                        className="barcode-quantity-input"
                                                        type="number"
                                                        value={quantity}

                                                        onChange={(e) =>
                                                            setQuantity(
                                                                e.target.value
                                                            )
                                                        }

                                                        placeholder="Ingrese cantidad..."
                                                    />

                                                </div>

                                                {/* =========================================
                                                    SELECTOR DE IMPRESORA
                                                    ========================================= */}
                                                <h3 className="barcode-title barcode-mt">
                                                    Impresora
                                                </h3>

                                                <div className="barcode-printer-section">
  
    <div
        className="barcode-printer-choice-group"
        role="group"
        aria-label="Seleccionar impresora"
    >
        <button
            type="button"
            className={`barcode-printer-card ${
                printerKind === "zebra" ? "selected" : ""
            }`}
            onClick={() => changePrinterKind("zebra")}
            aria-pressed={printerKind === "zebra"}
            disabled={printing}
        >
            <div className="barcode-printer-card-left">
                <div className="barcode-printer-icon-wrapper">
                    <Printer size={20} strokeWidth={2} />
                </div>

                <div className="barcode-printer-texts">
                    <span className="barcode-printer-title">
                        Zebra
                    </span>

                    <span className="barcode-printer-subtitle">
                        Browser Print
                    </span>
                </div>
            </div>

            <div className="barcode-printer-card-right">
                <div
                    className={`barcode-printer-radio ${
                        printerKind === "zebra" ? "selected" : ""
                    }`}
                >
                    {printerKind === "zebra" && (
                        <Check size={14} strokeWidth={3} />
                    )}
                </div>
            </div>
        </button>

        <button
            type="button"
            className={`barcode-printer-card ${
                printerKind === "niimbot" ? "selected" : ""
            }`}
            onClick={() => changePrinterKind("niimbot")}
            aria-pressed={printerKind === "niimbot"}
            disabled={printing}
        >
            <div className="barcode-printer-card-left">
                <div className="barcode-printer-icon-wrapper">
                    <Printer size={20} strokeWidth={2} />
                </div>

                <div className="barcode-printer-texts">
                    <span className="barcode-printer-title">
                        Bluetooth
                    </span>

                    <span className="barcode-printer-subtitle">
                        NIIMBOT B1
                    </span>
                </div>
            </div>

            <div className="barcode-printer-card-right">
                <div
                    className={`barcode-printer-radio ${
                        printerKind === "niimbot" ? "selected" : ""
                    }`}
                >
                    {printerKind === "niimbot" && (
                        <Check size={14} strokeWidth={3} />
                    )}
                </div>
            </div>
        </button>
    </div>
</div>

                                                {printerKind === "niimbot" && (
                                                    <p className="barcode-bluetooth-help">
                                                        En la PDA, use Chrome con HTTPS y active Bluetooth.
                                                        La primera impresión pedirá seleccionar la impresora.
                                                    </p>
                                                )}

                                            </div>

                                        </div>

                                    )}


                                    {/* =========================================
                            MANUAL TAB
                        ========================================= */}

                                    {activeTab === "manual" && (

                                        <div className="barcode-print-view">

                                            <div className="barcode-print-content">


                                                {/* PRODUCT TITLE */}

                                                <h2 className="barcode-title-product">

                                                    {
                                                        selectedProduct.description
                                                    }

                                                </h2>


                                                <h3 className="barcode-title">

                                                    Introduzca código de barra del proveedor

                                                </h3>


                                                {/* SUPPLIER CODE */}

                                                <div className="barcode-quantity">

                                                    <input
                                                        className="barcode-quantity-input"

                                                        type="text"

                                                        value={
                                                            supplierCode
                                                        }

                                                        onChange={(e) =>
                                                            setSupplierCode(
                                                                e.target.value
                                                            )
                                                        }

                                                        onKeyDown={(e) => {

                                                            if (
                                                                e.key ===
                                                                "Enter"
                                                            ) {

                                                                console.log(
                                                                    "Barcode:",
                                                                    supplierCode
                                                                );

                                                            }

                                                        }}

                                                        placeholder="Código de proveedor..."
                                                    />

                                                </div>


                                                {/* =================================
                                        INVENTORY
                                    ================================= */}

                                                <div className="product-stock-container">


                                                    {/* STOCK TOTAL */}

                                                    <div className="stock-summary-card">

                                                        <div className="stock-summary-icon">

                                                            <FaCubes />

                                                        </div>


                                                        <div className="stock-summary-content">

                                                            <span className="stock-summary-label">

                                                                Stock disponible

                                                            </span>


                                                            <div className="stock-summary-value-container">

                                                                <span className="stock-summary-value">

                                                                    {
                                                                        totalStock.toLocaleString()
                                                                    }

                                                                </span>


                                                                <span className="stock-summary-unit">

                                                                    unidades

                                                                </span>

                                                            </div>

                                                        </div>

                                                    </div>


                                                    {/* =================================
                                            STOCK POR UBICACIÓN
                                        ================================= */}

                                                    <div className="stock-locations-panel">

                                                        <div className="stock-locations-title">

                                                            Stock por ubicación

                                                        </div>


                                                        <div className="stock-locations-grid">


                                                            {/* LOCATIONS */}

                                                            {stockLocations.map(
                                                                (item) => (

                                                                    <button
                                                                        key={
                                                                            item.location_id
                                                                        }

                                                                        type="button"

                                                                        className={`
        stock-location-card
        ${!canAdjustStock
                                                                                ? "disabled"
                                                                                : ""
                                                                            }
    `}

                                                                        disabled={
                                                                            !canAdjustStock
                                                                        }

                                                                        onClick={() => {

                                                                            if (!canAdjustStock) {
                                                                                return;
                                                                            }


                                                                            handleOpenLocation(
                                                                                item
                                                                            );

                                                                        }}
                                                                    >

                                                                        <div className="stock-location-column">

                                                                            <span className="stock-location-label">

                                                                                Ubicación

                                                                            </span>


                                                                            <span className="stock-location-name">

                                                                                {
                                                                                    item.location_code
                                                                                }

                                                                            </span>

                                                                        </div>


                                                                        <div
                                                                            className="
            stock-location-column
            stock-location-quantity-column
        "
                                                                        >

                                                                            <span className="stock-location-label">

                                                                                Cantidad

                                                                            </span>


                                                                            <span className="stock-location-quantity">

                                                                                {
                                                                                    item.qty_on_hand
                                                                                }

                                                                            </span>

                                                                        </div>

                                                                    </button>
                                                                )
                                                            )}


                                                            {/* =================================
                                                    ADD STOCK
                                                ================================= */}

                                                            {canAdjustStock && (

                                                                <button
                                                                    type="button"
                                                                    className="stock-location-add-card"

                                                                    onClick={
                                                                        handleOpenAddStock
                                                                    }
                                                                >

                                                                    <div className="stock-location-add-icon">

                                                                        +

                                                                    </div>


                                                                    <div className="stock-location-add-content">

                                                                        <span className="stock-location-add-description">

                                                                            Agregar stock en otra ubicación

                                                                        </span>

                                                                    </div>

                                                                </button>

                                                            )}

                                                        </div>

                                                    </div>

                                                </div>

                                            </div>

                                        </div>

                                    )}

                                </div>


                                {/* =============================================
                        FOOTER NORMAL
                    ============================================= */}

                                <div className="barcode-container-footer">


                                    {activeTab === "print" && (

                                        <>

                                            <button
                                                type="button"
                                                className="barcode-cancel"
                                                onClick={
                                                    handleCloseProductModal
                                                }
                                            >

                                                Cancelar

                                            </button>


                                            <button
                                                type="button"
                                                className="barcode-submit"
                                                onClick={handlePrint}
                                                disabled={printing}
                                            >

                                                {printing ? "Imprimiendo..." : "Imprimir"}

                                            </button>

                                        </>

                                    )}


                                    {activeTab === "manual" && (

                                        <>

                                            <button
                                                type="button"
                                                className="barcode-cancel"
                                                onClick={
                                                    handleCloseProductModal
                                                }
                                            >

                                                Cancelar

                                            </button>


                                            <button
                                                type="button"
                                                className="barcode-submit"
                                                onClick={
                                                    handleSaveSupplierCode
                                                }
                                            >

                                                Guardar

                                            </button>

                                        </>

                                    )}

                                </div>

                            </>

                        )}

                    </div>

                </div>

            )}


            {selectedLocation && selectedProduct && (

                <div
                    className="location-detail-overlay"
                    onClick={() => setSelectedLocation(null)}
                >

                    <div
                        className="location-detail-modal"
                        onClick={(e) => e.stopPropagation()}
                    >

                        {/* HEADER */}
                        <div className="location-detail-header">

                            <button
                                type="button"
                                className="location-detail-close-icon"
                                onClick={() => setSelectedLocation(null)}
                            >
                                ×
                            </button>

                            <h3>
                                Ajustar Inventario en esta ubicación:
                            </h3>

                        </div>


                        {/* UBICACIÓN */}
                        <div className="location-detail-location">

                            <div className="location-detail-location-label">
                                Ubicación
                            </div>

                            <div className="location-detail-location-code">
                                {selectedLocation.location_code}
                            </div>

                        </div>


                        {/* CANTIDAD */}
                        <div className="location-detail-adjustment">

                            <input
                                type="number"
                                className="location-detail-quantity-input"
                                value={adjustQty}
                                onChange={(e) => setAdjustQty(e.target.value)}
                                min={0}
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        console.log({
                                            locationId: selectedLocation.location_id,
                                            productId: selectedProduct.id,
                                            product_sku: selectedProduct.sku,
                                            quantity: Number(adjustQty),
                                        });

                                        // Aquí puedes llamar tu función para guardar
                                        handleSaveInventoryAdjustment();
                                    }
                                }}
                            />

                            <button
                                type="button"
                                className="location-detail-save"
                                onClick={handleSaveInventoryAdjustment}
                            >
                                ✓
                            </button>

                        </div>

                    </div>

                </div>

            )}

        </div>
    )
};
