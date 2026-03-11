import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/warehouseTransfer.css"
import { useEffect } from "react";
import { openReceptionDB } from "../services/indexeddb.ts";
import apiClient from "../services/apiClient.ts";
import { Truck } from "lucide-react"; // instalar: npm i lucide-react

export default function ReceiveWareTransferSearch() {



    type ReceiveTransfersResponse = {
        success: boolean;
        total: number;
        data: WarehouseTransfer[];
        title?: string;
        message?: string;
    };

    type TransferCard = {
        id: number;
        code: string;
        from: string;
        to: string;
        qty: number;
    };

    useEffect(() => {
        const initDB = async () => {
            try {
                const db = await openReceptionDB();
                console.log("DB lista para usarse:", db);

                const response = await apiClient.get<ReceiveTransfersResponse>(
                    "/warehouse-transfers/receive-transfers"
                );

                const result = response.data;

                console.log("📦 RESPONSE:", result);

                if (!result.success) {
                    console.error(result.title, result.message);
                    return;
                }

                // 🔥 MAPEAR AL FORMATO FRONT
                const mapped = result.data.map((t) => ({
                    id: t.id,
                    code: t.name,
                    from: t.origin,
                    to: t.destination,
                    qty: t.total_lines,
                }));

                setTransfers(mapped);

            } catch (error) {
                console.error("❌ Error cargando transfers:", error);
            }
        };

        initDB();
    }, []);

    const navigate = useNavigate();
    const goToOrder = (id: number) => {
        navigate(`/warehouse-transfer-recepcion/${id}`);
    };
 


    type WarehouseTransfer = {
        id: number;
        name: string;
        origin: string;
        destination: string;
        total_lines: number;
    };



    //STATES
    const [transfers, setTransfers] = useState<TransferCard[]>([]);






    const openTransfer = (transfer: any) => {
        console.log("Abrir traslado", transfer);
        goToOrder(transfer.id)
    };

    return (
        <div className="container-receive-transfer">

            {/* HEADER */}
            <div className="titleRow">
                <div className="iconBox">
                    <Truck size={26} />
                </div>

                <h1 className="receive-transfer-search-title">Traslados pendientes por recibir</h1>
            </div>

            {/* GRID */}
            <div className="grid">

                {transfers.map((t) => (
                    <div
                        key={t.id}
                        className="card"
                        onClick={() => openTransfer(t)}
                    >

                        {/* qty circle */}
                        <div className="qtyCircle">{t.qty}</div>

                        {/* code */}
                        <div className="code">{t.code}</div>

                        {/* route */}
                        <div className="route">
                            {t.from} <svg
                                className="arrowIconreceive"
                                viewBox="0 0 480.026 480.026"
                            >
                                <path d="M475.922,229.325l-144-160c-3.072-3.392-7.36-5.312-11.904-5.312h-96c-6.304,0-12.032,3.712-14.624,9.472
          c-2.56,5.792-1.504,12.544,2.72,17.216l134.368,149.312l-134.368,149.28c-4.224,4.704-5.312,11.456-2.72,17.216
          c2.592,5.792,8.32,9.504,14.624,9.504h96c4.544,0,8.832-1.952,11.904-5.28l144-160
          C481.394,244.653,481.394,235.373,475.922,229.325z"/>
                                <path d="M267.922,229.325l-144-160c-3.072-3.392-7.36-5.312-11.904-5.312h-96c-6.304,0-12.032,3.712-14.624,9.472
          c-2.56,5.792-1.504,12.544,2.72,17.216l134.368,149.312L4.114,389.293c-4.224,4.704-5.312,11.456-2.72,17.216
          c2.592,5.792,8.32,9.504,14.624,9.504h96c4.544,0,8.832-1.952,11.904-5.28l144-160
          C273.394,244.653,273.394,235.373,267.922,229.325z"/>
                            </svg> {t.to}
                        </div>

                    </div>
                ))}

            </div>
        </div>
    );
}


