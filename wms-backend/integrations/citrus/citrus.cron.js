import cron from "node-cron";
import { syncAllItems } from "./citrus.sync.js";
import {syncAllPurchaseOrders} from "./citrus.sync.js"
import { getActiveSaleOrders } from "./citrus.saleOrder.js"


let running = false;
let lastRunAt = null;

const MIN_INTERVAL = 10000; // 10 segundos

export function startCitrusCron() {
  console.log("🟢 Citrus cron started");

  // =================================
  // CITRUS SYNC
  // Cada 3 minutos en segundo 0
  // 00:00, 03:00, 06:00...
  // =================================
  cron.schedule("0 */1 * * * *", async () => {
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


   // =================================
  // SALE ORDERS
  // Cada minuto en segundo 30
  // 00:30, 01:30, 02:30...
  // =================================
  cron.schedule("30 * * * * *", async () => {

  console.log("================================");
  console.log("⏰ CRON PURCHASE ORDERS");
  console.log(new Date().toISOString());
  console.log("================================");

  try {

    await getActiveSaleOrders();

    console.log("✅ SALES ORDERS FINALIZADO");

  } catch (error) {

    console.error("❌ ERROR SALES ORDERS");
    console.error(error);

  }

});
}
