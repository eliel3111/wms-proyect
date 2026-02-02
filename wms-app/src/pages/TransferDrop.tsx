import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/Transfer.css";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import { LoadingScreen } from "../components/LoadingScreen";
import type { ApiErrorResponse } from "../types/apiError";
import { errorTitles } from "../constants/errorTitles";


type Location = {
    id: number;
    code: string;
};

type ScannedProduct = {
    id: number;
    sku: string;
    description: string;
    uom?: string;
};



export default function TransferPickPage() {
    const navigate = useNavigate();
    const { openModal } = useModal();
    const [loading, setLoading] = useState(true);
    const [sessionId, setSessionId] = useState<number | null>(null);

    const [pendingLines, setPendingLines] = useState<any[]>([]);

    const [currentLine, setCurrentLine] = useState<ScannedProduct | null>(null);
    const currentLineRef = useRef<ScannedProduct | null>(null);

    const [fromLocation, setFromLocation] = useState<Location | null>(null);
    const fromLocationRef = useRef<Location | null>(null);





    const [qty, setQty] = useState<string>("");
    const qtyRef = useRef<string>("");


    const scanBuffer = useRef<string>("");
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
        loadPendingTransfers();
    }, []);

    async function loadPendingTransfers() {
        try {
            setLoading(true);
            const res = await apiClient.get("/transfer/pending");

            if (!res.data.success) throw new Error();
            console.log(res.data.data);
            setSessionId(Number(res.data.sessionId));
            setPendingLines(res.data.data);
        } catch (err) {
            openModal({
                title: "Error",
                message: "La session de traslado no esta activa"
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
        if (!currentLine || !fromLocation || !fromLocation || !sessionId) return;

        const qtyNumber = Number(qty);
        if (!qty || qtyNumber <= 0) {
            openModal({ title: "Cantidad inválida", message: "Ingrese una cantidad válida." });
            return;
        }

        try {
            await saveTransferLine({
                transfer_session_id: sessionId,
                product_sku: currentLine.sku,
                to_location_code: fromLocation.code,
                qty
            });


            setQty("");
            setCurrentLine(null);


            await loadPendingTransfers();

            openModal({ title: "OK", message: "Transferencia registrada." });

        } catch (err) {
            // ❌ NO abrir modal aquí (ya se abrió en saveTransferLine)
            console.error("Transfer falló (ya manejado):", err);
        }
    }

    // FUNCTION: Handle scanned location code
    function handleScanLocation(location: { id: string; code: string }) {
        if (!location?.id || !location?.code) return;

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
    }



    // FUNCTION: Send request to create transfer line
    async function saveTransferLine(payload: {
        transfer_session_id: number;
        product_sku: string;
        to_location_code: number | string;
        qty: number | string;
    }) {
        try {
            const res = await apiClient.post("/transfer/drop", payload);
            return res.data;

        } catch (error: any) {
            const data = error.response?.data as ApiErrorResponse | undefined;

            if (!data) {
                openModal({
                    title: "Error",
                    message: "Error desconocido"
                });
                return;
            }

            openModal({
                title: errorTitles[data.code] || "Error",
                message: data.message
            });


            // 👉 MUY IMPORTANTE: relanzar el error si el que llama lo necesita
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
                            LEA UNA UBICACIÓN DE DESTINO
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
                                {currentLine.description}
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
                        onChange={(e) => setQty(e.target.value)}
                    />
                </section>

                {/* BOTONES */}
                <section className="block-actions">
                    <button className="btn btn-exit" onClick={() => navigate("/transfer")}>
                        Salir
                    </button>

                    {Number(qty) > 0 && (
                        <button className="btn btn-save pop-in" onClick={onSave}>
                            Guardar
                        </button>
                    )}
                </section>

                {/* 🔽 TABLA DE PENDIENTES */}
                {pendingLines.length > 0 && (
                    <>
                        <div className="transfer-subtitle">
                            <h3 className="transfer-pending-title">Transferencias pendientes</h3>
                        </div>

                        <div className="transfer-table-wrapper">
                            <table className="transfer-table">
                                <thead>
                                    <tr>
                                        <th>SKU</th>
                                        <th>Descripción</th>
                                        <th className="only-mobile">Origen</th>
                                        <th className="only-mobile">Destino</th>
                                        <th>Pendiente</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pendingLines.map((line) => (
                                        <tr key={line.id}>
                                            <td>{line.sku}</td>
                                            <td>{line.description}</td>
                                            <td className="only-mobile">{line.from_location}</td>
                                            <td className="only-mobile">{line.to_location}</td>
                                            <td>{Number(line.pending_qty)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
