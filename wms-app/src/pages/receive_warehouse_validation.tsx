import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import apiClient from "../services/apiClient.ts";
import "../styles/ReceivingValidation.css";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import OrderLineCard from "../components/OrderLineCard.tsx";
import { useModal } from "../context/ModalContext.tsx";
import { useAuth } from "../context/AuthProvider.tsx";

type Diferencia = {
    id: number;
    sku: string;
    description: string;
    ordered_qty: number;
    received_qty: number;
    product_exists: boolean;
    barcodes: string[];
};



export default function ReceiveWareValidation() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { openModal } = useModal();
    const [diferencias, setDiferencias] = useState<Diferencia[]>([]);
    const [loading, setLoading] = useState(true);

    const { can } = useAuth();


    useEffect(() => {
        if (!id) return;

        const pickingId = Number(id);
        console.log("ID OBTENIDO DEL PARAMETRO: ", id);
        console.log("ID guardado: ", pickingId);
        if (isNaN(pickingId)) return;

        const loadDifferences = async () => {
            try {
                const response = await apiClient.get(
                    `/warehouse-transfers/differences/${pickingId}`
                );

                const result = response.data;

                if (!result.success) {
                    throw new Error("Error obteniendo diferencias");
                }

                const diffs: Diferencia[] = result.data.lines;
                console.log(result.data);
                console.log("DIFERENCIAS: ", diffs);
                // 1️⃣ Guardar diferencias en state
                setDiferencias(diffs);

                // 2️⃣ Si no hay diferencias → ir directo a final
                if (diffs.length === 0) {
                    setTimeout(() => {
                        navigate(`/receiving/final/${pickingId}`, { replace: true });
                    }, 5);
                }

            } catch (error) {
                console.error(error);
            } finally {
                setLoading(false);
            }
        };

        loadDifferences();
    }, [id, navigate]);

    const handleFinalize = () => {

        console.log("DIFERENCIAS ACTUALES:", diferencias.length);

        const hasDifferences = diferencias.length > 0;
        const canReceiveWithDifferences = can("warehouse_transfer.can_receive_transfer_differences");

        // ❌ Hay diferencias y NO tiene permiso → bloquear
        if (hasDifferences && !canReceiveWithDifferences) {
            openModal({
                title: "Esto es un traslado de almacén",
                message: "No tiene permisos para finalizar con diferencias de cantidades recibidas."
            });

            window.scrollTo({ top: 0, behavior: "smooth" });
            return;
        }

        // ✅ Si no hay diferencias O sí tiene permiso → continuar
        navigate(`/warehouse-transfer-final/${id}`);
    };

    if (loading) {
        return <LoadingScreen />;
    }


    return (
        <div className="page-validation">
            <div className="page-validation-content">

                <div className="validation-title-container">
                    <div className="validation-alert-icon">
                        <svg id="fi_15892071" enable-background="new 0 0 33 33" height="60" viewBox="0 0 33 33" width="60" xmlns="http://www.w3.org/2000/svg"><g><path d="m14.58 3.205c1.057-1.829 2.783-1.829 3.838 0l13.631 24.64c1.057 1.827.191 3.322-1.92 3.322h-9.789c-2.113 0-5.567 0-7.68 0h-9.789c-2.112 0-2.976-1.495-1.922-3.322z" fill="#f7c325"></path><g><g fill="#27314d"><path d="m16.5 9.96c-1.256 0-2.644.973-2.522 2.542l1.022 9.345c.04.647.244 1.467 1.5 1.467 1.254 0 1.459-.819 1.5-1.467l1.021-9.344c.122-1.57-1.267-2.543-2.521-2.543z"></path><circle cx="16.499" cy="26.863" r="1.831"></circle></g></g></g></svg>
                    </div>
                    <div className="validation-title">Se encontraron estos productos sin recibir</div>
                </div>


                <div className="order-container-table">
                    <div className="order-lines-header">
                        <div>Código</div>
                        <div>Descripción</div>
                        <div>Recibida</div>
                        <div>Diferencia</div>
                    </div>

                    <div className="lines-list-validation">
                        {diferencias.map((line) => (
                            <OrderLineCard key={line.id} line={line} validation={true} />
                        ))}
                    </div>
                </div>



                <div className="validation-footer">
                    <div className="validation-footer-text">
                        <div className="validation-subtitle">
                            ¿Desea finalizar la recepción?
                        </div>
                        <div className="validation-description">
                            Revise las diferencias antes de continuar.
                        </div>
                    </div>

                    <button
                        className="btn-finalize-blue"
                        onClick={handleFinalize}
                    >
                        Finalizar
                    </button>
                </div>

            </div>
        </div>
    );
}
