import { useState, useEffect } from "react";
import apiClient from "../services/apiClient";
import "../styles/picking.css"
import { LoadingScreen } from "../components/LoadingScreen.tsx";
import { useModal } from "../context/ModalContext";
import { MultiValueSearchInput } from "../components/MultiValueSearchInput";


type Picking = {
  id: string;
  name: string;
  erp_cliente: string;
  picker_id: number | null;
  picker_active: boolean;
  picker_name: string | null;
};

type Picker = {
  picker_id: number;
  user_id: number;
  full_name: string;
};

export default function PickingProcess() {

  //Estate para abrir y cerrar el side bar derecho de opciones
  const [openSidebar, setOpenSidebar] = useState(false);
  //Para paguinacion de todos los picking activos
  const [page, setPage] = useState(1);
  const limit = 10;
  const [total, setTotal] = useState(0);
  //Para guardar la data de los pickings
  const [data, setData] = useState<Picking[]>([]);
  // Para guardar el pedido elegido
  const [selectedItem, setSelectedItem] = useState<typeof data[number] | null>(null);
  //Para mostrar el boon confirmar
  const [showConfirm, setShowConfirm] = useState(false);
  //Para cambiar sidel modal view para elegir el picking
  const [view, setView] = useState("details");
  //Soloactive pickers
  const [pickers, setPickers] = useState<Picker[]>([]);

  const [selectedPicker, setSelectedPicker] = useState<number | null>(null);

  const [loadingData, setLoadingData] = useState(true);
  const [searchValues, setSearchValues] = useState<string[]>([]);


  useEffect(() => {
    const loadData = async () => {
      try {
        setLoadingData(true);

        await fetchPickings();

      } catch (error) {
        console.error("Error loading data:", error);
      } finally {
        setLoadingData(false);
      }
    };

    loadData();
  }, [page, limit]);

  const fetchPickings = async (
    values: string[] = searchValues
  ) => {
    try {

      console.log("🔍 Buscando pickings:", values);

      const res = await apiClient.get(
        "/picking/active-orders",
        {
          params: {
            page,
            limit,

            // ["1256", "1300"]
            // se convierte en:
            // "1256,1300"
            search: values.join(","),
          },
        }
      );

      if (res.data.success) {
        console.log("🟢 Pickings:", res.data.data);

        setData(res.data.data);
        setTotal(res.data.total);
      }

    } catch (error) {
      console.error(
        "Error fetching pickings:",
        error
      );
    }
  };

  //FUNCION QUE RECIBE LA BUSQUEDA
  const handleSearchPickings = (
    values: string[]
  ) => {
    console.log(
      "🔎 Valores para buscar:",
      values
    );

    // Cuando cambia una búsqueda,
    // regresamos a página 1.
    setPage(1);
    console.log("BUSCANDO AL BACKEND: ", values);
    fetchPickings(values);
  };

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


  //Funcion para anular un pedido:
  const handleCancelPicking = async () => {
    try {
      if (!selectedItem?.id) {
        console.log("❌ No hay picking seleccionado");
        return;
      }

      console.log("🟡 Cancelando picking:", selectedItem.id);

      const res = await apiClient.post("/picking/cancel", {
        id: selectedItem.id,
      });

      console.log("🟢 Respuesta backend:", res.data);

      // Opcional: cerrar sidebar
      fetchPickings();
      setOpenSidebar(false);
      setSelectedItem(null);



    } catch (error) {
      console.error("🔴 Error cancelando picking:", error);
    }
  };


  //Funcion para buscar los pickers activos al backend
  const fetchActivePickers = async () => {
    try {
      console.log("🟡 Llamando pickers activos...");

      const res = await apiClient.get("/picking/active-pickers");

      if (res.data.success) {
        setPickers(res.data.data);
        console.log("🟢 Pickers cargados:", res.data.data);
      } else {
        console.log("⚠️", res.data.message);
        setPickers([]);
      }

    } catch (error) {
      console.error("🔴 Error obteniendo pickers:", error);
      setPickers([]);
    }
  };


  //Funcion para reasignar un pewdido
  const { openModal } = useModal();
  const handleReassign = async () => {
    console.log("🚀 [START] Reassign desde frontend");

    try {
      // 🔹 Validaciones
      if (!selectedPicker) {
        console.log("⚠️ No picker seleccionado");

        openModal({
          title: "Advertencia",
          message: "Debes seleccionar un picker",
        });

        return;
      }

      if (!selectedItem?.id) {
        console.log("⚠️ No picking seleccionado");

        openModal({
          title: "Error",
          message: "No hay picking seleccionado",
        });

        return;
      }

      console.log("📤 Enviando request:", {
        selectedPicker,
        selectedItem,
      });

      // 🔥 Llamada al backend
      const response = await apiClient.post("/picking/reassign", {
        selectedPicker,
        selectedItem,
      });

      console.log("📥 Response backend:", response.data);

      const { success, message } = response.data;

      // 🎯 Title estándar
      const title = success ? "Operación exitosa" : "Error";

      // ✅ Solo si todo salió bien
      if (success) {
        console.log("✅ Reasignación exitosa, cambiando vista");
        fetchPickings();
        setOpenSidebar(false);
        setSelectedItem(null);
        setView("details"); // reset
      }


      openModal({
        title,
        message: message || "Ocurrió un problema",
      });


    } catch (error: any) {
      console.error("🔥 [CATCH ERROR] Reassign:", error);

      const backendMessage =
        error?.response?.data?.message ||
        "Error de conexión con el servidor";

      openModal({
        title: "Error de sistema",
        message: backendMessage,
      });
    } finally {
      console.log("🔚 [END] Reassign frontend");
    }
  };

  return (
    <div className="mainInner">
      <div className="monitor-header">

        <div className="monitor-header-parta">
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

            <MultiValueSearchInput
              values={searchValues}
              onChange={setSearchValues}
              onSearch={handleSearchPickings}
              width="420px"
              placeholder="Buscar pedidos..."
              autoFocus
            />

          </div>

          <div className="pickings-table">
            <div className="pickings-row-header">
              <span>Pedido</span>
              <span>Cliente</span>
              <span>Picker</span>
              <span>Estado</span>
            </div>

            <div className="pickersactivecontainer">
              {loadingData ? (
                <LoadingScreen />
              ) : data.length === 0 ? (
                <div className="no-pickings">
                  <div className="no-pickings-icon">🎉</div>
                  <p className="no-pickings-title">Excelente trabajo</p>
                  <span className="no-pickings-sub">
                    No hay pedidos pendientes
                  </span>
                </div>
              ) : (
                data.map((item) => (
                  <div
                    className="pickings-row"
                    onClick={() => {
                      setSelectedItem(item);
                      setShowConfirm(false);
                      setView("details");
                      setOpenSidebar(true);
                      setSelectedPicker(null);
                      fetchActivePickers();
                    }}
                    key={item.id}
                  >
                    <span>{item.name}</span>
                    <span>{item.erp_cliente}</span>

                    <span className="picker">
                      <div className="avatar" />
                      {item.picker_name || "Sin asignar"}
                    </span>

                    <span>
                      <span
                        className={`status ${item.picker_active ? "active" : "inactive"
                          }`}
                      >
                        {item.picker_active ? "Activo" : "Inactivo"}
                      </span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>





      {openSidebar && selectedItem && (
        <div className="sidebar-picking-process">
          <div className="sidebar-content">

            {/* BOTÓN CERRAR */}
            <button
              onClick={() => {
                setOpenSidebar(false);
                setSelectedItem(null);
                setView("details"); // reset
              }}
              className="modal-pick-close-btn"
            >
              ✕
            </button>

            {/* ========================= */}
            {/* 🟦 VISTA 1: DETALLES */}
            {/* ========================= */}
            {view === "details" && (
              <>
                <h2 className="modal-pick-title">
                  <span className="modal-pick-title-icon">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 348.882 348.882"
                    >
                      <path d="M333.988,11.758l-0.42-0.383C325.538,4.04,315.129,0,304.258,0c-12.187,0-23.888,5.159-32.104,14.153L116.803,184.231
      c-1.416,1.55-2.49,3.379-3.154,5.37l-18.267,54.762c-2.112,6.331-1.052,13.333,2.835,18.729c3.918,5.438,10.23,8.685,16.886,8.685
      c0,0,0.001,0,0.001,0c2.879,0,5.693-0.592,8.362-1.76l52.89-23.138c1.923-0.841,3.648-2.076,5.063-3.626L336.771,73.176
      C352.937,55.479,351.69,27.929,333.988,11.758z"/>
                      <path d="M303.85,138.388c-8.284,0-15,6.716-15,15v127.347c0,21.034-17.113,38.147-38.147,38.147H68.904
      c-21.035,0-38.147-17.113-38.147-38.147V100.413c0-21.034,17.113-38.147,38.147-38.147h131.587c8.284,0,15-6.716,15-15
      s-6.716-15-15-15H68.904c-37.577,0-68.147,30.571-68.147,68.147v180.321c0,37.576,30.571,68.147,68.147,68.147h181.798
      c37.576,0,68.147-30.571,68.147-68.147V153.388C318.85,145.104,312.134,138.388,303.85,138.388z"/>
                    </svg>
                  </span>

                  Modificar el pedido
                </h2>

                <div className="modal-pick-card">
                  <p><strong>Pedido:</strong> {selectedItem.name}</p>
                  <p><strong>Cliente:</strong> {selectedItem.erp_cliente}</p>

                  <div className="modal-pick-divider" />

                  <p className="modal-pick-row">
                    <span className="modal-pick-icon">
                      <svg viewBox="0 0 512 512">
                        <path d="M256,0c-74.439,0-135,60.561-135,135s60.561,135,135,135s135-60.561,135-135S330.439,0,256,0z"></path>
                        <path d="M423.966,358.195C387.006,320.667,338.009,300,286,300h-60c-52.008,0-101.006,20.667-137.966,58.195
      C51.255,395.539,31,444.833,31,497c0,8.284,6.716,15,15,15h420c8.284,0,15-6.716,15-15
      C481,444.833,460.745,395.539,423.966,358.195z"></path>
                      </svg>
                    </span>

                    <strong>Picker:</strong>{" "}
                    {selectedItem.picker_name || "Sin asignar"}
                  </p>
                  <p className="modal-pick-row">
                    <span className={
                      selectedItem.picker_active
                        ? "modal-pick-status-active"
                        : "modal-pick-status-inactive"
                    }>
                      <svg viewBox="0 0 507.2 507.2">
                        <circle cx="253.6" cy="253.6" r="253.6"></circle>
                        <path d="M188.8,368l130.4,130.4c108-28.8,188-127.2,188-244.8c0-2.4,0-4.8,0-7.2L404.8,152L188.8,368z"></path>
                        <path d="M260,310.4c11.2,11.2,11.2,30.4,0,41.6l-23.2,23.2c-11.2,11.2-30.4,11.2-41.6,0L93.6,272.8
      c-11.2-11.2-11.2-30.4,0-41.6l23.2-23.2c11.2-11.2,30.4-11.2,41.6,0L260,310.4z"></path>
                        <path d="M348.8,133.6c11.2-11.2,30.4-11.2,41.6,0l23.2,23.2c11.2,11.2,11.2,30.4,0,41.6l-176,175.2
      c-11.2,11.2-30.4,11.2-41.6,0l-23.2-23.2c-11.2-11.2-11.2-30.4,0-41.6L348.8,133.6z"></path>
                      </svg>
                    </span>

                    <strong>Picker Estado:</strong>{" "}
                    <span

                    >
                      {selectedItem.picker_active ? "Activo" : "Inactivo"}
                    </span>
                  </p>
                </div>

                <div className="modal-pick-section">
                  <h3 className="modal-pick-subtitle">Cambiar picker del pedido</h3>

                  <button
                    className="modal-pick-btn modal-pick-btn-blue"
                    onClick={() => setView("pickers")}
                  >
                    Elegir nuevo picker
                  </button>
                </div>

                <div className="modal-pick-section">
                  <h3 className="modal-pick-subtitle">Acciones</h3>

                  {!showConfirm && (
                    <button
                      className="modal-pick-btn modal-pick-btn-red"
                      onClick={() => setShowConfirm(true)}
                    >
                      Anular pedido
                    </button>
                  )}
                </div>

                <div className="modal-pick-section">
                  {showConfirm && (
                    <button
                      className="modal-pick-btn modal-pick-btn-yellow"
                      onClick={handleCancelPicking}
                    >
                      Confirmar anulación del pedido
                    </button>
                  )}
                </div>
              </>
            )}

            {/* ========================= */}
            {/* 🟩 VISTA 2: PICKERS */}
            {/* ========================= */}
            {view === "pickers" && (
              <>
                {/* HEADER */}
                <div className="modal-pick-header">
                  <h2>Elegir nuevo picker</h2>

                </div>

                <p className="modal-pick-subtitle-select">
                  Selecciona quién se encargará de este pedido
                </p>

                {/* LISTA */}
                <div className="modal-pick-card-select">
                  {pickers
                    .filter(p => p.picker_id !== selectedItem?.picker_id)
                    .map((p) => (
                      <div
                        key={p.picker_id}
                        className={`modal-pick-picker-row ${selectedPicker === p.picker_id ? "selected" : ""
                          }`}
                        onClick={() => setSelectedPicker(p.picker_id)}
                      >
                        {/* Avatar */}
                        <div className="modal-pick-avatar">👤</div>

                        {/* Info */}
                        <div className="modal-pick-info">
                          <span className="modal-pick-name">{p.full_name}</span>
                          <span className="modal-pick-status">
                            <span className="dot" /> Disponible
                          </span>
                        </div>

                        {/* Check */}
                        {selectedPicker === p.picker_id && (
                          <div className="modal-pick-check">✔</div>
                        )}
                      </div>
                    ))}
                </div>





                <button
                  className="modal-pick-save-btn modal-pick-btn-blue"
                  onClick={handleReassign}
                >
                  Guardar selección
                </button>
              </>
            )}

          </div>
        </div>
      )}
    </div>
  );
}