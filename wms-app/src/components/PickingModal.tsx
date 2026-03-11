import { useState } from "react"
import { LoadingScreen } from "../components/LoadingScreen.tsx";

interface User {
    id: number
    full_name: string
}

interface Props {
  users: User[]
  isLoading: boolean
  onClose: () => void
  onSave: (data: { users: number[] }) => void
}

export default function PickerModal({ users, onClose, onSave }: Props) {

    const [selectedUsers, setSelectedUsers] = useState<number[]>([])

    const toggleUser = (id: number) => {
        setSelectedUsers((prev) =>
            prev.includes(id)
                ? prev.filter((u) => u !== id)
                : [...prev, id]
        )
    }

    const handleSave = () => {
        const payload = {
            users: selectedUsers
        }

        console.log(payload)

        onSave(payload)
    }

    const isLoading = users.length === 0;

    return (
        <div className="modalOverlay">

            <div className="modalCard">

                <h2 className="modalTitle">
                    Selecciona un nuevo Picker
                </h2>

                <div className="usersList">

                    {isLoading ? (
                        <LoadingScreen />
                    ) : (
                        users.map((user) => (

                            <div
                                key={user.id}
                                className="userRow"
                                onClick={() => toggleUser(user.id)}
                            >

                                <input
                                    className="user-checkbox"
                                    type="checkbox"
                                    checked={selectedUsers.includes(user.id)}
                                    readOnly
                                />

                                <div className="avatar">
                                {<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" id="fi_1144709"><path d="m512 256c0 74.921875-32.191406 142.328125-83.488281 189.148438-45.511719 41.523437-106.050781 66.851562-172.511719 66.851562s-127-25.328125-172.511719-66.851562c-51.296875-46.820313-83.488281-114.226563-83.488281-189.148438 0-141.378906 114.621094-256 256-256s256 114.621094 256 256zm0 0" fill="#ffaa20"></path><path d="m512 256c0 74.921875-32.191406 142.328125-83.488281 189.148438-45.511719 41.523437-106.050781 66.851562-172.511719 66.851562v-512c141.378906 0 256 114.621094 256 256zm0 0" fill="#ff8900"></path><path d="m428.511719 444.128906v1.019532c-45.511719 41.523437-106.050781 66.851562-172.511719 66.851562s-127-25.328125-172.511719-66.851562v-1.019532c0-74.160156 47.042969-137.550781 112.863281-161.867187 18.589844-6.882813 38.6875-10.640625 59.648438-10.640625s41.058594 3.757812 59.660156 10.640625c65.820313 24.328125 112.851563 87.707031 112.851563 161.867187zm0 0" fill="#7985eb"></path><path d="m428.511719 444.128906v1.019532c-45.511719 41.523437-106.050781 66.851562-172.511719 66.851562v-240.378906c20.960938 0 41.058594 3.757812 59.660156 10.640625 65.820313 24.328125 112.851563 87.707031 112.851563 161.867187zm0 0" fill="#4b5be6"></path><path d="m361.808594 194.921875c0 58.339844-47.457032 105.8125-105.808594 105.8125-58.339844 0-105.808594-47.472656-105.808594-105.8125s47.46875-105.808594 105.808594-105.808594c58.351562 0 105.808594 47.46875 105.808594 105.808594zm0 0" fill="#ffdba9"></path><path d="m361.808594 194.921875c0 58.339844-47.457032 105.8125-105.808594 105.8125v-211.621094c58.351562 0 105.808594 47.46875 105.808594 105.808594zm0 0" fill="#ffc473"></path></svg>}
                            </div>

                                <span className="userName">
                                    {user.full_name}
                                </span>

                            </div>

                        ))
                    )}

                </div>

                <div className="modalButtons">

                    <button
                        className="btnSave"
                        onClick={handleSave}
                    >
                        Guardar
                    </button>

                    <button
                        className="btnCancel"
                        onClick={onClose}
                    >
                        Cancelar
                    </button>

                </div>

            </div>

        </div>
    )
}