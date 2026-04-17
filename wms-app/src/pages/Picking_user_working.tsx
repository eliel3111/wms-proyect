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
    const [pickings, setPickings] = useState<StockMoveLine[]>([]);
    const [pickingId, setPickingId] = useState<number | null>(null);
    const pickingIdRef = useRef<number | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const isModalOpenRef = useRef(false);
const [goNext, setGoNext] = useState(false);

    const [fromLocation, setFromLocation] = useState<Location | null>(null);
    const fromLocationRef = useRef<Location | null>(null);


    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
    const selectedProductRef = useRef<Product | null>(null);


    const [startedPicking, setStartedPicking] = useState(false);
    console.log(startedPicking);
    const [currentLine, setCurrentLine] = useState<StockMoveLine | null>(null);
    const currentLineRef = useRef<StockMoveLine | null>(null);
    const scanBuffer = useRef<string>("");


    const [qty, setQty] = useState<string>("");
    const qtyRef = useRef<string>("");

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
                console.log("📦 Products Locations:", response.data.finalResult);
                setPickings(response.data.finalResult);
                setLoading(false);   

            } catch (error) {
                console.error("❌ Error fetching products locations:", error);
            }
        };


    /* =======================
       SCANNER LISTENER
    ======================= */
    useEffect(() => {
        async function handleKeyDown(e: KeyboardEvent) {
            const isEndKey = e.key === "Enter" || e.key === "Tab";

            if (!isModalOpenRef.current) {
                openModal({
                    title: "INICIE LA RECOGIDA",
                    message: "Primero debe iniciar la ruta dando click a Recoger."
                });
                return;
            }

            if (isEndKey) {
                const scanned = scanBuffer.current
                    .replace(/[\r\n]+/g, "")
                    .trim()
                    .toUpperCase();

                scanBuffer.current = "";

                if (!scanned) return;

                console.log("📡 SCAN RECIBIDO:", scanned);

                try {
                    const res = await apiClient.post("/picking/scan", {
                        code: scanned,
                        pickingId: pickingIdRef.current,
                    });

                    const data = res.data;

                    console.log(data);

                    // 🟢 ES UBICACIÓN
                    if (data.success && data.type === "location") {
                        console.log("📍 UBICACIÓN DETECTADA:", data.data);
                        handleScanLocation(data.data);
                    }

                    // 🔵 ES PRODUCTO
                    else if (data.success && data.type === "product") {
                        handleScanProduct(data.data);
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

                    else if (!data.success && data.code === "NOT_IN_PICKING") {

                        openModal({
                            title:
                                data.title,
                            message: data.message
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


    // FUNCTION: Handle scanned location code
    function handleScanLocation(location: { id: string; code: string }) {
        if (!location?.id || !location?.code) return;



        setFromLocation(location);   // ✅ guardar ubicación
        setQty("");                        // 🔥 limpiar cantidad
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
        console.log(product)


        console.log("📍 UBICACIÓN ACTUAL:", fromLocationRef.current);
        console.log("📍 LIINEA ACTUAL:", currentLineRef.current);

        setSelectedProduct({
            id: Number(product.id),
            sku: product.sku,
        });
        setQty("");



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
            if (Number(qtyRef.current) <= 0) {
                openModal({
                    title: "Cantidad inválida",
                    message: "La cantidad debe ser mayor a 0"
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
          
            await fetchData();
setGoNext(true);
            setFromLocation(null);
            setSelectedProduct(null);
            setQty("");

            
            setStartedPicking(false);


        } catch (error) {
            console.error("🔥 ERROR confirm-line:", error);

            openModal({
                title: "Error",
                message: "No se pudo guardar la información"
            });
        }
    }

    function closeModal() {
        // ✅ TODO BIEN → LIMPIAR UI
        setFromLocation(null);
        setSelectedProduct(null);
        setQty("");

        setIsModalOpen(false);
        isModalOpenRef.current = false;
        setStartedPicking(false);
    }

    function handleOpenModal() {
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

  // 🔥 1. BUSCAR PRIMERO LAS QUE ESTÁN EN 0
  const zeroLine = pickings.find(line => {
    const done = Number(line.qty_done || 0);
    return done === 0;
  });

  if (zeroLine) {
    console.log("🎯 ZERO LINE", zeroLine);
    setCurrentLine(zeroLine);
    return zeroLine;
  }

  // 🔥 2. SI NO HAY EN 0 → BUSCAR PARCIALES
  const partialLine = pickings.find(line => {
    const done = Number(line.qty_done || 0);
    const required = Number(line.product_uom_qty || 0);

    return done < required;
  });

  if (partialLine) {
    console.log("🟡 PARTIAL LINE", partialLine);
    setCurrentLine(partialLine);
    return partialLine;
  }

  // 🔴 3. NO HAY MÁS
  console.log("✅ TODAS COMPLETAS");
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
            <div className="container-title">
                <div className="order-div-a">
                    {/* SVG */}
                    <div className="order-icon-picking">
                        <svg id="fi_19025404" height={50} width={50} enable-background="new 0 0 1024 1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><g id="XMLID_1129_"><g id="XMLID_24_"><path id="XMLID_28_" d="m408 317h48.1 115.6 140.4 121c19.6 0 39.2.5 58.8 0h.8c-9.6-12.7-19.3-25.3-28.9-38-2.7 11.9-5.5 23.7-8.2 35.6-6.6 28.3-13.1 56.6-19.7 85-8 34.4-16 68.8-23.9 103.3-6.9 29.8-13.8 59.5-20.7 89.3-3.3 14.4-7.1 28.8-10 43.3 0 .2-.1.4-.1.6 9.6-7.3 19.3-14.7 28.9-22-16.5 0-33 0-49.4 0-39.4 0-78.8 0-118.2 0-47.8 0-95.6 0-143.4 0-41.2 0-82.4 0-123.5 0-20 0-40.1-.6-60.1 0-.3 0-.6 0-.9 0 9.6 7.3 19.3 14.7 28.9 22-3-16.9-6-33.8-8.9-50.8-7.2-40.7-14.3-81.3-21.5-122-8.7-49.2-17.3-98.4-26-147.6-7.5-42.5-15-85.1-22.5-127.6-3.6-20.6-6.3-41.7-10.9-62.2-.1-.3-.1-.6-.2-.9-1.1-6.2-6-11.9-10.8-15.6-5.2-4-11.4-6.4-18.2-6.4-41.9 0-83.8 0-125.7 0-5.9 0-11.8 0-17.8 0-15.7 0-30.7 13.8-30 30 .7 16.3 13.2 30 30 30h125.7 17.8c-9.6-7.3-19.3-14.7-28.9-22 3 16.9 6 33.8 8.9 50.8 7.2 40.7 14.3 81.3 21.5 122 8.7 49.2 17.3 98.4 26 147.6 7.5 42.5 15 85.1 22.5 127.6 3.6 20.6 6.3 41.7 10.9 62.2.1.3.1.6.2.9 1.1 6.2 6 11.9 10.8 15.6 5.2 4 11.4 6.4 18.2 6.4h49.4 118.2 143.4 123.5c20 0 40.1.6 60.1 0h.9c12.7 0 26-9.3 28.9-22 2.7-11.9 5.5-23.7 8.2-35.6 6.6-28.3 13.1-56.6 19.7-85 8-34.4 16-68.8 23.9-103.3 6.9-29.8 13.8-59.5 20.7-89.3 3.3-14.4 6.9-28.8 10-43.3 0-.2.1-.4.1-.6 4.4-18.9-8.8-38-28.9-38-16 0-32.1 0-48.1 0-38.5 0-77.1 0-115.6 0-46.8 0-93.6 0-140.4 0-40.3 0-80.6 0-121 0-19.6 0-39.2-.4-58.8 0-.3 0-.6 0-.8 0-15.7 0-30.7 13.8-30 30 .7 16.3 13.2 30 30 30z"></path></g></g><g id="XMLID_1125_"><g id="XMLID_18_"><path id="XMLID_22_" d="m420.4 813.5c0 3.2-.3 6.4-.7 9.6.4-2.7.7-5.3 1.1-8-.9 5.8-2.4 11.3-4.6 16.7 1-2.4 2-4.8 3-7.2-1.7 3.8-3.6 7.5-5.9 10.9-.2.3-1.7 2.7-1.9 2.7-.1 0 5-6.1 2.3-3-1.4 1.6-2.8 3.3-4.4 4.8-1.4 1.4-2.9 2.6-4.3 3.9-1.9 1.7-4.8 2.5 2.5-1.9-.7.4-1.4 1-2.1 1.5-3.6 2.4-7.5 4.5-11.5 6.2l7.2-3c-5.4 2.2-10.9 3.8-16.7 4.6 2.7-.4 5.3-.7 8-1.1-6.4.8-12.8.8-19.2 0 2.7.4 5.3.7 8 1.1-5.8-.9-11.3-2.4-16.7-4.6l7.2 3c-3.8-1.7-7.5-3.6-10.9-5.9-.3-.2-2.7-1.7-2.7-1.9 0-.1 6.1 5 3 2.3-1.6-1.4-3.3-2.8-4.8-4.4-1.4-1.4-2.6-2.9-3.9-4.3-1.7-1.9-2.5-4.8 1.9 2.5-.4-.7-1-1.4-1.5-2.1-2.4-3.6-4.5-7.5-6.2-11.5 1 2.4 2 4.8 3 7.2-2.2-5.4-3.8-10.9-4.6-16.7.4 2.7.7 5.3 1.1 8-.8-6.4-.8-12.8 0-19.2-.4 2.7-.7 5.3-1.1 8 .9-5.8 2.4-11.3 4.6-16.7-1 2.4-2 4.8-3 7.2 1.7-3.8 3.6-7.5 5.9-10.9.2-.3 1.7-2.7 1.9-2.7.1 0-5 6.1-2.3 3 1.4-1.6 2.8-3.3 4.4-4.8 1.4-1.4 2.9-2.6 4.3-3.9 1.9-1.7 4.8-2.5-2.5 1.9.7-.4 1.4-1 2.1-1.5 3.6-2.4 7.5-4.5 11.5-6.2-2.4 1-4.8 2-7.2 3 5.4-2.2 10.9-3.8 16.7-4.6-2.7.4-5.3.7-8 1.1 6.4-.8 12.8-.8 19.2 0-2.7-.4-5.3-.7-8-1.1 5.8.9 11.3 2.4 16.7 4.6-2.4-1-4.8-2-7.2-3 3.8 1.7 7.5 3.6 10.9 5.9.3.2 2.7 1.7 2.7 1.9 0 .1-6.1-5-3-2.3 1.6 1.4 3.3 2.8 4.8 4.4 1.4 1.4 2.6 2.9 3.9 4.3 1.7 1.9 2.5 4.8-1.9-2.5.4.7 1 1.4 1.5 2.1 2.4 3.6 4.5 7.5 6.2 11.5-1-2.4-2-4.8-3-7.2 2.2 5.4 3.8 10.9 4.6 16.7-.4-2.7-.7-5.3-1.1-8 .4 3.2.6 6.4.7 9.6.2 15.7 13.7 30.7 30 30 16.1-.7 30.2-13.2 30-30-.2-19.3-5.8-39.3-17.1-55.1-12.5-17.4-28.6-29.6-48.6-37.1-35.8-13.5-80.9-1.5-105.2 28-14.2 17.2-22.2 36.4-24 58.7-1.6 19 3.8 39.5 13.7 55.7 9.6 15.8 24.1 29.7 41 37.5 20.4 9.3 41.6 11.9 63.6 7.6 44.6-8.7 76.2-50.8 76.7-95.3.2-15.7-13.9-30.7-30-30-16.5.8-30 13.2-30.1 30z"></path></g></g><g id="XMLID_1127_"><g id="XMLID_14_"><path id="XMLID_23_" d="m786.4 813.5c0 3.2-.3 6.4-.7 9.6.4-2.7.7-5.3 1.1-8-.9 5.8-2.4 11.3-4.6 16.7 1-2.4 2-4.8 3-7.2-1.7 3.8-3.6 7.5-5.9 10.9-.2.3-1.7 2.7-1.9 2.7-.1 0 5-6.1 2.3-3-1.4 1.6-2.8 3.3-4.4 4.8-1.4 1.4-2.9 2.6-4.3 3.9-1.9 1.7-4.8 2.5 2.5-1.9-.7.4-1.4 1-2.1 1.5-3.6 2.4-7.5 4.5-11.5 6.2l7.2-3c-5.4 2.2-10.9 3.8-16.7 4.6 2.7-.4 5.3-.7 8-1.1-6.4.8-12.8.8-19.2 0 2.7.4 5.3.7 8 1.1-5.8-.9-11.3-2.4-16.7-4.6l7.2 3c-3.8-1.7-7.5-3.6-10.9-5.9-.3-.2-2.7-1.7-2.7-1.9 0-.1 6.1 5 3 2.3-1.6-1.4-3.3-2.8-4.8-4.4-1.4-1.4-2.6-2.9-3.9-4.3-1.7-1.9-2.5-4.8 1.9 2.5-.4-.7-1-1.4-1.5-2.1-2.4-3.6-4.5-7.5-6.2-11.5 1 2.4 2 4.8 3 7.2-2.2-5.4-3.8-10.9-4.6-16.7.4 2.7.7 5.3 1.1 8-.8-6.4-.8-12.8 0-19.2-.4 2.7-.7 5.3-1.1 8 .9-5.8 2.4-11.3 4.6-16.7-1 2.4-2 4.8-3 7.2 1.7-3.8 3.6-7.5 5.9-10.9.2-.3 1.7-2.7 1.9-2.7.1 0-5 6.1-2.3 3 1.4-1.6 2.8-3.3 4.4-4.8 1.4-1.4 2.9-2.6 4.3-3.9 1.9-1.7 4.8-2.5-2.5 1.9.7-.4 1.4-1 2.1-1.5 3.6-2.4 7.5-4.5 11.5-6.2-2.4 1-4.8 2-7.2 3 5.4-2.2 10.9-3.8 16.7-4.6-2.7.4-5.3.7-8 1.1 6.4-.8 12.8-.8 19.2 0-2.7-.4-5.3-.7-8-1.1 5.8.9 11.3 2.4 16.7 4.6-2.4-1-4.8-2-7.2-3 3.8 1.7 7.5 3.6 10.9 5.9.3.2 2.7 1.7 2.7 1.9 0 .1-6.1-5-3-2.3 1.6 1.4 3.3 2.8 4.8 4.4 1.4 1.4 2.6 2.9 3.9 4.3 1.7 1.9 2.5 4.8-1.9-2.5.4.7 1 1.4 1.5 2.1 2.4 3.6 4.5 7.5 6.2 11.5-1-2.4-2-4.8-3-7.2 2.2 5.4 3.8 10.9 4.6 16.7-.4-2.7-.7-5.3-1.1-8 .4 3.2.7 6.4.7 9.6.2 15.7 13.7 30.7 30 30 16.1-.7 30.2-13.2 30-30-.2-19.3-5.8-39.3-17.1-55.1-12.5-17.4-28.6-29.6-48.6-37.1-35.8-13.5-80.9-1.5-105.2 28-14.2 17.2-22.2 36.4-24 58.7-1.6 19 3.8 39.5 13.7 55.7 9.6 15.8 24.1 29.7 41 37.5 20.4 9.3 41.6 11.9 63.6 7.6 44.6-8.7 76.2-50.8 76.7-95.3.2-15.7-13.9-30.7-30-30-16.5.8-29.9 13.2-30.1 30z"></path></g></g></svg>
                    </div>

                    {/* DETAILS */}
                    <div className="order-details">
                        <div className="order-number">PEDIDO PENDIENTE:</div>
                        {/*<div className="order-number-title">Orden de Compra</div>*/}
                    </div>
                </div>
                <div className="order-div-b">


                    {/* ✅ FINALIZAR */}
                <button className="picking-user-finish" onClick={handleFinish}>
  <span className="icon">
    <svg viewBox="0 0 24 24">
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
                    <div>Recogida</div>
                    <div>Diferencia</div>
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
        line={{
          id: line.product_id,
          sku: line.sku,
          description: line.description,
          ordered_qty: Math.trunc(Number(line.product_uom_qty)),
          received_qty: Math.trunc(Number(line.qty_done)),
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
                onClose={closeModal}
            >
                <div className="transfer-page">
                    <div className="transfer-card">

                        {/* ORIGEN */}
                        <section
                            className={`pick-user-location-card ${!fromLocation || fromLocation.code !== currentLine?.code
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


                                <span className="pick-user-location-code">
                                    {currentLine?.sku}
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
                                    className="qty-input"
                                    type="number"
                                    value={qty}
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
                            <button className="btn btn-exit" onClick={closeModal}>
                                Salir
                            </button>

                            {Number(qty) > 0 && (
                                <button className="btn btn-save pop-in" onClick={sendModal}>
                                    Siguiente
                                </button>
                            )}
                        </section>
                    </div>
                </div>

            </ScanModal>

        </div>

    );
}


