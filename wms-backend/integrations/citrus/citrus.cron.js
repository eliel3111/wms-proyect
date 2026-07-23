import cron from "node-cron";
import { syncAllItems } from "./citrus.sync.js";
import {syncAllPurchaseOrders} from "./citrus.sync.js"
import { getActiveSaleOrders } from "./citrus.saleOrder.js"
import { fetchWarehousesTest, syncWarehouses } from "./citrus.wharehouse.js";




let running = false;
let lastRunAt = null;

const MIN_INTERVAL = 10000;


// ==========================================================
// INICIAR CRONES DE CITRUS
// ==========================================================

export function startCitrusCron() {
  console.log("🟢 Citrus cron started");

  /*
   * Se ejecuta cada minuto, en el segundo 15:
   *
   * 00:15
   * 01:15
   * 02:15
   */
  cron.schedule("15 * * * * *", async () => {
    const now = Date.now();

    if (
      running ||
      (
        lastRunAt &&
        now - lastRunAt < MIN_INTERVAL
      )
    ) {
      console.log(
        "⏳ Skip: ejecución en progreso o muy reciente"
      );

      return;
    }

    running = true;
    lastRunAt = now;

    console.log("================================");
    console.log("⏱ EJECUTANDO CITRUS SYNC");
    console.log(new Date().toISOString());
    console.log("================================");

    console.time("⏱ Tiempo total sync");

    try {
      // ====================================================
      // 1. ITEMS
      // ====================================================

      try {
        console.log("🔄 Sync Items...");

        await syncAllItems();

        console.log(
          "✅ Sync Items finalizado"
        );
      } catch (error) {
        console.error(
          "❌ Error en syncAllItems:",
          error.message
        );
      }

      // ====================================================
      // 2. PURCHASE ORDERS
      // ====================================================

      try {
        console.log(
          "🔄 Sync Purchase Orders..."
        );

        await syncAllPurchaseOrders();

        console.log(
          "✅ Sync Purchase Orders finalizado"
        );
      } catch (error) {
        console.error(
          "❌ Error en syncAllPurchaseOrders:",
          error.message
        );
      }

      // ====================================================
      // 3. WAREHOUSES
      // ====================================================

      try {
        console.log(
          "🔄 Sync Warehouses..."
        );

        await runWarehouseSync();

        console.log(
          "✅ Sync Warehouses finalizado"
        );
      } catch (error) {
        console.error(
          "❌ Error en Warehouses:",
          error.message
        );
      }
    } catch (error) {
      console.error(
        "❌ Error general en Citrus Sync:",
        error
      );
    } finally {
      /*
       * Muy importante:
       *
       * running debe volver a false aunque ocurra
       * cualquier error inesperado.
       */
      running = false;

      console.timeEnd(
        "⏱ Tiempo total sync"
      );

      console.log(
        "🏁 Citrus Sync finalizado"
      );
    }
  });


  // ========================================================
  // SALES ORDERS
  // Cada minuto en el segundo 30
  // ========================================================

  cron.schedule("30 * * * * *", async () => {
    console.log("================================");
    console.log("⏰ CRON SALES ORDERS");
    console.log(new Date().toISOString());
    console.log("================================");

    try {
      await getActiveSaleOrders();

      console.log(
        "✅ SALES ORDERS FINALIZADO"
      );
    } catch (error) {
      console.error(
        "❌ ERROR SALES ORDERS:"
      );

      console.error(error);
    }
  });
}


// ==========================================================
// EJECUTAR SINCRONIZACIÓN DE ALMACENES
// ==========================================================

export async function runWarehouseSync() {
  try {
    console.log(
      "📡 BUSCANDO ALMACENES EN CITRUS..."
    );

    const citrusWarehouses =
      await fetchWarehousesTest();

    if (!Array.isArray(citrusWarehouses)) {
      throw new Error(
        "fetchWarehousesTest no devolvió un arreglo"
      );
    }

    console.log(
      "📦 Total almacenes encontrados:",
      citrusWarehouses.length
    );

    console.log(
      "📦 ALMACENES ENCONTRADOS:",
      citrusWarehouses
    );

    /*
     * No enviar clientDb.
     * syncWarehouses crea y libera su propia conexión.
     */
    const result =
      await syncWarehouses(
        citrusWarehouses
      );

    console.log(
      "✅ RESULTADO SINCRONIZACIÓN:",
      result.summary
    );

    return result;

  } catch (error) {
    console.error(
      "❌ ERROR EN SINCRONIZACIÓN DE ALMACENES:"
    );

    console.error(
      error.message
    );

    throw error;
  }
}