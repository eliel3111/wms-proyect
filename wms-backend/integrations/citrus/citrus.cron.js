import cron from "node-cron";
import { syncAllItems } from "./citrus.sync.js";
import {syncAllPurchaseOrders} from "./citrus.sync.js"


let running = false;
let lastRunAt = null;

const MIN_INTERVAL = 10000; // 10 segundos

export function startCitrusCron() {
  console.log("🟢 Citrus cron started");

  cron.schedule("*/10 * * * * *", async () => {
    const now = Date.now();

    // 🚫 Evitar ejecuciones simultáneas o muy seguidas
    if (running || (lastRunAt && now - lastRunAt < MIN_INTERVAL)) {
      console.log("⏳ Skip: ejecución en progreso o muy reciente");
      return;
    }

    running = true;
    lastRunAt = now;

    console.log("⏱ Ejecutando Citrus Sync...");
    console.time("⏱ Tiempo total sync");

    // 🔹 Sync Items
    try {
      console.log("🔄 Sync Items...");
      await syncAllItems();
    } catch (err) {
      console.error("❌ Error en syncAllItems:", err.message);
    }

    // 🔹 Sync Purchase Orders
    try {
      console.log("🔄 Sync Purchase Orders...");
      await syncAllPurchaseOrders();
    } catch (err) {
      console.error("❌ Error en syncAllPurchaseOrders:", err.message);
    }

    console.timeEnd("⏱ Tiempo total sync");

    running = false;
  });
}
