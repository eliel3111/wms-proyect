import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/Putaway.css";
import apiClient from "../services/apiClient";
import { LoadingScreen } from "../components/LoadingScreen.tsx";

type Product = {
  unitMeasureLocation?: string;
  description?: string;
};

export default function PutawayPickPage() {
  const navigate = useNavigate();

  // 🧾 Producto actual (mock por ahora)
  const product: Product = {
    unitMeasureLocation: "A-01-02",
    description: "Producto ejemplo",
  };

  // 📍 Ubicaciones disponibles
  const productLocations = ["R1-01", "R1-02", "R2-05"];
  const [loading, setLoading] = useState(true);
  // 📍 Ubicación seleccionada
  const [selectedLocation, setSelectedLocation] = useState<string | null>(null);
  const [productScanned, setProductScanned] = useState<boolean>(false);
  const scanBuffer = useRef<string>("");
const productScannedRef = useRef(false);

useEffect(() => {
  productScannedRef.current = productScanned;
}, [productScanned]);



  //Confirm if the user has an active session
  useEffect(() => {
    async function checkSession() {
      try {
        const res = await apiClient.get("/putaway/active-session");

        if (!res.data.hasSession) {
          console.log("❌ No hay sesión activa → regresando al menú");
          navigate("/putaway");
        } else {
          console.log("✅ Sesión activa:", res.data.session);
          // aquí luego guardas el sessionId si quieres
          setLoading(false);
        }

      } catch (error) {
        console.error("Error verificando sesión putaway:", error);
        navigate("/putaway");
      }
    }

    checkSession();
  }, []);


  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignorar si el usuario escribe en un input
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (e.key === "Enter") {
        const scannedValue = scanBuffer.current.trim();
        if (scannedValue) {
          handleScan(scannedValue);
          scanBuffer.current = "";
        }
      } else {
        // solo caracteres visibles
        if (e.key.length === 1) {
          scanBuffer.current += e.key;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);



















  //Function: Para manejar una lectura de un codigo
  async function handleScan(barcode: string) {
    if (!barcode) return;
    console.log("REF:", productScannedRef.current);
    if (productScannedRef.current) {
      console.log("📍 ESTO ES UNA UBICACIÓN:", barcode);

      // aquí luego validas si es ubicación real
      // validateLocation(barcode)

    } else {
      console.log("📦 ESTO ES UN PRODUCTO:", barcode);

      // aquí luego validas si es producto real
      const result = await verifyScannedProduct(barcode);
      console.log(result.success);

      //si se consiguio un producto
      if (result.success === true) {
        console.log("codigo correc");
        setProductScanned(true); // 👈 ya tenemos producto
        productScannedRef.current = true;
      }
      
    }
  }


// Function: Handle product code 
// services/putawayService.ts

async function verifyScannedProduct(barcode: string) {
  const response = await apiClient.post("/putaway/scan-product", {
    barcode
  });

  return response.data;
}


  function onSelectLocation(location: string) {
    setSelectedLocation(location);
  }

  // 🔢 Cantidad
  const [qty, setQty] = useState<number>(0);

  function onQtyChange(value: string) {
    const num = Number(value);
    if (isNaN(num) || num < 0) return;
    setQty(num);
  }

  // 🚪 Salir
  function onExit() {
    navigate("/putaway"); // o /menu
  }

  // 💾 Guardar
  async function onSave() {
    if (!selectedLocation) {
      alert("Seleccione una ubicación");
      return;
    }

    if (qty <= 0) {
      alert("Cantidad inválida");
      return;
    }

    const payload = {
      selectedLocation,
      qty,
      product,
    };

    console.log("Guardando putaway:", payload);

    // await apiClient.post("/putaway/pick", payload);

    setQty(0);
    setSelectedLocation(null);
  }

  if (loading) return <LoadingScreen />;

  return (
    <div className="putaway-page">
      <div className="putaway-card">
        {/* 1) PRODUCTO */}
        <section className="block block-product">
          <div className="product-top">
            <div className="product-meta">
              <span className="label">Ubicación de Medida:</span>
              <span className="value">
                {product.unitMeasureLocation ?? "-"}
              </span>
            </div>
          </div>

          <div className="product-desc">
            {product.description ?? "-"}
          </div>
        </section>

        {/* 2) UBICACIÓN */}
        <section className="block block-location">
          <div className="block-title">Ubicación de Origen</div>

          <div className="pills">
            {productLocations.length ? (
              productLocations.map((loc) => {
                const isActive = loc === selectedLocation;
                return (
                  <button
                    key={loc}
                    type="button"
                    className={`pill ${isActive ? "active" : ""}`}
                    onClick={() => onSelectLocation(loc)}
                  >
                    {loc}
                  </button>
                );
              })
            ) : (
              <div className="empty">No hay ubicaciones disponibles</div>
            )}
          </div>
        </section>

        {/* 3) CANTIDAD */}
        <section className="block block-qty">
          <div className="block-title">Cantidad</div>

          <div className="qty-row">
            <input
              className="qty-input"
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              placeholder="0"
              value={qty}
              onChange={(e) => onQtyChange(e.target.value)}
            />
          </div>

          <div className="helper">
            Usa el teclado numérico para escribir rápido.
          </div>
        </section>

        {/* 4) BOTONES */}
        <section className="block block-actions">
          <button type="button" className="btn btn-exit" onClick={onExit}>
            Salir
          </button>

          <button type="button" className="btn btn-save" onClick={onSave}>
            Guardar
          </button>
        </section>
      </div>
    </div>
  );
}
