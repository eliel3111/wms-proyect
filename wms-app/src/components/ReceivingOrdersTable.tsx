import {
  useEffect,
  useState,
} from "react";
import "../styles/ReceivingOrdersTable.css";
import {
  FiFileText,
  FiSearch,
} from "react-icons/fi";
import apiClient from "../services/apiClient.ts";
import { useNavigate } from "react-router-dom";


interface ReceivingOrder {

  purchase_order_id: number;

  purchase_order_number: string;

  erp_order_id:
    | number
    | string
    | null;

  status: string;

  supplier_name: string;

  completed_receipts_count: number;

  last_receipt_finished_at:
    | string
    | null;

}


export default function ReceivingOrdersTable() {

  // =========================================
  // STATES
  // =========================================

  const [orders, setOrders] =
    useState<ReceivingOrder[]>([]);

  const [searchValue, setSearchValue] =
    useState("");

  const [loading, setLoading] =
    useState(false);

const navigate = useNavigate();

const goToReceivingDetails = (
  purchaseOrderId: number
) => {

  navigate(
    `/receiving/details/${purchaseOrderId}`
  );

};

  // =========================================
  // OBTENER ÚLTIMAS 10 ÓRDENES
  // =========================================
// =========================================
// OBTENER ÚLTIMAS 10 ÓRDENES
// =========================================

const getRecentOrders = async () => {

  try {

    setLoading(true);


    const response = await apiClient.get(
      "/receiving/recent-completed-receipts"
    );


    // Axios ya convierte la respuesta JSON
    const data = response.data;


    console.log(
      "📦 ÓRDENES RECIENTES:",
      data
    );


    if (!data.success) {

      setOrders([]);

      return;

    }


    setOrders(
      Array.isArray(data.data)
        ? data.data
        : []
    );


  } catch (error: any) {

    console.error(
      "❌ Error obteniendo órdenes recientes:",
      error
    );


    console.error(
      "❌ Backend:",
      error?.response?.data
    );


    setOrders([]);


  } finally {

    setLoading(false);

  }

};


  // =========================================
  // BUSCAR ÓRDENES
  // =========================================

  // =========================================
// BUSCAR ÓRDENES
// =========================================

const searchOrders = async (
  value: string
) => {

  const cleanValue =
    value.trim();


  // Si está vacío volver
  // a las últimas 10
  if (!cleanValue) {

    await getRecentOrders();

    return;

  }


  try {

    setLoading(true);


    const response = await apiClient.get(

      `/receiving/search-purchase-orders/${encodeURIComponent(
        cleanValue
      )}`

    );


    // Axios ya convierte JSON
    const data = response.data;


    console.log(
      "🔎 RESULTADO BÚSQUEDA:",
      data
    );


    if (!data.success) {

      setOrders([]);

      return;

    }


    setOrders(
      Array.isArray(data.data)
        ? data.data
        : []
    );


  } catch (error: any) {

    console.error(
      "❌ Error buscando órdenes:",
      error
    );


    console.error(
      "❌ Backend:",
      error?.response?.data
    );


    setOrders([]);


  } finally {

    setLoading(false);

  }

};


  // =========================================
  // CARGAR ÚLTIMAS 10 AL ENTRAR
  // =========================================

  useEffect(() => {

    getRecentOrders();

  }, []);


  // =========================================
  // BUSCADOR CON DEBOUNCE
  // =========================================

  useEffect(() => {

    // Si está vacío no hacemos búsqueda aquí.
    // getRecentOrders() se ejecuta abajo.
    if (!searchValue.trim()) {

      return;

    }


    const timer = setTimeout(() => {

      searchOrders(searchValue);

    }, 400);


    return () => {

      clearTimeout(timer);

    };

  }, [searchValue]);


  // =========================================
  // CUANDO EL USUARIO BORRA EL SEARCH
  // =========================================

  useEffect(() => {

    if (searchValue === "") {

      getRecentOrders();

    }

  }, [searchValue]);


  // =========================================
  // SEARCH INPUT
  // =========================================

  const handleSearchChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {

    setSearchValue(
      event.target.value
    );

  };


  // =========================================
  // FORMAT DATE
  // =========================================

  const formatDate = (
    date: string | null
  ) => {

    if (!date) {

      return "N/A";

    }


    return new Date(
      date
    ).toLocaleString(
      "es-US",
      {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }
    );

  };


  // =========================================
  // JSX
  // =========================================

  return (

    <div className="receiving-orders-container">


      {/* =====================================
          HEADER
      ===================================== */}

      <div className="receiving-orders-header">


        {/* TITLE */}

        <div className="receiving-orders-container-title">

          <div className="receiving-orders-title-icon">

            <FiFileText size={25} />

          </div>


          <div className="receiving-orders-title-content">

            <div className="receiving-orders-title">

              Últimas órdenes con recepción

            </div>


            <div className="receiving-orders-subtitle">

              Últimas órdenes de compra que tienen una recepción registrada.

            </div>

          </div>

        </div>


        {/* SEARCH */}

        <div className="receiving-orders-search-box">

          <div className="receiving-orders-search-input-container">

            <FiSearch
              className="receiving-orders-search-icon"
              size={20}
            />


            <input
              type="text"
              className="receiving-orders-search-input"
              placeholder="Buscar por ID o Código..."
              value={searchValue}
              onChange={handleSearchChange}
            />

          </div>

        </div>

      </div>


      {/* =====================================
          TABLE
      ===================================== */}

      <div className="receiving-orders-table-container">


        {loading ? (

          <div className="receiving-orders-loading">

            Cargando órdenes...

          </div>

        ) : orders.length === 0 ? (

          <div className="receiving-orders-empty">

            No se encontraron órdenes de compra.

          </div>

        ) : (

          <table className="receiving-orders-table">


            {/* TABLE HEADER */}

            <thead>

              <tr>

                <th>
                  ID
                </th>

                <th>
                  OC No.
                </th>

                <th>
                  Proveedor
                </th>

                <th>
                  Cantidad de Recepciones
                </th>

                <th>
                  Última Recepción
                </th>

                <th>
                  Estado
                </th>

              </tr>

            </thead>


            {/* TABLE BODY */}

            <tbody>

              {orders.map((order) => (

                <tr
                  key={order.purchase_order_id}
                >

                  {/* ERP ID */}

                  <td>

                    {order.erp_order_id ?? "N/A"}

                  </td>


                {/* PURCHASE ORDER NUMBER */}

<td>

  <button
    type="button"
    className="receiving-orders-po-link"
    onClick={() =>
      goToReceivingDetails(
        order.purchase_order_id
      )
    }
  >

    {order.purchase_order_number}

  </button>

</td>


                  {/* SUPPLIER */}

                  <td>

                    {order.supplier_name || "N/A"}

                  </td>


                  {/* RECEIPTS COUNT */}

                  <td>

                    {order.completed_receipts_count}

                  </td>


                  {/* LAST RECEIPT */}

                  <td>

                    {formatDate(
                      order.last_receipt_finished_at
                    )}

                  </td>


                  {/* STATUS */}

                  <td>

                    <span
                      className={`
                        receiving-orders-status
                        receiving-orders-status-${order.status?.toLowerCase()}
                      `}
                    >

                      {order.status}

                    </span>

                  </td>

                </tr>

              ))}

            </tbody>

          </table>

        )}

      </div>

    </div>

  );

}