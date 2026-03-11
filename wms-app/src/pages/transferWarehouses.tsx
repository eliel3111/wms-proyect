import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/Transfer.css";
import "../styles/warehouseTransfer.css"
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import { LoadingScreen } from "../components/LoadingScreen";
import ScanModal from "../components/ScanModal.tsx";

type Location = {
    id: number;
    code: string;
};

type LocationType = {
    id: number | string;
    name: string;
    code?: string;
};


type ScannedProduct = {
    id: number;
    sku: string;
    description: string;
    uom?: string;
};

export type WarehouseTransferPendingLine = {
    id: number | string;
    product_id: number | string;
    product_qty: number | string;
    sku: string;
    description: string;
    state: string;
    uom: string;
};



export default function TransferWarehouse() {
    const navigate = useNavigate();
    const { openModal } = useModal();
    const [loading, setLoading] = useState(true);

    const [currentLine, setCurrentLine] = useState<ScannedProduct | null>(null);
    const currentLineRef = useRef<ScannedProduct | null>(null);

    const [fromLocation, setFromLocation] = useState<Location | null>(null);
    const fromLocationRef = useRef<Location | null>(null);


    const [pickingId, setPickingId] = useState<number | null>(null);

    const [activeLocations, setActiveLocations] = useState<LocationType[]>([]);

    const [locationOrigen, setLocationOrigen] = useState<LocationType | null>(null);
    const [locationDestino, setLocationDestino] = useState<LocationType | null>(null);
    const locationOrigenRef = useRef<LocationType | null>(null);
    const locationDestinoRef = useRef<LocationType | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);



    const [editLocation, setEditLocation] = useState<boolean>(false);
    const editLocationRef = useRef<boolean>(false);


    const [pendingLines, setPendingLines] = useState<WarehouseTransferPendingLine[]>([]);
    const pendingLinesRef = useRef<WarehouseTransferPendingLine[]>([]);




    const [qty, setQty] = useState<string>("");
    const qtyRef = useRef<string>("");


    const scanBuffer = useRef<string>("");
    const qtyInputRef = useRef<HTMLInputElement | null>(null);

    const pickingIdRef = useRef<number | null>(null);
    const activeLocationsRef = useRef<any[]>([]);


    //State para linea del stock line para eliminar y state para modal
    const [deleteLineId, setDeleteLineId] = useState<number | null>(null);
    const [showDeleteModal, setShowDeleteModal] = useState(false);


    useEffect(() => {
        locationOrigenRef.current = locationOrigen;
        console.log("📍 ORIGEN REF:", locationOrigenRef.current);
    }, [locationOrigen]);

    useEffect(() => {
        locationDestinoRef.current = locationDestino;
        console.log("📦 DESTINO REF:", locationDestinoRef.current);
    }, [locationDestino]);

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
        console.log("pickingId cambió → ref:", pickingIdRef.current);
    }, [pickingId]);

    useEffect(() => {
        activeLocationsRef.current = activeLocations;
        console.log("locations cambiaron → ref:", activeLocationsRef.current);
    }, [activeLocations]);

    useEffect(() => {
        editLocationRef.current = editLocation;
        console.log("editLocation REF:", editLocationRef.current);
    }, [editLocation]);

    useEffect(() => {
        pendingLinesRef.current = pendingLines;
        console.log(pendingLinesRef.current);
        console.log(pendingLines);
    }, [pendingLines]);


    useEffect(() => {
        const origenValido =
            locationOrigen &&
            locationOrigen.id !== 0 &&
            locationOrigen.id !== "0";

        const destinoValido =
            locationDestino &&
            locationDestino.id !== 0 &&
            locationDestino.id !== "0";

        if (origenValido && destinoValido) {
            setEditLocation(true);
        } else {
            setEditLocation(false);
        }
    }, [locationOrigen, locationDestino]);




    /* =======================
       LOAD warehouse locations
    ======================= */
    useEffect(() => {
        authorizeSession();
    }, []);

    async function authorizeSession() {
        try {
            setLoading(true);

            const res = await apiClient.get("/warehouse-transfers/init");

            const data = res.data;

            if (!data.success) {
                throw new Error(data.message || "Authorization failed");
            }

            console.log("SESSION RESPONSE:", data);

            // 🔴 Caso: transfer NO disponible
            if (data.status === "INACTIVE") {
                openModal({
                    title: "Transferencias no disponibles",
                    message: data.message
                });
                return;
            }

            // 🟢 Caso: ACTIVE
            if (data.status === "ACTIVE") {
                setPickingId(Number(data.picking.pickingId));
                setActiveLocations(data.warehouses || []);

                // si ya tiene locations guardadas
                if (data.picking.location_id) {

                    const origen = data.warehouses.find(
                        (w: any) => Number(w.id) === Number(data.picking.location_id)
                    );

                    if (origen) {
                        setLocationOrigen(origen);
                    }
                }


                if (data.picking.location_dest_id) {

                    const destino = data.warehouses.find(
                        (w: any) => Number(w.id) === Number(data.picking.location_dest_id)
                    );

                    if (destino) {
                        setLocationDestino(destino);
                    }
                }

                if (data.pendingLines) {
                    setPendingLines(data.pendingLines);
                }


            }

        } catch (err: any) {
            console.error(err);

            openModal({
                title: "Error",
                message:
                    err?.response?.data?.message ||
                    "No se pudo iniciar la sesión de traslado"
            });
        } finally {
            setLoading(false);
        }
    }



    /* =======================
       SCANNER LISTENER
    ======================= */
    useEffect(() => {
        async function handleKeyDown(e: KeyboardEvent) {
            const isEndKey = e.key === "Enter" || e.key === "Tab";

            if (isEndKey) {
                const scanned = scanBuffer.current
                    .replace(/[\r\n]+/g, "")
                    .trim()
                    .toUpperCase();

                scanBuffer.current = "";

                if (!scanned) return;

                console.log("📡 SCAN RECIBIDO:", scanned);

                try {
                    const res = await apiClient.post("/transfer/scan-product", {
                        code: scanned,
                        current_location_id: fromLocationRef.current?.id ?? null
                    });

                    const data = res.data;

                    // 🟢 ES UBICACIÓN
                    if (data.success && data.type === "location") {
                        console.log("📍 UBICACIÓN DETECTADA:", data.location);
                        handleScanLocation(data.location);
                    }

                    // 🔵 ES PRODUCTO
                    else if (data.success && data.type === "product") {
                        handleScanProduct(data.product);
                    }


                    // 🔴 NO ES NADA
                    else if (!data.success && data.code === "NOT_FOUND") {
                        console.log("❌ CÓDIGO NO VÁLIDO:", data.message);

                        // ❌ No hay ubicación todavía
                        if (!fromLocationRef.current) {
                            openModal({
                                title: "Escanee una ubicación",
                                message: "Primero debe escanear una ubicación válida antes de escanear un producto."
                            });
                            return;
                        }

                        // ❌ Ya hay ubicación, pero no hay producto válido
                        if (fromLocationRef.current && !currentLineRef.current) {
                            openModal({
                                title: "Escanee un producto válido",
                                message: "El código leído no corresponde a un producto válido. Intente nuevamente."
                            });
                            return;
                        }

                        // ⚠️ Caso extra (opcional, por seguridad)
                        openModal({
                            title: "Código no válido",
                            message: "El código escaneado no corresponde a una ubicación ni a un producto."
                        });
                    }


                    else if (!data.success && data.code === "NO_LOCATION") {

                        openModal({
                            title:
                                "Primero escanea una ubicación",
                            message: "Primero debe escanear una ubicación válida antes de escanear un producto."
                        });

                    }

                    else if (!data.success && data.code === "NO_STOCK_IN_LOCATION") {

                        openModal({
                            title:
                                "Verifique el producto",
                            message: "El producto no existe en esa ubicación o no tiene cantidad disponible."
                        });

                    }

                    else if (!data.success && data.code === "INVALID_CODE") {

                        openModal({
                            title:
                                "Verifique el código que leyó.",
                            message: "El código no corresponde a una ubicación ni a un producto."
                        });

                    }


                    // 🟡 Cualquier otro caso raro
                    else {
                        console.log("⚠️ RESPUESTA DESCONOCIDA:", data);
                    }

                } catch (error) {
                    console.error("🔥 Error llamando /transfer/scan-product:", error);
                }

            } else {
                // Solo acumula caracteres normales del scanner
                if (e.key.length === 1) {
                    scanBuffer.current += e.key;
                }
            }
        }

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);

    /* =======================
       SAVE TRANSFER DROP
    ======================= */
    async function onSave() {

        const payload = {
            picking_id: Number(pickingId),
            product_id: Number(currentLine?.id),
            qty: Number(qty),
            location_id: Number(fromLocation?.id),
            warehouse_id: Number(locationOrigen?.id),
            warehouse_dest_id: Number(locationDestino?.id),
        };

        console.log("📤 ENVIANDO LIMPIO:", payload);

        try {
            const res = await apiClient.post(
                "/warehouse-transfers/save-picking",
                payload
            );

            console.log("✅ RESPUESTA:", res.data);

            // 🔥 VUELVE A VALIDAR SESSION
            await authorizeSession();
            // limpiar
            setCurrentLine(null);
            setQty("");

            openModal({
                title: "OK",
                message: "Producto agregado al traslado"
            });

        } catch (err: any) {
            console.log("🔥 ERROR COMPLETO:", err?.response?.data);

            openModal({
                title: "Error",
                message:
                    err?.response?.data?.message ||
                    JSON.stringify(err?.response?.data) ||
                    "Error guardando traslado"
            });
        }
    }


    //FUNCTION: Para guardar traslado de almacen:
    async function onSaveWarehouse() {

    if (!pickingId) {
        openModal({
            title: "Error",
            message: "No hay sesión de traslado activa"
        });
        return;
    }

     // 🔴 validar que haya líneas
    if (!pendingLines || pendingLines.length === 0) {
        openModal({
            title: "Sin productos",
            message: "Debe agregar al menos un producto al traslado antes de cerrarlo."
        });
        return;
    }

    try {
        setLoading(true);

        openModal({
            title: "Procesando traslado",
            message: "Cerrando y generando documento..."
        });

        const res = await apiClient.post(
            "/warehouse-transfers/validar-traslado", // 🔥 tu endpoint real
            {
                picking_id: Number(pickingId)
                // user_id llega del backend por token/session
            }
        );

        console.log("✅ CLOSE RESPONSE:", res.data);

        if (!res.data.success) {
            throw new Error(res.data.message || "No se pudo cerrar traslado");
        }

        openModal({
            title: "Traslado cerrado",
            message: "El traslado fue enviado correctamente"
        });

        // 🔥 opcional reset
        // setPickingId(null);
        // navigate("/home");

    } catch (err: any) {
        console.log("🔥 ERROR CLOSE:", err?.response?.data || err.message);

        openModal({
            title: err?.response?.data?.title || "Error",
            message:
                err?.response?.data?.message ||
                err.message ||
                "No se pudo cerrar el traslado"
        });

    } finally {
        setLoading(false);
    }
}

    // FUNCTION: Handle scanned location code
    function handleScanLocation(location: { id: string; code: string }) {
        if (!location?.id || !location?.code) return;

        if (!confirmWarehousesSelected()) return;


        const parsedLocation = {
            id: Number(location.id),
            code: location.code
        };

        if (isNaN(parsedLocation.id)) {
            console.error("❌ ID de ubicación inválido:", location.id);
            return;
        }

        console.log("📍 UBICACIÓN ESCANEADA:", parsedLocation);

        setFromLocation(parsedLocation);   // ✅ guardar ubicación
        setCurrentLine(null);              // 🔥 limpiar producto
        setQty("");                        // 🔥 limpiar cantidad
        setIsModalOpen(true);
    }



    // FUNCTION: Validar almacenes
    function confirmWarehousesSelected(): boolean {
        if (!locationOrigenRef.current || !locationDestinoRef.current) {
            openModal({
                title: "Seleccione los almacenes primero",
                message:
                    "Primero tiene que seleccionar almacén de origen y almacén de destino."
            });

            setEditLocation(false);
            return false;
        }

        return true;
    }


    /* FUNCTION: Send request to create transfer line
    async function saveTransferLine(payload: {
        productId: number;
        fromLocationId: number;
        qty: number | string;
    }) {
        try {
            const res = await apiClient.post("/transfer/line", payload);
            return res.data;

        } catch (error: any) {
            const data = error?.response?.data;

            openModal({
                title: titles[data?.code as keyof typeof titles] || "Error",
                message: data?.message || "Ocurrió un error"
            });

            throw error;


            // 👉 MUY IMPORTANTE: relanzar el error si el que llama lo necesita
            throw error;
        }
    }*/


    //FUNTION: To hanfle scanned product code
    // FUNCTION: Handle scanned product
    function handleScanProduct(product: {
        id: number | string;
        sku: string;
        description: string;
        uom?: string;
    }) {


        // ❌ Si no hay ubicación escaneada primero
        if (!fromLocationRef.current) {
            openModal({
                title: "Escanee una ubicación",
                message: "Primero debe escanear la ubicación y luego el producto."
            });
            return;
        }
        console.log(product)
        const parsedProduct: ScannedProduct = {
            id: Number(product.id),
            sku: product.sku,
            description: product.description,
            uom: product.uom
        };

        console.log(parsedProduct);

        if (isNaN(parsedProduct.id)) {
            console.error("❌ ID de producto inválido:", product.id);
            openModal({
                title: "Error de producto",
                message: "El producto tiene un ID inválido."
            });
            return;
        }

        console.log("✅ PRODUCTO PARSEADO:", parsedProduct);
        console.log("📍 UBICACIÓN ACTUAL:", fromLocationRef.current);

        setCurrentLine(parsedProduct);   // ✅ ahora sí es ScannedProduct
        setQty("");
        focusQtyInput();


    }

    //FUNCTION: To focus the input
    function focusQtyInput() {
        requestAnimationFrame(() => {
            qtyInputRef.current?.focus();
            qtyInputRef.current?.select();
        });
    }


    //FUNCTION: To close modal
    function closeModal() {
        setIsModalOpen(false);
        setFromLocation(null);
        setCurrentLine(null);              // 🔥 limpiar producto
        setQty("");                        // 🔥 limpiar cantidad
    }


    async function handleSelectOrigen(locationId: string) {
        const locations =
            activeLocationsRef.current?.length
                ? activeLocationsRef.current
                : activeLocations;

        const selected = locations.find((l: any) => String(l.id) === locationId);
        if (!selected) return;

        // guardar temporal
        console.log(locationDestino);
        setLocationOrigen(selected);
        console.log("📦 ORIGEN SELECCIONADO:", selected);

        try {
            const res = await apiClient.post("/warehouse-transfers/location-origen", {
                picking_id: pickingId,
                warehouse_id: selected.id
            });

            const data = res.data;

            if (!data.success) {
                throw new Error(data.message || "Error guardando origen");
            }

            console.log("✅ Origen guardado en picking");

        } catch (err: any) {
            console.error("❌ Error guardando origen:", err);

            // rollback visual
            setLocationOrigen(null);

            openModal({
                title: "Error",
                message:
                    err?.response?.data?.message ||
                    "La sesión de traslado no está activa"
            });
        }
    }

    async function handleSelectDestino(locationId: string) {
        const locations =
            activeLocationsRef.current?.length
                ? activeLocationsRef.current
                : activeLocations;

        const selected = locations.find((l: any) => String(l.id) === locationId);
        if (!selected) return;

        // guardar temporal
        setLocationDestino(selected);
        console.log("📦 DESTINO SELECCIONADO:", selected);

        try {
            const res = await apiClient.post("/warehouse-transfers/location-destino", {
                picking_id: pickingId,
                warehouse_id: selected.id
            });

            const data = res.data;

            if (!data.success) {
                throw new Error(data.message || "Error guardando destino");
            }

            console.log("✅ Destino guardado en picking");

        } catch (err: any) {
            console.error("❌ Error guardando destino:", err);

            // rollback visual
            setLocationDestino(null);

            openModal({
                title: "Error",
                message:
                    err?.response?.data?.message ||
                    "La sesión de traslado no está activa"
            });
        }
    }


    //FUNCTION: Para limpiar almacenes en el back end y front end
    async function clearWarehouses() {
        try {
            const res = await apiClient.post("/warehouse-transfers/clear-locations", {
                picking_id: pickingId
            });

            const data = res.data;

            if (!data.success) {
                throw new Error(data.message || "No se pudo limpiar");
            }

            console.log("🧹 Almacenes limpiados");

            // limpiar visual
            setLocationOrigen(null);
            setLocationDestino(null);
            setEditLocation(false);

        } catch (err: any) {
            console.error("❌ Error limpiando:", err);

            openModal({
                title: "Error",
                message:
                    err?.response?.data?.message ||
                    err.message ||
                    "No se pudieron limpiar los almacenes"
            });
        }
    }

    //FUNCTION: Para eliminar una linea del stock.line
    function askDeleteLine(id: number) {
        console.log("🗑 eliminar linea:", id);

        setDeleteLineId(id);
        setShowDeleteModal(true);
    }


    //Function: Para eliminar una linea en el back end de stock line
    async function confirmDeleteLine() {
        if (!deleteLineId) return;

        console.log("🔥 ELIMINAR LINEA:", deleteLineId);

        try {

            // 🔥 AQUI backend luego
            const res = await apiClient.post("/warehouse-transfers/delete-line", { deleteLineId: deleteLineId });

            if (!res.data.success) {
                setShowDeleteModal(false);
                openModal({
                    title: "Error",
                    message: res.data.message
                });
                return;
            }

            openModal({
                title: "Eliminando stock line back end",
                message: "Codigo pending..."
            });

            // 🔥 VUELVE A VALIDAR SESSION
            await authorizeSession();

        } catch (err: any) {

            console.log("🔥 ERROR:", err?.response?.data);

            openModal({
                title: err?.response?.data?.title || "Error",
                message:
                    err?.response?.data?.message ||
                    "Error eliminando línea"
            });
        }

        setShowDeleteModal(false);
        setDeleteLineId(null);
    }




    /* =======================
   UI STATES
======================= */

    const showProductEmpty = fromLocation && !currentLine;
    const showProductData = !!currentLine;
    //const showProductIdle = fromLocation && currentLine;

    if (loading) return <LoadingScreen />;

    /*console.log("FROM LOCATION:", fromLocation);
    console.log("CURRENT LINE:", currentLine);
    console.log("showProductData:", !!currentLine);
    console.log("showProductEmpty:", fromLocation && !currentLine);*/


    return (
        <div className="transfer-page">


            <div className="transfer-card">




                {/*AREA DE ARRIBA ALMACENES ELEGIDOS RESUMEN*/}
                {editLocation && (
                    <div className="transferSelectedBar">

                        {/* izquierda: origen → destino */}
                        <div className="transferSelectedInfo">
                            <div className="transferCodes">
                                <span className="code">{locationOrigen?.code}</span>

                                <svg
                                    className="arrowIcon"
                                    viewBox="0 0 480.026 480.026"
                                >
                                    <path d="M475.922,229.325l-144-160c-3.072-3.392-7.36-5.312-11.904-5.312h-96c-6.304,0-12.032,3.712-14.624,9.472
          c-2.56,5.792-1.504,12.544,2.72,17.216l134.368,149.312l-134.368,149.28c-4.224,4.704-5.312,11.456-2.72,17.216
          c2.592,5.792,8.32,9.504,14.624,9.504h96c4.544,0,8.832-1.952,11.904-5.28l144-160
          C481.394,244.653,481.394,235.373,475.922,229.325z"/>
                                    <path d="M267.922,229.325l-144-160c-3.072-3.392-7.36-5.312-11.904-5.312h-96c-6.304,0-12.032,3.712-14.624,9.472
          c-2.56,5.792-1.504,12.544,2.72,17.216l134.368,149.312L4.114,389.293c-4.224,4.704-5.312,11.456-2.72,17.216
          c2.592,5.792,8.32,9.504,14.624,9.504h96c4.544,0,8.832-1.952,11.904-5.28l144-160
          C273.394,244.653,273.394,235.373,267.922,229.325z"/>
                                </svg>

                                <span className="code">{locationDestino?.code}</span>
                            </div>
                        </div>

                        {/* botón */}
                        <div className="transferSelectedActions">
                            <button
                                className="btnChange"
                                onClick={clearWarehouses}
                            >
                                Cambiar
                            </button>
                        </div>

                    </div>
                )}


                {/*ARE PARA SELECCIONAR ALMACEN*/}
                {!editLocation && (
                    <>
                        {/* CONTENIDO */}
                        <div className="transferContent">

                            {/* TITULO */}
                            <div className="transferTitle">
                                Traslado de almacén
                            </div>

                            {/* ORIGEN */}
                            <div className="fieldBlock">
                                <label>Origen</label>

                                <div className="selectBigWrapper">
                                    <select
                                        className="selectBigInput"
                                        value={locationOrigen?.id || ""}
                                        onChange={(e) => handleSelectOrigen(e.target.value)}
                                    >
                                        <option value="">Seleccionar origen</option>

                                        {(activeLocationsRef.current?.length
                                            ? activeLocationsRef.current
                                            : activeLocations
                                        ).map((loc: any) => (
                                            <option key={loc.id} value={loc.id}>
                                                {loc.code} - {loc.name}
                                            </option>
                                        ))}
                                    </select>

                                    <div className="selectChevron"></div>
                                </div>
                            </div>

                            {/* DESTINO */}
                            <div className="fieldBlock">
                                <label>Destino</label>

                                <div className="selectBigWrapper">
                                    <select
                                        className="selectBigInput"
                                        value={locationDestino?.id || ""}
                                        onChange={(e) => handleSelectDestino(e.target.value)}
                                    >
                                        <option value="">Seleccionar destino</option>

                                        {(activeLocationsRef.current?.length
                                            ? activeLocationsRef.current
                                            : activeLocations
                                        ).map((loc: any) => (
                                            <option key={loc.id} value={loc.id}>
                                                {loc.code} - {loc.name}
                                            </option>
                                        ))}
                                    </select>

                                    <div className="selectChevron"></div>
                                </div>
                            </div>

                        </div>
                    </>
                )}



                {editLocation && (
                    <div className="warehouse-front-container">
                        {/* ORIGEN */}
                        <section className={`block block-location ${!fromLocation ? "empty" : ""}`}>
                            {fromLocation ? (
                                <>
                                    <div className="block-title">Ubicación Origen</div>

                                    <div className="pills">
                                        <button type="button" className="pill active">
                                            {fromLocation.code}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <div className="transfer-product-hint">
                                    LEA UNA UBICACIÓN DE ORIGEN
                                </div>
                            )}
                        </section>

                        {/* PRODUCTO */}
                        <section
                            className={`block block-product 
                        ${showProductEmpty ? "empty" : ""} 
                        ${showProductData ? "has-product" : ""}
                        `}
                        >Productos Cargados por el Usuario:</section>

                        {/* CANTIDAD */}
                        {/* 📋 TABLA */}
                        <div className="putaway-table-wrapper">
                            <table className="putaway-table">
                                <thead>
                                    <tr>
                                        <th>SKU</th>
                                        <th>Descripción</th>
                                        <th>Cantidad</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pendingLines.map((line) => (
                                        <tr key={line.id}>
                                            <td>{line.sku}</td>
                                            <td>{line.description}</td>
                                            <td>
                                                <div style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: "8px",
                                                    justifyContent: "center"
                                                }}>

                                                    {Number(line.product_qty)}

                                                    <svg
                                                        width="18"
                                                        height="18"
                                                        viewBox="0 0 512 512"
                                                        xmlns="http://www.w3.org/2000/svg"
                                                        style={{ cursor: "pointer" }}
                                                        onClick={() => askDeleteLine(Number(line.id))}
                                                    >
                                                        <path
                                                            clipRule="evenodd"
                                                            d="m256 512c140.997 0 256-115.003 256-256s-115.003-256-256-256-256 115.003-256 256 115.003 256 256 256z"
                                                            fill="#f34235"
                                                            fillRule="evenodd"
                                                        />
                                                        <path
                                                            d="m366.313 171.409h-220.626c-1.246 0-2.434.513-3.291 1.415-.863.909-1.311 2.123-1.246 3.369l11.593 223.69c.513 9.951 8.718 17.747 18.688 17.747h169.137c9.971 0 18.176-7.796 18.688-17.747l11.593-223.69c.065-1.246-.383-2.46-1.246-3.369-.856-.902-2.044-1.415-3.29-1.415zm-182.334 45.095c-.084-3.044 1.026-5.946 3.129-8.166s4.94-3.492 7.984-3.583c6.335-.13 11.593 4.842 11.775 11.126l4.213 157.024c.091 3.038-1.019 5.946-3.129 8.173-2.103 2.214-4.946 3.486-7.997 3.577h-.337c-2.928 0-5.7-1.11-7.848-3.148-2.213-2.103-3.486-4.94-3.57-7.978zm60.577 156.537v-157.044c0-6.316 5.135-11.451 11.444-11.451s11.444 5.135 11.444 11.451v157.044c0 6.322-5.135 11.464-11.444 11.464s-11.444-5.141-11.444-11.464zm79.245.474c-.084 3.051-1.357 5.888-3.57 7.991-2.148 2.038-4.92 3.148-7.848 3.148h-.357c-3.044-.091-5.881-1.363-7.978-3.583-2.11-2.226-3.22-5.128-3.129-8.179l4.213-156.998c.182-6.29 5.401-11.295 11.697-11.139h.078c3.044.091 5.881 1.363 7.984 3.583s3.213 5.122 3.129 8.166zm65.199-237.101v12.048h-266v-12.048c0-6.647 5.407-12.054 12.054-12.054h87.496c2.317 0 4.265-1.746 4.518-4.051 1.617-14.787 14.054-25.939 28.932-25.939s27.315 11.152 28.932 25.939c.253 2.304 2.2 4.051 4.518 4.051h87.496c6.647 0 12.054 5.407 12.054 12.054z"
                                                            fill="#fff"
                                                        />
                                                    </svg>

                                                </div>
                                            </td>

                                        </tr>
                                    ))}
                                </tbody>

                            </table>
                        </div>

                        {/* BOTONES */}
                        <section className="block-actions">
                            <button className="btn btn-exit" onClick={() => navigate("/menu")}>
                                Salir
                            </button>


                            <button className="btn btn-save pop-in" onClick={onSaveWarehouse}>
                                Confirmar
                            </button>

                        </section>
                    </div>
                )}



            </div>




            <ScanModal
                open={isModalOpen}
                title={fromLocation ? "Producto encontrado" : "No existe"}
                onClose={closeModal}
            >
                {fromLocation ? (
                    <div className="modal-transfer-card">
                        {/* ORIGEN */}
                        <section className={`block block-location ${!fromLocation ? "empty" : ""}`}>
                            {fromLocation ? (
                                <>
                                    <div className="block-title">Ubicación Origen</div>

                                    <div className="pills">
                                        <button type="button" className="pill active">
                                            {fromLocation.code}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <div className="scan-product-hint">
                                    LEA UNA UBICACIÓN DE ORIGEN
                                </div>
                            )}
                        </section>

                        {/* PRODUCTO */}
                        <section
                            className={`block block-product 
      ${showProductEmpty ? "empty" : ""} 
      ${showProductData ? "has-product" : ""}
    `}
                        >
                            {showProductData ? (
                                <>
                                    <div className="product-desc">{currentLine.description}</div>

                                    <div className="product-top">
                                        <div className="product-meta">
                                            <span className="label">Código del producto:</span>
                                            <span className="value">{currentLine.sku}</span>
                                        </div>
                                    </div>
                                </>
                            ) : showProductEmpty ? (
                                <div className="scan-product-hint">LEA UN PRODUCTO</div>
                            ) : (
                                <>
                                    <div className="product-desc"></div>
                                    <div className="product-top">
                                        <div className="product-meta">
                                            <span className="label">Código del producto:</span>
                                            <span className="value"></span>
                                        </div>
                                    </div>
                                </>
                            )}
                        </section>

                        {/* CANTIDAD */}
                        <section className={`block ${currentLine && !qty ? "ready" : ""}`}>
                            <div className="block-title">Cantidad</div>

                            <input
                                ref={qtyInputRef}
                                className="qty-input"
                                type="number"
                                value={qty}
                                onChange={(e) => setQty(e.target.value)}
                            />
                        </section>

                        {/* BOTONES */}
                        <section className="block-actions">
                            <button className="btn btn-exit" onClick={closeModal}>
                                Salir
                            </button>

                            {Number(qty) > 0 && (
                                <button className="btn btn-save pop-in" onClick={onSave}>
                                    Guardar
                                </button>
                            )}
                        </section>
                    </div>
                ) : (
                    <div>
                        Producto no existe
                    </div>
                )}
            </ScanModal>


            {showDeleteModal && (
                <div className="wtDeleteModalOverlay">

                    <div className="wtDeleteModalBox">
                        <h3 className="wtDeleteModalTitle">Eliminar línea</h3>

                        <p className="wtDeleteModalText">
                            ¿Desea eliminar esta línea del traslado?
                        </p>

                        <div className="wtDeleteModalActions">

                            <button
                                className="wtDeleteBtnCancel"
                                onClick={() => {
                                    setShowDeleteModal(false);
                                    setDeleteLineId(null);
                                }}
                            >
                                Cerrar
                            </button>

                            <button
                                className="wtDeleteBtnConfirm"
                                onClick={confirmDeleteLine}
                            >
                                Confirmar
                            </button>

                        </div>
                    </div>

                </div>
            )}



        </div>
    );
}
