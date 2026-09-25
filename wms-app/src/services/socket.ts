// wms-app/src/services/socket.ts

import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.PROD
  ? window.location.origin
  : `http://${window.location.hostname}:3000`;

console.log("🔌 SOCKET URL:", SOCKET_URL);

const socket = io(SOCKET_URL, {
  withCredentials: true,
  transports: ["websocket"],
});

socket.on("connect", () => {
  console.log("🟢 SOCKET CONECTADO:", socket.id);
});

socket.on("connect_error", (err) => {
  console.error("🔴 SOCKET ERROR:", err);
});

export default socket;
