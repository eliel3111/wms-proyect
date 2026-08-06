import cron from "node-cron";

import {
  runPurchaseOrdersSync
} from "./purchaseOrders.runner.js";

let purchaseOrdersSyncRunning = false;

cron.schedule(
  "*/10 * * * * *",
  async () => {
    if (purchaseOrdersSyncRunning) {
      console.warn(
        "⚠️ La sincronización anterior todavía está ejecutándose."
      );

      return;
    }

    purchaseOrdersSyncRunning = true;

    try {
      console.log("");
      console.log(
        "⏰ Ejecutando cron de órdenes de compra"
      );

      await runPurchaseOrdersSync();
    } catch (error) {
      console.error(
        "🔥 Error en cron de órdenes de compra:",
        error
      );
    } finally {
      purchaseOrdersSyncRunning = false;
    }
  }
);

console.log(
  "✅ Cron de órdenes de compra registrado cada 10 minutos"
);