import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/ReceivingSearch.css";
import { useEffect, useRef } from "react";
import { openReceptionDB } from "../services/indexeddb.ts";
import TextInput from "../components/TextInput.tsx";
import MultiSelectInput from "../components/MultiSelectInput.tsx";
import apiClient from "../services/apiClient.ts";

export default function ReceivingSearch() {


  const poRef = useRef<HTMLDivElement>(null);
  const invoiceInputRef = useRef<HTMLInputElement | null>(null);
  const supplierInputRef = useRef<HTMLInputElement>(null);


  useEffect(() => {
    const initDB = async () => {
      try {
        const db = await openReceptionDB();
        console.log("DB lista para usarse:", db);

        const response = await apiClient.get("/receiving/open");



        if (!response) {
          throw new Error("Error obteniendo órdenes de compra");
        }

        // Axios ya parsea el JSON
        const result = response.data;

        // 3️⃣ Mapear al formato de react-select
        const options = result.data.map((po: any) => ({
          value: po.id,
          label: po.purchase_order_number,
        }));

        setPoOptions(options);
        console.log(options);


      } catch (error) {
        console.error("Error inicializando IndexedDB:", error);
      }
    };

    initDB();
  }, []);

  const navigate = useNavigate();

  
  const goToOrder = (ids: number[]) => {
  const params = new URLSearchParams();

  params.set("poIds", ids.join(","));

  navigate(`/ordencompra?${params.toString()}`);
};

  type Option = {
    value: number;
    label: string;
  };

  



  //STATES
  const [selectedPOs, setSelectedPOs] = useState<Option[]>([]);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [supplier, setSupplier] = useState("");
  const [errors, setErrors] = useState<{ invoiceNo?: string; po?: string }>({});
  const [poOptions, setPoOptions] = useState<
    { value: number; label: string }[]
  >([]);

  // Function to habdle button click
  const handleSubmit = async () => {
  const newErrors: {
    invoiceNo?: string;
    po?: string;
  } = {};

  // selectedPOs es un array.
  // [] es truthy, así que debes verificar length.
  if (selectedPOs.length === 0) {
    newErrors.po = "Orden de compra requerida";
  }

  if (Object.keys(newErrors).length > 0) {
    setErrors(newErrors);
    return;
  }

  // [
  //   { value: 35, label: "OC-000589" },
  //   { value: 39, label: "OC-000571" }
  // ]
  //
  // ↓
  //
  // [35, 39]

  const poIds = selectedPOs.map(
    (po) => po.value
  );

  setErrors({});

  try {
    console.log("📦 PO IDs:", poIds);

    const response = await apiClient.post(
      "/receiving/by-number",
      {
        poIds,
        invoiceNo,
        supplier,
      }
    );

    const result = response.data;

    if (!result.success) {
      throw new Error(
        result.message ||
          "Error consultando las órdenes de compra"
      );
    }

    if (!result.data) {
      throw new Error(
        "Respuesta inválida del servidor"
      );
    }

    // ==========================================================
    // NAVEGAR CON TODOS LOS IDs
    // ==========================================================

    goToOrder(poIds);

  } catch (err: any) {
    setErrors({
      po:
        err.message ||
        "Error consultando las órdenes",
    });

    setSelectedPOs([]);
  }
};

  function handleInvoiceFocus() {
    setTimeout(() => {
      invoiceInputRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",   // 👈 lo pone arriba
      });
    }, 300); // ⏱️ espera a que el teclado aparezca
  }

  function scrollToSupplierInput() {
    setTimeout(() => {
      supplierInputRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 300);
  }





  return (
    <div className="page">
      <div className="container">
        {/* TOP SECTION */}
        <div className="section top">
          <div ref={poRef} className="box div-a">
            <MultiSelectInput
  label="Órdenes de Compra"
  options={poOptions}
  value={selectedPOs}
  onChange={(selected) => {
                setSelectedPOs(selected);
                setErrors({});
              }}
  placeholder="Seleccione órdenes"
   required
              error={errors.po}
              onFocus={() => {
                poRef.current?.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
              }}
/>
            
          </div>
          <div className="box div-b">
            <TextInput
              ref={invoiceInputRef}
              label="No. de Factura"
              value={invoiceNo}
              onChange={setInvoiceNo}
              //required 
              error={errors.invoiceNo}
              placeholder="Ej: FAC-2025-001"
              onFocus={handleInvoiceFocus}
            />
          </div>
        </div>

        {/* BOTTOM SECTION */}
        <div className="section bottom">
          <div className="box div-c">
            <TextInput
              label="Proveedor"
              value={supplier}
              onChange={setSupplier}
              placeholder="Nombre del proveedor"
              ref={supplierInputRef}
              onFocus={scrollToSupplierInput}
            />
          </div>
          <div className="box div-d">
            <button className="btn-primary" onClick={handleSubmit}>Buscar</button>
          </div>


        </div>
      </div>
    </div>
  );
}
