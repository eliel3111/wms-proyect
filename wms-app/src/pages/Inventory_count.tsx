import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/InventoryCount.css";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import { LoadingScreen } from "../components/LoadingScreen";
import type { ApiErrorResponse } from "../types/apiError";



type Location = {
    id: number;
    code: string;
};

type ScannedProduct = {
    id: number;
    sku: string;
    description: string;
    erp_id?: number;
    erp_name?: string;
    erp_sku?: string;
    uom?: string;
};



export default function Inventory_count() {
    const navigate = useNavigate();
    const { openModal, closeModal } = useModal();
    const [loading, setLoading] = useState(true);
    const [sessionId, setSessionId] = useState<number | null>(null);



    const [currentLine, setCurrentLine] = useState<ScannedProduct | null>(null);
    const currentLineRef = useRef<ScannedProduct | null>(null);

    const [fromLocation, setFromLocation] = useState<Location | null>(null);
    const fromLocationRef = useRef<Location | null>(null);





    const [qty, setQty] = useState<string>("");
    const qtyRef = useRef<string>("");


    const scanBuffer = useRef<string>("");
    const lastScannerKeyTimeRef = useRef<number>(0);
    const qtyInputRef = useRef<HTMLInputElement | null>(null);


    useEffect(() => {
        currentLineRef.current = currentLine;
    }, [currentLine]);

    useEffect(() => {
        fromLocationRef.current = fromLocation;
    }, [fromLocation]);

    useEffect(() => {
        qtyRef.current = qty;
    }, [qty]);


    /* =======================
       LOAD PENDING TRANSFERS
    ======================= */
    useEffect(() => {
        loadInventorySession();
    }, []);

    async function loadInventorySession() {
        try {
            setLoading(true);

            const res =
                await apiClient.get(
                    "/inventory/session-status"
                );

            const data = res.data;
            console.log("SESSION DE INVENTARIO: ", data);

            if (!data.hasActiveSession) {
                openModal({
                    title: data.title || "Error",
                    message:
                        data.message ||
                        "No existe una sesión de inventario activa."
                });

                return;
            }

            if (data.session?.id) {
                setSessionId(
                    Number(data.session.id)
                );
            }
        } catch (error) {
            openModal({
                title: "Error",
                message:
                    "No fue posible validar la sesión de inventario."
            });
        } finally {
            setLoading(false);
        }
    }

    function normalizeScannedCode(raw: string) {
        let scanned = String(raw || "")
            .replace(/[\r\n]+/g, "")
            .trim()
            .toUpperCase();

        // Protección extra:
        // Si llega "10ST-A1-02", lo convierte en "ST-A1-02"
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
                scanBuffer.current = "";
                lastScannerKeyTimeRef.current = 0;
                return;
            }

            // =====================================================
            // 2. Termina el scan con Enter o Tab
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
                console.log("📍 LOCATION ACTUAL REF:", fromLocationRef.current);
                console.log("📦 PRODUCTO ACTUAL REF:", currentLineRef.current);
                console.log("🔢 QTY ACTUAL REF:", qtyRef.current);

                try {
                    const res = await apiClient.post("/inventory/scanned", {
                        productScanned: scanned,
                        locationScanned: fromLocationRef.current?.code ?? null
                    });

                    console.log("RESPUESTA:", res);

                    const data = res.data;

                    // 🟢 ES UBICACIÓN
                    if (data.success && data.type === "location") {
                        closeModal();

                        console.log("📍 UBICACIÓN DETECTADA:", data.data);

                        handleScanLocation(data.data);

                        setQty(data.qty || "");
                        qtyRef.current = String(data.qty || "");
                    }

                    // 🔵 ES PRODUCTO
                    else if (data.success && data.type === "product") {
                        closeModal();

                        console.log("📦 PRODUCTO DETECTADO:", data.data);

                        handleScanProduct(data.data);
                    }

                    // 🔴 ERROR
                    else if (!data.success) {
                        console.log("❌ ERROR:", data.message);

                        openModal({
                            title: data.title || "Error",
                            message: data.message || "Ocurrió un error."
                        });

                        return;
                    }

                } catch (error) {
                    console.error("🔥 Error llamando /inventory/scanned:", error);
                }

                return;
            }

            // =====================================================
            // 3. Acumular caracteres del scanner
            // =====================================================
            if (e.key.length === 1) {
                const now = Date.now();

                // Si pasó mucho tiempo entre teclas, era escritura manual vieja.
                // Limpiamos para que no se pegue con el scan nuevo.
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

    /* =======================
       SAVE TRANSFER DROP
    ======================= */

    async function onSave() {
        if (!currentLine || !fromLocation || !sessionId) {
            return;
        }

        const qtyNumber = Number(qty);

        if (!qty || qtyNumber < 0) {
            openModal({
                title: "Cantidad inválida",
                message: "Ingrese una cantidad válida."
            });
            return;
        }

        try {

            const result = await applyInventoryCount({
                locationSelected: fromLocation.id,
                productSelected: currentLine.id,
                qty: qtyNumber
            });

            if (!result.success) {
                openModal({
                    title: result.title,
                    message: result.message
                });
                return;
            }

            setQty("");
            setCurrentLine(null);
            setFromLocation(null);

            qtyRef.current = "";
            currentLineRef.current = null;
            fromLocationRef.current = null;
            scanBuffer.current = "";
            lastScannerKeyTimeRef.current = 0;
            qtyInputRef.current?.blur();

            openModal({
                title: result.title || "Conteo guardado",
                message: result.message || "El conteo fue registrado correctamente."
            });

        } catch (error) {
            console.error("Error guardando conteo:", error);
        }
    }


    // FUNCTION: Handle scanned location code
    function handleScanLocation(
        location: {
            id: string;
            code: string;
        }
    ) {
        if (!location?.id || !location?.code)
            return;

        const parsedLocation = {
            id: Number(location.id),
            code: location.code
        };

        if (
            isNaN(parsedLocation.id)
        ) {
            console.error(
                "ID de ubicación inválido:",
                location.id
            );
            return;
        }

        console.log(
            "UBICACIÓN ESCANEADA:",
            parsedLocation
        );

        /*
            Escanea ubicación
            ↓
            Guarda ubicación
            ↓
            Limpia producto anterior
            ↓
            Limpia cantidad anterior
        */

        setFromLocation(parsedLocation);
        fromLocationRef.current = parsedLocation;

        setCurrentLine(null);
        currentLineRef.current = null;

        setQty("");
        qtyRef.current = "";

        scanBuffer.current = "";
        lastScannerKeyTimeRef.current = 0;


    }



    async function applyInventoryCount(payload: {
        locationSelected: number;
        productSelected: number;
        qty: number;
    }) {
        try {

            const res = await apiClient.post(
                "/inventory/apply-count",
                payload
            );

            return res.data;

        } catch (error: any) {

            const data =
                error.response?.data as ApiErrorResponse | undefined;

            if (!data) {
                openModal({
                    title: "Error",
                    message: "Error desconocido."
                });

                throw error;
            }

            openModal({
                title: data.title || "Error",
                message: data.message
            });

            throw error;
        }
    }


    //FUNTION: To hanfle scanned product code
    // FUNCTION: Handle scanned product
    function handleScanProduct(product: {
        id: number | string;
        sku: string;
        description: string;
        uom?: string;
        erp_id?: number;
        erp_name?: string;
        erp_sku?: string;
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
            uom: product.uom,

            erp_id: product.erp_id,
            erp_name: product.erp_name,
            erp_sku: product.erp_sku
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

        setCurrentLine(parsedProduct);
        currentLineRef.current = parsedProduct;

        setQty("");
        qtyRef.current = "";

        scanBuffer.current = "";
        lastScannerKeyTimeRef.current = 0;

        focusQtyInput();

    }

    //FUNCTION: To focus the input
    function focusQtyInput() {
        requestAnimationFrame(() => {
            qtyInputRef.current?.focus();
            qtyInputRef.current?.select();
        });
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

                {/* ORIGEN */}
                <section className={`block block-location ${!fromLocation ? "empty" : ""}`}>
                    {fromLocation ? (
                        <>
                            <div className="block-title">Ubicación destino</div>

                            <div className="pills">
                                {fromLocation ? (
                                    <button type="button" className="pill active">
                                        {fromLocation.code}
                                    </button>
                                ) : (
                                    ""
                                )}
                            </div>
                        </>) : (<div className="scan-product-hint">
                            LEA UNA UBICACIÓN
                        </div>)}
                </section>


                {/* 1) PRODUCTO */}
                <section
                    className={`block block-product 
    ${showProductEmpty ? "empty" : ""} 
    ${showProductData ? "has-product" : ""}
  `}
                >

                    {showProductData ? (
                        /* 🟢 Hay producto */
                        <>
                            <div className="product-desc">
                                {currentLine.erp_name} / {currentLine.erp_sku} / {currentLine.description}
                            </div>

                            <div className="product-top">
                                <div className="product-meta">
                                    <span className="label">Código del producto:</span>
                                    <span className="value">
                                        {currentLine.sku}
                                    </span>
                                </div>
                            </div>
                        </>
                    ) : showProductEmpty ? (
                        /* 🟡 Hay ubicación, falta producto */
                        <div className="scan-product-hint">
                            LEA UN PRODUCTO
                        </div>
                    ) : (
                        /* 🔵 Estado inicial */
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
                <section
                    className={`block ${currentLine && !qty ? "ready" : ""}`}
                >

                    <div className="block-title">Cantidad</div>
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
                            setQty(e.target.value);
                            qtyRef.current = e.target.value;
                        }}
                    />
                </section>

                {/* BOTONES */}
                <section className="block-actions">
                    <button className="btn btn-exit" onClick={() => navigate("/menu")}>
                        Salir
                    </button>

                    {Number(qty) > 0 && (
                        <button className="btn btn-save pop-in" onClick={onSave}>
                            Guardar
                        </button>
                    )}
                </section>


            </div>
        </div>
    );
}
