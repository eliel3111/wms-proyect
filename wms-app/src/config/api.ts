// src/config/api.ts

let API_URL: string;

if (import.meta.env.PROD) {
  // PRODUCCIÓN
  // Nginx recibe /api y lo envía internamente a Node :3000
  API_URL = "/api";
} else {
  // DESARROLLO
  // Funciona tanto con localhost como accediendo desde otro equipo de la red
  API_URL = `http://${window.location.hostname}:3000/api`;
}

console.log("🌐 API URL:", API_URL);

export default API_URL;
