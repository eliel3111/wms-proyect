import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),

    VitePWA({
      registerType: "autoUpdate",

      devOptions: {
        enabled: true,
      },

      manifest: {
        id: "wms-local",
        name: "WMS Receiving LOCAL",
        short_name: "WMS",
        description: "Sistema de Recepción de Inventario",

        start_url: "/login",              // 🔥 obligatorio para install real
        scope: "/",
        display: "standalone",
        display_override: ["standalone", "fullscreen"],
        orientation: "portrait",
        prefer_related_applications: false,

        theme_color: "#1976d2",
        background_color: "#ffffff",

        icons: [
          {
            src: "/icons/icon-192.png?v=5",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable"
          },
          {
            src: "/icons/icon-512.png?v=5",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable"
          }
        ],

        // 🔥 ESTO FUERZA WEBAPK REAL EN ANDROID/PDA
        screenshots: [
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            form_factor: "wide"
          }
        ]
      },
    }),
  ],

  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://192.168.1.43:3000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});

//target: "http://192.168.1.43:3000",
//target: "https://wms-proyect.onrender.com",