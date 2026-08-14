
import { useState, useRef } from "react";
import "../styles/Barcode.css"
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import { Search } from 'lucide-react';
import { Printer } from "lucide-react";
import { X } from "lucide-react";
import { Plus } from "lucide-react";
import { getPrinter, sendZpl } from "../services/zebra.ts";
import { LoadingScreen } from "../components/LoadingScreen.tsx";

export interface Product {
    id: string;
    sku: string;
    description: string;
    erp_sku: string | null;
    erp_id: string | null;
    erp_name: string | null;
    supplier_barcode: string | null;
    total_qty_on_hand: number;
}

type PrintType = "internal" | "supplier";


export default function BarcodePage() {

    const [value, setValue] = useState("");
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
    const [activeTab, setActiveTab] = useState<"print" | "manual">("manual");
    const isSupplierDisabled = !selectedProduct?.supplier_barcode;
    const [supplierCode, setSupplierCode] = useState("");


    const [printType, setPrintType] = useState<PrintType>("internal");
    const [quantity, setQuantity] = useState("");
    const { openModal } = useModal();

    const [loading, setLoading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const handleClear = () => {
        setValue("");
        setProducts([]);
        setTimeout(() => {
            inputRef.current?.focus();
        }, 0);
    };


    async function handleSearch() {
        try {
            setLoading(true);
            if (!value.trim()) return;

            console.log("🔍 Buscando:", value);

            const res = await apiClient.post("/barcode/products/search", {
                text: value, // 👈 IMPORTANTE: mandar como objeto
            });

            setProducts(res.data.data);
            inputRef.current?.blur();

            console.log("✅ Result:", res.data);
            if (res.data.data.length === 0) {
                openModal({
                    title: "Producto no encontrado",
                    message: "No se encontró el producto escaneado.",
                });
            }
            setLoading(false);
        } catch (error) {
            console.error("❌ Error:", error);

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


            setSelectedProduct(null);
            setActiveTab("manual");
            setPrintType("internal");
            setQuantity("");
            setSupplierCode("");

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

    function handleReset() {
        setSelectedProduct(null);
        setActiveTab("manual");
        setPrintType("internal");
        setQuantity("");
        setSupplierCode("");
    }


    //Area de impresion

    function getBarcodeX(sku: string) {
        const labelWidth = 400;

        console.log(sku.length);

        let x;

        if (sku.length <= 10) {
            const moduleWidth = 4; // ^BY2

            // 🔥 factor realista (ajustado)
            const estimatedWidth = sku.length * 7.5 * moduleWidth;

            x = (labelWidth - estimatedWidth) / 2;
        } else {
            const moduleWidth = 4; // ^BY2

            // 🔥 factor realista (ajustado)
            const estimatedWidth = sku.length * 6.5 * moduleWidth;

            x = (labelWidth - estimatedWidth) / 2;
        }



        return Math.max(Math.floor(x), 10); // evita pegarse al borde
    }

    function clean(text: string) {
        return text
            .replace(/\^/g, "")
            .replace(/~/g, "")
            .replace(/\n/g, " ");
    }

    function cleanAndFormat(text: string) {
        let clean = text
            .normalize("NFD") // separa acentos
            .replace(/[\u0300-\u036f]/g, "") // elimina acentos
            .replace(/\^|~/g, "") // limpia ZPL
            .toUpperCase()
            .trim();

        // 🔥 1. Limitar a 40 caracteres con ...
        if (clean.length > 55) {
            clean = clean.slice(0, 52) + "...";
        }

        // 🔥 2. Si es <= 20, no dividir
        if (clean.length <= 20) {
            return clean;
        }

        // 🔥 3. Dividir en 2 líneas
        const line1 = clean.slice(0, 18).trim();
        const line2 = clean.slice(20).trim();

        return `${line1}\n${line2}`;
    }

    async function printLabel(
        description: string,
        sku: string,
        erp_name?: string,
        qty: number = 1
    ) {
        try {




            const printer = await getPrinter();
            console.log("CAMBIO DE PAPI");
            const d = cleanAndFormat(description);
            const i = cleanAndFormat(erp_name || "");
            const s = clean(sku);
            const x = getBarcodeX(s);


            function limitLabelText(
                i: string,
                d: string,
                maxChars: number = 48
            ): string {

                const text = `${i} / ${d}`.trim();

                if (text.length <= maxChars) {
                    return text;
                }

                return text.substring(0, maxChars - 3).trim() + "...";
            }

            const labelText = limitLabelText(i, d);

            const zpl = `
^XA

^PW400
^LL203
^LH0,0

^CF0,26

^FO0,10
^FB400,2,0,C,0
^FD${labelText}^FS

^BY2,2,50
^FO${x},75
^BCN,50,Y,N,N
^FD${s}^FS

^PQ${qty}
^XZ
`;

            await sendZpl(printer, zpl);

            console.log(`✅ Impreso ${qty} etiquetas`);
        } catch (error) {
            console.error("❌ Error imprimiendo:", error);
        }
    }

    function handlePrint() {
        if (!selectedProduct) return;

        const code =
            printType === "internal"
                ? selectedProduct.sku
                : selectedProduct.supplier_barcode;

        if (!code) {
            console.warn("❌ No hay código para imprimir");
            return;
        }

        printLabel(
            selectedProduct.description,
            code,
            selectedProduct.erp_name || "",
            Number(quantity)
        );
    }

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
                    className="barcode-modal-overlay"
                    onClick={() => setSelectedProduct(null)} // 🔥 cerrar al hacer click fuera
                >
                    <div
                        className="barcode-modal-container"
                        onClick={(e) => e.stopPropagation()} // 🔥 evita cerrar al hacer click dentro
                    >
                        <div className="barcode-container-header">

                            <div className="barcode-header-left">

                                <div
                                    className={`barcode-tab  barcode-print-tab ${activeTab === "print" ? "active" : ""}`}
                                    onClick={() => setActiveTab("print")}
                                >
                                    <Printer size={24} strokeWidth={1.5} />
                                    Imprimir
                                </div>

                                <div
                                    className={`barcode-tab ${activeTab === "manual" ? "active" : ""}`}
                                    onClick={() => setActiveTab("manual")}
                                >
                                    <Plus size={24} strokeWidth={2.5} />
                                    Introducir
                                </div>

                            </div>

                            <div className="barcode-header-right">
                                <button
                                    className="barcode-close-btn"
                                    onClick={handleReset}
                                >
                                    <X size={26} strokeWidth={3} />
                                </button>
                            </div>

                        </div>

                        <div className="barcode-container-center">

                            {activeTab === "print" && (
                                <div className="barcode-print-view">

                                    <div className="barcode-print-content">

                                        <h3 className="barcode-title">Seleccione una opción</h3>

                                        {/* OPCIÓN 1 */}
                                        <div
                                            className={`barcode-option ${printType === "internal" ? "barcode-option-active" : ""}`}
                                            onClick={() => setPrintType("internal")}
                                        >
                                            <div className="barcode-radio">
                                                {printType === "internal" && <div className="barcode-radio-dot" />}
                                            </div>



                                            <span className="barcode-option-text">
                                                Imprimir código interno del producto
                                            </span>
                                        </div>

                                        {/* OPCIÓN 2 */}
                                        <div
                                            className={`barcode-option 
                                                ${printType === "supplier" ? "barcode-option-active" : ""} 
                                                ${isSupplierDisabled ? "barcode-option-disabled" : ""}
                                            `}
                                            onClick={() => {
                                                if (isSupplierDisabled) return; // 🔥 bloquea click
                                                setPrintType("supplier");
                                            }}
                                        >
                                            <div className="barcode-radio">
                                                {printType === "supplier" && !isSupplierDisabled && (
                                                    <div className="barcode-radio-dot" />
                                                )}
                                            </div>

                                            <span className="barcode-option-text">
                                                Imprimir código del proveedor
                                            </span>
                                        </div>

                                        {/* CANTIDAD */}
                                        <h3 className="barcode-title barcode-mt">Cantidad</h3>

                                        <div className="barcode-quantity">
                                            <input
                                                className="barcode-quantity-input"
                                                type="number"
                                                value={quantity}
                                                onChange={(e) => setQuantity((e.target.value))}
                                                placeholder="Ingrese cantidad..."
                                            />


                                        </div>


                                    </div>

                                </div>
                            )}
                            {activeTab === "manual" && (
                                <div className="barcode-print-view">

                                    <div className="barcode-print-content">

                                        <h2 className="barcode-title-product">{selectedProduct.description}</h2>

                                        <h3 className="barcode-title">Introduzca código de barra del proveedor</h3>

                                        {/* OPCIÓN 1 */}
                                        <div className="barcode-quantity">
                                            <input
                                                className="barcode-quantity-input"
                                                type="text"
                                                value={supplierCode}
                                                onChange={(e) => setSupplierCode(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter") {
                                                        console.log("Barcode:", supplierCode);
                                                    }
                                                }}
                                                placeholder="Código de proveedor..."
                                            />


                                        </div>





                                    </div>

                                </div>
                            )}

                        </div>

                        <div className="barcode-container-footer">

                            {activeTab === "print" && (
                                <>
                                    {/* BOTÓN */}
                                    <button
                                        className="barcode-cancel"
                                        onClick={handleReset}
                                    >
                                        Cancelar
                                    </button>

                                    {/* BOTÓN */}
                                    <button
                                        className="barcode-submit"
                                        onClick={handlePrint}
                                    >
                                        Imprimir
                                    </button>
                                </>
                            )}

                            {activeTab === "manual" && (
                                <>
                                    {/* BOTÓN */}
                                    <button
                                        className="barcode-cancel"
                                        onClick={handleReset}
                                    >
                                        Cancelar
                                    </button>

                                    {/* BOTÓN */}
                                    <button
                                        className="barcode-submit"
                                        onClick={handleSaveSupplierCode}
                                    >
                                        Guardar
                                    </button>
                                </>
                            )}


                        </div>
                    </div>

                </div>
            )}

        </div>
    )
};