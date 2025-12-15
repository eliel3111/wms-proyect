import { useAuth } from "../context/AuthProvider.tsx";
import MenuButton from "../components/MenuButton.tsx";
import "../styles/MainMenu.css";
/*import { useState, useEffect } from "react";
import apiClient from "../services/apiClient.ts";*/


export default function Menu() {
  /*const { getToken, logout } = useAuth();
  const [result, setResult] = useState("");*/

  const { can } = useAuth();
    
/*useEffect(() => {
  console.log("CAN receive.view_po:", can("receive.view_po"));
  console.log("CAN receive.start_receiving:", can("receive.start_receiving"));
  console.log("CAN inventory.adjust_stock:", can("inventory.adjust_stock"));
}, []);*/


  /*async function hangleCerrar() {
    try {
      await logout();
    } catch (error) {
      console.error(error)
    }
  }*/

  /*async function handleCheckAuth() {
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
  }*/

  return (
    <div className="menu-page">
      <h1 className="menu-tittle">WMS Menu Principal</h1>

      <div className="menu-grid">
      {can("receive.view_po") && (
      <MenuButton
            title="Recepción"
            route="/receiving"
            icon={
              <svg
  viewBox="0 0 512 512"
  xmlns="http://www.w3.org/2000/svg"
>
  <polygon fill="#E2AE83" points="256,69.451 71.024,169.438 71.004,169.429 70.994,169.438 9.565,107.51 194.061,7.512" />
  <polygon fill="#D39C72" points="502.435,107.51 441.006,169.438 440.996,169.429 440.976,169.438 256,69.451 317.939,7.512" />
  <polygon fill="#F2C397" points="256,269.427 256,504.499 71.004,404.501 71.004,169.438" />
  <polygon fill="#E2AE83" points="440.996,169.438 440.996,404.501 256,504.499 256,269.427" />
  <polygon fill="#D39C72" points="410.994,185.653 410.994,420.719 440.996,404.501 440.996,169.438" />
  <polygon fill="#E2AE83" points="415.067,183.443 476.524,245.411 502.435,231.367 441.006,169.438 440.976,169.438" />
  <polygon fill="#FFD2A6" points="256,269.427 194.061,331.366 71.004,264.667 9.565,231.367 70.994,169.438 71.024,169.438" />
  <polygon fill="#C48D69" points="440.976,169.438 256,269.427 71.024,169.438 256,69.451" />
  <path
    fill="currentColor"
    d="M451.566,169.439l56.193-56.649c1.663-1.678,2.439-4.04 2.095-6.376
    c-0.345-2.337-1.77-4.375-3.846-5.5L321.512,0.916
    c-2.919-1.581-6.53-1.058-8.877,1.29l-56.639,56.639
    L199.361,2.21c-1.41-1.42-3.3-2.21-5.29-2.21z"
  />
</svg>

            }
          />
        )}

    </div>

    </div>
  );
}
