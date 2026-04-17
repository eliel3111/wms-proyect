// src/config/api.ts

const hostname = window.location.hostname;

console.log("NOMBRE DEL DOMINIO EN EL BROWSER",hostname);

let API_URL = "";

if (hostname.includes("test")) {
  API_URL = "https://api-test.sidialwms.com/api";
} else {
  API_URL = "https://api.sidialwms.com/api";
}

export default API_URL;