import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import "../styles/ReceivingFinal.css"
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import { LoadingScreen } from "../components/LoadingScreen.tsx";


type ReceivingLocation = {
    id: number;
    code: string;
};

type CloseReceivingPayload = {
    purchaseOrderId: number;
    receivingLocationId: string;
};

export default function ReceivingFinal() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const inputRef = useRef<HTMLInputElement>(null);
    const [loading, setLoading] = useState(true);
    const [locations, setLocations] = useState<ReceivingLocation[]>([]);
    const [error, setError] = useState<string | null>(null);
    const { openModal } = useModal();


    // Dar Focus al input de la paguina
    useEffect(() => {
        inputRef.current?.focus();
    }, []);
    function keepFocus() {
        inputRef.current?.focus();
    };
    useEffect(() => {
        window.addEventListener("click", keepFocus);
        return () => window.removeEventListener("click", keepFocus);
    }, []);

    // Search all the location for reception
    useEffect(() => {
        const loadLocations = async () => {
            try {
                const response = await apiClient.get("/receiving/locations");
                const result = response.data;
                console.log(result.data);
                if (!result.success) {
                    if (result.code === "UBICACION_NO_EXISTE") {
                        setError("No existe ubicación de recepción configurada");
                        return;
                    }
                }

                setLocations(result.data);

            } catch (err: any) {
                // Error de red o 500
                setError("Error consultando ubicaciones de recepción");
                console.error(err);
            } finally {
                setLoading(false);
                focusScannerInput();
            }
        };

        loadLocations();
    }, []);

    //FUNCTION: To verify the location code scanned exists.
    async function handleScanKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key !== "Enter") return;

        const scannedCode = e.currentTarget.value.trim();

        if (!scannedCode) return;

        console.log("📟 Código leído:", scannedCode);

        // 🔍 Buscar en locations
        const locationFound = locations.find(
            (loc) => loc.code === scannedCode
        );

        if (locationFound) {
            setLoading(true);
            const result = await closeReceiving({
                purchaseOrderId: Number(id),
                receivingLocationId: locationFound.code,
            });
            setLoading(false);
        } else {

            openModal({
                title: "Ubicación inválida",
                message: "El código escaneado NO es una ubicacion valida",
                onCloseCallback: focusScannerInput, // 👈 AQUÍ
            });

        }

        // 🧹 limpiar input para el próximo scan
        e.currentTarget.value = "";
        
    }

    // FUNCTION: To save reception
    async function closeReceiving(payload: CloseReceivingPayload) {
        const response = await apiClient.post("/receiving/close", payload);
        return response.data;
    }

    function focusScannerInput() {
        setTimeout(() => {
            inputRef.current?.focus();
        }, 50); // ⏱️ pequeño delay para mobile
    }

    if (loading) {
        return <LoadingScreen />;
    }

    return (
        <div className="page-receiving-final">
            <div className="page-receiving-final-content">
                {/* CARD PRINCIPAL */}
                <div className="barcode-card">
                    <div className="barcode-svg">
                        {/* SVG de barcode (placeholder) */}
                        <svg height={150} width={150} id="fi_11414226" enable-background="new 0 0 512 512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m96 120v104h-32v-104zm-32 168v104h32v-104zm168-168v104h32v-104zm0 168v104h32v-104zm184-168v104h32v-104zm0 168v104h32v-104zm-256-168v104h16v-104zm0 168v104h16v-104zm32-168v104h16v-104zm0 168v104h16v-104zm144-168v104h16v-104zm0 168v104h16v-104zm32-168v104h16v-104zm0 168v104h16v-104zm-248-168v104h24v-104zm0 168v104h24v-104zm168-168v104h24v-104zm0 168v104h24v-104zm200-48h-464v32h464zm-456-152h72v-16h-88v88h16zm464-16h-88v16h72v72h16zm-392 352h-72v-72h-16v88h88zm392-72h-16v72h-72v16h88z"></path></svg>
                    </div>

                    <div className="barcode-info">
                        <span className="barcode-label">Ubicar toda la mercancia en la ubicacion de recepcion con la <span className="barcode-value">PDA</span>:</span>
                    </div>
                </div>

                {/* INPUT DE SCAN */}
                <div className="scan-input-wrapper">
                    <input
                        ref={inputRef}
                        type="text"
                        inputMode="none"
                        placeholder="Escanee el código de barras"
                        className="scan-input"
                        onKeyDown={handleScanKeyDown}
                    />
                </div>
            </div>
        </div>
    )
};