// src/config/api.ts

const hostname = window.location.hostname;

console.log("NOMBRE DEL DOMINIO EN EL BROWSER",hostname);
//PRODUCCION SERVIDOR 
let API_URL = "http://localhost:3000/api";

/*if (hostname.includes("test")) {
  API_URL = "https://api-test.sidialwms.com/api";
} else {
  API_URL = "https://api.sidialwms.com/api";
}*/

export default API_URL;