import Select from "react-select";
import "../styles/SelectInput.css"

export interface SelectOption {
  value: number;
  label: string;
}

interface SelectInputProps {
  label: string;
  options: SelectOption[];
  value: SelectOption | null;
  onChange: (option: SelectOption | null) => void;
  required?: boolean;
  placeholder?: string;
  isDisabled?: boolean;
  isClearable?: boolean;
  error?: string;
  onFocus?: () => void; // ✅ NUEVO
}

const SelectInput = ({
  label,
  options,
  value,
  onChange,
  required = false,
  placeholder,
  isDisabled = false,
  isClearable = true,
  error,
  onFocus,
}: SelectInputProps) => {
  return (
    <div className="input-wrapper">
      <label className="input-label">
        {label}
        {required && <span className="required">*</span>}
      </label>

      <Select
        options={options}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        isDisabled={isDisabled}
        isClearable={isClearable}
        classNamePrefix="rs"
        onMenuOpen={() => {
          onFocus?.(); // 👈 fuerza scroll
        }}

        filterOption={(option, inputValue) => {
          if (!inputValue) return true;

          return option.label
            .toLowerCase()
            .includes(inputValue.toLowerCase());
        }}
        styles={{
          control: (base) => ({
            ...base,
            borderColor: error ? "#e53935" : base.borderColor,
            boxShadow: error ? "0 0 0 1px #e53935" : base.boxShadow,
            "&:hover": {
              borderColor: error ? "#e53935" : base.borderColor,
            },
          }),
        }}
      />

      {error && <span className="input-error-text">{error}</span>}
    </div>
  );
};

export default SelectInput;
