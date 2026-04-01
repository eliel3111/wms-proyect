import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/warehouseTransfer.css"
import "../styles/picking-user.css"
import { useEffect } from "react";
import apiClient from "../services/apiClient.ts";
import { FileText } from "lucide-react";

export default function GetAssignedPickings() {



   type AssignedPicking = {
  id: number;
  name: string;
  order_name: string | null;
  erp_cliente: string | null;
  type: "sales_order";
};

 type GetAssignedPickingsResponse = {
  success: boolean;
  title: string;
  message: string;
  data: AssignedPicking[];
};
    useEffect(() => {
        const initDB = async () => {
            try {


                const response = await apiClient.get<GetAssignedPickingsResponse >(
                    "/picking/assigned"
                );

                const result = response.data;

                console.log("📦 RESPONSE:", result);

                if (!result.success) {
                    console.error(result.title, result.message);
                    return;
                }

               

                setPickings(result.data);

            } catch (error) {
                console.error("❌ Error cargando transfers:", error);
            }
        };

        initDB();
    }, []);

    const navigate = useNavigate();
    const goToOrder = (id: number) => {
        navigate(`/picking/${id}`);
    };
 






    //STATES
    const [pickings, setPickings] = useState<AssignedPicking[]>([]);






    const openTransfer = (transfer: any) => {
        console.log("Abrir traslado", transfer);
        goToOrder(transfer.id)
    };

    return (
        <div className="container-receive-transfer">

            {/* HEADER */}
            <div className="titleRow">
                <div className="iconBox">
                    <FileText size={26} />
                </div>

                <h1 className="receive-transfer-search-title">Pedidos pendientes por recoger</h1>
            </div>

            {/* GRID */}
            <div className="grid">

                {pickings.map((t) => (
                    <div
                        key={t.id}
                        className="card"
                        onClick={() => openTransfer(t)}
                    >

                        {/* qty circle */}
                        <div className="picking-user-order-name">{t.order_name}</div>

                        {/* code */}
                        <div className="code">{t.name}</div>

                        {/* route */}
                        <div className="route">
                            {t.erp_cliente}
                        </div>

                    </div>
                ))}

            </div>
        </div>
    );
}


