// ============================================================
// FILE: integrations/admcloud/admcloud.cron.js
// ============================================================

import cron from "node-cron";

import {
  getAdmCloudProducts
} from "./admcloud.items.js";

import {
  syncAdmCloudProducts
} from "./admcloud.products.processor.js";

import {
  syncAdmCloudWarehouses
} from "./admcloud.locations.js";

import {
  syncAdmCloudUoms
} from "./admcloud.uom.service.js";

import {
  runAdmCloudPurchaseOrdersSync
} from "./admcloud.purchaseOrders.js";
import {
  runAdmCloudSalesOrdersSync
} from "./admcloud.salesOrders.js";


// ============================================================
// SINCRONIZACIÓN GENERAL ADM CLOUD
// ============================================================

export async function syncAdmCloud() {

  console.log("");
  console.log("🔄 ========================================");
  console.log("🔄 INICIANDO SYNC GENERAL ADM CLOUD");
  console.log("🕒", new Date().toISOString());
  console.log("🔄 ========================================");



  // ==========================================================
  // 1. UOM
  // ==========================================================

  console.log("");
  console.log("📏 SINCRONIZANDO UOM...");

  const uomResult =
    await syncAdmCloudUoms();

  console.log(
    "✅ UOM sincronizados:",
    uomResult
  );



  // ==========================================================
  // 2. WAREHOUSES / LOCATIONS
  // ==========================================================

  console.log("");
  console.log("🏭 SINCRONIZANDO WAREHOUSES...");

  const warehouseResult =
    await syncAdmCloudWarehouses();

  console.log(
    "✅ Warehouses sincronizados:",
    warehouseResult
  );



  // ==========================================================
  // 3. PRODUCTS
  // ==========================================================

  console.log("");
  console.log("📦 SINCRONIZANDO PRODUCTOS...");

  const products =
    await getAdmCloudProducts();

  const productResult =
    await syncAdmCloudProducts(
      products
    );

  console.log(
    `✅ Productos sincronizados: ${products.length}`
  );



  // ==========================================================
  // 4. PURCHASE ORDERS
  // ==========================================================

  console.log("");
  console.log(
    "🧾 SINCRONIZANDO PURCHASE ORDERS..."
  );

  const purchaseOrderResult =
    await runAdmCloudPurchaseOrdersSync();

  console.log(
    "✅ Purchase Orders sincronizadas:",
    purchaseOrderResult
  );



  // ==========================================================
  // FINAL
  // ==========================================================

  console.log("");
  console.log("✅ ========================================");
  console.log("✅ SYNC GENERAL ADM CLOUD COMPLETADO");
  console.log("✅ ========================================");


  return {

    uom:
      uomResult,

    warehouses:
      warehouseResult,

    products: {
      total: products.length,
      result: productResult
    },

    purchaseOrders:
      purchaseOrderResult

  };
}



// ============================================================
// CONTROL PARA EVITAR EJECUCIONES DUPLICADAS
// ============================================================

let isSyncRunning = false;



// ============================================================
// ADM CLOUD CRON
// CADA 15 SEGUNDOS
// ============================================================

export function startAdmCloudCron() {

  console.log(
    "⏰ Adm Cloud cron iniciado - cada 2 min"
  );


  cron.schedule(
  "*/2 * * * *",
  async () => {

      // ======================================================
      // EVITAR DOS SYNC AL MISMO TIEMPO
      // ======================================================

      if (isSyncRunning) {

        console.log(
          "⏭️ Adm Cloud sync omitido: ya hay uno ejecutándose"
        );

        return;
      }


      isSyncRunning = true;


      try {

        console.log("");
        console.log(
          "⏰ Ejecutando sincronización automática Adm Cloud..."
        );


        const result =
          await syncAdmCloud();


        console.log("");
        console.log(
          "✅ Cron Adm Cloud terminado correctamente"
        );

        console.log(
          "📊 Resultado general:",
          result
        );


      } catch (error) {

        console.error("");
        console.error(
          "❌ Error en cron Adm Cloud:",
          error
        );


      } finally {

        // ====================================================
        // SIEMPRE LIBERAR EL LOCK
        // ====================================================

        isSyncRunning = false;

      }

    }
  );



// ============================================================
// CRON - SALES ORDERS ADM CLOUD
// CADA 30 SEGUNDOS
// ============================================================

let salesOrdersSyncRunning = false;

cron.schedule(
  "*/30 * * * * *",
  async () => {

    // ========================================================
    // EVITAR EJECUCIONES SIMULTÁNEAS
    // ========================================================

    if (salesOrdersSyncRunning) {

      console.log(
        "⏭️ Sales Orders Sync omitido: sincronización anterior en ejecución."
      );

      return;
    }

    salesOrdersSyncRunning = true;

    console.log("");
    console.log("==============================================");
    console.log("🚚 CRON ADM CLOUD: SALES ORDERS");
    console.log("🕒 Fecha:", new Date().toISOString());
    console.log("==============================================");

    try {

      // ======================================================
      // EJECUTAR SERVICIO
      // ======================================================

      const result = await runAdmCloudSalesOrdersSync();

      console.log("");
      console.log("✅ SALES ORDERS SYNC FINALIZADO");

      console.log("📊 RESUMEN:", {
        success: result.success,
        totalReceived: result.totalReceived,
        totalUnique: result.totalUnique,
        inserted: result.inserted,
        updated: result.updated,
        done: result.done,
        draft: result.draft,
        failed: result.failed
      });

    } catch (error) {

      console.error(
        "❌ ERROR CRON SALES ORDERS:",
        {
          message: error.message,
          code: error.code,
          status: error.response?.status,
          data: error.response?.data,
          stack: error.stack
        }
      );

    } finally {

      // ======================================================
      // LIBERAR LOCK
      // ======================================================

      salesOrdersSyncRunning = false;

    }

  }
);



}


