import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/ReceivingSearch.css";
import { useEffect, useRef } from "react";
import { openReceptionDB } from "../services/indexeddb.ts";
import TextInput from "../components/TextInput.tsx";
import MultiSelectInput from "../components/MultiSelectInput.tsx";
import apiClient from "../services/apiClient.ts";
import ReceivingOrdersTable from "../components/ReceivingOrdersTable.tsx";
import {
  FilePlus2,
  Search,
  RotateCcw,
} from "lucide-react";

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

  const handleClearFilters = () => {

  setSelectedPOs([]);

  setInvoiceNo("");

  setSupplier("");

  setErrors({});

};




  return (
    <div className="page">
      {/* =========================================================
    RECEIVING SEARCH TOP AREA
========================================================= */}

<div className="receiving-search-top">


  {/* =======================================================
      PAGE TITLE
  ======================================================= */}

  <div className="receiving-search-hero">

    <div className="receiving-search-hero-icon">

      <FilePlus2
        size={25}
        strokeWidth={2}
      />

    </div>


    <div className="receiving-search-hero-content">

      <h1 className="receiving-search-hero-title">

        Recepción de Órdenes

      </h1>


      <p className="receiving-search-hero-subtitle">

        Consulta y gestiona las órdenes de compra con recepción registrada.

      </p>

    </div>

  </div>


  {/* =======================================================
      FILTER CARD
  ======================================================= */}

  <div className="receiving-search-filters">


    {/* =====================================================
        PURCHASE ORDERS
    ===================================================== */}

    <div
      ref={poRef}
      className="
        receiving-search-field
        receiving-search-field-po
      "
    >

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


    {/* =====================================================
        INVOICE
    ===================================================== */}

    <div
      className="
        receiving-search-field
        receiving-search-field-invoice
      "
    >

      <TextInput
        ref={invoiceInputRef}
        label="No. de Factura"
        value={invoiceNo}
        onChange={setInvoiceNo}
        error={errors.invoiceNo}
        placeholder="Ej: FAC-2025-001"
        onFocus={handleInvoiceFocus}
      />

    </div>


    {/* =====================================================
        SUPPLIER
    ===================================================== */}

    <div
      className="
        receiving-search-field
        receiving-search-field-supplier
      "
    >

      <TextInput
        label="Proveedor"
        value={supplier}
        onChange={setSupplier}
        placeholder="Nombre del proveedor"
        ref={supplierInputRef}
        onFocus={scrollToSupplierInput}
      />

    </div>


    {/* =====================================================
        ACTIONS
    ===================================================== */}

    <div className="receiving-search-actions">


      {/* SEARCH */}

      <button
        type="button"
        className="receiving-search-button receiving-search-button-primary"
        onClick={handleSubmit}
      >

        <Search
          size={18}
          strokeWidth={2.1}
        />

        <span>
          Buscar
        </span>

      </button>


      {/* CLEAR */}

      <button
        type="button"
        className="receiving-search-button receiving-search-button-secondary"
        onClick={handleClearFilters}
      >

        <RotateCcw
          size={17}
          strokeWidth={2}
        />

        <span>
          Limpiar
        </span>

      </button>

    </div>

  </div>

</div>


 {/* =========================================
        ÚLTIMAS ÓRDENES CON RECEPCIÓN
        SOLO DESKTOP
    ========================================= */}

      <div className="receiving-orders-desktop-section">

        <ReceivingOrdersTable />

      </div>

    </div>
  );
}
