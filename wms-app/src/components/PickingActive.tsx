
import "../styles/picking.css"
import { useState, useEffect } from "react";
import PickerModal from "./PickingModal";
import apiClient from "../services/apiClient";
import { useModal } from "../context/ModalContext";
import { LoadingScreen } from "../components/LoadingScreen.tsx";

interface Picker {
    id: number
    user_id: number
    full_name: string
    active_today: boolean
}
export default function PickingActive() {

    const { openModal } = useModal();
    const [pickers, setPickers] = useState<Picker[]>([])
    const [loadingPickers, setLoadingPickers] = useState(false)
    const [open, setOpen] = useState(false);
    const [users, setUsers] = useState<{ id: number; full_name: string }[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(false);
    const [deleteModal, setDeleteModal] = useState<{
        open: boolean
        pickerId: number | null
    }>({
        open: false,
        pickerId: null
    })


    useEffect(() => {

        fetchPickers()

    }, [])
    //Funcion para buscar todos los pickers
    const fetchPickers = async () => {

        try {

            setLoadingPickers(true)

            const res = await apiClient.get("/picking/all-pickers")

            if (!res.data.success) {

                openModal({
                    title: res.data.title || "Aviso",
                    message: res.data.message || "No se pudo obtener la información",
                })

                return
            }

            console.log("PICKERS:", res.data.data)

            setPickers(res.data.data);

        } catch (error) {

            console.error("Error fetching pickers", error)

            openModal({
                title: "Error de conexión",
                message: "No se pudo conectar con el servidor",
            })

        } finally {

            setLoadingPickers(false)

        }
    }

    //Buscar todos los usuarios activos para ser picker cuando open cambie
    useEffect(() => {
        if (!open) return;
        fetchUsers();

    }, [open]);

    const fetchUsers = async () => {
        try {

            setLoadingUsers(true);

            const res = await apiClient.get("/picking/available-users");

            if (!res.data.success) {

                setOpen(false);

                openModal({
                    title: res.data.title || "Aviso",
                    message: res.data.message || "No se pudo obtener la información",
                });

                return;
            }

            console.log("USUARIOS ACTIVOS:", res.data.data);

            setUsers(res.data.data);

        } catch (error) {

            console.error("Error fetching users", error);

        } finally {

            setLoadingUsers(false);

        }
    };

    const handlePickerChange = async (id: number, value: boolean) => {

        console.log("PICKER ID:", id, "VALUE:", value);

        try {

            const res = await apiClient.post("/picking/active-today", {
                pickerId: id,
                value: value
            });

            const data = res.data;

            if (!data.success) {

                openModal({
                    title: data.title || "Aviso",
                    message: data.message || "No se pudo obtener la información",
                });

                return;
            }

            setPickers((prev) =>
                prev.map((picker) =>
                    picker.id === id
                        ? { ...picker, active_today: value }
                        : picker
                )
            );

            await fetchPickers();

        } catch (error) {

            console.error("Error updating picker:", error);

            openModal({
                title: "Error",
                message: "Error de conexión con el servidor",
            });

        }

    };

    //Fuction to save pickers after modal closed
    const savePickers = async (data: { users: number[] }) => {

        try {

            const res = await apiClient.post("/picking/add-pickers", data);

            if (!res.data.success) {

                openModal({
                    title: res.data.title || "Aviso",
                    message: res.data.message || "No se pudo obtener la información",
                });

                return;
            }

            console.log("Pickers agregados correctamente", res.data);

        } catch (error) {

            openModal({
                title: "Error de conexión",
                message: "No se pudo conectar con el servidor",
            });

        }
    };


    //Funcion para eliminar un picker
    const removePicker = async () => {

        if (!deleteModal.pickerId) return;

        try {

            const res = await apiClient.post("/picking/remove-picker", {
                picker_id: deleteModal.pickerId
            });

            if (!res.data.success) {

                openModal({
                    title: res.data.title || "Aviso",
                    message: res.data.message || "No se pudo eliminar el picker"
                });

                return;
            }

            console.log("Picker eliminado:", deleteModal.pickerId);

            setDeleteModal({ open: false, pickerId: null });

            fetchPickers();

        } catch (error) {

            openModal({
                title: "Error",
                message: "Error al conectar con el servidor"
            });

        }

    };

    if (loadingPickers) {
        return <LoadingScreen />;
    }

    return (

        <div className="mainInner">
            <div className="monitor-header">

                <div>
                    <div className="monitor-title-small">
                        Pantalla Monitor
                    </div>

                    <div className="monitor-title-big">
                        Administrador de Pickers
                    </div>
                </div>

                <div className="add-picker" onClick={() => setOpen(true)}>

                    <svg className="add-picker-icon" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" id="fi_7887065"><g id="ESSENTIAL_UI" data-name="ESSENTIAL UI"><path d="m262.67 489.87c-38.08.94-112.9-5-137.35-10.79-16.67-3.51-32.34-13.21-44.14-26.71s-19.26-30.19-21-47.06l-.06-.52a271.5 271.5 0 0 1 -1.12-37.91s-.94-11.17 1.18-31.42c0-.17 0-.35 0-.52a73 73 0 0 1 21.08-43.94 74.29 74.29 0 0 1 44.28-21.32c24.53-2.59 99.17-4 137.11-4s98.82 1.41 123.35 4a74.31 74.31 0 0 1 44.28 21.32 72.93 72.93 0 0 1 21.07 44v.51c2.12 20.26 1.84 31.37 1.84 31.38a360.41 360.41 0 0 1 -1.83 38c0 .17 0 .34-.05.51-1.74 16.87-9.19 33.54-21 47.07s-27.48 23.19-44.15 26.7c-24.41 5.5-85.42 10.96-123.49 10.7z" fill="#4193d2"></path><path d="m374.61 268.72c-28.72-2-79-3.05-112-3.05-37.94 0-112.58 1.42-137.11 4a74.29 74.29 0 0 0 -44.24 21.33 73 73 0 0 0 -21.07 43.94v.52c-2.19 20.25-1.19 31.41-1.19 31.42a271.5 271.5 0 0 0 1.17 37.91l.06.52a81.9 81.9 0 0 0 7.87 27.26 268 268 0 0 0 57.9 6.31c113.19 0 209.93-70.59 248.61-170.16z" fill="#48a4df"></path><circle cx="253.53" cy="118.59" fill="#edab7e" r="118.59"></circle><path d="m410.08 308.16a101.92 101.92 0 1 0 101.92 101.92 101.92 101.92 0 0 0 -101.92-101.92z" fill="#f9973e"></path><path d="m454 429.08h-24.92v24.92a19 19 0 0 1 -38 0v-24.92h-24.87a19 19 0 0 1 0-38h24.87v-24.88a19 19 0 0 1 38 0v24.88h24.92a19 19 0 0 1 0 38z" fill="#fff"></path></g></svg>

                    <span>Agregar Picker</span>

                </div>

            </div>

            <div className="pickersactivecontainer">

                {pickers.map((picker) => (

                    <div className="pickerperson" key={picker.id}>

                        <div className="personalinformation">

                            <div className="avatar">
                                {<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" id="fi_1144709"><path d="m512 256c0 74.921875-32.191406 142.328125-83.488281 189.148438-45.511719 41.523437-106.050781 66.851562-172.511719 66.851562s-127-25.328125-172.511719-66.851562c-51.296875-46.820313-83.488281-114.226563-83.488281-189.148438 0-141.378906 114.621094-256 256-256s256 114.621094 256 256zm0 0" fill="#ffaa20"></path><path d="m512 256c0 74.921875-32.191406 142.328125-83.488281 189.148438-45.511719 41.523437-106.050781 66.851562-172.511719 66.851562v-512c141.378906 0 256 114.621094 256 256zm0 0" fill="#ff8900"></path><path d="m428.511719 444.128906v1.019532c-45.511719 41.523437-106.050781 66.851562-172.511719 66.851562s-127-25.328125-172.511719-66.851562v-1.019532c0-74.160156 47.042969-137.550781 112.863281-161.867187 18.589844-6.882813 38.6875-10.640625 59.648438-10.640625s41.058594 3.757812 59.660156 10.640625c65.820313 24.328125 112.851563 87.707031 112.851563 161.867187zm0 0" fill="#7985eb"></path><path d="m428.511719 444.128906v1.019532c-45.511719 41.523437-106.050781 66.851562-172.511719 66.851562v-240.378906c20.960938 0 41.058594 3.757812 59.660156 10.640625 65.820313 24.328125 112.851563 87.707031 112.851563 161.867187zm0 0" fill="#4b5be6"></path><path d="m361.808594 194.921875c0 58.339844-47.457032 105.8125-105.808594 105.8125-58.339844 0-105.808594-47.472656-105.808594-105.8125s47.46875-105.808594 105.808594-105.808594c58.351562 0 105.808594 47.46875 105.808594 105.808594zm0 0" fill="#ffdba9"></path><path d="m361.808594 194.921875c0 58.339844-47.457032 105.8125-105.808594 105.8125v-211.621094c58.351562 0 105.808594 47.46875 105.808594 105.808594zm0 0" fill="#ffc473"></path></svg>}
                            </div>

                            <span className="pickername">
                                {picker.full_name}
                            </span>

                        </div>

                        <div className="pickerstatus">

                            <label className="switch">
                                <input
                                    type="checkbox"
                                    checked={picker.active_today}
                                    onChange={(e) =>
                                        handlePickerChange(picker.id, e.target.checked)
                                    }
                                />
                                <span className="slider"></span>
                            </label>

                            <span className="picker-divider">|</span>

                            <div
                                className="picker-delete"
                                onClick={() =>
                                    setDeleteModal({
                                        open: true,
                                        pickerId: picker.id
                                    })
                                }

                            >
                                {/* tu SVG aquí */}
                                <svg
                                    className="delete-icon"
                                    viewBox="0 0 24 24"
                                >
                                    <path d="M3 6h18M9 6V4h6v2M8 6v14h8V6" stroke="currentColor" strokeWidth="2" fill="none" />
                                </svg>
                            </div>

                        </div>

                    </div>

                ))}

            </div>


            {open && (
                <PickerModal
                    users={users}
                    isLoading={loadingUsers}
                    onClose={() => setOpen(false)}
                    onSave={(data) => {
                        savePickers(data);
                        setOpen(false);
                        fetchPickers(); // refresca lista
                    }}
                />
            )}



            {deleteModal.open && (
                <div className="modal-overlay">

                    <div className="confirm-modal">

                        <h3>Eliminar Picker</h3>

                        <p>¿Estás seguro que deseas eliminar este picker?</p>

                        <div className="modal-buttons">

                            <button
                                className="btn-cancel"
                                onClick={() =>
                                    setDeleteModal({ open: false, pickerId: null })
                                }
                            >
                                Cancelar
                            </button>

                            <button
                                className="btn-delete"
                                onClick={removePicker}
                            >
                                Eliminar
                            </button>

                        </div>

                    </div>

                </div>
            )}
        </div>
    );
}