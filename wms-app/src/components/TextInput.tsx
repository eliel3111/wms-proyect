import { forwardRef } from "react";
import "../styles/TextInput.css";

interface TextInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;

  type?: "text" | "number" | "email" | "password";
  placeholder?: string;

  required?: boolean;
  error?: string;
  onFocus?: () => void;
  disabled?: boolean;
  name?: string;
}

const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  (
    {
      label,
      value,
      onChange,
      type = "text",
      placeholder,
      required = false,
      error,
      disabled = false,
      name,
      onFocus,
    },
    ref
  ) => {
    return (
      <div className="input-wrapper">
        <label className="input-label">
          {label}
          {required && <span className="required">*</span>}
        </label>

        <input
          ref={ref} // 🔥 AQUÍ ESTÁ LA CLAVE
          className={`input ${error ? "input-error" : ""}`}
          type={type}
          value={value}
          name={name}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={onFocus} // 🔥 MUY IMPORTANTE
          onChange={(e) => onChange(e.target.value)}
        />

        {error && <span className="input-error-text">{error}</span>}
      </div>
    );
  }
);

export default TextInput;
