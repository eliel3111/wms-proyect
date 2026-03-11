import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/Putaway.css";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import { LoadingScreen } from "../components/LoadingScreen.tsx";

/* =======================
   TYPES
======================= */

type Location = {
  id: number;
  code: string;
};

/*type ScannedProduct = {
  id: number;
  sku: string;
  description: string;
  uom?: string;
};

type ProductLocation = {
  location_id: number;
  location_code: string;
  qty_available: number;
};*/


type PendingPutawayLine = {
  id: string;              // viene como string desde Postgres
  sku: string;
  description: string;
  uom: string | null;      // ✅ agregado (por si algún producto no tiene uom)
  picked_qty: string;     // "10.000"
  put_qty: string;        // "0.000"
  pending_qty: string;   // "10.000"
  barcode: string | null; // barcode principal (puede ser null si no hay)
};


/* =======================
   COMPONENT
======================= */

export default function PutawayPickPage() {
  const navigate = useNavigate();
  const { openModal } = useModal();

  const [loading, setLoading] = useState(true);
  const [pendingLines, setPendingLines] = useState<PendingPutawayLine[]>([]);
  const pendingLinesRef = useRef<PendingPutawayLine[]>([]);

  const [sessionId, setSessionId] = useState<number | null>(null);
  const [currentLine, setCurrentLine] = useState<PendingPutawayLine | null>(null);
  const [putLocation, setPutLocation] = useState<Location | null>(null);
  const putLocationRef = useRef<Location | null>(null);
  //const [locationScanned, setLocationScanned] = useState(false);



  
  const qtyInputRef = useRef<HTMLInputElement | null>(null);
  const scanBuffer = useRef<string>("");
  const currentLineRef = useRef<PendingPutawayLine | null>(null);
  const [qty, setQty] = useState<string>("");
  const qtyRef = useRef<string>("");

  useEffect(() => {
    pendingLinesRef.current = pendingLines;
  }, [pendingLines]);
  useEffect(() => {
    currentLineRef.current = currentLine;
  }, [currentLine]);
  useEffect(() => {
    putLocationRef.current = putLocation;
  }, [putLocation]);
  useEffect(() => {
    qtyRef.current = qty;
  }, [qty]);




  /* =======================
     ACTIONS
  ======================= */

  {/*CALL AL PENDING PUTAWAY LINES FOR THIS USER*/ }
  useEffect(() => {
    loadPendingPutaway();
  }, []);


  {/*ESCUCHA LA LECTURA DEL SCANER*/ }
  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {

      const isEndKey =
        e.key === "Enter" ||
        e.key === "NumpadEnter" ||
        e.key === "Tab";

      if (isEndKey) {
        let scannedValue = scanBuffer.current
          .replace(/[\r\n]+/g, "")
          .trim()
          .toUpperCase();

        console.log("📡 SCAN:", JSON.stringify(scannedValue));

        if (!scannedValue) {
          scanBuffer.current = "";
          return;
        }

        try {
          // 1️⃣ ¿Es producto pendiente?
          const foundLine = pendingLinesRef.current.find(
            (line) => line.barcode?.trim().toUpperCase() === scannedValue
          );

          if (foundLine) {
            console.log("✅ PRODUCTO EN SESSION:", foundLine);
            setCurrentLine(foundLine);
            //setQty(String(Math.trunc(+foundLine.picked_qty)));
            //enfocar y select el input cantidad
            // 👉 seleccionar el input manualmente
            setTimeout(() => {
              qtyInputRef.current?.focus();
              qtyInputRef.current?.select();
            }, 0);
            scanBuffer.current = "";
            return;
          }

          // 2️⃣ ¿Es ubicación?
          const result = await verifyPutawayLocation(scannedValue);

          if (!result?.location) {
            openModal({
              title: "Ubicación no válida",
              message: "La ubicación escaneada no es correcta. Elija una ubicación en su almacén."
            });
            scanBuffer.current = "";
            return;
          }

          console.log("📍 UBICACIÓN OK:", result.location);
          setPutLocation(result.location);
          setCurrentLine(null);     // 🔥 limpiar producto
          setQty("");               // 🔥 limpiar cantidad (si existe)

        } catch (err) {
          console.error("❌ Error procesando scan:", err);
          openModal({
            title: "Error de escaneo",
            message: "No se pudo procesar el código escaneado."
          });
        } finally {
          scanBuffer.current = "";
        }

      } else {
        if (e.key.length === 1) {
          scanBuffer.current += e.key;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);



  function onExit() {
    navigate("/putaway");
  }

  /*FUNCTION: To confirm a location*/
  async function verifyPutawayLocation(scannedValue: string) {
    const response = await apiClient.post("/putaway/scan-putaway-location", {
      code: scannedValue
    });

    return response.data;
  }


  async function onSave() {

    if (!currentLine || !putLocation) return;

    const qtyNumber = Number(qty);

    if (!qty || qtyNumber <= 0) {
      openModal({
        title: "Cantidad inválida",
        message: "Ingrese una cantidad válida."
      });
      return;
    }

    try {
      // 👉 Aquí luego iría la llamada real a la API
      if (!sessionId) {
        throw new Error("No hay sesión activa");
      }

      if (!currentLine?.id) {
        throw new Error("No hay producto seleccionado");
      }

      if (!putLocation?.code) {
        throw new Error("No hay ubicación seleccionada");
      }

      const payload = {
        putaway_session_id: sessionId,
        product_id: currentLine.sku,
        to_location_code: putLocation.code,
        qty: Number(qty)
      };

      const result = await dropPutaway(payload);


      console.log("PUTAWAY DROP OK:", result);
      setQty("");
      setCurrentLine(null);
      setPutLocation(null);
      // 🔥 refrescar pendientes
      await loadPendingPutaway();

      openModal({
        title: "Guardado",
        message: "Putaway registrado correctamente."
      });

    } catch (error) {
      openModal({
        title: "Error",
        message: "No se pudo guardar el putaway."
      });
    }
  }

  // FUNCTION: to search all the pending lines
  async function loadPendingPutaway() {
    try {
      setLoading(true);

      const response = await apiClient.get("/putaway/pending");
      const result = response.data;

      if (!result.success) {
        throw new Error(result.message || "Error cargando pendientes");
      }
      console.log(result.data);
      setPendingLines(result.data);
      setSessionId(Number(result.sessionId));
      setSessionId(Number(result.sessionId));

    } catch (err: any) {
      console.error("Error cargando putaway pendientes:", err);
    } finally {
      setLoading(false);
    }
  }

  // FUNCTION: Drop de producto en putaway
  async function dropPutaway(payload: {
    putaway_session_id: number;
    product_id: string;
    to_location_code: string;
    qty: number;
  }) {
    const response = await apiClient.post("/putaway/drop", payload);
    return response.data;
  }


  //FUNCTION: Para manejar el input change
  function onQtyChange(value: string) {
    if (value === "") {
      setQty("");
      return;
    }

    const num = Number(value);
    if (isNaN(num) || num < 0) return;
    console.log(currentLine);
    if (!currentLine || !putLocation) return;

    //const qty_available = selectedLocation.qty_available; // ✅ ahora TS sabe que existe
    const qty_available = pendingLines
      .filter(line => line.sku === currentLine.sku)
      .reduce((sum, line) => {
        return sum + Number(line.picked_qty);
      }, 0);



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


  //FUNTION: to make input be focus
  /*function selectAllOnFocus(e: React.FocusEvent<HTMLInputElement>) {
    requestAnimationFrame(() => {
      e.target.select();
    });
  }*/


  /* =======================
     UI
  ======================= */

  const showProductEmpty = putLocation && !currentLine;




  if (loading) return <LoadingScreen />;

  return (
    <div className="putaway-page">
      <div className="putaway-card">

        {/* 2) UBICACIÓN DESTINO */}
        <section className={`block block-location ${!putLocation ? "empty" : ""}`}>
          {putLocation ? (
            <>
              <div className="block-title">Ubicación destino</div>

              <div className="pills">
                {putLocation ? (
                  <button type="button" className="pill active">
                    {putLocation.code}
                  </button>
                ) : (
                  ""
                )}
              </div>
            </>) : (<div className="scan-product-hint">
              LEA UNA UBICACIÓN DE ALMACÉN
            </div>)}
        </section>


        {/* 1) PRODUCTO */}
        <section
          className={`block block-product 
            ${showProductEmpty ? "empty" : ""} 
            ${currentLine ? "has-product" : ""}
          `}
        >


          {showProductEmpty ? (
            <div className="scan-product-hint">
              LEA UN PRODUCTO
            </div>
          ) : (
            <>
              <div className="product-desc">
                {currentLine ? currentLine.description : ""}
              </div>

              <div className="product-top">
                <div className="product-meta">
                  <span className="label">Código del producto:</span>
                  <span className="value">
                    {currentLine?.sku ?? ""}
                  </span>
                </div>
              </div>
            </>
          )}

        </section>





        {/* 3) CANTIDAD */}
        <section
          className={`block block-qty ${currentLine && putLocation && !qty ? "ready" : ""
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

          {Number(qty) > 0 && (
            <button
              type="button"
              className="btn btn-save pop-in"
              onClick={onSave}
            >
              Guardar
            </button>
          )}

        </section>


        {/* 🔽 SECCIÓN CONDICIONAL */}
        {pendingLines.length > 0 && (
          <>
            {/* 🧾 SUBTÍTULO */}
            <div className="putaway-subtitle">
              <div>Productos pendientes por ubicar</div>
            </div>

            {/* 📋 TABLA */}
            <div className="putaway-table-wrapper">
              <table className="putaway-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Descripción</th>
                    <th>Cantidad</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingLines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.sku}</td>
                      <td>{line.description}</td>
                      <td>{Number(line.pending_qty)}</td>
                    </tr>
                  ))}
                </tbody>

              </table>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
