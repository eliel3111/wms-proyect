import { useState, useEffect } from "react";
import apiClient from "../services/apiClient";
import "../styles/picking.css"

type Picking = {
  id: string;
  name: string;
  erp_cliente: string;
  picker_id: number | null;
  picker_active: boolean;
  picker_name: string | null;
};

export default function PickingProcess() {

    //Estate para abrir y cerrar el side bar derecho de opciones
    const [openSidebar, setOpenSidebar] = useState(false);
    //Para paguinacion de todos los picking activos
    const [page, setPage] = useState(1);
    const [limit, setLimit] = useState(4);
    const [total, setTotal] = useState(0);
    //Para guardar la data de los pickings
    const [data, setData] = useState<Picking[]>([]);


useEffect(() => {
  const fetchPickings = async () => {
    try {
      const res = await apiClient.get(
  `/picking/active-orders?page=${page}&limit=${limit}`
);

      if (res.data.success) {
        console.log(res.data.data)
        setData(res.data.data);
        setTotal(res.data.total);
      }

    } catch (error) {
      console.error("Error fetching pickings:", error);
    }
  };

  fetchPickings();
}, [page, limit]);





    //Funciones para mover las paguinas

    const start = (page - 1) * limit + 1;
    const end = Math.min(page * limit, total);
    const totalPages = Math.ceil(total / limit);
    const goToPrevPage = () => {
        console.log("Página anterior");
        if (page > 1) setPage(page - 1);
    };

    const goToNextPage = () => {
        console.log("Página siguiente");
        if (page < totalPages) setPage(page + 1);
    };

    return (
        <div className="mainInner">
            <div className="monitor-header">

                <div>
                    <div className="monitor-title-small">
                        Pantalla Monitor
                    </div>

                    <div className="monitor-title-big">
                        Proceso de Picking
                    </div>
                </div>

                <div className="page-control">
                    <span className="pagination-text">
                        {start}-{end} / {total > 1000 ? "1000+" : total}
                    </span>

                    <div className="pagination-buttons">
                        <button className="pagination-btn" onClick={goToPrevPage}>
                            ‹
                        </button>
                        <button className="pagination-btn" onClick={goToNextPage}>
                            ›
                        </button>
                    </div>
                </div>

            </div>


            <div className="pickersactivecontainer">


                <div className="pickings-card">
    <div className="pickings-header">
      <h3>Pickings Activos</h3>
    </div>

    <div className="pickings-table">
      <div className="pickings-row-header">
        <span>Pedido</span>
        <span>Cliente</span>
        <span>Picking</span>
        <span>Estado</span>
      </div>

      {data.map((item) => (
        <div className="pickings-row" onClick={() => setOpenSidebar(true)} key={item.id}>
          <span>{item.name}</span>
          <span>{item.erp_cliente}</span>

          <span className="picker">
            <div className="avatar" />
            {item.picker_name || "Sin asignar"}
          </span>

          <span>
            <span
              className={`status ${
                item.picker_active ? "active" : "inactive"
              }`}
            >
              {item.picker_active ? "Activo" : "Inactivo"}
            </span>
          </span>
        </div>
      ))}
    </div>
  </div>
            </div>





            {openSidebar && (
                <div className="sidebar-picking-process">
                    <div className="sidebar-content">
                        <button onClick={() => setOpenSidebar(false)}>Cerrar</button>
                        <h3>Contenido del Sidebar</h3>
                    </div>
                </div>
            )}
        </div>
    );
}