//wms-app/src/services/socket.ts

import { io } from "socket.io-client";

const socket = io(import.meta.env.VITE_SOCKET_URL, {
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