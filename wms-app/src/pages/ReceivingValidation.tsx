import { useEffect, useState } from "react";
import {
    useNavigate,
    useSearchParams
} from "react-router-dom";
import apiClient from "../services/apiClient.ts";
import "../styles/ReceivingValidation.css";
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import OrderLineCard from "../components/OrderLineCard.tsx";


type Diferencia = {
    id: number;

    purchase_order_id: number;
    purchase_order_number: string;

    sku: string;
    description: string;
    ordered_qty: number;
    received_qty: number;
    product_exists: boolean;
    barcodes: string[];
    erp_name: string | null;
    erp_sku: string | null;
    erp_id: number;
};



export default function ReceivingValidation() {
     const [searchParams] =
        useSearchParams();


    const navigate =
        useNavigate();


    const poIdsParam =
        searchParams.get("poIds");


    const [diferencias, setDiferencias] = useState<Diferencia[]>([]);
    const [loading, setLoading] = useState(true);



    useEffect(() => {


    if (!poIdsParam) {
        return;
    }


    const purchaseOrderIds =
        poIdsParam
            .split(",")
            .map(Number)
            .filter(
                (id) =>
                    Number.isInteger(id) &&
                    id > 0
            );


    console.log(
        "📦 PURCHASE ORDER IDS:",
        purchaseOrderIds
    );


    if (
        purchaseOrderIds.length === 0
    ) {

        console.error(
            "❌ No hay purchase order ids válidos"
        );

        setLoading(false);

        return;
    }


    const loadDifferences =
        async () => {

            try {

                console.log(
                    "🚀 BUSCANDO DIFERENCIAS DE:",
                    purchaseOrderIds
                );


                const response =
                    await apiClient.get(
                        "/receiving/differences",
                        {
                            params: {

                                poIds:
                                    purchaseOrderIds.join(",")

                            }
                        }
                    );


                const result =
                    response.data;


                console.log(
                    "📥 RESPUESTA BACKEND:",
                    result
                );


                if (!result.success) {

                    throw new Error(
                        result.message ||
                        "Error obteniendo diferencias"
                    );

                }


                const diffs:
                    Diferencia[] =
                    result.data.lines;


                console.log(
                    "📦 DIFERENCIAS:",
                    diffs
                );


                setDiferencias(
                    diffs
                );



                if (
                    diffs.length === 0
                ) {

                    setTimeout(
                        () => {

                            navigate(
                                `/receiving/final?poIds=${encodeURIComponent(
                                    purchaseOrderIds.join(",")
                                )}`,
                                {
                                    replace: true
                                }
                            );

                        },
                        5
                    );

                }


            } catch (error) {

                console.error(
                    "❌ Error obteniendo diferencias:",
                    error
                );


            } finally {

                setLoading(false);

            }

        };


    loadDifferences();


}, [
    poIdsParam,
    navigate
]);

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
                        onClick={() => navigate(`/receiving/final/${searchParams}`)}
                    >
                        Finalizar
                    </button>
                </div>

            </div>
        </div>
    );
}
