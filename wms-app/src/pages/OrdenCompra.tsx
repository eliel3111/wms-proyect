import { useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { getReceptionByPOId, saveReceptionIDB } from "../services/receptionIDB.helpers.ts";
import apiClient from "../services/apiClient.ts";
import "../styles/OrdenCompra.css"
import OrderLineCard from "../components/OrderLineCard.tsx"

/* Tipos base */
type Product = {
    id: number;
    sku: string;
    description: string;
    ordered_qty: number;
    received_qty: number;
    product_exists: boolean;
};

type Filter = "all" | "read" | "unread";

export default function OrdenCompra() {
    /* 1️⃣ Obtener ID desde la URL */
    const { id } = useParams<{ id: string }>();

    /* 2️⃣ Estados principales */
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isScannerMode, setIsScannerMode] = useState(true);
    const [scanInput, setScanInput] = useState("");
    const [products, setProducts] = useState<Product[]>([]);
    const [idbProducts, setIdbProducts] = useState<Product[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
    const [countQty, setCountQty] = useState<number>(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [poNumber, setPoNumber] = useState<string>("");
    const [purchaseOrderId, setPurchaseOrderId] = useState<number | null>(null);
    const [filter, setFilter] = useState<Filter>("all");


    useEffect(() => {
        if (!id) return;

        const poId = Number(id);
        if (isNaN(poId)) return;
        //fetchPurchaseOrderById(poId);
        setPurchaseOrderId(poId);

    }, [id]);






    useEffect(() => {
        if (!purchaseOrderId) return;
        console.log(products);
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

                if (!result.success) {
                    throw new Error(result.message || "Error cargando la orden de compra");
                }

                const data = result.data;

                setPoNumber(data.purchase_order_number);
                setProducts(data.lines);

                // 3️⃣ Guardar en IndexedDB
                if (!local?.lines || local.lines.length === 0) {
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
        const receivedMap = new Map(
            idbProducts.map((p: Product) => [p.sku, p.received_qty])
        );

        console.log("DICCIONARIO:", receivedMap);

        // 4️⃣ Mezclar backend + local
        const mergedProducts = products.map((p: Product) => {
            const localQty = receivedMap.get(p.sku);

            return {
                ...p,
                received_qty:
                    typeof localQty === "number" && localQty > 0
                        ? localQty
                        : p.received_qty,
            };
        });


        console.log("RESULTADO:", mergedProducts);

        setProducts(
            prioritizeMissingProducts(mergedProducts)
        );

    }, [poNumber, idbProducts]);




    const EPS = 0.000001; // tolerancia para “casi cero”

    const filteredProducts = products.filter((p) => {
        const qty = Number(p.received_qty); // convierte 0.000 o "0.000" a 0

        if (Number.isNaN(qty)) return filter === "all"; // o decide qué hacer si es inválido

        if (filter === "read") return qty > EPS;        // > 0 real
        if (filter === "unread") return Math.abs(qty) <= EPS; // 0, 0.000, etc.
        return true;
    });






    //FUNCTION TO MOVE MISSING PRODUCTS TO 1ST PLACE
    function prioritizeMissingProducts(lines: Product[]): Product[] {
        const missing = lines.filter(p => p.product_exists === false);
        const existing = lines.filter(p => p.product_exists !== false);

        return [...missing, ...existing];
    }


    //Function to call the back end to request the order data:
    /*async function fetchPurchaseOrderById(poId: number) {
        setLoading(true);
        setError(null);

        try {
            const response = await apiClient.get(`/receiving/${encodeURIComponent(poId)}`);

            

            const result = response.data;

            if (!result.success) {
                throw new Error(result.message || "Error cargando la orden de compra");
            }

            // Ajusta estos nombres según tu backend:
            // result.data.purchase_order_number
            // result.data.lines
            const data = result.data;

            setPoNumber(data.purchase_order_number);
            setProducts(data.lines); // aquí guardas los lines en el state

        } catch (err: any) {
            setError(err.message || "Error desconocido");
        } finally {
            setLoading(false);
        }
    }*/

    if (loading) {
        return <div style={{ padding: 20 }}>Loading...</div>;
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
                    <button className="pill-btn pause-btn">
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
                    <button className="pill-btn finish-btn">
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


            <div className="order-lines-header">
                <div>Código</div>
                <div>Recibida</div>
                <div>Descripción</div>
                <div>Diferencia</div>
            </div>

            <div className="lines-list">
                {filteredProducts.map((line) => (
                    <OrderLineCard key={line.id} line={line} />
                ))}
            </div>

            <div className="filter-bar">
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
                    Pendientes (0)
                </button>

                <button
                    className={filter === "read" ? "active" : ""}
                    onClick={() => setFilter("read")}
                >
                    Contadas (&gt;0)
                </button>
            </div>





            {/*<h1>Orden de Compra</h1>
            <p>ID: {id}</p>*/}

            {/* Debug temporal 
            <pre>
                {JSON.stringify(
                    {
                        isModalOpen,
                        isScannerMode,
                        scanInput,
                        selectedProduct,
                        countQty,
                        productsLength: products.length,
                    },
                    null,
                    2
                )}
            </pre>*/}
        </div>
    );
}
