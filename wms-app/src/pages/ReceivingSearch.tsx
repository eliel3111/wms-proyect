import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/ReceivingSearch.css";
import { useEffect } from "react";
import { openReceptionDB } from "../services/indexeddb.ts";

export default function ReceivingSearch() {
  useEffect(() => {
    const initDB = async () => {
      try {
        const db = await openReceptionDB();
        console.log("DB lista para usarse:", db);
      } catch (error) {
        console.error("Error inicializando IndexedDB:", error);
      }
    };

    initDB();
  }, []);
  const navigate = useNavigate();

  

  return (
    <div className="receiving-search-page">
      <div className="receiving-title">Inicio de Recepción</div>
    </div>
  );
}
