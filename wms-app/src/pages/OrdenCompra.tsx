import { useParams } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { getReceptionByPOId, saveReceptionIDB, deleteReceptionByPOId } from "../services/receptionIDB.helpers.ts";
import apiClient from "../services/apiClient.ts";
import "../styles/OrdenCompra.css"
import OrderLineCard from "../components/OrderLineCard.tsx";
import ScanModal from "../components/ScanModal.tsx";
import { useNavigate } from "react-router-dom";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import { useModal } from "../context/ModalContext";





/* Tipos base */
type Product = {
    id: number;
    sku: string;
    description: string;
    ordered_qty: number;
    received_qty: number;
    min_received_qty: number;
    product_exists: boolean;
    barcodes: string[];
    erp_name: string | null;
    erp_sku: string | null;
    erp_id: number;
};

type Filter = "all" | "read" | "unread";

export default function OrdenCompra() {
    /* 1️⃣ Obtener ID desde la URL */
    const { id } = useParams<{ id: string }>();

    /* 2️⃣ Estados principales */
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isScannerMode, setIsScannerMode] = useState(true);
    /*const [scanInput, setScanInput] = useState<number>(0);*/
    const [products, setProducts] = useState<Product[]>([]);
    const [idbProducts, setIdbProducts] = useState<Product[]>([]);
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
    /*const [countQty, setCountQty] = useState<number>(0);*/
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [poNumber, setPoNumber] = useState<string>("");
    const [purchaseOrderId, setPurchaseOrderId] = useState<number | null>(null);
    const [filter, setFilter] = useState<Filter>("all");
    const [quantityError, setQuantityError] = useState(false);
    const [shakeKey, setShakeKey] = useState(0);

    const qtyInputRef = useRef<HTMLInputElement>(null);

    const scanBufferRef = useRef("");
    const scanTimerRef = useRef<number | null>(null);
    const productsRef = useRef<Product[]>([]);
    const lastCodeRef = useRef<string>("");
    const selectedIndexRef = useRef<number | null>(null);

    const navigate = useNavigate();

    const { openModal } = useModal();

    useEffect(() => {
        if (!id) return;
        console.log("CHECK 1")
        const poId = Number(id);
        if (isNaN(poId)) return;
        //fetchPurchaseOrderById(poId);
        setPurchaseOrderId(poId);

    }, [id]);

    useEffect(() => {
        console.log("CHECK 2")
        // mantener el ref sincronizado con el state
        productsRef.current = products;
    }, [products]);

    useEffect(() => {
        selectedIndexRef.current = selectedIndex;
    }, [selectedIndex]);

    useEffect(() => {
        if (!purchaseOrderId) return;

        const timeout = setTimeout(() => {
            saveReceptionIDB({
                id: purchaseOrderId,
                purchase_order_number: poNumber,
                lines: products,
            });
            console.log("💾 Guardado automático en IndexedDB");
        }, 2000); // ⏱️ ideal para scanner + input manual

        return () => clearTimeout(timeout);
    }, [products, purchaseOrderId, poNumber]);




    useEffect(() => {

        if (!purchaseOrderId) return;
        const loadData = async () => {
            setLoading(true);

            try {
                // 1️⃣ IndexedDB
                const local = await getReceptionByPOId(purchaseOrderId);

                if (local) {
                    console.log("LOCAL VARIABLE", local);
                    setIdbProducts(local.lines);
                }

                // 2️⃣ Backend
                const response = await apiClient.get(`/receiving/${purchaseOrderId}`);
                console.log("RESPUESTA BASE DE DATOS", response.data);
                const result = response.data;
                console.log("CHECK 5")
                if (!result.success) {
                    throw new Error(result.message || "Error cargando la orden de compra");
                    setError("Error cargando la orden de compra");
                }

                const data = result.data;

                setPoNumber(data.purchase_order_number);
                setProducts(
                    prioritizeMissingProducts(data.lines)
                );

                // 3️⃣ Guardar en IndexedDB
                if (!local?.lines || local.lines.length === 0) {
                    console.log("CHECK 6")
                    await saveReceptionIDB({
                        id: purchaseOrderId,
                        purchase_order_number: data.purchase_order_number,
                        lines: data.lines,
                    });
                }


            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        };

        loadData();
    }, [purchaseOrderId]);





    useEffect(() => {
        if (!poNumber || products.length === 0 || idbProducts.length === 0) return;

        // 3️⃣ Crear diccionario sku → received_qty
        console.log("CHECK 7")
        const receivedMap = new Map(
            idbProducts.map((p: Product) => [p.sku, p.received_qty])
        );

        console.log("DICCIONARIO:", receivedMap);

        // 4️⃣ Mezclar backend + local
        const mergedProducts = products.map((p: Product) => {
            const localQty = receivedMap.get(p.sku);
            //console.log(localQty);
            //console.log(p.received_qty);
            return {
                ...p,
                received_qty:
                    typeof localQty === "number"
                        ? Math.max(localQty, p.received_qty)
                        : p.received_qty,
            };
        });


        console.log("RESULTADO:", mergedProducts);

        setProducts(
            prioritizeMissingProducts(mergedProducts)
        );

    }, [poNumber, idbProducts]);



    useEffect(() => {
        if (!isScannerMode) return;
        console.log(products);
        console.log("CHECK 8")
        const onKeyDown = (e: KeyboardEvent) => {
            if (
                e.key === "Shift" ||
                e.key === "Control" ||
                e.key === "Alt" ||
                e.key === "Meta"
            ) return;

            // FIN DEL SCAN
            if (e.key === "Enter") {
                const code = scanBufferRef.current;
                scanBufferRef.current = "";
                console.log("CHECK 9")
                if (scanTimerRef.current) {
                    clearTimeout(scanTimerRef.current);
                    scanTimerRef.current = null;
                }

                handleScannedCode(code);
                return;
            }

            // Caracter válido
            if (e.key.length === 1) {
                scanBufferRef.current += e.key;

                if (scanTimerRef.current) {
                    clearTimeout(scanTimerRef.current);
                }

                scanTimerRef.current = window.setTimeout(() => {
                    scanBufferRef.current = "";
                    scanTimerRef.current = null;
                }, 200);
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => {
            window.removeEventListener("keydown", onKeyDown);
            if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
        };
    }, [isScannerMode]);

    // AFTER INDEX OBTAINED, SAVE SELECTED PRODUCT
    /* ---------- DERIVED VALUE (AQUÍ) ---------- */
    const selectedProduct =
        selectedIndex !== null ? products[selectedIndex] : null;

    const EPS = 0.000001; // tolerancia para “casi cero”

    const filteredProducts = products.filter((p) => {
        const qty = Number(p.received_qty); // convierte 0.000 o "0.000" a 0

        if (Number.isNaN(qty)) return filter === "all"; // o decide qué hacer si es inválido

        if (filter === "read") return qty > EPS;        // > 0 real
        if (filter === "unread") return Math.abs(qty) <= EPS; // 0, 0.000, etc.
        return true;
    });
    // FUNCION PARA CERRAR MODAL
    function closeModal() {
        //Hacer que no se cierre si es menor a cero
        if (
            selectedProduct &&
            typeof selectedProduct.received_qty === "number" &&
            selectedProduct.received_qty < 0
        ) {
            openModal({
                title: "Ubicación inválida",
                message: "El código escaneado NO es una ubicacion valida"
            });
            return;
        }
        setIsModalOpen(false);
        setSelectedIndex(null);
        lastCodeRef.current = "";
        setIsScannerMode(true); // opcional: reactivar scanner
    }



    //FUNCTION TO SEARCH PRODUCT BARCODES
    function handleScannedCode(code: string) {
        const barcode = code.trim();
        if (!barcode) return;
        console.log("CHECK 10")
        console.log("RECIBIDO:", barcode);
        console.log("LAST REF:", lastCodeRef.current);

        // 🔒 bloqueo de repetidos
        if (barcode === lastCodeRef.current) {
            console.log("CODIGO REPETIDO, IGNORADO");
            incrementReceivedQty();
            return;
        }

        // actualizar ref (INMEDIATO)
        lastCodeRef.current = barcode;
        setQuantityError(false);
        console.log("CHECK 12")
        // 2️⃣ Cerrar modal primero
        setIsModalOpen(false);

        // 3️⃣ Buscar producto cuyo barcodes[] incluya el código
        let foundProduct = productsRef.current.find((product) =>
            Array.isArray(product.barcodes) &&
            product.barcodes.length > 0 &&
            product.barcodes.includes(barcode)
        );
        let index = productsRef.current.findIndex((product) =>
            Array.isArray(product.barcodes) &&
            product.barcodes.length > 0 &&
            product.barcodes.includes(barcode)
        );

        // 🔥 fallback a SKU
        if (!foundProduct) {
            foundProduct = productsRef.current.find(
                (product) => product.sku === barcode
            );

            index = productsRef.current.findIndex(
                (product) => product.sku === barcode
            );
        }
        console.log(productsRef.current);
        console.log("Producto encontrado:", foundProduct);
        if (index === -1) {
            // ❌ Producto NO existe
            setSelectedIndex(null);
            setIsModalOpen(true);
        } else {
            // ✅ Producto encontrado
            setSelectedIndex(index);
            selectedIndexRef.current = index;
            setIsModalOpen(true);
        }
    }

    useEffect(() => {
        console.log("PRODUCTS ACTUALIZADO:", products);
    }, [products]);


    //FUNCTION TO MOVE MISSING PRODUCTS TO 1ST PLACE
    function prioritizeMissingProducts(lines: Product[]): Product[] {
        const missing = lines.filter(p => p.product_exists === false);
        const existing = lines.filter(p => p.product_exists !== false);

        return [...missing, ...existing];
    }

    function handleReceivedQtyChange(e: React.ChangeEvent<HTMLInputElement>) {
        if (selectedIndex === null) return;

        const value = e.target.value;

        if (value !== "" && !/^\d+$/.test(value)) return;

        setProducts(prev => {
            setQuantityError(false);
            const currentProduct = prev[selectedIndex];

            const numericValue =
                value === ""
                    ? 0
                    : Math.min(Number(value), currentProduct.ordered_qty);

            const updated = [...prev];

            if (Number(value) > currentProduct.ordered_qty) {
                setQuantityError(true);
                setShakeKey(prev => prev + 1); // 🔥 fuerza re-render
            } else {
                setQuantityError(false);
            }

            const updatedProduct = {
                ...currentProduct,
                received_qty: numericValue,
            };

            updated.splice(selectedIndex, 1);
            updated.unshift(updatedProduct);

            return updated;
        });

        setSelectedIndex(0);
    }

    function handleReceivedQtyBlur() {
        if (selectedIndex === null) return;

        setProducts(prev => {
            const updated = [...prev];
            const current = updated[selectedIndex];

            let finalQty = Number(current.received_qty) || 0;

            if (finalQty < current.min_received_qty) {
                finalQty = current.min_received_qty;
            }

            if (finalQty > current.ordered_qty) {
                finalQty = current.ordered_qty;
            }

            updated[selectedIndex] = {
                ...current,
                received_qty: finalQty
            };

            return updated;
        });
    }


    // FUNCTION TO ADD +1 TO THE PRODUCT USING SCANNER
    function incrementReceivedQty() {
        const index = selectedIndexRef.current;
        if (index === null) return;

        setProducts(prev => {
            setQuantityError(false);
            const updated = [...prev];
            const current = updated[index];

            const nextQty = current.received_qty + 1;
            const safeQty = Math.min(nextQty, current.ordered_qty);

            const updatedProduct = {
                ...current,
                received_qty: safeQty,
            };
            console.log("NEXTQTY ", nextQty);
            console.log("ORDERED ", current.ordered_qty);
            if (nextQty > current.ordered_qty) {
                setQuantityError(true);
                setShakeKey(prev => prev + 1); // 🔥 fuerza re-render
            } else {
                setQuantityError(false);
            }


            updated.splice(index, 1);
            updated.unshift(updatedProduct);

            return updated;
        });

        // actualizar ambos
        setSelectedIndex(0);
        selectedIndexRef.current = 0;
    }

    // FUNCTION TO SAVE RECEPTION TO BACK END

    async function saveReceptionToBackend(receptionStatus: string) {
        if (!purchaseOrderId) {
            console.error("❌ purchaseOrderId no existe");
            return;
        }

        try {
            const response = await apiClient.post("/receiving/save", {
                purchase_order_id: purchaseOrderId,
                purchase_order_number: poNumber,
                reception_status: receptionStatus,
                lines: products.map(p => ({
                    id: Number(p.id),
                    received_qty: Number(p.received_qty),
                })),
            });


            const result = response.data;
            console.log("✅ RESPUESTA BACKEND:", result);

            if (!result.success) {
                throw new Error(result.message || "Error guardando recepción");
            }

            // 🧹 BORRAR INDEXEDDB SOLO SI EL BACKEND CONFIRMA
            await deleteReceptionByPOId(purchaseOrderId);

            console.log("🗑️ IndexedDB limpiado correctamente");


        } catch (error: any) {
            console.error("❌ Error guardando recepción:", error);
            alert("Ocurrió un error al guardar la recepción");
        }
    }





    if (loading) {
        return <LoadingScreen />;
    }


    if (error) {
        return (
            <div style={{ padding: 20 }}>
                <p style={{ color: "red" }}>{error}</p>
            </div>
        );
    }



    return (
        <div className="page-orden-compra">
            <div>{scanBufferRef.current}</div>
            <div className="container-title">
                <div className="order-div-a">
                    {/* SVG */}
                    <div className="order-icon">
                        <svg className="oder-icon-svg" id="fi_9752284" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"><path d="m45 53v-44c0-2.2-1.8-4-4-4h-36c-2.2 0-4 1.8-4 4v44c0 2.2 1.8 4 4 4h36c2.209 0 4-1.791 4-4z" fill="#ad6d40"></path><rect fill="#f8f8ff" height="44" rx="1" width="36" x="5" y="9"></rect><path d="m31 5v3c0 1.1-.9 2-2 2h-12c-1.1 0-2-.9-2-2v-3c0-.55.45-1 1-1h3.13c.44-1.73 2.01-3 3.87-3s3.43 1.27 3.87 3h3.13c.55 0 1 .45 1 1z" fill="#cbcbf4"></path><path d="m59 29.96v27.04c0 1.1-.9 2-2 2h-30c-1.1 0-2-.9-2-2v-27.04z" fill="#ea9453"></path><path d="m58.695 29.237-5.934-5.934c-.194-.194-.456-.303-.73-.303h-20.061c-.274 0-.537.109-.73.303l-5.934 5.934c-.651.651-.19 1.763.73 1.763h31.93c.92 0 1.381-1.112.73-1.763z" fill="#fcb36b"></path><path d="m47 31v7c0 .552-.448 1-1 1h-8c-.552 0-1-.448-1-1v-7l1-1h8z" fill="#723535"></path><rect fill="#fff" height="5" rx="1" width="7" x="29" y="50"></rect><path d="m47 31-3-8h-4l-3 8z" fill="#914747"></path><path d="m48.707 49.293c-.391-.391-1.023-.391-1.414 0l-1 1c-.391.391-.391 1.023 0 1.414.195.195.451.293.707.293v3c0 .553.447 1 1 1s1-.447 1-1v-3c.256 0 .512-.098.707-.293.391-.391.391-1.023 0-1.414z" fill="#20295e"></path><path d="m55.707 50.293-1-1c-.391-.391-1.023-.391-1.414 0l-1 1c-.391.391-.391 1.023 0 1.414.195.195.451.293.707.293v3c0 .553.447 1 1 1s1-.447 1-1v-3c.256 0 .512-.098.707-.293.391-.391.391-1.023 0-1.414z" fill="#20295e"></path><g fill="#43a867"><path d="m14 23c-.264 0-.519-.104-.707-.293l-2-2c-.391-.391-.391-1.023 0-1.414s1.023-.391 1.414 0l1.138 1.138 3.323-4.985c.306-.46.926-.584 1.387-.277.46.307.584.927.277 1.387l-4 6c-.166.249-.436.411-.733.44-.033.003-.066.005-.099.005z"></path><path d="m14 35c-.264 0-.519-.104-.707-.293l-2-2c-.391-.391-.391-1.023 0-1.414s1.023-.391 1.414 0l1.138 1.138 3.323-4.985c.306-.46.926-.584 1.387-.277.46.307.584.927.277 1.387l-4 6c-.166.249-.436.411-.733.44-.033.003-.066.005-.099.005z"></path><path d="m14 47c-.264 0-.519-.104-.707-.293l-2-2c-.391-.391-.391-1.023 0-1.414s1.023-.391 1.414 0l1.138 1.138 3.323-4.985c.306-.46.926-.583 1.387-.277.46.307.584.927.277 1.387l-4 6c-.166.249-.436.411-.733.44-.033.003-.066.005-.099.005z"></path></g></svg>
                    </div>

                    {/* DETAILS */}
                    <div className="order-details">
                        <div className="order-number">{poNumber}</div>
                        <div className="order-number-title">Orden de Compra</div>
                    </div>
                </div>
                <div className="order-div-b">
                    {/* ⏸️ PAUSAR */}
                    <button onClick={async () => {
                        await saveReceptionToBackend("paused");
                        navigate("/menu");
                    }} className="pill-btn pause-btn">
                        <span className="icon">
                            {/* ICONO PAUSA */}
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <rect x="6" y="4" width="4" height="16" />
                                <rect x="14" y="4" width="4" height="16" />
                            </svg>
                        </span>
                        <span className="label">Pausar</span>
                    </button>

                    {/* ✅ FINALIZAR */}
                    <button onClick={async () => {
                        await saveReceptionToBackend("in_progress");
                        navigate(`/validation/${purchaseOrderId}`);
                    }} className="pill-btn finish-btn">
                        <span className="icon">
                            {/* ICONO CHECK */}
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M9 16.2l-3.5-3.5-1.4 1.4L9 19 20.3 7.7l-1.4-1.4z" />
                            </svg>
                        </span>
                        <span className="label">Finalizar</span>
                    </button>
                </div>
            </div>

            <div className="order-container-table">
                <div className="order-lines-header">
                    <div>Código</div>
                    <div>Descripción</div>
                    <div>Recibida</div>
                    <div>Diferencia</div>
                </div>

                <div className="lines-list">
                    {filteredProducts.map((line) => (
                        <OrderLineCard key={line.id} line={line} />
                    ))}
                </div>
            </div>


            <div className="filter-bar">
                <div className="filter-bar-inner">
                    <button
                        className={filter === "all" ? "active" : ""}
                        onClick={() => setFilter("all")}
                    >
                        Todas
                    </button>

                    <button
                        className={filter === "unread" ? "active" : ""}
                        onClick={() => setFilter("unread")}
                    >
                        Pendientes
                    </button>

                    <button
                        className={filter === "read" ? "active" : ""}
                        onClick={() => setFilter("read")}
                    >
                        Contadas
                    </button>
                </div>
            </div>

            <ScanModal
                open={isModalOpen}
                title={selectedProduct ? "Producto encontrado" : "Producto no existe"}
                onClose={closeModal}
            >
                {selectedProduct ? (
                    <div className="modal-container">
                        <div className={`modal-sku ${selectedProduct.received_qty === selectedProduct.ordered_qty
                            ? "confirmed"
                            : ""
                            }`}>{selectedProduct.erp_name}</div>

                        <div className="modal-description">{selectedProduct.description} / PN: {selectedProduct.erp_sku} / ID: {selectedProduct.erp_id} / {selectedProduct.sku}</div>

                        <div className="qty-row">
                            <input
                                ref={qtyInputRef}
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={selectedProduct.received_qty}
                                onChange={handleReceivedQtyChange}
                                onBlur={handleReceivedQtyBlur}
                                className="quantity-input"
                                onFocus={() => {
                                    requestAnimationFrame(() => {
                                        const input = qtyInputRef.current;
                                        if (!input) return;
                                        input.select();
                                    });
                                }}




                            />

                            <span className="qty-separator">|</span>

                            <div className="ordered-qty">
                                {selectedProduct.ordered_qty}
                            </div>
                        </div>
                        {quantityError && (
                            <div key={shakeKey} className={`quantity-error-alert ${quantityError ? "shake" : ""}`}>
                                ⚠️ CANTIDAD MAYOR A LA ORDEN DE COMPRA
                            </div>
                        )}



                        <div className="modal-footer">
                            <button className="btn-close-green" onClick={closeModal}>
                                Cerrar
                            </button>
                        </div>

                    </div>
                ) : (
                    <div className="modal-container">
                        <div className="modal-error">
                            <svg fill="white" id="fi_2976286" enable-background="new 0 0 320.591 320.591" height="40" viewBox="0 0 320.591 320.591" width="40" xmlns="http://www.w3.org/2000/svg"><g><g id="close_1_"><path d="m30.391 318.583c-7.86.457-15.59-2.156-21.56-7.288-11.774-11.844-11.774-30.973 0-42.817l257.812-257.813c12.246-11.459 31.462-10.822 42.921 1.424 10.362 11.074 10.966 28.095 1.414 39.875l-259.331 259.331c-5.893 5.058-13.499 7.666-21.256 7.288z"></path><path d="m287.9 318.583c-7.966-.034-15.601-3.196-21.257-8.806l-257.813-257.814c-10.908-12.738-9.425-31.908 3.313-42.817 11.369-9.736 28.136-9.736 39.504 0l259.331 257.813c12.243 11.462 12.876 30.679 1.414 42.922-.456.487-.927.958-1.414 1.414-6.35 5.522-14.707 8.161-23.078 7.288z"></path></g></g></svg>
                        </div>

                        <div className="modal-description">
                            <p>El producto no esta en la orden de compra.</p>
                        </div>

                        <div className="modal-error-action">
                            Por favor, verifica el codigo ingresado.
                        </div>

                        <div className="modal-footer">
                            <button className="btn-close-green" onClick={closeModal}>
                                Cerrar
                            </button>
                        </div>

                    </div>

                )}
            </ScanModal>

        </div>
    );
}
