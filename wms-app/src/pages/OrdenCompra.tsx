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

    // Código que originó el modal de productos repetidos
    const repeatedScannedCodeRef =
        useRef<string>("");

    // ID exacto de la línea repetida elegida por el usuario
    const selectedRepeatedProductIdRef =
        useRef<number | null>(null);

    // ===============================================
    // PRODUCTOS REPETIDOS EN LA ORDEN
    // ===============================================

    const [repeatedProducts, setRepeatedProducts] =
        useState<Product[]>([]);

    const [isRepeatedModalOpen, setIsRepeatedModalOpen] =
        useState(false);



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



    // ===============================================
    // CANTIDADES VISIBLES DE LA RECEPCIÓN ACTUAL
    // ===============================================

    function getPreviousReceived(
        product: Product
    ): number {
        return Math.max(
            Number(product.min_received_qty ?? 0),
            0
        );
    }

    function getDisplayReceived(
        product: Product
    ): number {
        return Math.max(
            Number(product.received_qty ?? 0) -
            getPreviousReceived(product),
            0
        );
    }

    function getDisplayOrdered(
        product: Product
    ): number {
        return Math.max(
            Number(product.ordered_qty ?? 0) -
            getPreviousReceived(product),
            0
        );
    }


    // AFTER INDEX OBTAINED, SAVE SELECTED PRODUCT
    /* ---------- DERIVED VALUE (AQUÍ) ---------- */
    const selectedProduct =
        selectedIndex !== null ? products[selectedIndex] : null;
    const selectedDisplayReceived =
        selectedProduct
            ? getDisplayReceived(selectedProduct)
            : 0;

    const selectedDisplayOrdered =
        selectedProduct
            ? getDisplayOrdered(selectedProduct)
            : 0;
    const EPS = 0.000001; // tolerancia para “casi cero”

    const filteredProducts = products.filter(
        (product) => {
            const currentReceptionQty =
                getDisplayReceived(product);

            if (
                filter === "read"
            ) {
                return currentReceptionQty > EPS;
            }

            if (
                filter === "unread"
            ) {
                return (
                    Math.abs(currentReceptionQty) <= EPS
                );
            }

            return true;
        }
    );
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
        setIsModalOpen(false);

        setSelectedIndex(null);

        selectedIndexRef.current =
            null;

        // 🔥 Ya terminó de trabajar esta línea repetida
        selectedRepeatedProductIdRef.current =
            null;

        repeatedScannedCodeRef.current =
            "";

        lastCodeRef.current =
            "";

        setIsScannerMode(true);
    }


    // ======================================================
    // CERRAR MODAL DE PRODUCTOS REPETIDOS
    // ======================================================

   function closeRepeatedProductsModal() {

    console.log(
        "❌ Cerrando modal de productos repetidos"
    );


    // Cerrar modal
    setIsRepeatedModalOpen(false);


    // Vaciar productos
    setRepeatedProducts([]);


    // Quitar selección
    setSelectedIndex(null);

    selectedIndexRef.current =
        null;


    // Ninguna línea repetida elegida
    selectedRepeatedProductIdRef.current =
        null;


    // Limpiar código que abrió el modal
    repeatedScannedCodeRef.current =
        "";


    // Permitir volver a escanear
    lastCodeRef.current =
        "";


    // Limpiar buffer
    scanBufferRef.current =
        "";


    // Reactivar scanner
    setIsScannerMode(true);
}
    // ======================================================
    // SELECCIONAR UNA LÍNEA DE PRODUCTO REPETIDO
    // ======================================================

    function selectRepeatedProduct(
        product: Product
    ) {

        console.log("");
        console.log("✅✅✅ ========================================");
        console.log("✅ LÍNEA REPETIDA SELECCIONADA");
        console.log("✅✅✅ ========================================");

        console.log({
            id: product.id,
            sku: product.sku,
            erp_id: product.erp_id,
            erp_sku: product.erp_sku,
            ordered_qty: product.ordered_qty,
            received_qty: product.received_qty
        });


        // ==================================================
        // 1️⃣ BUSCAR EL ÍNDICE REAL EN products
        //
        // NO buscamos por SKU.
        // NO buscamos por barcode.
        //
        // Buscamos por ID porque la línea es única.
        // ==================================================

        const index =
            productsRef.current.findIndex(
                (currentProduct) =>
                    currentProduct.id === product.id
            );


        if (index === -1) {

            console.error(
                "❌ No se encontró la línea seleccionada en products:",
                product.id
            );

            return;
        }


        console.log(
            "📍 Índice real encontrado:",
            index
        );


        // ==================================================
        // 2️⃣ GUARDAR QUÉ LÍNEA REPETIDA FUE ELEGIDA
        // ==================================================

        selectedRepeatedProductIdRef.current =
            product.id;


        // ==================================================
        // 3️⃣ SELECCIONAR ESA LÍNEA
        //
        // Exactamente igual que tu flujo normal.
        // ==================================================

        setSelectedIndex(index);

        selectedIndexRef.current =
            index;


        // ==================================================
        // 4️⃣ GUARDAR EL CÓDIGO COMO ÚLTIMO SCAN
        //
        // Esto permite:
        //
        // usuario eligió Línea 2
        // vuelve a escanear mismo barcode
        // → incrementReceivedQty()
        // → incrementa Línea 2
        // ==================================================

        lastCodeRef.current =
            repeatedScannedCodeRef.current;


        // ==================================================
        // 5️⃣ RESETEAR ERRORES
        // ==================================================

        setQuantityError(false);


        // ==================================================
        // 6️⃣ CERRAR MODAL DE REPETIDOS
        // ==================================================

        setIsRepeatedModalOpen(false);

        setRepeatedProducts([]);


        // ==================================================
        // 7️⃣ LIMPIAR BUFFER
        // ==================================================

        scanBufferRef.current = "";


        // ==================================================
        // 8️⃣ REACTIVAR SCANNER
        // ==================================================

        setIsScannerMode(true);


        // ==================================================
        // 9️⃣ ABRIR TU ScanModal NORMAL
        // ==================================================

        setIsModalOpen(true);
    }

    //FUNCTION TO SEARCH PRODUCT BARCODES
    function handleScannedCode(code: string) {
        setIsRepeatedModalOpen(false);
        const barcode =
            code.trim();

        if (!barcode) return;


        // ==================================================
        // 🔥 PRIMERA VALIDACIÓN DEL SCAN
        //
        // Antes de ejecutar CUALQUIER lógica normal
        // verificamos líneas repetidas.
        // ==================================================

        const hasRepeatedProducts =
            checkRepeatedProduct(
                barcode
            );


        // ==================================================
        // SI ESTÁ REPETIDO:
        //
        // DETENER COMPLETAMENTE ESTE FLUJO
        // ==================================================

        if (hasRepeatedProducts) {

            console.log(
                "⛔ Flujo normal detenido por producto repetido"
            );

            return;
        }


        // ==================================================
        // DESDE AQUÍ TU CÓDIGO ACTUAL
        // ==================================================

        console.log("CHECK 10")
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

    function handleReceivedQtyChange(
        e: React.ChangeEvent<HTMLInputElement>
    ) {
        if (selectedIndex === null) return;

        const value = e.target.value;

        // Permitir solamente números enteros positivos
        if (
            value !== "" &&
            !/^\d+$/.test(value)
        ) {
            return;
        }

        setProducts((previousProducts) => {
            setQuantityError(false);

            const currentProduct =
                previousProducts[selectedIndex];

            if (!currentProduct) {
                return previousProducts;
            }

            // Cantidad recibida antes de esta recepción
            const previousReceived =
                getPreviousReceived(currentProduct);

            // Cantidad total pendiente al comenzar
            // esta recepción
            const displayOrdered =
                getDisplayOrdered(currentProduct);

            // Cantidad escrita por el usuario para
            // ESTA recepción
            const enteredDisplayQty =
                value === ""
                    ? 0
                    : Number(value);

            // No permitir que exceda lo pendiente
            const safeDisplayQty = Math.min(
                enteredDisplayQty,
                displayOrdered
            );

            /*
             * Convertir la cantidad visible
             * a cantidad acumulada real.
             *
             * Ejemplo:
             * anterior = 10
             * usuario escribe = 5
             * acumulado = 15
             */
            const accumulatedReceivedQty =
                previousReceived + safeDisplayQty;

            if (
                enteredDisplayQty > displayOrdered
            ) {
                setQuantityError(true);
                setShakeKey(
                    (previousKey) => previousKey + 1
                );
            } else {
                setQuantityError(false);
            }

            const updatedProduct = {
                ...currentProduct,

                // Se guarda el acumulado real
                received_qty:
                    accumulatedReceivedQty,
            };

            const updatedProducts = [
                ...previousProducts,
            ];

            /*
             * Mantener el producto editado al inicio,
             * como ya hacía tu código.
             */
            updatedProducts.splice(
                selectedIndex,
                1
            );

            updatedProducts.unshift(
                updatedProduct
            );

            return updatedProducts;
        });

        setSelectedIndex(0);
        selectedIndexRef.current = 0;
    }
    function handleReceivedQtyBlur() {
        if (selectedIndex === null) return;

        setProducts((previousProducts) => {
            const updatedProducts = [
                ...previousProducts,
            ];

            const currentProduct =
                updatedProducts[selectedIndex];

            if (!currentProduct) {
                return previousProducts;
            }

            const previousReceived =
                getPreviousReceived(currentProduct);

            const orderedQty = Number(
                currentProduct.ordered_qty ?? 0
            );

            let finalQty = Number(
                currentProduct.received_qty ?? 0
            );

            /*
             * Nunca puede quedar por debajo
             * de lo recibido anteriormente.
             */
            if (finalQty < previousReceived) {
                finalQty = previousReceived;
            }

            /*
             * Nunca puede superar lo ordenado.
             */
            if (finalQty > orderedQty) {
                finalQty = orderedQty;
            }

            updatedProducts[selectedIndex] = {
                ...currentProduct,
                received_qty: finalQty,
            };

            return updatedProducts;
        });
    }


    // FUNCTION TO ADD +1 TO THE PRODUCT USING SCANNER
    function incrementReceivedQty() {
        const index = selectedIndexRef.current;

        if (index === null) return;

        setProducts((previousProducts) => {
            setQuantityError(false);

            const updatedProducts = [
                ...previousProducts,
            ];

            const currentProduct =
                updatedProducts[index];

            if (!currentProduct) {
                return previousProducts;
            }

            const currentReceived = Number(
                currentProduct.received_qty ?? 0
            );

            const orderedQty = Number(
                currentProduct.ordered_qty ?? 0
            );

            /*
             * Incrementa el acumulado real.
             *
             * Si anteriormente había 10:
             * primer incremento -> 11
             * pantalla -> 1
             */
            const nextQty =
                currentReceived + 1;

            const safeQty = Math.min(
                nextQty,
                orderedQty
            );

            const updatedProduct = {
                ...currentProduct,
                received_qty: safeQty,
            };

            if (nextQty > orderedQty) {
                setQuantityError(true);

                setShakeKey(
                    (previousKey) => previousKey + 1
                );
            } else {
                setQuantityError(false);
            }

            updatedProducts.splice(index, 1);
            updatedProducts.unshift(
                updatedProduct
            );

            return updatedProducts;
        });

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




    // ======================================================
    // VERIFICAR SI EL PRODUCTO ESCANEADO ESTÁ REPETIDO
    // ======================================================

    function checkRepeatedProduct(
        scannedCode: string
    ): boolean {

        const code = scannedCode.trim();

        if (!code) {
            return false;
        }

        // ==================================================
        // UNA LÍNEA REPETIDA YA FUE ELEGIDA
        //
        // Si el usuario vuelve a leer el mismo código,
        // no volvemos a mostrar el modal de repetidos.
        //
        // Dejamos continuar handleScannedCode para que
        // llegue a incrementReceivedQty().
        // ==================================================

        const currentSelectedProduct =
            selectedIndexRef.current !== null
                ? productsRef.current[
                selectedIndexRef.current
                ]
                : null;


        if (
            selectedRepeatedProductIdRef.current !== null &&
            currentSelectedProduct?.id ===
            selectedRepeatedProductIdRef.current &&
            code === lastCodeRef.current
        ) {

            console.log(
                "✅ Línea repetida ya elegida → continuar con esa línea:",
                {
                    product_id:
                        currentSelectedProduct.id,

                    sku:
                        currentSelectedProduct.sku,

                    scanned_code:
                        code
                }
            );

            return false;
        }

        const currentProducts =
            productsRef.current;

        console.log("");
        console.log("🔍🔍🔍 ========================================");
        console.log("🔍 VERIFICANDO PRODUCTO REPETIDO");
        console.log("🔍🔍🔍 ========================================");
        console.log("📡 Código escaneado:", code);


        // ==================================================
        // 1️⃣ BUSCAR COINCIDENCIAS DIRECTAS
        //
        // Puede coincidir por:
        // - barcode
        // - SKU interno
        // ==================================================

        const directMatches =
            currentProducts.filter((product) => {

                const barcodeMatch =
                    Array.isArray(product.barcodes) &&
                    product.barcodes.includes(code);

                const skuMatch =
                    product.sku === code;

                return (
                    barcodeMatch ||
                    skuMatch
                );
            });


        console.log(
            "📦 Coincidencias directas:",
            directMatches.length
        );


        // ==================================================
        // NO ENCONTRAMOS NADA
        //
        // No hacemos nada.
        // Dejamos que handleScannedCode maneje
        // el producto inexistente normalmente.
        // ==================================================

        if (directMatches.length === 0) {

            console.log(
                "➡️ No hay coincidencias → flujo normal"
            );

            return false;
        }


        // ==================================================
        // 2️⃣ OBTENER LOS SKU RELACIONADOS
        //
        // Ejemplo:
        //
        // barcode 123456
        // encuentra SKU-500
        //
        // Ahora vamos a buscar TODAS las líneas
        // SKU-500 de la orden.
        // ==================================================

        const matchedSkus = new Set(
            directMatches
                .map((product) =>
                    product.sku
                )
                .filter(Boolean)
        );


        // ==================================================
        // 3️⃣ BUSCAR TODAS LAS LÍNEAS RELACIONADAS
        //
        // Una línea entra si:
        //
        // - tiene el mismo SKU encontrado
        // O
        // - tiene directamente el barcode leído
        // ==================================================

        const allMatches =
            currentProducts.filter((product) => {

                const sameSku =
                    matchedSkus.has(
                        product.sku
                    );

                const sameBarcode =
                    Array.isArray(product.barcodes) &&
                    product.barcodes.includes(code);

                return (
                    sameSku ||
                    sameBarcode
                );
            });


        // ==================================================
        // 4️⃣ EVITAR DUPLICAR LA MISMA LÍNEA
        //
        // La identidad real de la línea es product.id
        // que corresponde a purchase_order_lines.id
        // ==================================================

        const uniqueMatches =
            Array.from(
                new Map(
                    allMatches.map(
                        (product) => [
                            product.id,
                            product
                        ]
                    )
                ).values()
            );


        console.log(
            "📊 Líneas relacionadas:",
            uniqueMatches.length
        );

        console.log(
            "📦 Productos encontrados:",
            uniqueMatches
        );


        // ==================================================
        // 5️⃣ HAY MÁS DE UNA LÍNEA
        //
        // DETENER EL FLUJO COMPLETAMENTE
        // ==================================================

        if (uniqueMatches.length > 1) {

            console.log("");
            console.log("⚠️⚠️⚠️ ========================================");
            console.log("⚠️ PRODUCTO REPETIDO");
            console.log(
                "⚠️ Cantidad de líneas:",
                uniqueMatches.length
            );
            console.log("⚠️⚠️⚠️ ========================================");
            console.log("");

            // 🔥 Guardar el código que provocó
            // el modal de repetidos
            repeatedScannedCodeRef.current =
                code;


            // Guardar todas las líneas
            setRepeatedProducts(
                uniqueMatches
            );


            // Cerrar modal normal
            setIsModalOpen(false);


            // No dejar ninguna línea normal seleccionada
            setSelectedIndex(null);

            selectedIndexRef.current =
                null;


            // Detener scanner mientras
            // está abierta la pantalla especial
            //setIsScannerMode(true);


            // Abrir modal especial
            setIsRepeatedModalOpen(true);


            // TRUE significa:
            // handleScannedCode debe detenerse
            return true;
        }


        // ==================================================
        // 6️⃣ SOLO EXISTE UNA LÍNEA
        //
        // NO hacemos nada.
        // Continúa handleScannedCode normalmente.
        // ==================================================

        console.log(
            "✅ Solo una línea → flujo normal"
        );

        return false;
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

            {/* =====================================================
    PRODUCTOS REPETIDOS
===================================================== */}

            {isRepeatedModalOpen && (

                <div className="repeated-modal-overlay">

                    <div className="repeated-modal">

                        {/* ================================
                HEADER
            ================================= */}

                        <div className="repeated-modal-header">

                            <div className="repeated-modal-header-left">

                                <div className="repeated-warning-icon">

                                    <svg
                                        viewBox="0 0 24 24"
                                        aria-hidden="true"
                                    >
                                        <path
                                            d="M12 3L2.8 19a2 2 0 0 0 1.74 3h14.92a2 2 0 0 0 1.74-3L12 3Z"
                                            fill="currentColor"
                                        />

                                        <rect
                                            x="11"
                                            y="8"
                                            width="2"
                                            height="7"
                                            rx="1"
                                            fill="white"
                                        />

                                        <circle
                                            cx="12"
                                            cy="18"
                                            r="1.2"
                                            fill="white"
                                        />
                                    </svg>

                                </div>


                                <div className="repeated-modal-heading">

                                    <h2>
                                        Producto repetido
                                    </h2>

                                    <p>
                                        Seleccione una de las líneas:
                                    </p>

                                </div>

                            </div>


                            <button
                                type="button"
                                className="repeated-modal-x"
                                onClick={
                                    closeRepeatedProductsModal
                                }
                                aria-label="Cerrar"
                            >

                                <svg
                                    viewBox="0 0 24 24"
                                    aria-hidden="true"
                                >
                                    <path
                                        d="M6 6L18 18M18 6L6 18"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2.2"
                                        strokeLinecap="round"
                                    />
                                </svg>

                            </button>

                        </div>


                        {/* ================================
                PRODUCTOS
            ================================= */}

                        <div className="repeated-modal-content">

                            {repeatedProducts.map(
                                (product, index) => {

                                    const orderedQty =
                                        Number(
                                            product.ordered_qty ?? 0
                                        );

                                    const receivedQty =
                                        Number(
                                            product.received_qty ?? 0
                                        );


                                    /*
                                     * Para que sea idéntico
                                     * al diseño:
                                     *
                                     * 5 ordenado
                                     * 2 recibido
                                     * diferencia = -3
                                     */
                                    const differenceQty =
                                        receivedQty -
                                        orderedQty;


                                    return (

                                        <button
    key={product.id}
    type="button"
    className="repeated-line-card"
    onClick={() =>
        selectRepeatedProduct(product)
    }
    aria-label={
        `Seleccionar línea ${index + 1}, ` +
        `${product.sku}`
    }
>

                                            {/* LINE + SKU */}

                                            <div className="repeated-line-top">

                                                <span className="repeated-line-badge">
                                                    Línea {index + 1}
                                                </span>

                                                <span className="repeated-line-sku">
                                                    {product.sku}
                                                </span>

                                            </div>


                                            {/* ERP INFO */}

                                            <div className="repeated-line-erp">

                                                {product.erp_name || "-"}

                                                <span> / </span>

                                                {product.erp_sku || "-"}

                                                <span> / </span>

                                                {product.erp_id || "-"}

                                            </div>





                                            <div className="repeated-line-divider" />


                                            {/* QUANTITIES */}

                                            <div className="repeated-line-quantities">


                                                {/* ORDERED */}

                                                <div className="repeated-qty-item">

                                                    <span className="repeated-qty-label">
                                                        Ordenado
                                                    </span>

                                                    <strong className="repeated-qty-value">
                                                        {orderedQty.toFixed(2)}
                                                    </strong>

                                                </div>


                                                <div className="repeated-qty-separator" />


                                                {/* RECEIVED */}

                                                <div className="repeated-qty-item">

                                                    <span className="repeated-qty-label">
                                                        Recibido
                                                    </span>

                                                    <strong className="repeated-qty-value">
                                                        {receivedQty.toFixed(2)}
                                                    </strong>

                                                </div>


                                                <div className="repeated-qty-separator" />


                                                {/* DIFFERENCE */}

                                                <div className="repeated-qty-item">

                                                    <span className="repeated-qty-label">
                                                        Diferencia
                                                    </span>

                                                    <strong
                                                        className={`
                                                repeated-qty-value
                                                repeated-difference
                                                ${differenceQty < 0
                                                                ? "negative"
                                                                : differenceQty > 0
                                                                    ? "positive"
                                                                    : "zero"
                                                            }
                                            `}
                                                    >

                                                        {differenceQty > 0
                                                            ? "+"
                                                            : ""}

                                                        {differenceQty.toFixed(2)}

                                                    </strong>

                                                </div>

                                            </div>

                                        </button>
                                    );
                                }
                            )}

                        </div>


                        {/* ================================
                FOOTER
            ================================= */}

                        <div className="repeated-modal-footer">

                            <button
                                type="button"
                                className="repeated-modal-close-button"
                                onClick={
                                    closeRepeatedProductsModal
                                }
                            >
                                CERRAR
                            </button>

                        </div>

                    </div>

                </div>

            )}


            {/* =====================================================
    TU MODAL NORMAL
===================================================== */}

            <ScanModal
                open={isModalOpen}
                title={selectedProduct ? "Producto encontrado" : "Producto no existe"}
                onClose={closeModal}
            >
                {selectedProduct ? (
                    <div className="modal-container">
                        <div
                            className={`modal-sku ${selectedDisplayOrdered > 0 &&
                                selectedDisplayReceived >=
                                selectedDisplayOrdered
                                ? "confirmed"
                                : ""
                                }`}
                        >
                            {selectedProduct.erp_name}
                        </div>

                        <div className="modal-description">{selectedProduct.description} / PN: {selectedProduct.erp_sku} / ID: {selectedProduct.erp_id} / {selectedProduct.sku}</div>

                        <div className="qty-row">
                            <input
                                ref={qtyInputRef}
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"

                                // Cantidad de esta recepción
                                value={selectedDisplayReceived}

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
                                {selectedDisplayOrdered}
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
