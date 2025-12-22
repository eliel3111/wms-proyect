import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/ReceivingSearch.css";
import { useEffect } from "react";
import { openReceptionDB } from "../services/indexeddb.ts";
import TextInput from "../components/TextInput.tsx";
import SelectInput from "../components/SelectInput.tsx";
import apiClient from "../services/apiClient.ts";

export default function ReceivingSearch() {
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
  const goToOrder = (id: number) => {
    navigate(`/ordencompra/${id}`);
  };

  type Option = {
    value: number;
    label: string;
  };



  //STATES
  const [selectedPO, setSelectedPO] = useState<Option | null>(null);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [supplier, setSupplier] = useState("");
  const [errors, setErrors] = useState<{ invoiceNo?: string; po?: string }>({});
  const [poOptions, setPoOptions] = useState<
    { value: number; label: string }[]
  >([]);

  // Function to habdle button click
  const handleSubmit = async () => {
    const newErrors: { invoiceNo?: string; po?: string } = {};

    if (!selectedPO) newErrors.po = "Orden de compra requerida";
    //if (!invoiceNo.trim()) newErrors.invoiceNo = "Factura requerida";
    console.log(errors);
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    const poId = selectedPO?.label;

    setErrors({});

    try {

      if (!poId) {
        return;
      }

      const response = await apiClient.post("/receiving/by-number", {
        poNumber: poId,
        invoiceNo,
        supplier,
      });

      // Axios ya parsea el JSON
      const result = response.data;

      if (!result.success) {
        throw new Error(result.message || "Error consultando la orden de compra");
      }
      console.log(result.data.id);
      goToOrder(result.data.id);
      if (!result || !result.data) {
        throw new Error("Respuesta inválida del servidor");
      }

    } catch (err: any) {
      setErrors(err.message);
      setSelectedPO(null);
    }
  };







  return (
    <div className="page">
      <div className="container">
        {/* TOP SECTION */}
        <div className="section top">
          <div className="box div-a">
            <SelectInput
              label="Orden de Compra"
              options={poOptions}
              value={selectedPO}
              onChange={(selected) => {
                setSelectedPO(selected);
                setErrors({});
              }}
              placeholder="Seleccione una orden"
              required
              error={errors.po}
            />
          </div>
          <div className="box div-b">
            <TextInput
              label="No. de Factura"
              value={invoiceNo}
              onChange={setInvoiceNo}
              //required
              error={errors.invoiceNo}
              placeholder="Ej: FAC-2025-001"
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
