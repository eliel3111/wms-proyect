import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import "../styles/Putaway.css";

export default function PutawayDrop() {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const originLocation = location.state?.originLocation;

  useEffect(() => {
    if (!originLocation) {
      navigate("/putaway");
      return;
    }

    inputRef.current?.focus();
  }, []);

  function handleScan(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;

    const destination = e.currentTarget.value.trim();
    if (!destination) return;

    console.log("📦 ORIGEN:", originLocation);
    console.log("📍 DESTINO:", destination);

    // 👉 Aquí luego llamarás tu API de putaway

    alert(`Putaway confirmado:\n${originLocation} → ${destination}`);

    navigate("/menu");
  }

  return (
    <div className="page-putaway">
      <h2>Escanear destino</h2>
      <p>Escanee la ubicación final</p>

      <input
        ref={inputRef}
        className="scan-input"
        placeholder="Escanear ubicación destino"
        onKeyDown={handleScan}
      />
    </div>
  );
}
