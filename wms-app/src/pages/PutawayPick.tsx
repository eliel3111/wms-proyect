import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/Putaway.css";
import apiClient from "../services/apiClient";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import { useModal } from "../context/ModalContext";


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

type ProductLocation = {
  location_id: number;
  location_code: string;
  qty_available: number;
};



export default function PutawayPickPage() {
  const navigate = useNavigate();
  const { openModal } = useModal();


  // 📍 Ubicaciones disponibles
  //const productLocations = ["R1-01", "R1-02", "R2-05"];
  const [receivingLocations, setReceivingLocations] = useState<Location[]>([]);
  const [productLocations, setProductLocations] = useState<ProductLocation[]>([]);
  const [currentProduct, setCurrentProduct] = useState<ScannedProduct | null>(null);

  const [loading, setLoading] = useState(true);
  // 📍 Ubicación seleccionada
  const [selectedLocation, setSelectedLocation] = useState<ProductLocation | null>(null);
  const [productScanned, setProductScanned] = useState<boolean>(false);
  const scanBuffer = useRef<string>("");
  const productScannedRef = useRef(false);
  const currentProductRef = useRef<ScannedProduct | null>(null);
  const selectedLocationRef = useRef<ProductLocation | null>(null);
  const productLocationsRef = useRef<ProductLocation[]>([]);
  const qtyInputRef = useRef<HTMLInputElement | null>(null);




  useEffect(() => {
    productScannedRef.current = productScanned;
  }, [productScanned]);
  useEffect(() => {
    currentProductRef.current = currentProduct;
  }, [currentProduct]);

  useEffect(() => {
    selectedLocationRef.current = selectedLocation;
  }, [selectedLocation]);
  useEffect(() => {
    productLocationsRef.current = productLocations;
  }, [productLocations]);




  //Confirm if the user has an active session
  useEffect(() => {
    async function checkSession() {
      try {
        const res = await apiClient.get("/putaway/active-session-extended");

        if (!res.data.hasSession) {
          navigate("/putaway");
        } else {
          if (res.data.receivingLocations) {
            setReceivingLocations(res.data.receivingLocations);
          }
          // aquí luego guardas el sessionId si quieres
          setLoading(false);
        }

      } catch (error) {
        navigate("/putaway");
      }
    }

    checkSession();
  }, []);

// MANEJA CADA SCAN QUE HACE EL USUARIO
  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {
      // Ignorar si el usuario escribe en un input
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if (e.key === "Enter") {
        const scannedValue = scanBuffer.current.trim();

        if (scannedValue) {

          // ✅ verificar si es una ubicación de recepción
          const isReceivingLocation = receivingLocations.some(
            (loc) => loc.code === scannedValue
          );

          if (isReceivingLocation) {



            if (!currentProductRef.current) {
              ////console.log("⛔ Escanea un producto primero");
              openModal({
                title: "⛔ Primero debe escanear un producto",
                message: "El código escaneado NO es un producto"
              });
              // aquí modal: "Escanee un producto primero"
              scanBuffer.current = "";
              return;
            }
            ////console.log("🚫 Es ubicación de recepción, no se procesa:", scannedValue);
            handleScannedLocation(scannedValue);
            ////console.log("PRODUCTO: ", currentProductRef.current);
            ////console.log("CURRENT LOCATION: ", selectedLocationRef.current);

            scanBuffer.current = "";
            return; // ❌ no llama handleScan
          }

          // ✅ si no es ubicación → procesar
          await handleProductScan(scannedValue);
          scanBuffer.current = "";
        }

      } else {
        // 👉 Acumular caracteres del scanner
        if (e.key.length === 1) {
          scanBuffer.current += e.key;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [receivingLocations]); // 👈 importante


 //FUNCTION: Manejar cuando se scanea un producto
  async function handleProductScan(barcode: string) {
    if (!barcode) return;

    ////console.log("📦 Escaneando producto:", barcode);

    const result = await verifyScannedProduct(barcode);
    ////console.log("ALERTA ALERTA", result);
    if (!result.success) {
      ////console.log("❌ Producto no válido");
      openModal({
        title: "Producto no válido",
        message: "Producto no válido o no pendiente de putaway."
      });

      //console.log(result);
      // aquí puedes abrir modal / sonido error
      return;
    }

    //console.log("✅ Producto válido:", result);
    // quitar la ubicacion elegida para que se vean todas
    //console.log("CANTIDAD DE LOCATIONS", result.locations.length);
    setSelectedLocation(null);

    setCurrentProduct(result.product);
    // guardar todas las ubicaciones
    setProductLocations(result.locations)
    if (result.locations.length === 1) {
      setSelectedLocation(result.locations[0]);
      requestAnimationFrame(() => {
        if (qtyInputRef.current) {
          qtyInputRef.current.focus();
          qtyInputRef.current.select(); // 🔥 selecciona todo
        }
      });
    }
    setQty("");
    setProductScanned(true);
    productScannedRef.current = true;
  }



  // Function: Handle product code 
  // services/putawayService.ts

  async function verifyScannedProduct(barcode: string) {
    const response = await apiClient.post("/putaway/scan-product", {
      barcode
    });

    return response.data;
  }


  /*function onSelectLocation(location: string) {
    setSelectedLocation(location);
  }*/

  // 🔢 Cantidad
  const [qty, setQty] = useState<string>("");


  function onQtyChange(value: string) {
    if (value === "") {
      setQty("");
      return;
    }

    const num = Number(value);
    if (isNaN(num) || num < 0) return;

    if (!currentProduct || !selectedLocation) return;

    const qty_available = selectedLocation.qty_available; // ✅ ahora TS sabe que existe

    if (num > qty_available) {
      setQty(String(Math.trunc(qty_available)));
      openModal({
        title: "Cantidad mayor que la recibida",
        message: "Está eligiendo una cantidad mayor que la disponible en recepción."
      });

    } else {
      setQty(value);
    }
  }



  // 🚪 Salir
  function onExit() {
    navigate("/putaway"); // o /menu
  }

  // 💾 Guardar
  async function onSave() {
    if (!currentProduct || !selectedLocation) return;

    const qtyNumber = Number(qty);

    if (!qty || qtyNumber <= 0) {
      openModal({
        title: "Cantidad inválida",
        message: "Ingrese una cantidad válida."
      });
      return;
    }

    try {
      await savePutawayLine({
        productId: currentProduct.id,
        fromLocationId: selectedLocation.location_id,
        qty: qtyNumber
      });

      //console.log("✅ Putaway line creada:", result);

      // ✅ LIMPIAR PANTALLA PARA SIGUIENTE PRODUCTO
      resetPutawayScreen();

    } catch (error: any) {

      const code = error?.response?.data?.error?.code;

      if (code === "QTY_EXCEEDS_RECEIVING") {
        openModal({
          title: "Cantidad mayor a la recepción",
          message: "La cantidad ingresada supera lo disponible en recepción."
        });
      } else {
        openModal({
          title: "Error",
          message: "No se pudo guardar el putaway."
        });
      }
    }
  }

  //FUNTION: Para guardar putawayline
  async function savePutawayLine(payload: {
  productId: number;
  fromLocationId: number;
  qty: number;
}) {
  const response = await apiClient.post("/putaway/line", payload);
  return response.data;
}


  //FUNCTION: Para limpiar la pantalla para la otra putaway
  function resetPutawayScreen() {
    setCurrentProduct(null);
    setSelectedLocation(null);
    setProductLocations([]);
    setQty("");
    setProductScanned(false);

    // opcional: limpiar refs si usas scanner
    currentProductRef.current = null;
    selectedLocationRef.current = null;
    productLocationsRef.current = [];

    // aquí puedes hacer focus invisible para scanner si quieres
  }


  //FUNCTION: Para manejar un una ubicacion leida
  function handleScannedLocation(scannedValue: string) {
    const normalized = scannedValue.trim().toUpperCase();

    const locations = productLocationsRef.current;

    //console.log("📍 UBICACIÓN ESCANEADA:", normalized);
    //console.log("📦 UBICACIONES DISPONIBLES:", locations);

    const found = locations.find(
      (loc) => loc.location_code.trim().toUpperCase() === normalized
    );

    //console.log("🔎 RESULTADO:", found);

    if (found) {
      setSelectedLocation(found);

      // 👉 focus + seleccionar todo el contenido
      requestAnimationFrame(() => {
        if (qtyInputRef.current) {
          qtyInputRef.current.focus();
          qtyInputRef.current.select(); // 🔥 selecciona todo
        }
      });

    } else {
      //console.log("MODAL ERROR: ESTA UBICACIÓN NO ES VÁLIDA");
      openModal({
        title: "Ubicación no válida",
        message: "Esta ubicación no es válida. Verifique el código escaneado e intente nuevamente."
      });

    }
  }


  // Condicion para el boton guardar, para que no sea 0 o mas de la cantidad
  const canSave = Boolean(
    currentProduct &&
    selectedLocation &&
    qty &&
    Number(qty) > 0 &&
    Number(qty) <= Number(selectedLocation.qty_available)
  );




  //Lista de ubicaciones filtradas
  const locationsToRender = selectedLocation
    ? productLocations.filter(
      (loc) => loc.location_id === selectedLocation.location_id
    )
    : productLocations;


  if (loading) return <LoadingScreen />;

  return (
    <div className="putaway-page">
      <div className="putaway-card">
        {/* 1) PRODUCTO */}
        <section className={`block block-product ${!currentProduct ? "empty" : ""}`}>
          {currentProduct ? (
            <>

              <div className="product-desc">
                {currentProduct.description}
              </div>

              <div className="product-top">
                <div className="product-meta">
                  <span className="label">Unidad de Medida:</span>
                  <span className="value">
                    {currentProduct.uom ?? "-"}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="scan-product-hint">
              📦 LEA UN PRODUCTO
            </div>
          )}
        </section>


        {/* 2) UBICACIÓN */}
        <section className="block block-location">
          <div className="block-title">Ubicación de Origen</div>

          <div className="pills">
            {locationsToRender.length ? (
              locationsToRender.map((loc) => {
                //console.log(locationsToRender);
                const isActive = selectedLocation?.location_id === loc.location_id;

                return (
                  <button
                    key={loc.location_id}
                    type="button"
                    className={`pill ${isActive ? "active" : ""} ${locationsToRender.length > 1 ? "activePlus" : ""}`}
                    onClick={() => {
                      setSelectedLocation(loc);

                      requestAnimationFrame(() => {
                        if (qtyInputRef.current) {
                          qtyInputRef.current.focus();
                          qtyInputRef.current.select(); // 🔥 selecciona todo
                        }
                      });
                    }}

                  >
                    {loc.location_code}
                    < span className="pill-qty" > ({Math.trunc(loc.qty_available)})</span>
                  </button>
                );
              })
            ) : (
              <div className="empty">No hay ubicaciones disponibles</div>
            )}
          </div>

        </section>

        {/* 3) CANTIDAD */}
        <section
          className={`block block-qty ${currentProduct && selectedLocation && !qty ? "ready" : ""
            }`}
        >

          <div className="block-title">Cantidad</div>

          <div className="qty-row">
            <input
              ref={qtyInputRef}
              className="qty-input"
              type="number"
              inputMode="numeric"
              step="1"
              placeholder="0"
              value={qty}
              onChange={(e) => onQtyChange(e.target.value)}
              onFocus={(e) => e.target.select()}
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

          {canSave && (
            <button
              type="button"
              className="btn btn-save pop-in"
              onClick={onSave}
            >
              Guardar
            </button>
          )}

        </section>
      </div >
    </div >
  );
}
