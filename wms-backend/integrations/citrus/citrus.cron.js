import cron from "node-cron";
import { syncAllItems } from "./citrus.sync.js";

let running = false; // evita doble ejecución

export function startCitrusCron() {
  console.log("🟢 Citrus cron started (cada 30s)");

  cron.schedule("*/10 * * * * *", async () => {
    if (running) {
      console.log("⏳ Sync ya corriendo... skip");
      return;
    }

    try {
      running = true;

      console.log("⏱ Ejecutando Citrus Sync...");
      console.time("⏱ Tiempo total sync");   // 👈 inicia timer
      await syncAllItems();
      //await testSpeed();
      console.timeEnd("⏱ Tiempo total sync"); // 👈 muestra tiempo
    } catch (error) {
      console.error("🔴 Citrus cron error:", error.message);
    } finally {
      running = false;
    }
  });
}
