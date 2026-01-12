import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/Putaway.css";

export default function PutawayPick() {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleScan(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;

    const code = e.currentTarget.value.trim();
    if (!code) return;

    console.log("📥 ORIGEN:", code);

    setOrigin(code);

    navigate("/putaway/drop", {
      state: { originLocation: code }
    });
  }

  return (
    <div className="page-putaway">
      <h2>Escanear origen</h2>
      <p>Escanee la ubicación donde está la mercancía</p>

      <input
        ref={inputRef}
        className="scan-input"
        placeholder="Escanear ubicación origen"
        onKeyDown={handleScan}
      />
    </div>
  );
}
