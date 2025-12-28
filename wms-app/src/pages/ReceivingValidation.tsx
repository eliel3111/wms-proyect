import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import apiClient from "../services/apiClient";
import "../styles/ReceivingValidation.css"
import { LoadingScreen } from "../components/LoadingScreen.tsx"

export type Diferencia = {
    id: number;
    sku: string;
    description: string;
    ordered_qty: number;
    received_qty: number;
    difference_qty: number;
};


export default function ReceivingValidation() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();

    const [diferencias, setDiferencias] = useState<Diferencia[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!id) return;

        const poId = Number(id);
        if (isNaN(poId)) return;

        const loadDifferences = async () => {
            try {
                const response = await apiClient.get(
                    `/receiving/${poId}/differences`
                );

                const result = response.data;

                if (!result.success) {
                    throw new Error("Error obteniendo diferencias");
                }

                const diffs: Diferencia[] = result.data;
                console.log("DIFERENCIAS: ", diffs);
                // 1️⃣ Guardar diferencias en state
                setDiferencias(diffs);

                // 2️⃣ Si no hay diferencias → ir directo a final
                if (diffs.length === 0) {
                    navigate(`/receiving/final/${poId}`);
                }

            } catch (error) {
                console.error(error);
            } finally {
                setLoading(false);
            }
        };

        loadDifferences();
    }, [id, navigate]);

    if (loading) {
        return <LoadingScreen />;
    }


    return (
        <div className="page-validation">
            <div className="page-validation-content">
                <h2>Se encontraron estos productos sin recibir</h2>

                {diferencias.map(d => (
                    <div key={d.id} className="difference-card">
                        <div><b>SKU:</b> {d.sku}</div>
                        <div><b>Descripción:</b> {d.description}</div>
                        <div><b>Ordenada:</b> {d.ordered_qty}</div>
                        <div><b>Recibida:</b> {d.received_qty}</div>
                        <div><b>Diferencia:</b> {d.difference_qty}</div>
                    </div>
                ))}

                <div className="validation-footer">
                    <p>¿Desea Finalizar?</p>
                    <button onClick={() => navigate(`/receiving/final/${id}`)}>
                        Finalizar
                    </button>
                </div>
            </div>
        </div>
    );
}
