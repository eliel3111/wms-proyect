import { useState } from "react"

interface Props {
  pickerId: number
}

export default function PickerDelete({ pickerId }: Props) {

  const [open, setOpen] = useState(false)

  const handleDelete = () => {
    console.log("Eliminar picker:", pickerId)
    setOpen(false)
  }

  return (
    <>
      <div
        className="picker-delete"
        onClick={() => setOpen(true)}
      >
        <svg
          className="delete-icon"
          viewBox="0 0 24 24"
        >
          <path
            d="M3 6h18M9 6V4h6v2M8 6v14h8V6"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
          />
        </svg>
      </div>

      {open && (
        <div className="modal-overlay">

          <div className="delete-modal">

            <h3>Eliminar Picker</h3>

            <p>¿Seguro que deseas eliminar este picker?</p>

            <div className="modal-buttons">

              <button
                onClick={() => setOpen(false)}
                className="btn-cancel"
              >
                Cancelar
              </button>

              <button
                onClick={handleDelete}
                className="btn-delete"
              >
                Eliminar
              </button>

            </div>

          </div>

        </div>
      )}
    </>
  )
}