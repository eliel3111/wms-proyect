//src/components/MultiValueSearchInput.tsx
import { useState, type KeyboardEvent, type CSSProperties } from "react";
import "../styles/MultiValueSearchInput.css";

type MultiValueSearchInputProps = {
  values: string[];
  onChange: (values: string[]) => void;

  onSearch?: (values: string[]) => void;

  width?: string | number;
  placeholder?: string;
    autoFocus?: boolean;
  disabled?: boolean;
};

export function MultiValueSearchInput({
  values,
  onChange,
  onSearch,
  width = "400px",
  placeholder = "Buscar...",
  disabled = false,
  autoFocus = false,
}: MultiValueSearchInputProps) {

  // Texto que el usuario está escribiendo actualmente
  const [inputValue, setInputValue] = useState("");

  const addValue = () => {
    const cleanValue = inputValue.trim();

    // Si está vacío, simplemente buscar los valores actuales
    if (!cleanValue) {
      onSearch?.(values);
      return;
    }

    // Evitar valores duplicados
    const alreadyExists = values.some(
      (value) => value.toLowerCase() === cleanValue.toLowerCase()
    );

    if (alreadyExists) {
      setInputValue("");
      onSearch?.(values);
      return;
    }

    const newValues = [...values, cleanValue];

    // Actualiza array del componente padre
    onChange(newValues);

    // Limpia input
    setInputValue("");

    // Ejecuta búsqueda
    onSearch?.(newValues);
  };

  const removeValue = (valueToRemove: string) => {
    const newValues = values.filter(
      (value) => value !== valueToRemove
    );

    // Actualiza array del padre
    onChange(newValues);

    // Vuelve a buscar con los valores restantes
    onSearch?.(newValues);
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLInputElement>
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addValue();
    }

    // OPCIONAL:
    // Si el input está vacío y presionas Backspace,
    // elimina el último valor.
    if (
      event.key === "Backspace" &&
      inputValue === "" &&
      values.length > 0
    ) {
      const newValues = values.slice(0, -1);

      onChange(newValues);
      onSearch?.(newValues);
    }
  };

  const containerStyle: CSSProperties = {
    width:
      typeof width === "number"
        ? `${width}px`
        : width,
  };

  return (
    <div
      className={`multi-search ${
        disabled ? "multi-search-disabled" : ""
      }`}
      style={containerStyle}
    >
      {/* BOTÓN BUSCAR */}
      <button
        type="button"
        className="multi-search-button"
        onClick={addValue}
        disabled={disabled}
        aria-label="Buscar"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            d="M21 21l-4.35-4.35m1.35-5.65a7 7 0 1 1-14 0
               7 7 0 0 1 14 0z"
          />
        </svg>
      </button>

      {/* ÁREA DE VALORES + INPUT */}
      <div className="multi-search-content">

        {values.map((value) => (
          <div
            key={value}
            className="multi-search-chip"
          >
            <span className="multi-search-chip-text">
              {value}
            </span>

            <button
              type="button"
              className="multi-search-chip-remove"
              onClick={(event) => {
                event.stopPropagation();
                removeValue(value);
              }}
              aria-label={`Eliminar ${value}`}
              disabled={disabled}
            >
              ×
            </button>
          </div>
        ))}

        <input
  type="text"
  value={inputValue}
  onChange={(event) =>
    setInputValue(event.target.value)
  }
  onKeyDown={handleKeyDown}
  placeholder={
    values.length === 0
      ? placeholder
      : ""
  }
  disabled={disabled}
  autoFocus={autoFocus} // 👈 AQUÍ
  className="multi-search-input"
/>

      </div>
    </div>
  );
}