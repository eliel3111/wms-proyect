import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,        // ← IMPORTANTE para PDA/móvil
    port: 5173,        // ← puedes poner otro si quieres
    proxy: {
      "/api": {
        target: "http://192.168.1.43:3000", // ← OJO: cambiar a tu IP local
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
