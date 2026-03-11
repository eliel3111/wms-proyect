import cron from "node-cron";
import { getActivePurchaseOrders, getPurchaseOrderLinesByOrderId, processPurchaseOrderLines, upsertPurchaseOrderLines } from "../integrations/odoo/odoo.purchase.service.js";
import { getActiveProducts } from "../integrations/odoo/odoo.products.service.js";
import { syncWarehousesFull } from "../integrations/odoo/odoo.warehouse.sync.js";


// ===============================================
// 🔥 FULL SYNC EN ORDEN CONTROLADO
// ===============================================

export async function runFullSync() {

  console.log("🚀 FULL SYNC START");

  try {

    console.log("1️⃣ Sync Warehouses");
    await syncWarehousesFull();

    console.log("2️⃣ Sync Products");
    await getActiveProducts();

    console.log("3️⃣ Sync Purchase Orders");

    const orders = await getActivePurchaseOrders();

    for (const order of orders) {
      const orderLines = await getPurchaseOrderLinesByOrderId(order.id);
      const processedLines = await processPurchaseOrderLines(orderLines);
      await upsertPurchaseOrderLines(processedLines);
    }

    console.log("✅ FULL SYNC DONE");

  } catch (error) {

    console.error("❌ FULL SYNC FAILED:", error);

  }
}



export function startMainCron() {

  // Cada 10 minutos
  cron.schedule("*/10 * * * *", async () => {

    console.log("⏰ Ejecutando MAIN CRON");

    await runFullSync();

  });

  console.log("✅ Main cron started (cada 10 minutos)");
}








export function startCronJobs() {

  cron.schedule("*/10 * * * * *", async () => {

    try {

      console.log("[CRON] Sync PURCHASE ORDER start");

      const orders = await getActivePurchaseOrders();

      for (const order of orders) {

        const orderLines = await getPurchaseOrderLinesByOrderId(order.id);
      
        const processedLines = await processPurchaseOrderLines(orderLines);

        await upsertPurchaseOrderLines(processedLines);

        // 🔥 aquí luego haces tu UPSERT masivo
      }

      console.log("[CRON] Sync PURCHASE ORDER done, Count:", orders.length);

    } catch (err) {

      console.error("[CRON] Sync PURCHASE ORDER failed:", err);

    }

  });

  console.log("✅ Cron jobs started");
}

export function productsCronJobs() {
  // Cada 15 minutos
  cron.schedule("*/10 * * * * *", async () => {
    try {
      console.log("[CRON] Sync products start");
      await getActiveProducts();
      console.log("[CRON] Sync products done");
    } catch (err) {
      console.error("[CRON] Sync products failed:", err);
    }
  });

  console.log("✅ Cron jobs started");
}



// ✅ Warehouse sync fully operational
export function startWarehouseCron() {

  cron.schedule("*/10 * * * * *", async () => {
    try {
      console.log("⏰ Ejecutando cron warehouses");

      await syncWarehousesFull();

    } catch (error) {
      console.error("❌ Error cron warehouses:", error);
    }
  });

}