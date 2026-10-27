import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import "../styles/warehouseTransfer.css"
import "../styles/picking-user.css"
import "../styles/OrdenCompra.css"
import "../styles/picking-user.css"
import "../styles/Transfer.css";
import { useEffect } from "react";
import apiClient from "../services/apiClient.ts";
import { useModal } from "../context/ModalContext";
import ScanModal from "../components/ScanModal.tsx";
import OrderLineCard from "../components/OrderLineCard.tsx";

export default function PickingRoute() {

    type StockMoveLine = {
        id: number;
        move_id: number;
        product_id: number;
        product_uom_qty: number;
        qty_done: number;
        location_id: number;
        warehouse_id: number;
        tramo: number;
        nivel: number;
        code: string;
        sku: string;
        description: string;
        erp_name?: string | null;
        erp_sku?: string | null;
        erp_id?: number;
    };

    type Location = {
        id: number | string;
        code: string;
    };

    type Product = {
        id: number;
        sku: string;
    };

    //STATES
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();
    const { openModal } = useModal();
    const { closeModal } = useModal();
    const [pickings, setPickings] = useState<StockMoveLine[]>([]);
    const [pickingId, setPickingId] = useState<number | null>(null);
    const pickingIdRef = useRef<number | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const isModalOpenRef = useRef(false);
    const [goNext, setGoNext] = useState(false);
    const [canEdit, setCanEdit] = useState(false);
    const [isOriginModalOpen, setIsOriginModalOpen] = useState(false);

    const [originLine, setOriginLine] =
        useState<StockMoveLine | null>(null);

    const [selectedOriginWarehouseId, setSelectedOriginWarehouseId] =
        useState<number>(1);

    const [fromLocation, setFromLocation] = useState<Location | null>(null);
    const fromLocationRef = useRef<Location | null>(null);
    const qtyInputRef = useRef<HTMLInputElement | null>(null);

    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
    const selectedProductRef = useRef<Product | null>(null);


    const [startedPicking, setStartedPicking] = useState(false);
    console.log(startedPicking);
    const [currentLine, setCurrentLine] = useState<StockMoveLine | null>(null);
    const currentLineRef = useRef<StockMoveLine | null>(null);
    const scanBuffer = useRef<string>("");
    const lastScannerKeyTimeRef = useRef<number>(0);


    const [qty, setQty] = useState<string>("");
    const qtyRef = useRef<string>("");

    //State de error de location rojo
    //const [locationError, setLocationError] = useState(false);

    function logScannerState(label: string, scanned?: string) {
        console.log(`🧪 ${label}`, {
            scanned,
            fromLocation_state: fromLocation,
            fromLocation_ref: fromLocationRef.current,
            currentLine_ref: currentLineRef.current,
            selectedProduct_ref: selectedProductRef.current,
            qty_ref: qtyRef.current,
            pickingId_ref: pickingIdRef.current,
            isModalOpen_ref: isModalOpenRef.current,
        });
    }

    useEffect(() => {
        currentLineRef.current = currentLine;
    }, [currentLine]);
    useEffect(() => {
        fromLocationRef.current = fromLocation;
    }, [fromLocation]);

    useEffect(() => {
        qtyRef.current = qty;
    }, [qty]);
    useEffect(() => {
        pickingIdRef.current = pickingId;
    }, [pickingId]);
    useEffect(() => {
        selectedProductRef.current = selectedProduct;
    }, [selectedProduct]);
    useEffect(() => {
        if (goNext && pickings.length > 0) {
            selectNextLine();
            setGoNext(false);
        }
    }, [pickings]);


    /* 1️⃣ Obtener ID desde la URL */
    const { id } = useParams<{ id: string }>();
    useEffect(() => {
        if (!id) return;
        const poId = Number(id);
        if (isNaN(poId)) return;

        setPickingId(poId);
    }, [id]);



    useEffect(() => {
        // 🔹 1. Validar que exista pickingId
        if (!pickingId) return;

        fetchData();


    }, [pickingId]);



    const fetchData = async () => {
        try {
            // 🔹 2. Hacer request
            const response = await apiClient.get(
                `/picking/${pickingId}/products-locations`
            );

            // 🔹 3. Log del resultado
            console.log("📦 Products Locations:", response.data);

            if (!response.data.success) {
                setPickings([]);
                openModal({
                    title: "NO SE PUDO INICIAR RECOGIDA",
                    message: response.data.message
                });
                return;
            }

            setPickings(
                Array.isArray(response.data.data)
                    ? response.data.data
                    : []
            );
            setLoading(false);

        } catch (error) {
            console.error("❌ Error fetching products locations:", error);
        }
    };

    const fetchUpdatedMoveLines = async () => {
  if (!pickingId) {
    return false;
  }

  try {
    const response = await apiClient.get(
      `/picking/${pickingId}/move-lines`
    );

    const result = response.data;

    console.log(
      "📦 Move lines actualizadas:",
      result
    );

    if (!result.success) {
      openModal({
        title:
          result.title ||
          "No se pudieron actualizar las líneas",

        message:
          result.message ||
          "Ocurrió un error obteniendo las líneas del picking.",
      });

      return false;
    }

    const updatedLines =
      Array.isArray(result.data)
        ? result.data
        : [];

    // Guardar las líneas nuevas en pickings.
    setPickings(updatedLines);

    console.log(
      "✅ Pickings actualizado:",
      updatedLines
    );

    return true;
  } catch (error: any) {
    const backendError =
      error.response?.data;

    console.error(
      "❌ Error obteniendo move lines:",
      backendError || error
    );

    openModal({
      title:
        backendError?.title ||
        "Información guardada",

      message:
        backendError?.message ||
        "La línea fue guardada, pero no se pudo actualizar la lista del picking.",
    });

    return false;
  }
};

    const alreadyCheckedRef = useRef(false);

    useEffect(() => {
        if (alreadyCheckedRef.current) return;
        if (pickings.length === 0) return;

        alreadyCheckedRef.current = true;

        console.log("✅ PICKINGS CARGADOS POR PRIMERA VEZ:", pickings);

        selectNextLine();

    }, [pickings]);


    function normalizeScannedCode(raw: string) {
        let scanned = String(raw || "")
            .replace(/[\r\n]+/g, "")
            .trim()
            .toUpperCase();

        // Protección extra:
        // Si por error llega "10ST-A1-02", lo convierte en "ST-A1-02"
        const prefixes = ["ST-", "GC-", "USER-", "DESPACHO"];

        for (const prefix of prefixes) {
            const index = scanned.indexOf(prefix);

            if (index > 0) {
                scanned = scanned.slice(index);
                break;
            }
        }

        return scanned;
    }
    /* =======================
       SCANNER LISTENER
    ======================= */
    useEffect(() => {
        async function handleKeyDown(e: KeyboardEvent) {
            const target = e.target as HTMLElement;
            const isEndKey = e.key === "Enter" || e.key === "Tab";

            // =====================================================
            // 1. NO capturar lo que escribes en inputs
            // =====================================================
            if (
                target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable
            ) {
                // Si estás escribiendo cantidad, no contaminar el scanner buffer
                scanBuffer.current = "";
                lastScannerKeyTimeRef.current = 0;
                return;
            }
            closeModal();
            // =====================================================
            // 2. Si la ruta no está iniciada, no acumular teclas
            // =====================================================
            if (!isModalOpenRef.current) {
                scanBuffer.current = "";
                lastScannerKeyTimeRef.current = 0;

                if (isEndKey) {
                    openModal({
                        title: "INICIE LA RECOGIDA",
                        message: "Primero debe iniciar la ruta dando click a Recoger."
                    });
                }

                return;
            }

            // =====================================================
            // 3. Termina el scan con Enter o Tab
            // =====================================================
            if (isEndKey) {
                e.preventDefault();

                const rawScanned = scanBuffer.current;

                // Limpiar inmediatamente
                scanBuffer.current = "";
                lastScannerKeyTimeRef.current = 0;

                const scanned = normalizeScannedCode(rawScanned);

                if (!scanned) return;

                console.log("📡 SCAN RAW:", rawScanned);
                console.log("📡 SCAN RECIBIDO:", scanned);

                logScannerState("ANTES DE LLAMAR BACKEND /picking/scan", scanned);

                try {
                    const res = await apiClient.post("/picking/scan", {
                        code: scanned,
                        pickingId: pickingIdRef.current,
                    });

                    const data = res.data;

                    console.log("LLEGO DEL BACKKEND: ", data);
                    logScannerState("DESPUÉS DE RESPUESTA BACKEND", scanned);

                    // 🟢 ES UBICACIÓN
                    if (data.success && data.type === "location") {
                        console.log("✅ UBICACIÓN VALIDADA POR BACKEND:", data.data);
                        console.log("🟨 Current Location: ", currentLineRef.current?.code);

                        handleScanLocation(data.data);

                        /*  if (data.data.code !== currentLineRef.current?.code) {
                              setLocationError(true);
  
                              setTimeout(() => {
                                  setLocationError(false);
                              }, 2000);
  
                              return;
                          }*/
                    }

                    // 🔵 ES PRODUCTO
                    else if (data.success && data.type === "product") {
                        handleScanProduct(data.data);
                    }

                    // 🔴 NO ES NADA
                    else if (!data.success && data.code === "NOT_FOUND") {
                        console.log("❌ CÓDIGO NO VÁLIDO:", data.message);

                        if (!fromLocationRef.current) {
                            openModal({
                                title: "Escanee una ubicación",
                                message: "Primero debe escanear una ubicación válida antes de escanear un producto."
                            });
                            return;
                        }

                        if (fromLocationRef.current && !currentLineRef.current) {
                            openModal({
                                title: "Escanee un producto válido",
                                message: "El código leído no corresponde a un producto válido. Intente nuevamente."
                            });
                            return;
                        }

                        openModal({
                            title: "Código no válido",
                            message: "El código escaneado no corresponde a una ubicación ni a un producto."
                        });
                    }

                    else if (!data.success && data.code === "NO_LOCATION") {
                        openModal({
                            title: "Primero escanea una ubicación",
                            message: "Primero debe escanear una ubicación válida antes de escanear un producto."
                        });
                    }

                    else if (!data.success && data.code === "NOT_IN_PICKING") {
                        openModal({
                            title: data.title,
                            message: data.message
                        });
                    }

                    else if (!data.success && data.code === "INVALID_CODE") {
                        openModal({
                            title: "Verifique el código que leyó.",
                            message: "El código no corresponde a una ubicación ni a un producto."
                        });
                    }

                    else {
                        console.log("⚠️ RESPUESTA DESCONOCIDA:", data);
                    }

                } catch (error) {
                    console.error("🔥 Error llamando /picking/scan:", error);
                }

                return;
            }

            // =====================================================
            // 4. Acumular caracteres del scanner
            // =====================================================
            if (e.key.length === 1) {
                const now = Date.now();

                // Si pasó mucho tiempo entre teclas, era escritura manual anterior.
                // Limpiamos el buffer para que no se mezcle con el scan nuevo.
                if (
                    lastScannerKeyTimeRef.current &&
                    now - lastScannerKeyTimeRef.current > 300
                ) {
                    scanBuffer.current = "";
                }

                scanBuffer.current += e.key;
                lastScannerKeyTimeRef.current = now;

                console.log("⌨️ BUFFER SCANNER:", scanBuffer.current);
            }
        }

        window.addEventListener("keydown", handleKeyDown);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, []);


    // FUNCTION: Handle scanned location code
    function handleScanLocation(location: { id: string; code: string }) {
        if (!location?.id || !location?.code) return;

        const newLocation: Location = {
            id: location.id,
            code: location.code,
        };

        console.log("📍 HANDLE SCAN LOCATION - ANTES:", {
            location_recibida: location,
            fromLocation_state_antes: fromLocation,
            fromLocation_ref_antes: fromLocationRef.current,
            currentLine_ref: currentLineRef.current,
        });

        setFromLocation(newLocation);

        // ✅ IMPORTANTE:
        // Actualiza el ref inmediatamente, porque setFromLocation es asincrónico.
        fromLocationRef.current = newLocation;

        setSelectedProduct({
            id: -1,
            sku: ""
        } as any);

        selectedProductRef.current = {
            id: -1,
            sku: "",
        };

        setQty("");
        qtyRef.current = "";

        console.log("📍 HANDLE SCAN LOCATION - DESPUÉS:", {
            fromLocation_state_despues: newLocation,
            fromLocation_ref_despues: fromLocationRef.current,
            selectedProduct_ref: selectedProductRef.current,
            qty_ref: qtyRef.current,
        });
    }

    // FUNCTION: Handle scanned product
    function handleScanProduct(product: {
        id: number | string;
        sku: string;
    }) {


        // ❌ Si no hay ubicación escaneada primero
        if (!fromLocationRef.current) {
            openModal({
                title: "Escanee una ubicación",
                message: "Primero debe escanear la ubicación y luego el producto."
            });
            return;
        }
        //console.log(product)


        //console.log("📍 UBICACIÓN ACTUAL:", fromLocationRef.current);
        //console.log("📍 LIINEA ACTUAL:", currentLineRef.current);

        setSelectedProduct({
            id: Number(product.id),
            sku: product.sku,
        });
        setQty("");
        console.log("SKU ESCANEADO:", JSON.stringify(product.sku));
        console.log("SKU LINEA:", JSON.stringify(currentLineRef.current?.sku));
        console.log("CURRENT LINE:", currentLineRef.current);

        if (product.sku === currentLineRef.current?.sku) {
            console.log("✅ Es el mismo código");
            focusQtyInput();
        } else {
            console.log("❌ No es el mismo código");
            openModal({
                title: "Escanee el producto correcto",
                message: "El produco leido no es el producto en pantalla."
            });
        }

    }


    //Function to open the origin modal
    function handleOrigin(line: StockMoveLine) {

        console.log("📍 VER ORIGEN:", line);

        setOriginLine(line);

        setIsOriginModalOpen(true);
    }

    //function to close the origin modal
    function handleCloseOrigin() {
        setIsOriginModalOpen(false);
        setOriginLine(null);
    }


    async function handleSelectOriginWarehouse(warehouseId: number) {

        if (!originLine) {
            return;
        }

        console.log("🏬 WAREHOUSE SELECCIONADO:", warehouseId);
        console.log("📦 MOVE ID:", originLine.move_id);

        // actualizar visualmente
        setSelectedOriginWarehouseId(warehouseId);

        try {

            const response = await apiClient.post(
                "/picking/update-origin-warehouse",
                {
                    moveId: originLine.move_id,
                    warehouseId: warehouseId,
                }
            );

            console.log("✅ UPDATE ORIGIN RESPONSE:", response.data);

            if (!response.data.success) {

                openModal({
                    title: response.data.title || "Error",
                    message:
                        response.data.message ||
                        "No se pudo actualizar el origen."
                });

                return;
            }

            // cerrar modal de origen
            setIsOriginModalOpen(false);
            setOriginLine(null);

        } catch (error) {

            console.error(
                "❌ ERROR ACTUALIZANDO ORIGEN:",
                error
            );

            openModal({
                title: "Error",
                message: "No se pudo actualizar el origen del movimiento."
            });
        }
    }





    function handleEditLine(lineId: number) {

        console.log("✏️ EDITANDO LINE:", lineId);

        // 🔍 buscar línea completa real
        const pickingLine = pickings.find(p => p.id === lineId);

        if (!pickingLine) {
            console.log("❌ Línea no encontrada");
            return;
        }

        console.log("📦 PICKING LINE:", pickingLine);

        // =========================
        // CURRENT LINE
        // =========================
        setCurrentLine(pickingLine);
        currentLineRef.current = pickingLine;

        // =========================
        // LOCATION
        // =========================
        const location = {
            id: pickingLine.location_id,
            code: pickingLine.code,
        };

        //setFromLocation(location);
        //fromLocationRef.current = location;

        // =========================
        // PRODUCT
        // =========================
        const product = {
            id: pickingLine.product_id,
            sku: pickingLine.sku,
            description: pickingLine.description,
        };

        //setSelectedProduct(product);

        // =========================
        // QTY
        // =========================
        setQty(
            String(
                Number(pickingLine.qty_done || 0)
            )
        );

        console.log("📍 LOCATION:", location);
        console.log("📦 PRODUCT:", product);
        console.log("🔢 QTY:", qty);

        // =========================
        // OPEN MODAL
        // =========================
        setIsModalOpen(true);
        isModalOpenRef.current = true;
    }



    // FUNCION PARA CERRAR MODAL
    async function sendModal() {
        try {
            // 🔴 VALIDAR QUE TODO EXISTA
            if (
                !currentLineRef.current ||
                !fromLocationRef.current ||
                !selectedProductRef.current ||
                !qtyRef.current
            ) {
                openModal({
                    title: "Datos incompletos",
                    message: "Debe escanear ubicación, producto y cantidad"
                });
                return;
            }

            // 🔴 VALIDAR QTY
            if (Number(qtyRef.current) < 0) {
                openModal({
                    title: "Cantidad inválida",
                    message: "La cantidad debe ser mayor o igual a 0"
                });
                return;
            }

            // 🔥 CALL API
            const res = await apiClient.post("/picking/confirm-line", {
                id: currentLineRef.current.id,
                locationId: fromLocationRef.current.id,
                productId: selectedProductRef.current.id,
                qty: Number(qtyRef.current),
            });

            console.log("✅ RESPONSE:", res.data);

            // 🔴 SI FALLA
            if (!res.data.success) {
                openModal({
                    title: res.data.title,
                    message: res.data.message
                });
                return;
            }

            // ✅ TODO BIEN → LIMPIAR UI

            await fetchUpdatedMoveLines();
            setGoNext(true);
            setFromLocation(null);
            setSelectedProduct(null);
            setQty("");
            fromLocationRef.current = null;
            selectedProductRef.current = null;
            qtyRef.current = "";
            scanBuffer.current = "";
            lastScannerKeyTimeRef.current = 0;
            qtyInputRef.current?.blur();

            setStartedPicking(false);


        } catch (error) {
            console.error("🔥 ERROR confirm-line:", error);

            openModal({
                title: "Error",
                message: "No se pudo guardar la información"
            });
        }
    }

    function focusQtyInput() {
        qtyInputRef.current?.focus();
    }

    function closeModals() {
        // ✅ TODO BIEN → LIMPIAR UI
        setFromLocation(null);
        setSelectedProduct(null);
        setQty("");

        setIsModalOpen(false);
        isModalOpenRef.current = false;
        setStartedPicking(false);
    }

    function handleOpenModal() {
        // 🚫 SI YA SE PUEDE EDITAR → NO ABRIR MODAL
        if (canEdit) {
            console.log("✏️ EDIT MODE ENABLED → modal no se abre");
            return null;
        }
        selectNextLine();
        setIsModalOpen(true);
        isModalOpenRef.current = true;
        setStartedPicking(true);
    };

    const SkeletonLine = () => (
        <div className="skeleton-line">
            <div className="skeleton-code"></div>
            <div className="skeleton-text"></div>
            <div className="skeleton-qty"></div>
        </div>
    );




    function selectNextLine() {

        console.log("🟥🟥 LINEAS", pickings);

        // 🚫 SI YA ESTÁ EN MODO EDICIÓN
        if (canEdit) {
            setIsModalOpen(false);
            console.log("✏️ EDIT MODE ENABLED → modal no se abre");



            return null;
        }

        // 🔍 BUSCAR LÍNEAS EN 0
        const zeroLine = pickings.find(line => {

            const done = Number(line.qty_done || 0);

            return done === 0;
        });

        // ✅ ENCONTRÓ UNA EN 0
        if (zeroLine) {

            console.log("🎯 ZERO LINE", zeroLine);

            setCurrentLine(zeroLine);

            return zeroLine;
        }
        // 🔒 CERRAR MODAL
        setIsModalOpen(false);
        // ❌ YA NO HAY LÍNEAS EN 0
        console.log("✅ TODAS LAS LÍNEAS AUTOMÁTICAS COMPLETAS");



        // ✏️ ACTIVAR EDICIÓN MANUAL
        setCanEdit(true);

        console.log("✏️ canEdit = true");
        console.log("🚫 El modal ya no volverá a abrir");
        console.log("🧾 El usuario ahora puede editar manualmente");

        return null;
    }

    const handleFinish = async () => {
        if (!pickingIdRef.current) return;

        try {
            const response = await apiClient.get(
                `/picking/${pickingIdRef.current}/differences`
            );

            const result = response.data;

            if (!result.success) {
                openModal({
                    title: "Error",
                    message: "No se pudo validar el picking"
                });
                return;
            }

            const lines = result.data.lines;

            // 🔴 SI HAY DIFERENCIAS → IR A VALIDACIÓN
            if (lines.length > 0) {
                navigate(`/picking/validation/${pickingIdRef.current}`);
                return;
            }

            // ✅ SI NO HAY DIFERENCIAS → FINALIZAR DIRECTO
            navigate(`/picking/final/${pickingIdRef.current}`);

        } catch (error) {
            console.error(error);

            openModal({
                title: "Error",
                message: "Error al validar el picking"
            });
        }
    };





    return (
        <div className="page-orden-compra">

            <div className="sv-picking-header">
                {/* INFORMACIÓN DEL PEDIDO */}
                <div className="sv-picking-header-info">

                    {/* ICONO */}
                    <div className="sv-picking-header-icon">
                        <svg
                            viewBox="0 0 24 24"
                            width="44"
                            height="44"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                        >
                            <circle cx="9" cy="21" r="1" />
                            <circle cx="20" cy="21" r="1" />
                            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                        </svg>
                    </div>

                    {/* DETALLES */}
                    <div className="sv-picking-header-content">

                        <span className="sv-picking-header-subtitle">
                            ORDEN DE PREPARACIÓN
                        </span>

                        <h1 className="sv-picking-header-title">
                            PEDIDO PENDIENTE
                        </h1>

                        {/* METADATA */}
                        <div className="sv-picking-header-metadata">

                            <div className="sv-picking-meta-item">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <rect x="4" y="3" width="16" height="18" rx="2" />
                                    <path d="M8 8h8M8 12h8M8 16h5" />
                                </svg>

                                <span>{pickings.length} líneas</span>
                            </div>

                            <span className="sv-picking-meta-divider" />

                            <div className="sv-picking-meta-item">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M4 7h16M4 12h16M4 17h16" />
                                    <circle cx="2" cy="7" r="0.5" />
                                    <circle cx="2" cy="12" r="0.5" />
                                    <circle cx="2" cy="17" r="0.5" />
                                </svg>

                                <span>
                                    {pickings.reduce(
                                        (total, line) =>
                                            total + Number(line.product_uom_qty || 0),
                                        0
                                    ).toLocaleString("es-DO")} unidades
                                </span>
                            </div>

                            <span className="sv-picking-meta-divider" />

                            <div className="sv-picking-meta-item">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <rect x="3" y="4" width="18" height="17" rx="2" />
                                    <path d="M8 2v4M16 2v4M3 10h18" />
                                </svg>

                                <span>Pedido #{pickingId ?? "—"}</span>
                            </div>

                        </div>
                    </div>
                </div>

                {/* BOTÓN FINALIZAR */}
                <div className="sv-picking-header-actions">
                    <button
                        type="button"
                        className="sv-picking-header-finish"
                        onClick={handleFinish}
                    >
                        <svg
                            className="sv-picking-finish-check"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                        >
                            <path d="M20 6 9 17l-5-5" />
                        </svg>

                        <span>Finalizar</span>

                        <svg
                            className="sv-picking-finish-arrow"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                        >
                            <path d="m9 18 6-6-6-6" />
                        </svg>
                    </button>
                </div>
            </div>

            <div className="order-container-table">
                <div className="order-lines-header">
                    <div>SKU</div>
                    <div>Descripción</div>
                    <div>Cantidad</div>
                    <div>Diferencia</div>
                    <div className="editar">Acciones</div>
                </div>

                <div className="lines-list">

                    {loading ? (
                        <>
                            <SkeletonLine />
                            <SkeletonLine />
                            <SkeletonLine />
                            <SkeletonLine />
                        </>
                    ) : pickings.length === 0 ? (
                        <div>No hay líneas</div>
                    ) : (
                        pickings.map((line) => (
                            <OrderLineCard
                                key={line.id}
                                editable={true}
                                onEdit={() => handleEditLine(line.id)}

                                onOrigin={() => handleOrigin(line)}


                                line={{
                                    id: Number(line.product_id),
                                    sku: line.sku,
                                    description: line.description,
                                    ordered_qty: Math.trunc(Number(line.product_uom_qty)),
                                    received_qty: Math.trunc(Number(line.qty_done)),
                                    min_received_qty: 0,
                                    erp_name: line.erp_name,
                                    erp_sku: line.erp_sku,
                                    erp_id: line.erp_id,

                                    product_exists: true,
                                    barcodes: [],
                                }}
                            />
                        ))
                    )}

                </div>
            </div>


            <div className="picking-user-filter-bar">
                <div className="pick-user-filter-bar-inner">

                    <button className="pick-button" onClick={handleOpenModal}>
                        Recoger
                    </button>
                </div>
            </div>

            <ScanModal
                open={isModalOpen}
                onClose={closeModals}
            >
                <div className="transfer-page">
                    <div className="transfer-card">

                        {/* ORIGEN */}
                        <section
                            className={`pick-user-location-card ${!fromLocation
                                ? "pick-user-location-empty"
                                : ""
                                }`}
                        >
                            <span className="pick-user-location-label">
                                Lea la ubicación:
                            </span>
                            <div className="pick-user-location-header">


                                <span className="pick-user-location-code">
                                    {currentLine?.code}
                                </span>
                            </div>

                        </section>

                        {/* 1) PRODUCTO */}
                        <section
                            className={`pick-user-location-card ${!selectedProduct ||
                                Number(selectedProduct.id) !== Number(currentLine?.product_id)
                                ? "pick-user-product-empty"
                                : ""
                                }`}
                        >

                            <span className="pick-user-location-label">
                                Lea el producto:
                            </span>
                            <div className="pick-user-location-header">


                                <span className="pick-user-product-code">
                                    {currentLine?.erp_name} / {currentLine?.erp_sku} / {currentLine?.description} / {currentLine?.sku} / {currentLine?.erp_id}
                                </span>
                            </div>


                        </section>


                        {/* CANTIDAD */}
                        <section
                            className={`section-qty block ${currentLine && !qty ? "ready" : ""}`}
                        >
                            <div className="pick-user-qty-div-a">
                                <div className="block-title">Cantidad:</div>
                                <input
                                    ref={qtyInputRef}
                                    className="qty-input"
                                    type="number"
                                    value={qty}
                                    onFocus={() => {
                                        scanBuffer.current = "";
                                        lastScannerKeyTimeRef.current = 0;
                                    }}
                                    onChange={(e) => {
                                        const value = Number(e.target.value);
                                        const max = Math.trunc(Number(currentLine?.product_uom_qty || 0));

                                        if (value > max) {
                                            setQty(String(max));
                                            return;
                                        }

                                        if (value < 0) {
                                            setQty("0");
                                            return;
                                        }

                                        setQty(e.target.value);
                                    }}
                                />
                            </div>

                            <div>
                                <div className="block-title">Pedido:</div>
                                <div className="qty-display">
                                    {Math.trunc(Number(currentLine?.product_uom_qty || 0))}
                                </div>
                            </div>
                        </section>

                        {/* BOTONES */}
                        <section className="block-actions">
                            <button className="btn btn-exit" onClick={closeModals}>
                                Salir
                            </button>

                            {qty !== "" && Number(qty) >= 0 && (
                                <button
                                    className="btn btn-save pop-in"
                                    onClick={sendModal}
                                >
                                    Siguiente
                                </button>
                            )}
                        </section>
                    </div>
                </div>

            </ScanModal>



            {/*MODAL ORIGEN*/}
            {isOriginModalOpen && originLine && (
                <div
                    className="origin-modal-overlay"
                    onClick={handleCloseOrigin}
                >
                    <div
                        className="origin-modal"
                        onClick={(e) => e.stopPropagation()}
                    >

                        <div className="origin-modal-header">

                            <h3>Origen</h3>

                            <button
                                type="button"
                                className="origin-modal-close"
                                onClick={handleCloseOrigin}
                            >
                                ×
                            </button>

                        </div>


                        <div className="origin-modal-body">

                            <button
                                type="button"
                                className={`origin-option-btn ${selectedOriginWarehouseId === 2
                                    ? "origin-option-selected"
                                    : ""
                                    }`}
                                onClick={() => handleSelectOriginWarehouse(2)}
                            >
                                PARA ORDENAR
                            </button>


                            <button
                                type="button"
                                className={`origin-option-btn ${selectedOriginWarehouseId === 1
                                    ? "origin-option-selected"
                                    : ""
                                    }`}
                                onClick={() => handleSelectOriginWarehouse(1)}
                            >
                                PARA DESPACHAR
                            </button>

                        </div>

                    </div>
                </div>
            )}

        </div>

    );
}


