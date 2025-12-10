import { useAuth } from "../context/AuthProvider";
import { useState } from "react";
import apiClient from "../services/apiClient.ts";

export default function Dashboard() {
  const { getToken, logout } = useAuth();
  const [result, setResult] = useState("");

  async function hangleCerrar() {
    try {
      await logout();
    } catch (error) {
      console.error(error)
    }
  }

  async function handleCheckAuth() {
    try {
      const token = await getToken();
      console.log("TOKEN ENVIADO:", token);
      let res = await apiClient.get("/auth/me");
      const data = res.data;
      setResult(JSON.stringify(data, null, 2));

    } catch (error) {
      console.error(error);
      setResult("Error al obtener el perfil.");
    }
  }

  return (
    <div>
      <h1>Dashboard privado</h1>
      <p>Solo puedes ver esto si estás logueado.</p>

      <button onClick={handleCheckAuth}>Verificar auth/me</button>

      <button onClick={hangleCerrar}>Cerrar Session</button>

      {result && (
        <pre style={{ background: "#eee", padding: "10px", marginTop: "10px" }}>
          {result}
        </pre>
      )}
    </div>
  );
}
