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
  const { closeModal } = useModal();

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

        const target = e.target as HTMLElement;

        const isEndKey =
            e.key === "Enter" ||
            e.key === "NumpadEnter" ||
            e.key === "Tab";

        // =====================================================
        // DEBUG - EVENTO DEL SCANNER
        // =====================================================

        console.log("⌨️ SCANNER EVENT:", {
            key: e.key,
            target: target.tagName,
            inputFocused: target === qtyInputRef.current,
            buffer: scanBuffer.current,
            location: putLocationRef.current?.code ?? null,
            product: currentLineRef.current?.sku ?? null
        });

        // =====================================================
        // 1. IGNORAR INPUTS MANUALES
        // =====================================================

        if (
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable
        ) {

            console.log(
                "⚠️ SCANNER IGNORADO POR FOCO EN:",
                target.tagName
            );

            scanBuffer.current = "";
            return;
        }

        // =====================================================
        // 2. ACUMULAR CÓDIGO DEL SCANNER
        // =====================================================

        if (!isEndKey) {

            if (e.key.length === 1) {
                scanBuffer.current += e.key;
            }

            return;
        }

        e.preventDefault();

        // =====================================================
        // 3. OBTENER CÓDIGO ESCANEADO
        // =====================================================

        const scannedValue = scanBuffer.current
            .replace(/[\r\n]+/g, "")
            .trim()
            .toUpperCase();

        scanBuffer.current = "";

        console.log(
            "📡 CÓDIGO ESCANEADO:",
            scannedValue
        );

        if (!scannedValue) {
            console.log("⚠️ SCANNER BUFFER VACÍO");
            return;
        }

        try {

            // =====================================================
            // 4. BUSCAR PRODUCTO EN PUTAWAY
            // =====================================================

            const foundLine = pendingLinesRef.current.find(
                (line) =>
                    line.barcode?.trim().toUpperCase() === scannedValue ||
                    line.sku?.trim().toUpperCase() === scannedValue
            );

            console.log(
                "\x1b[44m\x1b[37m 📦 VALIDANDO PRODUCTO PUTAWAY \x1b[0m"
            );

            console.log({
                scannedValue,
                foundLine: foundLine ?? null,
                currentLocation: putLocationRef.current,
                pendingLinesCount: pendingLinesRef.current.length,
                pendingProducts: pendingLinesRef.current.map(
                    line => line.sku
                )
            });

            // =====================================================
            // 5. PRODUCTO ENCONTRADO
            // =====================================================

            if (foundLine) {

                console.log(
                    "✅ PRODUCTO ENCONTRADO EN PUTAWAY:",
                    foundLine
                );

                // Primero debe existir una ubicación
                if (!putLocationRef.current) {

                    openModal({
                        title: "⚠️ UBICACIÓN REQUERIDA",
                        message: "Primero debe escanear una ubicación de destino.",
                        buttonText: "Entendido",
                        titleColor: "#d97706"
                    });

                    return;
                }

                // Validar cantidad pendiente
                if (Number(foundLine.pending_qty) <= 0) {

                    openModal({
                        title: "⚠️ SIN CANTIDAD PENDIENTE",
                        message: "Este producto no tiene unidades pendientes de ubicar.",
                        buttonText: "Entendido",
                        titleColor: "#d97706"
                    });

                    return;
                }

                setCurrentLine(foundLine);
                currentLineRef.current = foundLine;

                setQty("");
                qtyRef.current = "";

                // Evitar mantener el scanner dentro del input
                qtyInputRef.current?.blur();

                return;
            }

            // =====================================================
            // 6. NO ES PRODUCTO: VERIFICAR SI ES UBICACIÓN
            // =====================================================

            console.log(
                "🔍 NO COINCIDE CON PRODUCTO. VERIFICANDO UBICACIÓN:",
                scannedValue
            );

            let location = null;

            try {

                const result = await verifyPutawayLocation(
                    scannedValue
                );

                console.log(
                    "📍 RESPUESTA BACKEND LOCATION:",
                    result
                );

                location = result?.location ?? null;

            } catch (locationError: any) {

                console.log(
                    "⚠️ ERROR VERIFICANDO UBICACIÓN:",
                    locationError?.response?.data ||
                    locationError
                );

                const status = locationError?.response?.status;

                // Error de servidor o conexión
                if (status !== 400 && status !== 404) {

                    openModal({
                        title: "❌ ERROR DE VERIFICACIÓN",
                        message: "No se pudo verificar el código escaneado. Intente nuevamente.",
                        buttonText: "Entendido",
                        titleColor: "red"
                    });

                    return;
                }
            }

            // =====================================================
            // 7. UBICACIÓN ENCONTRADA
            // =====================================================

            if (location) {

                console.log(
                    "✅ UBICACIÓN VÁLIDA:",
                    location
                );

                setPutLocation(location);
                putLocationRef.current = location;

                setCurrentLine(null);
                currentLineRef.current = null;

                setQty("");
                qtyRef.current = "";

                closeModal();

                return;
            }

            // =====================================================
            // 8. NO ES PRODUCTO NI UBICACIÓN VÁLIDA
            // =====================================================

            console.log(
                "\x1b[43m\x1b[30m ⚠️ CÓDIGO NO ENCONTRADO EN PUTAWAY \x1b[0m"
            );

            console.log({
                scannedValue,
                productFound: false,
                validLocation: false,
                currentLocation: putLocationRef.current?.code ?? null
            });

            openModal({
    title: "PRODUCTO NO VALIDO",
    message: "Este producto no está en el Putaway o el código no corresponde a una ubicación válida.",
    buttonText: "Entendido",
    titleColor: "warning"
});
            return;

        } catch (error) {

            console.error(
                "❌ ERROR PROCESANDO SCANNER:",
                error
            );

            openModal({
                title: "❌ ERROR DE ESCANEO",
                message: "Ocurrió un error procesando el código escaneado.",
                buttonText: "Entendido",
                titleColor: "red"
            });

        }

    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
        window.removeEventListener("keydown", handleKeyDown);
    };

}, []);


  function onExit() {
    navigate("/putaway");
  }

  /*FUNCTION: To confirm a location*/
  async function verifyPutawayLocation(scannedValue: string) {
    console.log("Buscando location...");
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
        title: "✅ PUTAWAY REGISTRADO",
        message: "El Putaway se registró correctamente.",
        buttonText: "Entendido",
        titleColor: "green"
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
              onFocus={(e) => {
                scanBuffer.current = "";
                e.target.select();
              }}
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
